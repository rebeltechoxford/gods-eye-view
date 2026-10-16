import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTakStore,
  DEFAULT_CONTACT_BYTES_LIMIT,
  DEFAULT_XML_NODE_LIMIT,
} from './store.js';
import {
  parseCotEvent,
  serializeCotEvent,
  byteLength,
} from './protocol/cot.js';
import {
  buildMarker,
  buildChat,
  buildDelete,
  buildEmergency,
} from './protocol/builders.js';
import { IDENTITY } from './protocol/fixtures.mjs';

function parsed(
  uid,
  children = '<n/><n/>',
  time = Date.now(),
  stale = time + 60000,
) {
  return parseCotEvent(
    `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="h-e" time="${new Date(time).toISOString()}" start="${new Date(time).toISOString()}" stale="${new Date(stale).toISOString()}"><point lat="34" lon="-89"/><detail><contact callsign="SYNTHETIC"/><sensor>${children}</sensor></detail></event>`,
  );
}

test('2000 normal contacts remain available and oldest nonself eviction still respects count', () => {
  const store = createTakStore();
  for (let i = 0; i < 2000; i++)
    store.apply(
      buildMarker(IDENTITY, {
        uid: `normal-${i}`,
        callsign: 'SYNTHETIC',
        lat: 34,
        lon: -89,
      }),
    );
  assert.equal(store.count(), 2000);
  assert.equal(store.resourceStats().evictedContacts, 0);
  store.apply(
    buildMarker(IDENTITY, {
      uid: 'normal-next',
      callsign: 'SYNTHETIC',
      lat: 34,
      lon: -89,
    }),
  );
  assert.equal(store.count(), 2000);
  assert.equal(store.get('normal-0'), null);
  assert.equal(store.resourceStats().evictedContacts, 1);
});

test('many valid extension-rich contacts respect retained XML node budget without stripping extensions', () => {
  const store = createTakStore();
  for (let i = 0; i < 40; i++)
    store.apply(parsed(`heavy-${i}`, '<n/>'.repeat(6000)));
  const resources = store.resourceStats();
  assert.ok(resources.xmlNodes <= DEFAULT_XML_NODE_LIMIT);
  assert.ok(resources.serializedBytes <= DEFAULT_CONTACT_BYTES_LIMIT);
  assert.ok(resources.evictedContacts > 0);
  assert.ok(store.count() < 40);
  assert.equal(store.get('heavy-0'), null);
  assert.ok(
    serializeCotEvent(store.get('heavy-39').event).includes('<sensor><n/>'),
  );
  assert.equal(
    store.get('heavy-39').event.detail.raw.children[1].children.length,
    6000,
  );
});

test('large text contacts are also bounded by serialized bytes', () => {
  const store = createTakStore();
  for (let i = 0; i < 2000; i++)
    store.apply(
      buildMarker(IDENTITY, {
        uid: `text-${i}`,
        callsign: 'SYNTHETIC',
        lat: 34,
        lon: -89,
        remarks: 'x'.repeat(4096),
      }),
    );
  assert.ok(
    store.resourceStats().serializedBytes <= DEFAULT_CONTACT_BYTES_LIMIT,
  );
  assert.ok(store.count() < 2000);
  assert.ok(store.resourceStats().evictedContacts > 0);
  assert.ok(store.get('text-1999'));
});

test('update, remove, stale sweep, clear and destroy release exact accounted resources', () => {
  let now = Date.now();
  const store = createTakStore({ now: () => now, staleRetainMs: 0 });
  const first = parsed('one', '<n/><n/>', now, now + 1000);
  store.apply(first);
  assert.equal(store.resourceStats().xmlNodes, 5);
  assert.equal(
    store.resourceStats().serializedBytes,
    byteLength(serializeCotEvent(first)),
  );
  const update = parsed('one', '<n/>', now + 1, now + 1000);
  store.apply(update);
  assert.equal(store.resourceStats().xmlNodes, 4);
  assert.equal(
    store.resourceStats().serializedBytes,
    byteLength(serializeCotEvent(update)),
  );
  store.apply(parsed('two', '<n/>', now, now + 1000));
  store.remove('one');
  assert.equal(store.resourceStats().xmlNodes, 4);
  now += 2000;
  assert.equal(store.sweep(), 1);
  assert.equal(store.resourceStats().xmlNodes, 0);
  assert.equal(store.resourceStats().serializedBytes, 0);
  store.apply(parsed('clear'));
  store.clear();
  assert.equal(store.resourceStats().serializedBytes, 0);
  store.apply(parsed('destroy'));
  store.destroy();
  assert.equal(store.resourceStats().xmlNodes, 0);
  assert.equal(store.count(), 0);
});

test('an overbudget update including self is refused before prior data is changed', () => {
  const first = parsed(IDENTITY.uid, '<n/>');
  const store = createTakStore({
    byteLimit: byteLength(serializeCotEvent(first)) + 10,
    xmlNodeLimit: 10,
  });
  store.setSelfUid(IDENTITY.uid);
  store.apply(first);
  const before = store.resourceStats();
  const prior = store.get(IDENTITY.uid);
  const tooLarge = parsed(IDENTITY.uid, 'x'.repeat(1000), first.timeMs + 1);
  assert.equal(store.apply(tooLarge), 'ignored');
  assert.equal(store.get(IDENTITY.uid), prior);
  assert.equal(store.resourceStats().serializedBytes, before.serializedBytes);
  assert.equal(store.resourceStats().rejectedContacts, 1);
  const nodes = createTakStore({ xmlNodeLimit: 4 });
  nodes.apply(first);
  const priorNodes = nodes.get(IDENTITY.uid);
  assert.equal(
    nodes.apply(parsed(IDENTITY.uid, '<n/><n/>', first.timeMs + 2)),
    'ignored',
  );
  assert.equal(nodes.get(IDENTITY.uid), priorNodes);
});

test('protected self cannot cause accepted contacts to exceed aggregate limits', () => {
  const self = parsed(IDENTITY.uid, '<n/>');
  const store = createTakStore({
    byteLimit: byteLength(serializeCotEvent(self)) + 10,
  });
  store.setSelfUid(IDENTITY.uid);
  store.apply(self);
  assert.equal(store.apply(parsed('other', '<n/>')), 'ignored');
  assert.equal(store.count(), 1);
  assert.ok(
    store.resourceStats().serializedBytes <= store.resourceStats().byteLimit,
  );
  assert.equal(store.resourceStats().rejectedContacts, 1);
});

test('delete/cancel accounting and bounded chat remain independent of XML contact limits', () => {
  const store = createTakStore({ xmlNodeLimit: 10, chatLimit: 2 });
  const marker = buildMarker(IDENTITY, {
    callsign: 'SYNTHETIC',
    lat: 34,
    lon: -89,
  });
  store.apply(marker);
  store.apply(buildDelete(IDENTITY, marker.uid));
  assert.equal(store.resourceStats().serializedBytes, 0);
  store.apply(buildEmergency(IDENTITY, { lat: 34, lon: -89 }));
  store.apply(
    buildEmergency(IDENTITY, { lat: 34, lon: -89 }, { cancel: true }),
  );
  assert.equal(store.resourceStats().serializedBytes, 0);
  for (let i = 0; i < 3; i++)
    store.apply(buildChat(IDENTITY, { message: `SYNTHETIC ${i}` }));
  assert.equal(store.chats().length, 2);
  assert.equal(store.resourceStats().serializedBytes, 0);
});

test('reordered deletes and emergency cancellations cannot remove newer contacts', () => {
  const store = createTakStore();
  const time = Date.now() - 1000;
  const marker = buildMarker(
    IDENTITY,
    {
      callsign: 'SYNTHETIC',
      lat: 34,
      lon: -89,
    },
    { nowMs: time + 100 },
  );
  const alert = buildEmergency(
    IDENTITY,
    { lat: 34, lon: -89 },
    { nowMs: time + 100 },
  );
  store.apply(marker);
  store.apply(alert);
  const before = store.resourceStats();
  assert.equal(
    store.apply(
      buildDelete(IDENTITY, marker.uid, marker.type, { nowMs: time }),
    ),
    'ignored',
  );
  assert.equal(
    store.apply(
      buildEmergency(
        IDENTITY,
        { lat: 34, lon: -89 },
        { cancel: true, nowMs: time },
      ),
    ),
    'ignored',
  );
  assert.equal(store.get(marker.uid).event, marker);
  assert.equal(store.get(alert.uid).event, alert);
  assert.deepEqual(store.resourceStats(), before);
  assert.equal(
    store.apply(
      buildDelete(IDENTITY, marker.uid, marker.type, { nowMs: time + 200 }),
    ),
    'deleted',
  );
  assert.equal(
    store.apply(
      buildEmergency(
        IDENTITY,
        { lat: 34, lon: -89 },
        { cancel: true, nowMs: time + 200 },
      ),
    ),
    'cancelled',
  );
  assert.equal(store.count(), 0);
  assert.equal(store.resourceStats().serializedBytes, 0);
  assert.equal(store.resourceStats().xmlNodes, 0);
});
