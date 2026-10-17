import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import WebSocket from 'ws';
import {
  startTakHttpsServer,
  SESSION_TTL_MS,
} from '../../server/standalone/tak-https.mjs';
import {
  readTakPrincipals,
  authenticateTakPrincipal,
} from '../../server/providers/tak/principals.js';
import {
  createPrincipalMapRoots,
  PRINCIPAL_MAP_BYTES,
} from '../../server/providers/tak/principalMaps.js';
import {
  loadTlsOptions,
  encodeTakStreamEvent,
} from '../../server/providers/tak/serverLink.js';
import { readTakGatewayConfig } from '../../server/providers/tak/config.js';
import { createCotStreamFramer } from '../tak/protocol/stream.js';
import {
  buildMarker,
  buildSelfSa,
  buildChat,
} from '../tak/protocol/builders.js';
import { serializeCotEvent, parseCotEvent } from '../tak/protocol/cot.js';
import { IDENTITY } from '../tak/protocol/fixtures.mjs';
import { createTakTlsFixtures } from './takTlsFixtures.mjs';

let alphaTls, bravoTls, directory, dist;
const tokens = {
  alpha: 'synthetic-alpha-operator-token-0123456789',
  bravo: 'synthetic-bravo-observer-token-0123456789',
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
before(() => {
  alphaTls = createTakTlsFixtures({
    clientName: 'Synthetic Alpha',
    authorityName: 'Synthetic Alpha',
  });
  bravoTls = createTakTlsFixtures({
    clientName: 'Synthetic Bravo',
    authorityName: 'Synthetic Bravo',
  });
  directory = mkdtempSync(path.join(tmpdir(), 'gev-tak-principals-'));
  dist = path.join(directory, 'dist');
  mkdirSync(dist);
  writeFileSync(
    path.join(dist, 'index.html'),
    '<!doctype html><title>Synthetic named console</title>',
  );
});
after(() => {
  alphaTls?.cleanup();
  bravoTls?.cleanup();
  if (
    directory &&
    path.dirname(path.resolve(directory)) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith('gev-tak-principals-')
  )
    rmSync(directory, { recursive: true, force: true });
});
const caseDirectory = () => mkdtempSync(path.join(directory, 'case-'));
function configuration(port = 8089) {
  return {
    schemaVersion: 1,
    principals: [
      {
        id: 'alpha',
        role: 'operator',
        enabled: true,
        tokenSha256: digest(tokens.alpha),
        server: { host: '127.0.0.1', port, ...alphaTls.clientConfig },
      },
      {
        id: 'bravo',
        role: 'observer',
        enabled: true,
        tokenSha256: digest(tokens.bravo),
        server: {
          host: '127.0.0.1',
          port,
          cert: bravoTls.file('client.pem'),
          key: bravoTls.file('client.key'),
          ca: alphaTls.file('ca.pem'),
        },
      },
    ],
  };
}
function writeConfig(folder, value) {
  const file = path.join(folder, 'principals.json');
  writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value),
  );
  return file;
}
async function waitFor(predicate, description, diagnostic = () => ({})) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out: ${description} ${JSON.stringify(diagnostic())}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function startPeer(t) {
  const sockets = new Set(),
    accepted = new Map(),
    messages = new Map(),
    rejected = [];
  const fingerprints = new Map(
    ['alpha', 'bravo'].map((id) => [
      new X509Certificate(
        (id === 'alpha' ? alphaTls : bravoTls).read('client.pem'),
      ).fingerprint256,
      id,
    ]),
  );
  const server = tls.createServer(
    {
      cert: alphaTls.read('server.pem'),
      key: alphaTls.read('server.key'),
      ca: [alphaTls.read('ca.pem'), bravoTls.read('ca.pem')],
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      assert.equal(socket.authorized, true);
      const id = fingerprints.get(socket.getPeerCertificate().fingerprint256);
      assert(
        id,
        'actual mutual TLS authenticated a configured distinct client identity',
      );
      accepted.set(id, socket);
      const framer = createCotStreamFramer({
        onEvent: (xml) => {
          const entries = messages.get(id) || [];
          entries.push(parseCotEvent(xml));
          messages.set(id, entries);
        },
      });
      socket.on('data', (bytes) => framer.push(bytes.toString()));
    },
  );
  server.on('tlsClientError', (error) => rejected.push(error.code));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, accepted, messages, rejected };
}
async function app(t, port) {
  const folder = caseDirectory(),
    value = configuration(port),
    file = writeConfig(folder, value);
  let time = Date.now();
  const instance = await startTakHttpsServer({
    env: {
      TAK_GATEWAY_USERS_FILE: file,
      TAK_GATEWAY_TOKEN: 'legacy-token-must-not-authorize-any-principal',
      TAK_HTTPS_CERT: alphaTls.file('server.pem'),
      TAK_HTTPS_KEY: alphaTls.file('server.key'),
    },
    distRoot: dist,
    providerPlugins: [],
    port: 0,
    now: () => time,
    offlineMaps: {
      root: path.join(folder, 'maps'),
      fetchImpl: async () => {
        throw new Error('Synthetic offline: no external request');
      },
    },
  });
  t.after(instance.close);
  return {
    ...instance,
    folder,
    value,
    file,
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}
function request(
  instance,
  route,
  { method = 'GET', cookie, body, headers = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      instance.origin + route,
      {
        method,
        ca: alphaTls.read('ca.pem'),
        headers: {
          Origin: instance.origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(body !== undefined
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function login(instance, id, token = tokens[id]) {
  instance.advance(13_000);
  const response = await request(instance, '/login', {
    method: 'POST',
    body: new URLSearchParams({ principal: id, token }).toString(),
  });
  assert.equal(response.status, 303, response.body);
  return response.headers['set-cookie'][0].split(';')[0];
}
function connect(instance, cookie, suffix = '') {
  const ws = new WebSocket(
    instance.origin.replace('https:', 'wss:') + '/api/tak/ws' + suffix,
    ['tak.v1'],
    {
      ca: alphaTls.read('ca.pem'),
      origin: instance.origin,
      headers: { Cookie: cookie },
    },
  );
  const inbox = [],
    waiters = new Set();
  ws.history = [];
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        op: 'identity',
        uid: IDENTITY.uid,
        callsign: IDENTITY.callsign,
      }),
    ),
  );
  ws.on('message', (value) => {
    inbox.push(value.toString());
    ws.history.push(value.toString());
    for (const check of [...waiters]) check();
  });
  ws.next = (predicate, timeout = 3000) =>
    new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        const index = inbox.findIndex(predicate);
        if (index < 0) return;
        clearTimeout(timer);
        waiters.delete(check);
        resolve(inbox.splice(index, 1)[0]);
      };
      timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error('Timed out waiting for named gateway frame'));
      }, timeout);
      waiters.add(check);
      check();
    });
  return ws;
}
const op = (name) => (text) =>
  text.startsWith('{') && JSON.parse(text).op === name;
const state = (id, wanted) => (text) =>
  op('submission')(text) &&
  JSON.parse(text).id === id &&
  JSON.parse(text).state === wanted;
const isXml = (text) => text.startsWith('<');

test('strict named configuration pins distinct client identities, stable opaque scopes, and disables insecure fallback', () => {
  const folder = caseDirectory(),
    input = configuration(),
    file = writeConfig(folder, input);
  const principals = readTakPrincipals(file),
    alpha = principals.get('alpha');
  assert.equal(
    authenticateTakPrincipal(principals, 'alpha', tokens.alpha),
    alpha,
  );
  assert.equal(
    authenticateTakPrincipal(principals, 'bravo', tokens.alpha),
    null,
  );
  assert.equal(
    authenticateTakPrincipal(principals, 'unknown', tokens.alpha),
    null,
  );
  assert.match(alpha.storageScope, /^[a-f0-9]{64}$/);
  assert.equal(
    readTakPrincipals(file).get('alpha').storageScope,
    alpha.storageScope,
  );
  assert.notEqual(principals.get('bravo').storageScope, alpha.storageScope);
  const disabled = structuredClone(input);
  disabled.principals[0].enabled = false;
  delete disabled.principals[0].server;
  writeConfig(folder, disabled);
  assert.equal(
    authenticateTakPrincipal(readTakPrincipals(file), 'alpha', tokens.alpha),
    null,
  );
  const tlsOptions = loadTlsOptions(alpha.server);
  assert.deepEqual(tlsOptions.cert, alphaTls.read('client.pem'));
  assert.equal(tlsOptions.rejectUnauthorized, true);
  const changed = structuredClone(input);
  changed.principals[0].role = 'observer';
  writeConfig(folder, changed);
  assert.notEqual(
    readTakPrincipals(file).get('alpha').storageScope,
    alpha.storageScope,
  );
  for (const change of [
    (c) => {
      c.principals[1].id = 'alpha';
    },
    (c) => {
      c.principals[1].tokenSha256 = c.principals[0].tokenSha256;
    },
    (c) => {
      c.principals[1].server = c.principals[0].server;
    },
    (c) => {
      c.principals[0].server.protocol = 'tcp';
    },
    (c) => {
      c.principals[0].role = 'admin';
    },
    (c) => {
      c.principals[0].server.key = bravoTls.file('client.key');
    },
    (c) => {
      c.principals[0].server.cert = alphaTls.file('expired.pem');
    },
    (c) => {
      c.principals[0].id = '../alpha';
    },
    (c) => {
      c.principals.push(...Array.from({ length: 7 }, () => c.principals[0]));
    },
  ]) {
    const invalid = structuredClone(input);
    change(invalid);
    writeConfig(folder, invalid);
    assert.throws(() => readTakPrincipals(file), /configuration/);
  }
  writeConfig(folder, ' '.repeat(65537));
  assert.throws(() => readTakPrincipals(file), /bounded/);
  assert.equal(
    readTakGatewayConfig({
      TAK_GATEWAY: '1',
      TAK_GATEWAY_TOKEN: tokens.alpha,
      TAK_GATEWAY_USERS_FILE: file,
    }).enabled,
    false,
    'dev/lab cannot silently expose one shared principal',
  );
});

test('genuine local HTTPS/WSS/mTLS keeps operator replay, status, identity and observer policy isolated', async (t) => {
  const peer = await startPeer(t),
    instance = await app(t, peer.port);
  const guest = await request(instance, '/api/tak/status');
  assert.equal(guest.status, 401);
  assert.doesNotMatch(guest.body, /alpha|bravo|storageScope|tokenSha256/);
  assert.match((await request(instance, '/login')).body, /name="principal"/);
  instance.advance(13_000);
  const legacyAttempt = await request(instance, '/login', {
    method: 'POST',
    body: new URLSearchParams({
      principal: 'alpha',
      token: 'legacy-token-must-not-authorize-any-principal',
    }).toString(),
  });
  assert.equal(
    legacyAttempt.status,
    401,
    'a legacy token cannot select a named principal',
  );
  const aCookie = await login(instance, 'alpha'),
    bCookie = await login(instance, 'bravo');
  const aStatus = JSON.parse(
    (await request(instance, '/api/tak/status', { cookie: aCookie })).body,
  );
  const bStatus = JSON.parse(
    (
      await request(instance, '/api/tak/status?principal=alpha', {
        cookie: bCookie,
        headers: { 'X-TAK-Principal': 'alpha' },
      })
    ).body,
  );
  assert.equal(aStatus.principal, 'alpha');
  assert.equal(bStatus.principal, 'bravo');
  assert.equal(bStatus.role, 'observer');
  assert.equal(aStatus.multiOperator, true);
  assert.notEqual(aStatus.storageScope, bStatus.storageScope);
  assert.doesNotMatch(
    JSON.stringify([aStatus, bStatus]),
    /tokenSha256|BEGIN.*KEY|material|synthetic-alpha-operator-token/,
  );
  const a = connect(instance, aCookie),
    b = connect(instance, bCookie, '?principal=alpha');
  await Promise.all([a.next(op('identity')), b.next(op('identity'))]);
  await waitFor(
    () => peer.accepted.size === 2,
    'distinct authenticated upstream clients',
    () => ({
      rejected: peer.rejected,
      alpha: a.history
        .filter(op('status'))
        .map((text) => JSON.parse(text).status.server),
      bravo: b.history
        .filter(op('status'))
        .map((text) => JSON.parse(text).status.server),
    }),
  );
  const netA = buildMarker(
    IDENTITY,
    { uid: 'NET-ALPHA', callsign: 'PRIVATE ALPHA', lat: 1, lon: 2 },
    { nowMs: instance.now() },
  );
  const netB = buildMarker(
    IDENTITY,
    { uid: 'NET-BRAVO', callsign: 'PRIVATE BRAVO', lat: 3, lon: 4 },
    { nowMs: instance.now() },
  );
  peer.accepted.get('alpha').write(encodeTakStreamEvent(netA));
  peer.accepted.get('bravo').write(encodeTakStreamEvent(netB));
  assert.equal(parseCotEvent(await a.next(isXml)).uid, netA.uid);
  assert.equal(parseCotEvent(await b.next(isXml)).uid, netB.uid);
  await assert.rejects(a.next(isXml, 100), /Timed out/);
  await assert.rejects(b.next(isXml, 100), /Timed out/);
  const own = buildMarker(
    IDENTITY,
    { callsign: 'ALPHA SHARED', lat: 1, lon: 2 },
    { nowMs: instance.now() },
  );
  a.send(JSON.stringify({ op: 'cot', id: 'own', xml: serializeCotEvent(own) }));
  await a.next(state('own', 'submitted'));
  await waitFor(
    () => peer.messages.get('alpha')?.some((event) => event.uid === own.uid),
    'alpha write on alpha certificate connection',
  );
  assert.equal(peer.messages.get('bravo')?.length || 0, 0);
  for (const [index, event] of [
    own,
    buildSelfSa(IDENTITY, { lat: 1, lon: 2 }, { nowMs: instance.now() }),
    buildChat(
      IDENTITY,
      { message: 'MUST NOT SEND' },
      { nowMs: instance.now() },
    ),
  ].entries()) {
    b.send(
      JSON.stringify({
        op: 'cot',
        id: `observer-${index}`,
        xml: serializeCotEvent(event),
      }),
    );
    assert.match(
      JSON.parse(await b.next(state(`observer-${index}`, 'rejected'))).reason,
      /receive-only/,
    );
  }
  const late = connect(instance, bCookie);
  await late.next(op('identity'));
  assert.equal(parseCotEvent(await late.next(isXml)).uid, netB.uid);
  await assert.rejects(late.next(isXml, 100), /Timed out/);
  const closeA = once(a, 'close');
  await request(instance, '/logout', { method: 'POST', cookie: aCookie });
  assert.equal((await closeA)[0], 1008);
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: aCookie })).status,
    401,
  );
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: bCookie })).status,
    200,
  );
  assert.equal(b.readyState, WebSocket.OPEN);
  b.close();
  late.close();
});

test('principal reconnect queues and reload revocation do not reset or expose unchanged operators', async (t) => {
  const peer = await startPeer(t),
    instance = await app(t, peer.port);
  const aCookie = await login(instance, 'alpha'),
    bCookie = await login(instance, 'bravo');
  const a = connect(instance, aCookie),
    b = connect(instance, bCookie);
  await Promise.all([a.next(op('identity')), b.next(op('identity'))]);
  await waitFor(() => peer.accepted.size === 2, 'upstream clients');
  const bravoSocket = peer.accepted.get('bravo');
  peer.accepted.get('alpha').destroy();
  await a.next(
    (text) =>
      op('status')(text) &&
      JSON.parse(text).status.server.state === 'reconnecting',
  );
  a.send(
    JSON.stringify({
      op: 'cot',
      id: 'outage',
      xml: serializeCotEvent(
        buildMarker(
          IDENTITY,
          { callsign: 'ALPHA OUTAGE', lat: 1, lon: 2 },
          { nowMs: instance.now() },
        ),
      ),
    }),
  );
  await a.next(state('outage', 'queued'));
  b.send(JSON.stringify({ op: 'status' }));
  const isolated = JSON.parse(await b.next(op('status'))).status;
  assert.equal(isolated.server.state, 'connected');
  assert.equal(isolated.server.queue, 0);
  assert.equal(isolated.browsers, 1);
  await a.next(state('outage', 'submitted'), 4000);
  assert.equal(peer.accepted.get('bravo'), bravoSocket);
  const oldScope = JSON.parse(
    (await request(instance, '/api/tak/status', { cookie: aCookie })).body,
  ).storageScope;
  instance.reloadPrincipals();
  assert.equal(peer.accepted.get('bravo'), bravoSocket);
  const changed = structuredClone(instance.value);
  changed.principals[0].tokenSha256 = digest(tokens.alpha + '-rotated');
  writeConfig(instance.folder, changed);
  const aClosed = once(a, 'close');
  instance.reloadPrincipals();
  assert.equal((await aClosed)[0], 1008);
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: aCookie })).status,
    401,
  );
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: bCookie })).status,
    200,
  );
  assert.equal(b.readyState, WebSocket.OPEN);
  const newCookie = await login(instance, 'alpha', tokens.alpha + '-rotated');
  assert.notEqual(
    JSON.parse(
      (await request(instance, '/api/tak/status', { cookie: newCookie })).body,
    ).storageScope,
    oldScope,
  );
  instance.advance(13_000);
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        body: new URLSearchParams({
          principal: 'alpha',
          token: tokens.alpha,
        }).toString(),
      })
    ).status,
    401,
  );
  const replacement = connect(instance, newCookie);
  await replacement.next(op('identity'));
  await waitFor(
    () => peer.accepted.get('alpha')?.readyState === 'open',
    'replacement alpha upstream',
  );
  peer.accepted.get('alpha').destroy();
  await replacement.next(
    (text) =>
      op('status')(text) &&
      JSON.parse(text).status.server.state === 'reconnecting',
  );
  const cancelledMarker = buildMarker(
    IDENTITY,
    { callsign: 'REVOKED QUEUE', lat: 1, lon: 2 },
    { nowMs: instance.now() },
  );
  replacement.send(
    JSON.stringify({
      op: 'cot',
      id: 'revoke-before-reconnect',
      xml: serializeCotEvent(cancelledMarker),
    }),
  );
  await replacement.next(state('revoke-before-reconnect', 'queued'));
  writeConfig(instance.folder, '{invalid');
  const bClosed = once(b, 'close'),
    replacementClosed = once(replacement, 'close');
  assert.throws(() => instance.reloadPrincipals(), /configuration/);
  assert.equal((await bClosed)[0], 1008);
  assert.equal((await replacementClosed)[0], 1008);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(
    peer.messages
      .get('alpha')
      ?.some((event) => event.uid === cancelledMarker.uid),
    false,
    'invalid reload removed queued tactical writes before reconnect',
  );
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: bCookie })).status,
    401,
  );
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: newCookie })).status,
    401,
  );
  writeConfig(instance.folder, changed);
  instance.reloadPrincipals();
  const restored = await login(instance, 'bravo');
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: restored })).status,
    200,
  );
});

test('named session limits and expiry stay bounded while offline cache ownership is never selected by URL', async (t) => {
  const peer = await startPeer(t),
    instance = await app(t, peer.port);
  const cookies = [];
  for (let index = 0; index < 4; index++)
    cookies.push(await login(instance, 'alpha'));
  instance.advance(13_000);
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        body: new URLSearchParams({
          principal: 'alpha',
          token: tokens.alpha,
        }).toString(),
      })
    ).status,
    503,
  );
  const bCookie = await login(instance, 'bravo');
  assert.equal(
    (await request(instance, '/api/maps/offline/packs', { cookie: cookies[0] }))
      .status,
    200,
  );
  assert.equal(
    (await request(instance, '/api/maps/offline/packs', { cookie: bCookie }))
      .status,
    200,
  );
  const aRoots = createPrincipalMapRoots(path.join(instance.folder, 'maps'), [
    dist,
  ]);
  assert.notEqual(await aRoots('alpha'), await aRoots('bravo'));
  const created = await request(instance, '/api/maps/offline/packs', {
    method: 'POST',
    cookie: cookies[0],
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'PRIVATE ALPHA MAP',
      sourceId: 'usgs-topo',
      bounds: { west: 0, south: 0, east: 0.01, north: 0.01 },
      minZoom: 1,
      maxZoom: 1,
    }),
  });
  assert.equal(created.status, 202, created.body);
  const id = JSON.parse(created.body).id;
  assert.equal(
    (
      await request(instance, `/api/maps/offline/packs/${id}`, {
        cookie: bCookie,
      })
    ).status,
    404,
  );
  assert.deepEqual(
    JSON.parse(
      (await request(instance, '/api/maps/offline/packs', { cookie: bCookie }))
        .body,
    ).packs,
    [],
  );
  const a = connect(instance, cookies[0]),
    b = connect(instance, bCookie);
  await Promise.all([a.next(op('identity')), b.next(op('identity'))]);
  const closedA = once(a, 'close'),
    closedB = once(b, 'close');
  instance.advance(SESSION_TTL_MS + 1);
  instance.gateway.recheckSessions();
  assert.equal((await closedA)[0], 1008);
  assert.equal((await closedB)[0], 1008);
  assert.equal(
    (await request(instance, '/api/tak/status', { cookie: cookies[0] })).status,
    401,
  );
});

test('eight durable account map reservations include retired accounts and refuse excess allocation without deleting work', async () => {
  const base = caseDirectory(),
    reserve = createPrincipalMapRoots(base, [dist]);
  const directories = await Promise.all(
    Array.from({ length: 8 }, (_, index) => reserve(`account-${index}`)),
  );
  assert.equal(new Set(directories).size, 8);
  assert.equal(await reserve('account-0'), directories[0]);
  await assert.rejects(reserve('new-account'), /reservations/);
  await assert.rejects(reserve('../escape'), /reservations/);
  assert.equal(PRINCIPAL_MAP_BYTES * 8, 2 * 1024 * 1024 * 1024);
});
