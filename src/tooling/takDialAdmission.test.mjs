import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDeviceDialAdmission,
  DEVICE_DIAL_LIMITS,
  deviceDialAdmission,
} from '../../server/providers/tak/dialAdmission.js';
import { createServerLink } from '../../server/providers/tak/serverLink.js';
import { createDeviceStreamPool } from '../../server/providers/tak/deviceStreams.js';
import { createIdentity, buildSelfSa } from '../tak/protocol/builders.js';
import { serializeCotEvent } from '../tak/protocol/cot.js';
import { createTakTlsFixtures } from './takTlsFixtures.mjs';

function clock() {
  let time = 1800000000000,
    next = 0;
  const timers = new Map();
  return {
    timers,
    now: () => time,
    setTimer(fn, ms) {
      const id = ++next;
      timers.set(id, { fn, at: time + ms, ms });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const until = time + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
      }
      time = until;
    },
  };
}
class Socket extends EventEmitter {
  authorized = true;
  destroyed = false;
  writableLength = 0;
  setEncoding() {}
  setKeepAlive() {}
  setTimeout() {}
  write(_xml, callback) {
    callback?.();
    return true;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
  }
}
function link(t, gate, time, options = {}) {
  const sockets = [],
    states = [];
  const instance = createServerLink({
    config: { protocol: 'tls', host: '127.0.0.1', port: 18089 },
    dialAdmission: gate,
    ...time,
    onXml() {},
    onStatus: (status) => states.push(status),
    connect() {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  t.after(() => instance.close());
  return { instance, sockets, states };
}
async function wait(predicate, label, diagnostic = () => ({})) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(
        'Timed out: ' + label + ' ' + JSON.stringify(diagnostic()),
      );
    await delay(5);
  }
}

test('process admission reserves before dialing, caps two handshakes and bounds the waiting queue', () => {
  const gate = createDeviceDialAdmission(),
    cancellations = [],
    releases = [];
  let peak = 0;
  for (let i = 0; i < DEVICE_DIAL_LIMITS.pending; i++)
    cancellations.push(
      gate.request((release) => {
        releases.push(release);
        peak = Math.max(peak, gate.status().active);
      }),
    );
  assert.deepEqual(gate.status(), { active: 2, waiting: 30 });
  assert.equal(
    gate.request(() => assert.fail('excess request dialed')),
    null,
  );
  cancellations[10]();
  assert.deepEqual(gate.status(), { active: 2, waiting: 29 });
  assert.ok(gate.request((release) => releases.push(release)));
  for (const cancel of cancellations) cancel();
  for (const release of releases) release();
  assert.equal(peak, 2);
  assert.deepEqual(gate.status(), { active: 0, waiting: 0 });
});

test('opt-in links share two slots; queued destroy never dials and success releases before the next handshake', (t) => {
  const gate = createDeviceDialAdmission(),
    time = clock(),
    links = Array.from({ length: 5 }, () => link(t, gate, time));
  assert.deepEqual(
    links.map((item) => item.sockets.length),
    [1, 1, 0, 0, 0],
  );
  links[2].instance.close();
  links[0].sockets[0].emit('secureConnect');
  assert.deepEqual(
    links.map((item) => item.sockets.length),
    [1, 1, 0, 1, 0],
  );
  assert.deepEqual(gate.status(), { active: 2, waiting: 1 });
  links[1].instance.close();
  assert.equal(links[4].sockets.length, 1);
  for (const item of links) item.instance.close();
  time.advance(120000);
  assert.deepEqual(gate.status(), { active: 0, waiting: 0 });
  assert.equal(time.timers.size, 0);
});

test('failed TLS, synchronous connect throws and early close release admission without bypassing retry bounds', (t) => {
  const gate = createDeviceDialAdmission({ random: () => 1 }),
    time = clock();
  const bad = link(t, gate, time),
    silent = link(t, gate, time),
    next = link(t, gate, time);
  bad.sockets[0].authorized = false;
  bad.sockets[0].emit('secureConnect');
  assert.equal(bad.instance.status().lastError, 'TLS_UNAUTHORIZED');
  assert.equal(next.sockets.length, 1);
  assert.ok([...time.timers.values()].some((timer) => timer.ms === 1250));
  silent.sockets[0].emit('error', { code: 'CERT_REJECTED' });
  assert.equal(silent.sockets[0].destroyed, true);
  assert.equal(gate.status().active, 1);
  const failed = link(t, gate, time, {
    connect() {
      throw Object.assign(new Error('synthetic'), { code: 'CONNECT_THROW' });
    },
  });
  assert.equal(failed.instance.status().lastError, 'CONNECT_THROW');
  assert.equal(gate.status().active, 1);
  for (const item of [bad, silent, next, failed]) item.instance.close();
  time.advance(60000);
  assert.deepEqual(gate.status(), { active: 0, waiting: 0 });
  assert.equal(time.timers.size, 0);
});

test('silent unauthenticated peers lose their slots at15seconds rather than the120second idle timeout', (t) => {
  const gate = createDeviceDialAdmission(),
    time = clock(),
    links = Array.from({ length: 3 }, () => link(t, gate, time));
  time.advance(14999);
  assert.equal(links[2].sockets.length, 0);
  time.advance(1);
  for (const item of links.slice(0, 2)) {
    assert.equal(item.sockets[0].destroyed, true);
    assert.equal(item.instance.status().lastError, 'TLS_HANDSHAKE_TIMEOUT');
  }
  assert.equal(links[2].sockets.length, 1);
  assert.deepEqual(gate.status(), { active: 1, waiting: 0 });
  links[2].sockets[0].emit('secureConnect');
  assert.equal(gate.status().active, 0);
});

test('late canceled admission and obsolete socket callbacks cannot dial or retire a newer generation', (t) => {
  const callbacks = [],
    time = clock();
  let releases = 0,
    dials = 0;
  const gate = {
    request(fn) {
      callbacks.push(fn);
      return () => {};
    },
    retryDelay: (base) => base,
  };
  const pending = link(t, gate, time, {
    connect() {
      dials++;
      return new Socket();
    },
  });
  pending.instance.close();
  callbacks[0](() => releases++);
  assert.equal(dials, 0);
  assert.equal(releases, 1);
  const real = createDeviceDialAdmission({ random: () => 0 }),
    a = link(t, real, time);
  const old = a.sockets[0];
  old.destroy();
  time.advance(1000);
  assert.equal(a.sockets.length, 2);
  old.emit('secureConnect');
  old.emit('error', { code: 'OLD_FAILURE' });
  old.emit('timeout');
  assert.equal(real.status().active, 1);
  assert.equal(a.sockets[1].destroyed, false);
  a.sockets[1].emit('secureConnect');
  assert.equal(real.status().active, 0);
});

test('retry jitter is bounded and capped at30seconds; legacy links do not use admission or handshake deadlines', (t) => {
  const maximum = createDeviceDialAdmission({ random: () => 1 }),
    minimum = createDeviceDialAdmission({ random: () => 0 });
  for (const base of [1000, 2000, 4000, 8000, 16000, 30000]) {
    assert.equal(minimum.retryDelay(base, 30000), base);
    assert.equal(maximum.retryDelay(base, 30000), Math.min(base + 250, 30000));
  }
  const time = clock(),
    legacy = link(t, undefined, time);
  assert.equal(time.timers.size, 0);
  legacy.sockets[0].destroy();
  assert.deepEqual(
    [...time.timers.values()].map((timer) => timer.ms),
    [1000],
  );
});

test('a reconnect observer that closes its link cannot leave a late retry timer', (t) => {
  const gate = createDeviceDialAdmission(),
    time = clock();
  let instance;
  const result = link(t, gate, time, {
    onStatus(status) {
      if (status.state === 'reconnecting') instance.close();
    },
  });
  instance = result.instance;
  result.sockets[0].destroy();
  assert.equal(time.timers.size, 0);
  assert.deepEqual(gate.status(), { active: 0, waiting: 0 });
  time.advance(120000);
  assert.equal(result.sockets.length, 1);
});

test('different principal pools pass the same process admission into their real server-link factories', (t) => {
  const time = clock(),
    sockets = [],
    pools = [];
  for (let i = 0; i < 3; i++) {
    const pool = createDeviceStreamPool({
      config: { protocol: 'tls', host: '127.0.0.1', port: 18089 },
      now: time.now,
      onReceive() {},
      setInterval: () => 1,
      clearInterval() {},
      createServer(options) {
        assert.equal(options.dialAdmission, deviceDialAdmission);
        assert.equal(options.handshakeMs, 15000);
        return createServerLink({
          ...options,
          ...time,
          connect() {
            const socket = new Socket();
            sockets.push(socket);
            return socket;
          },
        });
      },
    });
    pools.push(pool);
    t.after(() => pool.close());
    const identity = createIdentity(),
      ref = {};
    assert.equal(
      pool.attach(ref, { ...identity, authorized: () => true }).ok,
      true,
    );
    const sa = buildSelfSa(
      identity,
      { lat: 1, lon: 2, source: 'USER' },
      { nowMs: time.now() },
    );
    assert.equal(
      pool.send(serializeCotEvent(sa), sa, { deviceRef: ref }),
      true,
    );
  }
  assert.equal(deviceDialAdmission.status().active, 2);
  assert.equal(deviceDialAdmission.status().waiting, 1);
  for (const pool of pools) pool.close();
  assert.deepEqual(deviceDialAdmission.status(), { active: 0, waiting: 0 });
  assert.equal(time.timers.size, 0);
});

test('actual silent TLS connections time out and release capacity for a queued connection', async (t) => {
  const sockets = new Set(),
    server = net.createServer((socket) => {
      sockets.add(socket);
      socket.resume();
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const gate = createDeviceDialAdmission(),
    clientSockets = new Set(),
    clients = [],
    states = [];
  for (let i = 0; i < 3; i++) {
    const client = createServerLink({
      config: {
        protocol: 'tls',
        host: '127.0.0.1',
        port: server.address().port,
      },
      dialAdmission: gate,
      handshakeMs: 100,
      connect: () => {
        const socket = tls.connect({
          host: '127.0.0.1',
          port: server.address().port,
          rejectUnauthorized: true,
        });
        clientSockets.add(socket);
        socket.once('close', () => clientSockets.delete(socket));
        return socket;
      },
      onXml() {},
      onStatus: (status) => states.push(status),
    });
    clients.push(client);
    t.after(() => client.close());
  }
  assert.deepEqual(gate.status(), { active: 2, waiting: 1 });
  await wait(
    () =>
      states.filter((status) => status.lastError === 'TLS_HANDSHAKE_TIMEOUT')
        .length >= 2,
    'actual silent handshake timeout',
  );
  await wait(() => gate.status().waiting === 0, 'queued client admitted');
  for (const client of clients) client.close();
  await wait(
    () => !clientSockets.size && !sockets.size,
    'actual owned TLS and peer sockets closed',
  );
  assert.deepEqual(gate.status(), { active: 0, waiting: 0 });
});

test('real certificate rejection releases admission before a queued verified mTLS peer exchanges data', async (t) => {
  const certs = createTakTlsFixtures();
  t.after(() => certs.cleanup());
  const sockets = new Set(),
    accepted = [],
    incoming = [];
  const server = tls.createServer(
    {
      cert: certs.read('server.pem'),
      key: certs.read('server.key'),
      ca: certs.read('ca.pem'),
      requestCert: true,
      rejectUnauthorized: true,
      maxVersion: 'TLSv1.2',
    },
    (socket) => {
      accepted.push(socket);
      socket.on('error', () => {});
      socket.on('data', (data) => incoming.push(data.toString('utf8')));
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const gate = createDeviceDialAdmission(),
    clients = [],
    received = [],
    identities = [];
  for (let i = 0; i < 3; i++) {
    const client = createServerLink({
      config: {
        protocol: 'tls',
        host: '127.0.0.1',
        port: server.address().port,
        tls: {
          ...certs.clientConfig,
          ...(i < 2 ? { ca: certs.file('other-ca.pem') } : {}),
        },
      },
      dialAdmission: gate,
      onXml: (xml) => received.push(xml),
    });
    clients.push(client);
    const identity = createIdentity();
    identities.push(identity);
    const event = buildSelfSa(identity, { lat: 1, lon: 2, source: 'USER' });
    assert.equal(client.send(serializeCotEvent(event), event), true);
    t.after(() => client.close());
  }
  assert.deepEqual(gate.status(), { active: 2, waiting: 1 });
  await wait(
    () =>
      clients[0].status().state === 'reconnecting' &&
      clients[1].status().state === 'reconnecting' &&
      clients[2].status().state === 'connected' &&
      accepted.length >= 1,
    'rejected CAs release for verified peer',
    () => ({
      gate: gate.status(),
      clients: clients.map((client) => client.status()),
      accepted: accepted.length,
    }),
  );
  await wait(
    () => incoming.join('').includes(identities[2].uid),
    'only verified connection flushes its queued CoT',
  );
  for (const identity of identities.slice(0, 2))
    assert.equal(incoming.join('').includes(identity.uid), false);
  const identity = createIdentity(),
    event = buildSelfSa(identity, { lat: 1, lon: 2, source: 'USER' });
  // A TLS1.2 server can finish authenticating the client just before that
  // client rejects its server certificate. Only the verified client link may
  // process application data; server callback count is not that proof.
  for (const socket of accepted)
    if (!socket.destroyed) socket.write(serializeCotEvent(event));
  await wait(() => received.length === 1, 'actual mTLS return event');
  assert.equal(clients[0].status().rx, 0);
  assert.equal(clients[1].status().rx, 0);
  assert.equal(clients[2].status().rx, 1);
  assert.equal(gate.status().active, 0);
  for (const client of clients) client.close();
  await wait(
    () => !sockets.size,
    'actual peer observes all accepted and rejected clients closed',
  );
});
