import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createTakTlsFixtures } from './takTlsFixtures.mjs';
import {
  createServerLink,
  encodeTakStreamEvent,
} from '../../server/providers/tak/serverLink.js';
import { buildMarker } from '../tak/protocol/builders.js';
import { parseCotEvent } from '../tak/protocol/cot.js';
import { IDENTITY } from '../tak/protocol/fixtures.mjs';

let fixtures;
before(() => {
  fixtures = createTakTlsFixtures();
});
after(() => {
  fixtures?.cleanup();
});

async function waitFor(predicate, description) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await delay(10);
  }
}

async function startPeer(t, certificate = 'server.pem') {
  const sockets = new Set();
  const accepted = [];
  const incoming = [];
  const rejected = [];
  const server = tls.createServer(
    {
      cert: fixtures.read(certificate),
      key: fixtures.read('server.key'),
      ca: fixtures.read('ca.pem'),
      requestCert: true,
      rejectUnauthorized: true,
      maxVersion: 'TLSv1.2',
    },
    (socket) => {
      accepted.push(socket);
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => incoming.push(chunk));
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('tlsClientError', (error) => rejected.push(error.code));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, accepted, incoming, rejected };
}

function startLink(t, port, overrides = {}, options = {}) {
  const inbound = [];
  const states = [];
  const reconnects = [];
  const link = createServerLink({
    config: {
      host: '127.0.0.1',
      port,
      protocol: 'tls',
      tls: { ...fixtures.clientConfig, ...overrides },
    },
    onXml: (xml) => inbound.push(xml),
    onStatus: (s) => states.push(s.state),
    setTimer: (fn, ms) => {
      reconnects.push({ fn, ms });
      return reconnects.length;
    },
    clearTimer() {},
    ...options,
  });
  t.after(() => link.close());
  return { link, inbound, states, reconnects };
}

test('real local mutual TLS accepts authorized client and exchanges exact XML stream frames', async (t) => {
  const peer = await startPeer(t);
  const client = startLink(t, peer.port);
  await waitFor(
    () =>
      client.link.status().state === 'connected' && peer.accepted.length === 1,
    'mTLS connected',
  );
  assert.equal(peer.accepted[0].authorized, true);
  const marker = buildMarker(IDENTITY, {
    callsign: 'SYNTHETIC',
    lat: 34,
    lon: -89,
  });
  assert.equal(client.link.send('', marker), true);
  await waitFor(
    () => peer.incoming.join('') === encodeTakStreamEvent(marker),
    'wire frame',
  );
  const wire = peer.incoming.join('');
  assert.match(wire, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<event/);
  assert.ok(wire.endsWith('</event>'));
  peer.accepted[0].write(encodeTakStreamEvent(marker));
  await waitFor(() => client.inbound.length === 1, 'peer reply');
  assert.equal(parseCotEvent(client.inbound[0]).uid, marker.uid);
});

for (const scenario of [
  {
    name: 'untrusted server CA',
    certificate: 'server.pem',
    overrides: () => ({ ca: fixtures.file('other-ca.pem') }),
    error: /SELF_SIGNED|ISSUER|VERIFY/,
  },
  {
    name: 'wrong server hostname',
    certificate: 'wrong-host.pem',
    overrides: () => ({}),
    error: /CERT_ALTNAME_INVALID/,
  },
  {
    name: 'expired server certificate',
    certificate: 'expired.pem',
    overrides: () => ({}),
    error: /CERT_HAS_EXPIRED/,
  },
  {
    name: 'untrusted client certificate',
    certificate: 'server.pem',
    overrides: () => ({ cert: fixtures.file('untrusted-client.pem') }),
    error: /ALERT|SSL|TLS|RESET/,
  },
]) {
  test(`real TLS rejects ${scenario.name} and schedules a bounded reconnect`, async (t) => {
    const peer = await startPeer(t, scenario.certificate);
    const client = startLink(t, peer.port, scenario.overrides());
    client.link.send(
      '',
      buildMarker(IDENTITY, { callsign: 'MUST-NOT-LEAK', lat: 34, lon: -89 }),
    );
    await waitFor(
      () => client.link.status().state === 'reconnecting',
      scenario.name,
    );
    assert.match(client.link.status().lastError, scenario.error);
    assert.ok(!client.states.includes('connected'));
    // The server can finish its side before the client verifies its identity;
    // no application CoT may leave the unverified gateway connection.
    assert.equal(peer.incoming.join(''), '');
    if (scenario.name === 'untrusted client certificate')
      assert.equal(peer.accepted.length, 0);
    assert.equal(client.reconnects.length, 1);
    assert.equal(client.reconnects[0].ms, 1000);
    client.link.close();
    client.reconnects[0].fn();
    assert.equal(client.link.status().state, 'closed');
  });
}

test('real mutual TLS peer rejects a client which omits its certificate', async (t) => {
  const peer = await startPeer(t);
  const client = startLink(
    t,
    peer.port,
    {},
    {
      connect: () =>
        tls.connect({
          host: '127.0.0.1',
          port: peer.port,
          ca: fixtures.read('ca.pem'),
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
        }),
    },
  );
  await waitFor(
    () => client.link.status().state === 'reconnecting',
    'missing client certificate rejected',
  );
  assert.equal(peer.accepted.length, 0);
  assert.ok(!client.states.includes('connected'));
  assert.ok(peer.rejected.length > 0);
});
