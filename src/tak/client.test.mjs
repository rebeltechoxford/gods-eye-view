import test from 'node:test';
import assert from 'node:assert/strict';
import { createTakStore } from './store.js';
import { GPS_FIX_MAX_AGE_MS } from './position.js';
import {
  IDENTITY_STORAGE_KEY,
  SA_INTERVAL_MS,
  createTakClient,
} from './client.js';
import { parseCotEvent, serializeCotEvent } from './protocol/cot.js';
import { buildMarker, buildSelfSa } from './protocol/builders.js';
import {
  ATAK_CHAT,
  ATAK_DELETE,
  ATAK_SA,
  IDENTITY,
  T0,
  WINTAK_HOSTILE,
} from './protocol/fixtures.mjs';

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

function timers() {
  const active = new Map();
  let seq = 0;
  return {
    setInterval: (fn, ms) => {
      active.set(++seq, { fn, ms });
      return seq;
    },
    clearInterval: (id) => active.delete(id),
    fire(ms) {
      for (const t of Array.from(active.values())) if (t.ms === ms) t.fn();
    },
    count: () => active.size,
  };
}

function fakeTransport() {
  const t = { sent: [], handlers: null, open: false, connects: [] };
  t.factory = (handlers) => {
    t.handlers = handlers;
    return {
      connect: ({ token }) => {
        t.connects.push(token);
        t.open = true;
        handlers.onState('open');
      },
      disconnect: () => {
        t.open = false;
        handlers.onState('closed');
      },
      send: (xml) => {
        if (!t.open) return false;
        t.sent.push(xml);
        return true;
      },
      submit: (id, xml) => {
        if (!t.open) return false;
        t.lastSubmissionId = id;
        t.sent.push(xml);
        return true;
      },
      cancelSubmissions: () => {
        t.cancelled = (t.cancelled || 0) + 1;
      },
      requestStatus: () => {},
    };
  };
  return t;
}

test('client correlates submission outcomes without republishing imports or local markers across reconnects', () => {
  const { client, transport, timers: t, now } = setup();
  client.importXml(ATAK_SA);
  client.addMarker({ callsign: 'LOCAL', lat: 1, lon: 2, broadcast: false });
  assert.deepEqual(client.submissions(), []);
  client.connect();
  assert.equal(transport.sent.length, 0);
  const attempt = client.sendChat('private test body');
  assert.equal(attempt.sent, true);
  assert.equal(client.submissions().at(-1).state, 'pending');
  transport.handlers.onControl({
    op: 'submission',
    id: attempt.submissionId,
    state: 'queued',
    routes: [{ id: 'server', state: 'queued' }],
  });
  assert.equal(client.submissions().at(-1).state, 'queued');
  transport.handlers.onControl({
    op: 'submission',
    id: attempt.submissionId,
    state: 'submitted',
    routes: [{ id: 'server', state: 'submitted' }],
  });
  assert.equal(client.submissions().at(-1).state, 'submitted');
  assert.equal(
    JSON.stringify(client.submissions()).includes('private test body'),
    false,
  );
  const rejected = client.addMarker({ callsign: 'TRY', lat: 1, lon: 2 });
  transport.handlers.onControl({
    op: 'submission',
    id: rejected.submissionId,
    state: 'rejected',
    reason: 'No authorized TAK uplink configured',
    routes: [],
  });
  assert.equal(client.submissions().at(-1).state, 'rejected');
  client.disconnect();
  client.connect();
  assert.equal(transport.sent.length, 2, 'no replay from contacts/history');
  client.sendChat('expires');
  now.advance(30_001);
  t.fire(5000);
  assert.equal(client.submissions().at(-1).state, 'expired');
  client.sendChat('disconnect');
  client.disconnect();
  assert.equal(client.submissions().at(-1).state, 'rejected');
  client.clearPrivateState();
  assert.equal(transport.cancelled, 1);
  assert.deepEqual(client.submissions(), []);
  client.destroy();
  transport.handlers.onControl({
    op: 'submission',
    id: attempt.submissionId,
    state: 'queued',
    routes: [],
  });
  assert.deepEqual(client.submissions(), []);
  assert.equal(t.count(), 0);
});

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, get: (k) => data[k] ?? null, set: (k, v) => (data[k] = v) };
}

function setup({
  storage = memoryStorage(),
  now = clock(),
  canReportPosition = () => true,
} = {}) {
  const transport = fakeTransport();
  const t = timers();
  const client = createTakClient({
    createTransport: transport.factory,
    storage,
    now,
    canReportPosition,
    setInterval: t.setInterval,
    clearInterval: t.clearInterval,
  });
  return { client, transport, timers: t, storage, now };
}

// --- store -----------------------------------------------------------------

test('store upserts by uid, ignores older/duplicate reports and keeps a trail', () => {
  const store = createTakStore({ now: clock() });
  const at = (ms, lat) =>
    buildSelfSa(IDENTITY, { lat, lon: 0 }, { nowMs: T0 + ms });
  assert.equal(store.apply(at(0, 1)), 'contact');
  assert.equal(store.apply(at(0, 1)), 'ignored', 'same report');
  assert.equal(store.apply(at(-1000, 9)), 'ignored', 'older report');
  assert.equal(store.apply(at(1000, 2)), 'contact');
  assert.equal(store.apply(at(2000, 2)), 'contact', 'newer, same place');
  const contact = store.get(IDENTITY.uid);
  assert.equal(contact.point.lat, 2);
  assert.deepEqual(
    contact.trail.map((p) => p.lat),
    [1, 2],
  );
});

test('store applies deletes, alerts/cancels and chat; ignores pings and positionless events', () => {
  const store = createTakStore({ now: clock() });
  store.apply(parseCotEvent(WINTAK_HOSTILE));
  assert.equal(store.count(), 1);
  assert.equal(store.apply(parseCotEvent(ATAK_DELETE)), 'deleted');
  assert.equal(store.count(), 0);
  assert.equal(store.apply(parseCotEvent(ATAK_DELETE)), 'ignored');
  assert.equal(store.apply(parseCotEvent(ATAK_CHAT)), 'chat');
  assert.equal(
    store.apply(parseCotEvent(ATAK_CHAT)),
    'ignored',
    'chat deduped by messageId',
  );
  const [chat] = store.chats();
  assert.equal(chat.senderUid, 'ANDROID-0000synthetic01');
  assert.equal(chat.text, 'radio check');
  assert.equal(store.chats('Other room').length, 0);
});

test('store bounds contacts (never evicting self) and sweeps long-stale contacts', () => {
  const now = clock();
  const store = createTakStore({ limit: 2, staleRetainMs: 60_000, now });
  store.setSelfUid(IDENTITY.uid);
  store.apply(
    buildSelfSa(IDENTITY, { lat: 0, lon: 0 }, { nowMs: T0 }),
    'local',
  );
  store.apply(
    buildMarker(
      IDENTITY,
      { uid: 'm1', callsign: 'A', lat: 1, lon: 1 },
      { nowMs: T0 },
    ),
  );
  store.apply(
    buildMarker(
      IDENTITY,
      { uid: 'm2', callsign: 'B', lat: 1, lon: 1 },
      { nowMs: T0 },
    ),
  );
  assert.equal(store.count(), 2);
  assert.equal(store.get('m1'), null);
  assert.equal(store.get(IDENTITY.uid).origin, 'self');
  // Peer SA stale at T0+1 min; retained 1 more minute, then swept. Self is never swept.
  store.apply(
    parseCotEvent(
      ATAK_SA.replace('2026-10-13T19:06:00.123Z', '2026-10-13T19:01:00.000Z'),
    ),
  );
  now.advance(60_000 + 1);
  assert.equal(store.isStale(store.get('ANDROID-0000synthetic01')), true);
  assert.equal(store.sweep(), 0);
  now.advance(60_000);
  assert.equal(store.sweep(), 1);
  assert.notEqual(store.get(IDENTITY.uid), null);
});

test('store list puts emergencies and self first; applyAll notifies once', () => {
  const store = createTakStore({ now: clock() });
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.setSelfUid('me');
  const result = store.applyAll([
    buildMarker(
      IDENTITY,
      { uid: 'a', callsign: 'Alpha', lat: 0, lon: 0 },
      { nowMs: T0 },
    ),
    buildSelfSa(
      { ...IDENTITY, uid: 'me', callsign: 'Zulu' },
      { lat: 0, lon: 0 },
      { nowMs: T0 },
    ),
    parseCotEvent(ATAK_CHAT),
  ]);
  assert.deepEqual(result, {
    contact: 2,
    chat: 1,
    deleted: 0,
    cancelled: 0,
    ignored: 0,
  });
  assert.equal(notifications, 1);
  assert.deepEqual(
    store.list().map((c) => c.callsign),
    ['Zulu', 'Alpha'],
  );
});

// --- client ----------------------------------------------------------------

test('client mints a stable identity once and persists only identity fields', () => {
  const storage = memoryStorage();
  const { client } = setup({ storage });
  const id = client.identity();
  assert.match(id.uid, /^GEV-/);
  const saved = JSON.parse(storage.data[IDENTITY_STORAGE_KEY]);
  assert.deepEqual(Object.keys(saved).sort(), [
    'callsign',
    'role',
    'team',
    'uid',
  ]);
  const again = setup({ storage }).client;
  assert.equal(again.identity().uid, id.uid);
  const renamed = again.setIdentity({
    callsign: 'HAWK',
    team: 'Red',
    uid: 'hijack',
  });
  assert.equal(renamed.uid, id.uid, 'uid cannot be changed');
  assert.equal(JSON.parse(storage.data[IDENTITY_STORAGE_KEY]).callsign, 'HAWK');
});

test('client recovers from corrupt stored identity', () => {
  const { client } = setup({
    storage: memoryStorage({ [IDENTITY_STORAGE_KEY]: '{not json' }),
  });
  assert.match(client.identity().uid, /^GEV-/);
});

test('inbound XML is validated before reaching the store', () => {
  const { client, transport } = setup();
  transport.handlers.onXml(ATAK_SA);
  transport.handlers.onXml('<event uid="x"/>');
  transport.handlers.onXml('not xml');
  assert.equal(client.store.count(), 1);
  assert.deepEqual(client.counters(), {
    rx: 1,
    rxRejected: 2,
    tx: 0,
    txLocalOnly: 0,
  });
});

test('offline actions stay local and say so; connected actions are sent', () => {
  const { client, transport } = setup();
  const offline = client.addMarker({ callsign: 'OP', lat: 1, lon: 2 });
  assert.equal(offline.sent, false);
  assert.equal(client.store.get(offline.uid).origin, 'local');
  assert.equal(client.sendChat('anyone?').sent, false);
  client.connect('secret-token-123');
  assert.deepEqual(transport.connects, ['secret-token-123']);
  const online = client.addMarker({ callsign: 'OP2', lat: 1, lon: 2 });
  assert.equal(online.sent, true);
  assert.equal(parseCotEvent(transport.sent.at(-1)).detail.callsign, 'OP2');
  const unshared = client.addMarker({
    callsign: 'PRIVATE',
    lat: 1,
    lon: 2,
    broadcast: false,
  });
  assert.equal(unshared.sent, false);
  assert.equal(transport.sent.length, 1);
});

test('removing an own shared marker sends a delete; foreign contacts are removed locally only', () => {
  const { client, transport } = setup();
  client.connect();
  const { uid } = client.addMarker({ callsign: 'OP', lat: 1, lon: 2 });
  const removed = client.removeContact(uid);
  assert.equal(removed.removed, true);
  assert.equal(removed.sent, true);
  assert.equal(typeof removed.submissionId, 'string');
  const del = parseCotEvent(transport.sent.at(-1));
  assert.equal(del.type, 't-x-d-d');
  assert.equal(del.detail.links[0].uid, uid);
  transport.handlers.onXml(WINTAK_HOSTILE);
  const before = transport.sent.length;
  assert.deepEqual(
    client.removeContact('0b0b0b0b-1111-4222-8333-444444444444'),
    { removed: true, sent: false },
  );
  assert.equal(transport.sent.length, before);
});

test('self SA: armed without a fix sends nothing; beacons on fix, timer and connect', () => {
  const { client, transport, timers: t } = setup();
  client.setSaEnabled(true);
  assert.equal(transport.sent.length, 0);
  client.setFix({ lat: 34.1, lon: -89.2, source: 'GPS' });
  assert.equal(client.store.get(client.identity().uid).origin, 'self');
  assert.equal(transport.sent.length, 0, 'not connected yet');
  client.connect();
  assert.equal(transport.sent.length, 1, 'beacon on connect');
  t.fire(SA_INTERVAL_MS);
  assert.equal(transport.sent.length, 2);
  const sa = parseCotEvent(transport.sent.at(-1));
  assert.equal(sa.uid, client.identity().uid);
  assert.equal(sa.how, 'm-g');
  client.setSaEnabled(false);
  t.fire(SA_INTERVAL_MS);
  assert.equal(transport.sent.length, 2);
  assert.equal(
    client.removeContact(client.identity().uid).removed,
    false,
    'self cannot be removed',
  );
});

test('emergency requires a fix, raises and cancels', () => {
  const { client, transport } = setup();
  client.connect();
  assert.throws(() => client.setEmergency(true), /position/);
  client.setFix({ lat: 1, lon: 1 });
  assert.equal(client.setEmergency(true).sent, true);
  assert.equal(client.emergencyActive(), true);
  const alertUid = `${client.identity().uid}-9-1-1`;
  assert.equal(client.store.get(alertUid).emergency, true);
  client.setEmergency(false);
  assert.equal(parseCotEvent(transport.sent.at(-1)).type, 'b-a-o-can');
  assert.equal(client.store.get(alertUid), null);
  assert.equal(client.emergencyActive(), false);
});

test('import applies a document locally and is never broadcast', () => {
  const { client, transport } = setup();
  client.connect();
  const summary = client.importXml(
    `<events>${WINTAK_HOSTILE}${ATAK_CHAT}<event uid="bad"/></events>`,
  );
  assert.deepEqual(summary, {
    contact: 1,
    chat: 1,
    deleted: 0,
    cancelled: 0,
    ignored: 0,
    rejected: 1,
  });
  assert.equal(transport.sent.length, 0);
  assert.equal(client.store.list()[0].origin, 'import');
});

test('gateway control frames update link state; destroy stops timers', () => {
  const { client, transport, timers: t } = setup();
  transport.handlers.onControl({
    op: 'hello',
    status: { enabled: true, browsers: 1 },
  });
  assert.deepEqual(client.link().gateway, { enabled: true, browsers: 1 });
  transport.handlers.onControl({ op: 'reject', reason: 'rate-limited' });
  assert.equal(client.link().lastReject.reason, 'rate-limited');
  client.setSaEnabled(true);
  assert.equal(t.count(), 2);
  client.destroy();
  assert.equal(t.count(), 0);
  assert.equal(transport.open, false);
});

test('a network event cannot overwrite self with an older report', () => {
  const { client, transport, now } = setup();
  client.setSaEnabled(true);
  client.setFix({ lat: 5, lon: 5 });
  const forged = buildSelfSa(
    client.identity(),
    { lat: 9, lon: 9 },
    { nowMs: now() - 60_000 },
  );
  transport.handlers.onXml(serializeCotEvent(forged));
  assert.equal(client.store.get(client.identity().uid).point.lat, 5);
});

test('destroyed clients reject retained inbound callbacks and cannot restart SA timers', () => {
  const { client, transport, timers: t } = setup();
  client.setFix({ lat: 5, lon: 6 });
  client.setSaEnabled(true);
  client.destroy();
  const counters = client.counters();
  transport.handlers.onXml(ATAK_SA);
  transport.handlers.onControl({ op: 'hello', status: { secret: 'retired' } });
  transport.handlers.onState('open');
  client.setSaEnabled(true);
  client.setFix({ lat: 7, lon: 8 });
  assert.equal(client.store.apply(parseCotEvent(ATAK_SA)), 'ignored');
  assert.equal(client.store.count(), 0);
  assert.deepEqual(client.counters(), counters);
  assert.equal(client.link().state, 'closed');
  assert.equal(client.link().gateway, null);
  assert.equal(client.fix(), null);
  assert.equal(client.saEnabled(), false);
  assert.equal(t.count(), 0);
});

test('chat receipts never suppress bodies and dedup is scoped by sender and room', () => {
  const store = createTakStore({ chatLimit: 2 });
  assert.equal(
    store.apply(
      parseCotEvent(ATAK_CHAT.replace('type="b-t-f"', 'type="b-t-f-d"')),
    ),
    'ignored',
  );
  assert.equal(store.apply(parseCotEvent(ATAK_CHAT)), 'chat');
  const other = ATAK_CHAT.replaceAll(
    'ANDROID-0000synthetic01',
    'ANDROID-OTHER',
  );
  assert.equal(store.apply(parseCotEvent(other)), 'chat');
  assert.equal(store.apply(parseCotEvent(other)), 'ignored');
  const otherRoom = other.replaceAll('All Chat Rooms', 'Test Room');
  assert.equal(store.apply(parseCotEvent(otherRoom)), 'chat');
  assert.equal(store.chats().length, 2);
  assert.equal(
    store.apply(parseCotEvent(ATAK_CHAT)),
    'chat',
    'evicted dedup entries are removed with their messages',
  );
});

test('device fixes retain normalized immutable coordinates and invalid fixes change nothing', () => {
  const { client } = setup();
  client.setFix({ lat: '0', lon: '-89.5', hae: '120', source: 'GPS' });
  assert.equal(client.fix().lat, 0);
  assert.equal(client.fix().lon, -89.5);
  assert.equal(client.fix().hae, 120);
  assert.equal(Object.isFrozen(client.fix()), true);
  const prior = client.fix();
  assert.throws(() => client.setFix({ lat: '', lon: 0 }), /Latitude/);
  assert.equal(client.fix(), prior);
  client.destroy();
});

test('stale or background GPS never becomes a freshly dated position beacon or emergency', () => {
  let foreground = true;
  const {
    client,
    transport,
    timers: t,
    now,
  } = setup({ canReportPosition: () => foreground });
  client.connect();
  client.setSaEnabled(true);
  client.setFix({
    lat: 1,
    lon: 2,
    source: 'GPS',
    observedAtMs: now() - GPS_FIX_MAX_AGE_MS - 1,
  });
  assert.equal(transport.sent.length, 0);
  client.setFix({ lat: 1, lon: 2, source: 'GPS', observedAtMs: now() });
  assert.equal(transport.sent.length, 1);
  const measuredReport = client.store.get(client.identity().uid).event.timeMs;
  now.advance(GPS_FIX_MAX_AGE_MS + 1);
  t.fire(SA_INTERVAL_MS);
  assert.equal(transport.sent.length, 1);
  assert.equal(
    client.store.get(client.identity().uid).event.timeMs,
    measuredReport,
  );
  assert.throws(() => client.setEmergency(true), /fresh foreground GPS/);
  assert.equal(client.emergencyActive(), false);
  foreground = false;
  client.setFix({ lat: 3, lon: 4, source: 'GPS', observedAtMs: now() });
  t.fire(SA_INTERVAL_MS);
  assert.equal(transport.sent.length, 1);
  foreground = true;
  t.fire(SA_INTERVAL_MS);
  assert.equal(transport.sent.length, 2);
  client.setFix({ lat: 3, lon: 4, source: 'USER' });
  now.advance(GPS_FIX_MAX_AGE_MS + 1);
  t.fire(SA_INTERVAL_MS);
  assert.equal(
    transport.sent.length,
    4,
    'operator-set static position stays explicitly USER',
  );
  client.destroy();
});

test('operator session expiry clears tactical memory, positions and armed broadcasts', () => {
  const { client, transport, timers: t } = setup();
  client.connect({ session: true });
  client.addMarker({ callsign: 'PRIVATE', lat: 1, lon: 2 });
  client.sendChat('SYNTHETIC PRIVATE CHAT');
  client.setFix({ lat: 3, lon: 4, source: 'GPS' });
  client.setSaEnabled(true);
  transport.handlers.onControl({ op: 'session-expired' });
  assert.equal(client.store.count(), 0);
  assert.equal(client.store.chats().length, 0);
  assert.equal(client.fix(), null);
  assert.equal(client.saEnabled(), false);
  assert.equal(client.link().sessionExpired, true);
  assert.equal(
    t.count(),
    1,
    'only the contact sweep timer remains until page teardown',
  );
  client.destroy();
});
