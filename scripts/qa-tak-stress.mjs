#!/usr/bin/env node
/** Bounded synthetic contact performance evidence; no peer/network interoperability claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer';
import { interceptFixtures } from './qa-fixtureInterception.mjs';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import {
  hookRenderErrors,
  readRenderErrors,
  watchPage,
} from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const appUrl = new URL(option('--url', 'http://127.0.0.1:4176'));
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname),
  'Stress gate is loopback only',
);
const artifact = path.resolve(
  option('--artifact', 'qa-artifacts/tak/stress.json'),
);
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const browser = await puppeteer.launch({
  headless: true,
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 120000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
  ],
});
const errors = [];
let intercepted = 0;
let page;
let interception;
let stage = 'browser startup';
try {
  page = await browser.newPage();
  page.setDefaultTimeout(90000);
  watchPage(page, { name: '2000-contact-stress', errors });
  await hookRenderErrors(page);
  await page.evaluateOnNewDocument(() => {
    window.__stressUnhandled = [];
    window.addEventListener('unhandledrejection', (event) =>
      window.__stressUnhandled.push(
        String(event.reason?.stack || event.reason),
      ),
    );
  });
  interception = await interceptFixtures(page, {
    origin: appUrl.origin,
    handle: (request) => {
      const url = new URL(request.url());
      const respond = (payload) =>
        void request.respond(payload).catch(() => {});
      // Exercise the existing flat-terrain fallback instead of supplying bogus
      // successful terrain JSON to a quantized-mesh decoder.
      if (url.origin === 'https://terrain.reearth.land') {
        intercepted++;
        return respond({
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '',
        });
      }
      const tileRequest =
        request.method() === 'GET' &&
        ((url.origin === 'https://tile.openstreetmap.org' &&
          /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) ||
          (url.origin === 'https://services.arcgisonline.com' &&
            /\/World_Imagery\/MapServer\/tile\//.test(url.pathname)));
      if (tileRequest) {
        intercepted++;
        return respond({
          status: 200,
          contentType: 'image/jpeg',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: tile,
        });
      }
      if (
        url.origin === 'https://services.arcgisonline.com' &&
        url.pathname.endsWith('/World_Imagery/MapServer')
      )
        return respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({
            currentVersion: 10.81,
            fullExtent: {
              xmin: -20037508.342787,
              ymin: -20037508.342787,
              xmax: 20037508.342787,
              ymax: 20037508.342787,
              spatialReference: { wkid: 102100 },
            },
            tileInfo: {
              rows: 256,
              cols: 256,
              origin: { x: -20037508.342787, y: 20037508.342787 },
              spatialReference: { wkid: 102100 },
              lods: Array.from({ length: 20 }, (_, level) => ({
                level,
                resolution: 156543.033928 / 2 ** level,
                scale: 591657527.591555 / 2 ** level,
              })),
            },
          }),
        });
      if (
        (url.origin === appUrl.origin &&
          url.pathname.startsWith('/api/') &&
          !url.pathname.startsWith('/api/tak/')) ||
        (url.protocol.startsWith('http') && url.origin !== appUrl.origin)
      ) {
        intercepted++;
        return respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '{}',
        });
      }
      void request.continue().catch(() => {});
    },
  });
  appUrl.hash =
    'lat=34.3665&lon=-89.5192&alt=50000&heading=0&pitch=-70&map=osm&b=0';
  stage = 'app startup';
  await page.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      !!window.__godsEyeView?.takClient && !!window.__godsEyeView?.dataManager,
  );
  await page.evaluate(() =>
    document.querySelector('.first-run-explore')?.click(),
  );
  await page.waitForFunction(() => {
    const el = document.getElementById('loading-screen');
    return (
      !el ||
      el.classList.contains('hidden') ||
      getComputedStyle(el).display === 'none'
    );
  });
  await page.click('.tak-web-launcher');
  await page.waitForSelector('#tak-web-panel:not([hidden])');
  stage = 'synthetic globe tile readiness';
  await page.waitForFunction(
    () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 15000, polling: 250 },
  );
  stage = 'contact measurement';
  const measurements = await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const tak = gev.takClient;
    const { getWorldOverlayDiagnostics } =
      await import('/src/overlays/worldOverlay.js');
    const { getRenderGovernorDiagnostics } =
      await import('/src/renderGovernor.js');
    gev.viewer.scene.postProcessStages.bloom.enabled = false;
    tak.client.disconnect();
    tak.client.store.clear();
    const source = () => gev.viewer.dataSources.getByName('TAK contacts')[0];
    const heap = () => performance.memory?.usedJSHeapSize ?? null;
    const frame = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => resolve(performance.now())),
      );
    const settle = async () => {
      gev.viewer.scene.requestRender();
      await frame();
      await frame();
    };
    function event(index, update = false) {
      const ms = Date.now() + (update ? 1000 : 0);
      const time = new Date(ms).toISOString();
      const lat =
        34.3 + Math.floor(index / 45) * 0.003 + (update ? 0.00001 : 0);
      const lon = -89.6 + (index % 45) * 0.003;
      return `<event version="2.0" uid="SYNTHETIC-STRESS-${index}" type="a-f-G-U-C" how="h-e" time="${time}" start="${time}" stale="${new Date(ms + 600000).toISOString()}"><point lat="${lat}" lon="${lon}" hae="9999999" ce="15" le="9999999"/><detail><contact callsign="SYNTHETIC ${index}"/></detail></event>`;
    }
    globalThis.gc?.();
    await settle();
    const baseline = {
      heapBytes: heap(),
      domNodes: document.querySelectorAll('*').length,
      layers: [...gev.dataManager.layers.keys()].sort(),
      map: gev.mapStackController.getActiveId(),
      globeTilesLoaded: gev.viewer.scene.globe.tilesLoaded,
      requestRenderMode: gev.viewer.scene.requestRenderMode,
      renderGovernor: getRenderGovernorDiagnostics(),
      camera: {
        latitude: gev.viewer.camera.positionCartographic.latitude,
        longitude: gev.viewer.camera.positionCartographic.longitude,
        height: gev.viewer.camera.positionCartographic.height,
      },
    };
    const longTasks = [];
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    observer.observe({ type: 'longtask', buffered: false });
    const imports = [];
    const allStart = performance.now();
    for (let start = 0; start < 2000; start += 100) {
      const xml = Array.from({ length: 100 }, (_, offset) =>
        event(start + offset),
      ).join('');
      const before = performance.now();
      tak.client.importXml(xml);
      imports.push(performance.now() - before);
      await settle();
    }
    const importWallMs = performance.now() - allStart;
    const full = {
      contacts: tak.client.store.count(),
      entities: source().entities.values.length,
      rosterRows: document.querySelectorAll(
        '.tak-web-contact-row[data-tak-uid]',
      ).length,
      diagnostics: getWorldOverlayDiagnostics(),
      heapBytes: heap(),
      domNodes: document.querySelectorAll('*').length,
      resourceStats: tak.client.store.resourceStats?.() ?? null,
      requestRenderMode: gev.viewer.scene.requestRenderMode,
      renderGovernor: getRenderGovernorDiagnostics(),
    };
    let definitionsChanged = 0;
    const removers = source().entities.values.map((entity) =>
      entity.definitionChanged.addEventListener(() => definitionsChanged++),
    );
    const updateStart = performance.now();
    tak.client.importXml(event(1000, true));
    const oneUpdateMs = performance.now() - updateStart;
    const settleStart = performance.now();
    await settle();
    const updateSettleMs = performance.now() - settleStart;
    for (const remove of removers) remove();
    const samples = [];
    let sceneFrames = 0;
    const stopFrameCounter = gev.viewer.scene.postRender.addEventListener(
      () => sceneFrames++,
    );
    let last = await frame();
    for (let i = 0; i < 45; i++) {
      const current = await frame();
      samples.push(current - last);
      last = current;
    }
    stopFrameCounter();
    const overflowStart = performance.now();
    tak.client.importXml(
      Array.from({ length: 100 }, (_, offset) => event(2000 + offset)).join(''),
    );
    const overflowMs = performance.now() - overflowStart;
    await settle();
    const overflow = {
      contacts: tak.client.store.count(),
      entities: source().entities.values.length,
      oldestEvicted: !tak.client.store.get('SYNTHETIC-STRESS-0'),
    };
    const clearStart = performance.now();
    tak.client.store.clear();
    const clearMs = performance.now() - clearStart;
    await settle();
    const cleared = {
      contacts: tak.client.store.count(),
      entities: source().entities.values.length,
      overlayEntries:
        getWorldOverlayDiagnostics().entriesBySource['tak-contacts'] ?? 0,
    };
    globalThis.gc?.();
    const retainedHeapBytes = heap();
    const layersAfter = [...gev.dataManager.layers.keys()].sort();
    tak.destroy();
    tak.destroy();
    await settle();
    observer.disconnect();
    return {
      baseline,
      importBatchSize: 100,
      importBatchMs: imports,
      importCpuMs: imports.reduce((a, b) => a + b, 0),
      importWallMs,
      full,
      oneUpdateMs,
      entityDefinitionChangesForOneUpdate: definitionsChanged,
      updateSettleMs,
      frameIntervalsMs: samples,
      observedSceneFrames: sceneFrames,
      frameWindowMs: samples.reduce((sum, value) => sum + value, 0),
      overflowMs,
      overflow,
      clearMs,
      cleared,
      retainedHeapBytes,
      layersAfter,
      longTaskMs: longTasks,
      destroyed: {
        takRoots: document.querySelectorAll('.tak-web-root').length,
        sourceExists:
          gev.viewer.dataSources.getByName('TAK contacts').length > 0,
        overlayEntries:
          getWorldOverlayDiagnostics().entriesBySource['tak-contacts'] ?? 0,
      },
      unhandled: window.__stressUnhandled,
    };
  });
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(
    `${artifact}.measurements.json`,
    JSON.stringify(measurements, null, 2),
  );
  const expectedLayers = [
    ...LAYER_STATE_REGISTRY.map((entry) => entry.id),
    'local-adsb',
  ].sort();
  assert.deepEqual(measurements.baseline.layers, expectedLayers);
  assert.deepEqual(measurements.layersAfter, expectedLayers);
  assert.equal(measurements.full.contacts, 2000);
  assert.equal(measurements.full.entities, 2000);
  assert.ok(measurements.full.rosterRows <= 150);
  if (args.includes('--expect-cached'))
    assert.equal(measurements.entityDefinitionChangesForOneUpdate, 1);
  assert.equal(measurements.overflow.contacts, 2000);
  assert.equal(measurements.overflow.oldestEvicted, true);
  assert.deepEqual(measurements.cleared, {
    contacts: 0,
    entities: 0,
    overlayEntries: 0,
  });
  assert.deepEqual(measurements.destroyed, {
    takRoots: 0,
    sourceExists: false,
    overlayEntries: 0,
  });
  errors.push(...(await readRenderErrors(page)), ...measurements.unhandled);
  errors.push(...interception.errors);
  assert.deepEqual(errors, []);
  const sorted = measurements.frameIntervalsMs.slice().sort((a, b) => a - b);
  const output = {
    date: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    browser: await browser.version(),
    renderer:
      'headless Chromium ANGLE SwiftShader; synthetic tiles/providers; foreground desktop viewport1440x900; not real phone/GPU/live-layer load',
    interceptedRequests: intercepted,
    frameMedianMs: sorted[Math.floor(sorted.length / 2)],
    frameP95Ms: sorted[Math.floor(sorted.length * 0.95)],
    measurements,
    errors,
  };
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      artifact,
      importCpuMs: measurements.importCpuMs,
      importWallMs: measurements.importWallMs,
      oneUpdateMs: measurements.oneUpdateMs,
      changedEntities: measurements.entityDefinitionChangesForOneUpdate,
      frameMedianMs: output.frameMedianMs,
      frameP95Ms: output.frameP95Ms,
      clearMs: measurements.clearMs,
      fullHeapBytes: measurements.full.heapBytes,
      retainedHeapBytes: measurements.retainedHeapBytes,
      rosterRows: measurements.full.rosterRows,
      layers: measurements.layersAfter.length,
    }),
  );
} catch (error) {
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  let diagnostics;
  try {
    diagnostics = await page?.evaluate(() => {
      const gev = window.__godsEyeView;
      const globe = gev?.viewer?.scene?.globe;
      return {
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        hidden: document.hidden,
        useDefaultRenderLoop: gev?.viewer?.useDefaultRenderLoop,
        requestRenderMode: gev?.viewer?.scene?.requestRenderMode,
        globeTilesLoaded: globe?.tilesLoaded,
        terrain: globe?.terrainProvider?.constructor?.name,
        contacts: gev?.takClient?.client?.store?.count(),
        governor: gev?.getRenderGovernorDiagnostics?.(),
      };
    });
    await page?.screenshot({ path: `${artifact}.failure.png` });
  } catch (captureError) {
    diagnostics = { captureError: String(captureError) };
  }
  await fs.writeFile(
    `${artifact}.failure.json`,
    JSON.stringify(
      {
        failed: true,
        stage,
        diagnostics,
        error: String(error.stack || error),
        errors,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
