#!/usr/bin/env node
/**
 * My location acceptance in Chromium against the built private HTTPS app.
 *
 *   npm run build
 *   node scripts/qa-my-location.mjs
 *
 * Chromium's geolocation emulation stands in for the phone's GPS: fixes
 * around Oxford, MS. The gate turns the map's location button on, checks the
 * dot, the accuracy ring and FOLLOW, drags the map to end FOLLOW, follows
 * again, turns it off, saves the view as the start view (Location tray) and
 * checks a reload opens there and Reset returns to the default, checks a
 * denied permission is explained, and checks the button fits a phone-width
 * top bar. Nothing here needs a live provider.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startTakHttpsServer } from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';
import { resolveDefaultStartView } from '../src/ui/startView.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const timeout = Number(option('--timeout', '180000'));
const artifactDir = option('--artifact-dir', 'qa-artifacts/my-location');
const distRoot = path.resolve(option('--dist', 'dist'));
await fs.access(path.join(distRoot, 'index.html')).catch(() => {
  throw new Error('Run npm run build first');
});
await fs.mkdir(artifactDir, { recursive: true });

const OXFORD = { latitude: 34.3665, longitude: -89.5192, accuracy: 15 };
// The default the build was made with (VITE_GEV_START_VIEW, else Austin).
const DEFAULT_START = resolveDefaultStartView(process.env.VITE_GEV_START_VIEW);
const MOVED = { latitude: 34.3712, longitude: -89.5301, accuracy: 6 };
const PANNED = { latitude: 34.3755, longitude: -89.5402, accuracy: 6 };

const certificates = createTakTlsFixtures();
const spki = createHash('sha256')
  .update(
    new X509Certificate(certificates.read('server.pem')).publicKey.export({
      type: 'spki',
      format: 'der',
    }),
  )
  .digest('base64');
const token = randomBytes(32).toString('hex');
const fixtureRoot = await fs.mkdtemp(
  path.join(os.tmpdir(), 'gev-my-location-'),
);
const server = await startTakHttpsServer({
  env: {
    TAK_HTTPS_HOST: '127.0.0.1',
    TAK_GATEWAY_TOKEN: token,
    TAK_HTTPS_CERT: certificates.file('server.pem'),
    TAK_HTTPS_KEY: certificates.file('server.key'),
  },
  distRoot,
  port: 0,
  offlineMaps: { root: path.join(fixtureRoot, 'maps') },
  roadPacks: { root: fixtureRoot },
});
const origin = server.origin;

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: timeout,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--ignore-certificate-errors-spki-list=${spki}`,
  ],
});
const context = browser.defaultBrowserContext();
await context.overridePermissions(origin, ['geolocation']);
const page = await browser.newPage();
page.setDefaultTimeout(timeout);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error?.message || error)));
// Every request the page makes, to show the position is not sent anywhere.
const requests = [];
page.on('request', (request) =>
  requests.push({
    at: Date.now(),
    url: request.url(),
    body: request.postData() || '',
  }),
);
// Count device watches the page opens.
await page.evaluateOnNewDocument(() => {
  window.__gevClipboardWrites = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => window.__gevClipboardWrites.push(text),
    },
  });
  const geo = navigator.geolocation;
  const watch = geo.watchPosition.bind(geo);
  window.__gevWatchCount = 0;
  geo.watchPosition = (...args) => {
    window.__gevWatchCount++;
    return watch(...args);
  };
});

const results = [];
async function step(name, run) {
  const started = Date.now();
  const evidence = await run();
  results.push({
    name,
    ms: Date.now() - started,
    ...(evidence ? { evidence } : {}),
  });
  console.log(`ok ${results.length} ${name} (${Date.now() - started} ms)`);
}

async function booted() {
  await page.waitForFunction(() => window.__godsEyeView?.viewer);
  await page.waitForFunction(() =>
    document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  const welcome = await page
    .waitForSelector('#first-run-launcher.visible', { timeout: 5000 })
    .catch(() => null);
  if (welcome) await page.click('.first-run-explore');
}

const readState = () =>
  page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const button = document.getElementById('my-location-view');
    const source = viewer.dataSources.getByName('my-location')[0];
    const dot = source?.entities.getById('my-location');
    const ring = source?.entities.getById('my-location-accuracy');
    const degrees = (cartesian) => {
      if (!cartesian) return null;
      const c = window.Cesium
        ? window.Cesium.Cartographic.fromCartesian(cartesian)
        : viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian);
      return {
        lat: (c.latitude * 180) / Math.PI,
        lon: (c.longitude * 180) / Math.PI,
        height: c.height,
      };
    };
    const now = viewer.clock.currentTime;
    const camera = viewer.camera.positionCartographic;
    const groundHeight = viewer.scene.globe.getHeight(camera);
    const canvas = viewer.scene.canvas;
    const centerGround = viewer.camera.pickEllipsoid(
      { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 },
      viewer.scene.globe.ellipsoid,
    );
    return {
      state: button.dataset.state,
      pressed: button.getAttribute('aria-pressed'),
      label: button.getAttribute('aria-label'),
      dotShown: Boolean(dot?.show),
      ringShown: Boolean(ring?.show),
      ringRadius: ring?.ellipse?.semiMajorAxis?.getValue(now) ?? null,
      dot: degrees(dot?.position?.getValue(now)),
      camera: {
        lat: (camera.latitude * 180) / Math.PI,
        lon: (camera.longitude * 180) / Math.PI,
        height: camera.height,
      },
      groundHeight: Number.isFinite(groundHeight) ? groundHeight : 0,
      centerGround: degrees(centerGround),
      watches: window.__gevWatchCount,
      toast: document.getElementById('toast')?.textContent || '',
    };
  });

const near = (a, b, tolerance = 1e-4) =>
  Math.abs(a.lat - b.latitude) < tolerance &&
  Math.abs(a.lon - b.longitude) < tolerance;

const safelyFramed = (state, position) =>
  Number.isFinite(state.camera.height) &&
  state.camera.height >= state.groundHeight + 299 &&
  state.camera.height < 10_000 &&
  state.centerGround !== null &&
  near(state.camera, position, 1e-3) &&
  near(state.centerGround, position, 1e-3);

async function waitFor(predicate, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    last = await readState();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}; last state ${JSON.stringify(last)}`);
}

const summary = { origin };
let onAt = 0;
try {
  await step('sign in and boot the app', async () => {
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await page.type('input[name="token"]', token);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('form button'),
    ]);
    await page.setGeolocation(OXFORD);
    await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await booted();
    const state = await readState();
    assert.equal(state.state, 'off');
    assert.equal(state.dotShown, false);
    assert.equal(state.watches, 0, 'no GPS until the user asks');
  });

  await step(
    'the location button finds you, draws the dot and ring, and follows',
    async () => {
      onAt = Date.now();
      await page.click('#my-location-view');
      const state = await waitFor(
        (s) => s.state === 'following' && s.dotShown,
        'dot and FOLLOW',
      );
      assert.ok(near(state.dot, OXFORD), 'dot at the device position');
      assert.equal(state.ringShown, true);
      assert.equal(Math.round(state.ringRadius), OXFORD.accuracy);
      assert.equal(state.pressed, 'true');
      const framed = await waitFor(
        (s) => safelyFramed(s, OXFORD),
        'camera safely above the dot with the surface in the center of view',
      );
      assert.ok(safelyFramed(framed, OXFORD));
      await page.screenshot({
        path: path.join(artifactDir, 'my-location-following.png'),
      });
      return {
        dot: state.dot,
        cameraHeightM: Math.round(framed.camera.height),
        terrainHeightM: framed.groundHeight,
        centerGround: framed.centerGround,
      };
    },
  );

  await step('FOLLOW keeps the camera over each new fix', async () => {
    await page.setGeolocation(MOVED);
    const state = await waitFor(
      (s) => near(s.dot, MOVED) && safelyFramed(s, MOVED),
      'camera follows the moved fix above the surface',
    );
    assert.equal(state.state, 'following');
    assert.equal(Math.round(state.ringRadius), MOVED.accuracy);
    return {
      camera: state.camera,
      terrainHeightM: state.groundHeight,
      centerGround: state.centerGround,
    };
  });

  await step(
    'dragging the map ends FOLLOW; the dot keeps updating',
    async () => {
      const box = await page.$eval('#cesiumContainer canvas, canvas', (c) => {
        const r = c.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
      await page.mouse.up();
      const released = await waitFor(
        (s) => s.state === 'shown',
        'FOLLOW released by the drag',
      );
      const cameraBefore = released.camera;
      await page.setGeolocation(PANNED);
      const state = await waitFor((s) => near(s.dot, PANNED), 'dot moved');
      assert.ok(
        Math.abs(state.camera.lat - cameraBefore.lat) < 1e-6 &&
          Math.abs(state.camera.lon - cameraBefore.lon) < 1e-6,
        'the camera stays where the user left it',
      );
      assert.equal(state.state, 'shown');
    },
  );

  await step(
    'tapping again follows; tapping while following turns it off',
    async () => {
      await page.click('#my-location-view');
      await waitFor(
        (s) => s.state === 'following' && safelyFramed(s, PANNED),
        'FOLLOW again',
      );
      await page.click('#my-location-view');
      const off = await waitFor((s) => s.state === 'off', 'turned off');
      assert.equal(off.dotShown, false);
      assert.equal(off.ringShown, false);
      assert.equal(off.pressed, 'false');
      return { watchesOpened: off.watches };
    },
  );

  await step('the device position is not sent to any server', async () => {
    const fixed = (n) => n.toFixed(3);
    const coordinates = [OXFORD, MOVED, PANNED].flatMap((p) => [
      fixed(p.latitude),
      fixed(p.longitude),
    ]);
    const leaks = requests
      .filter((r) => r.at >= onAt)
      .filter((r) =>
        coordinates.some((c) => r.url.includes(c) || r.body.includes(c)),
      );
    const where = leaks.map((r) => new URL(r.url).pathname);
    // The first fix marks the view private (as TAK self position does), which
    // blocks camera-derived AI lookups such as nearby places for the session.
    assert.deepEqual(where, [], 'no request carried the device position');
    return {
      requestsWhileOn: requests.filter((r) => r.at >= onAt).length,
      where,
    };
  });

  const camera = () =>
    page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera.positionCartographic;
      return {
        lat: (c.latitude * 180) / Math.PI,
        lon: (c.longitude * 180) / Math.PI,
        height: c.height,
      };
    });
  async function openStartRow() {
    const shown = () =>
      page.evaluate(() => {
        const row = document.getElementById('start-view-set');
        const r = row?.getBoundingClientRect();
        return Boolean(r && r.width > 0 && r.height > 0);
      });
    if (!(await shown())) await page.click('#location-bar-toggle');
    await page.waitForFunction(() => {
      const r = document
        .getElementById('start-view-set')
        ?.getBoundingClientRect();
      return r && r.width > 0 && r.height > 0;
    });
  }
  async function reloadFresh() {
    // No hash: a share-link camera would take priority over the start view.
    await page.goto(`${origin}/?welcome=0`, { waitUntil: 'domcontentloaded' });
    await booted();
    // The start flight lands about 4.5 s after boot.
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }
  const nearCamera = (a, b, tolerance) =>
    Math.abs(a.lat - b.lat) < tolerance && Math.abs(a.lon - b.lon) < tolerance;

  let savedCamera = null;
  let privateReloadRequestIndex = 0;
  await step(
    'Start here saves the current view and a reload opens there',
    async () => {
      await openStartRow();
      const before = await page.$eval(
        '#start-view-status',
        (e) => e.textContent,
      );
      assert.equal(before, `Start view: ${DEFAULT_START.label} (default)`);
      savedCamera = await camera();
      await page.click('#start-view-set');
      const after = await page.$eval(
        '#start-view-status',
        (e) => e.textContent,
      );
      assert.match(after, /^Start view: \d+\.\d\d°N \d+\.\d\d°W$/);
      privateReloadRequestIndex = requests.length;
      await reloadFresh();
      const opened = await camera();
      assert.ok(
        nearCamera(opened, savedCamera, 1e-4) &&
          Math.abs(opened.height - savedCamera.height) < 5,
        `opened at ${JSON.stringify(opened)}, saved ${JSON.stringify(savedCamera)}`,
      );
      await openStartRow();
      assert.equal(
        await page.$eval('#start-view-status', (e) => e.textContent),
        after,
        'the saved start view is shown after the reload',
      );
      await page.screenshot({
        path: path.join(artifactDir, 'start-view-saved.png'),
      });
      return { status: after, opened };
    },
  );

  await step(
    'restored private view keeps disclosure blocked after reload',
    async () => {
      await page.waitForFunction(() => window.__godsEyeView?.takClient);
      assert.deepEqual(
        await page.evaluate(() => window.__godsEyeView.takClient.privacy()),
        { private: true, authorized: false },
      );
      assert.equal(
        await page.evaluate(() =>
          [...document.querySelectorAll('[data-tak-disclosure]')].some(
            (input) => input.checked,
          ),
        ),
        false,
        'disclosure permissions are never restored',
      );
      await page.click('#share-btn');
      await page.waitForFunction(() =>
        /privacy protection/i.test(
          document.getElementById('toast')?.textContent || '',
        ),
      );
      assert.match(
        await page.$eval('#toast', (element) => element.textContent),
        /privacy protection/i,
        'sharing the restored private camera requires fresh consent',
      );
      assert.deepEqual(
        await page.evaluate(() => window.__gevClipboardWrites),
        [],
        'blocked private sharing never calls the clipboard writer',
      );
      const leaks = requests
        .slice(privateReloadRequestIndex)
        .filter((request) => {
          const numbers =
            `${decodeURIComponent(request.url)} ${request.body}`.match(
              /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,
            ) || [];
          return numbers.some((number) =>
            [savedCamera.lat, savedCamera.lon].some(
              (coordinate) => Math.abs(Number(number) - coordinate) < 1e-3,
            ),
          );
        });
      assert.deepEqual(
        leaks.map((request) => new URL(request.url).pathname),
        [],
        'no startup request carried the restored private coordinates',
      );
    },
  );

  await step('Reset returns the start view to the default', async () => {
    await openStartRow();
    await page.click('#start-view-clear');
    assert.equal(
      await page.$eval('#start-view-status', (e) => e.textContent),
      `Start view: ${DEFAULT_START.label} (default)`,
    );
    await reloadFresh();
    const opened = await camera();
    assert.ok(
      // ~100 m and the default's height: tells it apart from a saved view
      // nearby (step 7 saves one in Oxford).
      nearCamera(opened, DEFAULT_START, 1e-3) &&
        Math.abs(opened.height - DEFAULT_START.height) < 5,
      `opened at ${JSON.stringify(opened)}`,
    );
    await page.screenshot({
      path: path.join(artifactDir, 'start-view-default.png'),
    });
    return { opened };
  });

  await step('a denied permission is explained and leaves it off', async () => {
    const session = await page.target().createCDPSession();
    await context.clearPermissionOverrides();
    await session.send('Browser.setPermission', {
      origin,
      permission: { name: 'geolocation' },
      setting: 'denied',
    });
    await page.click('#my-location-view');
    const state = await waitFor(
      (s) => s.state === 'off' && /location|GPS/i.test(s.toast),
      'denied explained',
    );
    return { toast: state.toast };
  });

  await step('the button fits a phone-width top bar', async () => {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    });
    // Switching to a touch viewport reloads the page in Chromium.
    await booted();
    await new Promise((resolve) => setTimeout(resolve, 800));
    const layout = await page.evaluate(() => {
      const buttons = [
        ...document.querySelectorAll('#top-center-actions button'),
      ].filter((b) => b.offsetParent !== null);
      const rects = buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          id: b.id,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        };
      });
      return { width: window.innerWidth, rects };
    });
    const mine = layout.rects.find((r) => r.id === 'my-location-view');
    assert.ok(mine, 'visible on a phone');
    for (const r of layout.rects) {
      assert.ok(
        r.left >= 0 && r.right <= layout.width,
        `${r.id} inside the screen`,
      );
      for (const other of layout.rects)
        if (other !== r)
          assert.ok(
            r.right <= other.left ||
              other.right <= r.left ||
              r.bottom <= other.top ||
              other.bottom <= r.top,
            `${r.id} does not overlap ${other.id}`,
          );
    }
    await page.screenshot({
      path: path.join(artifactDir, 'my-location-phone.png'),
    });
    return { buttons: layout.rects.map((r) => r.id) };
  });

  await step('no uncaught browser errors', async () => {
    assert.deepEqual(errors, []);
  });

  Object.assign(summary, {
    status: 'passed',
    date: new Date().toISOString(),
    browser: await browser.version(),
    results,
  });
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(`Passed ${results.length} my-location scenarios.`);
} catch (error) {
  await page
    .screenshot({ path: path.join(artifactDir, 'failure.png') })
    .catch(() => {});
  console.error(error?.stack || error);
  console.error('page errors:', errors.slice(-10));
  process.exitCode = 1;
} finally {
  await browser.close();
  await server.close();
  certificates.cleanup();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
