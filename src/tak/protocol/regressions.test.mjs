import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCotEvent, parseCotTime, serializeCotEvent } from './cot.js';
import { buildMarker, buildSelfSa, normalizeIdentity } from './builders.js';
import { createCotStreamFramer } from './stream.js';
import { createCotRouter, createDedupCache } from './router.js';
import { parseXmlDocument, serializeXmlElement } from './xml.js';
import { createTakStore } from '../store.js';
import { ATAK_SA, IDENTITY, T0 } from './fixtures.mjs';

test('parser and builders reject coercible blanks, booleans, containers and nondecimal coordinates', () => {
  for (const value of [
    '',
    ' ',
    '\t',
    null,
    undefined,
    true,
    false,
    [],
    {},
    '0x10',
    'Infinity',
    'NaN',
  ]) {
    assert.throws(
      () =>
        buildMarker(IDENTITY, { callsign: 'SYNTHETIC', lat: value, lon: 0 }),
      /Latitude/,
    );
    assert.throws(
      () => buildSelfSa(IDENTITY, { lat: 0, lon: value }),
      /Longitude/,
    );
  }
  for (const value of ['', ' ', '&#9;', 'NaN', '0x10']) {
    assert.throws(
      () => parseCotEvent(ATAK_SA.replace('lat="34.3665"', `lat="${value}"`)),
      /point/,
    );
  }
  assert.equal(
    buildMarker(IDENTITY, { callsign: 'ORIGIN', lat: 0, lon: '0' }).point.lon,
    0,
  );
});

test('identities are rejected rather than truncated into collisions', () => {
  const prefix = 'x'.repeat(256);
  for (const suffix of ['a', 'b']) {
    assert.throws(
      () => normalizeIdentity({ ...IDENTITY, uid: prefix + suffix }),
      /exceeds/,
    );
    assert.throws(
      () =>
        parseCotEvent(
          ATAK_SA.replace('ANDROID-0000synthetic01', prefix + suffix),
        ),
      /uid/,
    );
  }
  assert.notEqual(
    normalizeIdentity({ ...IDENTITY, uid: prefix.slice(1) + 'a' }).uid,
    normalizeIdentity({ ...IDENTITY, uid: prefix.slice(1) + 'b' }).uid,
  );
});

test('invalid calendar dates and inconsistent event times are rejected', () => {
  for (const value of [
    '2026-02-30T19:00:00Z',
    '2026-13-01T19:00:00Z',
    '2026-01-01T24:00:00Z',
  ])
    assert.equal(parseCotTime(value), null);
  assert.throws(
    () =>
      parseCotEvent(
        ATAK_SA.replace('2026-10-13T19:06:00.123Z', '2026-10-13T18:06:00.123Z'),
      ),
    /time ordering/,
  );
});

test('height unknown sentinel is exact and does not erase valid high space altitudes', () => {
  const space = buildSelfSa(
    { ...IDENTITY, type: 'a-f-P' },
    { lat: 0, lon: 0, hae: 35_786_000 },
    { nowMs: T0 },
  );
  assert.equal(parseCotEvent(serializeCotEvent(space)).point.hae, 35_786_000);
  assert.equal(parseCotEvent(ATAK_SA).point.hae, null);
});

test('relay preserves namespace scope, known-field extension attributes and mixed extension content', () => {
  const xml = ATAK_SA.replace(
    '<event ',
    '<event xmlns:x="urn:synthetic:sensor" ',
  )
    .replace('callsign="VIPER"', 'callsign="VIPER" x:custom="keep"')
    .replace('</detail>', '<x:sensor>before<x:part/>after</x:sensor></detail>');
  const relayed = serializeCotEvent(parseCotEvent(xml));
  assert.match(relayed, /xmlns:x="urn:synthetic:sensor"/);
  assert.match(relayed, /x:custom="keep"/);
  assert.match(relayed, /<x:sensor>before<x:part\/>after<\/x:sensor>/);
  assert.equal(parseCotEvent(relayed).detail.callsign, 'VIPER');
  const inherited = `<events xmlns:x="urn:synthetic:sensor">${xml.replace(' xmlns:x="urn:synthetic:sensor"', '')}</events>`;
  assert.match(serializeCotEvent(parseCotEvent(inherited)), /xmlns:x=/);
  assert.throws(() => parseXmlDocument('<x:missing/>'), /namespace/);
  assert.throws(() => parseXmlDocument('<a>\u0000</a>'), /character/);
  assert.equal(
    serializeXmlElement(parseXmlDocument('<a>before<b/>after</a>')),
    '<a>before<b/>after</a>',
  );
});

test('stream framing ignores event-like text in CDATA, comments and instructions across every split', () => {
  const xml =
    '<event uid="synthetic"><detail><remarks><![CDATA[</event><event uid="text"/>]]></remarks><!-- </event> --><?test value="</event>"?></detail></event>';
  for (const chunkSize of [1, 2, 7, xml.length]) {
    const received = [];
    const framer = createCotStreamFramer({
      onEvent: (frame) => received.push(frame),
    });
    for (let i = 0; i < xml.length; i += chunkSize)
      framer.push(xml.slice(i, i + chunkSize));
    assert.deepEqual(received, [xml]);
  }
});

test('same-timestamp corrections propagate and preserve airborne trail altitude', () => {
  const router = createCotRouter({ now: () => T0 });
  let delivered = 0;
  router.addLink({
    id: 'receiver',
    kind: 'test',
    send() {
      delivered++;
    },
  });
  const store = createTakStore({ now: () => T0 });
  router.subscribe((event) => store.apply(event));
  const first = buildSelfSa(
    IDENTITY,
    { lat: 1, lon: 2, hae: 3000 },
    { nowMs: T0 },
  );
  const corrected = buildSelfSa(
    IDENTITY,
    { lat: 1, lon: 2, hae: 3200 },
    { nowMs: T0 },
  );
  assert.equal(router.publish(first).ok, true);
  assert.equal(router.publish(corrected).ok, true);
  assert.equal(router.publish(corrected).reason, 'duplicate');
  assert.equal(delivered, 2);
  assert.deepEqual(
    store.get(IDENTITY.uid).trail.map((p) => p.hae),
    [3000, 3200],
  );
  assert.equal(store.apply(corrected), 'ignored');
  router.destroy();
  store.destroy();
});

test('ambiguous duplicate core fields are refused and prefixed plugin names stay extensions', () => {
  assert.throws(
    () =>
      parseCotEvent(
        ATAK_SA.replace('<detail>', '<point lat="0" lon="0"/><detail>'),
      ),
    /Duplicate/,
  );
  assert.throws(
    () =>
      parseCotEvent(
        ATAK_SA.replace('</detail>', '<contact callsign="IMPOSTOR"/></detail>'),
      ),
    /Duplicate/,
  );
  const plugin = parseCotEvent(
    ATAK_SA.replace('<detail>', '<detail xmlns:x="urn:synthetic">').replace(
      '</detail>',
      '<x:contact callsign="EXTENSION"/></detail>',
    ),
  );
  assert.equal(plugin.detail.callsign, 'VIPER');
  assert.equal(plugin.detail.extras[0].name, 'x:contact');
  assert.throws(() => parseXmlDocument('<a x="1"y="2"/>'), /separated/);
});

test('dedup memory is bounded by bytes in addition to report count', () => {
  const cache = createDedupCache({
    maxBytes: 80,
    capacity: 100,
    now: () => T0,
  });
  for (let i = 0; i < 100; i++) cache.check(`${i}${'x'.repeat(20)}`);
  assert.ok(cache.bytes() <= 80);
  assert.ok(cache.size() < 3);
  cache.clear();
  assert.equal(cache.bytes(), 0);
});

test('router contains local serialization failures and rejects oversized normalized output', () => {
  const router = createCotRouter();
  assert.equal(router.publish({}).ok, false);
  const expanded = ATAK_SA.replace(
    '</detail>',
    `<extension>${'>'.repeat(16_384)}</extension></detail>`,
  );
  assert.ok(new TextEncoder().encode(expanded).length < 64 * 1024);
  assert.equal(router.receiveXml(expanded).ok, false);
  router.destroy();
});

test('stream never injects event-like preamble comments or DTD contents', () => {
  const events = [];
  const framer = createCotStreamFramer({ onEvent: (xml) => events.push(xml) });
  const decoy = '<event uid="decoy"/>';
  const real = '<event uid="real"/>';
  framer.push(`<!--${decoy}--><?test value="${decoy}"?>${real}`);
  assert.deepEqual(events, [real]);
  framer.push(`<!DOCTYPE x [<!ENTITY example "${decoy}">]>${decoy}`);
  assert.deepEqual(events, [real]);
  framer.reset();
  framer.push(real);
  assert.deepEqual(events, [real, real]);
});

test('namespace inheritance is shared and excessive in-scope bindings are rejected', () => {
  const declarations = Array.from(
    { length: 40 },
    (_, i) => `xmlns:p${i}="urn:${i}"`,
  ).join(' ');
  const inherited = parseXmlDocument(`<a ${declarations}><b/><c/></a>`);
  assert.equal(inherited.children[0].namespaces, inherited.namespaces);
  assert.equal(inherited.children[1].namespaces, inherited.namespaces);
  const more = Array.from(
    { length: 25 },
    (_, i) => `xmlns:q${i}="urn:${i}"`,
  ).join(' ');
  assert.throws(
    () => parseXmlDocument(`<a ${declarations}><b ${more}/></a>`),
    /namespace bindings/,
  );
});
