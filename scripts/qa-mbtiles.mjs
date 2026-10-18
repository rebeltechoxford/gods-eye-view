#!/usr/bin/env node
/** Real private HTTPS/local-file/device/Cesium/outage acceptance; synthetic data only. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import * as sqlite from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startTakHttpsServer } from '../server/standalone/tak-https.mjs';
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
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  assert(args[i + 1] && !args[i + 1].startsWith('--'));
  return args[i + 1];
};
const distRoot = path.resolve(root, option('--dist', 'dist'));
const artifacts = path.resolve(
  root,
  option('--artifact-dir', 'qa-artifacts/mbtiles'),
);
const timeout = Number(option('--timeout', '180000'));
assert(Number.isFinite(timeout) && timeout >= 1000);
await fs.access(path.join(distRoot, 'gev-sw.js'));
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'gev-mbtiles-browser-'),
);
const certificates = createTakTlsFixtures();
const operatorToken = randomBytes(32).toString('hex');
const usersFile = path.join(directory, 'users.json');
const sourceFile = path.join(directory, 'synthetic.mbtiles');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const spki = createHash('sha256')
  .update(
    new X509Certificate(certificates.read('server.pem')).publicKey.export({
      type: 'spki',
      format: 'der',
    }),
  )
  .digest('base64');
const secretSentinel = 'SYNTHETIC-MBTILES-PRIVATE-NEVER-APP-CACHED';
const firstName = 'Synthetic private imported raster';
const sourceTitle = 'Synthetic source <b>inert text</b>';
const license =
  'Synthetic test-owned raster. Permission to retain; original notice <script>inert</script>. ' +
  'Synthetic permission phrase. '.repeat(275).trim();
const edition = 'Test edition 2026';
const sourceUrl = 'https://example.invalid/never-fetch-this-map';
const results = [],
  errors = [],
  pages = [],
  interceptions = [],
  externalRequests = [],
  http = [];
const pageInterceptions = new WeakMap();
let browser,
  instance,
  origin,
  outage = false,
  firstId,
  pauseWrite = false,
  releaseWrite,
  writeEntered;
const scrub = (value) => redact(value).replaceAll(operatorToken, 'REDACTED');
const image = png(0),
  southernImage = png(64);
function png(shift) {
  const chunk = (type, bytes) => {
    const out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    out.write(type, 4, 'ascii');
    bytes.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(256 * (256 * 4 + 1));
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const p = y * 1025 + 1 + x * 4;
      rows[p] = x;
      rows[p + 1] = y;
      rows[p + 2] = (x + y + shift) % 256;
      rows[p + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
async function startServer(port = 0) {
  const app = await startTakHttpsServer({
    env: {
      TAK_GATEWAY_USERS_FILE: usersFile,
      TAK_HTTPS_CERT: certificates.file('server.pem'),
      TAK_HTTPS_KEY: certificates.file('server.key'),
    },
    distRoot,
    providerPlugins: [],
    port,
    offlineMaps: {
      root: path.join(directory, 'maps'),
      fetchImpl: async () => {
        throw new Error('Import must not fetch USGS or provenance URLs');
      },
      writeImpl: async (handle, bytes) => {
        if (pauseWrite && bytes[0] !== 123) {
          pauseWrite = false;
          writeEntered();
          await new Promise((resolve) => {
            releaseWrite = resolve;
          });
        }
        await handle.writeFile(bytes);
        await handle.sync();
      },
    },
  });
  assert.equal(new URL(app.origin).hostname, '127.0.0.1');
  app.server.prependListener('request', (request, response) => {
    if (request.url.startsWith('/api/maps/offline/')) {
      const safePath = request.url.split('?')[0];
      response.once('finish', () =>
        http.push({
          method: request.method,
          path: safePath,
          status: response.statusCode,
          scope: !!request.headers['x-tak-storage-scope'],
          type: request.headers['content-type'],
          length: Number(request.headers['content-length'] || 0),
        }),
      );
    }
  });
  return app;
}
async function step(name, action) {
  console.log(`running ${name}`);
  const start = Date.now();
  const evidence = await action();
  results.push({ name, passed: true, elapsedMs: Date.now() - start, evidence });
  console.log(`ok ${results.length} ${name}`);
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
  page.setDefaultTimeout(timeout);
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
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
    window.__offlineUnhandled = [];
    addEventListener('unhandledrejection', (event) =>
      window.__offlineUnhandled.push(
        String(event.reason?.stack || event.reason),
      ),
    );
    window.__mbtilesLogout = [];
    const original = window.fetch;
    window.fetch = function (input, options) {
      const url = new URL(
        typeof input === 'string' ? input : input.url,
        location.href,
      );
      if (url.pathname === '/logout')
        window.__mbtilesLogout.push({
          fields: [
            ...document.querySelectorAll(
              '[data-mbtiles-form] input,[data-mbtiles-form] textarea',
            ),
          ].map((el) => ({
            type: el.type,
            value: el.type === 'checkbox' ? el.checked : el.value,
            files: el.files?.length || 0,
          })),
          contacts: window.__godsEyeView?.takClient?.client.store.count(),
        });
      return original.call(this, input, options);
    };
  });
  const interception = await interceptFixtures(page, {
    origin,
    includePaths: ['/login', '/logout'],
    handle: async (request) => {
      const url = new URL(request.url());
      assert(!url.href.includes(operatorToken), 'Credential in URL');
      if (url.origin === origin) {
        if (
          url.pathname.startsWith('/api/') &&
          !/^\/api\/(?:tak|maps\/offline)(?:\/|$)/.test(url.pathname)
        )
          return outage
            ? request.abort('internetdisconnected')
            : request.respond({
                status: 200,
                contentType: 'application/json',
                body: '{}',
              });
        return request.continue();
      }
      if (!url.protocol.startsWith('http')) return request.continue();
      externalRequests.push({ host: url.hostname, path: url.pathname, outage });
      if (outage) return request.abort('internetdisconnected');
      if (url.hostname === 'terrain.reearth.land')
        return request.respond({
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '{}',
        });
      if (
        /\/tile\/\d+\/\d+\/\d+$/.test(url.pathname) ||
        /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      )
        return request.respond({
          status: 200,
          contentType: 'image/png',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: image,
        });
      return request.respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{}',
      });
    },
  });
  interceptions.push(interception);
  pageInterceptions.set(page, interception);
  await page.bringToFront();
  return page;
}
async function login(page) {
  await page.bringToFront();
  await page.goto(origin + '/login', {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await page.type('input[name="principal"]', 'importer');
  await page.type('input[name="token"]', operatorToken);
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
    tap(page, 'form button'),
  ]);
  assert.equal(response.status(), 200);
  await boot(page);
}
async function fillImport(page, name = firstName) {
  await (await page.$('[data-mbtiles-file]')).uploadFile(sourceFile);
  await page.evaluate(
    (values) => {
      for (const [key, value] of Object.entries(values)) {
        const el = document.querySelector(`[data-mbtiles-${key}]`);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    },
    { name, source: sourceTitle, license, edition, url: sourceUrl },
  );
}
async function serverPacks(page) {
  return page.evaluate(async () => {
    const c = window.__godsEyeView.takClient.operatorContext();
    const r = await fetch('/api/maps/offline/packs', {
      headers: { 'X-TAK-Storage-Scope': c.storageScope },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('Cannot read test packs');
    return (await r.json()).packs;
  });
}
async function deviceSnapshot(page) {
  return page.evaluate(async () => {
    const scope = window.__godsEyeView.takClient.operatorContext().storageScope;
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('gev-offline-maps-v1-' + scope, 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const read = (store) =>
        new Promise((resolve, reject) => {
          const r = db.transaction(store).objectStore(store).getAll();
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      const packs = await read('packs'),
        tiles = await read('tiles');
      return { packs, tileCount: tiles.length };
    } finally {
      db.close();
    }
  });
}
async function privacyEvidence(page) {
  return page.evaluate(async () => {
    const gev = window.__godsEyeView;
    return {
      privacy: gev.takClient.privacy(),
      permissions: [...document.querySelectorAll('[data-tak-disclosure]')].map(
        (el) => ({ scope: el.dataset.takDisclosure, checked: el.checked }),
      ),
      copied: await gev.styleManager.shareLinkManager.copyLink(),
      hash: gev.styleManager.shareLinkManager._buildHashParams(),
      captured: gev.sceneDirector.captureShot(),
      exported: gev.sceneDirector.exportProject(),
    };
  });
}
async function cachesSafe(page) {
  return page.evaluate(
    async (token, sentinel, source) => {
      let files = 0;
      for (const name of await caches.keys())
        for (const request of await (await caches.open(name)).keys()) {
          const url = new URL(request.url);
          if (
            url.origin !== location.origin ||
            url.search ||
            /^\/(?:api|login|logout)(?:\/|$)/.test(url.pathname)
          )
            throw new Error('Private route cached');
          const response = await (await caches.open(name)).match(request);
          if (response.headers.has('set-cookie'))
            throw new Error('Cookie cached');
          const text = await response.text();
          if (
            text.includes(token) ||
            text.includes(sentinel) ||
            text.includes(source)
          )
            throw new Error('Runtime private data cached');
          files++;
        }
      for (const value of Object.values(localStorage))
        if (
          String(value).includes(token) ||
          String(value).includes(sentinel) ||
          String(value).includes(source)
        )
          throw new Error('Runtime payload in localStorage');
      return { files };
    },
    operatorToken,
    secretSentinel,
    sourceTitle,
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
  await fs.writeFile(
    usersFile,
    JSON.stringify({
      schemaVersion: 1,
      principals: [
        {
          id: 'importer',
          role: 'operator',
          enabled: true,
          tokenSha256: digest(operatorToken),
          server: { host: '127.0.0.1', port: 9, ...certificates.clientConfig },
        },
      ],
    }),
  );
  const Database = sqlite.Database || sqlite.DatabaseSync,
    db = new Database(sourceFile);
  db.exec(
    "CREATE TABLE metadata(name TEXT,value TEXT);INSERT INTO metadata VALUES('name','Synthetic private raster'),('format','png'),('attribution','Original synthetic notice');CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB);BEGIN",
  );
  const insert = db.prepare('INSERT INTO tiles VALUES(?,?,?,?)');
  insert.run(0, 0, 0, image);
  insert.run(1, 0, 1, image);
  insert.run(1, 0, 0, southernImage);
  db.exec('COMMIT');
  db.close();
  assert(
    Buffer.byteLength(license) <= 8192 && Buffer.byteLength(license) > 7500,
  );
  const sourceBytes = await fs.readFile(sourceFile),
    sourceHash = digest(sourceBytes);
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
    'named native login and phone form require per-file rights before any upload',
    async () => {
      await login(page);
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-offline-status]')
            .textContent.includes('No saved maps') &&
          document.querySelector('[data-offline-cancel]').hidden &&
          !document.querySelector('[data-mbtiles-submit]').disabled,
        { timeout },
      );
      const c = await page.evaluate(() =>
        window.__godsEyeView.takClient.operatorContext(),
      );
      assert.equal(c.principal, 'importer');
      await fillImport(page);
      assert.equal(
        await page.$eval('[data-mbtiles-rights]', (el) => el.checked),
        false,
      );
      const count = http.length;
      await tap(page, '[data-mbtiles-submit]');
      assert.equal(
        http
          .slice(count)
          .some((r) => r.method === 'POST' && r.path.endsWith('/imports')),
        false,
      );
      assert.equal(
        await page.$eval(
          '[data-mbtiles-rights]',
          (el) => el.validity.valueMissing,
        ),
        true,
      );
      const layout = await page.$eval('[data-mbtiles-form]', (form) =>
        [
          ...form.querySelectorAll(
            'input:not([type=checkbox]),textarea,button,.tak-web-check',
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            height: r.height,
            left: r.left,
            right: r.right,
            font: getComputedStyle(el).fontSize,
          };
        }),
      );
      for (const field of layout) {
        assert(field.left >= 0 && field.right <= 391, JSON.stringify(field));
        assert(field.height >= 44, JSON.stringify(field));
      }
      await screenshot(page, '01-phone-import-permission.png');
      return {
        principal: c.principal,
        storageScopeBound: true,
        minimumTouchHeight: Math.min(...layout.map((f) => f.height)),
        noUploadWithoutRights: true,
      };
    },
  );
  await step(
    'real selected File imports through authenticated HTTP then retains the map and offline app on device',
    async () => {
      await tap(page, '[data-mbtiles-rights]');
      await tap(page, '[data-mbtiles-submit]');
      await page.waitForFunction(
        () => document.querySelector('[data-offline-cancel]').hidden,
        { timeout: 300000 },
      );
      assert.match(
        await page.$eval('[data-offline-status]', (el) => el.textContent),
        /Imported map, source notices, server\/device copies and offline app ready/,
      );
      const packs = await serverPacks(page);
      assert.equal(packs.length, 1);
      firstId = packs[0].id;
      assert.equal(packs[0].state, 'ready');
      assert.equal(packs[0].sourceId, 'operator-mbtiles');
      const local = await deviceSnapshot(page),
        m = local.packs[0];
      assert.equal(m.id, firstId);
      assert.equal(m.schemaVersion, 2);
      assert.equal(m.state, 'ready');
      assert.equal(local.tileCount, 3);
      assert.equal(m.provenance.sha256, sourceHash);
      assert.equal(m.provenance.fileBytes, sourceBytes.length);
      assert.equal(m.provenance.sourceTitle, sourceTitle);
      assert.equal(m.provenance.license, license);
      assert.equal(m.provenance.edition, edition);
      assert.equal(m.sourceUrl, sourceUrl);
      assert.deepEqual(m.plannedKeys, ['0/0/0', '1/0/0', '1/0/1']);
      assert.equal(
        await page.$eval('[data-mbtiles-file]', (el) => el.files.length),
        0,
      );
      assert.equal(
        await page.$eval('[data-mbtiles-rights]', (el) => el.checked),
        false,
      );
      const upload = http.find(
        (r) => r.method === 'PUT' && r.path.endsWith('/file'),
      );
      assert(
        upload &&
          upload.status === 202 &&
          upload.scope &&
          upload.length === sourceBytes.length &&
          upload.type === 'application/vnd.sqlite3',
      );
      assert(
        http
          .filter((r) => r.path.startsWith('/api/maps/offline/'))
          .every((r) => r.scope),
      );
      assert.equal(
        externalRequests.some((r) => r.host === 'example.invalid'),
        false,
      );
      return {
        fileBytes: sourceBytes.length,
        originalSha256: sourceHash,
        tiles: 3,
        rawFileUpload: true,
        serverAndDeviceReady: true,
      };
    },
  );
  await step(
    'Cesium displays imported pixels with TMS row inversion, sparse blank coverage and retained inert notices',
    async () => {
      const e = await renderEvidence(page, firstId);
      assert.equal(e.terrain, 'offline-ellipsoid');
      assert(
        e.flatTerrain && e.renderedTiles > 0 && e.distinctSampledColors > 16,
      );
      assert.deepEqual(
        e.layers,
        [...LAYER_STATE_REGISTRY.map((e) => e.id), 'local-adsb', 'fisb'].sort(),
      );
      const samples = await page.evaluate(async () => {
        const p =
          window.__godsEyeView.viewer.imageryLayers.get(0).imageryProvider;
        const color = async (x, y, z) => {
          const image = await p.requestImage(x, y, z);
          const c = document.createElement('canvas');
          c.width = c.height = 256;
          const ctx = c.getContext('2d');
          ctx.drawImage(image, 0, 0, 256, 256);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        return {
          north: await color(0, 0, 1),
          south: await color(0, 1, 1),
          missing: await color(1, 0, 1),
        };
      });
      assert.deepEqual(samples.north, [0, 0, 0, 255]);
      assert.deepEqual(samples.south, [0, 0, 64, 255]);
      assert.equal(samples.missing[3], 0);
      await tap(page, 'Source / license / edition', firstName);
      await idle(page);
      const text = await page.$eval(
        '[data-mbtiles-notice]',
        (el) => el.textContent,
      );
      for (const item of [sourceTitle, license, edition, sourceHash, sourceUrl])
        assert(text.includes(item));
      assert.equal(
        await page.$$eval(
          '[data-mbtiles-notice] script,[data-mbtiles-notice] b,[data-mbtiles-notice] a',
          (els) => els.length,
        ),
        0,
      );
      const privacy = await privacyEvidence(page);
      assert.deepEqual(privacy.privacy, { private: true, authorized: false });
      assert(privacy.permissions.every((p) => !p.checked));
      assert.equal(privacy.copied, false);
      assert.equal(privacy.hash, null);
      assert.equal(privacy.captured, false);
      assert.equal(privacy.exported, false);
      await screenshot(page, '02-imported-notices-phone.png');
      const hintLayout = await page.$eval('[data-tak-privacy]', (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const parent = el.closest('#tak-web-panel').getBoundingClientRect();
        return {
          wordBreak: getComputedStyle(el).wordBreak,
          lines: [...range.getClientRects()].map((r) => ({
            left: r.left,
            right: r.right,
          })),
          left: parent.left,
          right: parent.right,
        };
      });
      assert.equal(hintLayout.wordBreak, 'normal');
      assert(
        hintLayout.lines.every(
          (r) => r.left >= hintLayout.left && r.right <= hintLayout.right,
        ),
      );
      await setPanelOpen(page, false);
      const creditSelector = '#cesium-credits .gev-saved-map-credit';
      const credit = await page.$eval(
        creditSelector,
        (el, fullLicense) => {
          const r = el.getBoundingClientRect();
          return {
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
            interiorHits: [0.2, 0.5, 0.8].flatMap((x) =>
              [0.2, 0.5, 0.8].map((y) => {
                const hit = document.elementFromPoint(
                  r.left + r.width * x,
                  r.top + r.height * y,
                );
                return hit === el || el.contains(hit);
              }),
            ),
            clientHeight: el.clientHeight,
            scrollHeight: el.scrollHeight,
            complete: el.textContent.includes(fullLicense),
            tabIndex: el.tabIndex,
          };
        },
        license,
      );
      assert.equal(
        await page.$$eval(creditSelector, (els) => els.length),
        1,
        'Static/provider credits must deduplicate',
      );
      assert(
        credit.left >= 0 &&
          credit.right <= 391 &&
          credit.top >= 0 &&
          credit.bottom <= 844,
      );
      assert(credit.width >= 280, 'Saved credit needs a readable phone width');
      assert(
        credit.interiorHits.every(Boolean),
        'Full saved attribution scroll area must be unobstructed',
      );
      assert(
        credit.height <= 161 &&
          credit.height >= 44 &&
          credit.scrollHeight > credit.clientHeight,
      );
      assert(
        credit.complete && credit.tabIndex === 0,
        'Full long license must remain keyboard accessible',
      );
      await page.focus(creditSelector);
      await page.keyboard.press('End');
      await page.waitForFunction(
        (selector) => document.querySelector(selector).scrollTop > 0,
        { timeout: 10000 },
        creditSelector,
      );
      await screenshot(page, '02a-imported-attribution-phone.png');
      await setPanelOpen(page, true);

      return {
        renderedTiles: e.renderedTiles,
        decodedColors: e.distinctSampledColors,
        tmsSamples: samples,
        allGevLayers: e.layers.length,
        privateBeforeDisclosure: true,
        boundedCompleteCredit: credit,
        privacyHintLinesWithinPanel: true,
      };
    },
  );
  await step(
    'actual cancel waits for the paused conversion write and requires fresh selection and rights',
    async () => {
      let entered;
      const writing = new Promise((resolve) => {
        entered = resolve;
      });
      writeEntered = entered;
      pauseWrite = true;
      await fillImport(page, 'Synthetic cancelled import');
      await tap(page, '[data-mbtiles-rights]');
      await tap(page, '[data-mbtiles-submit]');
      await writing;
      const cancelRequest = page.waitForRequest(
        (r) =>
          r.method() === 'POST' &&
          /\/imports\/[^/]+\/cancel$/.test(new URL(r.url()).pathname),
        { timeout },
      );
      await tap(page, '[data-offline-cancel]');
      await cancelRequest;
      releaseWrite();
      releaseWrite = null;
      await idle(page);
      assert.match(
        await page.$eval('[data-offline-status]', (el) => el.textContent),
        /MBTiles import interrupted.*Reselect/,
      );
      assert.equal(
        await page.$eval('[data-mbtiles-file]', (el) => el.files.length),
        0,
      );
      assert.equal(
        await page.$eval('[data-mbtiles-rights]', (el) => el.checked),
        false,
      );
      assert.equal((await serverPacks(page)).length, 1);
      assert.equal(
        http.filter(
          (r) =>
            r.method === 'POST' && /\/imports\/[^/]+\/cancel$/.test(r.path),
        ).length,
        1,
      );
      return {
        actualCancelRequest: true,
        readyPackPreserved: true,
        fileReselectionRequired: true,
      };
    },
  );
  await step(
    'true HTTPS outage fresh-page boot restores imported map and notices with disclosure still blocked',
    async () => {
      const t = new Date().toISOString(),
        s = new Date(Date.now() + 600000).toISOString();
      await page.evaluate(
        (xml) => window.__godsEyeView.takClient.client.importXml(xml),
        `<event version="2.0" uid="${secretSentinel}" type="a-f-G-U-C" how="h-e" time="${t}" start="${t}" stale="${s}"><point lat="0" lon="0"/><detail><contact callsign="${secretSentinel}"/></detail></event>`,
      );
      await cachesSafe(page);
      const oldPort = Number(new URL(origin).port);
      await collectErrors(page);
      await pageInterceptions.get(page).dispose();
      await page.close();
      await instance.close();
      instance = null;
      outage = true;
      page = await pageForRun();
      const response = await page.goto(
        origin + '/#lat=0&lon=0&alt=50000&map=osm&b=0',
        { waitUntil: 'domcontentloaded', timeout },
      );
      assert.equal(response.status(), 200);
      assert(response.fromServiceWorker());
      await boot(page, { hasShareState: true });
      const e = await renderEvidence(page, firstId);
      assert(e.online && e.renderedTiles > 0 && e.distinctSampledColors > 16);
      assert.equal(e.contacts, 0);
      assert.equal(e.chats, 0);
      assert.equal(e.terrain, 'offline-ellipsoid');
      const local = await deviceSnapshot(page);
      assert.equal(local.packs[0].provenance.sha256, sourceHash);
      assert.equal(local.packs[0].provenance.license, license);
      const p = await privacyEvidence(page);
      assert.deepEqual(p.privacy, { private: true, authorized: false });
      assert(p.permissions.every((p) => !p.checked));
      assert.equal(p.copied, false);
      assert.equal(p.hash, null);
      assert.equal(p.captured, false);
      assert.equal(p.exported, false);
      assert.deepEqual(
        externalRequests.filter((r) => r.outage),
        [],
        'Retained map/app must not request public fallback assets',
      );
      await cachesSafe(page);
      await screenshot(page, '03-outage-imported-phone.png');
      outage = false;
      instance = await startServer(oldPort);
      return {
        realListenerStopped: true,
        navigatorOnline: true,
        fromServiceWorker: true,
        renderedTiles: e.renderedTiles,
        privateTacticalStateRestored: false,
        sourceNoticesRetained: true,
      };
    },
  );
  await step(
    'native sign-out clears selected file, source fields and rights before the scoped logout request',
    async () => {
      await login(page);
      await fillImport(page, 'Private unsubmitted source');
      await tap(page, '[data-mbtiles-rights]');
      assert.equal(
        await page.$eval('[data-mbtiles-file]', (el) => el.files.length),
        1,
      );
      assert.equal(
        await page.$eval('[data-mbtiles-rights]', (el) => el.checked),
        true,
      );
      await page.$eval('[data-tak-section=network]', (el) => {
        el.open = true;
      });
      const snapshot = [];
      await page.exposeFunction('__captureMbtilesLogout', (value) =>
        snapshot.push(value),
      );
      await page.evaluate(() => {
        const old = window.fetch;
        window.fetch = function (input, options) {
          const url = new URL(
            typeof input === 'string' ? input : input.url,
            location.href,
          );
          if (url.pathname === '/logout')
            void window.__captureMbtilesLogout({
              fields: [
                ...document.querySelectorAll(
                  '[data-mbtiles-form] input,[data-mbtiles-form] textarea',
                ),
              ].map((el) => ({
                type: el.type,
                value: el.type === 'checkbox' ? el.checked : el.value,
                files: el.files?.length || 0,
              })),
              contacts: window.__godsEyeView?.takClient?.client.store.count(),
            });
          return old.call(this, input, options);
        };
      });
      const nav = page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout,
      });
      await Promise.all([nav, tap(page, '[data-tak-logout]')]);
      assert.equal(new URL(page.url()).pathname, '/login');
      assert.equal(snapshot.length, 1);
      for (const f of snapshot[0].fields) {
        assert.equal(f.value, f.type === 'checkbox' ? false : '');
        assert.equal(f.files, 0);
      }
      assert.equal(snapshot[0].contacts, 0);
      return { clearedBeforeActualPost: true, exactScopeLogout: true };
    },
  );
  for (const p of pages) if (!p.isClosed()) await collectErrors(p);
  assert.deepEqual(
    interceptions.flatMap((i) => i.errors),
    [],
  );
  assert.deepEqual(errors, []);
  await fs.writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      {
        passed: true,
        date: new Date().toISOString(),
        node: process.version,
        browser: await browser.version(),
        synthetic: true,
        realPhoneAcceptance: false,
        results,
        http,
        externalRequests: externalRequests.length,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: results.length,
      artifactDir: artifacts,
    }),
  );
} catch (error) {
  const dom = [];
  for (const [i, p] of pages.entries())
    if (!p.isClosed()) {
      dom.push(
        await p
          .evaluate(() => ({
            path: location.pathname,
            status: document.querySelector('[data-offline-status]')
              ?.textContent,
            panelHidden: document.querySelector('#tak-web-panel')?.hidden,
          }))
          .catch(() => ({ unavailable: true })),
      );
      await screenshot(p, `failure-${i}.png`).catch(() => {});
    }
  await fs.writeFile(
    path.join(artifacts, 'failure.json'),
    JSON.stringify(
      {
        passed: false,
        results,
        error: scrub(error.stack || error),
        errors,
        dom,
        http,
        interceptionErrors: interceptions.flatMap((i) => i.errors).map(scrub),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  releaseWrite?.();
  for (const i of interceptions) await i.dispose().catch(() => {});
  await browser?.close().catch(() => {});
  await instance?.close().catch(() => {});
  certificates.cleanup();
  const absolute = path.resolve(directory);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.match(path.basename(absolute), /^gev-mbtiles-browser-/);
  await fs.rm(absolute, { recursive: true, force: true });
}
