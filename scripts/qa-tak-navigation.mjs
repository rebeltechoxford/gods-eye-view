#!/usr/bin/env node
/**
 * Real UI/touch/Cesium navigation acceptance against a local app.
 * node scripts/qa-tak-navigation.mjs --url http://127.0.0.1:4175
 * Synthetic public imagery, GPS and refused-logout fixtures only; real private
 * authentication/revocation remains the separate qa-tak-private gate.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { interceptFixtures } from './qa-fixtureInterception.mjs';
import {
  hookRenderErrors,
  readRenderErrors,
  watchPage,
} from './qa-browserEvidence.mjs';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert(
    args[index + 1] && !args[index + 1].startsWith('--'),
    `${name} needs a value`,
  );
  return args[index + 1];
}
const base = new URL(option('--url', 'http://127.0.0.1:4175'));
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
  'Navigation QA requires an explicitly local app',
);
const dir = path.resolve(
  option('--artifact-dir', 'qa-artifacts/tak-navigation'),
);
const timeout = Number(option('--timeout', '90000'));
assert(Number.isFinite(timeout) && timeout >= 1000);
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const errors = [],
  results = [],
  touches = [],
  sockets = [];
let logoutSnapshot = null;
let browser, page, interception, monitor;
async function step(name, action) {
  console.log(`running ${name}`);
  const start = Date.now();
  const evidence = await action();
  results.push({ name, passed: true, elapsedMs: Date.now() - start, evidence });
  console.log(`ok ${results.length} ${name}`);
}
async function state(predicate, ...values) {
  const handle = await page.waitForFunction(
    predicate,
    { timeout, polling: 50 },
    ...values,
  );
  await handle.dispose();
}
async function tap(selector, predicate, ...values) {
  const element = await page.waitForSelector(selector, { visible: true });
  try {
    await element.evaluate((node) =>
      node.scrollIntoView({ block: 'center', behavior: 'instant' }),
    );
    await element.evaluate(async (node) => {
      const deadline = performance.now() + 5000;
      for (;;) {
        node.getBoundingClientRect();
        const active = [];
        for (let parent = node; parent; parent = parent.parentElement)
          for (const animation of parent.getAnimations())
            if (
              (animation.pending || animation.playState === 'running') &&
              Number.isFinite(animation.effect?.getComputedTiming().endTime)
            )
              active.push(animation);
        if (!active.length) return;
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw new Error('Touch target animations did not settle');
        let timer;
        try {
          await Promise.race([
            Promise.all(
              active.map((animation) => animation.finished.catch(() => {})),
            ),
            new Promise((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error('Touch target animations did not settle')),
                remaining,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    });
    const point = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        width: rect.width,
        height: rect.height,
        visible:
          !!hit && (hit === node || node.contains(hit)) && !node.disabled,
        viewport: [innerWidth, innerHeight],
      };
    });
    assert(
      point.visible &&
        point.x >= 0 &&
        point.x <= point.viewport[0] &&
        point.y >= 0 &&
        point.y <= point.viewport[1],
      `Covered or offscreen touch target ${selector}: ${JSON.stringify(point)}`,
    );
    touches.push({ selector, ...point });
    await page.touchscreen.tap(point.x, point.y);
    // Each action supplies its observable DOM/product acknowledgement. This wait
    // starts after dispatch; no rejecting promise is left unobserved during CDP.
    if (predicate) await state(predicate, ...values);
  } finally {
    await element.dispose();
  }
}
async function fill(selector, value) {
  await tap(
    selector,
    (target) => document.activeElement?.matches(target),
    selector,
  );
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
  assert.equal(await page.$eval(selector, (node) => node.value), value);
}
async function open(name) {
  const selector = `[data-tak-section="${name}"]`;
  if (await page.$eval(selector, (node) => node.open)) return;
  await tap(
    `${selector} > summary`,
    (name) =>
      document.querySelector(`[data-tak-section="${name}"]`)?.open === true,
    name,
  );
}
async function validate(format, text) {
  await open('navigation');
  await page.select('[data-tak-nav-format]', format);
  await fill('[data-tak-nav-input]', text);
  await tap(
    '[data-tak-nav-validate]',
    () =>
      !document.querySelector('[data-tak-nav-readout]').hidden &&
      !document.querySelector('[data-tak-nav-focus]').disabled,
  );
}
async function snapshot() {
  return page.evaluate(() => {
    const api = window.__godsEyeView.takClient;
    return {
      input: document.querySelector('[data-tak-nav-input]')?.value,
      label: document.querySelector('[data-tak-nav-label]')?.value,
      readout: document.querySelector('[data-tak-nav-readout]')?.textContent,
      hidden: document.querySelector('[data-tak-nav-readout]')?.hidden,
      focusDisabled: document.querySelector('[data-tak-nav-focus]')?.disabled,
      markerDisabled: document.querySelector('[data-tak-nav-marker]')?.disabled,
      contacts: api.client.store.count(),
      fix: api.client.fix(),
      tx: api.client.counters().tx,
      privacy: api.privacy(),
    };
  });
}
async function capture(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await state(() => window.__godsEyeView.viewer.scene.globe.tilesLoaded);
  const geometry = await page.evaluate(
    () =>
      window.__godsEyeView.viewer.scene.globe._surface._tilesToRender.filter(
        (tile) =>
          tile.data?.mesh &&
          tile.data.imagery?.some((image) => image.readyImagery),
      ).length,
  );
  assert(geometry > 0, 'Screenshot requires actual textured Cesium geometry');
  await fs.mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
  return { texturedGeometry: geometry };
}

try {
  browser = await puppeteer.launch({
    headless: !args.includes('--headful'),
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    defaultViewport: { width: 390, height: 844, hasTouch: true },
    protocolTimeout: 120000,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  page = await browser.newPage();
  page.setDefaultTimeout(timeout);
  monitor = watchPage(page, { name: 'tak-navigation', errors });
  await hookRenderErrors(page);
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (new URL(url).pathname === '/api/tak/ws') sockets.push(url);
  });
  await page.evaluateOnNewDocument(() => {
    window.__qaUnhandled = [];
    window.addEventListener('unhandledrejection', (event) =>
      window.__qaUnhandled.push(String(event.reason)),
    );
    const intervals = new Map(),
      every = globalThis.setInterval.bind(globalThis),
      stop = globalThis.clearInterval.bind(globalThis);
    globalThis.setInterval = (action, ms, ...values) => {
      const id = every(action, ms, ...values);
      intervals.set(id, ms);
      return id;
    };
    globalThis.clearInterval = (id) => {
      intervals.delete(id);
      return stop(id);
    };
    window.__qaIntervals = () => [...intervals.values()];
    let watch = null;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition(callback) {
          watch = callback;
          return 17;
        },
        clearWatch() {
          watch = null;
        },
      },
    });
    window.__qaGps = {
      emit(ageMs = 0) {
        if (!watch) throw new Error('No active synthetic GPS watch');
        watch({
          timestamp: Date.now() - ageMs,
          coords: {
            latitude: 56,
            longitude: 12,
            accuracy: 5,
            altitude: null,
            altitudeAccuracy: null,
            speed: null,
            heading: null,
          },
        });
      },
    };
  });
  interception = await interceptFixtures(page, {
    origin: base.origin,
    includePaths: ['/logout'],
    async handle(request) {
      const url = new URL(request.url());
      const reply = (status, contentType, body) =>
        request.respond({
          status,
          contentType,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body,
        });
      if (url.origin === base.origin && url.pathname === '/logout') {
        assert.equal(request.method(), 'POST');
        logoutSnapshot = await snapshot();
        return reply(
          503,
          'application/json',
          '{"error":"Synthetic refused logout: cleanup test only"}',
        );
      }
      if (url.origin === base.origin && url.pathname === '/api/tak/status')
        return reply(
          200,
          'application/json',
          JSON.stringify({
            enabled: false,
            sessionAuthenticated: true,
            reason:
              'Synthetic sign-out UI cleanup fixture; no real authenticated peer',
          }),
        );
      if (url.hostname === 'terrain.reearth.land')
        return reply(400, 'text/plain', 'Synthetic terrain unavailable');
      if (
        url.hostname === 'tile.openstreetmap.org' &&
        /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      )
        return reply(200, 'image/jpeg', tile);
      if (url.pathname.endsWith('/World_Imagery/MapServer/tile/19/0/0'))
        return reply(404, 'text/plain', 'Synthetic missing-tile sentinel');
      if (
        url.hostname === 'services.arcgisonline.com' &&
        /\/World_Imagery\/MapServer\/tile\//.test(url.pathname)
      )
        return reply(200, 'image/jpeg', tile);
      if (
        url.hostname === 'services.arcgisonline.com' &&
        url.pathname.endsWith('/World_Imagery/MapServer')
      )
        return reply(
          200,
          'application/json',
          JSON.stringify({
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
        );
      if (url.origin === base.origin && url.pathname.startsWith('/api/'))
        return reply(200, 'application/json', '{}');
      if (url.origin !== base.origin)
        return reply(200, 'application/json', '{}');
      return request.continue();
    },
  });
  const url = new URL(base);
  url.hash = 'lat=56&lon=12&alt=50000&map=osm&b=0';
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout });
  await page.bringToFront();
  await state(
    () =>
      !!window.__godsEyeView?.takClient?.navigation &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  const welcome = await page.evaluate(() =>
    document
      .getElementById('first-run-launcher')
      ?.classList.contains('visible'),
  );
  if (welcome)
    await tap(
      '.first-run-explore',
      () =>
        !document
          .getElementById('first-run-launcher')
          ?.classList.contains('visible'),
    );
  await tap(
    '.tak-web-launcher',
    () =>
      !document.querySelector('#tak-web-panel').hidden &&
      document
        .querySelector('.tak-web-launcher')
        .getAttribute('aria-expanded') === 'true',
  );
  await open('navigation');

  await step(
    'all 31 GEV layers remain; navigation starts without GPS or network publication',
    async () => {
      const actual = await page.evaluate(() =>
        [...window.__godsEyeView.dataManager.layers.keys()].sort(),
      );
      assert.deepEqual(
        actual,
        [
          ...LAYER_STATE_REGISTRY.map((item) => item.id),
          'local-adsb',
          'fisb',
        ].sort(),
      );
      assert.equal((await snapshot()).fix, null);
      assert.equal((await snapshot()).tx, 0);
      assert.deepEqual(sockets, []);
    },
  );
  for (const [format, text] of [
    ['DD', '56, 12'],
    ['DMS', '56 0 0 N 12 0 0 E'],
    ['MGRS', '33VUC1292810141'],
    ['UTM', '32 N 687071.44 6210141.33'],
  ])
    await step(
      `${format} real input resolves to independent known WGS84 56N,12E`,
      async () => {
        await validate(format, text);
        const readout = await page.$$eval(
          '[data-tak-nav-readout] dd',
          (items) => items.map((node) => node.textContent),
        );
        const [lat, lon] = readout[0].split(',').map(Number);
        assert(
          Math.abs(lat - 56) < 0.00002 && Math.abs(lon - 12) < 0.00002,
          JSON.stringify(readout),
        );
        assert.equal(readout.length, 5);
        return { input: text, readout };
      },
    );
  for (const [hemisphere, expectedLatitude] of [
    ['N', 85],
    ['S', -85],
  ])
    await step(
      `UPS ${hemisphere} input resolves a polar waypoint without GPS or transmission`,
      async () => {
        const northing =
          hemisphere === 'N' ? '1444542.6086173223' : '2555457.3913826775';
        await validate('UPS', `${hemisphere} 2000000 ${northing}`);
        const readout = await page.$$eval(
          '[data-tak-nav-readout] dd',
          (items) => items.map((node) => node.textContent),
        );
        const [lat, lon] = readout[0].split(',').map(Number);
        assert(
          Math.abs(lat - expectedLatitude) < 1e-6 && Math.abs(lon) < 1e-6,
          JSON.stringify(readout),
        );
        assert.match(readout[2], /Unavailable/);
        assert.match(readout[3], /Unavailable/);
        assert.match(readout[4], new RegExp(`^${hemisphere} `));
        assert.equal((await snapshot()).fix, null);
        assert.equal((await snapshot()).tx, 0);
        return { readout };
      },
    );
  await step(
    'editing/invalid coordinate disables focus and marker without retaining the previous target',
    async () => {
      await page.select('[data-tak-nav-format]', 'DD');
      await fill('[data-tak-nav-input]', '91, 12');
      assert.equal((await snapshot()).focusDisabled, true);
      await tap('[data-tak-nav-validate]', () =>
        document
          .querySelector('[data-tak-nav-status]')
          .classList.contains('tak-web-error'),
      );
      const value = await snapshot();
      assert(value.focusDisabled && value.markerDisabled && value.hidden);
      assert.equal(value.fix, null);
    },
  );
  await step(
    'a real local marker action uses the validated point and emits zero network frames',
    async () => {
      await validate('DD', '56, 12');
      await fill('[data-tak-nav-label]', 'SYNTHETIC NAV WAYPOINT');
      const before = await snapshot();
      await tap('[data-tak-nav-marker]', () =>
        window.__godsEyeView.takClient.client.store
          .list()
          .some((contact) => contact.callsign === 'SYNTHETIC NAV WAYPOINT'),
      );
      const contact = await page.evaluate(() =>
        window.__godsEyeView.takClient.client.store
          .list()
          .find((item) => item.callsign === 'SYNTHETIC NAV WAYPOINT'),
      );
      assert.equal(contact.point.lat, 56);
      assert.equal(contact.point.lon, 12);
      assert.equal((await snapshot()).tx, before.tx);
      assert.equal((await snapshot()).fix, null);
      assert.deepEqual(sockets, []);
    },
  );
  await step(
    'entered location activates sticky privacy and blocks public sharing/AI/recording by default',
    async () => {
      const policy = await snapshot();
      assert.equal(policy.privacy.private, true);
      assert.equal(policy.privacy.authorized, false);
      assert.equal(
        await page.evaluate(() =>
          window.__godsEyeView.styleManager.shareLinkManager._buildHashParams(),
        ),
        null,
      );
      const permissions = await page.$$eval('[data-tak-disclosure]', (nodes) =>
        nodes.map((node) => node.checked),
      );
      assert(
        permissions.length > 0 && permissions.every((allowed) => !allowed),
      );
    },
  );
  await step(
    'physical waypoint focus releases public camera follow and completes at the requested coordinate',
    async () => {
      await page.evaluate(() => {
        const viewer = window.__godsEyeView.viewer;
        viewer.trackedEntity = viewer.entities.add({
          id: 'QA-NAV-PUBLIC-FOLLOW',
          position: viewer.camera.position.clone(),
        });
        const camera = viewer.camera,
          original = camera.flyTo;
        const probe = (window.__qaNavFocus = {
          calls: 0,
          complete: false,
          cancelled: false,
        });
        camera.flyTo = function (options) {
          probe.calls++;
          return original.call(this, {
            ...options,
            complete() {
              probe.complete = true;
              options.complete?.();
            },
            cancel() {
              probe.cancelled = true;
              options.cancel?.();
            },
          });
        };
        window.__qaRestoreNavFocus = () => {
          camera.flyTo = original;
          viewer.entities.removeById('QA-NAV-PUBLIC-FOLLOW');
        };
      });
      try {
        await tap(
          '[data-tak-nav-focus]',
          () =>
            window.__qaNavFocus.complete &&
            !window.__godsEyeView.viewer.trackedEntity,
        );
        const focused = await page.evaluate(() => ({
          ...window.__qaNavFocus,
          lat:
            (window.__godsEyeView.viewer.camera.positionCartographic.latitude *
              180) /
            Math.PI,
          lon:
            (window.__godsEyeView.viewer.camera.positionCartographic.longitude *
              180) /
            Math.PI,
          height:
            window.__godsEyeView.viewer.camera.positionCartographic.height,
        }));
        assert.equal(focused.calls, 1);
        assert.equal(focused.cancelled, false);
        assert(
          Math.abs(focused.lat - 56) < 0.00001 &&
            Math.abs(focused.lon - 12) < 0.00001,
          JSON.stringify(focused),
        );
        assert(focused.height >= 11999 && focused.height < 12500);
        return focused;
      } finally {
        await page.evaluate(() => window.__qaRestoreNavFocus());
      }
    },
  );
  await step(
    'operator and synthetic GPS origins are distinct; stale/stopped GPS cannot supply navigation',
    async () => {
      await open('position');
      await tap(
        '[data-tak-fix-center]',
        () => window.__godsEyeView.takClient.client.fix()?.source === 'USER',
      );
      await validate('DD', '56, 12.001');
      await page.select('[data-tak-nav-origin]', 'position');
      await state(() =>
        /OPERATOR-SET/.test(
          document.querySelector('[data-tak-nav-reference]').textContent,
        ),
      );
      const range = await page.$eval(
        '[data-tak-nav-range]',
        (node) => node.textContent,
      );
      assert.match(range, /TRUE/);
      assert(parseFloat(range) > 60 && parseFloat(range) < 65, range);
      await tap(
        '[data-tak-gps]',
        () =>
          document
            .querySelector('[data-tak-gps]')
            .getAttribute('aria-pressed') === 'true',
      );
      await page.evaluate(() => window.__qaGps.emit());
      await state(() =>
        /DEVICE GPS/.test(
          document.querySelector('[data-tak-nav-reference]').textContent,
        ),
      );
      await page.evaluate(() => window.__qaGps.emit(31000));
      await state(() =>
        /stale, stopped or backgrounded/.test(
          document.querySelector('[data-tak-nav-reference]').textContent,
        ),
      );
      await tap('[data-tak-nav-position]', () =>
        document
          .querySelector('[data-tak-nav-status]')
          .classList.contains('tak-web-error'),
      );
      assert.match(
        await page.$eval('[data-tak-nav-status]', (node) => node.textContent),
        /stale/,
      );
      await tap(
        '[data-tak-gps]',
        () =>
          document
            .querySelector('[data-tak-gps]')
            .getAttribute('aria-pressed') === 'false',
      );
    },
  );
  await step(
    'phone controls retain 44px physical targets and 16px input text over real globe geometry',
    async () => {
      await open('navigation');
      const metrics = await page.$$eval(
        '.tak-navigation button, .tak-navigation select, .tak-navigation input, .tak-navigation textarea',
        (nodes) =>
          nodes.map((node) => ({
            selector: [...node.attributes].find((attribute) =>
              attribute.name.startsWith('data-tak-nav-'),
            )?.name,
            height: node.getBoundingClientRect().height,
            width: node.getBoundingClientRect().width,
            font: parseFloat(getComputedStyle(node).fontSize),
            viewport: innerWidth,
          })),
      );
      for (const metric of metrics) {
        assert(metric.height >= 44, JSON.stringify(metric));
        assert(metric.font >= 16, JSON.stringify(metric));
        assert(metric.width <= metric.viewport, JSON.stringify(metric));
      }
      await fill('[data-tak-nav-input]', '56, 12.001');
      await tap(
        '[data-tak-nav-validate]',
        () => !document.querySelector('[data-tak-nav-focus]').disabled,
      );
      await tap('[data-tak-nav-range]');
      return { metrics, ...(await capture('phone-navigation')) };
    },
  );
  await step(
    'real Sign out handler clears private navigation before a labelled synthetic refused logout POST',
    async () => {
      await open('network');
      await tap('[data-tak-logout]', () =>
        /Server sign-out could not be confirmed/.test(
          document.querySelector('[data-tak-status]').textContent,
        ),
      );
      assert(
        logoutSnapshot,
        'POST observer must see the actual Sign out request',
      );
      assert.equal(logoutSnapshot.input, '');
      assert.equal(logoutSnapshot.label, '');
      assert.equal(logoutSnapshot.readout, '');
      assert(
        logoutSnapshot.focusDisabled &&
          logoutSnapshot.markerDisabled &&
          logoutSnapshot.hidden,
      );
      assert.equal(logoutSnapshot.contacts, 0);
      assert.equal(logoutSnapshot.fix, null);
      assert.equal(logoutSnapshot.privacy.authorized, false);
      return {
        fixture:
          'HTTP503 refused logout; tests local clear-before-POST only, not authentication/revocation',
        ...logoutSnapshot,
      };
    },
  );
  await step(
    'clear stays private; repeated destroy releases navigation DOM, interval and camera listener',
    async () => {
      await validate('DD', '56, 12');
      await tap(
        '[data-tak-nav-clear]',
        () =>
          document.querySelector('[data-tak-nav-readout]').hidden &&
          document.querySelector('[data-tak-nav-input]').value === '',
      );
      assert.equal((await snapshot()).privacy.private, true);
      const cleanup = await page.evaluate(() => {
        const { viewer, takClient } = window.__godsEyeView;
        const before = {
          intervals: window.__qaIntervals().filter((ms) => ms === 1000).length,
          listeners: viewer.camera.moveEnd.numberOfListeners,
        };
        takClient.navigation.destroy();
        takClient.navigation.destroy();
        const after = {
          intervals: window.__qaIntervals().filter((ms) => ms === 1000).length,
          listeners: viewer.camera.moveEnd.numberOfListeners,
          sections: document.querySelectorAll('[data-tak-section="navigation"]')
            .length,
        };
        takClient.destroy();
        takClient.destroy();
        return {
          before,
          after,
          roots: document.querySelectorAll('.tak-web-root').length,
        };
      });
      assert.equal(cleanup.after.intervals, cleanup.before.intervals - 1);
      assert.equal(cleanup.after.listeners, cleanup.before.listeners - 1);
      assert.equal(cleanup.after.sections, 0);
      assert.equal(cleanup.roots, 0);
      return cleanup;
    },
  );
  errors.push(
    ...(await readRenderErrors(page)),
    ...(await page.evaluate(() => window.__qaUnhandled)),
    ...interception.errors,
  );
  assert.deepEqual(errors, []);
  console.log(`Navigation browser acceptance: ${results.length} passed.`);
} catch (error) {
  process.exitCode = 1;
  errors.push(error.stack || String(error));
  console.error(error.stack || error);
  await fs.mkdir(dir, { recursive: true });
  await page
    ?.screenshot({ path: path.join(dir, 'failure.png') })
    .catch(() => {});
} finally {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'results.json'),
    JSON.stringify(
      {
        status: process.exitCode ? 'failed' : 'passed',
        date: new Date().toISOString(),
        node: process.version,
        mode: 'real GEV/Cesium/UI/touch; synthetic tiles/GPS/status/refused-logout; no live TAK peer or physical phone',
        results,
        touches,
        sockets,
        errors,
        console: monitor?.console,
        failedRequests: monitor?.failed,
      },
      null,
      2,
    ),
  );
  try {
    await interception?.dispose();
  } finally {
    await browser?.close();
  }
}
