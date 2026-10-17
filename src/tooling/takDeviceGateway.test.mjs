import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { createTakGateway } from '../../server/providers/tak/gateway.js';
import { readTakGatewayConfig } from '../../server/providers/tak/config.js';
import { principalGatewayConfig } from '../../server/providers/tak/principals.js';
import {
  createIdentity,
  buildMarker,
  buildSelfSa,
  buildChat,
} from '../tak/protocol/builders.js';
import { serializeCotEvent, parseCotEvent } from '../tak/protocol/cot.js';

const TOKEN = 'synthetic-device-pool-test-token-0123456789';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(2);
  }
  throw new Error('Timed out: ' + label);
}
async function fixture(t, overrides = {}) {
  const streams = [],
    sockets = [];
  let time = Date.now();
  const gateway = createTakGateway({
    config: {
      ...readTakGatewayConfig({ TAK_GATEWAY: '1', TAK_GATEWAY_TOKEN: TOKEN }),
      server: { protocol: 'tls', host: '127.0.0.1', port: 18089 },
      ...overrides,
    },
    WebSocketServer,
    now: () => time,
    createServer(hooks) {
      const stream = { hooks, sent: [], closed: false };
      streams.push(stream);
      hooks.onStatus?.({ state: 'connected' });
      return {
        id: 'server',
        kind: 'server',
        limits: { rate: 200, burst: 1000 },
        send(xml, event, tracking) {
          stream.sent.push({ xml, event });
          tracking?.onState?.({ state: 'queued' });
          tracking?.onState?.({
            state: tracking.canWrite?.() === false ? 'rejected' : 'submitted',
          });
          return true;
        },
        cancel() {},
        status: () => ({ state: 'connected', tx: stream.sent.length }),
        close() {
          stream.closed = true;
        },
      };
    },
    log: { info() {}, warn() {}, error() {} },
  });
  const server = http.createServer((req, res) => {
    if (!gateway.handleHttpRequest(req, res)) res.end();
  });
  server.on('upgrade', (req, socket, head) =>
    gateway.handleUpgrade(req, socket, head),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  t.after(async () => {
    for (const socket of sockets) socket.ws.terminate();
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  });
  async function connect(identity = createIdentity()) {
    const messages = [],
      events = [],
      errors = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/tak/ws`,
      ['tak.v1', 'tak.token.' + TOKEN],
      { origin: `http://127.0.0.1:${port}` },
    );
    ws.on('error', (error) => errors.push(error));
    ws.on('message', (data) => {
      const text = data.toString();
      if (text.startsWith('<')) events.push(parseCotEvent(text));
      else messages.push(JSON.parse(text));
    });
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          op: 'identity',
          uid: identity.uid,
          callsign: identity.callsign,
        }),
      ),
    );
    const state = { ws, identity, messages, events, errors };
    sockets.push(state);
    await wait(
      () => messages.some((m) => m.op === 'identity') || errors.length,
      'identity acknowledgement',
    );
    if (errors.length) throw errors[0];
    return state;
  }
  async function submit(browser, event) {
    const id = randomUUID();
    browser.ws.send(
      JSON.stringify({ op: 'cot', id, xml: serializeCotEvent(event) }),
    );
    return wait(
      () =>
        browser.messages.findLast(
          (m) => m.op === 'submission' && m.id === id && m.state !== 'queued',
        ),
      'submission outcome',
    );
  }
  async function presence(browser) {
    return submit(
      browser,
      buildSelfSa(
        browser.identity,
        { lat: 38.8895, lon: -77.0353, source: 'USER' },
        { nowMs: time },
      ),
    );
  }
  return {
    streams,
    gateway,
    connect,
    submit,
    presence,
    now: () => time,
    advance(ms) {
      time += ms;
    },
    port,
  };
}

test('device streams default off; original16browser and4account session capacities keep one legacy uplink', async (t) => {
  assert.equal(readTakGatewayConfig({}).deviceStreams, false);
  assert.equal(
    readTakGatewayConfig({ TAK_DEVICE_STREAMS: '1' }).deviceStreams,
    true,
  );
  assert.equal(
    readTakGatewayConfig({ TAK_DEVICE_STREAMS: '0' }).deviceStreams,
    false,
  );
  for (const count of [16, 4]) {
    const f = await fixture(t, { browserLimit: count });
    for (let i = 0; i < count; i++) await f.connect();
    assert.equal(f.streams.length, 1);
    await assert.rejects(f.connect(), /503/);
  }
});

test('named principal opt-in is explicit and keeps observer role and fixed TLS scope', () => {
  const principal = {
    id: 'observer',
    role: 'observer',
    storageScope: 'a'.repeat(64),
    server: { protocol: 'tls', host: '127.0.0.1', port: 18089 },
  };
  assert.equal(principalGatewayConfig(principal, {}).deviceStreams, false);
  const config = principalGatewayConfig(principal, {}, { deviceStreams: true });
  assert.equal(config.deviceStreams, true);
  assert.equal(config.role, 'observer');
  assert.equal(config.browserLimit, 4);
  assert.equal(config.server, principal.server);
  for (const values of [
    { server: null },
    { server: { protocol: 'tcp' } },
    { server: principal.server, mesh: {} },
    { server: principal.server, bridge: true },
  ]) {
    assert.throws(
      () =>
        createTakGateway({
          config: {
            enabled: true,
            token: TOKEN,
            deviceStreams: true,
            ...values,
          },
          WebSocketServer,
        }),
      /verified-TLS/,
    );
  }
});

test('actual WebSocket pool preserves sender context, isolates identical stripped-routing ingress and own replay', async (t) => {
  const f = await fixture(t, { deviceStreams: true }),
    a = await f.connect(),
    b = await f.connect(),
    c = await f.connect();
  assert.equal(f.streams.length, 1, 'SA-off identities share original feed');
  assert.equal((await f.presence(a)).state, 'submitted');
  const aw = f.streams.at(-1);
  assert.equal((await f.presence(b)).state, 'submitted');
  const bw = f.streams.at(-1);
  const event = buildMarker(createIdentity(), {
    uid: 'PRIVATE-STRIPPED-DEST',
    callsign: 'PRIVATE',
    lat: 1,
    lon: 2,
  });
  const xml = serializeCotEvent(event);
  aw.hooks.onXml(xml);
  await wait(
    () => a.events.some((e) => e.uid === event.uid),
    'ownerA private ingress',
  );
  bw.hooks.onXml(xml);
  await wait(
    () => b.events.some((e) => e.uid === event.uid),
    'ownerB identical private ingress',
  );
  await delay(25);
  assert.equal(
    c.events.some((e) => e.uid === event.uid),
    false,
  );
  const late = await f.connect();
  await delay(25);
  assert.equal(
    late.events.some((e) => e.uid === event.uid),
    false,
  );
  const mirror = await f.connect(a.identity);
  await wait(
    () => mirror.events.some((e) => e.uid === event.uid),
    'sameUID authorized replay',
  );
  mirror.ws.send(JSON.stringify({ op: 'status' }));
  const status = await wait(
    () =>
      mirror.messages.findLast(
        (m) =>
          m.op === 'status' &&
          m.status.server?.presence?.uid === a.identity.uid,
      ),
    'scoped status',
  );
  assert.equal(JSON.stringify(status).includes(b.identity.uid), false);
  assert.equal(
    status.status.server.tx,
    2,
    'status retains summed upstream submissions',
  );
  assert.equal(
    'presence' in f.gateway.status().server,
    false,
    'internal summary has no implicit device identity',
  );
  const httpStatus = await fetch(
    `http://127.0.0.1:${f.port}/api/tak/status`,
  ).then((response) => response.json());
  assert.equal(
    'server' in httpStatus,
    false,
    'public HTTP status retains its existing limited summary',
  );
});

test('explicit stop is owner-only and retires old transport; SA-off broadcasts remain available', async (t) => {
  const f = await fixture(t, { deviceStreams: true }),
    a = await f.connect(),
    mirror = await f.connect(a.identity),
    b = await f.connect();
  await f.presence(a);
  const aw = f.streams.at(-1);
  const rejected = await f.presence(mirror);
  assert.equal(rejected.state, 'rejected');
  mirror.ws.send(JSON.stringify({ op: 'presence', enabled: false }));
  await wait(
    () =>
      mirror.messages.some(
        (m) =>
          m.op === 'reject' &&
          m.command === 'presence' &&
          /publisher/.test(m.reason),
      ),
    'mirror cannot stop publisher',
  );
  assert.equal(aw.closed, false);
  b.ws.send(
    JSON.stringify({ op: 'presence', enabled: false, uid: a.identity.uid }),
  );
  await wait(
    () =>
      b.messages.some(
        (m) => m.op === 'reject' && m.reason === 'unknown control message',
      ),
    'cannot stop another UID',
  );
  assert.equal(aw.closed, false);
  a.ws.send(JSON.stringify({ op: 'presence', enabled: false }));
  await wait(
    () => a.messages.some((m) => m.op === 'presence' && m.enabled === false),
    'publisher stop',
  );
  assert.equal(aw.closed, true);
  const privateEvent = buildMarker(createIdentity(), {
    uid: 'RETIRED-WIRE',
    callsign: 'RETIRED',
    lat: 1,
    lon: 2,
  });
  aw.hooks.onXml(serializeCotEvent(privateEvent));
  await delay(25);
  assert.equal(
    a.events.some((e) => e.uid === privateEvent.uid),
    false,
  );
  const publicEvent = buildMarker(
    a.identity,
    { callsign: 'SA-OFF PUBLIC', lat: 1, lon: 2 },
    { nowMs: f.now() },
  );
  assert.equal((await f.submit(a, publicEvent)).state, 'submitted');
  assert.ok(
    f.streams.find(
      (stream) =>
        !stream.closed &&
        stream.sent.some((item) => item.event.uid === publicEvent.uid),
    ),
  );
});

test('pool ingress retains broadcast-only chat policy; observer cannot publish', async (t) => {
  const f = await fixture(t, { deviceStreams: true }),
    a = await f.connect();
  await f.presence(a);
  const aw = f.streams.at(-1);
  const directed = buildChat(createIdentity(), {
    message: 'PRIVATE NOT ENABLED',
    chatroom: a.identity.uid,
  });
  aw.hooks.onXml(serializeCotEvent(directed));
  await delay(25);
  assert.equal(
    a.events.some((e) => e.uid === directed.uid),
    false,
  );
  const ownDirected = buildChat(a.identity, {
    message: 'OUTBOUND PRIVATE NOT ENABLED',
    chatroom: 'SYNTHETIC-PEER',
  });
  assert.equal((await f.submit(a, ownDirected)).state, 'rejected');
  const observer = await fixture(t, { deviceStreams: true, role: 'observer' }),
    view = await observer.connect();
  const rejected = await observer.presence(view);
  assert.equal(rejected.state, 'rejected');
  assert.match(rejected.reason, /receive-only/);
  const broadcast = buildChat(createIdentity(), {
    message: 'BROADCAST STILL WORKS',
  });
  observer.streams[0].hooks.onXml(serializeCotEvent(broadcast));
  await wait(
    () => view.events.some((e) => e.uid === broadcast.uid),
    'receive-only group feed',
  );
});

test('non-SA endpoint cannot register a marker/control UID through actual WebSocket submission', async (t) => {
  const f = await fixture(t, { deviceStreams: true }),
    a = await f.connect(),
    b = await f.connect();
  const marker = buildMarker(
    a.identity,
    { callsign: 'SYNTHETIC ENDPOINT', lat: 1, lon: 2 },
    { nowMs: f.now() },
  );
  const forged = {
    ...marker,
    detail: { ...marker.detail, endpoint: '*:-1:stcp' },
  };
  const result = await f.submit(a, forged);
  assert.equal(result.state, 'rejected');
  assert.match(result.reason, /explicit self presence/);
  assert.equal(f.streams[0].sent.length, 0);
  await delay(25);
  assert.equal(
    b.events.some((event) => event.uid === marker.uid),
    false,
  );
});

test('mixed public and device-private replay share the original principal entry and byte budget', async (t) => {
  const f = await fixture(t, { deviceStreams: true }),
    a = await f.connect();
  await f.presence(a);
  const wire = f.streams.at(-1);
  const payload = 'x'.repeat(4096);
  // Each event is larger than4KiB, so bytes become the binding limit before
  // the1,000-entry public reserve. A fake clock avoids weakening rate limits.
  for (let i = 0; i < 850; i++) {
    f.advance(250);
    if (i && i % 80 === 0)
      assert.equal((await f.presence(a)).state, 'submitted');
    const local = buildMarker(
      a.identity,
      { callsign: `LOCAL-${i}`, lat: 1, lon: 2, remarks: payload },
      { nowMs: f.now(), staleMs: 600000 },
    );
    assert.equal((await f.submit(a, local)).state, 'submitted');
    const peer = buildMarker(
      createIdentity(),
      {
        uid: `PRIVATE-${i}`,
        callsign: `PRIVATE-${i}`,
        lat: 1,
        lon: 2,
        remarks: payload,
      },
      { nowMs: f.now(), staleMs: 600000 },
    );
    wire.hooks.onXml(serializeCotEvent(peer));
  }
  const status = f.gateway.status();
  assert.ok(status.replay <= 1000);
  assert.ok(status.replayBytes <= 4 * 1024 * 1024);
  assert.ok(status.server.replay <= 1000);
  assert.ok(status.server.replayBytes <= 4 * 1024 * 1024);
  assert.ok(status.replayBytes + status.server.replayBytes <= 8 * 1024 * 1024);
  const mirror = await f.connect(a.identity);
  const expected = status.replay + status.server.replay;
  await wait(
    () => mirror.events.length >= expected,
    'bounded mixed replay drained',
  );
  await delay(25);
  assert.equal(mirror.events.length, expected);
  assert.ok(mirror.events.some((event) => event.uid.startsWith('PRIVATE-')));
  assert.ok(mirror.events.some((event) => event.uid.startsWith('GEV-MARKER-')));
  const bytes = mirror.events.reduce(
    (sum, event) => sum + Buffer.byteLength(serializeCotEvent(event)),
    0,
  );
  assert.ok(mirror.events.length <= 2000);
  assert.ok(bytes <= 8 * 1024 * 1024);
});
