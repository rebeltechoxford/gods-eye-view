import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter, once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { readTakGatewayConfig } from '../../server/providers/tak/config.js';
import {
  TAK_WS_PROTOCOL,
  TAK_WS_ROUTE,
  MAX_BROWSER_BUFFER_BYTES,
  REPLAY_BYTES_LIMIT,
  authorizeUpgrade,
  createTakGateway,
  gatewayPolicy,
} from '../../server/providers/tak/gateway.js';
import { createMeshLink } from '../../server/providers/tak/meshLink.js';
import {
  createServerLink,
  loadTlsOptions,
  SERVER_QUEUE_BYTES_LIMIT,
  SERVER_QUEUE_MAX_AGE_MS,
} from '../../server/providers/tak/serverLink.js';
import { parseCotEvent, serializeCotEvent } from '../tak/protocol/cot.js';
import {
  buildChat,
  buildMarker,
  buildDelete,
  buildSelfSa,
  buildEmergency,
  createIdentity,
} from '../tak/protocol/builders.js';
import {
  ATAK_SA as ORIGINAL_ATAK_SA,
  IDENTITY,
  WINTAK_HOSTILE as ORIGINAL_WINTAK,
} from '../tak/protocol/fixtures.mjs';

const TOKEN = 'synthetic-local-operator-token-0123456789';
function fresh(xml, staleMs = 60_000) {
  const event = parseCotEvent(xml);
  const now = Date.now();
  return serializeCotEvent({
    ...event,
    timeMs: now,
    startMs: now,
    staleMs: now + staleMs,
  });
}
const ATAK_SA = fresh(ORIGINAL_ATAK_SA);
const WINTAK_HOSTILE = fresh(ORIGINAL_WINTAK);

// --- config -----------------------------------------------------------------

test('gateway is off by default and uplinks need explicit opt-in', () => {
  const config = readTakGatewayConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.mesh, null);
  assert.equal(config.server, null);
  assert.deepEqual(config.errors, []);
});

test('mesh config applies ATAK defaults and validates groups/ports/interface', () => {
  const ok = readTakGatewayConfig({ TAK_GATEWAY: '1', TAK_MESH: 'true' });
  assert.deepEqual(
    { ...ok.mesh },
    {
      group: '239.2.3.1',
      port: 6969,
      chatGroup: '224.10.10.1',
      chatPort: 17012,
      iface: null,
      ttl: 1,
      loopback: false,
    },
  );
  const bad = readTakGatewayConfig({
    TAK_MESH: '1',
    TAK_MESH_GROUP: '10.0.0.1',
    TAK_MESH_PORT: '70000',
    TAK_MESH_INTERFACE: 'eth0',
    TAK_MESH_TTL: '99',
  });
  assert.equal(bad.mesh, null);
  assert.equal(bad.errors.length, 4);
});

test('server config: TLS needs client material; plaintext cannot escape private literal addresses', () => {
  assert.match(
    readTakGatewayConfig({ TAK_SERVER: 'tak.example.org:8089' }).errors[0],
    /CERT/,
  );
  const tls = readTakGatewayConfig({
    TAK_SERVER: 'tak.example.org:8089',
    TAK_SERVER_P12: 'c.p12',
    TAK_SERVER_P12_PASSWORD: 'atakatak',
  });
  assert.equal(tls.server.protocol, 'tls');
  assert.equal(tls.server.tls.p12, 'c.p12');
  assert.match(
    readTakGatewayConfig({
      TAK_SERVER: 'tak.example.org:8087',
      TAK_SERVER_PROTOCOL: 'tcp',
    }).errors[0],
    /loopback\/RFC1918/,
  );
  assert.equal(
    readTakGatewayConfig({
      TAK_SERVER: '192.168.1.20:8087',
      TAK_SERVER_PROTOCOL: 'tcp',
    }).server.host,
    '192.168.1.20',
  );
  for (const host of [
    'tak.example.org',
    'tak.local',
    '8.8.8.8',
    '127.1',
    '010.0.0.1',
    '0x7f000001',
    '2130706433',
  ]) {
    const rejected = readTakGatewayConfig({
      TAK_SERVER: `${host}:8087`,
      TAK_SERVER_PROTOCOL: 'tcp',
      TAK_SERVER_ALLOW_PLAINTEXT: '1',
    });
    assert.equal(rejected.server, null, host);
    assert.match(rejected.errors[0], /literal loopback\/RFC1918/, host);
  }
  for (const host of [
    'localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.2',
    '192.168.1.20',
    '[::1]',
  ]) {
    assert.ok(
      readTakGatewayConfig({
        TAK_SERVER: `${host}:8087`,
        TAK_SERVER_PROTOCOL: 'tcp',
      }).server,
      host,
    );
  }
  assert.match(
    readTakGatewayConfig({ TAK_SERVER: 'nope' }).errors[0],
    /host:port/,
  );
  assert.match(
    readTakGatewayConfig({ TAK_SERVER: 'h:1', TAK_SERVER_PROTOCOL: 'udp' })
      .errors[0],
    /tls or tcp/,
  );
});

test('a malformed token keeps the gateway off', () => {
  const short = readTakGatewayConfig({
    TAK_GATEWAY: '1',
    TAK_GATEWAY_TOKEN: 'short',
  });
  assert.equal(short.enabled, false);
  const spaces = readTakGatewayConfig({
    TAK_GATEWAY: '1',
    TAK_GATEWAY_TOKEN: 'has spaces in it ok',
  });
  assert.equal(spaces.enabled, false);
  const missing = readTakGatewayConfig({ TAK_GATEWAY: '1' });
  assert.equal(missing.enabled, false);
  assert.match(missing.errors[0], /required/);
  const ok = readTakGatewayConfig({
    TAK_GATEWAY: '1',
    TAK_GATEWAY_TOKEN: TOKEN,
  });
  assert.equal(ok.enabled, true);
  assert.equal(ok.token, TOKEN);
});

test('TLS options keep verification on and prefer PKCS#12 when given', () => {
  const read = (p) => `<${p}>`;
  const p12 = loadTlsOptions(
    {
      host: 'tak.example.org',
      tls: { p12: 'a.p12', p12Password: 'x', ca: 'ca.pem' },
    },
    read,
  );
  assert.deepEqual(p12, {
    servername: 'tak.example.org',
    minVersion: 'TLSv1.2',
    pfx: '<a.p12>',
    passphrase: 'x',
    ca: '<ca.pem>',
    rejectUnauthorized: true,
  });
  const pem = loadTlsOptions(
    { host: '10.0.0.5', tls: { cert: 'c', key: 'k', ca: null } },
    read,
  );
  assert.deepEqual(pem, {
    servername: undefined,
    minVersion: 'TLSv1.2',
    cert: '<c>',
    key: '<k>',
    rejectUnauthorized: true,
  });
});

// --- authorization + policy -------------------------------------------------

test('upgrades require actual loopback, the local listener origin, tak.v1 and an operator token', () => {
  const req = (headers = {}, socket = {}) => ({
    socket: {
      remoteAddress: '127.0.0.1',
      localAddress: '127.0.0.1',
      localPort: 5173,
      ...socket,
    },
    headers: {
      host: 'localhost:5173',
      origin: 'http://localhost:5173',
      'sec-websocket-protocol': `tak.v1, tak.token.${TOKEN}`,
      ...headers,
    },
  });
  const config = { token: TOKEN };
  assert.deepEqual(authorizeUpgrade(req(), config), { ok: true });
  for (const headers of [
    { origin: 'http://evil.example' },
    { origin: undefined },
    { origin: 'not a url' },
    { host: 'evil.example:5173', origin: 'http://evil.example:5173' },
    { host: 'localhost:6000', origin: 'http://localhost:6000' },
    { origin: 'https://localhost:5173' },
    { forwarded: 'for=127.0.0.1' },
    { 'x-forwarded-for': '127.0.0.1' },
  ])
    assert.equal(authorizeUpgrade(req(headers), config).status, 403);
  assert.equal(
    authorizeUpgrade(req({}, { remoteAddress: '192.168.1.2' }), config).status,
    403,
  );
  assert.equal(
    authorizeUpgrade(req({}, { localAddress: '0.0.0.0' }), config).status,
    403,
  );
  assert.equal(
    authorizeUpgrade(req({ 'sec-websocket-protocol': 'chat' }), config).reason,
    'protocol',
  );
  assert.equal(
    authorizeUpgrade(req({ 'sec-websocket-protocol': 'tak.v1' }), config)
      .status,
    401,
  );
  assert.equal(authorizeUpgrade(req(), {}).status, 401);
});

test('policy: browsers see all; mesh and server only cross when bridged', () => {
  const k = (kind) => ({ kind, authorized: true });
  const off = gatewayPolicy({ bridge: false });
  const on = gatewayPolicy({ bridge: true });
  assert.equal(off({ from: k('mesh'), to: k('browser') }), true);
  assert.equal(off({ from: k('browser'), to: k('mesh') }), true);
  assert.equal(off({ from: k('browser'), to: k('server') }), true);
  assert.equal(off({ from: k('mesh'), to: k('server') }), false);
  assert.equal(off({ from: k('server'), to: k('mesh') }), false);
  assert.equal(on({ from: k('mesh'), to: k('server') }), true);
  assert.equal(on({ from: k('server'), to: k('mesh') }), true);
});

// --- end-to-end over a real HTTP server -------------------------------------

function fakeLink(kind) {
  const link = { kind, sent: [], onXml: null, closed: false };
  link.factory = ({ onXml }) => {
    link.onXml = onXml;
    return {
      id: kind,
      kind,
      send: (xml) => link.sent.push(xml),
      status: () => ({ state: 'joined', rx: 0, tx: link.sent.length }),
      close: () => (link.closed = true),
    };
  };
  return link;
}

async function startGateway(configOverrides = {}) {
  const mesh = fakeLink('mesh');
  const server = fakeLink('server');
  const config = {
    ...readTakGatewayConfig({ TAK_GATEWAY: '1', TAK_GATEWAY_TOKEN: TOKEN }),
    mesh: { group: '239.2.3.1', port: 6969 },
    server: { host: '127.0.0.1', port: 8087, protocol: 'tcp' },
    ...configOverrides,
  };
  const gateway = createTakGateway({
    config,
    WebSocketServer,
    createMesh: mesh.factory,
    createServer: server.factory,
    log: { warn() {}, info() {} },
  });
  const httpServer = http.createServer((req, res) => {
    if (!gateway.handleHttpRequest(req, res)) res.end();
  });
  httpServer.on('upgrade', (req, socket, head) => {
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
  });
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const { port } = httpServer.address();
  const close = async () => {
    gateway.close();
    httpServer.closeAllConnections?.();
    await new Promise((resolve) => httpServer.close(resolve));
  };
  return { gateway, mesh, server, port, close };
}

function connect(
  port,
  {
    origin = `http://127.0.0.1:${port}`,
    protocols = [TAK_WS_PROTOCOL, `tak.token.${TOKEN}`],
    identity = IDENTITY,
  } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${TAK_WS_ROUTE}`, protocols, {
    origin,
  });
  const inbox = [];
  const waiters = [];
  ws.on('open', () => {
    if (identity)
      ws.send(
        JSON.stringify({
          op: 'identity',
          uid: identity.uid,
          callsign: identity.callsign,
        }),
      );
  });
  ws.on('message', (data) => {
    inbox.push(data.toString());
    for (const w of waiters.splice(0)) w();
  });
  ws.next = async (predicate = () => true, timeoutMs = 2000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = inbox.findIndex(predicate);
      if (index >= 0) return inbox.splice(index, 1)[0];
      if (Date.now() > deadline)
        throw new Error('timed out waiting for message');
      await new Promise((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  ws.inbox = inbox;
  return ws;
}

const isXml = (m) => m.startsWith('<');
const isOp = (op) => (m) => m.startsWith('{') && JSON.parse(m).op === op;

test('browser <-> mesh/server relay over a real WebSocket', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const a = connect(g.port);
  const b = connect(g.port);
  await once(a, 'open');
  await once(b, 'open');
  const hello = JSON.parse(await a.next(isOp('hello')));
  assert.equal(hello.status.enabled, true);
  assert.equal(hello.status.mesh.state, 'joined');

  // Mesh traffic reaches every browser, normalised.
  g.mesh.onXml(ATAK_SA);
  const fromMesh = await a.next(isXml);
  assert.equal(parseCotEvent(fromMesh).detail.callsign, 'VIPER');
  await b.next(isXml);
  assert.equal(g.server.sent.length, 0, 'not bridged');

  // Browser marker reaches mesh, server and the other browser, not itself.
  const marker = serializeCotEvent(
    buildMarker(IDENTITY, { callsign: 'OP', lat: 1, lon: 2 }),
  );
  a.send(marker);
  const atB = await b.next(isXml);
  assert.equal(parseCotEvent(atB).detail.callsign, 'OP');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(g.mesh.sent.length, 1);
  assert.equal(g.server.sent.length, 1);
  assert.equal(a.inbox.filter(isXml).length, 0, 'no echo to the sender');

  // Junk is refused back to the sender with a reason.
  a.send('<event uid="x"/>');
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /Invalid/);
  a.send(Buffer.from([0xbf, 1, 0xbf]));
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /binary/);

  // Status on request.
  a.send(JSON.stringify({ op: 'status' }));
  const status = JSON.parse(await a.next(isOp('status'))).status;
  assert.equal(status.browsers, 2);
  assert.ok(status.router.accepted >= 2);
  a.close();
  b.close();
});

test('late joiners get a replay of live (non-stale) contacts, minus deletes', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const marker = buildMarker(IDENTITY, {
    uid: 'gone',
    callsign: 'GONE',
    lat: 1,
    lon: 1,
  });
  g.mesh.onXml(
    serializeCotEvent(
      buildMarker(IDENTITY, { uid: 'kept', callsign: 'KEPT', lat: 1, lon: 1 }),
    ),
  );
  g.mesh.onXml(serializeCotEvent(marker));
  g.mesh.onXml(
    `<event version="2.0" uid="del-1" type="t-x-d-d" how="h-g-i-g-o" time="${new Date().toISOString()}" start="${new Date().toISOString()}" stale="${new Date(Date.now() + 20000).toISOString()}"><point lat="0" lon="0"/><detail><link uid="gone" relation="none"/></detail></event>`,
  );
  g.mesh.onXml(fresh(WINTAK_HOSTILE, -1));
  const late = connect(g.port);
  await once(late, 'open');
  await late.next(isOp('hello'));
  const replayed = [];
  try {
    for (;;) replayed.push(parseCotEvent(await late.next(isXml, 300)).uid);
  } catch {
    // drained
  }
  assert.ok(replayed.includes('kept'));
  assert.ok(!replayed.includes('gone'));
  assert.ok(!replayed.includes('0b0b0b0b-1111-4222-8333-444444444444'));
  late.close();
});

test('late WebSocket joiners retain newer replay positions and alerts after reordered updates and removals', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const time = Date.now() - 1000;
  const marker = (nowMs, lat) =>
    buildMarker(
      IDENTITY,
      {
        uid: 'reordered-marker',
        callsign: 'SYNTHETIC',
        lat,
        lon: 2,
      },
      { nowMs },
    );
  const newer = marker(time + 100, 2);
  const alert = buildEmergency(
    IDENTITY,
    { lat: 2, lon: 2 },
    { nowMs: time + 100 },
  );
  for (const event of [
    newer,
    marker(time, 1),
    buildDelete(IDENTITY, newer.uid, newer.type, { nowMs: time + 50 }),
    alert,
    buildEmergency(
      IDENTITY,
      { lat: 1, lon: 2 },
      { cancel: true, nowMs: time + 50 },
    ),
  ])
    g.mesh.onXml(serializeCotEvent(event));
  assert.equal(g.gateway.status().replay, 2);

  const late = connect(g.port);
  await once(late, 'open');
  await late.next(isOp('identity'));
  const replayed = new Map();
  for (let i = 0; i < 2; i++) {
    const event = parseCotEvent(await late.next(isXml));
    replayed.set(event.uid, event);
  }
  assert.equal(replayed.get(newer.uid).timeMs, newer.timeMs);
  assert.equal(replayed.get(newer.uid).point.lat, 2);
  assert.equal(replayed.get(alert.uid).timeMs, alert.timeMs);
  assert.equal(replayed.get(alert.uid).detail.emergency.cancel, false);
  late.close();

  g.mesh.onXml(
    serializeCotEvent(
      buildDelete(IDENTITY, newer.uid, newer.type, { nowMs: time + 200 }),
    ),
  );
  g.mesh.onXml(
    serializeCotEvent(
      buildEmergency(
        IDENTITY,
        { lat: 2, lon: 2 },
        { cancel: true, nowMs: time + 200 },
      ),
    ),
  );
  assert.equal(g.gateway.status().replay, 0);
  const afterRemoval = connect(g.port);
  await once(afterRemoval, 'open');
  await afterRemoval.next(isOp('identity'));
  await assert.rejects(afterRemoval.next(isXml, 150), /timed out/);
  afterRemoval.close();
});

test('upgrades are refused for cross-origin pages, wrong protocol and missing token', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const statusOf = async (ws) => {
    const [, res] = await once(ws, 'unexpected-response');
    return res.statusCode;
  };
  assert.equal(
    await statusOf(connect(g.port, { origin: 'http://evil.example' })),
    403,
  );
  assert.equal(
    await statusOf(connect(g.port, { protocols: [TAK_WS_PROTOCOL] })),
    401,
  );
  const ok = connect(g.port);
  await once(ok, 'open');
  assert.equal(
    ok.protocol,
    TAK_WS_PROTOCOL,
    'the token is never echoed as the chosen protocol',
  );
  ok.close();
});

test('bridged gateway relays mesh <-> server; close shuts uplinks', async () => {
  const g = await startGateway({ bridge: true });
  g.mesh.onXml(ATAK_SA);
  g.server.onXml(WINTAK_HOSTILE);
  assert.equal(g.server.sent.length, 1);
  assert.equal(g.mesh.sent.length, 1);
  await g.close();
  assert.equal(g.mesh.closed, true);
  assert.equal(g.server.closed, true);
});

// --- server link over a real TCP socket --------------------------------------

test('server link streams CoT both ways, queues while down and reconnects', async (t) => {
  const received = [];
  const sockets = [];
  const tak = net.createServer((socket) => {
    sockets.push(socket);
    socket.setEncoding('utf8');
    socket.on('data', (d) => received.push(d));
    socket.on('error', () => {});
  });
  tak.listen(0, '127.0.0.1');
  await once(tak, 'listening');

  const inbound = [];
  const timers = [];
  const link = createServerLink({
    config: {
      host: '127.0.0.1',
      port: tak.address().port,
      protocol: 'tcp',
      tls: null,
    },
    onXml: (xml) => inbound.push(xml),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  // Close the client first, then any server-side sockets, or tak.close()
  // waits for the link's idle timeout.
  t.after(async () => {
    link.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => tak.close(r));
  });

  link.send(
    serializeCotEvent(
      buildMarker(IDENTITY, {
        uid: 'queued',
        callsign: 'QUEUED',
        lat: 1,
        lon: 2,
      }),
    ),
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(link.status().state, 'connected');
  assert.ok(received.join('').includes('uid="queued"'));

  // Server pushes events split across writes.
  const half = Math.floor(ATAK_SA.length / 2);
  sockets[0].write(ATAK_SA.slice(0, half));
  sockets[0].write(ATAK_SA.slice(half) + WINTAK_HOSTILE);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(inbound.length, 2);
  assert.equal(parseCotEvent(inbound[0]).detail.callsign, 'VIPER');

  // Server drops us: we schedule a reconnect with backoff and keep queueing.
  sockets[0].destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(link.status().state, 'reconnecting');
  assert.equal(timers.at(-1).ms, 1000);
  link.send(
    serializeCotEvent(
      buildMarker(IDENTITY, {
        uid: 'while-down',
        callsign: 'DOWN',
        lat: 1,
        lon: 2,
      }),
    ),
  );
  timers.at(-1).fn();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(link.status().state, 'connected');
  assert.equal(link.status().reconnects, 1);
  assert.ok(received.join('').includes('uid="while-down"'));
});

test('server link bounds its offline queue', () => {
  const socket = new EventEmitter();
  socket.write = () => {};
  socket.destroy = () => {};
  const link = createServerLink({
    config: { host: 'x', port: 1, protocol: 'tcp', tls: null },
    onXml: () => {},
    connect: () => socket,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  for (let i = 0; i < 300; i++)
    link.send(
      serializeCotEvent(
        buildMarker(IDENTITY, {
          uid: String(i),
          callsign: 'BOUNDED',
          lat: 1,
          lon: 2,
        }),
      ),
    );
  assert.equal(link.status().queue, 256);
  assert.equal(link.status().droppedQueue, 44);
  link.close();
});

// --- mesh link (fake UDP socket) --------------------------------------------

function fakeDgram() {
  const sockets = [];
  const factory = () => {
    const s = new EventEmitter();
    s.memberships = [];
    s.sent = [];
    s.bind = (port, cb) => {
      s.port = port;
      queueMicrotask(cb);
    };
    s.addMembership = (group, iface) => s.memberships.push([group, iface]);
    s.setMulticastTTL = (ttl) => (s.ttl = ttl);
    s.setMulticastLoopback = (on) => (s.loopback = on);
    s.setMulticastInterface = (iface) => (s.iface = iface);
    s.send = (buf, port, group, cb) => {
      s.sent.push({ xml: buf.toString(), port, group });
      cb?.(null);
    };
    s.close = () => (s.closed = true);
    sockets.push(s);
    return s;
  };
  return { sockets, factory };
}

test('mesh link joins SA + chat groups, routes chat to the chat group, skips protobuf', async () => {
  const dgram = fakeDgram();
  const inbound = [];
  const config = readTakGatewayConfig({
    TAK_MESH: '1',
    TAK_MESH_INTERFACE: '192.168.1.10',
  }).mesh;
  const mesh = createMeshLink({
    config,
    onXml: (x) => inbound.push(x),
    createSocket: dgram.factory,
  });
  await new Promise((r) => setTimeout(r, 10));
  const [sa, chat] = dgram.sockets;
  assert.deepEqual(sa.memberships, [['239.2.3.1', '192.168.1.10']]);
  assert.deepEqual(chat.memberships, [['224.10.10.1', '192.168.1.10']]);
  assert.equal(sa.ttl, 1);
  assert.equal(sa.loopback, false);
  assert.equal(mesh.status().state, 'joined');

  const marker = buildMarker(IDENTITY, { callsign: 'OP', lat: 1, lon: 2 });
  mesh.send(serializeCotEvent(marker), marker);
  const message = buildChat(IDENTITY, { message: 'hi' });
  mesh.send(serializeCotEvent(message), message);
  assert.equal(sa.sent[0].group, '239.2.3.1');
  assert.equal(sa.sent[0].port, 6969);
  assert.equal(chat.sent[0].group, '224.10.10.1');
  assert.equal(chat.sent[0].port, 17012);

  sa.emit('message', Buffer.from(ATAK_SA));
  sa.emit('message', Buffer.from([0xbf, 0x01, 0xbf, 0x0a]));
  assert.equal(inbound.length, 1);
  assert.equal(mesh.status().protobuf, 1);

  mesh.send('x'.repeat(9000), marker);
  assert.equal(mesh.status().oversized, 1);
  mesh.close();
  assert.equal(sa.closed && chat.closed, true);
});

test('browser identity and marker ownership are enforced at the gateway', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const a = connect(g.port, { identity: null });
  await once(a, 'open');
  await a.next(isOp('hello'));
  const marker = buildMarker(IDENTITY, { callsign: 'OWN', lat: 1, lon: 2 });
  a.send(serializeCotEvent(marker));
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /Register/);
  assert.equal(g.server.sent.length, 0);
  a.send(
    JSON.stringify({
      op: 'identity',
      uid: IDENTITY.uid,
      callsign: IDENTITY.callsign,
    }),
  );
  await a.next(isOp('identity'));
  a.send(
    serializeCotEvent(
      buildMarker(IDENTITY, {
        uid: '00000000-0000-4000-8000-000000000001',
        callsign: 'SPOOF',
        lat: 1,
        lon: 2,
      }),
    ),
  );
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /unowned/);
  a.send(serializeCotEvent(buildSelfSa(createIdentity(), { lat: 1, lon: 2 })));
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /unowned/);
  a.send(serializeCotEvent(marker));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.server.sent.length, 1);
  const other = createIdentity();
  const b = connect(g.port, { identity: other });
  await once(b, 'open');
  await b.next(isOp('identity'));
  b.send(serializeCotEvent(buildDelete(other, marker.uid)));
  assert.match(JSON.parse(await b.next(isOp('reject'))).reason, /Only markers/);
  assert.equal(g.server.sent.length, 1);
  a.send(serializeCotEvent(buildDelete(IDENTITY, marker.uid)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.server.sent.length, 2);
  a.close();
  b.close();
});

test('identity can refresh its callsign and reconnect but cannot impersonate a known network uid', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const collision = createIdentity();
  g.mesh.onXml(serializeCotEvent(buildSelfSa(collision, { lat: 1, lon: 2 })));
  const a = connect(g.port, { identity: collision });
  await once(a, 'open');
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /Identity/);
  for (const callsign of ['UPDATED', 'UPDATED-AGAIN']) {
    a.send(JSON.stringify({ op: 'identity', uid: IDENTITY.uid, callsign }));
    await a.next(isOp('identity'));
  }
  a.send(
    serializeCotEvent(
      buildSelfSa(
        { ...IDENTITY, callsign: 'UPDATED-AGAIN' },
        { lat: 1, lon: 2 },
      ),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.server.sent.length, 1);
  a.send(
    JSON.stringify({
      op: 'identity',
      uid: createIdentity().uid,
      callsign: 'SWITCH',
    }),
  );
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /Identity/);
  a.close();
  const b = connect(g.port);
  await once(b, 'open');
  await b.next(isOp('identity'));
  b.close();
});

test('directed chat is denied, chat is not replayed, and browser routing extensions are stripped or rejected', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const a = connect(g.port);
  await once(a, 'open');
  await a.next(isOp('identity'));
  a.send(
    serializeCotEvent(
      buildChat(IDENTITY, { message: 'PRIVATE', chatroom: 'OTHER-DEVICE' }),
    ),
  );
  assert.match(
    JSON.parse(await a.next(isOp('reject'))).reason,
    /All Chat Rooms/,
  );
  const marker = serializeCotEvent(
    buildMarker(IDENTITY, { callsign: 'SAFE', lat: 1, lon: 2 }),
  );
  a.send(
    marker.replace(
      '</detail>',
      '<marti><dest callsign="PRIVATE"/></marti></detail>',
    ),
  );
  assert.match(JSON.parse(await a.next(isOp('reject'))).reason, /extension/);
  a.send(
    marker.replace('<contact ', '<contact private-route="MUST-BE-STRIPPED" '),
  );
  a.send(serializeCotEvent(buildChat(IDENTITY, { message: 'BROADCAST' })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(g.server.sent.length, 2);
  assert.ok(!g.server.sent[0].includes('MUST-BE-STRIPPED'));
  const b = connect(g.port);
  await once(b, 'open');
  await b.next(isOp('hello'));
  assert.equal(
    parseCotEvent(await b.next(isXml)).uid,
    parseCotEvent(marker).uid,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(b.inbox.filter(isXml).length, 0);
  g.mesh.onXml(
    serializeCotEvent(
      buildChat(createIdentity(), {
        message: 'INBOUND PRIVATE',
        chatroom: 'OTHER-DEVICE',
      }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(b.inbox.filter(isXml).length, 0);
  a.close();
  b.close();
});

test('local bootstrap requires opt-in POST and same-origin; unauthenticated status contains no credentials or endpoints', async (t) => {
  const g = await startGateway({ localBootstrap: true });
  t.after(g.close);
  const base = `http://127.0.0.1:${g.port}`;
  const status = await (await fetch(`${base}/api/tak/status`)).json();
  assert.equal(status.bootstrapAllowed, true);
  assert.ok(!('server' in status));
  assert.ok(!('token' in status));
  assert.equal(
    (await fetch(`${base}/api/tak/session`, { headers: { origin: base } }))
      .status,
    405,
  );
  assert.equal(
    (
      await fetch(`${base}/api/tak/session`, {
        method: 'POST',
        headers: { origin: 'http://evil.example', 'x-tak-session': '1' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/api/tak/session`, {
        method: 'POST',
        headers: { origin: base },
      })
    ).status,
    403,
  );
  const allowed = await fetch(`${base}/api/tak/session`, {
    method: 'POST',
    headers: { origin: base, 'x-tak-session': '1' },
  });
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.equal((await allowed.json()).token, TOKEN);
  const off = await startGateway();
  t.after(off.close);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${off.port}/api/tak/session`, {
        method: 'POST',
        headers: {
          origin: `http://127.0.0.1:${off.port}`,
          'x-tak-session': '1',
        },
      })
    ).status,
    403,
  );
});

test('WS controls share the rate limit and oversized frames close the connection', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const a = connect(g.port);
  await once(a, 'open');
  await a.next(isOp('identity'));
  const closed = once(a, 'close');
  for (let i = 0; i < 150; i++) a.send(JSON.stringify({ op: 'status' }));
  assert.equal((await closed)[0], 1008);
  assert.ok(a.inbox.filter(isOp('status')).length <= 60);
  const b = connect(g.port);
  await once(b, 'open');
  const oversized = once(b, 'close');
  b.send('x'.repeat(64 * 1024 + 1));
  assert.equal((await oversized)[0], 1009);
});

test('live/replayed CoT is withheld until the identity ACK', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const a = connect(g.port, { identity: null });
  await once(a, 'open');
  await a.next(isOp('hello'));
  g.mesh.onXml(
    serializeCotEvent(
      buildMarker(IDENTITY, { callsign: 'WITHHELD', lat: 1, lon: 2 }),
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(a.inbox.filter(isXml).length, 0);
  a.send(
    JSON.stringify({
      op: 'identity',
      uid: IDENTITY.uid,
      callsign: IDENTITY.callsign,
    }),
  );
  await a.next(isOp('identity'));
  assert.equal(parseCotEvent(await a.next(isXml)).detail.callsign, 'WITHHELD');
  a.close();
});

test('slow browser is terminated before the outbound buffer exceeds its cap', () => {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.bufferedAmount = 0;
  ws.sent = [];
  ws.send = (message, callback) => {
    ws.sent.push(message);
    callback?.();
  };
  ws.terminate = () => {
    ws.readyState = 3;
    ws.emit('close');
  };
  ws.close = ws.terminate;
  class FakeWss {
    handleUpgrade(_req, _socket, _head, attach) {
      attach(ws);
    }
    close() {}
  }
  const gateway = createTakGateway({
    config: readTakGatewayConfig({
      TAK_GATEWAY: '1',
      TAK_GATEWAY_TOKEN: TOKEN,
    }),
    WebSocketServer: FakeWss,
  });
  try {
    gateway.handleUpgrade(
      {
        url: TAK_WS_ROUTE,
        socket: {
          localAddress: '127.0.0.1',
          remoteAddress: '127.0.0.1',
          localPort: 5173,
        },
        headers: {
          host: 'localhost:5173',
          origin: 'http://localhost:5173',
          'sec-websocket-protocol': `tak.v1,tak.token.${TOKEN}`,
        },
      },
      {},
      Buffer.alloc(0),
    );
    const sent = ws.sent.length;
    ws.bufferedAmount = MAX_BROWSER_BUFFER_BYTES;
    ws.emit('message', Buffer.from('{"op":"status"}'), false);
    assert.equal(ws.readyState, 3);
    assert.equal(ws.sent.length, sent);
  } finally {
    gateway.close();
  }
});

test('server queue coalesces positions, expires old sends, and respects socket backpressure', () => {
  const socket = new EventEmitter();
  const written = [];
  let ready = false;
  socket.writableLength = 0;
  socket.write = (xml) => {
    written.push(xml);
    return ready;
  };
  socket.destroy = () => {};
  let now = Date.now();
  const link = createServerLink({
    config: { host: '127.0.0.1', port: 1, protocol: 'tcp' },
    now: () => now,
    onXml() {},
    connect: () => socket,
  });
  try {
    const first = buildSelfSa(IDENTITY, { lat: 1, lon: 2 }, { nowMs: now });
    const update = buildSelfSa(
      IDENTITY,
      { lat: 3, lon: 4 },
      { nowMs: now + 1 },
    );
    link.send('', first);
    link.send('', update);
    assert.equal(link.status().queue, 1);
    assert.equal(link.status().coalesced, 1);
    socket.emit('connect');
    assert.equal(written.length, 1);
    assert.equal(parseCotEvent(written[0]).point.lat, 3);
    link.send(
      '',
      buildMarker(
        IDENTITY,
        { callsign: 'WAIT', lat: 1, lon: 2 },
        { nowMs: now },
      ),
    );
    assert.equal(written.length, 1);
    assert.equal(link.status().queue, 1);
    ready = true;
    socket.emit('drain');
    assert.equal(written.length, 2);
    assert.equal(link.status().queue, 0);
    ready = false;
    link.send(
      '',
      buildMarker(
        IDENTITY,
        { callsign: 'BLOCK', lat: 1, lon: 2 },
        { nowMs: now },
      ),
    );
    link.send(
      '',
      buildMarker(
        IDENTITY,
        { callsign: 'EXPIRE', lat: 1, lon: 2 },
        { nowMs: now },
      ),
    );
    const before = written.length;
    now += SERVER_QUEUE_MAX_AGE_MS + 1;
    ready = true;
    socket.emit('drain');
    assert.equal(written.length, before);
    assert.equal(link.status().queue, 0);
    assert.ok(link.status().droppedExpired > 0);
  } finally {
    link.close();
  }
});

test('server offline queue is byte bounded as well as count bounded', () => {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  const link = createServerLink({
    config: { host: '127.0.0.1', port: 1, protocol: 'tcp' },
    onXml() {},
    connect: () => socket,
  });
  try {
    for (let i = 0; i < 300; i++)
      link.send(
        '',
        buildMarker(IDENTITY, {
          callsign: 'BOUND',
          lat: 1,
          lon: 2,
          remarks: 'x'.repeat(4096),
        }),
      );
    assert.ok(link.status().queueBytes <= SERVER_QUEUE_BYTES_LIMIT);
    assert.ok(link.status().queue < 256);
    assert.ok(link.status().droppedQueue > 0);
  } finally {
    link.close();
  }
});

test('large replay drains in batches without disconnecting an authorized local browser', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  for (let i = 0; i < 200; i++)
    g.gateway.router.publish(
      buildMarker(IDENTITY, {
        callsign: `REPLAY-${i}`,
        lat: 1,
        lon: 2,
        remarks: 'x'.repeat(4096),
      }),
      'mesh',
    );
  assert.ok(g.gateway.status().replayBytes > MAX_BROWSER_BUFFER_BYTES);
  const a = connect(g.port);
  await once(a, 'open');
  await a.next(isOp('identity'));
  const uids = new Set();
  for (let i = 0; i < 200; i++)
    uids.add(parseCotEvent(await a.next(isXml)).uid);
  assert.equal(uids.size, 200);
  assert.equal(a.readyState, WebSocket.OPEN);
  a.close();
});

test('replay retains bounded bytes even when fewer than 2000 large contacts arrive', async (t) => {
  const g = await startGateway();
  t.after(g.close);
  for (let i = 0; i < 600; i++) {
    const event = buildMarker(IDENTITY, {
      callsign: `LARGE-${i}`,
      lat: 1,
      lon: 2,
    });
    g.gateway.router.publish(
      {
        ...event,
        detail: {
          ...event.detail,
          extras: [
            {
              name: 'sensor',
              attrs: {},
              children: [],
              text: 'x'.repeat(16000),
            },
          ],
        },
      },
      'mesh',
    );
  }
  assert.ok(g.gateway.status().replayBytes <= REPLAY_BYTES_LIMIT);
  assert.ok(g.gateway.status().replay < 600);
});
