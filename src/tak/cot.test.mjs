import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cotAffiliation,
  normalizeCotRecord,
  parseCotXml,
  MAX_COT_DOCUMENT_BYTES,
  MAX_COT_EVENTS,
} from './cot.js';
import { createCotStore } from './contactStore.js';

function node(localName, attrs = {}, children = []) {
  return {
    localName,
    children,
    getAttribute(name) {
      return attrs[name] ?? null;
    },
  };
}

function documentWithEvents(events, parserErrors = []) {
  return {
    getElementsByTagName(name) {
      return name === 'parsererror' ? parserErrors : name === '*' ? events : [];
    },
  };
}

function validEvent(overrides = {}) {
  return node(
    'event',
    {
      uid: 'test-1',
      type: 'a-f-G-U-C',
      time: '2026-10-13T15:00:00Z',
      stale: '2026-10-13T15:05:00Z',
      ...overrides,
    },
    [
      node('point', { lat: '34.3665', lon: '-89.5192', hae: '125' }),
      node('detail', {}, [node('contact', { callsign: 'ALPHA 1' })]),
    ],
  );
}

test('CoT affiliations distinguish contact categories', () => {
  assert.equal(cotAffiliation('a-f-G-U-C'), 'friendly');
  assert.equal(cotAffiliation('a-h-G-U-C'), 'hostile');
  assert.equal(cotAffiliation('a-n-G-U-C'), 'neutral');
  assert.equal(cotAffiliation('a-u-G-U-C'), 'unknown');
  assert.equal(cotAffiliation('b-m-p-s-p-i'), 'marker');
});

test('normalized CoT retains valid zero coordinates and timestamps', () => {
  const record = normalizeCotRecord(
    {
      uid: 'test',
      type: 'a-f-G-U-C',
      lat: 0,
      lon: 0,
      hae: 0,
      callsign: 'TEST',
      time: '2026-10-13T15:00:00Z',
      stale: '2026-10-13T15:05:00Z',
    },
    12,
  );
  assert.equal(record.lat, 0);
  assert.equal(record.lon, 0);
  assert.equal(record.altitudeM, 0);
  assert.equal(record.affiliation, 'friendly');
  assert.equal(record.eventTimeMs, Date.parse('2026-10-13T15:00:00Z'));
  assert.equal(record.receivedAtMs, 12);
});

test('rejects contacts without coordinates, uid or within invalid ranges', () => {
  assert.equal(normalizeCotRecord({ uid: 'x', lat: 91, lon: 0 }), null);
  assert.equal(normalizeCotRecord({ uid: 'x', lat: 0, lon: 181 }), null);
  assert.equal(normalizeCotRecord({ uid: 'x', lat: null, lon: 0 }), null);
  assert.equal(normalizeCotRecord({ uid: 'x', lat: 0, lon: '' }), null);
  assert.equal(normalizeCotRecord({ uid: '', lat: 0, lon: 0 }), null);
  assert.equal(normalizeCotRecord(null), null);
});

test('parses individual CoT event with caller provided XML parser', () => {
  const result = parseCotXml('<event/>', {
    parseXml: () => documentWithEvents([validEvent()]),
  });
  assert.equal(result.rejected, 0);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].uid, 'test-1');
  assert.equal(result.contacts[0].callsign, 'ALPHA 1');
  assert.equal(result.contacts[0].lat, 34.3665);
  assert.equal(result.contacts[0].lon, -89.5192);
});

test('rejects XML entity declarations and oversize input before parsing', () => {
  const unsafe =
    '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
    '<event uid="x"><point lat="0" lon="0"/></event>';
  assert.throws(() => parseCotXml(unsafe), /DTD or entity/);
  assert.throws(
    () => parseCotXml('x'.repeat(MAX_COT_DOCUMENT_BYTES + 1)),
    /1 MiB/,
  );
});

test('rejects parser errors, too many events and invalid-only imports', () => {
  assert.throws(
    () =>
      parseCotXml('<event/>', {
        parseXml: () => documentWithEvents([], [{}]),
      }),
    /Malformed/,
  );
  assert.throws(
    () =>
      parseCotXml('<events/>', {
        parseXml: () => documentWithEvents([]),
      }),
    /No CoT events/,
  );
  const tooMany = Array.from({ length: MAX_COT_EVENTS + 1 }, () =>
    validEvent(),
  );
  assert.throws(
    () =>
      parseCotXml('<events/>', {
        parseXml: () => documentWithEvents(tooMany),
      }),
    /too many/,
  );
  const invalid = validEvent({ uid: '' });
  assert.throws(
    () =>
      parseCotXml('<event/>', {
        parseXml: () => documentWithEvents([invalid]),
      }),
    /valid positions/,
  );
});

test('contact store upserts by uid, ignores older packets and bounds state', () => {
  const store = createCotStore({ limit: 2 });
  let changes = 0;
  store.subscribe(() => changes++);
  const first = normalizeCotRecord({
    uid: 'alpha',
    lat: 1,
    lon: 2,
    time: '2026-10-13T15:00:00Z',
  });
  const old = normalizeCotRecord({
    uid: 'alpha',
    lat: 3,
    lon: 4,
    time: '2026-10-13T14:00:00Z',
  });
  const newer = normalizeCotRecord({
    uid: 'alpha',
    lat: 5,
    lon: 6,
    time: '2026-10-13T16:00:00Z',
  });
  assert.deepEqual(store.ingest([first]), { accepted: 1, ignored: 0 });
  assert.deepEqual(store.ingest([old]), { accepted: 0, ignored: 1 });
  assert.equal(store.get('alpha').lat, 1);
  store.ingest([newer]);
  assert.equal(store.get('alpha').lat, 5);
  store.ingest([normalizeCotRecord({ uid: 'beta', lat: 1, lon: 1 })]);
  store.ingest([normalizeCotRecord({ uid: 'gamma', lat: 1, lon: 1 })]);
  assert.equal(store.count(), 2);
  assert.equal(store.get('alpha'), null);
  assert.equal(changes, 4);
  store.clear();
  assert.equal(store.count(), 0);
  store.destroy();
});

test('staleness is based on the CoT stale timestamp', () => {
  const store = createCotStore({
    now: () => Date.parse('2026-10-13T15:10:00Z'),
  });
  const stale = normalizeCotRecord({
    uid: 'stale',
    lat: 1,
    lon: 2,
    stale: '2026-10-13T15:00:00Z',
  });
  const fresh = normalizeCotRecord({
    uid: 'fresh',
    lat: 1,
    lon: 2,
    stale: '2026-10-13T15:30:00Z',
  });
  assert.equal(store.isStale(stale), true);
  assert.equal(store.isStale(fresh), false);
});
