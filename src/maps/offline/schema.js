/** Portable, deliberately closed contract for retained USGS raster packs. */
export const OFFLINE_LIMITS = Object.freeze({
  maxTiles: 5000,
  maxPackBytes: 512 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxTileBytes: 2 * 1024 * 1024,
  fetchConcurrency: 4,
  maxManifestBytes: 2 * 1024 * 1024,
  maxPacks: 32,
});
export const OFFLINE_SOURCE = Object.freeze({
  id: 'usgs-topo',
  url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer',
  credit:
    'Map services and data available from U.S. Geological Survey, National Geospatial Program. USGS The National Map and credited contributors.',
  termsUrl:
    'https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map',
  minZoom: 0,
  maxZoom: 23,
  tileSize: 256,
});
export const MERCATOR_LATITUDE = 85.0511287798066;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set([
  'partial',
  'downloading',
  'ready',
  'cancelled',
  'failed',
]);
const CONTENT_TYPES = new Set(['image/png', 'image/jpeg']);
const fields = new Set([
  'schemaVersion',
  'id',
  'name',
  'sourceId',
  'sourceUrl',
  'bounds',
  'minZoom',
  'maxZoom',
  'plannedTiles',
  'completedTiles',
  'downloadedBytes',
  'state',
  'createdAt',
  'updatedAt',
  'acquiredAt',
  'credit',
  'tiles',
  'error',
]);
function fail(message) {
  throw new TypeError(`Offline map: ${message}`);
}
function record(value, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(`${label} must be an object`);
}
function number(value, min, max, label) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    fail(`invalid ${label}`);
  return value;
}
function integer(value, min, max, label) {
  number(value, min, max, label);
  if (!Number.isInteger(value)) fail(`invalid ${label}`);
  return value;
}
export function validatePackId(id) {
  if (typeof id !== 'string' || !UUID.test(id)) fail('invalid pack UUID');
  return id.toLowerCase();
}
function iso(value, label) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail(`invalid ${label}`);
  return value;
}
function boundsOf(bounds) {
  record(bounds, 'bounds');
  if (
    Object.keys(bounds).some(
      (key) => !['west', 'south', 'east', 'north'].includes(key),
    )
  )
    fail('unknown bounds field');
  const west = number(bounds.west, -180, 180, 'west'),
    east = number(bounds.east, -180, 180, 'east');
  const south = number(
      bounds.south,
      -MERCATOR_LATITUDE,
      MERCATOR_LATITUDE,
      'south',
    ),
    north = number(
      bounds.north,
      -MERCATOR_LATITUDE,
      MERCATOR_LATITUDE,
      'north',
    );
  if (west === east || south >= north) fail('bounds must have positive area');
  return { west, south, east, north };
}
export function tileKey(z, x, y) {
  integer(z, 0, OFFLINE_SOURCE.maxZoom, 'tile zoom');
  integer(x, 0, 2 ** z - 1, 'tile x');
  integer(y, 0, 2 ** z - 1, 'tile y');
  return `${z}/${x}/${y}`;
}
export function parseTileKey(key) {
  if (
    typeof key !== 'string' ||
    !/^(0|[1-9]\d*)\/(0|[1-9]\d*)\/(0|[1-9]\d*)$/.test(key)
  )
    fail('invalid tile key');
  const [z, x, y] = key.split('/').map(Number);
  tileKey(z, x, y);
  return { key, z, x, y };
}
export function offlineTileUrl(z, x, y) {
  tileKey(z, x, y);
  return `${OFFLINE_SOURCE.url}/tile/${z}/${y}/${x}`;
}
const latitudeY = (latitude, n) =>
  Math.max(
    0,
    Math.min(
      n,
      ((1 - Math.asinh(Math.tan((latitude * Math.PI) / 180)) / Math.PI) / 2) *
        n,
    ),
  );
/** Counts before enumeration, including antimeridian areas, to prevent huge plans. */
export function planOfflineTiles({ bounds, minZoom, maxZoom }) {
  const area = boundsOf(bounds);
  integer(
    minZoom,
    OFFLINE_SOURCE.minZoom,
    OFFLINE_SOURCE.maxZoom,
    'minimum zoom',
  );
  integer(maxZoom, minZoom, OFFLINE_SOURCE.maxZoom, 'maximum zoom');
  const longitudeRanges =
    area.west < area.east
      ? [[area.west, area.east]]
      : [
          [area.west, 180],
          [-180, area.east],
        ];
  const ranges = [];
  let count = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const n = 2 ** z,
      y0 = Math.min(n - 1, Math.floor(latitudeY(area.north, n))),
      y1 = Math.max(0, Math.ceil(latitudeY(area.south, n)) - 1);
    const xRanges = [];
    for (const [west, east] of longitudeRanges) {
      if (west === east) continue;
      const x0 = Math.min(n - 1, Math.floor(((west + 180) / 360) * n)),
        x1 = Math.max(0, Math.ceil(((east + 180) / 360) * n) - 1);
      // Antimeridian ranges can overlap at very low zooms; merge intervals.
      xRanges.push([x0, x1]);
    }
    xRanges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of xRanges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1] + 1)
        last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    for (const [x0, x1] of merged) {
      count += (x1 - x0 + 1) * (y1 - y0 + 1);
      if (count > OFFLINE_LIMITS.maxTiles)
        fail(`area/detail exceeds ${OFFLINE_LIMITS.maxTiles} tiles`);
      ranges.push({ z, x0, x1, y0, y1 });
    }
  }
  const tiles = [];
  for (const { z, x0, x1, y0, y1 } of ranges)
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        tiles.push({ key: tileKey(z, x, y), z, x, y });
  if (!tiles.length) fail('empty tile plan');
  return tiles;
}
export function createOfflineManifest({
  id,
  name,
  bounds,
  minZoom,
  maxZoom,
  createdAt = new Date().toISOString(),
}) {
  const plan = planOfflineTiles({ bounds, minZoom, maxZoom });
  return validateOfflineManifest({
    schemaVersion: 1,
    id,
    name,
    sourceId: OFFLINE_SOURCE.id,
    sourceUrl: OFFLINE_SOURCE.url,
    bounds,
    minZoom,
    maxZoom,
    plannedTiles: plan.length,
    completedTiles: 0,
    downloadedBytes: 0,
    state: 'partial',
    createdAt,
    updatedAt: createdAt,
    acquiredAt: null,
    credit: OFFLINE_SOURCE.credit,
    tiles: {},
  });
}
export function validateOfflineManifest(value, { requireReady = false } = {}) {
  record(value, 'manifest');
  if (Object.keys(value).some((key) => !fields.has(key)))
    fail('unknown manifest field');
  if (
    value.schemaVersion !== 1 ||
    value.sourceId !== OFFLINE_SOURCE.id ||
    value.sourceUrl !== OFFLINE_SOURCE.url ||
    value.credit !== OFFLINE_SOURCE.credit
  )
    fail('unsupported schema or source');
  const id = validatePackId(value.id);
  if (
    typeof value.name !== 'string' ||
    value.name !== value.name.trim() ||
    !value.name ||
    value.name.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value.name)
  )
    fail('invalid pack name');
  const bounds = boundsOf(value.bounds),
    plan = planOfflineTiles({
      bounds,
      minZoom: value.minZoom,
      maxZoom: value.maxZoom,
    });
  if (value.plannedTiles !== plan.length) fail('tile plan count differs');
  if (!STATES.has(value.state) || (requireReady && value.state !== 'ready'))
    fail('pack is not ready or has invalid state');
  iso(value.createdAt, 'creation time');
  iso(value.updatedAt, 'update time');
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt))
    fail('update precedes creation');
  if (value.acquiredAt !== null) iso(value.acquiredAt, 'acquisition time');
  record(value.tiles, 'tile metadata');
  const planned = new Set(plan.map((t) => t.key));
  const tiles = {};
  let bytes = 0,
    count = 0;
  for (const [key, meta] of Object.entries(value.tiles)) {
    if (!planned.has(key)) fail('tile outside pack plan');
    record(meta, 'tile metadata');
    if (
      Object.keys(meta).some(
        (field) => !['bytes', 'sha256', 'contentType'].includes(field),
      )
    )
      fail('unknown tile metadata field');
    integer(meta.bytes, 1, OFFLINE_LIMITS.maxTileBytes, 'tile bytes');
    if (
      typeof meta.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(meta.sha256) ||
      !CONTENT_TYPES.has(meta.contentType)
    )
      fail('invalid tile hash or MIME');
    bytes += meta.bytes;
    count++;
    tiles[key] = {
      bytes: meta.bytes,
      sha256: meta.sha256,
      contentType: meta.contentType,
    };
  }
  if (
    bytes > OFFLINE_LIMITS.maxPackBytes ||
    value.downloadedBytes !== bytes ||
    value.completedTiles !== count
  )
    fail('pack byte/count summary differs');
  if (value.state === 'ready' && (count !== plan.length || !value.acquiredAt))
    fail('ready pack is incomplete');
  if (
    value.error !== undefined &&
    (typeof value.error !== 'string' ||
      value.error.length > 256 ||
      /[\u0000-\u001f]/.test(value.error))
  )
    fail('invalid error text');
  const result = {
    schemaVersion: 1,
    id,
    name: value.name,
    sourceId: OFFLINE_SOURCE.id,
    sourceUrl: OFFLINE_SOURCE.url,
    bounds,
    minZoom: value.minZoom,
    maxZoom: value.maxZoom,
    plannedTiles: plan.length,
    completedTiles: count,
    downloadedBytes: bytes,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    acquiredAt: value.acquiredAt,
    credit: OFFLINE_SOURCE.credit,
    tiles,
    ...(value.error === undefined ? {} : { error: value.error }),
  };
  const metadataBytes = new TextEncoder().encode(
    JSON.stringify(result),
  ).byteLength;
  if (
    metadataBytes > OFFLINE_LIMITS.maxManifestBytes ||
    metadataBytes + bytes + 12 > OFFLINE_LIMITS.maxPackBytes
  )
    fail('pack or manifest exceeds byte limit');
  return result;
}
export function validateTileBytes(bytes, contentType) {
  if (
    !(bytes instanceof Uint8Array) ||
    !bytes.byteLength ||
    bytes.byteLength > OFFLINE_LIMITS.maxTileBytes
  )
    fail('invalid tile byte length');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png =
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
    view.getUint32(8) === 13 &&
    [73, 72, 68, 82].every((v, i) => bytes[12 + i] === v) &&
    view.getUint32(16) === 256 &&
    view.getUint32(20) === 256;
  let jpeg = false;
  if (
    bytes.length >= 12 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes.at(-2) === 255 &&
    bytes.at(-1) === 217
  ) {
    let offset = 2,
      segments = 0;
    while (offset + 4 < bytes.length && segments++ < 512) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      if (offset + 3 > bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0xd8 || marker === 1 || (marker >= 0xd0 && marker <= 0xd7))
        continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        jpeg =
          length >= 8 &&
          view.getUint16(offset + 3) === 256 &&
          view.getUint16(offset + 5) === 256;
        break;
      }
      offset += length;
    }
  }
  if (!(
    (contentType === 'image/png' && png) ||
    (contentType === 'image/jpeg' && jpeg)
  ))
    fail('tile MIME does not match PNG/JPEG bytes');
  return bytes;
}
export const packStorageBytes = (manifest) =>
  manifest.downloadedBytes +
  new TextEncoder().encode(JSON.stringify(manifest)).byteLength +
  12;
export async function hashTile(bytes, cryptoRef = globalThis.crypto) {
  if (!(bytes instanceof Uint8Array) || !cryptoRef?.subtle)
    fail('SHA256 unavailable or invalid bytes');
  const digest = await cryptoRef.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
