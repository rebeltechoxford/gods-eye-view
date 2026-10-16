#!/usr/bin/env node
/** Actual HTTPS/UI/IndexedDB/SW/Cesium outage acceptance with synthetic map bytes. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import {
  startTakHttpsServer,
  SESSION_TTL_MS,
} from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import {
  hookRenderErrors,
  readRenderErrors,
  redact,
} from './qa-browserEvidence.mjs';
import { interceptFixtures } from './qa-fixtureInterception.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert(
    args[index + 1] && !args[index + 1].startsWith('--'),
    `${name} requires a value`,
  );
  return args[index + 1];
}
const distRoot = path.resolve(root, option('--dist', 'dist'));
const fontProvenanceBytes = await fs.readFile(
  path.join(root, 'public/fonts/provenance.json'),
);
const fontProvenance = JSON.parse(fontProvenanceBytes.toString('utf8'));
const expectedFontFiles = [
  fontProvenance.stylesheet,
  ...fontProvenance.assets,
  ...fontProvenance.licenses,
  {
    path: '/fonts/provenance.json',
    bytes: fontProvenanceBytes.length,
    sha256: createHash('sha256').update(fontProvenanceBytes).digest('hex'),
  },
].map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
const artifacts = path.resolve(
  root,
  option('--artifact-dir', 'qa-artifacts/offline-maps'),
);
const timeout = Number(option('--timeout', '180000'));
assert(Number.isFinite(timeout) && timeout >= 1000);
await fs.access(path.join(distRoot, 'gev-sw.js'));
await fs.mkdir(artifacts, { recursive: true });
const downloads = path.join(artifacts, 'exports');
await fs.mkdir(downloads, { recursive: true });
const fixtureRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'gev-offline-browser-'),
);
const certificates = createTakTlsFixtures();
const operatorToken = randomBytes(32).toString('hex');
const spki = createHash('sha256')
  .update(
    new X509Certificate(certificates.read('server.pem')).publicKey.export({
      type: 'spki',
      format: 'der',
    }),
  )
  .digest('base64');
const image = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const expectedTileHash = createHash('sha256').update(image).digest('hex');
const secretSentinel = 'SYNTHETIC-OFFLINE-PRIVATE-NOT-CACHED';
const firstName = 'Synthetic retained map';
const secondName = 'Synthetic cancelled map';
const results = [];
const errors = [];
const externalRequests = [];
const outageMapRequests = [];
const outageFontRequests = [];
const pages = [];
const interceptions = [];
const pageInterceptions = new WeakMap();
const unloadSnapshots = [];
const expiredShellResponses = [];
const tileRequests = [];
const savedEnvironment = ['AISSTREAM_API_KEY', 'LOCAL_RECEIVER_FEEDS'].map(
  (name) => [name, process.env[name]],
);
let browser, instance, origin;
let outage = false;
let tileDelay = 5;
let activeDownloads = 0;
let maximumDownloads = 0;
let firstId;
let nowMs = Date.now();
const scrub = (value) => redact(value).replaceAll(operatorToken, 'REDACTED');
const mapHost = (url) =>
  /(?:openstreetmap\.org|arcgisonline\.com|reearth\.land|cesium\.com|cesium\.io|nationalmap\.gov)$/.test(
    url.hostname,
  ) || url.hostname === 'maps.googleapis.com';

async function step(name, action) {
  const started = Date.now();
  console.log(`running ${name}`);
  const evidence = await action();
  results.push({
    name,
    passed: true,
    elapsedMs: Date.now() - started,
    ...(evidence ? { evidence } : {}),
  });
  console.log(`ok ${results.length} ${name}`);
}
async function startServer(port = 0) {
  const app = await startTakHttpsServer({
    env: {
      TAK_HTTPS_HOST: '127.0.0.1',
      TAK_GATEWAY_TOKEN: operatorToken,
      TAK_HTTPS_CERT: certificates.file('server.pem'),
      TAK_HTTPS_KEY: certificates.file('server.key'),
    },
    distRoot,
    port,
    now: () => nowMs,
    offlineMaps: {
      root: path.join(fixtureRoot, 'packs'),
      async fetchImpl(url, { signal, redirect, headers }) {
        assert.match(
          url,
          /^https:\/\/basemap\.nationalmap\.gov\/arcgis\/rest\/services\/USGSTopo\/MapServer\/tile\/\d+\/\d+\/\d+$/,
        );
        assert.equal(redirect, 'manual');
        assert.equal(headers.Authorization, undefined);
        tileRequests.push(new URL(url).pathname);
        activeDownloads++;
        maximumDownloads = Math.max(maximumDownloads, activeDownloads);
        try {
          await new Promise((resolve, reject) => {
            const done = () => {
              signal.removeEventListener('abort', aborted);
              resolve();
            };
            const timer = setTimeout(done, tileDelay);
            const aborted = () => {
              clearTimeout(timer);
              reject(new Error('Synthetic cancellation'));
            };
            signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted) aborted();
          });
          return new Response(image, {
            headers: { 'Content-Type': 'image/jpeg' },
          });
        } finally {
          activeDownloads--;
        }
      },
    },
  });
  assert.equal(new URL(app.origin).hostname, '127.0.0.1');
  app.server.prependListener('request', (request, response) => {
    if (request.url === '/api/maps/offline/shell')
      response.once('finish', () => {
        if (response.statusCode === 401) expiredShellResponses.push(401);
      });
  });
  return app;
}
async function tap(page, selectorOrText, rowName, { panelOpen } = {}) {
  const handle = rowName
    ? await page.evaluateHandle(
        (name, text) => {
          const row = [
            ...document.querySelectorAll('[data-offline-list] li'),
          ].find((item) =>
            item.querySelector('p')?.textContent.startsWith(name + ' ·'),
          );
          return row
            ? [...row.querySelectorAll('button')].find(
                (button) => button.textContent === text,
              )
            : null;
        },
        rowName,
        selectorOrText,
      )
    : await page.$(selectorOrText);
  const element = handle?.asElement ? handle.asElement() : handle;
  assert(element, `Missing UI control ${selectorOrText}`);
  await element.evaluate((el) =>
    el.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const point = await element.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2,
      y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      visible: !!hit && (hit === el || el.contains(hit)) && !el.disabled,
      disabled: !!el.disabled,
      hit: hit?.tagName + '.' + hit?.className,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  });
  assert(
    point.visible,
    `Covered, disabled or unreachable UI control ${selectorOrText}: ${JSON.stringify(point)}`,
  );
  const marker = `QA offline tap ${Date.now()} ${selectorOrText}`;
  let listener, timer;
  const delivered =
    panelOpen === undefined
      ? new Promise((resolve, reject) => {
          listener = (message) => {
            if (message.text() === marker) resolve();
          };
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `Physical tap did not deliver a click: ${selectorOrText}`,
                ),
              ),
            10000,
          );
          page.on('console', listener);
        })
      : page
          .waitForFunction(
            (open) =>
              document.querySelector('#tak-web-panel')?.hidden === !open &&
              document
                .querySelector('.tak-web-launcher')
                ?.getAttribute('aria-expanded') === String(open),
            { timeout: 10000, polling: 50 },
            panelOpen,
          )
          .then((result) => result.dispose());
  // Handle rejection immediately even if registering the DOM click observer or
  // dispatching native input stalls. Failure still propagates through Promise.all.
  void delivered.catch(() => {});
  try {
    if (panelOpen === undefined)
      await element.evaluate(
        (el, text) =>
          el.addEventListener('click', () => console.debug(text), {
            once: true,
          }),
        marker,
      );
    await Promise.all([page.touchscreen.tap(point.x, point.y), delivered]);
  } finally {
    clearTimeout(timer);
    if (listener) page.off('console', listener);
    await handle.dispose().catch(() => {});
  }
}
async function setPanelOpen(page, open) {
  const already = await page.$eval('#tak-web-panel', (el) => !el.hidden);
  if (already === open) return;
  await tap(page, '.tak-web-launcher', undefined, { panelOpen: open });
}
async function idle(page) {
  await page.waitForFunction(
    () => document.querySelector('[data-offline-cancel]')?.hidden === true,
    { timeout },
  );
}
async function openMaps(page) {
  await setPanelOpen(page, true);
  await page.$eval('[data-tak-section="maps"]', async (el) => {
    if (el.open) return;
    await new Promise((resolve) => {
      el.addEventListener('toggle', resolve, { once: true });
      el.open = true;
    });
  });
  await idle(page);
}
async function boot(page, { hasShareState = false } = {}) {
  await page.waitForFunction(
    () => !!window.__godsEyeView?.takClient?.savedMaps,
    { timeout },
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout },
  );
  if (
    !hasShareState &&
    !(await page.evaluate(
      () =>
        sessionStorage.getItem('gev:first-run-mission-session:v1') ===
        'dismissed',
    ))
  ) {
    await page.waitForSelector('#first-run-launcher.visible', { timeout });
    await tap(page, '.first-run-explore');
    await page.waitForFunction(
      () =>
        !document
          .getElementById('first-run-launcher')
          ?.classList.contains('visible'),
      { timeout },
    );
  }
  await openMaps(page);
}
async function pageForRun() {
  const page = await browser.newPage();
  pages.push(page);
  await page.exposeFunction('__qaRecordOfflineUnload', (snapshot) =>
    unloadSnapshots.push(snapshot),
  );
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(timeout);
  await hookRenderErrors(page);
  page.on('pageerror', (error) => errors.push(scrub(error.message)));
  page.on('console', (message) => {
    if (
      /An error occurred while rendering|initialization failed|QA unhandled promise/i.test(
        message.text(),
      )
    )
      errors.push(scrub(message.text()));
  });
  await page.evaluateOnNewDocument(() => {
    window.__offlineInputTrace = [];
    for (const type of [
      'pointerdown',
      'pointerup',
      'touchstart',
      'touchend',
      'click',
    ])
      document.addEventListener(
        type,
        (event) => {
          const point = event.changedTouches?.[0] || event;
          const trace = window.__offlineInputTrace;
          trace.push({
            type,
            at: Math.round(performance.now()),
            target:
              event.target?.tagName + '.' + String(event.target?.className),
            x: point.clientX,
            y: point.clientY,
            pointerType: event.pointerType || null,
            defaultPrevented: event.defaultPrevented,
            panelHidden: document.querySelector('#tak-web-panel')?.hidden,
          });
          if (trace.length > 100) trace.shift();
        },
        { capture: true },
      );
    window.addEventListener('beforeunload', () => {
      const tak = window.__godsEyeView?.takClient;
      if (!tak) return;
      void window
        .__qaRecordOfflineUnload({
          contacts: tak.client.store.count(),
          chats: tak.client.store.chats().length,
          fix: tak.client.fix() ? true : null,
          sa: tak.client.saEnabled(),
          authorized: tak.privacy().authorized,
          privateInputs: [
            ...document.querySelectorAll(
              '.tak-web-root input:not([type="checkbox"]),.tak-web-root textarea',
            ),
          ].some((el) => el.value !== ''),
          disclosure: document.querySelector('[data-tak-disclosure]')?.checked,
          markerShare: document.querySelector('[data-tak-marker-broadcast]')
            ?.checked,
        })
        .catch(() => {});
    });
    window.__offlineUnhandled = [];
    window.addEventListener('unhandledrejection', (event) => {
      window.__offlineUnhandled.push(
        String(event.reason?.message || event.reason),
      );
      console.error('QA unhandled promise');
    });
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
    eventsEnabled: true,
  });
  page.on('request', (request) => {
    if (request.url().includes(operatorToken))
      errors.push('Credential in request URL');
  });
  const interception = await interceptFixtures(page, {
    origin,
    includePaths: ['/login', '/logout'],
    handle: async (request) => {
      try {
        const url = new URL(request.url());
        assert(!url.href.includes(operatorToken), 'Credential in request URL');
        if (url.origin === origin) {
          if (
            url.pathname.startsWith('/api/') &&
            !/^\/api\/(?:tak|maps\/offline)(?:\/|$)/.test(url.pathname)
          ) {
            if (outage) return await request.abort('internetdisconnected');
            return await request.respond({
              status: 200,
              contentType: 'application/json',
              body: '{}',
            });
          }
          // During outage the actual closed HTTPS listener must fail, allowing
          // the real service worker to supply only its verified saved assets.
          return await request.continue();
        }
        if (!url.protocol.startsWith('http')) return await request.continue();
        externalRequests.push({
          host: url.hostname,
          path: url.pathname,
          outage,
        });
        if (outage) {
          if (mapHost(url)) outageMapRequests.push(url.hostname + url.pathname);
          if (
            ['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)
          )
            outageFontRequests.push(url.hostname + url.pathname);
          return await request.abort('internetdisconnected');
        }
        if (url.hostname === 'terrain.reearth.land')
          return await request.respond({
            status: 400,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: '{}',
          });
        if (
          /\/tile\/\d+\/\d+\/\d+$/.test(url.pathname) ||
          /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
        )
          return await request.respond({
            status: 200,
            contentType: 'image/jpeg',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: image,
          });
        return await request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '{}',
        });
      } catch (error) {
        errors.push(scrub(error.message));
        await request.abort().catch(() => {});
      }
    },
  });
  interceptions.push(interception);
  pageInterceptions.set(page, interception);
  await page.bringToFront();
  return page;
}
async function login(page) {
  await page.goto(origin + '/login', {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await page.type('input[name="token"]', operatorToken);
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
    tap(page, 'form button'),
  ]);
  assert.equal(
    response.status(),
    200,
    'Native login must reach the built application',
  );
  await boot(page);
}
async function fillArea(page, name, maximum = 2) {
  await page.evaluate(
    (label, zoom) => {
      const values = {
        name: label,
        west: -180,
        east: 180,
        south: -80,
        north: 80,
        min: 0,
        max: zoom,
      };
      for (const [key, value] of Object.entries(values)) {
        const input = document.querySelector(`[data-offline-${key}]`);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('[data-offline-phone]').checked = true;
    },
    name,
    maximum,
  );
}
async function dbSnapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('gev-offline-maps-v1', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = (store) =>
        new Promise((resolve, reject) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const packs = await read('packs');
      const tiles = await read('tiles');
      const settings = await read('settings');
      const failures = [];
      for (const tile of tiles) {
        const expected = packs.find((pack) => pack.id === tile.packId)?.tiles[
          tile.key
        ];
        const bytes = new Uint8Array(tile.bytes);
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
        ]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
        if (
          !expected ||
          expected.sha256 !== hash ||
          expected.bytes !== bytes.byteLength ||
          expected.contentType !== tile.contentType
        )
          failures.push(tile.key);
      }
      return {
        packs,
        tileCount: tiles.length,
        hashFailures: failures,
        selected:
          settings.find((setting) => setting.key === 'selected')?.packId ||
          null,
      };
    } finally {
      db.close();
    }
  });
}
async function serverPacks(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/maps/offline/packs', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Map list refused (${response.status})`);
    return (await response.json()).packs;
  });
}
async function rowReady(page, name) {
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll('[data-offline-list] li p')].some(
        (el) =>
          el.textContent.startsWith(label + ' ·') &&
          el.textContent.includes('device ready'),
      ),
    { timeout, polling: 100 },
    name,
  );
}
async function renderEvidence(page, id) {
  await page.waitForFunction(
    (packId) =>
      window.__godsEyeView?.mapStackController?.getActiveId() ===
        `offline-${packId}` &&
      window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 60000, polling: 250 },
    id,
  );
  return page.evaluate(async (packId) => {
    const gev = window.__godsEyeView,
      viewer = gev.viewer;
    viewer.scene.postProcessStages.bloom.enabled = false;
    const layer = viewer.imageryLayers.get(0),
      provider = layer.imageryProvider;
    const terrain = viewer.terrainProvider;
    const terrainTile = await terrain.requestTileGeometry(0, 0, 0);
    const terrainRectangle = terrain.tilingScheme.tileXYToRectangle(0, 0, 0);
    const terrainSamples = [0.25, 0.5, 0.75].map((fraction) =>
      terrainTile.interpolateHeight(
        terrainRectangle,
        terrainRectangle.west +
          (terrainRectangle.east - terrainRectangle.west) * fraction,
        terrainRectangle.south +
          (terrainRectangle.north - terrainRectangle.south) * fraction,
      ),
    );
    const decoded = await provider.requestImage(0, 0, 0);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    context.drawImage(decoded, 0, 0, 256, 256);
    const pixels = context.getImageData(0, 0, 256, 256).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 64)
      colors.add(
        `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]},${pixels[i + 3]}`,
      );
    const rendered = (viewer.scene.globe._surface?._tilesToRender || []).filter(
      (tile) =>
        tile.data?.imagery?.some(
          (item) =>
            item.readyImagery?.imageryLayer === layer &&
            (item.readyImagery?.texture ||
              item.readyImagery?.textureWebMercator),
        ),
    ).length;
    const panelBounds = document
      .querySelector('#tak-web-panel')
      .getBoundingClientRect();
    const mapInputs = [
      ...document.querySelectorAll('[data-offline-form] input[type="number"]'),
    ].map((input) => {
      const bounds = input.getBoundingClientRect();
      const labelBounds = input.closest('label').getBoundingClientRect();
      return {
        field: [...input.attributes].find((attribute) =>
          attribute.name.startsWith('data-offline-'),
        )?.name,
        left: bounds.left,
        right: bounds.right,
        width: bounds.width,
        height: bounds.height,
        labelLeft: labelBounds.left,
        labelRight: labelBounds.right,
      };
    });
    return {
      activeId: gev.mapStackController.getActiveId(),
      terrain: gev.mapStackController._terrainMode,
      flatTerrain:
        terrainSamples.every((height) => height === 0) &&
        terrain.hasWaterMask === false &&
        terrain.hasVertexNormals === false &&
        terrain.availability === undefined,
      terrainSamples,
      tileWidth: decoded.width,
      tileHeight: decoded.height,
      distinctSampledColors: colors.size,
      renderedTiles: rendered,
      layers: [...gev.dataManager.layers.keys()].sort(),
      contacts: gev.takClient.client.store.count(),
      chats: gev.takClient.client.store.chats().length,
      online: navigator.onLine,
      credit:
        document.querySelector('.cesium-credit-logoContainer')?.parentElement
          ?.textContent || document.body.textContent,
      camera: {
        lat: viewer.camera.positionCartographic.latitude,
        lon: viewer.camera.positionCartographic.longitude,
        height: viewer.camera.positionCartographic.height,
      },
      packId,
      inputLayout: {
        viewportWidth: innerWidth,
        panelLeft: panelBounds.left,
        panelRight: panelBounds.right,
        fields: mapInputs,
      },
    };
  }, id);
}
async function cacheEvidence(page) {
  return page.evaluate(
    async (token, sentinel, expectedFonts) => {
      const names = await caches.keys();
      const paths = [];
      const verifiedFontFiles = [];
      let bytes = 0;
      for (const name of names)
        for (const request of await (await caches.open(name)).keys()) {
          const url = new URL(request.url);
          paths.push(url.pathname);
          if (
            url.origin !== location.origin ||
            url.search ||
            /^\/(?:api|login|logout)(?:\/|$)/.test(url.pathname)
          )
            throw new Error(
              'An API, credential route or foreign response was cached',
            );
          const response = await (await caches.open(name)).match(request);
          if (response.headers.has('set-cookie'))
            throw new Error('A credential cookie was cached');
          const value = await response.arrayBuffer();
          bytes += value.byteLength;
          const expectedFont = expectedFonts.find(
            (file) => file.path === url.pathname,
          );
          if (expectedFont) {
            const hash = [
              ...new Uint8Array(await crypto.subtle.digest('SHA-256', value)),
            ]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join('');
            if (
              hash !== expectedFont.sha256 ||
              (Number.isInteger(expectedFont.bytes) &&
                expectedFont.bytes !== value.byteLength)
            )
              throw new Error(
                `Saved font file integrity mismatch: ${url.pathname}`,
              );
            verifiedFontFiles.push(url.pathname);
          }
          const text = new TextDecoder().decode(value);
          if (text.includes(token) || text.includes(sentinel))
            throw new Error('Runtime credential or tactical data was cached');
        }
      for (const value of Object.values(localStorage))
        if (String(value).includes(token) || String(value).includes(sentinel))
          throw new Error('Runtime private data leaked to localStorage');
      for (const file of expectedFonts)
        if (!verifiedFontFiles.includes(file.path))
          throw new Error(
            `Offline application omitted font asset or notice: ${file.path}`,
          );
      return {
        cacheCount: names.length,
        files: paths.length,
        bytes,
        workers: paths.filter((pathname) =>
          pathname.startsWith('/cesium/Workers/'),
        ).length,
        hasIndex: paths.includes('/index.html'),
        fonts: paths.filter((pathname) =>
          /\.(?:woff2?|ttf|otf)$/.test(pathname),
        ),
        verifiedFontFiles,
      };
    },
    operatorToken,
    secretSentinel,
    expectedFontFiles,
  );
}
async function fontEvidence(page) {
  const evidence = await page.evaluate(async () => {
    let timer;
    const faces = await Promise.race([
      document.fonts.load('24px "Material Symbols Outlined"', 'public'),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Saved icon font did not load')),
          6000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const probe = document.createElement('span');
    probe.textContent = 'public';
    Object.assign(probe.style, {
      position: 'absolute',
      left: '-10000px',
      top: '0',
      display: 'inline-block',
      width: 'auto',
      overflow: 'visible',
      fontFamily: '"Material Symbols Outlined"',
      fontSize: '24px',
      fontWeight: '400',
      fontStyle: 'normal',
      fontFeatureSettings: '"liga"',
      whiteSpace: 'nowrap',
    });
    document.body.append(probe);
    try {
      return {
        loadedFaces: faces.map((face) => ({
          family: face.family,
          status: face.status,
        })),
        glyphWidth: probe.getBoundingClientRect().width,
      };
    } finally {
      probe.remove();
    }
  });
  assert(
    evidence.loadedFaces.some(
      (face) =>
        face.family.includes('Material Symbols Outlined') &&
        face.status === 'loaded',
    ),
    'Saved Material Symbols face must actually load',
  );
  assert(
    evidence.glyphWidth > 0 && evidence.glyphWidth <= 32,
    'The public ligature must render as one 24px icon rather than fallback text',
  );
  return evidence;
}
async function screenshot(page, name) {
  await page.addStyleTag({
    content: 'input[type=password],[data-tak-uid]{visibility:hidden!important}',
  });
  await page.screenshot({ path: path.join(artifacts, name), fullPage: false });
}
async function collectErrors(page) {
  errors.push(...(await readRenderErrors(page)));
  errors.push(...(await page.evaluate(() => window.__offlineUnhandled || [])));
}

try {
  for (const [name] of savedEnvironment) process.env[name] = '';
  instance = await startServer();
  origin = instance.origin;
  browser = await puppeteer.launch({
    headless: !args.includes('--headful'),
    protocolTimeout: timeout,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  let page = await pageForRun();
  await step(
    'native HTTPS login and actual Saved Maps UI create both retained copies plus the verified shell',
    async () => {
      await login(page);
      await fillArea(page, firstName);
      await tap(page, '[data-offline-form] button[type=submit]');
      await idle(page);
      await rowReady(page, firstName);
      const local = await dbSnapshot(page);
      const server = await serverPacks(page);
      const pack = local.packs.find((item) => item.name === firstName);
      assert.equal(pack.state, 'ready');
      firstId = pack.id;
      assert.equal(server.find((item) => item.id === firstId).state, 'ready');
      assert.equal(pack.completedTiles, 21);
      assert.equal(local.tileCount, 21);
      assert.deepEqual(local.hashFailures, []);
      assert.equal(local.selected, firstId);
      assert.ok(
        Object.values(pack.tiles).every(
          (tile) => tile.sha256 === expectedTileHash,
        ),
      );
      const shell = await cacheEvidence(page);
      assert(shell.hasIndex && shell.workers > 0);
      return { tiles: pack.completedTiles, shell, serverAndDeviceReady: true };
    },
  );
  await step(
    'selected local Cesium imagery decodes nonblank pixels with flat terrain and all GEV layers',
    async () => {
      const evidence = await renderEvidence(page, firstId);
      assert.equal(evidence.terrain, 'offline-ellipsoid');
      assert.equal(evidence.flatTerrain, true);
      assert.equal(evidence.tileWidth, 256);
      assert.equal(evidence.tileHeight, 256);
      assert(evidence.distinctSampledColors > 16);
      assert(evidence.renderedTiles > 0);
      assert.match(evidence.credit, /USGS The National Map/);
      assert.ok(evidence.credit.includes(`Saved map: ${firstName}`));
      assert.match(evidence.credit, /Flat ellipsoid terrain/);
      assert.equal(evidence.inputLayout.viewportWidth, 390);
      assert.equal(evidence.inputLayout.fields.length, 6);
      for (const input of evidence.inputLayout.fields) {
        assert(
          input.left >= evidence.inputLayout.panelLeft &&
            input.right <= evidence.inputLayout.panelRight,
          `${input.field} must remain inside the 390px phone panel`,
        );
        assert(
          input.left >= input.labelLeft - 1 &&
            input.right <= input.labelRight + 1,
          `${input.field} must remain inside its own number-field label`,
        );
        assert(
          input.width >= 100 && input.height >= 44,
          `${input.field} must provide a readable phone-width field and 44px touch height`,
        );
      }
      assert.deepEqual(
        evidence.layers,
        [...LAYER_STATE_REGISTRY.map((entry) => entry.id), 'local-adsb'].sort(),
      );
      await screenshot(page, 'retained-map.png');
      return {
        terrain: evidence.terrain,
        renderedTiles: evidence.renderedTiles,
        colors: evidence.distinctSampledColors,
        layerCount: evidence.layers.length,
        inputLayout: evidence.inputLayout,
      };
    },
  );
  await step(
    'actual backup export, device deletion and file-input import preserve verified tiles',
    async () => {
      await tap(page, 'Export backup', firstName);
      await idle(page);
      let backup;
      for (let i = 0; i < 100; i++) {
        backup = (await fs.readdir(downloads)).find(
          (name) => name === `${firstId}.gevmap`,
        );
        if (backup) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert(backup, 'The browser must produce a .gevmap download');
      await tap(page, 'Delete device copy', firstName);
      await idle(page);
      assert(
        !(await dbSnapshot(page)).packs.some((pack) => pack.id === firstId),
      );
      await (
        await page.$('[data-offline-import]')
      ).uploadFile(path.join(downloads, backup));
      await idle(page);
      await rowReady(page, firstName);
      const restored = await dbSnapshot(page);
      assert.equal(
        restored.packs.find((pack) => pack.id === firstId).state,
        'ready',
      );
      assert.deepEqual(restored.hashFailures, []);
      return {
        backupBytes: (await fs.stat(path.join(downloads, backup))).size,
        restoredTiles: restored.tileCount,
      };
    },
  );
  await step(
    'UI cancellation retains progress and UI resume completes the server/device copies',
    async () => {
      tileDelay = 200;
      await fillArea(page, secondName, 3);
      await tap(page, '[data-offline-form] button[type=submit]');
      await page.waitForFunction(
        async (name) => {
          const response = await fetch('/api/maps/offline/packs', {
            cache: 'no-store',
          });
          const pack = (await response.json()).packs.find(
            (item) => item.name === name,
          );
          return (
            pack?.completedTiles >= 4 && pack.completedTiles < pack.plannedTiles
          );
        },
        { timeout, polling: 100 },
        secondName,
      );
      await tap(page, '[data-offline-cancel]');
      await idle(page);
      await page.waitForFunction(
        async (name) =>
          (
            await (
              await fetch('/api/maps/offline/packs', { cache: 'no-store' })
            ).json()
          ).packs.find((item) => item.name === name)?.state === 'cancelled',
        { timeout, polling: 100 },
        secondName,
      );
      const cancelled = (await serverPacks(page)).find(
        (item) => item.name === secondName,
      );
      assert(
        cancelled.completedTiles > 0 &&
          cancelled.completedTiles < cancelled.plannedTiles,
      );
      await tap(page, '[data-offline-refresh]');
      await idle(page);
      tileDelay = 500;
      await tap(page, 'Resume server download', secondName);
      await idle(page);
      await page.waitForFunction(
        async (id) =>
          (
            await (
              await fetch(`/api/maps/offline/packs/${id}`, {
                cache: 'no-store',
              })
            ).json()
          ).state === 'downloading',
        { timeout, polling: 100 },
        cancelled.id,
      );
      await tap(page, '[data-offline-refresh]');
      await idle(page);
      await tap(page, 'Cancel server download', secondName);
      await idle(page);
      await page.waitForFunction(
        async (id) =>
          (
            await (
              await fetch(`/api/maps/offline/packs/${id}`, {
                cache: 'no-store',
              })
            ).json()
          ).state === 'cancelled',
        { timeout, polling: 100 },
        cancelled.id,
      );
      const cancelledResume = (await serverPacks(page)).find(
        (item) => item.id === cancelled.id,
      );
      assert(
        cancelledResume.completedTiles >= cancelled.completedTiles &&
          cancelledResume.completedTiles < cancelledResume.plannedTiles,
      );
      await tap(page, '[data-offline-refresh]');
      await idle(page);
      tileDelay = 5;
      await tap(page, 'Resume server download', secondName);
      await idle(page);
      await page.waitForFunction(
        async (id) =>
          (
            await (
              await fetch(`/api/maps/offline/packs/${id}`, {
                cache: 'no-store',
              })
            ).json()
          ).state === 'ready',
        { timeout, polling: 100 },
        cancelled.id,
      );
      await tap(page, '[data-offline-refresh]');
      await idle(page);
      await tap(page, 'Save to this device', secondName);
      await idle(page);
      await rowReady(page, secondName);
      assert.deepEqual((await dbSnapshot(page)).hashFailures, []);
      await tap(page, 'Delete device copy', secondName);
      await idle(page);
      await tap(page, 'Delete server copy', secondName);
      await idle(page);
      await tap(page, 'Show saved map', firstName);
      await idle(page);
      return {
        retainedBeforeResume: cancelled.completedTiles,
        retainedAfterResumedJobCancellation: cancelledResume.completedTiles,
        resumedJobCancelled: true,
        planned: cancelled.plannedTiles,
        maxConcurrentDownloads: maximumDownloads,
      };
    },
  );
  await step(
    'private tactical fixtures remain session-only and never enter saved application caches',
    async () => {
      const time = new Date().toISOString(),
        stale = new Date(Date.now() + 600000).toISOString();
      const xml = `<event version="2.0" uid="${secretSentinel}" type="a-f-G-U-C" how="h-e" time="${time}" start="${time}" stale="${stale}"><point lat="34" lon="-89"/><detail><contact callsign="${secretSentinel}"/></detail></event><event version="2.0" uid="GeoChat.synthetic.All.sentinel" type="b-t-f" how="h-e" time="${time}" start="${time}" stale="${stale}"><point lat="0" lon="0"/><detail><__chat messageId="sentinel" chatroom="All Chat Rooms" id="All Chat Rooms" senderCallsign="Synthetic"/><remarks>${secretSentinel}</remarks></detail></event>`;
      await page.$eval('[data-tak-section="import"]', (el) => {
        el.open = true;
      });
      await page.$eval(
        '[data-tak-xml]',
        (el, value) => {
          el.value = value;
        },
        xml,
      );
      await tap(page, '[data-tak-import]');
      await page.waitForFunction(
        () =>
          window.__godsEyeView.takClient.client.store.count() === 1 &&
          window.__godsEyeView.takClient.client.store.chats().length === 1,
        { timeout },
      );
      const cache = await cacheEvidence(page);
      assert(cache.workers > 0 && cache.hasIndex);
      return cache;
    },
  );
  await step(
    'actual server outage and a fresh page boot the saved app/map while navigator remains online',
    async () => {
      const port = Number(new URL(origin).port);
      await instance.close();
      instance = null;
      outage = true;
      await collectErrors(page);
      await pageInterceptions.get(page)?.dispose();
      await page.close();
      page = await pageForRun();
      const response = await page.goto(
        origin + '/#lat=0&lon=0&alt=50000&map=osm&b=0',
        {
          waitUntil: 'domcontentloaded',
          timeout,
        },
      );
      assert.equal(response.status(), 200);
      assert.equal(response.fromServiceWorker(), true);
      await boot(page, { hasShareState: true });
      console.log('offline fresh page initialized with saved maps UI');
      const fonts = await fontEvidence(page);
      const before = await renderEvidence(page, firstId);
      console.log(
        'offline saved map has actual rendered imagery and flat terrain',
      );
      assert.equal(
        before.online,
        true,
        'Test actual reachability failure without setting navigator offline',
      );
      assert.equal(before.contacts, 0);
      assert.equal(before.chats, 0);
      assert.equal(before.terrain, 'offline-ellipsoid');
      assert.equal(before.flatTerrain, true);
      assert(before.renderedTiles > 0 && before.distinctSampledColors > 16);
      assert.match(before.credit, /USGS The National Map/);
      assert.ok(before.credit.includes(`Saved map: ${firstName}`));
      await setPanelOpen(page, false);
      const pan = await page.evaluate(() => {
        const canvas = window.__godsEyeView.viewer.scene.canvas;
        for (const [a, b] of [
          [0.5, 0.55],
          [0.65, 0.5],
          [0.55, 0.4],
          [0.7, 0.65],
        ]) {
          const x = innerWidth * a,
            y = innerHeight * b;
          if (
            document.elementFromPoint(x, y) === canvas &&
            document.elementFromPoint(x + 30, y + 15) === canvas
          )
            return { x, y };
        }
        throw new Error('No unobstructed globe area for real pan input');
      });
      await page.mouse.move(pan.x, pan.y);
      await page.mouse.down();
      await page.mouse.move(pan.x + 30, pan.y + 15, { steps: 12 });
      await page.mouse.up();
      const after = await renderEvidence(page, firstId);
      assert.notDeepEqual(
        after.camera,
        before.camera,
        'Real globe input must pan the saved map',
      );
      assert.equal(after.activeId, `offline-${firstId}`);
      assert.equal(after.terrain, 'offline-ellipsoid');
      assert.equal(after.flatTerrain, true);
      assert.deepEqual(
        outageMapRequests,
        [],
        'A selected saved map must never fall back to online maps/terrain',
      );
      assert.deepEqual(
        outageFontRequests,
        [],
        'Saved app must not request external Google fonts during outage',
      );
      await screenshot(page, 'disconnected-fresh-launch.png');
      // A real same-port restart also checks server disk persistence and cookie re-login.
      outage = false;
      instance = await startServer(port);
      return {
        navigatorOnline: before.online,
        fromServiceWorker: true,
        staleOnlineBasemapHash: true,
        renderedTiles: after.renderedTiles,
        cameraChanged: true,
        tacticalStateRestored: false,
        fonts,
      };
    },
  );
  await step(
    'same-port restart preserves server packs; explicit UI deletions remove server/device/shell copies',
    async () => {
      await login(page);
      const server = await serverPacks(page);
      assert.equal(server.find((pack) => pack.id === firstId).state, 'ready');
      await tap(page, '[data-offline-refresh]');
      await idle(page);
      await rowReady(page, firstName);
      await tap(page, 'Delete server copy', firstName);
      await idle(page);
      assert(!(await serverPacks(page)).some((pack) => pack.id === firstId));
      await tap(page, 'Delete device copy', firstName);
      await idle(page);
      assert.equal((await dbSnapshot(page)).packs.length, 0);
      assert.equal((await dbSnapshot(page)).tileCount, 0);
      await tap(page, '[data-offline-shell-delete]');
      await idle(page);
      const cacheNames = await page.evaluate(() => caches.keys());
      assert.deepEqual(
        cacheNames.filter((name) => name.startsWith('gev-offline-shell')),
        [],
      );
      await screenshot(page, 'copies-explicitly-deleted.png');
      return {
        serverPacks: (await serverPacks(page)).length,
        devicePacks: 0,
        deviceTiles: 0,
        savedShellCaches: 0,
      };
    },
  );
  await step(
    'actual service-worker save HTTP401 clears private state before returning to login',
    async () => {
      await page.evaluate((sentinel) => {
        const tak = window.__godsEyeView.takClient;
        tak.client.setFix({ lat: 0, lon: 0, source: 'USER' });
        tak.client.addMarker({
          callsign: sentinel,
          lat: 0,
          lon: 0,
          broadcast: false,
        });
        const time = new Date().toISOString();
        const stale = new Date(Date.now() + 600000).toISOString();
        tak.client.importXml(
          `<event version="2.0" uid="GeoChat.synthetic.All.expiring" type="b-t-f" how="h-e" time="${time}" start="${time}" stale="${stale}"><point lat="0" lon="0"/><detail><__chat messageId="expiring" chatroom="All Chat Rooms" id="All Chat Rooms" senderCallsign="Synthetic"/><remarks>${sentinel}</remarks></detail></event>`,
        );
        const disclosure = document.querySelector('[data-tak-disclosure]');
        disclosure.checked = true;
        disclosure.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-tak-xml]').value = sentinel;
        document.querySelector('[data-tak-marker-broadcast]').checked = true;
      }, secretSentinel);
      const loaded = await page.evaluate(() => {
        const tak = window.__godsEyeView.takClient;
        return {
          contacts: tak.client.store.count(),
          chats: tak.client.store.chats().length,
          fix: !!tak.client.fix(),
          authorized: tak.privacy().authorized,
        };
      });
      assert(
        loaded.contacts > 0 &&
          loaded.chats > 0 &&
          loaded.fix &&
          loaded.authorized,
      );
      const baseline = unloadSnapshots.length;
      const responseBaseline = expiredShellResponses.length;
      nowMs += SESSION_TTL_MS + 1;
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
        tap(page, '[data-offline-shell]'),
      ]);
      assert.equal(new URL(page.url()).pathname, '/login');
      const deadline = Date.now() + timeout;
      while (unloadSnapshots.length <= baseline && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const snapshot = unloadSnapshots.slice(baseline).at(-1);
      assert(snapshot, 'Departing app must report its cleared tactical state');
      assert.equal(snapshot.contacts, 0);
      assert.equal(snapshot.chats, 0);
      assert.equal(snapshot.fix, null);
      assert.equal(snapshot.sa, false);
      assert.equal(snapshot.authorized, false);
      assert.equal(snapshot.privateInputs, false);
      assert.equal(snapshot.disclosure, false);
      assert.equal(snapshot.markerShare, false);
      assert.equal(expiredShellResponses.length - responseBaseline, 1);
      return { actualShellHttpStatus: 401, clearedBeforeUnload: snapshot };
    },
  );
  for (const page of pages)
    if (!page.isClosed()) {
      await collectErrors(page);
    }
  assert(maximumDownloads <= 4);
  assert.deepEqual(
    interceptions.flatMap((item) => item.errors),
    [],
  );
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    date: new Date().toISOString(),
    browser: await browser.version(),
    platform: `${process.platform} ${process.arch}`,
    synthetic: true,
    realPhoneAcceptance: false,
    externalBulkDownloads: 0,
    tileRequests: tileRequests.length,
    maximumDownloads,
    blockedOrStubbedPublicRequests: externalRequests.length,
    outageMapRequests,
    outageFontRequests,
    results,
    errors,
  };
  await fs.writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: results.length,
      artifactDir: artifacts,
      tileRequests: tileRequests.length,
      maximumDownloads,
    }),
  );
} catch (error) {
  const domEvidence = [];
  for (const [index, page] of pages.entries())
    if (!page.isClosed()) {
      domEvidence.push(
        await Promise.race([
          page
            .evaluate(() => ({
              path: location.pathname,
              activeMap:
                window.__godsEyeView?.mapStackController?.getActiveId(),
              panelHidden: document.querySelector('#tak-web-panel')?.hidden,
              expanded: document
                .querySelector('.tak-web-launcher')
                ?.getAttribute('aria-expanded'),
              inputTrace: window.__offlineInputTrace || [],
            }))
            .catch(() => ({ unavailable: true })),
          new Promise((resolve) =>
            setTimeout(() => resolve({ unavailable: true }), 5000),
          ),
        ]),
      );
      await Promise.race([
        screenshot(page, `failure-${index}.png`).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 10000)),
      ]);
    }
  await fs.writeFile(
    path.join(artifacts, 'failure.json'),
    JSON.stringify(
      {
        passed: false,
        results,
        error: scrub(error.stack || error),
        errors: errors.map(scrub),
        outage,
        maximumDownloads,
        outageMapRequests,
        outageFontRequests,
        domEvidence,
        interceptionErrors: interceptions
          .flatMap((item) => item.errors)
          .map(scrub),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const interception of interceptions)
    await interception.dispose().catch(() => {});
  await browser?.close().catch(() => {});
  await instance?.close().catch(() => {});
  certificates.cleanup();
  for (const [name, value] of savedEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const absolute = path.resolve(fixtureRoot);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.ok(path.basename(absolute).startsWith('gev-offline-browser-'));
  await fs.rm(absolute, { recursive: true, force: true });
}
