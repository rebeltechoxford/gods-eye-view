// Builders for the CoT events this client originates. Each returns a frozen
// CotEvent (see cot.js) ready for serializeCotEvent(). Portable module.

import {
  COT_VERSION,
  COT_UNKNOWN,
  CotValidationError,
  cotNumber,
} from './cot.js';

/** ATAK team colours, in ATAK's own order. */
export const TAK_TEAMS = Object.freeze([
  'White',
  'Yellow',
  'Orange',
  'Magenta',
  'Red',
  'Maroon',
  'Purple',
  'Dark Blue',
  'Blue',
  'Cyan',
  'Teal',
  'Green',
  'Dark Green',
  'Brown',
]);

/** ATAK team roles. */
export const TAK_ROLES = Object.freeze([
  'Team Member',
  'Team Lead',
  'HQ',
  'Sniper',
  'Medic',
  'Forward Observer',
  'RTO',
  'K9',
]);

/** CSS colours approximating the ATAK team palette (for UI swatches). */
export const TAK_TEAM_COLORS = Object.freeze({
  White: '#ffffff',
  Yellow: '#ffff00',
  Orange: '#ff8000',
  Magenta: '#ff00ff',
  Red: '#ff0000',
  Maroon: '#800000',
  Purple: '#800080',
  'Dark Blue': '#000080',
  Blue: '#0000ff',
  Cyan: '#00ffff',
  Teal: '#008080',
  Green: '#00ff00',
  'Dark Green': '#008000',
  Brown: '#a52a2a',
});

export const ALL_CHAT_ROOMS = 'All Chat Rooms';
export const CLIENT_PLATFORM = "God's Eye View TAK";
export const CLIENT_VERSION = '0.3.0';

/** Default SA stale window: ATAK uses ~2x its report interval. */
export const DEFAULT_SA_STALE_MS = 2 * 60 * 1000;
export const DEFAULT_MARKER_STALE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CHAT_STALE_MS = 24 * 60 * 60 * 1000;

function requireText(value, label, max = 120) {
  const out = String(value ?? '').trim();
  if (!out) throw new CotValidationError(`${label} is required`);
  if (out.length > max)
    throw new CotValidationError(`${label} exceeds ${max} characters`);
  if (/[\u0000-\u001f\u007f]/.test(out))
    throw new CotValidationError(`${label} contains control characters`);
  return out;
}

function requirePoint({ lat, lon, hae = null, ce = null, le = null }) {
  const la = cotNumber(lat, -90, 90);
  const lo = cotNumber(lon, -180, 180);
  if (la === null)
    throw new CotValidationError('Latitude must be between -90 and 90');
  if (lo === null)
    throw new CotValidationError('Longitude must be between -180 and 180');
  const opt = (v, min, max) => {
    const parsed = cotNumber(v, min, max);
    return parsed === COT_UNKNOWN ? null : parsed;
  };
  return Object.freeze({
    lat: la,
    lon: lo,
    hae: opt(hae, -12_000, 1_000_000_000),
    ce: opt(ce, 0, COT_UNKNOWN),
    le: opt(le, 0, COT_UNKNOWN),
  });
}

function emptyDetail(overrides = {}) {
  return Object.freeze({
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
    ...overrides,
  });
}

function event({ uid, type, how, nowMs, staleMs, point, detail }) {
  return Object.freeze({
    version: COT_VERSION,
    uid,
    type,
    how,
    access: null,
    qos: null,
    opex: null,
    timeMs: nowMs,
    startMs: nowMs,
    staleMs: nowMs + staleMs,
    point,
    detail,
  });
}

/** Random RFC 4122 v4 uuid using whatever crypto the runtime has. */
export function randomUuid() {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * @typedef {object} TakIdentity
 * @property {string} uid Stable device uid (e.g. "GEV-<uuid>").
 * @property {string} callsign
 * @property {string} team One of TAK_TEAMS.
 * @property {string} role One of TAK_ROLES.
 * @property {string} [type] Self CoT type; default a-f-G-U-C.
 * @property {string} [endpoint] contact endpoint; default "*:-1:stcp".
 */

/** Validate and normalise an identity; unknown team/role fall back to defaults. */
export function normalizeIdentity(input = {}) {
  const uid = requireText(input.uid, 'Device uid', 256);
  const callsign = requireText(input.callsign, 'Callsign', 40);
  return Object.freeze({
    uid,
    callsign,
    team: TAK_TEAMS.includes(input.team) ? input.team : 'Cyan',
    role: TAK_ROLES.includes(input.role) ? input.role : 'Team Member',
    type: /^a-[fa]-[A-Z](?:-[A-Za-z0-9]+)*$/.test(input.type || '')
      ? input.type
      : 'a-f-G-U-C',
    endpoint: String(input.endpoint || '*:-1:stcp').slice(0, 120),
  });
}

export function createIdentity({ callsign, team, role } = {}) {
  return normalizeIdentity({
    uid: `GEV-${randomUuid()}`,
    callsign: callsign || `GEV-${Math.floor(Math.random() * 9000 + 1000)}`,
    team,
    role,
  });
}

/**
 * Self situational-awareness (position) report, the ATAK "PPLI".
 * @param {TakIdentity} identity
 * @param {{lat:number, lon:number, hae?:number, ce?:number, le?:number,
 *   course?:number, speed?:number, battery?:number, source?:string}} fix
 */
export function buildSelfSa(
  identity,
  fix,
  { nowMs = Date.now(), staleMs = DEFAULT_SA_STALE_MS } = {},
) {
  const id = normalizeIdentity(identity);
  const point = requirePoint(fix);
  const source = fix.source === 'GPS' ? 'GPS' : 'USER';
  return event({
    uid: id.uid,
    type: id.type,
    how: source === 'GPS' ? 'm-g' : 'h-e',
    nowMs,
    staleMs,
    point,
    detail: emptyDetail({
      callsign: id.callsign,
      endpoint: id.endpoint,
      droid: id.callsign,
      group: Object.freeze({ name: id.team, role: id.role }),
      takv: Object.freeze({
        device: 'Browser',
        platform: CLIENT_PLATFORM,
        os: 'web',
        version: CLIENT_VERSION,
      }),
      precision: Object.freeze({
        geopointsrc: source,
        altsrc: point.hae === null ? '???' : source,
      }),
      status: Number.isFinite(fix.battery)
        ? Object.freeze({
            battery: Math.max(0, Math.min(100, fix.battery)),
            readiness: null,
          })
        : null,
      track:
        Number.isFinite(fix.course) || Number.isFinite(fix.speed)
          ? Object.freeze({
              course: Number.isFinite(fix.course) ? fix.course : null,
              speed: Number.isFinite(fix.speed) ? fix.speed : null,
            })
          : null,
    }),
  });
}

/**
 * A map point ("spot map" marker), linked to its creator like ATAK does.
 * @param {TakIdentity} identity creator
 * @param {{uid?:string, callsign:string, lat:number, lon:number, hae?:number,
 *   type?:string, remarks?:string, argb?:number}} marker
 */
export function buildMarker(
  identity,
  marker,
  { nowMs = Date.now(), staleMs = DEFAULT_MARKER_STALE_MS } = {},
) {
  const id = normalizeIdentity(identity);
  const callsign = requireText(marker.callsign, 'Marker label');
  const type = /^(?:b-m-p|a-[a-z]-[A-Z])(?:-[A-Za-z0-9.]+)*$/.test(
    marker.type || '',
  )
    ? marker.type
    : 'b-m-p-s-m';
  return event({
    uid: marker.uid
      ? requireText(marker.uid, 'Marker uid', 256)
      : `GEV-MARKER-${id.uid.replace(/^GEV-/, '')}-${randomUuid()}`,
    type,
    how: 'h-g-i-g-o',
    nowMs,
    staleMs,
    point: requirePoint(marker),
    detail: emptyDetail({
      callsign,
      links: [
        Object.freeze({
          uid: id.uid,
          type: id.type,
          relation: 'p-p',
          parentCallsign: id.callsign,
          productionTimeMs: nowMs,
        }),
      ],
      remarks: marker.remarks
        ? Object.freeze({
            text: String(marker.remarks).slice(0, 4096),
            source: null,
            to: null,
            timeMs: null,
          })
        : null,
      argb: Number.isFinite(marker.argb) ? marker.argb : -1,
      iconsetpath:
        type === 'b-m-p-s-m' ? 'COT_MAPPING_SPOTMAP/b-m-p-s-m/-1' : null,
    }),
  });
}

/**
 * GeoChat message in ATAK's wire layout. `chatroom` is "All Chat Rooms" for
 * broadcast, or a contact uid / group name for directed chat.
 * @param {TakIdentity} identity sender
 * @param {{message:string, chatroom?:string, chatroomId?:string, point?:object}} chat
 */
export function buildChat(
  identity,
  chat,
  {
    nowMs = Date.now(),
    staleMs = DEFAULT_CHAT_STALE_MS,
    messageId = randomUuid(),
  } = {},
) {
  const id = normalizeIdentity(identity);
  const message = requireText(chat.message, 'Message', 4096);
  const chatroom = String(chat.chatroom || ALL_CHAT_ROOMS).slice(0, 120);
  const chatroomId = String(chat.chatroomId || chatroom).slice(0, 256);
  const point = chat.point
    ? requirePoint(chat.point)
    : Object.freeze({ lat: 0, lon: 0, hae: null, ce: null, le: null });
  return event({
    uid: `GeoChat.${id.uid}.${chatroomId}.${messageId}`,
    type: 'b-t-f',
    how: 'h-g-i-g-o',
    nowMs,
    staleMs,
    point,
    detail: emptyDetail({
      chat: Object.freeze({
        parent: 'RootContactGroup',
        groupOwner: false,
        messageId,
        chatroom,
        id: chatroomId,
        senderCallsign: id.callsign,
        participants: [id.uid, chatroomId],
      }),
      links: [
        Object.freeze({
          uid: id.uid,
          type: id.type,
          relation: 'p-p',
          parentCallsign: null,
          productionTimeMs: null,
        }),
      ],
      remarks: Object.freeze({
        text: message,
        source: `BAO.F.ATAK.${id.uid}`,
        to: chatroomId,
        timeMs: nowMs,
      }),
    }),
  });
}

/** t-x-d-d: ask peers to remove `targetUid` (e.g. a marker we created). */
export function buildDelete(
  identity,
  targetUid,
  targetType = 'b-m-p-s-m',
  { nowMs = Date.now(), staleMs = 20_000 } = {},
) {
  normalizeIdentity(identity); // only identified nodes may originate deletes
  const target = requireText(targetUid, 'Target uid', 256);
  return event({
    uid: randomUuid(),
    type: 't-x-d-d',
    how: 'h-g-i-g-o',
    nowMs,
    staleMs,
    point: Object.freeze({ lat: 0, lon: 0, hae: null, ce: null, le: null }),
    detail: emptyDetail({
      links: [
        Object.freeze({
          uid: target,
          type: targetType,
          relation: 'none',
          parentCallsign: null,
          productionTimeMs: null,
        }),
      ],
      extras: [{ name: '__forcedelete', attrs: {}, children: [], text: '' }],
    }),
  });
}

/** t-x-c-t keep-alive ping (TAK Server answers with t-x-c-t-r). */
export function buildPing(
  identity,
  { nowMs = Date.now(), staleMs = 20_000 } = {},
) {
  const id = normalizeIdentity(identity);
  return event({
    uid: `${id.uid}-ping`,
    type: 't-x-c-t',
    how: 'h-g-i-g-o',
    nowMs,
    staleMs,
    point: Object.freeze({ lat: 0, lon: 0, hae: null, ce: null, le: null }),
    detail: emptyDetail(),
  });
}

/** Emergency (911 / ring the bell / cancel) for the identity's position. */
export function buildEmergency(
  identity,
  fix,
  {
    kind = '911 Alert',
    cancel = false,
    nowMs = Date.now(),
    staleMs = 60_000,
  } = {},
) {
  const id = normalizeIdentity(identity);
  const type = cancel
    ? 'b-a-o-can'
    : kind === 'Ring The Bell'
      ? 'b-a-o-pan'
      : kind === 'In Contact'
        ? 'b-a-o-opn'
        : 'b-a-o-tbl';
  return event({
    uid: `${id.uid}-9-1-1`,
    type,
    how: 'h-e',
    nowMs,
    staleMs,
    point: requirePoint(fix),
    detail: emptyDetail({
      links: [
        Object.freeze({
          uid: id.uid,
          type: id.type,
          relation: 'p-p',
          parentCallsign: null,
          productionTimeMs: null,
        }),
      ],
      callsign: `${id.callsign}-Alert`,
      emergency: Object.freeze({ type: kind, cancel, text: id.callsign }),
    }),
  });
}
