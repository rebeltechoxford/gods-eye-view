import test from 'node:test';
import assert from 'node:assert/strict';
import { createCotStreamFramer, isTakProtobuf } from './stream.js';
import { ATAK_CHAT, ATAK_SA, WINTAK_HOSTILE } from './fixtures.mjs';

function collect(options = {}) {
  const events = [];
  const discards = [];
  const framer = createCotStreamFramer({
    onEvent: (xml) => events.push(xml),
    onDiscard: (reason, count) => discards.push([reason, count]),
    ...options,
  });
  return { framer, events, discards };
}

const strip = (xml) => xml.replace(/^<\?xml[^>]*\?>/, '');

test('frames concatenated events with declarations between them', () => {
  const { framer, events } = collect();
  framer.push(ATAK_SA + '\n' + WINTAK_HOSTILE + ATAK_CHAT);
  assert.deepEqual(events, [strip(ATAK_SA), WINTAK_HOSTILE, ATAK_CHAT]);
  assert.equal(framer.stats().buffered, 0);
});

test('frames correctly whatever the chunk boundaries (byte-at-a-time)', () => {
  const stream =
    ATAK_SA + WINTAK_HOSTILE + '<events>' + ATAK_CHAT + '</events>';
  for (const size of [1, 2, 3, 7, 64, 1000]) {
    const { framer, events } = collect();
    for (let i = 0; i < stream.length; i += size)
      framer.push(stream.slice(i, i + size));
    assert.deepEqual(
      events,
      [strip(ATAK_SA), WINTAK_HOSTILE, ATAK_CHAT],
      `chunk ${size}`,
    );
  }
});

test('"<events>" wrappers are not mistaken for events', () => {
  const { framer, events } = collect();
  framer.push('<events><event uid="a"/></events>');
  assert.deepEqual(events, ['<event uid="a"/>']);
});

test('quoted ">" inside start-tag attributes does not end the tag', () => {
  const { framer, events } = collect();
  framer.push('<event uid="a>b" note=\'x/>\'><point/></event>');
  assert.deepEqual(events, ['<event uid="a>b" note=\'x/>\'><point/></event>']);
});

test('resynchronises after a truncated event', () => {
  const { framer, events, discards } = collect();
  framer.push('<event uid="cut"><point lat="1"' + WINTAK_HOSTILE);
  assert.deepEqual(events, [WINTAK_HOSTILE]);
  assert.deepEqual(discards, [['truncated event', 1]]);
});

test('discards oversized events and recovers', () => {
  const { framer, events, discards } = collect({ maxEventBytes: 200 });
  framer.push(
    `<event uid="big"><detail>${'x'.repeat(500)}</detail></event><event uid="ok"/>`,
  );
  assert.deepEqual(events, ['<event uid="ok"/>']);
  assert.equal(discards[0][0], 'oversized event');
  const { framer: open, discards: openDiscards } = collect({
    maxEventBytes: 100,
  });
  open.push(`<event uid="never-closes">${'y'.repeat(300)}`);
  assert.equal(openDiscards.length, 1);
  assert.ok(open.stats().buffered < 100);
});

test('drops inter-event noise without growing the buffer; reset clears partials', () => {
  const { framer, events } = collect();
  framer.push('garbage garbage <ev');
  assert.equal(framer.stats().buffered, 3);
  framer.push('ent uid="x"/>');
  assert.deepEqual(events, ['<event uid="x"/>']);
  framer.push('<event uid="partial">');
  framer.reset();
  framer.push('</event>');
  assert.equal(events.length, 1);
});

test('TAK protocol v1 magic byte is detected', () => {
  assert.equal(isTakProtobuf(Uint8Array.of(0xbf, 0x01, 0xbf)), true);
  assert.equal(isTakProtobuf(new TextEncoder().encode('<event')), false);
  assert.equal(isTakProtobuf(null), false);
});
