import * as mgrsModule from 'mgrs';
import { Cartographic, Ellipsoid, EllipsoidGeodesic } from 'cesium';

// Node resolves this package's CommonJS main; Vite resolves its named-only ESM
// module. Reflect avoids requesting a nonexistent static default ESM export.
const mgrs = Reflect.get(mgrsModule, 'default') ?? mgrsModule;

export const COORDINATE_FORMATS = Object.freeze(['DD', 'DMS', 'MGRS', 'UTM']);
const RAD = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257223563;
const E = Math.sqrt(F * (2 - F));
const N = F / (2 - F);
const SCALE = 0.9996;
const B = (A / (1 + N)) * (1 + N ** 2 / 4 + N ** 4 / 64);
// Fourth-order Kruger series; independent arithmetic implementation of the
// published Transverse Mercator equations, restricted to UTM's zone domain.
const ALPHA = [
  N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180,
  (13 * N ** 2) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440,
  (61 * N ** 3) / 240 - (103 * N ** 4) / 140,
  (49561 * N ** 4) / 161280,
];
const BETA = [
  N / 2 - (2 * N ** 2) / 3 + (37 * N ** 3) / 96 - N ** 4 / 360,
  N ** 2 / 48 + N ** 3 / 15 - (437 * N ** 4) / 1440,
  (17 * N ** 3) / 480 - (37 * N ** 4) / 840,
  (4397 * N ** 4) / 161280,
];
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
const NUMBER = '[+-]?(?:\\d{1,3}(?:\\.\\d+)?|\\.\\d+)';
const DD = new RegExp(`^(${NUMBER})(?:\\s*,\\s*|\\s+)(${NUMBER})$`);
const DMS_AXIS =
  '(\\d{1,3})(?:\\s*°\\s*|\\s+)(\\d{1,2})(?:\\s*[\u0027′]\\s*|\\s+)(\\d{1,2}(?:\\.\\d+)?)(?:\\s*["″])?\\s*';
const DMS = new RegExp(
  `^${DMS_AXIS}([NS])\\s*[,;]?\\s*${DMS_AXIS}([EW])$`,
  'i',
);
const GRID_DOMAIN =
  'UTM/MGRS supports 80°S to 84°N; polar UPS is not implemented.';

export function validateWaypoint(point) {
  if (
    !point ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    Math.abs(point.lat) > 90 ||
    Math.abs(point.lon) > 180
  )
    throw new TypeError('Enter WGS84 latitude −90…90 and longitude −180…180.');
  return { lat: point.lat, lon: point.lon };
}

function gridPoint(point) {
  const result = validateWaypoint(point);
  if (result.lat < -80 || result.lat > 84) throw new RangeError(GRID_DOMAIN);
  return result;
}

export function utmZone({ lat, lon }) {
  gridPoint({ lat, lon });
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
  if (lat >= 72 && lat <= 84 && lon >= 0 && lon < 42) {
    if (lon < 9) return 31;
    if (lon < 21) return 33;
    if (lon < 33) return 35;
    return 37;
  }
  return Math.min(60, Math.floor((lon + 180) / 6) + 1);
}

export function toUtm(point, { zone = utmZone(point) } = {}) {
  const { lat, lon } = gridPoint(point);
  if (!Number.isInteger(zone) || zone < 1 || zone > 60)
    throw new RangeError('UTM zone must be 1…60.');
  const delta = ((lon - (zone * 6 - 183) + 540) % 360) - 180;
  if (Math.abs(delta) > 9)
    throw new RangeError('Point is outside this UTM zone projection.');
  const phi = lat * RAD;
  const q = Math.asinh(Math.tan(phi)) - E * Math.atanh(E * Math.sin(phi));
  const chi = Math.atan(Math.sinh(q));
  const eta0 = Math.atanh(Math.cos(chi) * Math.sin(delta * RAD));
  const xi0 = Math.atan2(Math.tan(chi), Math.cos(delta * RAD));
  let xi = xi0,
    eta = eta0;
  for (let i = 0; i < ALPHA.length; i++) {
    const j = 2 * (i + 1);
    xi += ALPHA[i] * Math.sin(j * xi0) * Math.cosh(j * eta0);
    eta += ALPHA[i] * Math.cos(j * xi0) * Math.sinh(j * eta0);
  }
  return {
    zone,
    hemisphere: lat < 0 ? 'S' : 'N',
    easting: 500000 + SCALE * B * eta,
    northing: (lat < 0 ? 10000000 : 0) + SCALE * B * xi,
  };
}

export function fromUtm({ zone, hemisphere, easting, northing }) {
  if (
    !Number.isInteger(zone) ||
    zone < 1 ||
    zone > 60 ||
    !['N', 'S'].includes(hemisphere) ||
    !Number.isFinite(easting) ||
    easting < 100000 ||
    easting > 900000 ||
    !Number.isFinite(northing) ||
    northing < 0 ||
    northing > 10000000
  )
    throw new TypeError(
      'Use zone 1…60, hemisphere N/S, easting 100000…900000 m and northing 0…10000000 m.',
    );
  const xi = (northing - (hemisphere === 'S' ? 10000000 : 0)) / (SCALE * B);
  const eta = (easting - 500000) / (SCALE * B);
  let xi0 = xi,
    eta0 = eta;
  for (let i = 0; i < BETA.length; i++) {
    const j = 2 * (i + 1);
    xi0 -= BETA[i] * Math.sin(j * xi) * Math.cosh(j * eta);
    eta0 -= BETA[i] * Math.cos(j * xi) * Math.sinh(j * eta);
  }
  const chi = Math.atan2(
    Math.sin(xi0),
    Math.hypot(Math.sinh(eta0), Math.cos(xi0)),
  );
  const q0 = Math.asinh(Math.tan(chi));
  let q = q0;
  for (let i = 0; i < 12; i++) {
    const next = q0 + E * Math.atanh(E * Math.tanh(q));
    if (Math.abs(next - q) < 1e-14) {
      q = next;
      break;
    }
    q = next;
  }
  const lat = Math.atan(Math.sinh(q)) / RAD;
  const lon = zone * 6 - 183 + Math.atan2(Math.sinh(eta0), Math.cos(xi0)) / RAD;
  if (Math.abs(lon - (zone * 6 - 183)) > 9 + 1e-8)
    throw new RangeError('Point is outside this UTM zone projection.');
  if (
    lat < -80 - 1e-8 ||
    lat > 84 + 1e-8 ||
    (hemisphere === 'N' && lat < -1e-8) ||
    (hemisphere === 'S' && lat > 1e-8)
  )
    throw new RangeError(GRID_DOMAIN);
  return validateWaypoint({
    lat: Math.min(84, Math.max(-80, lat)),
    lon: lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon,
  });
}

function parseMgrs(text) {
  const value = text.toUpperCase().replace(/\s+/g, '');
  const match =
    /^([1-9]|[1-5]\d|60)([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d{0,10})$/.exec(
      value,
    );
  if (!match || match[5].length % 2)
    throw new TypeError(
      'Use a full MGRS zone, band, square and an even number of digits (0…10).',
    );
  const zone = Number(match[1]);
  const band = match[2];
  if (
    !['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'][(zone - 1) % 3].includes(match[3]) ||
    (band === 'X' && [32, 34, 36].includes(zone))
  )
    throw new TypeError('MGRS square or zone is invalid for this grid zone.');
  const index = BANDS.indexOf(band);
  const south = -80 + index * 8;
  const north = band === 'X' ? 84 : south + 8;
  let west = zone * 6 - 186,
    east = west + 6;
  if (band === 'V' && zone === 31) east = 3;
  if (band === 'V' && zone === 32) west = 3;
  if (band === 'X' && [31, 33, 35, 37].includes(zone)) {
    west = { 31: 0, 33: 9, 35: 21, 37: 33 }[zone];
    east = { 31: 9, 33: 21, 35: 33, 37: 42 }[zone];
  }
  // mgrs 2.1.0 returns a zero-area SW point for references without digits.
  // Its SW/NE 10km edge cells give the complete enclosing 100km square.
  const bbox = match[5].length
    ? mgrs.inverse(value)
    : [
        ...mgrs.inverse(value + '00').slice(0, 2),
        ...mgrs.inverse(value + '99').slice(2),
      ];
  const clipped = [
    Math.max(west, bbox[0]),
    Math.max(south, bbox[1]),
    Math.min(east, bbox[2]),
    Math.min(north, bbox[3]),
  ];
  if (
    !clipped.every(Number.isFinite) ||
    clipped[0] >= clipped[2] ||
    clipped[1] >= clipped[3]
  )
    throw new TypeError(
      'MGRS cell does not intersect its declared zone and latitude band.',
    );
  // A grid reference denotes an area. Use its centre, clipped at zone/band
  // boundaries; fewer digits never imply metre-level location accuracy.
  return {
    ...validateWaypoint({
      lon: (clipped[0] + clipped[2]) / 2,
      lat: (clipped[1] + clipped[3]) / 2,
    }),
    cellSizeM: 10 ** (5 - match[5].length / 2),
  };
}

export function parseCoordinate(text, format = 'DD') {
  if (typeof text !== 'string' || !text.trim() || text.length > 160)
    throw new TypeError('Enter one coordinate, up to 160 characters.');
  const value = text.trim();
  if (format === 'MGRS') return parseMgrs(value);
  if (format === 'DD') {
    const match = DD.exec(value);
    if (!match)
      throw new TypeError(
        'Use latitude, longitude in decimal degrees, e.g. 38.88927, -77.05020.',
      );
    return validateWaypoint({ lat: Number(match[1]), lon: Number(match[2]) });
  }
  if (format === 'DMS') {
    const match = DMS.exec(value);
    if (!match)
      throw new TypeError(
        'Use degrees minutes seconds with N/S then E/W, e.g. 38°53\'21.37"N 77°03\'00.72"W.',
      );
    const axis = (offset, negative) => {
      const d = Number(match[offset]),
        m = Number(match[offset + 1]),
        s = Number(match[offset + 2]);
      if (m >= 60 || s >= 60)
        throw new RangeError('DMS minutes and seconds must each be below 60.');
      return (d + m / 60 + s / 3600) * (negative ? -1 : 1);
    };
    return validateWaypoint({
      lat: axis(1, match[4].toUpperCase() === 'S'),
      lon: axis(5, match[8].toUpperCase() === 'W'),
    });
  }
  if (format === 'UTM') {
    const match =
      /^(\d{1,2})\s*([NS])\s+(\d{1,6}(?:\.\d+)?)\s+(\d{1,8}(?:\.\d+)?)$/i.exec(
        value,
      );
    if (!match)
      throw new TypeError(
        'Use zone, hemisphere N/S, easting and northing in metres, e.g. 18 N 323394 4307396. N/S means hemisphere, not latitude band.',
      );
    return fromUtm({
      zone: Number(match[1]),
      hemisphere: match[2].toUpperCase(),
      easting: Number(match[3]),
      northing: Number(match[4]),
    });
  }
  throw new TypeError('Unsupported coordinate format.');
}

function dms(value, positive, negative) {
  const ticks = Math.round(Math.abs(value) * 360000);
  const degrees = Math.floor(ticks / 360000);
  const minutes = Math.floor((ticks % 360000) / 6000);
  const seconds = ((ticks % 6000) / 100).toFixed(2).padStart(5, '0');
  return `${degrees}°${String(minutes).padStart(2, '0')}′${seconds}″${value < 0 ? negative : positive}`;
}

export function formatCoordinate(point, format = 'DD') {
  const { lat, lon } = validateWaypoint(point);
  if (format === 'DD') return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  if (format === 'DMS') return `${dms(lat, 'N', 'S')} ${dms(lon, 'E', 'W')}`;
  if (format === 'MGRS') {
    gridPoint(point);
    // At the inclusive 84° boundary the dependency omits Svalbard exceptions.
    // Select the containing metre cell immediately inside the supported grid.
    return mgrs.forward([lon, lat === 84 ? 84 - 1e-10 : lat], 5);
  }
  if (format === 'UTM') {
    const utm = toUtm(point);
    return `${utm.zone} ${utm.hemisphere} ${utm.easting.toFixed(1)} ${utm.northing.toFixed(1)}`;
  }
  throw new TypeError('Unsupported coordinate format.');
}

/** WGS84 ellipsoidal surface range and initial TRUE bearing (not grid/magnetic). */
export function rangeBearing(origin, target) {
  validateWaypoint(origin);
  validateWaypoint(target);
  const delta = (target.lon - origin.lon) * RAD;
  const dot =
    Math.sin(origin.lat * RAD) * Math.sin(target.lat * RAD) +
    Math.cos(origin.lat * RAD) * Math.cos(target.lat * RAD) * Math.cos(delta);
  if (dot < Math.cos(Math.PI - 0.02))
    throw new RangeError(
      'Range/bearing unavailable for nearly antipodal points.',
    );
  if (
    origin.lat === target.lat &&
    (Math.abs(origin.lat) === 90 || Math.abs(Math.sin(delta / 2)) < 1e-14)
  )
    return { distanceM: 0, trueBearingDeg: null };
  const geodesic = new EllipsoidGeodesic(
    Cartographic.fromDegrees(origin.lon, origin.lat),
    Cartographic.fromDegrees(target.lon, target.lat),
    Ellipsoid.WGS84,
  );
  const distanceM = geodesic.surfaceDistance;
  const trueBearingDeg =
    Math.abs(origin.lat) === 90
      ? null
      : (((geodesic.startHeading / RAD) % 360) + 360) % 360;
  if (
    !Number.isFinite(distanceM) ||
    (trueBearingDeg !== null && !Number.isFinite(trueBearingDeg))
  )
    throw new RangeError('Cannot calculate this geodesic.');
  return { distanceM, trueBearingDeg };
}
