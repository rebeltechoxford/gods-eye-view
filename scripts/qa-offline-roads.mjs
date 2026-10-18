#!/usr/bin/env node
/**
 * Offline driving-directions acceptance in Chromium.
 *
 * Development lab, against a running app whose gateway serves a road pack:
 *
 *   GEV_ROAD_PACK_DIR=<dir with *.gevroads + .json> npm run tak:lab
 *   node scripts/qa-offline-roads.mjs --url http://127.0.0.1:4174
 *
 * Built private HTTPS app with a real outage (run `npm run build` first):
 *
 *   node scripts/qa-offline-roads.mjs --https --pack-dir <dir>
 *
 * Every request to an online router is refused for the whole run, so a route
 * can only come from the on-device pack. The script installs the first listed
 * pack through the TAK panel, routes a drive (default Oxford to Tupelo, MS;
 * --from/--to lat,lon), checks a walking request fails with the offline
 * explanation, and reloads and routes again from device storage. With
 * --https it starts its own loopback HTTPS server with a synthetic operator
 * token, signs in through the real login form at phone size, expects the
 * install to save the app for offline launch, then stops the server and
 * routes from a fresh page served by the saved app.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startTakHttpsServer } from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const https = argv.includes('--https');
const point = (text) => {
  const [lat, lon] = text.split(',').map(Number);
  assert(Number.isFinite(lat) && Number.isFinite(lon), `bad point ${text}`);
  return { lat, lon };
};
const from = point(option('--from', '34.3664,-89.5193'));
const to = point(option('--to', '34.2576,-88.7034'));
const artifactDir = option(
  '--artifact-dir',
  https ? 'qa-artifacts/offline-roads-https' : 'qa-artifacts/offline-roads',
);
const timeout = Number(option('--timeout', '180000'));
await fs.mkdir(artifactDir, { recursive: true });

// Only router URLs are paused (CDP Fetch patterns; "\?" is a literal "?").
// page.setRequestInterception would also pause the route worker's module
// imports, which Puppeteer can leave pending (see qa-fixtureInterception.mjs).
const ROUTER_PATTERNS = [
  '*/api/route',
  '*/api/route\\?*',
  '*://routing.openstreetmap.de/*',
  '*://router.project-osrm.org/*',
];
const routerRequests = [];
const results = [];
const errors = [];
const consoleLines = [];
const step = async (name, fn) => {
  const started = Date.now();
  await fn();
  results.push({ name, ms: Date.now() - started });
  console.log(`ok ${results.length} ${name} (${Date.now() - started} ms)`);
};

let server = null;
let certificates = null;
let fixtureRoot = null;
let origin;
let token;
let spki;
const environment = ['AISSTREAM_API_KEY', 'LOCAL_RECEIVER_FEEDS'].map(
  (name) => [name, process.env[name]],
);
if (https) {
  const distRoot = path.resolve(option('--dist', 'dist'));
  await fs.access(path.join(distRoot, 'gev-sw.js')).catch(() => {
    throw new Error('--https needs a production build: run npm run build');
  });
  const packDir = option('--pack-dir', process.env.GEV_ROAD_PACK_DIR);
  assert(packDir, '--https needs --pack-dir <dir> or GEV_ROAD_PACK_DIR');
  // Keep live public feeds out of the synthetic server.
  for (const [name] of environment) delete process.env[name];
  certificates = createTakTlsFixtures();
  token = randomBytes(32).toString('hex');
  spki = createHash('sha256')
    .update(
      new X509Certificate(certificates.read('server.pem')).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('base64');
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-offline-roads-'));
  server = await startTakHttpsServer({
    env: {
      TAK_HTTPS_HOST: '127.0.0.1',
      TAK_GATEWAY_TOKEN: token,
      TAK_HTTPS_CERT: certificates.file('server.pem'),
      TAK_HTTPS_KEY: certificates.file('server.key'),
    },
    distRoot,
    port: 0,
    offlineMaps: { root: path.join(fixtureRoot, 'maps') },
    roadPacks: { root: path.resolve(packDir) },
  });
  origin = server.origin;
} else {
  const url = new URL(option('--url', 'http://127.0.0.1:4174'));
  assert(
    ['127.0.0.1', 'localhost'].includes(url.hostname),
    'QA runs only against a local app',
  );
  origin = url.origin;
}

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  defaultViewport: https
    ? { width: 390, height: 844, isMobile: true, hasTouch: true }
    : { width: 1440, height: 900 },
  protocolTimeout: timeout,
  // Same launch flags as the TAK browser gates.
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(argv.includes('--headful')
      ? []
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    ...(https ? [`--ignore-certificate-errors-spki-list=${spki}`] : []),
  ],
});

async function newPage() {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(timeout);
  const cdp = await tab.target().createCDPSession();
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    routerRequests.push(request.url);
    cdp
      .send('Fetch.failRequest', {
        requestId,
        errorReason: 'InternetDisconnected',
      })
      .catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: ROUTER_PATTERNS.map((urlPattern) => ({
      urlPattern,
      requestStage: 'Request',
    })),
  });
  tab.on('pageerror', (error) => errors.push(String(error?.message || error)));
  tab.on('console', (message) => {
    if (['error', 'warn'].includes(message.type()))
      consoleLines.push(`${message.type()}: ${message.text()}`);
  });
  tab.on('workercreated', (worker) =>
    consoleLines.push(`worker started: ${worker.url()}`),
  );
  tab.on('workerdestroyed', (worker) =>
    consoleLines.push(`worker ended: ${worker.url()}`),
  );
  return tab;
}
let page = await newPage();

async function openApp(start = '/?welcome=0') {
  const response = await page.goto(origin + start, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(() =>
    window.__godsEyeView?.dataManager?.layers?.get('directions'),
  );
  return response;
}
// The home-screen launch opens the manifest start_url, "/", with no query:
// the saved app never serves a URL with a query string.
async function launchFromHomeScreen() {
  const response = await openApp('/');
  await page.waitForFunction(() =>
    document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  const welcome = await page
    .waitForSelector('#first-run-launcher.visible', { timeout: 5000 })
    .catch(() => null);
  if (welcome) await page.click('.first-run-explore');
  return response;
}
async function login() {
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
  await page.type('input[name="token"]', token);
  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    page.click('form button'),
  ]);
  assert.equal(response.status(), 200, 'login reaches the built app');
}
async function route(mode) {
  await page.evaluate((m) => {
    window.__godsEyeView.dataManager.setLayerParams(
      'directions',
      { mode: m },
      { origin: 'user' },
    );
  }, mode);
  await page.evaluate(
    (a, b) => {
      const module =
        window.__godsEyeView.dataManager.layers.get('directions').module;
      module.placeEndpoint('a', a);
      module.placeEndpoint('b', b);
    },
    from,
    to,
  );
}
async function waitForRoute() {
  await page.waitForFunction(
    () => {
      const stats = window.__godsEyeView.dataManager.layers
        .get('directions')
        .module.getStats();
      return stats.count > 0 || (stats.error && !stats.loading);
    },
    { timeout },
  );
  return page.evaluate(() => {
    const stats = window.__godsEyeView.dataManager.layers
      .get('directions')
      .module.getStats();
    return {
      count: stats.count,
      error: stats.error,
      source: stats.source,
      coverage: stats.coverage,
    };
  });
}
// Frame both ends so the screenshot shows the drive, not the default view.
async function frameTrip() {
  await page.evaluate(
    (a, b, phone) => {
      const { viewer } = window.__godsEyeView;
      const Cartesian3 = viewer.camera.position.constructor;
      const span = Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(
          (a.lon + b.lon) / 2,
          // On a phone the drawers cover mid-screen; aim below the trip.
          (a.lat + b.lat) / 2 - (phone ? span * 0.55 : 0),
          Math.max(20000, span * 111000 * (phone ? 3.5 : 1.8)),
        ),
      });
    },
    from,
    to,
    https,
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
async function enableDirections() {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('directions', true),
  );
  await page.waitForFunction(() =>
    window.__godsEyeView.dataManager.isEnabled('directions'),
  );
}
async function closeTakPanel() {
  await page.evaluate(() => {
    const panel = document.getElementById('tak-web-panel');
    if (panel && !panel.hidden)
      document.querySelector('.tak-web-launcher')?.click();
  });
}
async function driveOffline(name) {
  await enableDirections();
  const started = Date.now();
  await route('car');
  const drive = await waitForRoute();
  drive.ms = Date.now() - started;
  assert.equal(drive.error, null, `route failed: ${drive.error}`);
  assert.ok(drive.count > 2, 'turn-by-turn steps are present');
  assert.match(drive.source, /^Offline · /);
  assert.match(drive.coverage, /offline/);
  assert.deepEqual(routerRequests, [], 'no online router was asked');
  await closeTakPanel();
  await frameTrip();
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
  return drive;
}

const summary = { mode: https ? 'https-outage' : 'dev-lab', from, to };
try {
  await step('app opens with every online router refused', async () => {
    if (https) await login();
    await openApp();
    await page.waitForSelector('.tak-web-launcher');
    const probe = await page.evaluate(() =>
      fetch('/api/route?profile=car&coords=-89.5,34.4;-88.7,34.3&steps=1').then(
        () => 'answered',
        () => 'refused',
      ),
    );
    assert.equal(probe, 'refused', 'the online router block is in force');
    assert.equal(routerRequests.length, 1, 'refused requests are recorded');
    routerRequests.length = 0;
  });
  await step(
    'a road pack installs through OFFLINE ROADS and verifies',
    async () => {
      // Open the panel once the app has finished loading and wired it.
      await page.waitForFunction(() =>
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      );
      await page.waitForFunction(
        () => {
          const toggle = document.querySelector('.tak-web-launcher');
          if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
          return toggle?.getAttribute('aria-expanded') === 'true';
        },
        { polling: 1000 },
      );
      await page.waitForSelector('[data-tak-section="roads"] > summary', {
        visible: true,
      });
      await page.$eval('[data-tak-section="roads"]', (element) =>
        element.scrollIntoView(),
      );
      await page.click('[data-tak-section="roads"] > summary');
      await page.waitForSelector(
        '[data-roads-available] [data-roads-action="download"]',
        { timeout },
      );
      summary.pack = await page.$eval(
        '[data-roads-available] li span',
        (el) => el.textContent,
      );
      await page.click('[data-roads-available] [data-roads-action="download"]');
      // The final status names whether the app was saved for offline launch.
      await page.waitForFunction(
        () =>
          /installed and verified\..*(saved for offline launch|was not saved)/.test(
            document.querySelector('[data-roads-status]')?.textContent || '',
          ),
        { timeout },
      );
      summary.installStatus = await page.$eval(
        '[data-roads-status]',
        (el) => el.textContent,
      );
      if (https)
        assert.match(
          summary.installStatus,
          /The app is saved for offline launch on this device\./,
        );
      await page.waitForFunction(() =>
        /ready/.test(
          document.querySelector('[data-roads-installed]')?.textContent || '',
        ),
      );
      await page.$eval('[data-tak-section="roads"]', (element) =>
        element.scrollIntoView(),
      );
      await page.screenshot({
        path: path.join(artifactDir, 'offline-roads-installed.png'),
      });
    },
  );
  await step(
    'a drive routes on the device with no router request',
    async () => {
      summary.firstRoute = await driveOffline('offline-drive');
    },
  );
  await step(
    'a walk explains that offline packs cover driving only',
    async () => {
      await route('foot');
      const walk = await waitForRoute();
      assert.equal(walk.count, 0);
      assert.match(walk.error, /cover driving only/);
      // Walking is not in a road pack, so only it may try the online router.
      assert.ok(
        routerRequests.length > 0 &&
          routerRequests.every((url) => /[?&]profile=foot&/.test(url)),
        `only walking asked the online router: ${routerRequests}`,
      );
      summary.walkRouterRequests = routerRequests.length;
      routerRequests.length = 0;
    },
  );
  await step(
    'after a reload the installed pack still routes offline',
    async () => {
      await openApp();
      summary.afterReload = await driveOffline('offline-drive-reloaded');
    },
  );
  if (https)
    await step(
      'with the server stopped, a fresh page launches from the saved app and routes',
      async () => {
        await server.close();
        server = null;
        await page.close();
        page = await newPage();
        const response = await launchFromHomeScreen();
        assert.equal(
          response.fromServiceWorker(),
          true,
          'the page came from the saved app, not the stopped server',
        );
        const status = await page.evaluate(() =>
          fetch('/api/tak/status', { cache: 'no-store' }).then(
            () => 'reachable',
            () => 'unreachable',
          ),
        );
        assert.equal(status, 'unreachable', 'the private server is down');
        summary.duringOutage = await driveOffline('outage-drive');
      },
    );
  assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
  Object.assign(summary, {
    date: new Date().toISOString(),
    status: 'passed',
    browser: await browser.version(),
    refusedRouterRequests: routerRequests,
    results,
  });
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(`Passed ${results.length} offline routing scenarios.`);
  console.log(
    `First drive: ${summary.firstRoute.coverage} (${summary.firstRoute.ms} ms, cold); after reload ${summary.afterReload.ms} ms${summary.duringOutage ? `; server stopped ${summary.duringOutage.ms} ms` : ''}.`,
  );
} catch (error) {
  await page
    .screenshot({ path: path.join(artifactDir, 'failure.png') })
    .catch(() => {});
  console.error(error?.stack || error);
  console.error(consoleLines.slice(-40).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server?.close();
  certificates?.cleanup();
  if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  for (const [name, value] of environment)
    if (value !== undefined) process.env[name] = value;
}
