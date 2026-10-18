// Road pack manifest: the sidecar JSON a pack is published with. Portable;
// the server validates it before serving a pack and the phone validates it
// again before storing one.

export const ROAD_PACK_MANIFEST_VERSION = 1;
export const MAX_ROAD_PACK_BYTES = 1024 * 1024 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.gevroads$/;

const isIso = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f]/.test(value);

/** Strictly validate a sidecar manifest; returns the public fields or throws. */
export function validateRoadPackManifest(value) {
  const fail = (message) => {
    throw new TypeError(`Road pack manifest: ${message}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('not an object');
  if (value.manifestVersion !== ROAD_PACK_MANIFEST_VERSION)
    fail('unsupported version');
  if (typeof value.id !== 'string' || !UUID.test(value.id)) fail('invalid id');
  if (!shortText(value.name, 80)) fail('invalid name');
  // The file name is server-side only; a published manifest omits it.
  if (
    value.file !== undefined &&
    (typeof value.file !== 'string' || !FILE.test(value.file))
  )
    fail('invalid file name');
  if (
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 64 ||
    value.bytes > MAX_ROAD_PACK_BYTES
  )
    fail('invalid size');
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256))
    fail('invalid sha256');
  if (value.profile !== 'car') fail('unsupported profile');
  const b = value.bounds;
  if (
    !b ||
    ![b.west, b.south, b.east, b.north].every(Number.isFinite) ||
    b.west < -180 ||
    b.east > 180 ||
    b.west >= b.east ||
    b.south < -90 ||
    b.north > 90 ||
    b.south >= b.north
  )
    fail('invalid bounds');
  if (value.edition !== null && !isIso(value.edition)) fail('invalid edition');
  if (!isIso(value.builtAt)) fail('invalid build time');
  if (!shortText(value.license, 40) || !shortText(value.attribution, 200))
    fail('invalid license');
  return Object.freeze({
    manifestVersion: value.manifestVersion,
    id: value.id.toLowerCase(),
    name: value.name,
    ...(value.file !== undefined ? { file: value.file } : {}),
    bytes: value.bytes,
    sha256: value.sha256,
    profile: value.profile,
    bounds: { west: b.west, south: b.south, east: b.east, north: b.north },
    edition: value.edition,
    builtAt: value.builtAt,
    license: value.license,
    attribution: value.attribution,
  });
}

/** Whether a validated manifest's bounds contain a point. */
export function roadPackCovers(manifest, lat, lon) {
  const b = manifest.bounds;
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}
