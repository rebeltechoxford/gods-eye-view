import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CotValidationError,
  MAX_COT_DOCUMENT_BYTES,
  MAX_COT_EVENTS,
  cotAffiliation,
  cotDeleteTarget,
  cotKind,
  describeCotType,
  isCotStale,
  parseCotDocument,
  parseCotEvent,
  parseCotTime,
  serializeCotEvent,
} from './cot.js';
import {
  ALL_CHAT_ROOMS,
  TAK_ROLES,
  TAK_TEAMS,
  buildChat,
  buildDelete,
  buildEmergency,
  buildMarker,
  buildPing,
  buildSelfSa,
  createIdentity,
  normalizeIdentity,
} from './builders.js';
import {
  ATAK_CHAT,
  ATAK_DELETE,
  ATAK_SA,
  AIR_TRACK,
  IDENTITY,
  T0,
  WINTAK_HOSTILE,
} from './fixtures.mjs';

const event = (uid, extra = '', point = '<point lat="1" lon="2"/>') =>
  `<event version="2.0" uid="${uid}" type="a-f-G" how="m-g" time="2026-10-13T19:00:00Z" start="2026-10-13T19:00:00Z" stale="2026-10-13T19:05:00Z"${extra}>${point}</event>`;

test('type taxonomy covers every 2525 affiliation and dimension', () => {
  assert.equal(cotAffiliation('a-f-G-U-C'), 'friendly');
  assert.equal(cotAffiliation('a-a-G'), 'friendly');
  assert.equal(cotAffiliation('a-h-G'), 'hostile');
  assert.equal(cotAffiliation('a-s-G'), 'hostile');
  assert.equal(cotAffiliation('a-j-A'), 'hostile');
  assert.equal(cotAffiliation('a-k-A'), 'hostile');
  assert.equal(cotAffiliation('a-n-S'), 'neutral');
  assert.equal(cotAffiliation('a-u-G'), 'unknown');
  assert.equal(cotAffiliation('a-p-G'), 'unknown');
  assert.equal(cotAffiliation('b-m-p-s-m'), 'marker');
  assert.deepEqual(
    { ...describeCotType('a-h-A-M-F-Q') },
    {
      type: 'a-h-A-M-F-Q',
      kind: 'sa',
      affiliation: 'hostile',
      affiliationDetail: 'hostile',
      dimension: 'air',
      functionId: 'M-F-Q',
    },
  );
  assert.equal(cotKind('b-t-f'), 'chat');
  assert.equal(cotKind('b-t-f-d'), 'chat');
  assert.equal(cotKind('b-a-o-tbl'), 'alert');
  assert.equal(cotKind('t-x-d-d'), 'delete');
  assert.equal(cotKind('t-x-c-t'), 'ping');
  assert.equal(cotKind('u-d-f'), 'drawing');
  assert.equal(cotKind('y-zzz'), 'other');
});

test('CoT time accepts ISO UTC with fractions/offsets and rejects free text', () => {
  assert.equal(parseCotTime('2026-10-13T19:00:00Z'), T0);
  assert.equal(parseCotTime('2026-10-13T19:00:00.000123456Z'), T0);
  assert.equal(parseCotTime('2026-10-13T21:00:00+02:00'), T0);
  assert.equal(parseCotTime('Oct 13 2026'), null);
  assert.equal(parseCotTime(''), null);
  assert.equal(parseCotTime('2026-10-13'), null);
});

test('parses a real-shaped ATAK SA with full detail and the 9999999 sentinel', () => {
  const sa = parseCotEvent(ATAK_SA);
  assert.equal(sa.uid, 'ANDROID-0000synthetic01');
  assert.equal(sa.type, 'a-f-G-U-C');
  assert.equal(sa.how, 'h-e');
  assert.equal(sa.timeMs, T0 + 123);
  assert.equal(sa.staleMs, T0 + 123 + 6 * 60_000);
  assert.deepEqual(
    { ...sa.point },
    { lat: 34.3665, lon: -89.5192, hae: null, ce: null, le: null },
  );
  assert.equal(sa.detail.callsign, 'VIPER');
  assert.equal(sa.detail.endpoint, '*:-1:stcp');
  assert.equal(sa.detail.droid, 'VIPER');
  assert.deepEqual(sa.detail.group, { name: 'Cyan', role: 'Team Lead' });
  assert.deepEqual(sa.detail.track, { course: 30.5, speed: 1.2 });
  assert.equal(sa.detail.status.battery, 88);
  assert.equal(sa.detail.takv.platform, 'ATAK-CIV');
  assert.equal(sa.detail.precision.geopointsrc, 'USER');
  assert.equal(Object.isFrozen(sa), true);
});

test('parses WinTAK hostile with links, remarks and preserves unknown detail', () => {
  const hostile = parseCotEvent(WINTAK_HOSTILE);
  assert.equal(hostile.point.hae, 120.5);
  assert.equal(hostile.point.ce, 15);
  assert.equal(hostile.point.le, null);
  assert.equal(hostile.detail.remarks.text, 'Two vehicles & dismounts');
  assert.equal(hostile.detail.links[0].parentCallsign, 'WINTAK-1');
  assert.deepEqual(
    hostile.detail.extras.map((e) => e.localName),
    ['archive', '__milsym'],
  );
});

test('parses GeoChat and delete tasking', () => {
  const chat = parseCotEvent(ATAK_CHAT);
  assert.equal(chat.detail.chat.chatroom, ALL_CHAT_ROOMS);
  assert.equal(chat.detail.chat.senderCallsign, 'VIPER');
  assert.deepEqual(chat.detail.chat.participants, [
    'ANDROID-0000synthetic01',
    ALL_CHAT_ROOMS,
  ]);
  assert.equal(chat.detail.remarks.text, 'radio check');
  const del = parseCotEvent(ATAK_DELETE);
  assert.equal(cotDeleteTarget(del), '0b0b0b0b-1111-4222-8333-444444444444');
  assert.equal(cotDeleteTarget(chat), null);
});

test('serialise -> parse round-trips every field, including preserved extras', () => {
  for (const xml of [
    ATAK_SA,
    WINTAK_HOSTILE,
    ATAK_CHAT,
    ATAK_DELETE,
    AIR_TRACK,
  ]) {
    const first = parseCotEvent(xml);
    const out = serializeCotEvent(first);
    assert.equal(out.startsWith('<event '), true);
    assert.equal(out.includes('<?xml'), false);
    const second = parseCotEvent(out);
    assert.deepEqual(stripExtras(second), stripExtras(first), xml.slice(0, 60));
    assert.deepEqual(
      second.detail.extras.map((e) => e.localName),
      first.detail.extras.map((e) => e.localName),
    );
  }
});

function stripExtras(e) {
  return { ...e, detail: { ...e.detail, extras: e.detail.extras.length } };
}

test('rejects events without uid, type, time, stale or a usable point', () => {
  const cases = [
    [event(''), /uid/],
    [event('x').replace('type="a-f-G"', 'type="a f"'), /type/],
    [event('x').replace(' time="2026-10-13T19:00:00Z"', ''), /time/],
    [event('x').replace(' stale="2026-10-13T19:05:00Z"', ''), /stale/],
    [event('x', '', '<point lat="91" lon="0"/>'), /point/],
    [event('x', '', '<point lat="0" lon="-181"/>'), /point/],
    [event('x', '', '<point lat="NaN" lon="0"/>'), /point/],
    [event('x', '', ''), /point/],
  ];
  for (const [xml, reason] of cases)
    assert.throws(() => parseCotEvent(xml), reason, xml);
});

test('keeps valid zero coordinates', () => {
  const e = parseCotEvent(
    event('zero', '', '<point lat="0" lon="0" hae="0"/>'),
  );
  assert.equal(e.point.lat, 0);
  assert.equal(e.point.lon, 0);
  assert.equal(e.point.hae, 0);
});

test('documents: wrappers, concatenations, per-event rejection and limits', () => {
  const doc = `<events>${event('a')}${event('')}${event('b')}</events>`;
  const { events, rejected } = parseCotDocument(doc);
  assert.deepEqual(
    events.map((e) => e.uid),
    ['a', 'b'],
  );
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /uid/);
  assert.equal(
    parseCotDocument(event('a') + '\n' + event('b')).events.length,
    2,
  );
  assert.throws(() => parseCotDocument('<x/>'), /No CoT events/);
  assert.throws(() => parseCotDocument('   '), CotValidationError);
  assert.throws(() => parseCotDocument('<event'), /Malformed/);
  assert.throws(
    () => parseCotDocument('x'.repeat(MAX_COT_DOCUMENT_BYTES + 1)),
    /1 MiB/,
  );
  const many = `<events>${Array.from({ length: MAX_COT_EVENTS + 1 }, (_, i) => event(`u${i}`)).join('')}</events>`;
  assert.throws(
    () => parseCotDocument(many, { maxBytes: 10 * 1024 * 1024 }),
    /too many/,
  );
  assert.throws(() => parseCotEvent(event('a') + event('b')), /too many/);
  const xxe =
    '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + event('x');
  assert.throws(() => parseCotDocument(xxe), /DTD/);
});

test('staleness compares the stale time with now', () => {
  const e = parseCotEvent(event('s'));
  assert.equal(isCotStale(e, Date.parse('2026-10-13T19:04:59Z')), false);
  assert.equal(isCotStale(e, Date.parse('2026-10-13T19:05:00Z')), true);
});

test('identity: normalises unknown team/role and refuses empty callsign', () => {
  const id = normalizeIdentity({
    uid: 'u',
    callsign: ' A ',
    team: 'Plaid',
    role: 'Boss',
  });
  assert.equal(id.callsign, 'A');
  assert.equal(id.team, 'Cyan');
  assert.equal(id.role, 'Team Member');
  assert.throws(
    () => normalizeIdentity({ uid: 'u', callsign: '  ' }),
    /Callsign/,
  );
  const fresh = createIdentity({ team: 'Red', role: 'Medic' });
  assert.match(fresh.uid, /^GEV-[0-9a-f-]{36}$/);
  assert.equal(TAK_TEAMS.length, 14);
  assert.equal(TAK_ROLES.includes('Medic'), true);
});

test('self SA builder emits ATAK-compatible PPLI', () => {
  const sa = buildSelfSa(
    IDENTITY,
    {
      lat: 1.5,
      lon: 2.5,
      hae: 10,
      course: 90,
      speed: 3,
      battery: 140,
      source: 'GPS',
    },
    { nowMs: T0 },
  );
  assert.equal(sa.uid, IDENTITY.uid);
  assert.equal(sa.type, 'a-f-G-U-C');
  assert.equal(sa.how, 'm-g');
  assert.equal(sa.staleMs - sa.timeMs, 120_000);
  const parsed = parseCotEvent(serializeCotEvent(sa));
  assert.equal(parsed.detail.callsign, 'GODSEYE');
  assert.deepEqual(parsed.detail.group, { name: 'Cyan', role: 'HQ' });
  assert.equal(parsed.detail.status.battery, 100);
  assert.deepEqual(parsed.detail.track, { course: 90, speed: 3 });
  assert.equal(parsed.detail.takv.platform, "God's Eye View TAK");
  assert.equal(parsed.detail.precision.geopointsrc, 'GPS');
  const manual = buildSelfSa(IDENTITY, { lat: 1, lon: 2 }, { nowMs: T0 });
  assert.equal(manual.how, 'h-e');
  assert.equal(manual.detail.precision.altsrc, '???');
  assert.throws(() => buildSelfSa(IDENTITY, { lat: 100, lon: 0 }), /Latitude/);
});

test('marker, chat, delete, ping and emergency builders round-trip', () => {
  const marker = buildMarker(
    IDENTITY,
    { callsign: 'OP-1', lat: '1.25', lon: '-2.5', remarks: 'watch <here>' },
    { nowMs: T0 },
  );
  const m = parseCotEvent(serializeCotEvent(marker));
  assert.equal(m.type, 'b-m-p-s-m');
  assert.equal(m.detail.callsign, 'OP-1');
  assert.equal(m.detail.links[0].uid, IDENTITY.uid);
  assert.equal(m.detail.links[0].relation, 'p-p');
  assert.equal(m.detail.remarks.text, 'watch <here>');
  assert.equal(m.detail.argb, -1);
  assert.throws(
    () => buildMarker(IDENTITY, { callsign: '', lat: 0, lon: 0 }),
    /label/,
  );

  const chat = buildChat(
    IDENTITY,
    { message: 'hello & bye' },
    { nowMs: T0, messageId: 'm-1' },
  );
  const c = parseCotEvent(serializeCotEvent(chat));
  assert.equal(c.uid, `GeoChat.${IDENTITY.uid}.${ALL_CHAT_ROOMS}.m-1`);
  assert.equal(c.detail.chat.senderCallsign, 'GODSEYE');
  assert.equal(c.detail.chat.messageId, 'm-1');
  assert.equal(c.detail.remarks.text, 'hello & bye');
  assert.equal(c.detail.remarks.source, `BAO.F.ATAK.${IDENTITY.uid}`);

  const del = parseCotEvent(
    serializeCotEvent(
      buildDelete(IDENTITY, marker.uid, marker.type, { nowMs: T0 }),
    ),
  );
  assert.equal(cotDeleteTarget(del), marker.uid);
  assert.deepEqual(
    del.detail.extras.map((e) => e.localName),
    ['__forcedelete'],
  );

  assert.equal(
    parseCotEvent(serializeCotEvent(buildPing(IDENTITY, { nowMs: T0 }))).type,
    't-x-c-t',
  );

  const alert = parseCotEvent(
    serializeCotEvent(
      buildEmergency(IDENTITY, { lat: 1, lon: 2 }, { nowMs: T0 }),
    ),
  );
  assert.equal(alert.type, 'b-a-o-tbl');
  assert.equal(alert.uid, `${IDENTITY.uid}-9-1-1`);
  assert.equal(alert.detail.emergency.type, '911 Alert');
  const cancel = parseCotEvent(
    serializeCotEvent(
      buildEmergency(IDENTITY, { lat: 1, lon: 2 }, { cancel: true, nowMs: T0 }),
    ),
  );
  assert.equal(cancel.type, 'b-a-o-can');
  assert.equal(cancel.detail.emergency.cancel, true);
});

test('hostile strings in detail fields cannot break out of the XML', () => {
  const marker = buildMarker(
    IDENTITY,
    {
      callsign: '"/><event uid="evil',
      lat: 0,
      lon: 0,
      remarks: ']]></remarks><x>',
    },
    { nowMs: T0 },
  );
  const xml = serializeCotEvent(marker);
  const { events } = parseCotDocument(xml);
  assert.equal(events.length, 1);
  assert.equal(events[0].detail.callsign, '"/><event uid="evil');
  assert.equal(events[0].detail.remarks.text, ']]></remarks><x>');
});
