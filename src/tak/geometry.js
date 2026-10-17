// Original portable geometry model; no DOM, Cesium, network or native TAK code.
export const GEOMETRY_LIMITS = Object.freeze({
  vertices: 256,
  detailChildren: 1024,
  minHae: -12_000,
  maxHae: 1_000_000,
  strokeWidth: 32,
  waypointName: 64,
  waypointRemarks: 256,
});
export const GEOMETRY_TYPES = Object.freeze({ shape: 'u-d-f', route: 'b-m-r' });
export const ROUTE_METHODS = Object.freeze([
  'Driving',
  'Walking',
  'Flying',
  'Swimming',
  'Watercraft',
]);
export const ROUTE_DIRECTIONS = Object.freeze(['Infil', 'Exfil']);
export const ROUTE_TYPES = Object.freeze(['Primary', 'Secondary']);
export const ROUTE_ORDERS = Object.freeze([
  'Ascending Check Points',
  'Descending Check Points',
]);
export const GEOMETRY_STROKE_STYLES = Object.freeze([
  'solid',
  'dashed',
  'dotted',
  'outlined',
]);
const UID = /^[A-Za-z0-9_.:/+-]{1,256}$/;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ANGLE_EPSILON = 1e-10;
const toRadians = (value) => (value * Math.PI) / 180;

export class GeometryValidationError extends Error {
  constructor(message, status = 'invalid') {
    super(message);
    this.name = 'GeometryValidationError';
    this.status = status;
  }
}
function invalid(message) {
  throw new GeometryValidationError(message);
}
function unsupported(message) {
  throw new GeometryValidationError(message, 'unsupported');
}
function number(value, label, min, max) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    invalid(`${label} must be a finite number between ${min} and ${max}`);
  return Object.is(value, -0) ? 0 : value;
}
function decimal(value, label, min, max) {
  if (typeof value !== 'string' || !DECIMAL.test(value.trim()))
    invalid(`Invalid ${label}`);
  return number(Number(value.trim()), label, min, max);
}
function optionalText(value, label, limit) {
  if (value === undefined || value === null || value === '') return null;
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    invalid(`${label} exceeds its text limit or contains control characters`);
  return value.trim() || null;
}
function uid(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UID.test(value))
    invalid('Invalid waypoint UID');
  return value;
}
export function signedGeometryColor(value) {
  if (!Number.isInteger(value)) invalid('ARGB color must be an integer');
  return number(value, 'ARGB color', -2147483648, 4294967295) | 0;
}
function color(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) invalid('ARGB color must be an integer');
  return signedGeometryColor(value);
}
export function geometryColorRgba(argb) {
  const value = color(argb, -1) >>> 0;
  return Object.freeze({
    red: ((value >>> 16) & 255) / 255,
    green: ((value >>> 8) & 255) / 255,
    blue: (value & 255) / 255,
    alpha: (value >>> 24) / 255,
  });
}
function enumValue(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!allowed.includes(value)) unsupported(`Unsupported ${label}`);
  return value;
}
function routeMetadata(input = {}) {
  return Object.freeze({
    method: enumValue(input.method, ROUTE_METHODS, 'Driving', 'route method'),
    direction: enumValue(
      input.direction,
      ROUTE_DIRECTIONS,
      'Infil',
      'route direction',
    ),
    routeType: enumValue(input.routeType, ROUTE_TYPES, 'Primary', 'route type'),
    order: enumValue(input.order, ROUTE_ORDERS, ROUTE_ORDERS[0], 'route order'),
    transportationType:
      optionalText(input.transportationType, 'Transportation type', 64) ??
      'Ground',
    planningMethod:
      optionalText(input.planningMethod, 'Planning method', 64) ?? 'Infil',
    prefix: optionalText(input.prefix, 'Waypoint prefix', 16) ?? 'CP',
  });
}
function vertex(input, draftRoute = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    invalid('A vertex must have numeric lat/lon fields');
  const lat = number(input.lat, 'Latitude', -90, 90),
    lon = number(input.lon, 'Longitude', -180, 180);
  const hae =
    input.hae === undefined || input.hae === null || input.hae === 9999999
      ? null
      : number(
          input.hae,
          'HAE metres',
          GEOMETRY_LIMITS.minHae,
          GEOMETRY_LIMITS.maxHae,
        );
  const identifier = uid(input.uid);
  const type = input.type ?? null;
  const relation = input.relation ?? (identifier && draftRoute ? 'c' : null);
  const callsign = optionalText(
    input.callsign,
    'Waypoint name',
    GEOMETRY_LIMITS.waypointName,
  );
  const remarks = optionalText(
    input.remarks,
    'Waypoint remarks',
    GEOMETRY_LIMITS.waypointRemarks,
  );
  if (identifier) {
    if (!['b-m-p-w', 'b-m-p-c'].includes(type) || relation !== 'c')
      unsupported(
        'Only constituent waypoint/control-point links are supported',
      );
  } else if (type || relation || callsign || remarks) {
    if (
      !draftRoute ||
      (type && !['b-m-p-w', 'b-m-p-c'].includes(type)) ||
      (relation && relation !== 'c')
    )
      invalid(
        'Waypoint metadata requires a UID, type and constituent relation',
      );
  }
  return Object.freeze({
    lat,
    lon,
    hae,
    uid: identifier,
    type,
    relation,
    callsign,
    remarks,
  });
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const length = (a) => Math.hypot(...a);
const angle = (a, b) => Math.atan2(length(cross(a, b)), dot(a, b));
const unit = ({ lat, lon }) => {
  const latitude = toRadians(lat),
    longitude = toRadians(lon),
    cos = Math.cos(latitude);
  return [
    cos * Math.cos(longitude),
    cos * Math.sin(longitude),
    Math.sin(latitude),
  ];
};
const samePosition = (a, b) => angle(unit(a), unit(b)) < ANGLE_EPSILON;
const sameVertex = (a, b) => samePosition(a, b) && a.hae === b.hae;
const wrap = (value) => ((((value + 180) % 360) + 360) % 360) - 180;

/** Shortest-edge unwrapping; never draws a 358-degree edge through Greenwich. */
export function unwrapGeometryLongitudes(vertices) {
  if (!Array.isArray(vertices) || !vertices.length) return Object.freeze([]);
  if (vertices.length > GEOMETRY_LIMITS.vertices + 1)
    invalid('Geometry exceeds 256 vertices');
  for (const point of vertices) {
    number(point?.lat, 'Latitude', -90, 90);
    number(point?.lon, 'Longitude', -180, 180);
  }
  const result = [vertices[0].lon];
  for (let i = 1; i < vertices.length; i++) {
    const delta = wrap(vertices[i].lon - vertices[i - 1].lon);
    if (Math.abs(Math.abs(delta) - 180) < 1e-10)
      unsupported(
        'Exactly half-world longitude edges need an intermediate vertex',
      );
    result.push(result.at(-1) + delta);
  }
  return Object.freeze(result);
}
export function geometryBounds(vertices) {
  const longitudes = unwrapGeometryLongitudes(vertices);
  if (!longitudes.length) invalid('Geometry needs vertices');
  const westUnwrapped = Math.min(...longitudes),
    eastUnwrapped = Math.max(...longitudes);
  const longitudeSpan = eastUnwrapped - westUnwrapped;
  const west = longitudeSpan >= 360 ? -180 : wrap(westUnwrapped);
  const east = longitudeSpan >= 360 ? 180 : wrap(eastUnwrapped);
  return Object.freeze({
    west,
    east,
    south: Math.min(...vertices.map((p) => p.lat)),
    north: Math.max(...vertices.map((p) => p.lat)),
    crossesAntimeridian: longitudeSpan < 360 && west > east,
    longitudeSpan,
  });
}
function onArc(a, b, p) {
  return Math.abs(angle(a, p) + angle(p, b) - angle(a, b)) < 1e-9;
}
function arcsIntersect(a, b, c, d) {
  const n1 = cross(a, b),
    n2 = cross(c, d),
    intersection = cross(n1, n2),
    magnitude = length(intersection);
  if (magnitude < 1e-14)
    return onArc(a, b, c) || onArc(a, b, d) || onArc(c, d, a) || onArc(c, d, b);
  const p = intersection.map((value) => value / magnitude),
    opposite = p.map((value) => -value);
  return (
    (onArc(a, b, p) && onArc(c, d, p)) ||
    (onArc(a, b, opposite) && onArc(c, d, opposite))
  );
}
function validateEdges(points, closed) {
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const radians = angle(points[i], points[(i + 1) % points.length]);
    if (radians < ANGLE_EPSILON)
      invalid('Consecutive vertices must be distinct');
    if (radians > Math.PI - 1e-9)
      unsupported('Antipodal edges need an intermediate vertex');
  }
}
function validatePolygon(vertices, points, bounds) {
  if (vertices.some((point) => Math.abs(point.lat) > 89.999))
    unsupported(
      'Pole-touching polygons are outside this regional geometry subset',
    );
  if (bounds.longitudeSpan >= 180)
    unsupported(
      'Polygons spanning half the world require a smaller regional ring',
    );
  const closureDelta = wrap(vertices[0].lon - vertices.at(-1).lon);
  const unwrapped = unwrapGeometryLongitudes(vertices);
  if (Math.abs(unwrapped.at(-1) + closureDelta - unwrapped[0]) > 1e-8)
    unsupported('Polygons winding around a pole are unsupported');
  let area = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[0], points[i], points[i + 1]];
    area +=
      2 *
      Math.atan2(dot(a, cross(b, c)), 1 + dot(a, b) + dot(b, c) + dot(c, a));
  }
  if (Math.abs(area) < 1e-14) invalid('Polygon area is degenerate');
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i + points.length - 1) % points.length],
      current = points[i],
      next = points[(i + 1) % points.length];
    if (onArc(previous, current, next) || onArc(current, next, previous))
      invalid('Adjacent polygon edges overlap');
  }
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (angle(points[i], points[j]) < ANGLE_EPSILON)
        invalid('Polygon contains repeated vertices');
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (
        arcsIntersect(
          points[i],
          points[(i + 1) % points.length],
          points[j],
          points[(j + 1) % points.length],
        )
      )
        invalid('Polygon edges self-intersect or touch');
    }
  }
}

/** Strict complete geometry validation. Unknown HAE is never converted to zero. */
export function validateGeometry(input, { authoring = false } = {}) {
  if (!input || !['polyline', 'polygon', 'route'].includes(input.kind))
    invalid('Choose polyline, polygon or route geometry');
  if (
    !Array.isArray(input.vertices) ||
    input.vertices.length >
      GEOMETRY_LIMITS.vertices + (input.kind === 'polygon' ? 1 : 0)
  )
    invalid('Geometry exceeds 256 vertices');
  const vertices = input.vertices.map((point) =>
    vertex(point, authoring && input.kind === 'route'),
  );
  if (
    input.kind === 'polygon' &&
    vertices.length > 1 &&
    samePosition(vertices[0], vertices.at(-1))
  ) {
    if (!sameVertex(vertices[0], vertices.at(-1)))
      invalid('Polygon closing altitude disagrees with its first vertex');
    vertices.pop();
  }
  if (
    vertices.length < (input.kind === 'polygon' ? 3 : 2) ||
    vertices.length > GEOMETRY_LIMITS.vertices
  )
    invalid(
      'Geometry needs at least two line/route or three polygon vertices, at most 256',
    );
  if (input.kind === 'polyline' && samePosition(vertices[0], vertices.at(-1)))
    invalid('A closed u-d-f ring must be a polygon');
  const known = vertices.filter((point) => point.hae !== null).length;
  if (known && known !== vertices.length)
    unsupported(
      'Mixed known/unknown HAE geometry is unsupported; original CoT is retained',
    );
  const waypointUids = vertices.map((point) => point.uid).filter(Boolean);
  if (new Set(waypointUids).size !== waypointUids.length)
    invalid('Waypoint UIDs must be unique');
  const points = vertices.map(unit),
    closed = input.kind === 'polygon',
    bounds = geometryBounds(vertices);
  validateEdges(points, closed);
  if (closed) validatePolygon(vertices, points, bounds);
  const style = input.style ?? {};
  if (typeof style !== 'object' || Array.isArray(style))
    invalid('Geometry style must be an object');
  if (
    input.kind === 'route' &&
    input.route != null &&
    (typeof input.route !== 'object' || Array.isArray(input.route))
  )
    invalid('Route metadata must be an object');
  const fillColor = color(style.fillColor, closed ? 0x33ffffff : 0x00ffffff);
  if (!closed && fillColor >>> 24)
    invalid('Open geometry cannot have a polygon fill');
  const result = {
    kind: input.kind,
    vertices: Object.freeze(vertices),
    closed,
    altitudeMode: known ? 'absolute' : 'ground',
    style: Object.freeze({
      strokeColor: color(style.strokeColor, -1),
      fillColor,
      strokeWidth:
        style.strokeWidth === undefined
          ? 3
          : number(
              style.strokeWidth,
              'Stroke width',
              0.5,
              GEOMETRY_LIMITS.strokeWidth,
            ),
      strokeStyle: enumValue(
        style.strokeStyle,
        GEOMETRY_STROKE_STYLES,
        'solid',
        'stroke style',
      ),
    }),
    route: input.kind === 'route' ? routeMetadata(input.route) : null,
    bounds,
  };
  return Object.freeze(result);
}

export function isGeometryType(type) {
  return type === GEOMETRY_TYPES.shape || type === GEOMETRY_TYPES.route;
}
function elementNumber(node, key, label, min, max) {
  return decimal(node.attrs?.[key], label, min, max);
}
function field(children, name) {
  const matches = children.filter((child) => child.name === name);
  if (matches.length > 1) invalid(`Duplicate geometry ${name}`);
  const node = matches[0];
  if (
    node &&
    (node.namespaces?.xmlns || node.children?.length || node.text?.trim())
  )
    unsupported(`Unsupported namespaced or nested ${name}`);
  return node;
}
function linkVertex(node) {
  if (node.namespaces?.xmlns || node.children?.length || node.text?.trim())
    unsupported('Unsupported namespaced or nested geometry link');
  const parts = node.attrs.point.split(',');
  if (![2, 3].includes(parts.length))
    invalid('Vertex point must be lat,lon or lat,lon,HAE');
  const point = {
    lat: decimal(parts[0], 'vertex latitude', -90, 90),
    lon: decimal(parts[1], 'vertex longitude', -180, 180),
    hae: null,
  };
  if (parts.length === 3) {
    const altitude = decimal(
      parts[2],
      'vertex HAE',
      GEOMETRY_LIMITS.minHae,
      9999999,
    );
    point.hae =
      altitude === 9999999
        ? null
        : number(
            altitude,
            'Vertex HAE metres',
            GEOMETRY_LIMITS.minHae,
            GEOMETRY_LIMITS.maxHae,
          );
  }
  return {
    ...point,
    uid: node.attrs.uid,
    type: node.attrs.type,
    relation: node.attrs.relation,
    callsign: node.attrs.callsign,
    remarks: node.attrs.remarks,
  };
}

/** Peer parse results are explicit: unsupported XML remains in the original event. */
export function parseTakGeometry(event) {
  const type = event?.type;
  if (!isGeometryType(type))
    return Object.freeze({
      status: /^(?:u-d-|b-m-r)/.test(type ?? '')
        ? 'unsupported'
        : 'not-geometry',
      ...(/^(?:u-d-|b-m-r)/.test(type ?? '')
        ? { reason: 'Unsupported TAK geometry type' }
        : {}),
    });
  try {
    const children = event.detail?.raw?.children ?? event.detail?.extras ?? [];
    if (
      !Array.isArray(children) ||
      children.length > GEOMETRY_LIMITS.detailChildren
    )
      invalid('Geometry detail exceeds its child limit');
    const links = children.filter(
      (child) =>
        child.name === 'link' && Object.hasOwn(child.attrs ?? {}, 'point'),
    );
    if (
      links.length >
      GEOMETRY_LIMITS.vertices + (type === GEOMETRY_TYPES.shape ? 1 : 0)
    )
      invalid('Geometry exceeds 256 vertices');
    const vertices = links.map(linkVertex);
    let kind = type === GEOMETRY_TYPES.route ? 'route' : 'polyline';
    if (
      kind === 'polyline' &&
      vertices.length > 1 &&
      samePosition(vertices[0], vertices.at(-1))
    )
      kind = 'polygon';
    const route = field(children, 'link_attr');
    if (route && kind !== 'route')
      unsupported('Route attributes on non-route geometry');
    const stroke = field(children, 'strokeColor'),
      weight = field(children, 'strokeWeight'),
      fill = field(children, 'fillColor'),
      lineStyle = field(children, 'strokeStyle');
    const routeColor =
      route?.attrs.color === undefined
        ? undefined
        : elementNumber(route, 'color', 'Route color', -2147483648, 4294967295);
    const routeWidth =
      route?.attrs.stroke === undefined
        ? undefined
        : elementNumber(
            route,
            'stroke',
            'Route stroke',
            0,
            GEOMETRY_LIMITS.strokeWidth,
          );
    if (routeWidth !== undefined && !Number.isInteger(routeWidth))
      invalid('Legacy route stroke must be an integer');
    const strokeColor = stroke
      ? elementNumber(stroke, 'value', 'Stroke color', -2147483648, 4294967295)
      : routeColor;
    const strokeWidth = weight
      ? elementNumber(
          weight,
          'value',
          'Stroke width',
          0.5,
          GEOMETRY_LIMITS.strokeWidth,
        )
      : routeWidth;
    if (
      (routeColor !== undefined &&
        strokeColor !== undefined &&
        signedGeometryColor(routeColor) !== signedGeometryColor(strokeColor)) ||
      (routeWidth !== undefined &&
        strokeWidth !== undefined &&
        routeWidth !== Math.trunc(strokeWidth))
    )
      invalid('Conflicting route and drawing styles');
    const geometry = validateGeometry({
      kind,
      vertices,
      style: {
        strokeColor,
        strokeWidth,
        fillColor: fill
          ? elementNumber(fill, 'value', 'Fill color', -2147483648, 4294967295)
          : 0x00ffffff,
        strokeStyle: lineStyle?.attrs.value,
      },
      route: route
        ? {
            method: route.attrs.method,
            direction: route.attrs.direction,
            routeType: route.attrs.routetype,
            order: route.attrs.order,
            transportationType: route.attrs.type,
            planningMethod: route.attrs.planningmethod,
            prefix: route.attrs.prefix,
          }
        : undefined,
    });
    return Object.freeze({ status: 'ok', geometry });
  } catch (error) {
    return Object.freeze({
      status:
        error instanceof GeometryValidationError ? error.status : 'invalid',
      reason:
        error instanceof GeometryValidationError
          ? error.message
          : 'Malformed geometry detail',
    });
  }
}
