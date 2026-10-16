#!/usr/bin/env node
/** Real Cesium/UI acceptance with hermetic public-provider fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { REFERENCE_MAPS, CORE_MAP_IDS } from '../src/maps/referenceCatalog.js';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import {
  hookRenderErrors,
  readRenderErrors,
  watchPage,
} from './qa-browserEvidence.mjs';
import { interceptFixtures } from './qa-fixtureInterception.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const base = new URL(value('--url', 'http://127.0.0.1:4176'));
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
  'QA requires a local app',
);
const dir = value('--artifact-dir', 'qa-artifacts/reference-maps');
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const requests = [],
  errors = [],
  results = [];
let failId = null;
const browser = await puppeteer.launch({
  headless: !args.includes('--headful'),
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 120000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});
const page = await browser.newPage();
const workers = [],
  workerNetwork = [],
  fixtureScripts = [];
const monitor = watchPage(page, { name: 'reference-maps', errors });
page.on('workercreated', (worker) => {
  workers.push(worker.url());
  worker.client.on('Network.responseReceived', ({ response }) =>
    workerNetwork.push({
      url: response.url,
      status: response.status,
      mime: response.mimeType,
    }),
  );
});
page.setDefaultTimeout(60000);
page.on('pageerror', (error) => errors.push(error.message));
await hookRenderErrors(page);
const interception = await interceptFixtures(page, {
  origin: base.origin,
  handle: (request) => {
    const url = new URL(request.url());
    const reply = (status, contentType, body) =>
      void request
        .respond({
          status,
          contentType,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body,
        })
        .catch(() => {});
    if (
      args.includes('--fonts') &&
      ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
    )
      return void request.continue().catch(() => {});
    // A hard failure exercises the real ellipsoid fallback, rather than
    // pretending an untyped JSON object is terrain geometry.
    if (url.hostname === 'terrain.reearth.land')
      return reply(400, 'text/plain', 'Synthetic terrain unavailable');
    const source = REFERENCE_MAPS.find((entry) =>
      request.url().startsWith(entry.url),
    );
    if (source) {
      requests.push({ id: source.id, url: request.url() });
      if (source.id === failId) return reply(503, 'application/json', '{}');
      // ArcGIS probes one missing-image sentinel. Giving it our real fixture
      // texture would teach Cesium to discard every subsequent image as missing.
      if (
        source.sourceType === 'arcgis' &&
        source.minimumChartLevel === undefined &&
        url.pathname.endsWith(`/tile/${source.maximumLevel}/0/0`)
      )
        return reply(404, 'text/plain', 'Synthetic missing-tile sentinel');
      if (source.sourceType === 'wms' || url.pathname.includes('/tile/'))
        return reply(200, 'image/jpeg', tile);
      return reply(200, 'application/json', JSON.stringify(metadata(source)));
    }
    if (url.pathname.endsWith('/World_Imagery/MapServer/tile/19/0/0'))
      return reply(404, 'text/plain', 'Synthetic missing-tile sentinel');
    if (
      url.hostname === 'tile.openstreetmap.org' ||
      /World_Imagery\/MapServer\/tile\//.test(url.pathname)
    )
      return reply(200, 'image/jpeg', tile);
    if (url.pathname.endsWith('/World_Imagery/MapServer'))
      return reply(
        200,
        'application/json',
        JSON.stringify(metadata({ maximumLevel: 19 })),
      );
    if (
      url.origin === base.origin &&
      url.pathname.startsWith('/api/') &&
      !url.pathname.startsWith('/api/tak/')
    )
      return reply(200, 'application/json', '{}');
    if (url.protocol.startsWith('http') && url.origin !== base.origin) {
      if (
        request.resourceType() === 'script' ||
        /\.m?js(?:$|\?)/.test(url.pathname)
      )
        fixtureScripts.push(request.url());
      return reply(200, 'application/json', '{}');
    }
    void request.continue().catch(() => {});
  },
});
function metadata(source) {
  return {
    currentVersion: 10.81,
    copyrightText: source.credit || 'Synthetic fixture',
    fullExtent: {
      xmin: -20037508.342787,
      ymin: -20037508.342787,
      xmax: 20037508.342787,
      ymax: 20037508.342787,
      spatialReference: { wkid: 102100 },
    },
    minLOD: source.minimumChartLevel ?? 0,
    maxLOD: source.maximumLevel,
    tileInfo: {
      rows: 256,
      cols: 256,
      origin: { x: -20037508.342787, y: 20037508.342787 },
      spatialReference: { wkid: 102100 },
      // FAA really advertises 24 LODs even when maxLOD is 9 or 12.
      lods: Array.from(
        {
          length:
            source.minimumChartLevel === undefined
              ? source.maximumLevel + 1
              : 24,
        },
        (_, level) => ({
          level,
          resolution: 156543.033928 / 2 ** level,
          scale: 591657527.591555 / 2 ** level,
        }),
      ),
    },
  };
}
const step = async (name, run) => {
  const detail = await run();
  results.push({ name, passed: true, detail });
  console.log(`ok ${results.length} ${name}`);
};
async function select(id) {
  await page.select('#map-reference-select', id);
  await page.waitForFunction(
    (expected) =>
      window.__godsEyeView.mapStackController.getActiveId() === expected &&
      !window.__godsEyeView.mapStackController.getState().lastError,
    {},
    id,
  );
}
async function capture(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await page.waitForFunction(
    () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 30000 },
  );
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}
try {
  await fs.mkdir(dir, { recursive: true });
  const address = new URL(base);
  address.hash =
    'lat=34.3665&lon=-89.5192&alt=50000&heading=0&pitch=-70&map=osm&b=0';
  await page.goto(address.href, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      !!window.__godsEyeView?.takClient &&
      !!window.__godsEyeView?.mapStackController,
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden') ||
      getComputedStyle(document.getElementById('loading-screen')).display ===
        'none',
  );
  await page.waitForFunction(() => {
    const launcher = document.getElementById('first-run-launcher');
    return !launcher || launcher.dataset.initialized === 'true';
  });
  if (await page.$('#first-run-launcher.visible')) {
    await page.click('#first-run-launcher.visible .first-run-explore');
    await page.waitForFunction(
      () => !document.querySelector('#first-run-launcher.visible'),
    );
  }
  // Let the initial globe finish its real terrain/imagery work before rapidly
  // replacing its imagery layer through all eight factories.
  await page.waitForFunction(
    () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 30000 },
  );
  if (
    await page.$eval(
      '#control-panel-toggle',
      (node) => node.getAttribute('aria-expanded') === 'false',
    )
  )
    await page.click('#control-panel-toggle');
  await page.waitForSelector('#map-reference-select', { visible: true });
  await step(
    'all existing GEV layers and five quick map controls retained; optional sources start lazy',
    async () => {
      const initial = await page.evaluate(() => ({
        layers: [...window.__godsEyeView.dataManager.layers.keys()].sort(),
        chips: [
          ...document.querySelectorAll('#map-stack-chips [data-stack-id]'),
        ].map((node) => node.dataset.stackId),
        options: [...document.querySelectorAll('#map-reference-select option')]
          .map((node) => node.value)
          .filter(Boolean),
        network: window.__godsEyeView.takClient.client.link().state,
      }));
      assert.deepEqual(
        initial.layers,
        [...LAYER_STATE_REGISTRY.map(({ id }) => id), 'local-adsb'].sort(),
      );
      assert.deepEqual(initial.chips, CORE_MAP_IDS);
      assert.equal(initial.options.length, 8);
      assert.equal(requests.length, 0);
      assert(['idle', 'disconnected'].includes(initial.network));
      // A synthetic retained tactical contact proves map changes don't clear TAK.
      await page.evaluate(() => {
        const now = Date.now();
        window.__godsEyeView.takClient.client.importXml(
          `<event version="2.0" uid="QA-MAP-PRESERVE" type="a-f-G-U-C" how="h-e" time="${new Date(now).toISOString()}" start="${new Date(now).toISOString()}" stale="${new Date(now + 3600000).toISOString()}"><point lat="34.3665" lon="-89.5192" hae="9999999" ce="15" le="9999999"/><detail><contact callsign="SYNTHETIC MAP QA"/></detail></event>`,
        );
      });
      return initial;
    },
  );
  for (const source of REFERENCE_MAPS) {
    await step(
      `${source.id}: real Cesium factory, same controller, credits and retained tactical contact`,
      async () => {
        await select(source.id);
        await page.evaluate(() => {
          const scene = window.__godsEyeView.viewer.scene;
          scene.postProcessStages.bloom.enabled = false;
          scene.requestRender();
        });
        // CreditDisplay paints on a rendered frame after activation settles.
        await page.waitForFunction(
          (credit) =>
            document
              .querySelector('.cesium-widget-credits')
              .textContent.includes(credit),
          {},
          source.credit,
        );
        const state = await page.evaluate(() => {
          const gev = window.__godsEyeView,
            provider = gev.mapStackController._imageryLayer.imageryProvider;
          return {
            active: gev.mapStackController.getActiveId(),
            minimumLevel: provider.minimumLevel,
            maximumLevel: provider.maximumLevel,
            details: document.querySelector('.map-reference-details')
              .textContent,
            credits: document.querySelector('.cesium-widget-credits')
              .textContent,
            tak: !!gev.takClient.client.store.get('QA-MAP-PRESERVE'),
            layers: gev.dataManager.layers.size,
          };
        });
        assert.equal(state.active, source.id);
        assert(state.tak);
        assert.equal(state.layers, 30);
        assert(state.details.includes(source.credit));
        assert(state.credits.includes(source.credit));
        assert.equal(state.maximumLevel, source.maximumLevel);
        if (source.lifecycle) assert(state.details.includes(source.lifecycle));
        if (source.referenceOnly)
          assert(state.details.includes('Reference display only'));
        return state;
      },
    );
  }
  await step(
    'FAA never fetches below min or above max; reusable blank is transparent; valid tile uses WebMercator bounds',
    async () => {
      await select('faa-vfr');
      const before = requests.filter(
        ({ id, url }) => id === 'faa-vfr' && url.includes('/tile/'),
      ).length;
      const detail = await page.evaluate(async () => {
        const provider =
          window.__godsEyeView.mapStackController._imageryLayer.imageryProvider;
        const image = await provider.requestImage(0, 0, 0);
        await provider.requestImage(0, 0, 7);
        await provider.requestImage(0, 0, 13);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0);
        const alpha = ctx.getImageData(0, 0, 1, 1).data[3];
        const level = 8,
          x = 64,
          y = 101;
        const rectangle = provider.tilingScheme.tileXYToRectangle(x, y, level);
        const containsOxford =
          rectangle.west < (-89.5192 * Math.PI) / 180 &&
          rectangle.east > (-89.5192 * Math.PI) / 180 &&
          rectangle.south < (34.3665 * Math.PI) / 180 &&
          rectangle.north > (34.3665 * Math.PI) / 180;
        const tile = await provider.requestImage(x, y, level);
        return {
          alpha,
          containsOxford,
          width: tile.width,
          minimumLevel: provider.minimumLevel,
        };
      });
      assert.equal(detail.alpha, 0);
      assert(detail.containsOxford);
      assert.equal(detail.minimumLevel, 0);
      assert(detail.width > 0);
      const after = requests.filter(
        ({ id, url }) => id === 'faa-vfr' && url.includes('/tile/'),
      );
      assert(after.length >= before + 1);
      for (const { url } of after) {
        const level = Number(
          new URL(url).pathname.split('/tile/')[1].split('/')[0],
        );
        assert(level >= 8 && level <= 12, `FAA invalid acquisition ${url}`);
      }
      return detail;
    },
  );
  await step(
    'NOAA issues a complete WMS1.3 EPSG3857 13-layer GetMap',
    async () => {
      await select('noaa-enc');
      await page.evaluate(async () => {
        await window.__godsEyeView.mapStackController._imageryLayer.imageryProvider.requestImage(
          64,
          101,
          8,
        );
      });
      const call = requests.find(
        ({ id, url }) =>
          id === 'noaa-enc' &&
          new URL(url).searchParams.get('request')?.toLowerCase() === 'getmap',
      );
      assert(call, 'NOAA GetMap absent');
      const params = new URL(call.url).searchParams;
      assert.equal(params.get('crs'), 'EPSG:3857');
      assert.equal(params.get('version'), '1.3.0');
      assert.equal(params.get('layers'), '0,1,2,3,4,5,6,7,8,9,10,11,12');
      await capture('noaa-fixture');
      return Object.fromEntries(params);
    },
  );
  await step(
    'three genuine provider failures fall back through existing controller to credited OSM',
    async () => {
      await select('esri-ocean');
      failId = 'esri-ocean';
      // Exercise real request rejection; Cesium normally owns raising this event.
      await page.evaluate(async () => {
        const provider =
          window.__godsEyeView.mapStackController._imageryLayer.imageryProvider;
        for (let index = 0; index < 3; index++) {
          try {
            await provider.requestImage(0, index, 2);
            throw new Error('fixture outage did not reject');
          } catch (error) {
            if (error.statusCode !== 503) throw error;
            provider.errorEvent.raiseEvent({
              message: 'Synthetic 503 provider outage',
            });
          }
        }
      });
      await page.waitForFunction(
        () => window.__godsEyeView.mapStackController.getActiveId() === 'osm',
      );
      failId = null;
      return await page.evaluate(() => ({
        active: window.__godsEyeView.mapStackController.getActiveId(),
        lastError: window.__godsEyeView.mapStackController.getState().lastError,
        tak: !!window.__godsEyeView.takClient.client.store.get(
          'QA-MAP-PRESERVE',
        ),
      }));
    },
  );
  await step(
    'reference selector remains usable on a phone with original quick controls',
    async () => {
      await page.setViewport({ width: 390, height: 844 });
      if (
        await page.$eval(
          '#control-panel-toggle',
          (node) => node.getAttribute('aria-expanded') === 'true',
        )
      )
        await page.click('#control-panel-toggle');
      await page.click('#control-panel-toggle');
      await page.waitForSelector('#map-reference-select', { visible: true });
      await select('esri-topo');
      const metrics = await page.$eval('#map-reference-select', (node) => ({
        font: parseFloat(getComputedStyle(node).fontSize),
        height: node.getBoundingClientRect().height,
        width: node.getBoundingClientRect().width,
        viewport: innerWidth,
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
        viewportHeight: innerHeight,
      }));
      assert(metrics.font >= 16);
      assert(metrics.height >= 44);
      assert(metrics.width <= metrics.viewport);
      assert(
        metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight,
        'Phone selector must be inside the visible viewport',
      );
      await capture('phone-reference-selector');
      return metrics;
    },
  );
  const renderErrors = await readRenderErrors(page);
  assert.deepEqual(renderErrors, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(interception.errors, []);
  await fs.writeFile(
    path.join(dir, 'results.json'),
    JSON.stringify(
      {
        status: 'passed',
        at: new Date().toISOString(),
        mode: 'synthetic provider fixtures; real Cesium/UI',
        results,
        requests,
        errors,
        workers,
        workerNetwork,
        fixtureScripts,
        console: monitor.console,
        failedRequests: monitor.failed,
      },
      null,
      2,
    ),
  );
  console.log(`Reference maps: ${results.length} passed; evidence ${dir}`);
} catch (error) {
  await fs.mkdir(dir, { recursive: true });
  await page
    .screenshot({ path: path.join(dir, 'failure.png') })
    .catch(() => {});
  await fs.writeFile(
    path.join(dir, 'results.json'),
    JSON.stringify(
      {
        status: 'failed',
        at: new Date().toISOString(),
        results,
        requests,
        errors,
        workers,
        workerNetwork,
        workerState: await Promise.all(
          page.workers().map(async (worker) => ({
            url: worker.url(),
            state: await Promise.race([
              worker.client.send('Runtime.evaluate', {
                expression:
                  'JSON.stringify({url:location.href,onmessage:typeof self.onmessage})',
                returnByValue: true,
              }),
              new Promise((resolve) =>
                setTimeout(() => resolve('worker evaluation timeout'), 2000),
              ),
            ]).catch((error) => String(error)),
          })),
        ),
        fixtureScripts,
        console: monitor.console,
        failedRequests: monitor.failed,
        documentState: await page
          .evaluate(() => {
            const gev = window.__godsEyeView,
              scene = gev?.viewer?.scene,
              surface = scene?.globe?._surface;
            return {
              visibility: document.visibilityState,
              renderErrors: window.__qaRenderErrors,
              governor: gev?.getRenderGovernorDiagnostics?.(),
              renderRequested: scene?._renderRequested,
              frameNumber: scene?.frameState?.frameNumber,
              useDefaultRenderLoop: gev?.viewer?.useDefaultRenderLoop,
              globeShow: scene?.globe?.show,
              imageryLayers: gev?.viewer?.imageryLayers?.length,
              terrain: gev?.viewer?.terrainProvider?.constructor.name,
              renderLoop: gev?.viewer?._cesiumWidget?._renderLoopRunning,
              roots: surface?._levelZeroTiles?.map((tile) => ({
                level: tile.level,
                state: tile.state,
                renderable: tile.renderable,
                terrainState: tile.data?.terrainState,
                mesh: !!tile.data?.mesh,
                imagery: tile.data?.imagery?.map((item) => ({
                  loading: item.loadingImagery?.state,
                  ready: item.readyImagery?.state,
                })),
              })),
              loadQueue:
                surface &&
                [
                  '_tileLoadQueueHigh',
                  '_tileLoadQueueMedium',
                  '_tileLoadQueueLow',
                  '_tilesToRender',
                ].map((key) => [key, surface[key]?.length]),
              keys: Object.keys(gev || {}),
              loading: document.getElementById('loading-screen')?.className,
              toggle: document.getElementById('control-panel-toggle')
                ?.outerHTML,
              select: document.getElementById('map-reference-select')
                ?.outerHTML,
            };
          })
          .catch(() => null),
        failure: error.stack,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
