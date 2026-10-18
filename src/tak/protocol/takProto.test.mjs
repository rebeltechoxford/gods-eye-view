import test from 'node:test';
import assert from 'node:assert/strict';
import { CotValidationError, parseCotEvent, serializeCotEvent } from './cot.js';
import {
  buildChat,
  buildDelete,
  buildEmergency,
  buildMarker,
  buildPing,
  buildSelfSa,
} from './builders.js';
import {
  AIR_TRACK,
  ATAK_CHAT,
  ATAK_DELETE,
  ATAK_SA,
  IDENTITY,
  T0,
  WINTAK_HOSTILE,
} from './fixtures.mjs';
import {
  MAX_TAK_PROTO_PAYLOAD_BYTES,
  TakProtoError,
  buildTakProtocolRequest,
  cotEventToTakMessage,
  cotEventToTakPayload,
  createTakStreamFramer,
  createTakStreamReader,
  decodeTakMessage,
  encodeTakMeshDatagram,
  encodeTakMessage,
  encodeTakStreamFrame,
  mayBeTakProtocolControl,
  readTakMeshDatagram,
  readTakProtocolControl,
  takEventToCotXml,
  takPayloadToCot,
} from './takProto.js';
import { TAK_PROTO_ORACLE } from './takProtoOracle.mjs';
import { parseXmlDocument, serializeXmlElement } from './xml.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const bytes = (text) => Uint8Array.from(Buffer.from(text, 'hex'));

/** Order-insensitive XML view: CoT attribute and detail order carry no meaning. */
function canonical(xml) {
  const sort = (element) => ({
    name: element.name,
    attrs: Object.fromEntries(Object.entries(element.attrs).sort()),
    text: element.children.length ? '' : element.text,
    children: element.children
      .map(sort)
      .sort((a, b) =>
        serializeXmlElement(a).localeCompare(serializeXmlElement(b)),
      ),
  });
  return serializeXmlElement(sort(parseXmlDocument(xml)));
}

function roundTrip(event) {
  const payload = cotEventToTakPayload(event);
  const { xml } = takPayloadToCot(payload);
  return { payload, back: parseCotEvent(xml) };
}

function cotEventMessage(fields, detail = null) {
  return {
    takControl: null,
    cotEvent: {
      type: 'a-f-G',
      uid: 'SYNTH-1',
      sendTime: T0,
      staleTime: T0 + 60_000,
      lat: 1,
      lon: 2,
      detail,
      ...fields,
    },
  };
}

// --- Independent oracle (Google protobuf + published TAK descriptors) ------

for (const [name, oracle] of Object.entries(TAK_PROTO_ORACLE)) {
  test(`decodes the oracle ${name} payload field for field`, () => {
    assert.deepEqual(decodeTakMessage(bytes(oracle.payload)), oracle.values);
  });

  test(`encodes ${name} byte-identically to the oracle`, () => {
    assert.equal(hex(encodeTakMessage(oracle.values)), oracle.payload);
  });

  test(`mesh and stream framing of ${name} match the oracle`, () => {
    const mesh = readTakMeshDatagram(bytes(oracle.mesh));
    assert.equal(mesh.version, 1);
    assert.equal(hex(mesh.payload), oracle.payload);
    assert.equal(
      hex(encodeTakMeshDatagram(bytes(oracle.payload))),
      oracle.mesh,
    );
    assert.equal(
      hex(encodeTakStreamFrame(bytes(oracle.payload))),
      oracle.stream,
    );
  });
}

test('negative zero survives decode and encode as the oracle wrote it', () => {
  const oracle = TAK_PROTO_ORACLE.markerMinimal;
  const decoded = decodeTakMessage(bytes(oracle.payload));
  assert.equal(Object.is(decoded.cotEvent.lon, -0), true);
  assert.equal(Object.is(oracle.values.cotEvent.lon, -0), true);
  // A positive zero is the proto3 default and is omitted from the wire.
  const positive = structuredClone(oracle.values);
  positive.cotEvent.lon = 0;
  assert.ok(encodeTakMessage(positive).length < bytes(oracle.payload).length);
});

test('GEV XML fixture encodes to exactly the bytes the oracle built field by field', () => {
  // ATAK_SA and the oracle saFull message describe the same synthetic report.
  const message = cotEventToTakMessage(parseCotEvent(ATAK_SA));
  assert.deepEqual(message, TAK_PROTO_ORACLE.saFull.values);
  assert.equal(
    hex(cotEventToTakPayload(parseCotEvent(ATAK_SA))),
    TAK_PROTO_ORACLE.saFull.payload,
  );
});

test('an oracle SA decodes into the same CoT contact GEV reads from XML', () => {
  const { control, xml } = takPayloadToCot(
    bytes(TAK_PROTO_ORACLE.saFull.payload),
  );
  assert.equal(control, null);
  const event = parseCotEvent(xml);
  const fromXml = parseCotEvent(ATAK_SA);
  assert.equal(
    canonical(serializeCotEvent(event)),
    canonical(serializeCotEvent(fromXml)),
  );
  assert.equal(event.detail.callsign, 'VIPER');
  assert.deepEqual(event.detail.group, { name: 'Cyan', role: 'Team Lead' });
  assert.deepEqual(event.detail.track, { course: 30.5, speed: 1.2 });
  assert.equal(event.detail.status.battery, 88);
  assert.equal(event.detail.droid, 'VIPER');
  assert.equal(event.point.hae, null, '9999999 remains the unknown sentinel');
  assert.equal(event.timeMs, Date.parse('2026-10-13T19:00:00.123Z'));
});

test('GeoChat with TakControl keeps the advertisement and exact Unicode remarks', () => {
  const { control, xml } = takPayloadToCot(
    bytes(TAK_PROTO_ORACLE.chatWithControl.payload),
  );
  assert.deepEqual(control, {
    minProtoVersion: 1,
    maxProtoVersion: 1,
    contactUid: 'ANDROID-0000synthetic01',
  });
  const event = parseCotEvent(xml);
  assert.equal(event.type, 'b-t-f');
  assert.equal(event.detail.chat.senderCallsign, 'VIPER');
  assert.deepEqual(event.detail.chat.participants, [
    'ANDROID-0000synthetic01',
    'All Chat Rooms',
  ]);
  assert.equal(event.detail.remarks.text, 'radio check & comms ✓ señal 📡');
});

test('a TakControl-only advertisement has no CoT event to route', () => {
  const result = takPayloadToCot(bytes(TAK_PROTO_ORACLE.controlOnly.payload));
  assert.equal(result.xml, null);
  assert.equal(result.control.maxProtoVersion, 1);
});

test('defaults for start, how and absent detail follow CoT semantics', () => {
  const event = parseCotEvent(
    takPayloadToCot(bytes(TAK_PROTO_ORACLE.markerMinimal.payload)).xml,
  );
  assert.equal(event.startMs, event.timeMs);
  assert.equal(event.timeMs, Date.parse('2100-01-01T00:00:00.000Z'));
  assert.equal(event.how, 'h-g-i-g-o');
  assert.deepEqual(
    { ...event.point },
    { lat: -33.8568, lon: 0, hae: 12.25, ce: 4.5, le: null },
  );
});

// --- CoT round trips ------------------------------------------------------

test('every synthetic peer fixture survives XML -> protobuf -> XML', () => {
  for (const xml of [
    ATAK_SA,
    WINTAK_HOSTILE,
    ATAK_CHAT,
    ATAK_DELETE,
    AIR_TRACK,
  ]) {
    const event = parseCotEvent(xml);
    const { payload, back } = roundTrip(event);
    assert.equal(
      canonical(serializeCotEvent(back)),
      canonical(serializeCotEvent(event)),
      event.uid,
    );
    assert.ok(payload.length < serializeCotEvent(event).length, event.uid);
  }
});

test('GEV builder output survives the protobuf round trip', () => {
  const opts = { nowMs: T0 };
  const marker = buildMarker(
    IDENTITY,
    { callsign: 'OP', lat: 1.5, lon: -2.25 },
    opts,
  );
  const events = [
    buildSelfSa(IDENTITY, { lat: 34.36, lon: -89.51 }, opts),
    marker,
    buildChat(IDENTITY, { message: 'hi <there> & "you"' }, opts),
    buildDelete(IDENTITY, marker.uid, marker.type, opts),
    buildPing(IDENTITY, opts),
    buildEmergency(IDENTITY, { lat: 1, lon: 2 }, opts),
  ];
  for (const event of events) {
    const { back } = roundTrip(event);
    assert.equal(
      canonical(serializeCotEvent(back)),
      canonical(serializeCotEvent(event)),
      event.type,
    );
  }
});

test('drawing vertices and styles travel in xmlDetail unchanged', () => {
  const shape = `<event version="2.0" uid="SYNTH-SHAPE-1" type="u-d-f" how="h-e" time="2026-10-13T19:00:00Z" start="2026-10-13T19:00:00Z" stale="2026-10-14T19:00:00Z"><point lat="34.36" lon="-89.52" hae="9999999" ce="9999999" le="9999999"/><detail><link point="34.36,-89.52"/><link point="34.37,-89.51"/><link point="34.35,-89.50"/><strokeColor value="-65536"/><strokeWeight value="3.0"/><contact callsign="Shape 1"/><labels_on value="false"/></detail></event>`;
  const event = parseCotEvent(shape);
  const message = cotEventToTakMessage(event);
  assert.equal(message.cotEvent.detail.contact.callsign, 'Shape 1');
  assert.match(
    message.cotEvent.detail.xmlDetail,
    /^<link point="34.36,-89.52"\/>/,
  );
  const { back } = roundTrip(event);
  assert.equal(
    canonical(serializeCotEvent(back)),
    canonical(serializeCotEvent(event)),
  );
});

test('elements the structured form cannot carry completely stay in xmlDetail', () => {
  const xml = `<event version="2.0" uid="SYNTH-2" type="a-f-G" time="2026-10-13T19:00:00Z" start="2026-10-13T19:00:00Z" stale="2026-10-13T19:05:00Z"><point lat="1" lon="2" hae="0" ce="1" le="1"/><detail><contact callsign="C" phone="555-0100"/><__group name="Cyan"/><status battery="88" readiness="true"/><track course="north" speed="1"/><takv device="D" platform="P" os="1"/><precisionlocation altsrc="GPS"/></detail></event>`;
  const event = parseCotEvent(xml);
  const { detail } = cotEventToTakMessage(event).cotEvent;
  for (const field of [
    'contact',
    'group',
    'status',
    'track',
    'takv',
    'precisionLocation',
  ])
    assert.equal(detail[field], null, field);
  for (const name of [
    'contact',
    '__group',
    'status',
    'track',
    'takv',
    'precisionlocation',
  ])
    assert.match(detail.xmlDetail, new RegExp(`<${name}[ >/]`), name);
  const { back } = roundTrip(event);
  assert.equal(
    canonical(serializeCotEvent(back)),
    canonical(serializeCotEvent(event)),
  );
  assert.equal(back.detail.phone, '555-0100');
});

test('namespaced detail extensions keep their declarations', () => {
  const xml = `<event xmlns:x="urn:synthetic:ext" version="2.0" uid="SYNTH-NS" type="b-m-p-s-m" time="2026-10-13T19:00:00Z" start="2026-10-13T19:00:00Z" stale="2026-10-13T19:05:00Z"><point lat="1" lon="2" hae="0" ce="1" le="1"/><detail><x:note x:level="2">kept</x:note></detail></event>`;
  const event = parseCotEvent(xml);
  const message = cotEventToTakMessage(event);
  assert.equal(
    message.cotEvent.detail.xmlDetail,
    '<x:note xmlns:x="urn:synthetic:ext" x:level="2">kept</x:note>',
  );
  const back = parseCotEvent(takEventToCotXml(message.cotEvent));
  assert.equal(back.detail.extras[0].name, 'x:note');
  assert.equal(back.detail.extras[0].text, 'kept');
});

// --- Refusals -----------------------------------------------------------

test('xmlDetail cannot escape <detail> or smuggle markup', () => {
  for (const xmlDetail of [
    '</detail><point lat="9" lon="9"/><detail>',
    '<!DOCTYPE x [<!ENTITY e "boom">]><a>&e;</a>',
    '<a>&unknown;</a>',
    'loose text',
    '<a>',
    '<![CDATA[<event>]]>',
  ]) {
    const message = cotEventMessage({}, { xmlDetail });
    assert.throws(
      () => takEventToCotXml(message.cotEvent),
      (error) =>
        error instanceof TakProtoError && error.code === 'invalid-event',
      xmlDetail,
    );
  }
});

test('xmlDetail wins over a duplicated structured element, as the schema requires', () => {
  const { cotEvent } = cotEventMessage(
    {},
    {
      xmlDetail: '<contact callsign="FROM XML" phone="555-0100"/>',
      contact: { callsign: 'FROM MESSAGE', endpoint: '' },
      track: { speed: 2, course: 90 },
    },
  );
  const event = parseCotEvent(takEventToCotXml(cotEvent));
  assert.equal(event.detail.callsign, 'FROM XML');
  assert.equal(event.detail.phone, '555-0100');
  assert.deepEqual(event.detail.track, { course: 90, speed: 2 });
});

test('TAK Server schema additions are recognized rather than flagged as unknown', () => {
  // TakMessage.submissionTime (3) / creationTime (4); CotEvent.caveat (16) /
  // releaseableTo (17), as in the official server's takmessage/cotevent.proto.
  const base = TAK_PROTO_ORACLE.markerMinimal.values;
  const message = {
    ...base,
    submissionTime: T0 + 5,
    creationTime: T0 + 4,
    cotEvent: { ...base.cotEvent, caveat: 'SYNTHETIC', releaseableTo: 'LAB' },
  };
  const payload = encodeTakMessage(message);
  assert.deepEqual(decodeTakMessage(payload), message);
  const result = takPayloadToCot(payload);
  assert.equal(result.incomplete, false);
  assert.match(result.xml, /caveat="SYNTHETIC"/);
  assert.match(result.xml, /releasableTo="LAB"/);
  assert.doesNotMatch(result.xml, /submissionTime|creationTime/);
  // Absent server fields leave the client-schema shape unchanged.
  assert.deepEqual(
    Object.keys(
      decodeTakMessage(bytes(TAK_PROTO_ORACLE.markerMinimal.payload)),
    ),
    ['takControl', 'cotEvent'],
  );
});

test('events without usable times or positions are refused, not invented', () => {
  for (const fields of [
    { sendTime: 0 },
    { staleTime: 0 },
    { sendTime: 9e15 },
  ]) {
    assert.throws(
      () => takEventToCotXml(cotEventMessage(fields).cotEvent),
      (error) => error.code === 'invalid-event',
    );
  }
  const xml = takEventToCotXml(cotEventMessage({ lat: Number.NaN }).cotEvent);
  assert.throws(() => parseCotEvent(xml), /no valid point/);
  assert.throws(() => takEventToCotXml(null), TakProtoError);
});

test('malformed wire data is refused with TakProtoError', () => {
  const cases = {
    'wrong wire type for uid': '12022801',
    'wrong wire type for cotEvent': '1001',
    'group wire type': '12012b',
    'truncated varint': '1280',
    'eleven-byte varint': '10' + 'ff'.repeat(10) + '01',
    'tenth varint byte overflow': '10' + 'ff'.repeat(9) + '02',
    'inner length beyond message': '12052a04414243',
    'outer length beyond payload': '12062a03414243',
    'invalid UTF-8 uid': '12032a01ff',
    'invalid wire type 7': '0f',
    'field number zero': '0000',
  };
  for (const [label, text] of Object.entries(cases))
    assert.throws(() => decodeTakMessage(bytes(text)), TakProtoError, label);
});

test('uint32 overflow and unsafe uint64 are rejected precisely', () => {
  // Detail.status.battery = 2^32 (field 5 of Detail, field 1 of Status).
  const status = '08' + '8080808010';
  const detail =
    '2a' + (status.length / 2).toString(16).padStart(2, '0') + status;
  const cotEvent =
    '7a' + (detail.length / 2).toString(16).padStart(2, '0') + detail;
  const payload =
    '12' + (cotEvent.length / 2).toString(16).padStart(2, '0') + cotEvent;
  assert.throws(() => decodeTakMessage(bytes(payload)), /exceeds uint32/);
  // CotEvent.sendTime = 2^53 exactly is not a safe integer.
  const time = '30' + '8080808080808010';
  assert.throws(
    () =>
      decodeTakMessage(
        bytes('12' + (time.length / 2).toString(16).padStart(2, '0') + time),
      ),
    /out of range/,
  );
});

test('unknown fields are skipped and repeated messages merge as protobuf does', () => {
  const known = TAK_PROTO_ORACLE.markerMinimal.payload;
  // TakMessage field 99 (length-delimited), then a CotEvent carrying only
  // unknown field 20 (varint): both are skipped without disturbing the event.
  const decoded = decodeTakMessage(
    bytes('9a0603abcdef' + known + '1203a00105'),
  );
  assert.deepEqual(decoded, TAK_PROTO_ORACLE.markerMinimal.values);
  // Skipped fields are reported so receivers can flag a partial decode.
  assert.equal(takPayloadToCot(bytes('9a0603abcdef' + known)).incomplete, true);
  assert.equal(takPayloadToCot(bytes(known)).incomplete, false);
  const stats = { unknownFields: 0 };
  decodeTakMessage(bytes('9a0603abcdef' + known + '1203a00105'), stats);
  assert.equal(stats.unknownFields, 2);
  // A second cotEvent occurrence overrides only the fields it carries.
  const merged = decodeTakMessage(bytes(known + '12052a03414243'));
  assert.equal(merged.cotEvent.uid, 'ABC');
  assert.equal(merged.cotEvent.type, 'b-m-p-s-m');
});

test('payload and converted event sizes are bounded', () => {
  assert.throws(
    () => decodeTakMessage(new Uint8Array(MAX_TAK_PROTO_PAYLOAD_BYTES + 1)),
    (error) => error.code === 'oversized',
  );
  // Single-quoted '"' characters expand six-fold when re-serialized.
  const attrs = Array.from(
    { length: 10 },
    (_, i) => `a${i}='${'"'.repeat(4000)}'`,
  ).join(' ');
  const { cotEvent } = cotEventMessage({}, { xmlDetail: `<big ${attrs}/>` });
  assert.ok(
    encodeTakMessage({ cotEvent }).length <= MAX_TAK_PROTO_PAYLOAD_BYTES,
  );
  assert.throws(
    () => takEventToCotXml(cotEvent),
    (error) => error.code === 'oversized',
  );
});

test('every truncation and seeded mutation fails closed', () => {
  const payload = bytes(TAK_PROTO_ORACLE.chatWithControl.payload);
  const attempt = (input) => {
    let decoded;
    try {
      decoded = decodeTakMessage(input);
    } catch (error) {
      assert.ok(error instanceof TakProtoError, error.stack);
      return;
    }
    if (!decoded.cotEvent) return;
    let xml;
    try {
      xml = takEventToCotXml(decoded.cotEvent);
    } catch (error) {
      assert.ok(error instanceof TakProtoError, error.stack);
      return;
    }
    try {
      parseCotEvent(xml);
    } catch (error) {
      assert.ok(error instanceof CotValidationError, error.stack);
    }
  };
  for (let length = 0; length < payload.length; length++)
    attempt(payload.subarray(0, length));
  let seed = 0x5eed;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x80000000;
  };
  for (let round = 0; round < 3000; round++) {
    const mutated = payload.slice();
    for (let flips = 1 + Math.floor(random() * 4); flips > 0; flips--)
      mutated[Math.floor(random() * mutated.length)] = Math.floor(
        random() * 256,
      );
    attempt(mutated);
  }
});

// --- Mesh header and stream framing --------------------------------------

test('mesh datagrams with another version or a broken header are distinguished', () => {
  assert.throws(
    () => readTakMeshDatagram(Uint8Array.of(0xbf, 0x02, 0xbf, 0x12, 0x00)),
    (error) => error.code === 'unsupported-version',
  );
  for (const datagram of [
    Uint8Array.of(0xbf, 0x01, 0x00),
    Uint8Array.of(0xbf, 0x01),
    Uint8Array.of(0x3c, 0x65),
    Uint8Array.of(0xbf),
  ])
    assert.throws(
      () => readTakMeshDatagram(datagram),
      (error) => error.code === 'malformed',
    );
});

test('stream framer reassembles frames across every chunk boundary', () => {
  const frames = Object.values(TAK_PROTO_ORACLE).map((oracle) => oracle.stream);
  const stream = bytes(frames.join(''));
  const expected = Object.values(TAK_PROTO_ORACLE).map(
    (oracle) => oracle.payload,
  );
  for (const size of [1, 2, 3, 5, 64, stream.length]) {
    const payloads = [];
    const framer = createTakStreamFramer({
      onPayload: (payload) => payloads.push(hex(payload)),
      onError: (error) => assert.fail(error.message),
    });
    for (let at = 0; at < stream.length; at += size)
      framer.push(stream.subarray(at, at + size));
    assert.deepEqual(payloads, expected, `chunk ${size}`);
    assert.equal(framer.stats().buffered, 0);
  }
});

test('stream framer poisons on a missing header or oversized frame until reset', () => {
  const errors = [];
  const payloads = [];
  const framer = createTakStreamFramer({
    onPayload: (payload) => payloads.push(payload),
    onError: (error) => errors.push(error.code),
    maxPayloadBytes: 1024,
  });
  framer.push(Buffer.from('<event'));
  framer.push(bytes(TAK_PROTO_ORACLE.controlOnly.stream));
  assert.deepEqual(errors, ['malformed']);
  assert.equal(payloads.length, 0);
  assert.equal(framer.stats().poisoned, true);
  framer.reset();
  framer.push(Uint8Array.of(0xbf, 0x81, 0x08)); // 1025 bytes announced
  assert.deepEqual(errors, ['malformed', 'oversized']);
  framer.reset();
  framer.push(bytes(TAK_PROTO_ORACLE.controlOnly.stream));
  assert.equal(payloads.length, 1);
});

// --- Streaming negotiation ----------------------------------------------

// The specification's own examples, verbatim apart from concrete times.
const SPEC_TIME = '2026-10-13T19:00:00Z';
const SPEC_STALE = '2026-10-13T19:01:00Z';
const specControl = (type, control) =>
  `<event version='2.0' uid='protouid' type='${type}' time='${SPEC_TIME}' start='${SPEC_TIME}' stale='${SPEC_STALE}' how='m-g'>
  <point lat='0.0' lon='0.0' hae='0.0' ce='999999' le='999999'/>
  <detail>
    <TakControl>
      ${control}
    </TakControl>
  </detail>
</event>`;
const SPEC_OFFER = specControl(
  't-x-takp-v',
  `<TakProtocolSupport version="1">
        <DetailExt id="extId" supportsAll="true"/>
      </TakProtocolSupport>`,
);
const SPEC_ACCEPT = specControl('t-x-takp-r', '<TakResponse status="true"/>');
const SPEC_DENY = specControl('t-x-takp-r', '<TakResponse status="false"/>');

test('negotiation control events are recognized from the specification examples', () => {
  assert.equal(mayBeTakProtocolControl(SPEC_OFFER), true);
  assert.equal(
    mayBeTakProtocolControl(ATAK_SA.replace(/^<\?xml[^>]*\?>/, '')),
    false,
  );
  assert.deepEqual(readTakProtocolControl(SPEC_OFFER), {
    kind: 'support',
    uid: 'protouid',
    versions: [1],
    status: null,
  });
  assert.equal(readTakProtocolControl(SPEC_ACCEPT).status, true);
  assert.equal(readTakProtocolControl(SPEC_DENY).status, false);
  assert.equal(readTakProtocolControl(ATAK_SA), null);
  const twoAnswers = specControl(
    't-x-takp-r',
    '<TakResponse status="true"/><TakResponse status="true"/>',
  );
  assert.equal(readTakProtocolControl(twoAnswers).status, null);
  const request = buildTakProtocolRequest({ uid: 'protouid', nowMs: T0 });
  assert.deepEqual(readTakProtocolControl(request), {
    kind: 'request',
    uid: 'protouid',
    versions: [1],
    status: null,
  });
  assert.match(request, /<TakControl><TakRequest version="1"\/><\/TakControl>/);
  assert.equal(
    parseCotEvent(request).staleMs - parseCotEvent(request).timeMs,
    60_000,
  );
});

function readerHarness(onControl = () => {}) {
  const xml = [];
  const payloads = [];
  const errors = [];
  const reader = createTakStreamReader({
    onXml: (text) => {
      xml.push(text);
      const control = mayBeTakProtocolControl(text)
        ? readTakProtocolControl(text)
        : null;
      if (control) onControl(control, reader);
    },
    onPayload: (payload) => payloads.push(hex(payload)),
    onError: (error) => errors.push(error.code),
  });
  return { reader, xml, payloads, errors };
}

const answer = (control, reader) => {
  if (control.kind !== 'response') return;
  if (control.status) reader.acceptProtobuf();
  else reader.release();
};

test('the stream switches to binary frames exactly after the accepting response', () => {
  const frames =
    TAK_PROTO_ORACLE.saFull.stream + TAK_PROTO_ORACLE.chatWithControl.stream;
  // Multi-byte UTF-8 before the response exercises split characters too.
  const before = Buffer.from(WINTAK_HOSTILE.replace('H.1', 'Ĥ.1 ✓'));
  const stream = Buffer.concat([
    before,
    Buffer.from(SPEC_ACCEPT),
    Buffer.from(frames, 'hex'),
  ]);
  const expected = [
    TAK_PROTO_ORACLE.saFull.payload,
    TAK_PROTO_ORACLE.chatWithControl.payload,
  ];
  const run = (chunks) => {
    const h = readerHarness(answer);
    h.reader.hold();
    for (const chunk of chunks) h.reader.push(chunk);
    assert.deepEqual(h.errors, []);
    assert.equal(h.xml.length, 2);
    assert.equal(parseCotEvent(h.xml[0]).detail.callsign, 'Ĥ.1 ✓');
    assert.deepEqual(h.payloads, expected);
    assert.equal(h.reader.mode, 'protobuf');
  };
  run([stream]);
  for (let split = 1; split < stream.length; split++)
    run([stream.subarray(0, split), stream.subarray(split)]);
  run([...stream].map((byte) => Uint8Array.of(byte)));
});

test('a denied request resumes XML and a stray newline after acceptance is tolerated', () => {
  const denied = readerHarness(answer);
  denied.reader.hold();
  denied.reader.push(Buffer.from(SPEC_DENY + ATAK_CHAT.slice(0, 40)));
  denied.reader.push(Buffer.from(ATAK_CHAT.slice(40)));
  assert.equal(denied.reader.mode, 'xml');
  assert.equal(parseCotEvent(denied.xml[1]).type, 'b-t-f');

  const lenient = readerHarness(answer);
  lenient.reader.hold();
  lenient.reader.push(Buffer.from(SPEC_ACCEPT + '\r\n'));
  // Whitespace may also arrive in its own chunk before the first frame.
  lenient.reader.push(Buffer.from('\n'));
  lenient.reader.push(Buffer.from(TAK_PROTO_ORACLE.controlOnly.stream, 'hex'));
  assert.deepEqual(lenient.payloads, [TAK_PROTO_ORACLE.controlOnly.payload]);
  assert.deepEqual(lenient.errors, []);
});

test('held bytes are bounded and binary garbage after acceptance fails the stream', () => {
  const runaway = readerHarness();
  runaway.reader.hold();
  runaway.reader.push(new Uint8Array(2 * 64 * 1024 + 1).fill(0x41));
  assert.deepEqual(runaway.errors, ['oversized']);
  assert.equal(runaway.reader.mode, 'failed');
  runaway.reader.reset();
  assert.equal(runaway.reader.mode, 'xml');

  const garbage = readerHarness(answer);
  garbage.reader.hold();
  garbage.reader.push(
    Buffer.concat([Buffer.from(SPEC_ACCEPT), Buffer.from('<event')]),
  );
  assert.deepEqual(garbage.errors, ['malformed']);
});

test('XML-only streams read identically through the byte reader', () => {
  const stream = Buffer.from(ATAK_SA + WINTAK_HOSTILE + ATAK_CHAT);
  for (const size of [1, 3, 17, stream.length]) {
    const h = readerHarness();
    for (let at = 0; at < stream.length; at += size)
      h.reader.push(stream.subarray(at, at + size));
    assert.deepEqual(
      h.xml.map((xml) => parseCotEvent(xml).uid),
      [ATAK_SA, WINTAK_HOSTILE, ATAK_CHAT].map((xml) => parseCotEvent(xml).uid),
    );
  }
});
