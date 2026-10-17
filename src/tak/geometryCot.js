// Independent CoT emission using the repository's existing XML/identity tools.
import {
  normalizeIdentity,
  randomUuid,
  buildMarker,
  buildDelete,
} from './protocol/builders.js';
import {
  serializeCotEvent,
  parseCotEvent,
  byteLength,
  MAX_COT_EVENT_BYTES,
} from './protocol/cot.js';
import {
  GeometryValidationError,
  GEOMETRY_TYPES,
  validateGeometry,
} from './geometry.js';

export const GEOMETRY_STALE_MS = 24 * 60 * 60 * 1000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function fail(message) {
  throw new GeometryValidationError(message);
}
function identityPrefix(identity) {
  const id = normalizeIdentity(identity);
  if (!id.uid.startsWith('GEV-') || !UUID.test(id.uid.slice(4)))
    fail('Geometry needs a GEV device identity');
  return `GEV-MARKER-${id.uid.slice(4)}-`;
}
export function ownsGeometryUid(identity, uid) {
  const prefix = identityPrefix(identity);
  return (
    typeof uid === 'string' &&
    uid.startsWith(prefix) &&
    UUID.test(uid.slice(prefix.length))
  );
}
export function ownsGeometryWaypointUid(geometryUid, uid) {
  const prefix = `${geometryUid}-WP-`;
  return (
    typeof uid === 'string' &&
    uid.startsWith(prefix) &&
    UUID.test(uid.slice(prefix.length))
  );
}
function element(name, attrs) {
  return Object.freeze({
    name,
    attrs: Object.freeze(attrs),
    children: Object.freeze([]),
    text: '',
  });
}
function authorText(value, label, max) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(`Invalid ${label}`);
  return value.trim();
}
function optionsTimes({
  nowMs = Date.now(),
  staleMs = GEOMETRY_STALE_MS,
  expectedRevision,
} = {}) {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > 8.64e15 - GEOMETRY_STALE_MS ||
    !Number.isSafeInteger(staleMs) ||
    staleMs <= 0 ||
    staleMs > GEOMETRY_STALE_MS
  )
    fail('Geometry times or stale duration are invalid');
  if (
    expectedRevision !== undefined &&
    (!Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      nowMs <= expectedRevision)
  )
    fail('Geometry update must have a newer revision than the expected event');
  return { nowMs, staleMs };
}
function anchor(geometry) {
  const first = geometry.vertices[0];
  const firstPosition = { lat: first.lat, lon: first.lon, hae: first.hae };
  if (geometry.kind === 'route') return firstPosition;
  let x = 0,
    y = 0,
    z = 0;
  for (const vertex of geometry.vertices) {
    const lat = (vertex.lat * Math.PI) / 180,
      lon = (vertex.lon * Math.PI) / 180;
    x += Math.cos(lat) * Math.cos(lon);
    y += Math.cos(lat) * Math.sin(lon);
    z += Math.sin(lat);
  }
  // A long open path can have cancelling vectors. Its real vertices remain the
  // geometry; use the first point only for that event's separate label anchor.
  if (Math.hypot(x, y, z) < 1e-10) return firstPosition;
  return {
    lat: (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
    lon: (Math.atan2(y, x) * 180) / Math.PI,
    hae:
      geometry.altitudeMode === 'absolute'
        ? geometry.vertices.reduce((sum, point) => sum + point.hae, 0) /
          geometry.vertices.length
        : null,
  };
}

/** Build a new feature, or an own-UID full replacement with stable waypoint IDs. */
export function buildGeometry(identity, input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    fail('Provide a complete drawing or route');
  const id = normalizeIdentity(identity),
    prefix = identityPrefix(id),
    times = optionsTimes(options);
  const copied = !input?.uid;
  const uid = copied ? `${prefix}${randomUuid()}` : input.uid;
  if (!ownsGeometryUid(id, uid))
    fail('Geometry UID is not owned by this identity');
  const callsign = authorText(input.callsign, 'drawing/route name', 64);
  if (
    input.remarks !== undefined &&
    input.remarks !== null &&
    (typeof input.remarks !== 'string' ||
      input.remarks.length > 256 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.remarks))
  )
    fail(
      'Geometry remarks exceed 256 characters or contain control characters',
    );
  const draft = validateGeometry(input, { authoring: true });
  const vertices = draft.vertices.map((point, index) => {
    if (draft.kind !== 'route') {
      if (point.uid || point.type || point.callsign || point.remarks)
        fail('Authored drawing vertices do not carry route waypoint metadata');
      return point;
    }
    const waypointUid =
      copied || !point.uid ? `${uid}-WP-${randomUuid()}` : point.uid;
    if (!ownsGeometryWaypointUid(uid, waypointUid))
      fail('Waypoint UID is not owned by this geometry');
    return {
      ...point,
      uid: waypointUid,
      type: point.type ?? 'b-m-p-w',
      relation: 'c',
      callsign: point.callsign ?? `${draft.route.prefix}${index + 1}`,
    };
  });
  const geometry = validateGeometry({ ...draft, vertices });
  const details = geometry.vertices.map((point) =>
    element('link', {
      point: `${point.lat},${point.lon}${point.hae === null ? '' : `,${point.hae}`}`,
      ...(point.uid
        ? {
            uid: point.uid,
            type: point.type,
            relation: 'c',
            callsign: point.callsign ?? '',
            remarks: point.remarks ?? '',
          }
        : {}),
    }),
  );
  if (geometry.closed) details.push(details[0]);
  if (geometry.route) {
    const route = geometry.route;
    details.push(
      element('link_attr', {
        color: String(geometry.style.strokeColor),
        stroke: String(Math.trunc(geometry.style.strokeWidth)),
        type: route.transportationType,
        method: route.method,
        direction: route.direction,
        routetype: route.routeType,
        order: route.order,
        planningmethod: route.planningMethod,
        prefix: route.prefix,
      }),
    );
  }
  details.push(
    element('strokeColor', { value: String(geometry.style.strokeColor) }),
    element('strokeWeight', { value: String(geometry.style.strokeWidth) }),
    element('strokeStyle', { value: geometry.style.strokeStyle }),
  );
  if (geometry.closed)
    details.push(
      element('fillColor', { value: String(geometry.style.fillColor) }),
    );
  details.push(element('archive', {}));
  const base = buildMarker(
    id,
    { uid, callsign, ...anchor(geometry), remarks: input.remarks || undefined },
    times,
  );
  const event = Object.freeze({
    ...base,
    type:
      geometry.kind === 'route' ? GEOMETRY_TYPES.route : GEOMETRY_TYPES.shape,
    how: 'h-e',
    detail: Object.freeze({
      ...base.detail,
      argb: null,
      iconsetpath: null,
      extras: Object.freeze(details),
    }),
  });
  const xml = serializeCotEvent(event);
  if (byteLength(xml) > MAX_COT_EVENT_BYTES)
    fail('Geometry CoT exceeds the 64 KiB event limit');
  // The canonical parsed result has the same bounded raw tree as a peer event.
  return parseCotEvent(xml);
}

/** Deletes keep the existing t-x-d-d contract; authorization is identity-bound. */
export function buildGeometryDelete(
  identity,
  targetUid,
  targetType,
  options = {},
) {
  if (!ownsGeometryUid(identity, targetUid))
    fail('Geometry UID is not owned by this identity');
  if (![GEOMETRY_TYPES.shape, GEOMETRY_TYPES.route].includes(targetType))
    fail('Unsupported geometry delete target type');
  return buildDelete(
    identity,
    targetUid,
    targetType,
    optionsTimes({ ...options, staleMs: options.staleMs ?? 20000 }),
  );
}
