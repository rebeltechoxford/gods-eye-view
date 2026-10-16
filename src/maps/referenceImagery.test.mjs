import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { MAP_STACKS } from './catalog.js';
import {
  ALL_MAP_IDS,
  CORE_MAP_IDS,
  REFERENCE_MAPS,
} from './referenceCatalog.js';
import { createDefaultMapSources } from './defaultSources.js';
import {
  boundChartProvider,
  createReferenceImagery,
  EMPTY_CHART_TILE,
} from './referenceImagery.js';
import {
  VIEW_MAPS,
  createView,
  viewFromParams,
  viewToParams,
} from '../view/index.js';
import { GEV_ACTION_SCHEMAS } from '../voice/actionSchemas.js';

test('curated references preserve original IDs, defaults, lazy acquisition and shared voice/view IDs', () => {
  assert.deepEqual(
    MAP_STACKS.slice(0, 5).map(({ id }) => id),
    CORE_MAP_IDS,
  );
  assert.deepEqual(
    MAP_STACKS.map(({ id }) => id),
    ALL_MAP_IDS,
  );
  assert.equal(new Set(ALL_MAP_IDS).size, 13);
  for (const map of ALL_MAP_IDS)
    assert.equal(
      viewFromParams(
        viewToParams(
          createView({ map, camera: { lat: 34.3665, lon: -89.5192 } }),
        ),
      ).map,
      map,
    );
  assert.deepEqual(VIEW_MAPS, ALL_MAP_IDS);
  assert.deepEqual(
    GEV_ACTION_SCHEMAS.find(({ name }) => name === 'set_map_stack').parameters
      .properties.stack.enum,
    ALL_MAP_IDS,
  );
  for (const [options, expected] of [
    [{}, 'esri-imagery'],
    [{ googleTileset: {} }, 'photoreal'],
    [{ cesiumToken: 'synthetic' }, 'esri-imagery'],
  ]) {
    const registry = createDefaultMapSources(options);
    assert.equal(registry.defaultId, expected);
    const terrain = registry.sources.find(
      ({ descriptor }) => descriptor.id === 'osm',
    ).terrain;
    for (const descriptor of REFERENCE_MAPS) {
      const source = registry.sources.find(
        (entry) => entry.descriptor.id === descriptor.id,
      );
      assert.equal(typeof source.imagery, 'function');
      assert.equal(source.available, true);
      assert.equal(source.terrain, terrain);
      assert.equal(source.credit, descriptor.credit);
      assert.equal(source.constructionFallback.id, 'osm');
      assert.equal(source.tileFailureFallback.id, 'osm');
      assert.match(descriptor.url, /^https:\/\//);
      assert.equal(new URL(descriptor.url).search, '');
    }
  }
});

test('chart blank tile decodes to a transparent RGBA pixel', async () => {
  const { data, info } = await sharp(
    Buffer.from(EMPTY_CHART_TILE.split(',')[1], 'base64'),
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1);
  assert.equal(info.height, 1);
  assert.deepEqual([...data], [0, 0, 0, 0]);
});

test('reference factories acquire only pinned endpoints and disable picking', async () => {
  const calls = [];
  const sdk = {
    ArcGisMapServerImageryProvider: {
      fromUrl: async (url, options) => {
        calls.push({ url, options });
        return { marker: url };
      },
    },
    WebMercatorTilingScheme: class {},
    NeverTileDiscardPolicy: class {},
    WebMapServiceImageryProvider: class {
      constructor(options) {
        calls.push({ options });
        this.options = options;
      }
    },
    Resource: {
      fetchImage() {
        assert.fail('blank should not decode before tile request');
      },
    },
  };
  for (const entry of REFERENCE_MAPS)
    await createReferenceImagery(entry.id, {}, sdk);
  assert.equal(calls.length, 8);
  for (const [index, entry] of REFERENCE_MAPS.entries()) {
    assert.equal(calls[index].options.enablePickFeatures, false);
    assert.equal(calls[index].options.credit, entry.credit);
    assert.equal(calls[index].options.maximumLevel, entry.maximumLevel);
    assert.equal(calls[index].url || calls[index].options.url, entry.url);
  }
  const wms = calls[4].options;
  for (const call of calls.slice(5))
    assert.ok(
      call.options.tileDiscardPolicy instanceof sdk.NeverTileDiscardPolicy,
    );
  assert.equal(wms.crs, 'EPSG:3857');
  assert.equal(wms.layers, '0,1,2,3,4,5,6,7,8,9,10,11,12');
  assert.deepEqual(wms.parameters, {
    version: '1.3.0',
    format: 'image/png',
    transparent: true,
    styles: '',
  });
  assert.ok(wms.tilingScheme instanceof sdk.WebMercatorTilingScheme);
  await assert.rejects(
    createReferenceImagery('https://attacker.invalid', {}, sdk),
    /Unknown reference/,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    createReferenceImagery('esri-topo', { signal: abort.signal }, sdk),
    { name: 'AbortError' },
  );
  assert.equal(calls.length, 8);
});

test('FAA keeps global root level0 while bounding requests, reuses empty coverage and preserves outages/scheduling', async () => {
  const calls = [];
  let mode = 'tile',
    blanks = 0;
  const expected = {};
  const provider = {
    maximumLevel: 23,
    tileWidth: 256,
    tileHeight: 256,
    credit: {},
    rectangle: {},
    tilingScheme: {},
    errorEvent: {},
    requestImage(...args) {
      calls.push(args);
      if (mode === 'busy') return undefined;
      if (mode === 'missing') return Promise.reject({ statusCode: 404 });
      if (mode === 'offline') return Promise.reject({ statusCode: 503 });
      return Promise.resolve(expected);
    },
  };
  const empty = {};
  const chart = boundChartProvider(
    provider,
    { minimumChartLevel: 8, maximumLevel: 12 },
    () => {
      blanks++;
      return empty;
    },
  );
  assert.equal(chart.minimumLevel, 0);
  assert.equal(chart.maximumLevel, 12);
  assert.equal(await chart.requestImage(0, 0, 0), empty);
  assert.equal(await chart.requestImage(0, 0, 7), empty);
  assert.equal(await chart.requestImage(0, 0, 13), empty);
  assert.equal(calls.length, 0);
  assert.equal(blanks, 1);
  const request = {};
  assert.equal(await chart.requestImage(2, 3, 8, request), expected);
  assert.deepEqual(calls[0], [2, 3, 8, request]);
  mode = 'missing';
  assert.equal(await chart.requestImage(2, 3, 9), empty);
  mode = 'busy';
  assert.equal(chart.requestImage(2, 3, 9), undefined);
  mode = 'offline';
  await assert.rejects(
    chart.requestImage(2, 3, 9),
    (error) => error.statusCode === 503,
  );
  assert.equal(chart.errorEvent, provider.errorEvent);
  assert.equal(chart.credit, provider.credit);
});
