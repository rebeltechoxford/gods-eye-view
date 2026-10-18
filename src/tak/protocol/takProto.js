// TAK Protocol Version 1: protobuf payloads, mesh datagrams, streaming frames
// and lossless-where-possible conversion to and from CoT XML.
//
// Independent MIT implementation written against the public TAK protocol
// description (atak-civ takproto/README.txt) and its published proto3 schema
// (package atakmap.commoncommo.protobuf.v1). No generated protobuf runtime:
// the schema is small and fixed, so a bounded hand-written reader refuses
// what a general decoder would silently accept. Decoded events are converted
// to CoT XML and validated by the same parser as every other input, so a
// protobuf peer gains no path around XML validation. Portable like the rest
// of this directory (no DOM, no Node APIs); today only the gateway and the
// synthetic lab import it, so it adds nothing to the application bundle.

import {
  MAX_COT_EVENT_BYTES,
  byteLength,
  parseCotEvent,
  parseCotTime,
  serializeCotEvent,
} from './cot.js';
import { TAK_PROTO_MAGIC, createCotStreamFramer } from './stream.js';
import {
  CotXmlError,
  parseXmlDocument,
  parseXmlFragment,
  serializeXmlElement,
} from './xml.js';

export { TAK_PROTO_MAGIC };

/** The only TAK protocol payload version this module encodes or decodes. */
export const TAK_PROTOCOL_VERSION = 1;
/** Largest accepted payload; a converted event must still fit the XML cap. */
export const MAX_TAK_PROTO_PAYLOAD_BYTES = MAX_COT_EVENT_BYTES;
/** Latest instant Date can format (ECMAScript time value limit). */
const MAX_TIME_MS = 8.64e15;

export class TakProtoError extends Error {
  /**
   * @param {string} message
   * @param {'malformed'|'unsupported-version'|'oversized'|'invalid-event'} [code]
   */
  constructor(message, code = 'malformed') {
    super(message);
    this.name = 'TakProtoError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Schema (field number -> [name, type, message])
// ---------------------------------------------------------------------------

const SCHEMA = Object.freeze({
  TakMessage: {
    1: ['takControl', 'message', 'TakControl'],
    2: ['cotEvent', 'message', 'CotEvent'],
  },
  TakControl: {
    1: ['minProtoVersion', 'uint32'],
    2: ['maxProtoVersion', 'uint32'],
    3: ['contactUid', 'string'],
  },
  CotEvent: {
    1: ['type', 'string'],
    2: ['access', 'string'],
    3: ['qos', 'string'],
    4: ['opex', 'string'],
    5: ['uid', 'string'],
    6: ['sendTime', 'uint64'],
    7: ['startTime', 'uint64'],
    8: ['staleTime', 'uint64'],
    9: ['how', 'string'],
    10: ['lat', 'double'],
    11: ['lon', 'double'],
    12: ['hae', 'double'],
    13: ['ce', 'double'],
    14: ['le', 'double'],
    15: ['detail', 'message', 'Detail'],
  },
  Detail: {
    1: ['xmlDetail', 'string'],
    2: ['contact', 'message', 'Contact'],
    3: ['group', 'message', 'Group'],
    4: ['precisionLocation', 'message', 'PrecisionLocation'],
    5: ['status', 'message', 'Status'],
    6: ['takv', 'message', 'Takv'],
    7: ['track', 'message', 'Track'],
  },
  Contact: { 1: ['endpoint', 'string'], 2: ['callsign', 'string'] },
  Group: { 1: ['name', 'string'], 2: ['role', 'string'] },
  PrecisionLocation: { 1: ['geopointsrc', 'string'], 2: ['altsrc', 'string'] },
  Status: { 1: ['battery', 'uint32'] },
  Takv: {
    1: ['device', 'string'],
    2: ['platform', 'string'],
    3: ['os', 'string'],
    4: ['version', 'string'],
  },
  Track: { 1: ['speed', 'double'], 2: ['course', 'double'] },
});

// TAK Server's copy of the schema appends these fields. They are recognized
// so they are never mistaken for an unknown detail extension, and appear in
// a decoded message only when sent. Submission/creation times are server
// bookkeeping, not CoT; caveat/releasableTo are CoT event attributes.
const SERVER_FIELDS = Object.freeze({
  TakMessage: {
    3: ['submissionTime', 'uint64'],
    4: ['creationTime', 'uint64'],
  },
  CotEvent: {
    16: ['caveat', 'string'],
    17: ['releaseableTo', 'string'],
  },
});

const WIRE = Object.freeze({ varint: 0, fixed64: 1, bytes: 2, fixed32: 5 });
const TYPE_WIRE = Object.freeze({
  string: WIRE.bytes,
  message: WIRE.bytes,
  uint32: WIRE.varint,
  uint64: WIRE.varint,
  double: WIRE.fixed64,
});
const DEFAULTS = Object.freeze({ string: '', uint32: 0, uint64: 0, double: 0 });

function emptyMessage(name) {
  const out = {};
  for (const [field, type] of Object.values(SCHEMA[name]))
    out[field] = type === 'message' ? null : DEFAULTS[type];
  return out;
}

// ---------------------------------------------------------------------------
// Wire reader
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Encoder = new TextEncoder();

/**
 * Read an unsigned varint. Returns a Number; values beyond 2^53 lose
 * precision, so callers that need exact values check Number.isSafeInteger.
 */
function readVarint(bytes, at, end) {
  let value = 0;
  let scale = 1;
  for (let i = 0; i < 10; i++) {
    if (at >= end) throw new TakProtoError('Truncated varint');
    const byte = bytes[at++];
    // The tenth byte may carry only bit 63.
    if (i === 9 && byte > 1) throw new TakProtoError('Varint exceeds 64 bits');
    value += (byte & 0x7f) * scale;
    if (!(byte & 0x80)) return { value, at };
    scale *= 128;
  }
  throw new TakProtoError('Varint exceeds 10 bytes');
}

/** True once bytes[at..] holds a terminated varint (or 10 bytes, which fail decoding). */
function varintComplete(bytes, at, end) {
  for (let i = at; i < end && i < at + 10; i++)
    if (!(bytes[i] & 0x80)) return true;
  return end - at >= 10;
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function decodeMessage(
  name,
  bytes,
  start,
  end,
  stats,
  target = emptyMessage(name),
) {
  const schema = SCHEMA[name];
  let at = start;
  while (at < end) {
    const key = readVarint(bytes, at, end);
    at = key.at;
    if (!Number.isSafeInteger(key.value))
      throw new TakProtoError('Invalid field key');
    const number = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (number < 1 || number > 0x1fffffff)
      throw new TakProtoError('Invalid field number');
    let value = 0; // varint value
    let spanStart = 0; // fixed64 / length-delimited contents
    let spanEnd = 0;
    switch (wire) {
      case WIRE.varint: {
        const read = readVarint(bytes, at, end);
        value = read.value;
        at = read.at;
        break;
      }
      case WIRE.fixed64:
        if (end - at < 8) throw new TakProtoError('Truncated fixed64 field');
        spanStart = at;
        at += 8;
        break;
      case WIRE.bytes: {
        const read = readVarint(bytes, at, end);
        if (!Number.isSafeInteger(read.value) || read.value > end - read.at)
          throw new TakProtoError('Truncated length-delimited field');
        spanStart = read.at;
        spanEnd = read.at + read.value;
        at = spanEnd;
        break;
      }
      case WIRE.fixed32:
        if (end - at < 4) throw new TakProtoError('Truncated fixed32 field');
        at += 4;
        break;
      default:
        // Groups (3/4) are deprecated and absent from this schema; 6/7 are invalid.
        throw new TakProtoError(`Unsupported wire type ${wire}`);
    }
    const field = schema[number] || SERVER_FIELDS[name]?.[number];
    // Unknown fields are skipped: the protocol allows appending fields whose
    // omission is irrelevant to every TAK application. They are counted
    // because an unadvertised detail extension would also arrive this way.
    if (!field) {
      stats.unknownFields++;
      continue;
    }
    const [fieldName, type, messageName] = field;
    if (TYPE_WIRE[type] !== wire)
      throw new TakProtoError(`${name}.${fieldName} has the wrong wire type`);
    switch (type) {
      case 'string':
        try {
          target[fieldName] = utf8.decode(bytes.subarray(spanStart, spanEnd));
        } catch {
          throw new TakProtoError(`${name}.${fieldName} is not valid UTF-8`);
        }
        break;
      case 'message':
        // Repeated occurrences of a singular message merge (protobuf rules).
        target[fieldName] = decodeMessage(
          messageName,
          bytes,
          spanStart,
          spanEnd,
          stats,
          target[fieldName] || emptyMessage(messageName),
        );
        break;
      case 'uint32':
        if (value > 0xffffffff)
          throw new TakProtoError(`${name}.${fieldName} exceeds uint32`);
        target[fieldName] = value;
        break;
      case 'uint64':
        if (!Number.isSafeInteger(value))
          throw new TakProtoError(`${name}.${fieldName} is out of range`);
        target[fieldName] = value;
        break;
      case 'double':
        target[fieldName] = view(bytes).getFloat64(spanStart, true);
        break;
    }
  }
  if (at !== end) throw new TakProtoError(`${name} overruns its length`);
  return target;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input))
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TakProtoError('TAK protocol payload must be bytes');
}

/**
 * Decode one TAK Protocol v1 payload (a serialized TakMessage, no header).
 * Scalars absent on the wire take their proto3 defaults; absent messages are null.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {{unknownFields:number}} [stats] Receives the count of skipped fields.
 */
export function decodeTakMessage(input, stats = { unknownFields: 0 }) {
  const bytes = asBytes(input);
  if (bytes.byteLength > MAX_TAK_PROTO_PAYLOAD_BYTES)
    throw new TakProtoError(
      'TAK protocol payload exceeds the size limit',
      'oversized',
    );
  return decodeMessage('TakMessage', bytes, 0, bytes.byteLength, stats);
}

// ---------------------------------------------------------------------------
// Wire writer
// ---------------------------------------------------------------------------

function varintBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TakProtoError('Varint must be a non-negative safe integer');
  const out = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// Proto3 omits default scalars. -0 is encoded: its bit pattern is not zero.
function encodeMessage(name, message) {
  const parts = [];
  const fields = Object.entries({
    ...SCHEMA[name],
    ...SERVER_FIELDS[name],
  }).sort(([a], [b]) => a - b);
  for (const [number, [fieldName, type, messageName]] of fields) {
    const value = message?.[fieldName];
    const key = (wire) => varintBytes(Number(number) * 8 + wire);
    switch (type) {
      case 'string': {
        if (typeof value !== 'string' || value === '') break;
        const encoded = utf8Encoder.encode(value);
        parts.push(key(WIRE.bytes), varintBytes(encoded.length), encoded);
        break;
      }
      case 'message': {
        if (!value) break;
        const encoded = encodeMessage(messageName, value);
        parts.push(key(WIRE.bytes), varintBytes(encoded.length), encoded);
        break;
      }
      case 'uint32':
      case 'uint64': {
        if (!value) break;
        if (type === 'uint32' && value > 0xffffffff)
          throw new TakProtoError(`${name}.${fieldName} exceeds uint32`);
        parts.push(key(WIRE.varint), varintBytes(value));
        break;
      }
      case 'double': {
        if (typeof value !== 'number' || Object.is(value, 0)) break;
        const encoded = new Uint8Array(8);
        view(encoded).setFloat64(0, value, true);
        parts.push(key(WIRE.fixed64), encoded);
        break;
      }
    }
  }
  return concat(
    parts.map((part) =>
      part instanceof Uint8Array ? part : Uint8Array.from(part),
    ),
  );
}

/** Serialize a TakMessage object (same shape decodeTakMessage returns). */
export function encodeTakMessage(message) {
  const bytes = encodeMessage('TakMessage', message);
  if (bytes.byteLength > MAX_TAK_PROTO_PAYLOAD_BYTES)
    throw new TakProtoError(
      'TAK protocol payload exceeds the size limit',
      'oversized',
    );
  return bytes;
}

// ---------------------------------------------------------------------------
// Mesh datagrams and streaming frames
// ---------------------------------------------------------------------------

/** Mesh datagram: 0xbf <version varint> 0xbf <payload>. */
export function encodeTakMeshDatagram(payload) {
  return concat([
    Uint8Array.of(TAK_PROTO_MAGIC, TAK_PROTOCOL_VERSION, TAK_PROTO_MAGIC),
    asBytes(payload),
  ]);
}

/**
 * Split a mesh datagram into its version and payload. Throws TakProtoError
 * with code 'unsupported-version' for a well-formed header of another version.
 */
export function readTakMeshDatagram(input) {
  const bytes = asBytes(input);
  if (bytes[0] !== TAK_PROTO_MAGIC)
    throw new TakProtoError('Missing TAK protocol header');
  const version = readVarint(bytes, 1, bytes.byteLength);
  if (bytes[version.at] !== TAK_PROTO_MAGIC)
    throw new TakProtoError('Malformed TAK protocol header');
  if (version.value !== TAK_PROTOCOL_VERSION)
    throw new TakProtoError(
      `TAK protocol version ${version.value} is not supported`,
      'unsupported-version',
    );
  return { version: version.value, payload: bytes.subarray(version.at + 1) };
}

/** Streaming frame: 0xbf <payload length varint> <payload>. */
export function encodeTakStreamFrame(payload) {
  const bytes = asBytes(payload);
  return concat([
    Uint8Array.of(TAK_PROTO_MAGIC),
    Uint8Array.from(varintBytes(bytes.byteLength)),
    bytes,
  ]);
}

/**
 * Frame a negotiated TAK protocol stream into payloads. A stream has no
 * resynchronization marker, so any framing error poisons the framer until
 * reset(); the owner should drop the connection.
 * @param {object} options
 * @param {(payload:Uint8Array)=>void} options.onPayload
 * @param {(error:TakProtoError)=>void} [options.onError]
 * @param {number} [options.maxPayloadBytes]
 */
export function createTakStreamFramer({
  onPayload,
  onError = () => {},
  maxPayloadBytes = MAX_TAK_PROTO_PAYLOAD_BYTES,
}) {
  let buffer = new Uint8Array(0);
  let poisoned = false;
  let framed = 0;
  function fail(error) {
    poisoned = true;
    buffer = new Uint8Array(0);
    onError(error);
  }
  return Object.freeze({
    /** Append raw stream bytes. */
    push(chunk) {
      if (poisoned || !chunk?.length) return;
      buffer = buffer.length
        ? concat([buffer, asBytes(chunk)])
        : asBytes(chunk).slice();
      while (buffer.length && !poisoned) {
        if (buffer[0] !== TAK_PROTO_MAGIC)
          return fail(new TakProtoError('Missing TAK stream header'));
        // A length cut by the chunk boundary is incomplete, not invalid.
        if (!varintComplete(buffer, 1, buffer.length)) return;
        let length;
        try {
          length = readVarint(buffer, 1, buffer.length);
        } catch (error) {
          return fail(error);
        }
        if (length.value > maxPayloadBytes)
          return fail(
            new TakProtoError(
              'TAK stream frame exceeds the size limit',
              'oversized',
            ),
          );
        const end = length.at + length.value;
        if (buffer.length < end) return;
        const payload = buffer.slice(length.at, end);
        buffer = buffer.subarray(end);
        framed++;
        onPayload(payload);
      }
    },
    reset() {
      buffer = new Uint8Array(0);
      poisoned = false;
    },
    stats: () => ({ framed, buffered: buffer.length, poisoned }),
  });
}

// ---------------------------------------------------------------------------
// CoT XML conversion
// ---------------------------------------------------------------------------

/**
 * Detail elements with a structured protobuf form. Every attribute the form
 * names is required unless the published schema says otherwise (contact's
 * endpoint); anything less travels whole in xmlDetail.
 */
const STRUCTURED = Object.freeze({
  contact: {
    field: 'contact',
    attrs: ['endpoint', 'callsign'],
    required: ['callsign'],
  },
  __group: {
    field: 'group',
    attrs: ['name', 'role'],
    required: ['name', 'role'],
  },
  precisionlocation: {
    field: 'precisionLocation',
    attrs: ['geopointsrc', 'altsrc'],
    required: ['geopointsrc', 'altsrc'],
  },
  status: { field: 'status', attrs: ['battery'], required: ['battery'] },
  takv: {
    field: 'takv',
    attrs: ['device', 'platform', 'os', 'version'],
    required: ['device', 'platform', 'os', 'version'],
  },
  track: {
    field: 'track',
    attrs: ['speed', 'course'],
    required: ['speed', 'course'],
  },
});

function timeText(ms, label) {
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_TIME_MS)
    throw new TakProtoError(
      `CoT event ${label} time is missing or invalid`,
      'invalid-event',
    );
  return new Date(ms).toISOString();
}

// Doubles keep JavaScript's shortest round-trip text. NaN/Infinity become
// text the CoT parser refuses, so an unusable point is rejected there.
const numberText = (value) => String(value);

function structuredElement(name, values) {
  const attrs = {};
  for (const attr of STRUCTURED[name].attrs) {
    const value = values[attr];
    if (typeof value === 'number') attrs[attr] = numberText(value);
    else if (value) attrs[attr] = value;
  }
  return { name, attrs, children: [] };
}

function xmlDetailElements(xmlDetail) {
  if (!xmlDetail) return [];
  try {
    // Re-serialized rather than spliced so the fragment cannot close <detail>.
    return parseXmlFragment(xmlDetail);
  } catch (error) {
    if (error instanceof CotXmlError)
      throw new TakProtoError(
        `Detail XML is malformed: ${error.message}`,
        'invalid-event',
      );
    throw error;
  }
}

/**
 * Convert a decoded CotEvent message to a CoT XML event string. The result
 * is not yet validated as CoT; feed it to parseCotEvent/router.receiveXml.
 * @param {ReturnType<typeof decodeTakMessage>['cotEvent']} event
 * @returns {string}
 */
export function takEventToCotXml(event) {
  if (!event)
    throw new TakProtoError('TAK message has no CoT event', 'invalid-event');
  const time = timeText(event.sendTime, 'send');
  const attrs = {
    version: '2.0',
    uid: event.uid,
    type: event.type,
    how: event.how || undefined,
    time,
    start: event.startTime ? timeText(event.startTime, 'start') : time,
    stale: timeText(event.staleTime, 'stale'),
    access: event.access || undefined,
    qos: event.qos || undefined,
    opex: event.opex || undefined,
    caveat: event.caveat || undefined,
    releasableTo: event.releaseableTo || undefined,
  };
  const point = {
    name: 'point',
    attrs: {
      lat: numberText(event.lat),
      lon: numberText(event.lon),
      hae: numberText(event.hae),
      ce: numberText(event.ce),
      le: numberText(event.le),
    },
    children: [],
  };
  const children = [];
  const detail = event.detail;
  if (detail) {
    const extra = xmlDetailElements(detail.xmlDetail);
    // A sender that left an element in xmlDetail as well as in its message
    // form broke the sending rules; the schema says xmlDetail then wins.
    const inXml = new Set(extra.map((element) => element.name));
    for (const [name, { field }] of Object.entries(STRUCTURED))
      if (detail[field] && !inXml.has(name))
        children.push(structuredElement(name, detail[field]));
    children.push(...extra);
  }
  let xml;
  try {
    xml = serializeXmlElement({
      name: 'event',
      attrs,
      children: [point, { name: 'detail', attrs: {}, children }],
    });
  } catch (error) {
    if (error instanceof CotXmlError)
      throw new TakProtoError(
        `CoT event cannot be represented: ${error.message}`,
        'invalid-event',
      );
    throw error;
  }
  if (byteLength(xml) > MAX_COT_EVENT_BYTES)
    throw new TakProtoError(
      'Converted CoT event exceeds the size limit',
      'oversized',
    );
  return xml;
}

/**
 * Decode a payload into its optional TakControl and CoT XML.
 * A TakControl-only message (mesh version advertisement) has xml === null.
 * `incomplete` reports skipped unknown fields: the event may lack detail its
 * sender meant to include, which receivers should make visible.
 * @returns {{control: ?object, xml: ?string, incomplete: boolean}}
 */
export function takPayloadToCot(input) {
  const stats = { unknownFields: 0 };
  const message = decodeTakMessage(input, stats);
  return {
    control: message.takControl,
    xml: message.cotEvent ? takEventToCotXml(message.cotEvent) : null,
    incomplete: stats.unknownFields > 0,
  };
}

function isWhitespace(text) {
  return !String(text || '').trim();
}

// An element moves into its structured form only when the protobuf form
// represents it completely: known attributes only, non-empty values, no
// children/text, and numeric fields that survive the conversion.
function structuredValues(element) {
  const spec = STRUCTURED[element.name];
  if (!spec || element.children.length || !isWhitespace(element.text))
    return null;
  const names = Object.keys(element.attrs);
  if (!names.every((attr) => spec.attrs.includes(attr))) return null;
  if (!spec.required.every((attr) => names.includes(attr))) return null;
  const values = {};
  for (const attr of names) {
    const raw = element.attrs[attr];
    if (raw === '') return null;
    if (element.name === 'status') {
      if (!/^(?:0|[1-9]\d{0,9})$/.test(raw) || Number(raw) > 0xffffffff)
        return null;
      values[attr] = Number(raw);
    } else if (element.name === 'track') {
      const parsed = Number(raw);
      if (
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim()) ||
        !Number.isFinite(parsed)
      )
        return null;
      values[attr] = parsed;
    } else values[attr] = raw;
  }
  return values;
}

// Inherited namespace bindings travel with each element moved into xmlDetail.
function withScope(element) {
  const inherited = [];
  for (const key in element.namespaces || {})
    if (!Object.hasOwn(element.attrs, key))
      inherited.push([key, element.namespaces[key]]);
  if (!inherited.length) return element;
  return {
    ...element,
    attrs: { ...Object.fromEntries(inherited), ...element.attrs },
  };
}

/**
 * Convert a CoT event (parsed or built) to a TakMessage object. Detail
 * elements without a complete structured form are carried in xmlDetail.
 * @param {import('./cot.js').CotEvent} event
 */
export function cotEventToTakMessage(event) {
  const root = parseXmlDocument(serializeCotEvent(event));
  const a = root.attrs;
  const point = root.children.find((child) => child.name === 'point');
  const detailEl = root.children.find((child) => child.name === 'detail');
  const number = (value) => (value === undefined ? 0 : Number(value));
  const message = {
    type: a.type,
    access: a.access || '',
    qos: a.qos || '',
    opex: a.opex || '',
    uid: a.uid,
    sendTime: parseCotTime(a.time),
    startTime: parseCotTime(a.start),
    staleTime: parseCotTime(a.stale),
    how: a.how || '',
    lat: number(point?.attrs.lat),
    lon: number(point?.attrs.lon),
    hae: number(point?.attrs.hae),
    ce: number(point?.attrs.ce),
    le: number(point?.attrs.le),
    detail: null,
  };
  for (const key of ['sendTime', 'startTime', 'staleTime'])
    if (!Number.isSafeInteger(message[key]) || message[key] < 0)
      throw new TakProtoError(
        `CoT event ${key} cannot be encoded`,
        'invalid-event',
      );
  if (detailEl) {
    const detail = emptyMessage('Detail');
    let xmlDetail = '';
    for (const child of detailEl.children) {
      const spec = STRUCTURED[child.name];
      const values =
        spec && !detail[spec.field] ? structuredValues(child) : null;
      if (values) detail[spec.field] = values;
      else xmlDetail += serializeXmlElement(withScope(child));
    }
    detail.xmlDetail = xmlDetail;
    // An empty <detail/> needs no submessage; decoding always emits one.
    if (
      xmlDetail ||
      Object.values(detail).some((value) => value && typeof value === 'object')
    )
      message.detail = detail;
  }
  return { takControl: null, cotEvent: message };
}

/** Serialize a CoT event as a TAK Protocol v1 payload (no header). */
export function cotEventToTakPayload(event) {
  return encodeTakMessage(cotEventToTakMessage(event));
}

// ---------------------------------------------------------------------------
// Streaming connection negotiation (t-x-takp-v / -q / -r)
// ---------------------------------------------------------------------------

export const TAK_PROTOCOL_CONTROL_TYPES = Object.freeze({
  support: 't-x-takp-v',
  request: 't-x-takp-q',
  response: 't-x-takp-r',
});
/** The client waits at least one minute for the server's response. */
export const TAK_NEGOTIATION_TIMEOUT_MS = 60_000;

const CONTROL_KINDS = new Map(
  Object.entries(TAK_PROTOCOL_CONTROL_TYPES).map(([kind, type]) => [
    type,
    kind,
  ]),
);
const CONTROL_START = /^<event\b[^>]*?\stype\s*=\s*(["'])t-x-takp-[vqr]\1/;

/** Cheap pre-filter: whether a framed XML event may be negotiation control. */
export function mayBeTakProtocolControl(xml) {
  return CONTROL_START.test(xml);
}

/**
 * Read a negotiation control event. Returns null for any other event and
 * throws CotValidationError for invalid CoT. Its UID names the negotiation
 * transaction only; it is never an application identity.
 * @param {string|import('./cot.js').CotEvent} input
 * @returns {null|{kind:'support'|'request'|'response', uid:string, versions:number[], status:?boolean}}
 */
export function readTakProtocolControl(input) {
  const event = typeof input === 'string' ? parseCotEvent(input) : input;
  const kind = CONTROL_KINDS.get(event?.type);
  if (!kind) return null;
  const control = event.detail.extras.find(
    (element) => element.name === 'TakControl',
  );
  const versions = [];
  const responses = [];
  for (const child of control?.children || []) {
    if (
      (kind === 'support' && child.name === 'TakProtocolSupport') ||
      (kind === 'request' && child.name === 'TakRequest')
    ) {
      if (/^[1-9]\d{0,8}$/.test(child.attrs.version ?? ''))
        versions.push(Number(child.attrs.version));
    } else if (kind === 'response' && child.name === 'TakResponse')
      responses.push(child.attrs.status);
  }
  // Exactly one TakResponse is allowed; anything else is not an answer.
  const status =
    kind === 'response' && responses.length === 1
      ? responses[0] === 'true'
        ? true
        : responses[0] === 'false'
          ? false
          : null
      : null;
  return { kind, uid: event.uid, versions, status };
}

/** The client's request to switch a streaming connection to `version`. */
export function buildTakProtocolRequest({
  uid,
  version = TAK_PROTOCOL_VERSION,
  nowMs = Date.now(),
}) {
  const time = new Date(nowMs).toISOString();
  return serializeXmlElement({
    name: 'event',
    attrs: {
      version: '2.0',
      uid,
      type: TAK_PROTOCOL_CONTROL_TYPES.request,
      time,
      start: time,
      stale: new Date(nowMs + TAK_NEGOTIATION_TIMEOUT_MS).toISOString(),
      how: 'm-g',
    },
    children: [
      {
        name: 'point',
        attrs: {
          lat: '0.0',
          lon: '0.0',
          hae: '0.0',
          ce: '999999',
          le: '999999',
        },
        children: [],
      },
      {
        name: 'detail',
        attrs: {},
        children: [
          {
            name: 'TakControl',
            attrs: {},
            children: [
              {
                name: 'TakRequest',
                attrs: { version: String(version) },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  });
}

const CLOSE_TAG = Uint8Array.from('</event', (char) => char.charCodeAt(0));
const isAsciiSpace = (byte) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

/** Index just past the first complete `</event>` end tag, or -1. */
function closingTagEnd(bytes) {
  for (
    let at = bytes.indexOf(0x3c);
    at >= 0;
    at = bytes.indexOf(0x3c, at + 1)
  ) {
    let i = 0;
    while (i < CLOSE_TAG.length && bytes[at + i] === CLOSE_TAG[i]) i++;
    if (i < CLOSE_TAG.length) continue;
    let end = at + CLOSE_TAG.length;
    while (end < bytes.length && isAsciiSpace(bytes[end])) end++;
    if (end >= bytes.length) return -1;
    if (bytes[end] === 0x3e) return end + 1;
  }
  return -1;
}

/**
 * Read one TAK Server streaming connection: CoT XML until a negotiation is
 * accepted, then TAK protocol stream frames. While a request is outstanding
 * (hold()), bytes are released only up to complete `</event>` end tags, so
 * an accepting response and the first binary frame may share a TCP chunk.
 * Call acceptProtobuf() or release() from the onXml callback for the response.
 * @param {object} options
 * @param {(xml:string)=>void} options.onXml
 * @param {(payload:Uint8Array)=>void} options.onPayload
 * @param {(reason:string, count:number)=>void} [options.onDiscard]
 * @param {(error:TakProtoError)=>void} [options.onError] Drop the connection.
 */
export function createTakStreamReader({
  onXml,
  onPayload,
  onDiscard,
  onError = () => {},
  maxEventBytes = MAX_COT_EVENT_BYTES,
  maxPayloadBytes = MAX_TAK_PROTO_PAYLOAD_BYTES,
}) {
  const empty = new Uint8Array(0);
  let mode = 'xml'; // xml | held | protobuf | failed
  let decoder = new TextDecoder('utf-8');
  let held = empty;
  let draining = false;
  let skipSpace = false;
  const xmlFramer = createCotStreamFramer({
    onEvent: onXml,
    onDiscard,
    maxEventBytes,
  });
  const protoFramer = createTakStreamFramer({
    onPayload,
    onError: fail,
    maxPayloadBytes,
  });

  function fail(error) {
    mode = 'failed';
    held = empty;
    onError(error);
  }
  function feedXml(bytes) {
    const text = decoder.decode(bytes, { stream: true });
    if (text) xmlFramer.push(text);
  }
  function feedProtobuf(bytes) {
    let at = 0;
    // Tolerate whitespace a server may leave after its accepting response.
    if (skipSpace) while (at < bytes.length && isAsciiSpace(bytes[at])) at++;
    if (at >= bytes.length) return;
    skipSpace = false;
    protoFramer.push(bytes.subarray(at));
  }
  function drain() {
    draining = true;
    try {
      while (mode === 'held') {
        const end = closingTagEnd(held);
        if (end < 0) {
          if (held.length > 2 * maxEventBytes)
            fail(
              new TakProtoError(
                'Negotiation stream exceeds the size limit',
                'oversized',
              ),
            );
          return;
        }
        const piece = held.subarray(0, end);
        held = held.subarray(end);
        feedXml(piece);
      }
      const rest = held;
      held = empty;
      if (mode === 'protobuf') feedProtobuf(rest);
      else if (mode === 'xml') feedXml(rest);
    } finally {
      draining = false;
    }
  }
  return Object.freeze({
    /** Append raw connection bytes (strings are UTF-8 encoded first). */
    push(chunk) {
      if (!chunk?.length || mode === 'failed') return;
      const bytes =
        typeof chunk === 'string' ? utf8Encoder.encode(chunk) : asBytes(chunk);
      if (mode === 'protobuf') return feedProtobuf(bytes);
      if (mode === 'xml') return feedXml(bytes);
      held = held.length ? concat([held, bytes]) : bytes.slice();
      if (!draining) drain();
    },
    /** A request was sent: stop at event boundaries until it is answered. */
    hold() {
      if (mode === 'xml') mode = 'held';
    },
    /** The response accepted the request: later bytes are stream frames. */
    acceptProtobuf() {
      if (mode !== 'held') return;
      mode = 'protobuf';
      skipSpace = true;
      if (!draining) drain();
    },
    /** The request was denied: continue reading XML. */
    release() {
      if (mode !== 'held') return;
      mode = 'xml';
      if (!draining) drain();
    },
    reset() {
      mode = 'xml';
      held = empty;
      skipSpace = false;
      decoder = new TextDecoder('utf-8');
      xmlFramer.reset();
      protoFramer.reset();
    },
    get mode() {
      return mode;
    },
  });
}
