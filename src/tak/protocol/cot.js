// Cursor on Target (CoT) event model: parse, validate, serialise.
//
// Independent MIT implementation written against the public CoT event schema
// and observed ATAK/WinTAK interchange. No ATAK-CIV source is incorporated.
// Portable: no DOM, no Cesium, no Node APIs. Shared by browser and gateway.

import {
  CotXmlError,
  descendantElements,
  parseXmlFragment,
  serializeXmlElement,
} from './xml.js';

export const COT_VERSION = '2.0';
export const MAX_COT_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_COT_EVENT_BYTES = 64 * 1024;
export const MAX_COT_EVENTS = 1000;
/** CoT sentinel for "unknown" height/error values. */
export const COT_UNKNOWN = 9999999;

const UID_PATTERN = /^[^\u0000-\u001f\u007f<>&"]{1,256}$/;
const TYPE_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9.]+){0,15}$/;
const HOW_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9.]+){0,7}$/;

/** Detail children this module understands; everything else is preserved. */
const KNOWN_DETAIL = new Set([
  'contact',
  '__group',
  'track',
  'status',
  'takv',
  'precisionlocation',
  'remarks',
  'link',
  '__chat',
  'emergency',
  'uid',
  'color',
  'usericon',
]);

// Core CoT names are unprefixed. A plugin's x:contact is an extension, not
// an authoritative identity or ownership field merely sharing a local name.
function childElements(parent, name) {
  return parent?.children.filter((child) => child.name === name) || [];
}
function childElement(parent, name) {
  return childElements(parent, name)[0] || null;
}

export class CotValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CotValidationError';
  }
}

// ---------------------------------------------------------------------------
// Type taxonomy
// ---------------------------------------------------------------------------

const AFFILIATION_CODES = Object.freeze({
  p: 'pending',
  u: 'unknown',
  a: 'assumed-friend',
  f: 'friend',
  n: 'neutral',
  s: 'suspect',
  h: 'hostile',
  j: 'joker',
  k: 'faker',
  o: 'none',
});

const DIMENSION_CODES = Object.freeze({
  P: 'space',
  A: 'air',
  G: 'ground',
  S: 'surface',
  U: 'subsurface',
  F: 'sof',
  X: 'other',
});

/** Display bucket used for colour/shape: the four classic frame families. */
export function cotAffiliation(type) {
  const atoms = String(type ?? '').split('-');
  if (atoms[0] !== 'a') return 'marker';
  switch (atoms[1]) {
    case 'f':
    case 'a':
      return 'friendly';
    case 'h':
    case 's':
    case 'j':
    case 'k':
      return 'hostile';
    case 'n':
      return 'neutral';
    default:
      return 'unknown';
  }
}

/**
 * Break a CoT type into its taxonomy.
 * @param {string} type e.g. "a-f-G-U-C"
 */
export function describeCotType(type) {
  const text = String(type ?? '');
  const atoms = text.split('-');
  const isAtom = atoms[0] === 'a';
  return Object.freeze({
    type: text,
    kind: cotKind(text),
    affiliation: cotAffiliation(text),
    affiliationDetail: isAtom ? AFFILIATION_CODES[atoms[1]] || 'unknown' : null,
    dimension: isAtom ? DIMENSION_CODES[atoms[2]] || null : null,
    functionId: isAtom ? atoms.slice(3).join('-') : '',
  });
}

/**
 * Coarse routing class:
 * - 'sa'      atoms (a-*): a thing that exists at a place
 * - 'chat'    b-t-f GeoChat message (b-t-f-d/r receipts included)
 * - 'marker'  b-m-p-* map points
 * - 'alert'   b-a-* emergency / alarm
 * - 'delete'  t-x-d-d tasking: remove the linked uid
 * - 'ping'    t-x-c-t (ping) / t-x-c-t-r (pong)
 * - 'drawing' u-d-* shapes and routes
 * - 'other'
 */
export function cotKind(type) {
  const text = String(type ?? '');
  if (text.startsWith('a-')) return 'sa';
  if (text === 'b-t-f' || text.startsWith('b-t-f-')) return 'chat';
  if (text.startsWith('b-m-p')) return 'marker';
  if (text.startsWith('b-a-')) return 'alert';
  if (text === 't-x-d-d') return 'delete';
  if (text === 't-x-c-t' || text === 't-x-c-t-r') return 'ping';
  if (text.startsWith('u-d-') || text.startsWith('b-m-r')) return 'drawing';
  return 'other';
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function text(value, max = 256) {
  if (value === undefined || value === null) return '';
  // Drop C0 controls except tab/newline; keep everything printable.
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function optionalText(value, max) {
  const out = text(value, max);
  return out || null;
}

export function cotNumber(value, min, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (
    typeof value === 'string' &&
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
  )
    return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

const number = cotNumber;

/** Height/error with the CoT 9999999 "unknown" sentinel mapped to null. */
function measure(value, min, max) {
  const parsed = number(value, min, max);
  if (parsed === null || parsed === COT_UNKNOWN) return null;
  return parsed;
}

/** Parse an ISO-8601 timestamp; CoT requires UTC but tolerate offsets. */
export function parseCotTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    raw,
  );
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = '0'] = parts.map(
    (part, index) => (index ? Number(part) : part),
  );
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(
      raw,
    )
  )
    return null;
  // Trim sub-millisecond digits Date.parse may reject.
  const normalized = raw.replace(/(\.\d{3})\d+/, '$1');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

export function formatCotTime(ms) {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * @typedef {object} CotPoint
 * @property {number} lat
 * @property {number} lon
 * @property {?number} hae Height above ellipsoid, metres (null = unknown).
 * @property {?number} ce Circular error, metres (null = unknown).
 * @property {?number} le Linear error, metres (null = unknown).
 */

/**
 * @typedef {object} CotEvent
 * @property {string} version
 * @property {string} uid
 * @property {string} type
 * @property {string} how
 * @property {?string} access
 * @property {?string} qos
 * @property {?string} opex
 * @property {number} timeMs
 * @property {number} startMs
 * @property {number} staleMs
 * @property {?CotPoint} point Null when the point is absent/invalid (non-geographic events).
 * @property {CotDetail} detail
 */

/**
 * @typedef {object} CotDetail
 * @property {?string} callsign
 * @property {?string} endpoint
 * @property {?string} phone
 * @property {?{name:?string, role:?string}} group
 * @property {?{course:?number, speed:?number}} track
 * @property {?{battery:?number, readiness:?string}} status
 * @property {?{device:?string, platform:?string, os:?string, version:?string}} takv
 * @property {?{geopointsrc:?string, altsrc:?string}} precision
 * @property {?{text:string, source:?string, to:?string, timeMs:?number}} remarks
 * @property {{uid:string, type:?string, relation:?string, parentCallsign:?string, productionTimeMs:?number}[]} links
 * @property {?CotChat} chat
 * @property {?{type:?string, cancel:boolean, text:string}} emergency
 * @property {?string} droid
 * @property {?number} argb Point colour as signed ARGB int.
 * @property {?string} iconsetpath
 * @property {object[]} extras Unrecognised detail elements, preserved for relay.
 */

/**
 * @typedef {object} CotChat
 * @property {?string} chatroom
 * @property {?string} id
 * @property {?string} parent
 * @property {?string} senderCallsign
 * @property {?string} messageId
 * @property {boolean} groupOwner
 * @property {string[]} participants uid0..uidN from chatgrp
 */

function parseDetail(detailEl) {
  /** @type {CotDetail} */
  const detail = {
    callsign: null,
    endpoint: null,
    phone: null,
    group: null,
    track: null,
    status: null,
    takv: null,
    precision: null,
    remarks: null,
    links: [],
    chat: null,
    emergency: null,
    droid: null,
    argb: null,
    iconsetpath: null,
    extras: [],
  };
  if (!detailEl) return detail;
  for (const name of KNOWN_DETAIL) {
    if (name !== 'link' && childElements(detailEl, name).length > 1)
      throw new CotValidationError(`Duplicate CoT detail ${name}`);
  }
  // Preserve bounded extension trees when relaying, including unfamiliar
  // attributes of known elements. Display fields are normalized separately.
  Object.defineProperty(detail, 'raw', { value: detailEl });

  const contact = childElement(detailEl, 'contact');
  if (contact) {
    detail.callsign = optionalText(contact.attrs.callsign, 120);
    detail.endpoint = optionalText(contact.attrs.endpoint, 120);
    detail.phone = optionalText(contact.attrs.phone, 40);
  }
  const group = childElement(detailEl, '__group');
  if (group) {
    detail.group = {
      name: optionalText(group.attrs.name, 40),
      role: optionalText(group.attrs.role, 40),
    };
  }
  const track = childElement(detailEl, 'track');
  if (track) {
    detail.track = {
      course: number(track.attrs.course, -360, 360),
      speed: number(track.attrs.speed, 0, 10_000),
    };
  }
  const status = childElement(detailEl, 'status');
  if (status) {
    detail.status = {
      battery: number(status.attrs.battery, 0, 100),
      readiness: optionalText(status.attrs.readiness, 16),
    };
  }
  const takv = childElement(detailEl, 'takv');
  if (takv) {
    detail.takv = {
      device: optionalText(takv.attrs.device, 80),
      platform: optionalText(takv.attrs.platform, 80),
      os: optionalText(takv.attrs.os, 40),
      version: optionalText(takv.attrs.version, 80),
    };
  }
  const precision = childElement(detailEl, 'precisionlocation');
  if (precision) {
    detail.precision = {
      geopointsrc: optionalText(precision.attrs.geopointsrc, 32),
      altsrc: optionalText(precision.attrs.altsrc, 32),
    };
  }
  const remarks = childElement(detailEl, 'remarks');
  if (remarks) {
    detail.remarks = {
      text: text(remarks.text, 4096),
      source: optionalText(remarks.attrs.source, 160),
      to: optionalText(remarks.attrs.to, 160),
      timeMs: parseCotTime(remarks.attrs.time),
    };
  }
  for (const link of childElements(detailEl, 'link').slice(0, 32)) {
    const uid = text(link.attrs.uid, 256);
    if (!uid) continue;
    detail.links.push({
      uid,
      type: optionalText(link.attrs.type, 64),
      relation: optionalText(link.attrs.relation, 16),
      parentCallsign: optionalText(link.attrs.parent_callsign, 120),
      productionTimeMs: parseCotTime(link.attrs.production_time),
    });
  }
  const chat = childElement(detailEl, '__chat');
  if (chat) {
    const chatgrp = childElement(chat, 'chatgrp');
    const participants = [];
    if (chatgrp) {
      for (let index = 0; index < 64; index++) {
        const uid = chatgrp.attrs[`uid${index}`];
        if (uid === undefined) break;
        const value = text(uid, 256);
        if (value) participants.push(value);
      }
    }
    detail.chat = {
      chatroom: optionalText(chat.attrs.chatroom, 120),
      id: optionalText(chat.attrs.id, 256),
      parent: optionalText(chat.attrs.parent, 120),
      senderCallsign: optionalText(chat.attrs.senderCallsign, 120),
      messageId: optionalText(chat.attrs.messageId, 128),
      groupOwner: chat.attrs.groupOwner === 'true',
      participants,
    };
  }
  const emergency = childElement(detailEl, 'emergency');
  if (emergency) {
    detail.emergency = {
      type: optionalText(emergency.attrs.type, 40),
      cancel: emergency.attrs.cancel === 'true',
      text: text(emergency.text, 256),
    };
  }
  const uidEl = childElement(detailEl, 'uid');
  if (uidEl) detail.droid = optionalText(uidEl.attrs.Droid, 120);
  const color = childElement(detailEl, 'color');
  if (color) detail.argb = number(color.attrs.argb, -(2 ** 31), 2 ** 32 - 1);
  const icon = childElement(detailEl, 'usericon');
  if (icon) detail.iconsetpath = optionalText(icon.attrs.iconsetpath, 256);

  for (const child of detailEl.children) {
    if (!KNOWN_DETAIL.has(child.name) && detail.extras.length < 32)
      detail.extras.push(child);
  }
  return detail;
}

/**
 * Validate one parsed <event> element into a frozen CotEvent.
 * Throws CotValidationError with a human-readable reason when unusable.
 * @param {import('./xml.js').XmlElement} element
 * @returns {CotEvent}
 */
export function cotEventFromElement(element) {
  if (!element || element.name !== 'event')
    throw new CotValidationError('Not a CoT <event> element');
  const a = element.attrs;
  if (
    childElements(element, 'point').length > 1 ||
    childElements(element, 'detail').length > 1
  )
    throw new CotValidationError('Duplicate CoT point or detail');
  const uid = String(a.uid ?? '').trim();
  if (!UID_PATTERN.test(uid))
    throw new CotValidationError('CoT event uid is missing or invalid');
  const type = String(a.type ?? '').trim();
  if (!TYPE_PATTERN.test(type))
    throw new CotValidationError(`CoT event ${uid} has an invalid type`);
  const how = String(a.how ?? '').trim() || 'h-g-i-g-o';
  if (!HOW_PATTERN.test(how))
    throw new CotValidationError(`CoT event ${uid} has an invalid how`);
  const timeMs = parseCotTime(a.time);
  if (timeMs === null)
    throw new CotValidationError(`CoT event ${uid} has no valid time`);
  const startMs = parseCotTime(a.start) ?? timeMs;
  const staleMs = parseCotTime(a.stale);
  if (staleMs === null)
    throw new CotValidationError(`CoT event ${uid} has no valid stale time`);
  if (staleMs < timeMs || startMs > staleMs)
    throw new CotValidationError(`CoT event ${uid} has invalid time ordering`);

  const pointEl = childElement(element, 'point');
  let point = null;
  if (pointEl) {
    const lat = number(pointEl.attrs.lat, -90, 90);
    const lon = number(pointEl.attrs.lon, -180, 180);
    if (lat !== null && lon !== null) {
      point = Object.freeze({
        lat,
        lon,
        hae: measure(pointEl.attrs.hae, -12_000, 1_000_000_000),
        ce: measure(pointEl.attrs.ce, 0, 1e9),
        le: measure(pointEl.attrs.le, 0, 1e9),
      });
    }
  }
  const kind = cotKind(type);
  // A position report or map point without a usable location is meaningless.
  if (!point && (kind === 'sa' || kind === 'marker'))
    throw new CotValidationError(`CoT event ${uid} has no valid point`);

  const detail = parseDetail(childElement(element, 'detail'));
  return Object.freeze({
    namespaces: element.namespaces,
    version: text(a.version, 8) || COT_VERSION,
    uid,
    type,
    how,
    access: optionalText(a.access, 64),
    qos: optionalText(a.qos, 16),
    opex: optionalText(a.opex, 16),
    timeMs,
    startMs,
    staleMs,
    point,
    detail: Object.freeze(detail),
  });
}

/**
 * Parse a CoT document: a single <event>, a wrapper holding several events, or
 * a concatenation of events (as seen on a TCP stream). Individual invalid
 * events are reported in `rejected` rather than failing the whole document.
 * @param {string} xml
 * @param {{maxEvents?:number, maxBytes?:number}} [options]
 * @returns {{events: CotEvent[], rejected: {uid:?string, reason:string}[]}}
 */
export function parseCotDocument(xml, options = {}) {
  const maxEvents = options.maxEvents ?? MAX_COT_EVENTS;
  const maxBytes = options.maxBytes ?? MAX_COT_DOCUMENT_BYTES;
  if (typeof xml !== 'string' || !xml.trim())
    throw new CotValidationError('Provide a CoT XML document.');
  if (byteLength(xml) > maxBytes)
    throw new CotValidationError(
      `CoT document exceeds the ${formatBytes(maxBytes)} limit.`,
    );
  let roots;
  try {
    roots = parseXmlFragment(xml);
  } catch (error) {
    if (error instanceof CotXmlError)
      throw new CotValidationError(`Malformed CoT XML: ${error.message}`);
    throw error;
  }
  const elements = descendantElements(roots, 'event');
  if (!elements.length) throw new CotValidationError('No CoT events found.');
  if (elements.length > maxEvents)
    throw new CotValidationError(
      `CoT document contains too many events (${elements.length} > ${maxEvents}).`,
    );
  const events = [];
  const rejected = [];
  for (const element of elements) {
    try {
      events.push(cotEventFromElement(element));
    } catch (error) {
      if (!(error instanceof CotValidationError)) throw error;
      rejected.push({
        uid: optionalText(element.attrs.uid, 256),
        reason: error.message,
      });
    }
  }
  return { events, rejected };
}

/** Parse exactly one event; throws when the input is not one valid event. */
export function parseCotEvent(xml) {
  const { events, rejected } = parseCotDocument(xml, {
    maxEvents: 1,
    maxBytes: MAX_COT_EVENT_BYTES,
  });
  if (!events.length) throw new CotValidationError(rejected[0].reason);
  return events[0];
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

function el(name, attrs = {}, children = [], textValue = '') {
  return { name, attrs, children, text: textValue };
}

function fmtNumber(value, fallback = COT_UNKNOWN) {
  return Number.isFinite(value) ? String(value) : String(fallback);
}

function namespaceAttributes(scope) {
  const attrs = Object.create(null);
  // Parsed namespaces use a shared prototype chain to avoid copying every
  // ancestor binding onto every XML node. Flatten only the emitted root.
  for (const key in scope) attrs[key] = scope[key];
  return attrs;
}

function detailElements(detail = {}) {
  const out = [];
  if (detail.takv) {
    out.push(
      el('takv', {
        device: detail.takv.device,
        platform: detail.takv.platform,
        os: detail.takv.os,
        version: detail.takv.version,
      }),
    );
  }
  if (detail.callsign || detail.endpoint || detail.phone) {
    out.push(
      el('contact', {
        callsign: detail.callsign,
        endpoint: detail.endpoint,
        phone: detail.phone,
      }),
    );
  }
  if (detail.droid) out.push(el('uid', { Droid: detail.droid }));
  if (detail.precision) {
    out.push(
      el('precisionlocation', {
        geopointsrc: detail.precision.geopointsrc,
        altsrc: detail.precision.altsrc,
      }),
    );
  }
  if (detail.group) {
    out.push(
      el('__group', { name: detail.group.name, role: detail.group.role }),
    );
  }
  if (detail.status) {
    out.push(
      el('status', {
        battery: Number.isFinite(detail.status.battery)
          ? String(Math.round(detail.status.battery))
          : undefined,
        readiness: detail.status.readiness,
      }),
    );
  }
  if (detail.track) {
    out.push(
      el('track', {
        course: Number.isFinite(detail.track.course)
          ? String(detail.track.course)
          : undefined,
        speed: Number.isFinite(detail.track.speed)
          ? String(detail.track.speed)
          : undefined,
      }),
    );
  }
  if (detail.chat) {
    const c = detail.chat;
    const chatgrpAttrs = { id: c.id };
    (c.participants || []).forEach((uid, index) => {
      chatgrpAttrs[`uid${index}`] = uid;
    });
    out.push(
      el(
        '__chat',
        {
          parent: c.parent,
          groupOwner: c.groupOwner ? 'true' : 'false',
          messageId: c.messageId,
          chatroom: c.chatroom,
          id: c.id,
          senderCallsign: c.senderCallsign,
        },
        [el('chatgrp', chatgrpAttrs)],
      ),
    );
  }
  for (const link of detail.links || []) {
    out.push(
      el('link', {
        uid: link.uid,
        type: link.type,
        relation: link.relation,
        parent_callsign: link.parentCallsign,
        production_time: Number.isFinite(link.productionTimeMs)
          ? formatCotTime(link.productionTimeMs)
          : undefined,
      }),
    );
  }
  if (detail.emergency) {
    out.push(
      el(
        'emergency',
        {
          type: detail.emergency.type,
          cancel: detail.emergency.cancel ? 'true' : undefined,
        },
        [],
        detail.emergency.text || '',
      ),
    );
  }
  if (Number.isFinite(detail.argb))
    out.push(el('color', { argb: String(detail.argb) }));
  if (detail.iconsetpath)
    out.push(el('usericon', { iconsetpath: detail.iconsetpath }));
  if (detail.remarks) {
    out.push(
      el(
        'remarks',
        {
          source: detail.remarks.source,
          to: detail.remarks.to,
          time: Number.isFinite(detail.remarks.timeMs)
            ? formatCotTime(detail.remarks.timeMs)
            : undefined,
        },
        [],
        detail.remarks.text || '',
      ),
    );
  }
  for (const extra of detail.extras || []) out.push(extra);
  return out;
}

/**
 * Serialise an event (as produced by parse or the builders) to CoT XML.
 * Output never includes an XML declaration so it can be streamed directly.
 * @param {CotEvent} event
 * @returns {string}
 */
export function serializeCotEvent(event) {
  if (!event || !UID_PATTERN.test(String(event.uid ?? '')))
    throw new CotValidationError('Cannot serialise CoT without a valid uid');
  if (!TYPE_PATTERN.test(String(event.type ?? '')))
    throw new CotValidationError('Cannot serialise CoT without a valid type');
  for (const key of ['timeMs', 'startMs', 'staleMs']) {
    if (!Number.isFinite(event[key]))
      throw new CotValidationError(`Cannot serialise CoT without ${key}`);
  }
  const point = event.point || {
    lat: 0,
    lon: 0,
    hae: null,
    ce: null,
    le: null,
  };
  const root = el(
    'event',
    {
      ...namespaceAttributes(event.namespaces),
      version: event.version || COT_VERSION,
      uid: event.uid,
      type: event.type,
      how: event.how || 'h-g-i-g-o',
      time: formatCotTime(event.timeMs),
      start: formatCotTime(event.startMs),
      stale: formatCotTime(event.staleMs),
      access: event.access || undefined,
      qos: event.qos || undefined,
      opex: event.opex || undefined,
    },
    [
      el('point', {
        lat: String(point.lat),
        lon: String(point.lon),
        hae: fmtNumber(point.hae),
        ce: fmtNumber(point.ce),
        le: fmtNumber(point.le),
      }),
      event.detail?.raw || el('detail', {}, detailElements(event.detail)),
    ],
  );
  return serializeXmlElement(root);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

export function byteLength(value) {
  if (encoder) return encoder.encode(value).byteLength;
  // Fallback: UTF-16 length is a lower bound; multiply for a safe upper bound.
  return value.length * 3;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0)
    return `${bytes / (1024 * 1024)} MiB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

/** True when the event's stale time has passed. */
export function isCotStale(event, nowMs = Date.now()) {
  return Number.isFinite(event?.staleMs) && event.staleMs <= nowMs;
}

/** Display name: callsign, else the uid. */
export function cotDisplayName(event) {
  return event?.detail?.callsign || event?.uid || '';
}

/** The uid a t-x-d-d delete event targets (first link uid), or null. */
export function cotDeleteTarget(event) {
  if (event?.type !== 't-x-d-d') return null;
  return event.detail?.links?.[0]?.uid || null;
}
