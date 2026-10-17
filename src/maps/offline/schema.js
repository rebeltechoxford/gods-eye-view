/** Portable, closed contracts for fixed-source downloads and local raster imports. */
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
export const OFFLINE_IMPORT_LIMITS = Object.freeze({
  maxMetadataBytes: 64 * 1024,
  maxMetadataEntries: 64,
  maxMetadataValueBytes: 16 * 1024,
});
export const OFFLINE_IMPORTED_SOURCE = 'operator-mbtiles';
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
const importedFields = new Set([...fields, 'plannedKeys', 'provenance']);
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
function plainText(value, maximum, label, { empty = false } = {}) {
  if (
    typeof value !== 'string' ||
    (!empty && !value.trim()) ||
    new TextEncoder().encode(value).byteLength > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    fail(`invalid ${label}`);
  return value;
}
function sourceUrl(value) {
  plainText(value, 2048, 'source URL', { empty: true });
  if (/[\u0000-\u0020\u007f]/.test(value)) fail('invalid source URL');
  if (value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      fail('invalid source URL');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      fail('invalid source URL');
  }
  return value;
}
/** An operator assertion of permission is recorded, not treated as a verified license. */
export function validateMbtilesImportRequest(value) {
  record(value, 'MBTiles import request');
  const allowed = new Set([
    'name',
    'fileBytes',
    'sourceTitle',
    'sourceUrl',
    'license',
    'edition',
    'authorized',
    'selection',
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.authorized !== true
  )
    fail('an explicit permission-to-copy assertion is required');
  plainText(value.name, 80, 'pack name');
  if (
    value.name !== value.name.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.name)
  )
    fail('invalid pack name');
  integer(
    value.fileBytes,
    100,
    OFFLINE_LIMITS.maxPackBytes,
    'original file bytes',
  );
  return {
    name: value.name,
    fileBytes: value.fileBytes,
    sourceTitle: plainText(value.sourceTitle, 512, 'source title'),
    sourceUrl: sourceUrl(value.sourceUrl ?? ''),
    license: plainText(value.license, 8192, 'license or permission notice'),
    edition: plainText(value.edition ?? '', 512, 'edition', { empty: true }),
    authorized: true,
    ...(value.selection === undefined
      ? {}
      : { selection: validateMbtilesSelection(value.selection) }),
  };
}
export function validateImportProvenance(value) {
  record(value, 'import provenance');
  const allowed = new Set([
    'format',
    'sha256',
    'fileBytes',
    'importedAt',
    'sourceTitle',
    'license',
    'edition',
    'metadata',
    'crs',
    'tileScheme',
    'tileSize',
    'permission',
    'selection',
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    value.format !== 'mbtiles'
  )
    fail('unsupported import provenance');
  if (
    value.crs !== 'EPSG:3857' ||
    value.tileScheme !== 'tms' ||
    value.tileSize !== 256 ||
    value.permission !== 'operator-asserted'
  )
    fail('unsupported original raster scheme or permission record');
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))
    fail('invalid original file hash');
  integer(
    value.fileBytes,
    100,
    OFFLINE_LIMITS.maxPackBytes,
    'original file bytes',
  );
  iso(value.importedAt, 'import time');
  plainText(value.sourceTitle, 512, 'source title');
  plainText(value.license, 8192, 'license or permission notice');
  plainText(value.edition, 512, 'edition', { empty: true });
  if (
    !Array.isArray(value.metadata) ||
    value.metadata.length > OFFLINE_IMPORT_LIMITS.maxMetadataEntries
  )
    fail('metadata entry limit');
  const seen = new Set();
  const metadata = value.metadata.map((entry) => {
    record(entry, 'original metadata');
    if (Object.keys(entry).some((key) => !['name', 'value'].includes(key)))
      fail('unknown original metadata field');
    plainText(entry.name, 128, 'metadata name');
    plainText(
      entry.value,
      OFFLINE_IMPORT_LIMITS.maxMetadataValueBytes,
      'metadata value',
      { empty: true },
    );
    if (seen.has(entry.name)) fail('duplicate original metadata name');
    seen.add(entry.name);
    return { name: entry.name, value: entry.value };
  });
  if (
    new TextEncoder().encode(JSON.stringify(metadata)).byteLength >
    OFFLINE_IMPORT_LIMITS.maxMetadataBytes
  )
    fail('original metadata byte limit');
  return {
    format: 'mbtiles',
    sha256: value.sha256,
    fileBytes: value.fileBytes,
    crs: 'EPSG:3857',
    tileScheme: 'tms',
    tileSize: 256,
    permission: 'operator-asserted',
    importedAt: value.importedAt,
    sourceTitle: value.sourceTitle,
    license: value.license,
    edition: value.edition,
    metadata,
    ...(value.selection === undefined
      ? {}
      : { selection: validateMbtilesSelection(value.selection) }),
  };
}
function importedPlan(value) {
  if (
    !Array.isArray(value.plannedKeys) ||
    !value.plannedKeys.length ||
    value.plannedKeys.length > OFFLINE_LIMITS.maxTiles
  )
    fail('invalid imported tile plan');
  let previous = null;
  const plan = value.plannedKeys.map((key) => {
    const tile = parseTileKey(key);
    if (previous !== null && key <= previous)
      fail('imported tile keys must be unique and sorted');
    previous = key;
    return tile;
  });
  const zooms = plan.map((tile) => tile.z);
  if (
    Math.min(...zooms) !== value.minZoom ||
    Math.max(...zooms) !== value.maxZoom
  )
    fail('imported zoom range differs from tile keys');
  return plan;
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
export function planOfflineTiles(value) {
  if (value?.schemaVersion === 2) return importedPlan(value);
  const { bounds, minZoom, maxZoom } = value;
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
/** An import selection is a bounded potential grid, not permission to scan an unlimited sparse area. */
export function validateMbtilesSelection(value) {
  record(value, 'MBTiles selection');
  if (
    Object.keys(value).some(
      (key) => !['bounds', 'minZoom', 'maxZoom'].includes(key),
    )
  )
    fail('unknown MBTiles selection field');
  const result = {
    bounds: boundsOf(value.bounds),
    minZoom: integer(
      value.minZoom,
      0,
      OFFLINE_SOURCE.maxZoom,
      'selection minimum zoom',
    ),
    maxZoom: integer(
      value.maxZoom,
      value.minZoom,
      OFFLINE_SOURCE.maxZoom,
      'selection maximum zoom',
    ),
  };
  planOfflineTiles(result);
  return result;
}
/** Disjoint, bounded, parameterized-query rectangles in original MBTiles TMS coordinates. */
export function mbtilesSelectionRanges(value) {
  const byZoom = new Map();
  for (const { z, x, y } of planOfflineTiles(validateMbtilesSelection(value))) {
    let row = byZoom.get(z);
    if (!row) byZoom.set(z, (row = { xs: new Set(), y0: y, y1: y }));
    row.xs.add(x);
    row.y0 = Math.min(row.y0, y);
    row.y1 = Math.max(row.y1, y);
  }
  const ranges = [];
  for (const [z, { xs, y0, y1 }] of byZoom) {
    let previous;
    for (const x of [...xs].sort((a, b) => a - b)) {
      if (previous && x === previous.x1 + 1) previous.x1 = x;
      else {
        previous = {
          z,
          x0: x,
          x1: x,
          r0: 2 ** z - 1 - y1,
          r1: 2 ** z - 1 - y0,
        };
        ranges.push(previous);
      }
    }
  }
  return ranges;
}
/** The smallest circular tile envelope preserves antimeridian coverage without stretching across the globe. */
export function importedTileBounds(keys) {
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > OFFLINE_LIMITS.maxTiles
  )
    fail('invalid imported tile bounds');
  const intervals = [];
  let south = MERCATOR_LATITUDE,
    north = -MERCATOR_LATITUDE;
  for (const key of keys) {
    const { z, x, y } = parseTileKey(key),
      n = 2 ** z;
    const latitude = (v) =>
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
    intervals.push([(360 * x) / n, (360 * (x + 1)) / n]);
    south = Math.min(south, latitude(y + 1));
    north = Math.max(north, latitude(y));
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1])
      last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  let largest = -1,
    end,
    start;
  for (let i = 0; i < merged.length; i++) {
    const next =
      merged[(i + 1) % merged.length][0] + (i + 1 === merged.length ? 360 : 0);
    if (next - merged[i][1] > largest) {
      largest = next - merged[i][1];
      start = next % 360;
      end = merged[i][1];
    }
  }
  return {
    west: largest === 0 ? -180 : start - 180,
    south: Math.max(-MERCATOR_LATITUDE, south),
    east: largest === 0 ? 180 : end - 180,
    north: Math.min(MERCATOR_LATITUDE, north),
  };
}
/** Sparse imports retain their exact keys; missing coverage never means an online fallback. */
export function createImportedManifest({
  id,
  name,
  bounds,
  minZoom,
  maxZoom,
  plannedKeys,
  provenance,
  sourceUrl: url = '',
  credit,
  createdAt = new Date().toISOString(),
}) {
  return validateOfflineManifest({
    schemaVersion: 2,
    id,
    name,
    sourceId: OFFLINE_IMPORTED_SOURCE,
    sourceUrl: url,
    bounds,
    minZoom,
    maxZoom,
    plannedKeys,
    provenance,
    credit,
    plannedTiles: plannedKeys.length,
    completedTiles: 0,
    downloadedBytes: 0,
    state: 'partial',
    createdAt,
    updatedAt: createdAt,
    acquiredAt: null,
    tiles: {},
  });
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
  const imported = value.schemaVersion === 2;
  if (
    Object.keys(value).some(
      (key) => !(imported ? importedFields : fields).has(key),
    )
  )
    fail('unknown manifest field');
  if (
    imported
      ? value.sourceId !== OFFLINE_IMPORTED_SOURCE
      : value.schemaVersion !== 1 ||
        value.sourceId !== OFFLINE_SOURCE.id ||
        value.sourceUrl !== OFFLINE_SOURCE.url ||
        value.credit !== OFFLINE_SOURCE.credit
  )
    fail('unsupported schema or source');
  const provenance = imported
    ? validateImportProvenance(value.provenance)
    : null;
  if (imported) {
    sourceUrl(value.sourceUrl);
    plainText(value.credit, 24 * 1024, 'source credit');
  }
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
    plan = planOfflineTiles(
      imported
        ? value
        : {
            bounds,
            minZoom: value.minZoom,
            maxZoom: value.maxZoom,
          },
    );
  if (value.plannedTiles !== plan.length) fail('tile plan count differs');
  if (provenance?.selection) {
    const selected = new Set(
      planOfflineTiles(provenance.selection).map((tile) => tile.key),
    );
    if (plan.some((tile) => !selected.has(tile.key)))
      fail('imported tile outside selection');
    const envelope = importedTileBounds(value.plannedKeys);
    // Transcendental latitude results may differ by a few ULPs across phone
    // engines. This sub-millimetre tolerance is not an arbitrary coverage edit.
    if (
      Object.keys(envelope).some(
        (key) => Math.abs(bounds[key] - envelope[key]) > 1e-9,
      )
    )
      fail('imported subset bounds differ from tile envelope');
  }
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
    schemaVersion: imported ? 2 : 1,
    id,
    name: value.name,
    sourceId: imported ? OFFLINE_IMPORTED_SOURCE : OFFLINE_SOURCE.id,
    sourceUrl: imported ? value.sourceUrl : OFFLINE_SOURCE.url,
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
    credit: imported ? value.credit : OFFLINE_SOURCE.credit,
    tiles,
    ...(imported
      ? { plannedKeys: plan.map((tile) => tile.key), provenance }
      : {}),
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
