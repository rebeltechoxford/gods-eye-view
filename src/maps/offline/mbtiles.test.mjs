import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createImportedManifest,
  createOfflineManifest,
  validateOfflineManifest,
  planOfflineTiles,
  hashTile,
} from './schema.js';
import { exportOfflinePack, readOfflinePack } from './file.js';

const id = '12345678-1234-4123-8123-123456789abc';
const date = '2026-10-17T00:00:00.000Z';
const image = new Uint8Array(
  await readFile(
    new URL(
      '../../../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
      import.meta.url,
    ),
  ),
);
const sha256 = await hashTile(image);
const provenance = {
  format: 'mbtiles',
  sha256: 'a'.repeat(64),
  fileBytes: 16384,
  importedAt: date,
  crs: 'EPSG:3857',
  tileScheme: 'tms',
  tileSize: 256,
  permission: 'operator-asserted',
  sourceTitle: 'Operator-owned synthetic map',
  license: 'Synthetic fixture: permission to copy.',
  edition: 'Fixture edition 2026',
  metadata: [
    { name: 'name', value: 'Synthetic map' },
    { name: 'format', value: 'jpg' },
    { name: 'attribution', value: '<b>Original notice & copyright</b>' },
  ],
};
const create = (options = {}) =>
  createImportedManifest({
    id,
    name: 'Sparse approved map',
    bounds: { west: -180, south: -80, east: 180, north: 80 },
    minZoom: 2,
    maxZoom: 2,
    plannedKeys: ['2/0/0', '2/3/3'],
    provenance,
    credit: 'Operator notice <b>kept as text</b>',
    createdAt: date,
    ...options,
  });
function ready(pack) {
  const tiles = Object.fromEntries(
    pack.plannedKeys.map((key) => [
      key,
      {
        bytes: image.byteLength,
        sha256,
        contentType: 'image/jpeg',
      },
    ]),
  );
  return validateOfflineManifest(
    {
      ...pack,
      tiles,
      completedTiles: pack.plannedKeys.length,
      downloadedBytes: image.byteLength * pack.plannedKeys.length,
      state: 'ready',
      acquiredAt: date,
    },
    { requireReady: true },
  );
}

test('v2 imported raster packs keep exact sparse keys and original notices through backup', async () => {
  const pack = ready(create());
  assert.deepEqual(
    planOfflineTiles(pack).map((tile) => tile.key),
    ['2/0/0', '2/3/3'],
  );
  assert.equal(pack.sourceId, 'operator-mbtiles');
  assert.equal(pack.sourceUrl, '');
  assert.deepEqual(pack.provenance, provenance);
  const blob = await exportOfflinePack(pack, async () => ({
    bytes: image,
    contentType: 'image/jpeg',
  }));
  const decoded = await readOfflinePack(blob);
  assert.deepEqual(decoded.manifest, pack);
  assert.deepEqual(await decoded.fetchTile('2/3/3'), {
    bytes: image,
    contentType: 'image/jpeg',
  });
  await assert.rejects(() => decoded.fetchTile('2/1/1'), /outside/);
});

test('v2 rejects duplicate, unsorted, out-of-world, excessive and misdeclared tile plans', () => {
  for (const options of [
    { plannedKeys: [] },
    { plannedKeys: ['2/0/0', '2/0/0'] },
    { plannedKeys: ['2/3/3', '2/0/0'] },
    { plannedKeys: ['2/4/0'] },
    { plannedKeys: ['2/00/0'] },
    { minZoom: 1 },
    { maxZoom: 3 },
    {
      plannedKeys: Array.from({ length: 5001 }, (_, n) => `13/${n}/0`),
      minZoom: 13,
      maxZoom: 13,
    },
  ])
    assert.throws(() => create(options), TypeError);
  const pack = create();
  assert.throws(
    () => validateOfflineManifest({ ...pack, sourceId: 'usgs-topo' }),
    /unsupported/,
  );
  assert.throws(
    () =>
      validateOfflineManifest({
        ...pack,
        sourceUrl: 'file:///private/key.pem',
      }),
    /source URL/,
  );
  assert.throws(
    () =>
      validateOfflineManifest({
        ...pack,
        sourceUrl: 'https://user:pass@example.com',
      }),
    /source URL/,
  );
  assert.throws(
    () =>
      validateOfflineManifest({ ...pack, state: 'ready', acquiredAt: date }),
    /incomplete/,
  );
});

test('v2 provenance is closed and bounded; metadata HTML stays inert original text', () => {
  for (const extra of [
    { license: '' },
    { sha256: 'bad' },
    { fileBytes: Infinity },
    {
      metadata: [
        { name: 'format', value: 'jpg' },
        { name: 'format', value: 'png' },
      ],
    },
    { metadata: [{ name: 'name', value: 'x'.repeat(16385) }] },
    {
      metadata: Array.from({ length: 65 }, (_, n) => ({
        name: String(n),
        value: '',
      })),
    },
    {
      metadata: Array.from({ length: 5 }, (_, n) => ({
        name: String(n),
        value: 'x'.repeat(16000),
      })),
    },
    { serverPath: '/private' },
  ])
    assert.throws(
      () => create({ provenance: { ...provenance, ...extra } }),
      TypeError,
    );
  const pack = create();
  provenance.metadata[0].value = 'mutated after creation';
  assert.equal(pack.provenance.metadata[0].value, 'Synthetic map');
  provenance.metadata[0].value = 'Synthetic map';
});

test('v1 retains its fixed source, unknown-field rejection and complete rectangular plan', () => {
  const pack = createOfflineManifest({
    id,
    name: 'USGS fixture',
    createdAt: date,
    bounds: { west: -1, south: -1, east: 1, north: 1 },
    minZoom: 1,
    maxZoom: 1,
  });
  assert.equal(planOfflineTiles(pack).length, 4);
  assert.throws(
    () => validateOfflineManifest({ ...pack, sourceId: 'operator-mbtiles' }),
    /unsupported/,
  );
  assert.throws(
    () => validateOfflineManifest({ ...pack, plannedKeys: ['1/0/0'] }),
    /unknown/,
  );
  assert.throws(
    () => validateOfflineManifest({ ...pack, credit: 'Someone else' }),
    /unsupported/,
  );
});

test('imported map credits escape private text and distinguish import time from edition', async () => {
  const { offlineSource, isOfflineSource } = await import('./imagery.js');
  const sdk = {
    Event: class {},
    Credit: class {
      constructor(html) {
        this.html = html;
      }
    },
    WebMercatorTilingScheme: class {
      rectangle = {};
    },
    EllipsoidTerrainProvider: class {},
  };
  const pack = ready(
    create({
      name: '<script>Private name</script>',
      provenance: { ...provenance, edition: '<b>2026 & private</b>' },
    }),
  );
  const source = offlineSource(
    pack,
    {
      getTile() {
        throw new Error('Credit creation must not fetch tiles');
      },
    },
    sdk,
  );
  assert.equal(isOfflineSource(source), true);
  assert.equal(source.localOnly, true);
  const provider = await source.imagery();
  assert.match(
    provider.credit.html,
    /&lt;script&gt;Private name&lt;\/script&gt;/,
  );
  assert.match(provider.credit.html, /Imported 2026-10-17T00:00:00.000Z/);
  assert.match(
    provider.credit.html,
    /Edition &lt;b&gt;2026 &amp; private&lt;\/b&gt;/,
  );
  assert.match(provider.credit.html, /Flat ellipsoid terrain/);
  assert.equal(provider.credit.html.includes('Downloaded'), false);
  assert.equal(provider.credit.html.includes('<script>'), false);
  assert.equal(provider.credit.html.includes('<b>'), false);
  provider.destroy();
  assert.equal(provider.isDestroyed(), true);
});
