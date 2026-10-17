import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createDeviceStreamPool,
  DEVICE_STREAM_LIMITS,
} from '../../server/providers/tak/deviceStreams.js';
import {
  buildMarker,
  buildSelfSa,
  createIdentity,
} from '../tak/protocol/builders.js';
import { serializeCotEvent } from '../tak/protocol/cot.js';

function fixture(t, options = {}) {
  let time = 1_800_000_000_000,
    tick;
  const links = [],
    received = [],
    pool = createDeviceStreamPool({
      config: { protocol: 'tls', host: '127.0.0.1', port: 18089 },
      now: () => time,
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval() {},
      onReceive: (...args) => received.push(args),
      createServer(hooks) {
        const sent = [],
          queue = [],
          link = {
            hooks,
            sent,
            queue,
            closed: false,
            send(xml, event, tracking) {
              const item = { xml, event, tracking };
              sent.push(item);
              tracking?.onState?.({ state: 'queued' });
              if (options.queued) queue.push(item);
              else
                tracking?.onState?.({
                  state:
                    tracking?.canWrite?.() === false ? 'rejected' : 'submitted',
                });
              return true;
            },
            cancel(owner) {
              for (const item of [...queue])
                if (item.tracking?.owner === owner) {
                  queue.splice(queue.indexOf(item), 1);
                  item.tracking.onState({ state: 'rejected' });
                }
            },
            status: () => ({ state: 'connected' }),
            close() {
              this.closed = true;
              for (const item of queue.splice(0))
                item.tracking?.onState?.({ state: 'rejected' });
            },
          };
        links.push(link);
        hooks.onStatus({ state: 'connected' });
        return link;
      },
      ...options.pool,
    });
  t.after(() => pool.close());
  function join(identity = createIdentity()) {
    const ref = {},
      state = { authorized: true };
    const result = pool.attach(ref, {
      ...identity,
      authorized: () => state.authorized,
    });
    return { ref, identity, state, result };
  }
  function send(member, event, observer = () => {}) {
    return pool.send(serializeCotEvent(event), event, {
      deviceRef: member.ref,
      owner: member.ref,
      onState: observer,
      canWrite: () => member.state.authorized,
    });
  }
  function presence(member) {
    return send(
      member,
      buildSelfSa(
        member.identity,
        { lat: 38.8895, lon: -77.0353, source: 'USER' },
        { nowMs: time },
      ),
    );
  }
  function marker(uid = randomUUID(), remarks) {
    return buildMarker(
      createIdentity(),
      { uid, callsign: 'SYNTHETIC', lat: 1, lon: 2, remarks },
      { nowMs: time },
    );
  }
  return {
    pool,
    links,
    received,
    join,
    send,
    presence,
    marker,
    now: () => time,
    elapse(ms) {
      time += ms;
    },
    advance(ms) {
      time += ms;
      tick();
    },
  };
}

test('TLS-only lazy feed preserves SA-off public actions; first device endpoint is explicit USER SA', (t) => {
  const f = fixture(t);
  assert.equal(f.links.length, 0);
  const a = f.join();
  assert.equal(a.result.ok, true);
  assert.equal(f.pool.status().streams, 1);
  assert.equal(f.send(a, f.marker()), true);
  assert.equal(f.links[0].sent.length, 1);
  assert.equal(f.links[0].sent[0].event.detail.endpoint, null);
  assert.equal(f.presence(a), true);
  assert.equal(f.links[0].closed, true);
  assert.equal(f.pool.status().streams, 1);
  assert.equal(f.links[1].sent[0].event.uid, a.identity.uid);
  assert.equal(f.links[1].sent[0].event.how, 'h-e');
  assert.equal(f.pool.status().presence[0].presenceSent, true);
  assert.throws(
    () => createDeviceStreamPool({ config: { protocol: 'tcp' } }),
    /TLS/,
  );
});

test('duplicate UID tabs share one stream and one presence publisher; conflict and stale authorization fail closed', (t) => {
  const f = fixture(t),
    a = f.join(),
    mirror = f.join(a.identity);
  assert.equal(f.presence(a), true);
  assert.equal(f.presence(mirror), false);
  assert.equal(f.pool.status().streams, 1);
  assert.equal(
    f.pool.attach(
      {},
      { ...a.identity, callsign: 'OTHER', authorized: () => true },
    ).ok,
    false,
  );
  assert.equal(f.pool.stopPresence(mirror.ref), false);
  a.state.authorized = false;
  f.advance(1);
  assert.equal(f.links[1].closed, true);
  assert.equal(f.pool.status().presence[0].active, false);
  assert.equal(
    f.presence(mirror),
    true,
    'remaining tab must explicitly send new authorized presence',
  );
});

test('presence expiry and stop close routing; late ingress from retired stream is ignored', (t) => {
  const f = fixture(t),
    a = f.join();
  f.presence(a);
  const retired = f.links.at(-1);
  f.advance(DEVICE_STREAM_LIMITS.presenceMs);
  assert.equal(retired.closed, true);
  assert.equal(f.pool.status().presence[0].active, false);
  retired.hooks.onXml(serializeCotEvent(f.marker('retired')));
  assert.equal(f.received.length, 0);
  f.presence(a);
  assert.equal(f.pool.stopPresence(a.ref), true);
  assert.equal(f.pool.status().presence[0].active, false);
});

test('self presence validates exact identity, canonical endpoint and fresh observation', (t) => {
  const f = fixture(t),
    a = f.join();
  const sa = buildSelfSa(
    a.identity,
    { lat: 1, lon: 2, source: 'USER' },
    { nowMs: f.now() },
  );
  assert.equal(
    f.send(a, { ...sa, detail: { ...sa.detail, callsign: 'IMPOSTOR' } }),
    false,
  );
  assert.equal(
    f.send(a, {
      ...sa,
      detail: { ...sa.detail, endpoint: '192.0.2.1:1234:tcp' },
    }),
    false,
  );
  assert.equal(f.send(a, { ...sa, timeMs: f.now() - 30_001 }), false);
  assert.equal(f.pool.status().presence[0].active, false);
});

test('only fresh self-SA can carry an endpoint before or after reconnect', (t) => {
  const f = fixture(t),
    a = f.join(),
    marker = f.marker('NOT-A-DEVICE');
  const endpointMarker = {
    ...marker,
    detail: { ...marker.detail, endpoint: '*:-1:stcp' },
  };
  assert.equal(f.send(a, endpointMarker), false);
  assert.equal(f.links[0].sent.length, 0);
  assert.equal(f.presence(a), true);
  const wire = f.links.at(-1);
  wire.hooks.onStatus({ state: 'reconnecting' });
  wire.hooks.onStatus({ state: 'connected' });
  assert.equal(f.pool.status().presence[0].presenceSent, false);
  assert.equal(f.send(a, endpointMarker), false);
  assert.equal(
    f.send(a, marker),
    true,
    'endpoint-free public work remains usable',
  );
  assert.equal(f.pool.status().presence[0].presenceSent, false);
  assert.equal(f.presence(a), true);
  assert.equal(f.pool.status().presence[0].presenceSent, true);
  assert.equal(
    wire.sent
      .filter((item) => item.event.detail.endpoint)
      .every(
        (item) =>
          item.event.uid === a.identity.uid && item.event.type.startsWith('a-'),
      ),
    true,
  );
});

test('lease expiry rejects routing synchronously before the periodic cleanup tick', (t) => {
  const f = fixture(t),
    a = f.join();
  f.presence(a);
  const wire = f.links.at(-1);
  f.elapse(DEVICE_STREAM_LIMITS.presenceMs);
  wire.hooks.onXml(serializeCotEvent(f.marker('EXPIRED-PRIVATE')));
  assert.equal(f.received.length, 0);
  assert.equal(wire.closed, true);
  assert.equal(f.pool.status().presence[0].active, false);
  assert.equal(
    f.send(a, f.marker()),
    true,
    'fresh public work uses the shared feed',
  );
});

test('growing a populated pool immediately trims every retained replay partition', (t) => {
  const f = fixture(t),
    a = f.join();
  for (let i = 0; i < 1000; i++)
    f.links[0].hooks.onXml(serializeCotEvent(f.marker(`old-public-${i}`)));
  assert.equal(f.pool.replay(a.ref).length, 1000);
  f.presence(a);
  const privateWire = f.links.at(-1),
    b = f.join(),
    sharedWire = f.links.at(-1),
    share = Math.floor(DEVICE_STREAM_LIMITS.replayEntries / 3);
  assert.equal(f.pool.replay(a.ref).length, share);
  assert.equal(f.pool.replay(b.ref).length, share);
  for (let i = 0; i < share; i++) {
    privateWire.hooks.onXml(serializeCotEvent(f.marker(`private-A-${i}`)));
    sharedWire.hooks.onXml(serializeCotEvent(f.marker(`new-public-${i}`)));
  }
  const c = f.join(),
    reduced = Math.floor(DEVICE_STREAM_LIMITS.replayEntries / 4);
  for (const member of [a, b, c])
    assert.equal(f.pool.replay(member.ref).length, reduced);
  assert.ok(
    f.pool.replay(a.ref).every((item) => item.xml.includes('private-A-')),
  );
  assert.ok(
    f.pool.replay(c.ref).every((item) => item.xml.includes('new-public-')),
  );
});

test('attaching another UID immediately reduces existing dedup history without requiring a new write', (t) => {
  const f = fixture(t),
    a = f.join();
  let oldest, newest;
  for (let i = 0; i < DEVICE_STREAM_LIMITS.seenEntries; i++) {
    const xml = serializeCotEvent(f.marker(`dedup-${i}`));
    if (!i) oldest = xml;
    newest = xml;
    f.pool.rememberPublic(xml);
  }
  f.join();
  f.links[0].hooks.onXml(oldest);
  f.links[0].hooks.onXml(newest);
  assert.equal(f.received.filter((item) => item[0] === a.ref).length, 1);
  assert.ok(
    f.received.find((item) => item[0] === a.ref)[1].includes('dedup-0'),
  );
});

test('four streams include shared feed; no fifth dial and no active-device eviction', (t) => {
  const f = fixture(t),
    members = Array.from({ length: 4 }, () => f.join());
  for (const a of members) assert.equal(f.presence(a), true);
  assert.equal(f.pool.status().streams, 4);
  const excess = f.join();
  assert.equal(excess.result.ok, false);
  assert.equal(f.pool.status().devices, 4);
  assert.equal(f.pool.status().streams, 4);
  f.pool.stopPresence(members[0].ref);
  assert.equal(
    f.pool.status().streams,
    4,
    'three device streams and one shared feed',
  );
});

test('global UID claims reject another pool and release on last tab/destroy', (t) => {
  const one = fixture(t),
    two = fixture(t),
    a = one.join();
  assert.equal(two.join(a.identity).result.ok, false);
  one.pool.detach(a.ref);
  assert.equal(two.join(a.identity).result.ok, true);
});

test('process-wide dial cap bounds independent principals and releases reservations on close', (t) => {
  const pools = Array.from({ length: 8 }, () => fixture(t));
  for (const f of pools) {
    const members = Array.from({ length: 4 }, () => f.join());
    for (const a of members) assert.equal(f.presence(a), true);
  }
  const ninth = fixture(t);
  assert.equal(ninth.join().result.ok, false);
  assert.equal(ninth.links.length, 0);
  pools[0].pool.close();
  assert.equal(ninth.join().result.ok, true);
});

test('stripped-routing identical XML reaches each intended UID independently and never a third UID or its replay', (t) => {
  const f = fixture(t),
    a = f.join(),
    b = f.join(),
    c = f.join();
  f.presence(a);
  const aWire = f.links.at(-1);
  f.presence(b);
  const bWire = f.links.at(-1);
  const xml = serializeCotEvent(f.marker('PRIVATE-SERVER-MARKER'));
  aWire.hooks.onXml(xml);
  bWire.hooks.onXml(xml);
  aWire.hooks.onXml(xml);
  assert.deepEqual(
    f.received.map((r) => r[0]),
    [a.ref, b.ref],
  );
  assert.equal(f.received[0][3].ownerUid, a.identity.uid);
  assert.equal(f.received[1][3].ownerUid, b.identity.uid);
  assert.equal(f.pool.replay(c.ref).length, 0);
  const mirror = f.join(a.identity);
  assert.equal(f.pool.replay(mirror.ref).length, 1);
  assert.equal(f.pool.replay(c.ref).length, 0);
});

test('shared feed serves only SA-off devices and contact replay never copies a private device partition', (t) => {
  const f = fixture(t),
    a = f.join(),
    b = f.join();
  const shared = f.links[0];
  f.presence(a);
  const privateWire = f.links.at(-1);
  shared.hooks.onXml(serializeCotEvent(f.marker('PUBLIC-SHARED')));
  privateWire.hooks.onXml(serializeCotEvent(f.marker('PRIVATE-A')));
  assert.deepEqual(
    f.received.map((r) => r[0]),
    [b.ref, a.ref],
  );
  const c = f.join();
  assert.deepEqual(
    f.pool.replay(c.ref).map((item) => /uid="([^"]+)"/.exec(item.xml)[1]),
    ['PUBLIC-SHARED'],
  );
});

test('four copied 100Hz public feeds retain per-device delivery instead of spending one principal frame bucket four times', (t) => {
  const f = fixture(t),
    wires = [],
    members = Array.from({ length: 4 }, () => f.join());
  for (const a of members) {
    f.presence(a);
    wires.push(f.links.at(-1));
  }
  for (let i = 0; i < 750; i++) {
    f.advance(10);
    const xml = serializeCotEvent(f.marker('public-' + i));
    for (const wire of wires) wire.hooks.onXml(xml);
  }
  assert.equal(f.received.length, 3000);
  for (const a of members)
    assert.equal(f.received.filter((r) => r[0] === a.ref).length, 750);
  assert.equal(f.pool.status().wireLimited, 0);
  assert.equal(f.pool.status().deliveryLimited, 0);
});

test('wire byte flood is bounded without consuming another device delivery share', (t) => {
  const f = fixture(t),
    a = f.join(),
    b = f.join();
  f.presence(a);
  const aw = f.links.at(-1);
  f.presence(b);
  const bw = f.links.at(-1);
  for (let i = 0; i < 700; i++)
    aw.hooks.onXml(serializeCotEvent(f.marker('large-' + i, 'x'.repeat(4096))));
  assert.ok(f.pool.status().wireLimited > 0);
  bw.hooks.onXml(serializeCotEvent(f.marker('fair-B')));
  assert.equal(f.received.at(-1)[0], b.ref);
  assert.match(f.received.at(-1)[1], /fair-B/);
});

test('aggregate pending cap, exact owner cancellation, reconnect epoch and late completion are bounded', (t) => {
  const f = fixture(t, { queued: true }),
    a = f.join(),
    b = f.join(),
    outcomes = [];
  f.presence(a);
  const aw = f.links.at(-1);
  f.presence(b);
  for (let i = 0; i < 254; i++)
    assert.equal(
      f.send(i % 2 ? a : b, f.marker(), (state) => outcomes.push(state)),
      true,
    );
  assert.equal(f.pool.status().queue, 256);
  assert.equal(f.send(a, f.marker()), false);
  f.pool.cancel(a.ref);
  assert.equal(f.pool.status().queue, 128);
  const old = aw.sent.find((item) => item.tracking);
  aw.hooks.onStatus({ state: 'reconnecting' });
  assert.equal(old.tracking.canWrite(), false);
  f.pool.close();
  assert.equal(f.pool.status().queueBytes, 0);
  const count = outcomes.length;
  old.tracking.onState({ state: 'submitted' });
  assert.equal(outcomes.length, count);
});

test('receive-only pool cannot publish presence/public actions; invalid auth never dials', (t) => {
  const f = fixture(t, { pool: { readOnly: true } }),
    a = f.join();
  assert.equal(f.presence(a), false);
  assert.equal(f.send(a, f.marker()), false);
  f.links[0].hooks.onXml(serializeCotEvent(f.marker('OBSERVED')));
  assert.equal(f.received.length, 1);
  const other = fixture(t);
  assert.equal(
    other.pool.attach({}, { ...createIdentity(), authorized: () => false }).ok,
    false,
  );
  assert.equal(other.links.length, 0);
});
