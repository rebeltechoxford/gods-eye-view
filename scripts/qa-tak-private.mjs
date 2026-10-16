#!/usr/bin/env node
/**
 * Built-app HTTPS/PWA acceptance. Starts an ephemeral 127.0.0.1-only server.
 * Chromium trusts only this run's synthetic leaf SPKI. No trust-store changes,
 * real GPS, external providers, TAK uplinks, or physical phone claims.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { interceptFixtures } from './qa-fixtureInterception.mjs';
import WebSocket from 'ws';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  startTakHttpsServer,
} from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';
import {
  hookRenderErrors,
  readRenderErrors,
  redact,
} from './qa-browserEvidence.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  assert(args[i + 1] && !args[i + 1].startsWith('--'), `${name} needs a value`);
  return args[i + 1];
}
const artifactDir = path.resolve(
  root,
  option('--artifact-dir', 'qa-artifacts/tak-private'),
);
const distRoot = path.resolve(root, option('--dist', 'dist'));
const timeout = Number(option('--timeout', '90000'));
assert(Number.isFinite(timeout) && timeout >= 1000, 'Invalid timeout');
await fs.access(path.join(distRoot, 'manifest.webmanifest'));
await fs.access(path.join(distRoot, 'gev-sw.js'));
const fixtures = createTakTlsFixtures();
const operatorToken = randomBytes(32).toString('hex');
const certificate = new X509Certificate(fixtures.read('server.pem'));
const spki = createHash('sha256')
  .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64');
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const results = [];
const errors = [];
const authRequests = [];
const unloadSnapshots = [];
const pages = [];
const interceptions = [];
let nowMs = Date.now();
let instance;
let browser;
let externalRequests = 0;
let providerRequests = 0;
let rejectInitialStatus = false;
let logoutSnapshot = null;
let observedLogoutPost = false;
const frames = { sent: [], received: [], protocols: [] };
const savedProviderEnv = ['AISSTREAM_API_KEY', 'LOCAL_RECEIVER_FEEDS'].map(
  (name) => [name, process.env[name]],
);
const scrub = (value) => redact(value).replaceAll(operatorToken, 'REDACTED');
async function step(name, run) {
  const start = Date.now();
  console.log(`running ${name}`);
  await run();
  results.push({ name, passed: true, elapsedMs: Date.now() - start });
  console.log(`ok ${results.length} ${name}`);
}
function request(
  pathname,
  { method = 'GET', cookie, body, headers = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      instance.origin + pathname,
      {
        method,
        ca: fixtures.read('ca.pem'),
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function touch(page, selector) {
  await page.$eval(selector, (el) =>
    el.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const point = await page.$eval(selector, (el) => {
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      visible: !!hit && (hit === el || el.contains(hit)),
      width: innerWidth,
      height: innerHeight,
    };
  });
  assert(
    point.visible &&
      point.x >= 0 &&
      point.x <= point.width &&
      point.y >= 0 &&
      point.y <= point.height,
    `Touch target is covered or outside the viewport: ${selector}`,
  );
  const marker = `QA tap delivered ${selector}`;
  const clicked = new Promise((resolve, reject) => {
    const listener = (message) => {
      if (message.text() !== marker) return;
      clearTimeout(timer);
      page.off('console', listener);
      resolve();
    };
    const timer = setTimeout(() => {
      page.off('console', listener);
      reject(new Error(`Physical touch did not deliver a click: ${selector}`));
    }, 3000);
    page.on('console', listener);
  });
  await page.$eval(
    selector,
    (el, text) =>
      el.addEventListener('click', () => console.debug(text), { once: true }),
    marker,
  );
  await page.touchscreen.tap(point.x, point.y);
  await clicked;
}
async function openSection(page, name) {
  await page.$eval(`[data-tak-section="${name}"]`, (el) => {
    el.open = true;
  });
}
async function boot(page) {
  await page.waitForFunction(() => !!window.__godsEyeView?.takClient, {
    timeout,
  });
  await page.waitForFunction(
    () => {
      const el = document.getElementById('loading-screen');
      return (
        !el ||
        getComputedStyle(el).display === 'none' ||
        el.classList.contains('hidden')
      );
    },
    { timeout },
  );
  const welcomeDismissed = await page.evaluate(
    () =>
      sessionStorage.getItem('gev:first-run-mission-session:v1') ===
      'dismissed',
  );
  if (!welcomeDismissed) {
    // Welcome is intentionally initialized after the loading transition. A
    // premature click on the hidden template has no registered handler yet.
    await page.waitForSelector('#first-run-launcher.visible', { timeout });
    await touch(page, '.first-run-explore');
    await page.waitForFunction(
      () =>
        !document
          .getElementById('first-run-launcher')
          ?.classList.contains('visible'),
      { timeout },
    );
  }
  await page.waitForFunction(
    async () => !!(await navigator.serviceWorker.getRegistration('/'))?.active,
    { timeout },
  );
  await touch(page, '.tak-web-launcher');
  await page.waitForSelector('#tak-web-panel:not([hidden])');
}
async function connect(page) {
  await openSection(page, 'network');
  await page.waitForFunction(
    () => !document.querySelector('[data-tak-logout]').hidden,
    { timeout },
  );
  // Even a stale/autofilled token field must not switch private HTTPS back
  // to raw-token transport mode and lose cookie-expiry handling.
  await page.$eval('[data-tak-token]', (el) => {
    el.value = 'synthetic-unused-token-0123456789';
  });
  await touch(page, '[data-tak-connect]');
  await page.waitForFunction(
    () => window.__godsEyeView.takClient.client.link().state === 'open',
    { timeout },
  );
  await page.waitForFunction(
    () => document.querySelector('.tak-web-root').dataset.link === 'open',
    { timeout },
  );
}
async function stateSnapshot(page) {
  return page.evaluate(() => {
    const tak = window.__godsEyeView.takClient;
    return {
      contacts: tak.client.store.count(),
      chats: tak.client.store.chats().length,
      fix: tak.client.fix(),
      sa: tak.client.saEnabled(),
      privacy: tak.privacy(),
      activeGps: window.__qaGps.active(),
      privateInputs: [
        ...document.querySelectorAll(
          '.tak-web-root input:not([type="checkbox"]),.tak-web-root textarea',
        ),
      ].some((el) => el.value !== ''),
      markerShare: document.querySelector('[data-tak-marker-broadcast]')
        .checked,
      emergency: document
        .querySelector('[data-tak-emergency]')
        .getAttribute('aria-pressed'),
    };
  });
}
async function storageSnapshot(page) {
  return page.evaluate(async () => ({
    caches: await caches.keys(),
    databases: (await indexedDB.databases()).map((entry) => entry.name),
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
}
async function finishExpiredNavigation(page, baseline, expectExpired = true) {
  await page.waitForFunction(() => location.pathname === '/login', { timeout });
  const deadline = Date.now() + timeout;
  while (unloadSnapshots.length <= baseline && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const snapshot = unloadSnapshots.slice(baseline).at(-1);
  assert(
    snapshot,
    'The departing tactical document must report its cleared state',
  );
  if (expectExpired) assert.equal(snapshot.sessionExpired, true);
  assert.equal(snapshot.contacts, 0);
  assert.equal(snapshot.chats, 0);
  assert.equal(snapshot.fix, null);
  assert.equal(snapshot.sa, false);
  assert.equal(snapshot.activeGps, false);
  assert.equal(snapshot.privateInputs, false);
  assert.equal(snapshot.privacy.authorized, false);
  assert.equal(snapshot.markerShare, false);
  assert.equal(snapshot.emergency, 'false');
  assert.equal(new URL(page.url()).pathname, '/login');
  if (expectExpired)
    assert.equal((await request('/api/tak/status')).status, 401);
}
async function screenshot(page, name) {
  if (
    await page.evaluate(
      () => !!window.__godsEyeView?.viewer?.scene?.globe?.show,
    )
  ) {
    await page.bringToFront();
    await page.waitForFunction(
      () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
      { timeout },
    );
  }
  // Fixtures only; also conceal all credential and generated device UID fields.
  await page.addStyleTag({
    content: 'input[type=password],[data-tak-uid]{visibility:hidden!important}',
  });
  await page.screenshot({
    path: path.join(artifactDir, name),
    fullPage: false,
  });
}
async function preparePage() {
  const page = await browser.newPage();
  pages.push(page);
  page.setDefaultTimeout(timeout);
  await page.exposeFunction('__qaRecordUnload', (snapshot) =>
    unloadSnapshots.push(snapshot),
  );
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await hookRenderErrors(page);
  page.on('pageerror', (error) => errors.push(scrub(error?.message || error)));
  page.on('console', (message) => {
    const text = message.text();
    if (
      /An error occurred while rendering|initialization failed|listener error|QA unhandled promise/i.test(
        text,
      )
    )
      errors.push(scrub(text));
  });
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('beforeunload', () => {
      const tak = window.__godsEyeView?.takClient;
      if (!tak) return;
      void window
        .__qaRecordUnload({
          contacts: tak.client.store.count(),
          chats: tak.client.store.chats().length,
          fix: tak.client.fix() ? true : null,
          sa: tak.client.saEnabled(),
          privacy: tak.privacy(),
          activeGps: window.__qaGps.active(),
          sessionExpired: tak.client.link().sessionExpired,
          privateInputs: [
            ...document.querySelectorAll(
              '.tak-web-root input:not([type="checkbox"]),.tak-web-root textarea',
            ),
          ].some((el) => el.value !== ''),
          markerShare: document.querySelector('[data-tak-marker-broadcast]')
            .checked,
          emergency: document
            .querySelector('[data-tak-emergency]')
            .getAttribute('aria-pressed'),
        })
        .catch(() => {});
    });
    let success;
    let active = false;
    let clearCount = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(fn) {
          success = fn;
          active = true;
          return 73;
        },
        clearWatch() {
          active = false;
          clearCount++;
        },
      },
    });
    window.__qaGps = {
      active: () => active,
      cleared: () => clearCount,
      emit(ageMs = 0) {
        success?.({
          timestamp: Date.now() - ageMs,
          coords: {
            latitude: 34.3665,
            longitude: -89.5192,
            altitude: 185,
            accuracy: 7.2,
            altitudeAccuracy: 12,
            heading: 45,
            speed: 0,
          },
        });
      },
    };
    window.__qaUnhandled = [];
    window.addEventListener('unhandledrejection', (e) => {
      window.__qaUnhandled.push(String(e.reason?.message || e.reason));
      console.error('QA unhandled promise');
    });
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', (event) => {
    if (event.url.includes(operatorToken))
      errors.push('Operator token in WS URL');
  });
  cdp.on('Network.webSocketWillSendHandshakeRequest', ({ request: req }) => {
    const protocol = Object.entries(req.headers).find(
      ([name]) => name.toLowerCase() === 'sec-websocket-protocol',
    )?.[1];
    if (protocol) frames.protocols.push(protocol);
  });
  for (const [event, list] of [
    ['Network.webSocketFrameSent', frames.sent],
    ['Network.webSocketFrameReceived', frames.received],
  ]) {
    cdp.on(event, ({ response }) => {
      const data = response.payloadData;
      if (data.includes(operatorToken))
        errors.push('Operator token in WebSocket payload');
      if (data.startsWith('{')) {
        try {
          list.push(JSON.parse(data).op);
        } catch {
          /* malformed frames tested separately */
        }
      }
    });
  }
  const interception = await interceptFixtures(page, {
    origin: instance.origin,
    includePaths: ['/login', '/logout'],
    handle: async (req) => {
      try {
        const url = new URL(req.url());
        assert(
          !url.href.includes(operatorToken),
          'Operator token in request URL',
        );
        if (url.origin === instance.origin) {
          if (rejectInitialStatus && url.pathname === '/api/tak/status') {
            rejectInitialStatus = false;
            await page.waitForFunction(
              () => !!window.__godsEyeView?.takClient,
              {
                timeout,
              },
            );
            await page.evaluate(() => {
              window.__godsEyeView.takClient.client.setFix({
                lat: 34.3665,
                lon: -89.5192,
                source: 'USER',
              });
              const consent = document.querySelector('[data-tak-disclosure]');
              consent.checked = true;
              consent.dispatchEvent(new Event('change', { bubbles: true }));
              document.querySelector('[data-tak-xml]').value =
                'SYNTHETIC INITIAL STATUS INPUT';
            });
            return await req.respond({
              status: 401,
              contentType: 'application/json',
              headers: { 'Cache-Control': 'no-store' },
              body: '{"error":"Operator login required"}',
            });
          }
          if (url.pathname === '/logout') {
            observedLogoutPost = req.method() === 'POST';
            logoutSnapshot = await stateSnapshot(page);
          }
          if (
            url.pathname.startsWith('/api/') &&
            !url.pathname.startsWith('/api/tak/')
          ) {
            providerRequests++;
            return await req.respond({
              status: 200,
              contentType: 'application/json',
              body:
                url.pathname === '/api/openai/hud-summary'
                  ? '{"summary":"Synthetic QA globe ready"}'
                  : '{}',
            });
          }
          return await req.continue();
        }
        if (!url.protocol.startsWith('http')) return await req.continue();
        externalRequests++;
        // A 404 asks Cesium to probe legacy heightmap metadata; 400 gives the
        // established flat-terrain fallback promptly in this hermetic fixture.
        if (url.hostname === 'terrain.reearth.land')
          return await req.respond({
            status: 400,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: '{}',
          });
        const knownTile =
          /\/tile\/\d+\/\d+\/\d+$/.test(url.pathname) ||
          /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname);
        if (url.pathname.endsWith('/World_Imagery/MapServer/tile/19/0/0'))
          return await req.respond({
            status: 404,
            contentType: 'text/plain',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: 'Synthetic missing-image sentinel',
          });
        if (knownTile)
          return await req.respond({
            status: 200,
            contentType: 'image/jpeg',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: tile,
          });
        if (url.pathname.endsWith('/World_Imagery/MapServer'))
          return await req.respond({
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
        return await req.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '{}',
        });
      } catch (error) {
        errors.push(scrub(error?.message || error));
        await req.abort().catch(() => {});
      }
    },
  });
  interceptions.push(interception);
  return { page, cdp };
}
async function login(page) {
  await page.goto(instance.origin, { waitUntil: 'domcontentloaded', timeout });
  assert.equal(new URL(page.url()).pathname, '/login');
  await submitLogin(page);
  await boot(page);
}
async function submitLogin(page, expectApp = true) {
  await page.type('input[name="token"]', operatorToken);
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
    touch(page, 'form button'),
  ]);
  assert.equal(response.status(), 200, 'Native login form must reach the app');
  if (expectApp) assert.equal(new URL(page.url()).pathname, '/');
}

async function startFixtureServer(port = 0) {
  const app = await startTakHttpsServer({
    env: {
      TAK_HTTPS_HOST: '127.0.0.1',
      TAK_GATEWAY_TOKEN: operatorToken,
      TAK_HTTPS_CERT: fixtures.file('server.pem'),
      TAK_HTTPS_KEY: fixtures.file('server.key'),
    },
    distRoot,
    port,
    now: () => nowMs,
  });
  assert.equal(new URL(app.origin).hostname, '127.0.0.1');
  app.server.prependListener('request', (req) => {
    if (!['/login', '/logout'].includes(req.url)) return;
    const entry = {
      method: req.method,
      path: req.url,
      origin: req.headers.origin || null,
      fetchSite: req.headers['sec-fetch-site'] || null,
    };
    authRequests.push(entry);
  });
  return app;
}

try {
  await fs.mkdir(artifactDir, { recursive: true });
  // Default providers are installed, but their only eager network sources are
  // explicitly disabled. Browser provider requests are intercepted below.
  for (const [name] of savedProviderEnv) process.env[name] = '';
  instance = await startFixtureServer();
  browser = await puppeteer.launch({
    headless: !args.includes('--headful'),
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      `--ignore-certificate-errors-spki-list=${spki}`,
      ...(args.includes('--headful')
        ? []
        : ['--use-gl=angle', '--use-angle=swiftshader']),
    ],
  });
  const { page, cdp } = await preparePage();
  await step(
    'HTTPS login wall protects app, API, manifest and worker',
    async () => {
      for (const url of ['/', '/manifest.webmanifest', '/gev-sw.js']) {
        const response = await request(url);
        assert.equal(response.status, 303);
        assert.equal(response.headers.location, '/login');
        assert.equal(response.headers['cache-control'], 'no-store');
      }
      assert.equal((await request('/api/tak/status')).status, 401);
      assert.equal((await request('/api/setup/keys')).status, 404);
      assert.equal((await request('/mcp')).status, 404);
      await login(page);
      assert.equal(
        authRequests.find(
          (entry) => entry.method === 'POST' && entry.path === '/login',
        )?.origin,
        instance.origin,
      );
      assert.equal(await page.evaluate(() => window.isSecureContext), true);
      const cookie = (await browser.defaultBrowserContext().cookies()).find(
        (entry) => entry.name === SESSION_COOKIE,
      );
      assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
      assert(
        !(await page.evaluate(() =>
          document.cookie.includes('__Host-gev-tak-session'),
        )),
      );
    },
  );
  await step(
    'credentialed manifest and network-only service worker register behind login',
    async () => {
      assert.equal(
        await page.$eval('link[rel="manifest"]', (el) => el.crossOrigin),
        'use-credentials',
      );
      const manifest = await cdp.send('Page.getAppManifest');
      assert.deepEqual(manifest.errors, []);
      const parsed = JSON.parse(manifest.data);
      assert.equal(parsed.start_url, '/');
      assert.equal(parsed.display, 'standalone');
      assert(parsed.icons.length >= 2);
      const registration = await page.evaluate(async () => {
        const reg = await navigator.serviceWorker.ready;
        return {
          active: reg.active?.scriptURL,
          scope: reg.scope,
          cache: reg.updateViaCache,
        };
      });
      assert.equal(registration.active, instance.origin + '/gev-sw.js');
      assert.equal(registration.scope, instance.origin + '/');
      assert.equal(registration.cache, 'none');
      await page.reload({ waitUntil: 'domcontentloaded', timeout });
      await boot(page);
      assert.equal(
        await page.evaluate(
          () => navigator.serviceWorker.controller?.scriptURL,
        ),
        instance.origin + '/gev-sw.js',
      );
    },
  );
  await step(
    'cookie-only Connect waits for real gateway identity acknowledgement',
    async () => {
      await connect(page);
      assert(frames.sent.includes('identity'));
      assert(frames.received.includes('identity'));
      assert(
        frames.protocols.length > 0 &&
          frames.protocols.every((protocol) => protocol === 'tak.v1'),
      );
      const safe = await page.evaluate(() => ({
        text: document.documentElement.textContent,
        url: location.href,
        tokenInput: document.querySelector('[data-tak-token]').value,
      }));
      assert.equal(safe.tokenInput, '');
      assert(!JSON.stringify(safe).includes(operatorToken));
      // WS status deliberately omits HTTP session metadata. It must not mask
      // the authenticated HTTP status and hide the only Sign out control.
      assert.equal(
        await page.$eval('[data-tak-logout]', (el) => el.hidden),
        false,
      );
      assert.equal(
        await page.evaluate(
          async () =>
            (await (await fetch('/api/tak/status')).json())
              .sessionAuthenticated,
        ),
        true,
      );
    },
  );
  await step(
    'phone touch layout, measured GPS freshness and private state work in production',
    async () => {
      await openSection(page, 'position');
      await touch(page, '[data-tak-gps]');
      await page.evaluate(() => window.__qaGps.emit());
      await page.waitForFunction(() =>
        document.querySelector('[data-tak-fix]').textContent.includes('FRESH'),
      );
      const position = await page.$eval(
        '[data-tak-fix]',
        (el) => el.textContent,
      );
      assert(
        position.includes('DEVICE GPS') &&
          position.includes('±8 m reported accuracy'),
      );
      assert.deepEqual(
        await page.evaluate(() => window.__godsEyeView.takClient.privacy()),
        { private: true, authorized: false },
      );
      const layout = await page.$eval('#tak-web-panel', (panel) => {
        panel.scrollTop = 0;
        const rect = panel.getBoundingClientRect();
        const button = panel.querySelector('[data-tak-gps]');
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: innerWidth,
          height: innerHeight,
          touchHeight: button.getBoundingClientRect().height,
          inputFont: getComputedStyle(
            panel.querySelector('input:not([type=checkbox])'),
          ).fontSize,
          device: document.querySelector('[data-tak-device-state]').textContent,
        };
      });
      assert(
        layout.left >= 0 &&
          layout.right <= layout.width + 1 &&
          layout.top >= 0 &&
          layout.bottom <= layout.height,
      );
      assert(layout.touchHeight >= 44);
      assert(Number.parseFloat(layout.inputFont) >= 16);
      assert(layout.device.includes('FOREGROUND'));
      await page.evaluate(() => window.__qaGps.emit(60000));
      await page.waitForFunction(() =>
        document.querySelector('[data-tak-fix]').textContent.includes('STALE'),
      );
      await screenshot(page, '01-phone-gps-private.png');
      const storage = await storageSnapshot(page);
      assert.deepEqual(storage.caches, []);
      assert.deepEqual(storage.databases, []);
      assert(!JSON.stringify(storage).includes('34.3665'));
      assert(!JSON.stringify(storage).includes(operatorToken));
    },
  );
  await step(
    'each marker starts unshared and submission does not arm the next marker',
    async () => {
      await openSection(page, 'marker');
      assert.equal(
        await page.$eval('[data-tak-marker-broadcast]', (el) => el.checked),
        false,
      );
      const tx = await page.evaluate(
        () => window.__godsEyeView.takClient.client.counters().tx,
      );
      await page.$eval('[data-tak-marker-form]', (form) => {
        form.querySelector('[data-tak-callsign]').value =
          'SYNTHETIC PRIVATE UNVETTED MARKER';
        form.querySelector('[data-tak-lat]').value = '34.37';
        form.querySelector('[data-tak-lon]').value = '-89.52';
      });
      await touch(page, '[data-tak-marker-form] button[type="submit"]');
      await page.waitForFunction(() =>
        window.__godsEyeView.takClient.client.store
          .list()
          .some(
            (contact) =>
              contact.callsign === 'SYNTHETIC PRIVATE UNVETTED MARKER',
          ),
      );
      assert.equal(
        await page.$eval('[data-tak-marker-broadcast]', (el) => el.checked),
        false,
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.client.counters().tx,
        ),
        tx,
      );
    },
  );
  await step(
    'bounded contact storage reports evictions without exposing private contact details',
    async () => {
      const resources = await page.evaluate(() => {
        const client = window.__godsEyeView.takClient.client;
        const time = new Date().toISOString();
        const stale = new Date(Date.now() + 300000).toISOString();
        const extension = '<n/>'.repeat(6000);
        for (let i = 0; i < 20; i++)
          client.importXml(
            `<event version="2.0" uid="synthetic-capacity-${i}" type="a-f-G-U-C" how="h-e" time="${time}" start="${time}" stale="${stale}"><point lat="34" lon="-89"/><detail><contact callsign="SYNTHETIC PRIVATE CAPACITY ${i}"/><sensor>${extension}</sensor></detail></event>`,
          );
        return client.store.resourceStats();
      });
      assert(resources.evictedContacts > 0);
      assert(resources.xmlNodes <= resources.xmlNodeLimit);
      assert(resources.serializedBytes <= resources.byteLimit);
      await page.waitForFunction(
        () => !document.querySelector('[data-tak-resources]').hidden,
      );
      const notice = await page.$eval(
        '[data-tak-resources]',
        (el) => el.textContent,
      );
      assert(notice.includes('older contacts removed'));
      assert(
        !notice.includes('SYNTHETIC PRIVATE') &&
          !notice.includes('synthetic-capacity'),
      );
    },
  );
  await step(
    'offline navigation is a generic reconnect page; private data is not cached',
    async () => {
      // First verify the browser's own connectivity badge, then use a real
      // server outage so worker fetches fail independently of CDP emulation.
      await page.waitForFunction(
        () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
        { timeout },
      );
      console.log(
        '  offline: real globe ready; requesting browser offline mode',
      );
      await page.setOfflineMode(true);
      console.log(
        '  offline: browser emulation acknowledged; waiting for device badge',
      );
      await page.waitForFunction(() =>
        document
          .querySelector('[data-tak-device-state]')
          .textContent.includes('OFFLINE / LOCAL'),
      );
      console.log(
        '  offline: device badge confirmed; restoring browser network',
      );
      await page.setOfflineMode(false);
      const port = Number(new URL(instance.origin).port);
      const origin = instance.origin;
      console.log('  offline: closing real HTTPS server');
      await instance.close();
      // GEV updates the location hash. Use the second supported shell path to
      // force a real document request rather than only clearing that hash.
      const response = await page.goto(instance.origin + '/index.html', {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      console.log(
        '  offline: outage navigation committed; checking service-worker reconnect page',
      );
      // Chromium may return no Puppeteer HTTPResponse for a synthetic worker
      // document. Check the committed document and browser navigation timing.
      await page.waitForFunction(() => document.title === 'GEV TAK · Offline');
      assert.equal(new URL(page.url()).pathname, '/index.html');
      const navigation = await page.evaluate(() => {
        const entry = performance.getEntriesByType('navigation')[0];
        return {
          status: entry?.responseStatus,
          workerStart: entry?.workerStart,
        };
      });
      if (navigation.status) assert.equal(navigation.status, 503);
      if (response) {
        assert.equal(response.status(), 503);
        assert.equal(response.fromServiceWorker(), true);
      }
      const body = await page.$eval('body', (el) => el.textContent);
      assert(body.includes('Reconnect to your approved private network'));
      assert(!body.includes('34.3665') && !body.includes(operatorToken));
      assert.equal(await page.evaluate(() => !!window.__godsEyeView), false);
      const state = await storageSnapshot(page);
      assert.deepEqual(state.caches, []);
      assert.deepEqual(state.databases, []);
      const api = await page.evaluate(async () => {
        try {
          const res = await fetch('/api/tak/status');
          return { failed: false, content: await res.text() };
        } catch {
          return { failed: true };
        }
      });
      assert.equal(api.failed, true);
      assert.equal(
        await page.$eval('a[href="/"]', (el) => el.textContent),
        'Try again',
      );
      await screenshot(page, '02-offline-reconnect.png');
      console.log(
        '  offline: generic reconnect page verified; restarting HTTPS server',
      );
      instance = await startFixtureServer(port);
      assert.equal(instance.origin, origin);
      // Server sessions are intentionally memory-only; restart requires login.
      await login(page);
      assert.equal(
        await page.evaluate(() => window.__godsEyeView.takClient.client.fix()),
        null,
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.client.link().state,
        ),
        'idle',
      );
      await connect(page);
    },
  );
  await step(
    'Sign out clears local state before POST and revokes cookie and open sockets',
    async () => {
      const cookie = (await browser.defaultBrowserContext().cookies()).find(
        (entry) => entry.name === SESSION_COOKIE,
      );
      assert(cookie, 'An authenticated operator cookie is required');
      // A second authenticated socket remains open independently of the UI's
      // voluntary disconnect. This proves server-side logout revocation.
      const observer = new WebSocket(
        instance.origin.replace('https:', 'wss:') + '/api/tak/ws',
        ['tak.v1'],
        {
          ca: fixtures.read('ca.pem'),
          headers: {
            Origin: instance.origin,
            Cookie: `${SESSION_COOKIE}=${cookie.value}`,
          },
        },
      );
      observer.on('error', () => {});
      await once(observer, 'open');
      const observerClosed = once(observer, 'close');
      await openSection(page, 'position');
      await touch(page, '[data-tak-gps]');
      await page.evaluate(() => {
        window.__qaGps.emit();
        window.__godsEyeView.takClient.client.addMarker({
          callsign: 'SYNTHETIC PRIVATE EUD',
          lat: 34.37,
          lon: -89.52,
          broadcast: false,
        });
        const consent = document.querySelector('[data-tak-disclosure]');
        consent.checked = true;
        consent.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('[data-tak-xml]').value =
          'SYNTHETIC PRIVATE INPUT';
      });
      await openSection(page, 'network');
      await touch(page, '[data-tak-logout]');
      await page.waitForFunction(() => location.pathname === '/login');
      assert.equal(observedLogoutPost, true);
      assert.equal(logoutSnapshot.contacts, 0);
      assert.equal(logoutSnapshot.chats, 0);
      assert.equal(logoutSnapshot.fix, null);
      assert.equal(logoutSnapshot.sa, false);
      assert.equal(logoutSnapshot.activeGps, false);
      assert.equal(logoutSnapshot.privateInputs, false);
      assert.equal(logoutSnapshot.privacy.authorized, false);
      assert.equal(logoutSnapshot.markerShare, false);
      assert.equal(logoutSnapshot.emergency, 'false');
      const [code, reason] = await observerClosed;
      assert.equal(code, 1008);
      assert.equal(reason.toString(), 'session expired');
      assert(
        !(await browser.defaultBrowserContext().cookies()).some(
          (entry) => entry.name === SESSION_COOKIE,
        ),
      );
      assert.equal((await request('/api/tak/status')).status, 401);
      await page.reload({ waitUntil: 'domcontentloaded', timeout });
      assert.equal(new URL(page.url()).pathname, '/login');
    },
  );
  await step(
    'expired cookie session closes real WSS, clears GPS/private state and returns to login',
    async () => {
      await login(page);
      await connect(page);
      await openSection(page, 'position');
      await touch(page, '[data-tak-gps]');
      await page.evaluate(() => {
        window.__qaGps.emit();
        window.__godsEyeView.takClient.client.addMarker({
          callsign: 'SYNTHETIC EXPIRED EUD',
          lat: 34.37,
          lon: -89.52,
          broadcast: false,
        });
        document.querySelector('[data-tak-xml]').value =
          'SYNTHETIC EXPIRING INPUT';
      });
      const baseline = unloadSnapshots.length;
      nowMs += SESSION_TTL_MS + 1;
      instance.gateway.recheckSessions();
      await finishExpiredNavigation(page, baseline);
      await screenshot(page, '03-signed-out.png');
    },
  );
  await step(
    'expired session while disconnected is detected after a refused WSS upgrade',
    async () => {
      await login(page);
      await connect(page);
      await openSection(page, 'position');
      await touch(page, '[data-tak-gps]');
      await page.evaluate(() => window.__qaGps.emit());
      await openSection(page, 'network');
      await touch(page, '[data-tak-disconnect]');
      await page.waitForFunction(
        () => window.__godsEyeView.takClient.client.link().state === 'closed',
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.privacy().private,
        ),
        true,
      );
      nowMs += SESSION_TTL_MS + 1;
      const baseline = unloadSnapshots.length;
      await touch(page, '[data-tak-connect]');
      await finishExpiredNavigation(page, baseline);
    },
  );
  await step(
    'simulated initial status HTTP401 clears data loaded during the pending status request',
    async () => {
      await page.goto(instance.origin + '/login', {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      rejectInitialStatus = true;
      const baseline = unloadSnapshots.length;
      await submitLogin(page, false);
      await finishExpiredNavigation(page, baseline, false);
    },
  );
  await step(
    'no app errors, tactical caches, credentials or private payload persistence',
    async () => {
      for (const current of pages) {
        errors.push(...(await readRenderErrors(current)));
        errors.push(
          ...(await current.evaluate(() => window.__qaUnhandled || [])),
        );
        const storage = await storageSnapshot(current);
        assert.deepEqual(storage.caches, []);
        assert.deepEqual(storage.databases, []);
        for (const value of [
          operatorToken,
          'SYNTHETIC PRIVATE',
          'SYNTHETIC EXPIRED',
          '34.3665',
        ])
          assert(!JSON.stringify(storage).includes(value));
      }
      errors.push(...interceptions.flatMap((item) => item.errors));
      assert.deepEqual(errors, []);
    },
  );
  console.log(
    `Passed ${results.length} production HTTPS/PWA browser scenarios (synthetic, loopback only).`,
  );
} catch (error) {
  process.exitCode = 1;
  errors.push(scrub(error?.stack || error));
  console.error(scrub(error?.stack || error));
  for (const [i, page] of pages.entries())
    await screenshot(page, `failure-${i}.png`).catch(() => {});
} finally {
  try {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, 'results.json'),
      JSON.stringify(
        {
          status: process.exitCode ? 'failed' : 'passed',
          date: new Date().toISOString(),
          node: process.version,
          browser: browser
            ? await browser.version().catch(() => 'closed')
            : null,
          syntheticOnly: true,
          loopbackOnly: true,
          trust: 'ephemeral synthetic leaf SPKI only; no system trust changes',
          physicalPhoneTested: false,
          realTakPeerTested: false,
          externalRequestsIntercepted: externalRequests,
          providerRequestsIntercepted: providerRequests,
          fixtureCancellations: interceptions.flatMap(
            (item) => item.cancellations,
          ),
          authRequests,
          results,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled(interceptions.map((item) => item.dispose()));
    await Promise.allSettled([browser?.close(), instance?.close()]);
    for (const [name, value] of savedProviderEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fixtures.cleanup();
  }
}
