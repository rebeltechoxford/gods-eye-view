#!/usr/bin/env node
/** Real built-browser named account isolation on synthetic loopback HTTPS/mTLS. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import {
  startTakHttpsServer,
  SESSION_TTL_MS,
} from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';
import { createCotStreamFramer } from '../src/tak/protocol/stream.js';
import { buildMarker } from '../src/tak/protocol/builders.js';
import { parseCotEvent, serializeCotEvent } from '../src/tak/protocol/cot.js';
import { interceptFixtures } from './qa-fixtureInterception.mjs';
import {
  hookRenderErrors,
  readRenderErrors,
  redact,
} from './qa-browserEvidence.mjs';
const root = fileURLToPath(new URL('../', import.meta.url)),
  args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const distRoot = path.resolve(root, option('--dist', 'dist')),
  artifacts = path.resolve(
    root,
    option('--artifact-dir', 'qa-artifacts/tak-operators'),
  );
const timeout = Number(option('--timeout', '90000'));
assert(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 300000);
await fs.access(path.join(distRoot, 'index.html'));
const alphaTls = createTakTlsFixtures({
    clientName: 'Synthetic Alpha',
    authorityName: 'Synthetic Alpha',
  }),
  bravoTls = createTakTlsFixtures({
    clientName: 'Synthetic Bravo',
    authorityName: 'Synthetic Bravo',
  });
const directory = await fs.mkdtemp(
  path.join(tmpdir(), 'gev-operator-browser-'),
);
const tokens = {
  alpha: randomBytes(32).toString('base64url'),
  bravo: randomBytes(32).toString('base64url'),
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const spki = createHash('sha256')
  .update(
    new X509Certificate(alphaTls.read('server.pem')).publicKey.export({
      type: 'spki',
      format: 'der',
    }),
  )
  .digest('base64');
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const results = [],
  errors = [],
  pages = [],
  interceptions = [],
  unloads = [],
  touches = [];
const peerSockets = new Set(),
  accepted = new Map(),
  peerMessages = new Map();
let peer,
  instance,
  browser,
  nowMs = Date.now(),
  usersFile,
  origin,
  port,
  heldStatus,
  releaseStatus,
  holdPage,
  expirePage,
  logoutPosts = 0,
  offline = false;
const scrub = (value) =>
  Object.values(tokens).reduce(
    (text, token) => text.replaceAll(token, 'REDACTED'),
    redact(String(value)),
  );
async function until(predicate, label, limit = timeout) {
  const end = Date.now() + limit;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function step(name, action) {
  console.log(`running ${name}`);
  const start = Date.now(),
    evidence = await action();
  results.push({ name, passed: true, elapsedMs: Date.now() - start, evidence });
  console.log(`ok ${results.length} ${name}`);
}
async function tap(page, selector) {
  const node = await page.waitForSelector(selector, { visible: true });
  try {
    await node.evaluate(async (el) => {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const animations = [];
      for (let parent = el; parent; parent = parent.parentElement)
        animations.push(
          ...parent
            .getAnimations()
            .filter(
              (a) =>
                (a.pending || a.playState === 'running') &&
                Number.isFinite(a.effect?.getComputedTiming().endTime),
            ),
        );
      await Promise.all(animations.map((a) => a.finished.catch(() => {})));
    });
    const point = await node.evaluate((el) => {
      const r = el.getBoundingClientRect(),
        x = r.x + r.width / 2,
        y = r.y + r.height / 2,
        hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        height: r.height,
        visible:
          !el.disabled &&
          !!hit &&
          (hit === el || el.contains(hit)) &&
          x >= 0 &&
          y >= 0 &&
          x < innerWidth &&
          y < innerHeight,
      };
    });
    assert(point.visible, `Inaccessible target ${selector}`);
    assert(
      point.height >= 44 || selector.includes('summary'),
      `Short touch target ${selector}`,
    );
    touches.push({ selector, ...point });
    await page.touchscreen.tap(point.x, point.y);
  } finally {
    await node.dispose();
  }
}
async function fill(page, selector, value) {
  const node = await page.waitForSelector(selector, { visible: true });
  await node.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
  await node.dispose();
}
async function section(page, name) {
  const selector = `[data-tak-section="${name}"]`;
  if (!(await page.$eval(selector, (el) => el.open)))
    await tap(page, `${selector} summary`);
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
  if (
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
  if (await page.$eval('#tak-web-panel', (el) => el.hidden))
    await tap(page, '.tak-web-launcher');
  await page.waitForSelector('#tak-web-panel:not([hidden])');
}
async function login(page, id, { pending = false } = {}) {
  await page.goto(origin + '/login', {
    waitUntil: 'domcontentloaded',
    timeout,
  });
  await fill(page, 'input[name="principal"]', id);
  await fill(page, 'input[name="token"]', tokens[id]);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
    tap(page, 'form button[type="submit"]'),
  ]);
  if (!pending) await boot(page);
}
async function connect(page) {
  await section(page, 'network');
  await tap(page, '[data-tak-connect]');
  await page.waitForFunction(
    () => window.__godsEyeView.takClient.client.link().state === 'open',
    { timeout },
  );
  assert.equal(await page.$eval('[data-tak-logout]', (el) => el.hidden), false);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const tak = window.__godsEyeView?.takClient;
    if (!tak)
      return {
        tak: false,
        path: location.pathname,
        dbAccess: window.__qaDbAccess,
      };
    return {
      tak: true,
      context: tak.operatorContext(),
      uid: tak.client.identity().uid,
      callsign: tak.client.identity().callsign,
      contacts: tak.client.store
        .list()
        .map((c) => ({ uid: c.uid, callsign: c.callsign })),
      activeMap: window.__godsEyeView.mapStackController.getActiveId(),
      canShare: tak.client.canShare(),
      fix: !!tak.client.fix(),
      sa: tak.client.saEnabled(),
      privacy: tak.privacy(),
      dbAccess: window.__qaDbAccess,
    };
  });
}
async function prepare(context, label) {
  const page = await context.newPage();
  pages.push(page);
  page.setDefaultTimeout(timeout);
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  await hookRenderErrors(page);
  await page.exposeFunction('__qaOperatorUnload', (value) =>
    unloads.push({ label, ...value }),
  );
  await page.evaluateOnNewDocument(() => {
    window.__qaLogoutInvocations = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (url, options) => {
      if (
        new URL(typeof url === 'string' ? url : url.url, location.origin)
          .pathname === '/logout'
      ) {
        const tak = window.__godsEyeView?.takClient;
        window.__qaLogoutInvocations.push({
          contacts: tak?.client.store.count(),
          fix: tak?.client.fix(),
          sa: tak?.client.saEnabled(),
          authorized: tak?.privacy().authorized,
          vertices: document.querySelectorAll('[data-drawing-vertices] li')
            .length,
          draft: !!window.__godsEyeView?.viewer.dataSources
            .getByName('TAK contacts')[0]
            ?.entities.getById('tak-draft:editor'),
          privateInputs: [
            ...document.querySelectorAll(
              '.tak-web-root input:not([type="checkbox"]):not([type="color"]),.tak-web-root textarea',
            ),
          ].some((el) => el.value !== ''),
          colors: [
            ...document.querySelectorAll('.tak-web-root input[type="color"]'),
          ].map((el) => ({
            name: el.hasAttribute('data-drawing-color')
              ? 'stroke'
              : el.hasAttribute('data-drawing-fill')
                ? 'fill'
                : 'unknown',
            value: el.value,
          })),
        });
        if (window.__qaFailLogoutOnce) {
          window.__qaFailLogoutOnce = false;
          return Promise.reject(
            new TypeError('Synthetic offline sign-out failure'),
          );
        }
      }
      return nativeFetch(url, options);
    };
    window.__qaDbAccess = [];
    for (const method of ['open', 'databases']) {
      const original = indexedDB[method]?.bind(indexedDB);
      if (original)
        indexedDB[method] = (...args) => {
          window.__qaDbAccess.push(
            method === 'open' ? String(args[0]) : 'databases',
          );
          return original(...args);
        };
    }
    window.addEventListener('beforeunload', () => {
      const tak = window.__godsEyeView?.takClient;
      if (!tak) {
        void window
          .__qaOperatorUnload({ tak: false, dbAccess: window.__qaDbAccess })
          .catch(() => {});
        return;
      }
      void window
        .__qaOperatorUnload({
          tak: true,
          contacts: tak.client.store.count(),
          chats: tak.client.store.chats().length,
          fix: tak.client.fix(),
          sa: tak.client.saEnabled(),
          retired: tak.operatorContext().retired,
          permissions: tak.privacy().authorized,
          shares: [...document.querySelectorAll('[data-tak-disclosure]')].some(
            (el) => el.checked,
          ),
          vertices: document.querySelectorAll('[data-drawing-vertices] li')
            .length,
          draft: !!window.__godsEyeView.viewer.dataSources
            .getByName('TAK contacts')[0]
            ?.entities.getById('tak-draft:editor'),
          dbAccess: window.__qaDbAccess,
        })
        .catch(() => {});
    });
    window.addEventListener('unhandledrejection', (e) =>
      console.error('QA unhandled ' + String(e.reason?.message || e.reason)),
    );
  });
  page.on('pageerror', (error) => errors.push(scrub(error.stack || error)));
  page.on('console', (message) => {
    if (
      /An error occurred while rendering|initialization failed|listener error|QA unhandled/i.test(
        message.text(),
      )
    )
      errors.push(scrub(message.text()));
  });
  const interception = await interceptFixtures(page, {
    origin,
    includePaths: ['/logout'],
    handle: async (req) => {
      const url = new URL(req.url());
      assert(
        !Object.values(tokens).some((token) => url.href.includes(token)),
        'Token must never enter a URL',
      );
      if (url.origin === origin) {
        if (url.pathname === '/logout') logoutPosts++;
        if (url.pathname === '/api/tak/status' && page === expirePage) {
          expirePage = null;
          nowMs += SESSION_TTL_MS + 1;
        }
        if (url.pathname === '/api/tak/status' && page === holdPage) {
          holdPage = null;
          heldStatus = true;
          await new Promise((resolve) => {
            releaseStatus = resolve;
          });
        }
        if (
          url.pathname.startsWith('/api/') &&
          !url.pathname.startsWith('/api/tak/') &&
          !url.pathname.startsWith('/api/maps/')
        )
          return req.respond({
            status: 200,
            contentType: 'application/json',
            body: '{}',
          });
        return req.continue();
      }
      if (!url.protocol.startsWith('http')) return req.continue();
      if (url.hostname === 'terrain.reearth.land')
        return req.respond({
          status: 400,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: '{}',
        });
      if (
        /\/tile\/\d+\/\d+\/\d+$/.test(url.pathname) ||
        /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      )
        return req.respond({
          status: 200,
          contentType: 'image/jpeg',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: tile,
        });
      return req.respond({
        status: 404,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{}',
      });
    },
  });
  interceptions.push(interception);
  return page;
}
async function startApp(nextPort = 0) {
  instance = await startTakHttpsServer({
    env: {
      TAK_GATEWAY_USERS_FILE: usersFile,
      TAK_HTTPS_CERT: alphaTls.file('server.pem'),
      TAK_HTTPS_KEY: alphaTls.file('server.key'),
    },
    distRoot,
    providerPlugins: [],
    port: nextPort,
    now: () => nowMs,
    offlineMaps: {
      root: path.join(directory, 'maps'),
      fetchImpl: async (url) => {
        assert(
          String(url).startsWith('https://basemap.nationalmap.gov/'),
          'Only fixed synthetic USGS request',
        );
        return new Response(tile, {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      },
    },
  });
  origin = instance.origin;
  port = instance.server.address().port;
  offline = false;
}
async function go(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch (error) {
    if (!/ERR_ABORTED|ERR_CONNECTION_REFUSED/.test(error.message)) throw error;
  }
}
async function peerUpdate(id) {
  await until(() => accepted.has(id), `authorized ${id} mutual TLS`);
  const event = buildMarker(
    {
      uid: `GEV-${id === 'alpha' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'}`,
      callsign: `SYNTHETIC ${id}`,
    },
    {
      uid: `PEER-${id.toUpperCase()}`,
      callsign: `PRIVATE ${id.toUpperCase()} CONTACT`,
      lat: 34.3665,
      lon: -89.5192,
    },
    { nowMs },
  );
  accepted.get(id).write(serializeCotEvent(event) + '\n');
  return event;
}
async function saveAlphaMap(page) {
  await section(page, 'maps');
  await fill(page, '[data-offline-name]', 'PRIVATE ALPHA AREA');
  for (const [key, value] of Object.entries({
    west: '-1',
    east: '1',
    south: '-1',
    north: '1',
    min: '0',
    max: '0',
  }))
    await fill(page, `[data-offline-${key}]`, value);
  await tap(page, '[data-offline-form] button[type="submit"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-offline-status]')
        .textContent.includes('offline app ready'),
    { timeout: 300000 },
  );
  return page.evaluate(() => ({
    active: window.__godsEyeView.mapStackController.getActiveId(),
    approval: JSON.parse(localStorage.getItem('gev.tak.operator-offline.v1')),
    databases: window.__qaDbAccess.filter((s) => s !== 'databases'),
  }));
}
try {
  const fingerprints = new Map(
    [
      ['alpha', alphaTls],
      ['bravo', bravoTls],
    ].map(([id, fixture]) => [
      new X509Certificate(fixture.read('client.pem')).fingerprint256,
      id,
    ]),
  );
  peer = tls.createServer(
    {
      cert: alphaTls.read('server.pem'),
      key: alphaTls.read('server.key'),
      ca: [alphaTls.read('ca.pem'), bravoTls.read('ca.pem')],
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      assert(socket.authorized);
      const id = fingerprints.get(socket.getPeerCertificate().fingerprint256);
      assert(id);
      accepted.set(id, socket);
      const framer = createCotStreamFramer({
        onEvent: (xml) => {
          const records = peerMessages.get(id) || [];
          records.push(parseCotEvent(xml));
          peerMessages.set(id, records);
        },
      });
      socket.on('data', (bytes) => framer.push(bytes.toString()));
      socket.once('close', () => {
        if (accepted.get(id) === socket) accepted.delete(id);
      });
    },
  );
  peer.on('connection', (socket) => {
    peerSockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peerSockets.delete(socket));
  });
  peer.on('tlsClientError', (error) => errors.push(scrub(error.code || error)));
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  usersFile = path.join(directory, 'users.json');
  await fs.writeFile(
    usersFile,
    JSON.stringify({
      schemaVersion: 1,
      principals: [
        {
          id: 'alpha',
          role: 'operator',
          enabled: true,
          tokenSha256: digest(tokens.alpha),
          server: {
            host: '127.0.0.1',
            port: peer.address().port,
            ...alphaTls.clientConfig,
          },
        },
        {
          id: 'bravo',
          role: 'observer',
          enabled: true,
          tokenSha256: digest(tokens.bravo),
          server: {
            host: '127.0.0.1',
            port: peer.address().port,
            cert: bravoTls.file('client.pem'),
            key: bravoTls.file('client.key'),
            ca: alphaTls.file('ca.pem'),
          },
        },
      ],
    }),
  );
  await startApp();
  await fs.mkdir(artifacts, { recursive: true });
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-webgl',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  const context = await browser.createBrowserContext(),
    alpha = await prepare(context, 'alpha');
  let alphaState, alphaScope, alphaUid, mapId;
  await step(
    'named native login resolves exact operator context and authenticated mTLS contact stream',
    async () => {
      await login(alpha, 'alpha');
      await connect(alpha);
      await peerUpdate('alpha');
      await alpha.waitForFunction(
        () => !!window.__godsEyeView.takClient.client.store.get('PEER-ALPHA'),
        { timeout },
      );
      alphaState = await snapshot(alpha);
      alphaScope = alphaState.context.storageScope;
      alphaUid = alphaState.uid;
      assert.equal(alphaState.context.principal, 'alpha');
      assert.equal(alphaState.context.role, 'operator');
      assert(alphaState.canShare);
      assert(/^[a-f0-9]{64}$/.test(alphaScope));
      await alpha.evaluate(() =>
        window.__godsEyeView.takClient.client.setIdentity({
          callsign: 'PRIVATE ALPHA SELF',
        }),
      );
      const outbound = await alpha.evaluate(() =>
        window.__godsEyeView.takClient.client.addMarker({
          callsign: 'PRIVATE ALPHA WEB MARKER',
          lat: 34.37,
          lon: -89.52,
          broadcast: true,
        }),
      );
      assert.equal(outbound.sent, true);
      await until(
        () =>
          (peerMessages.get('alpha') || []).some(
            (event) => event.uid === outbound.uid,
          ),
        'actual alpha mTLS uplink receives web marker',
      );
      await alpha.screenshot({
        path: path.join(artifacts, '01-alpha-phone.png'),
      });
      return { principal: 'alpha', mutualTls: true, phoneWidth: 390 };
    },
  );
  await step(
    'explicit device map and offline app save retain only approved account scope',
    async () => {
      const saved = await saveAlphaMap(alpha);
      assert(saved.active?.startsWith('offline-'));
      mapId = saved.active;
      assert.equal(saved.approval.storageScope, alphaScope);
      assert.equal(saved.approval.principal, 'alpha');
      assert(
        saved.databases.every(
          (name) => name === `gev-offline-maps-v1-${alphaScope}`,
        ),
      );
      const storage = await alpha.evaluate(async () => ({
        keys: Object.keys(localStorage),
        text: JSON.stringify(localStorage),
        cacheKeys: (
          await Promise.all(
            (await caches.keys()).map(async (name) =>
              (await (await caches.open(name)).keys()).map(
                (req) => new URL(req.url).pathname,
              ),
            ),
          )
        ).flat(),
      }));
      assert(storage.keys.includes(`gev.tak.identity.v1.${alphaScope}`));
      assert(!storage.keys.includes('gev.tak.identity.v1'));
      assert(!storage.text.includes('PRIVATE ALPHA CONTACT'));
      assert(
        !Object.values(tokens).some((token) => storage.text.includes(token)),
      );
      assert(
        storage.cacheKeys.every(
          (key) => !key.startsWith('/api/') && !key.endsWith('.cot'),
        ),
      );
      return {
        approved: true,
        scopedDatabase: true,
        appCacheFiles: storage.cacheKeys.length,
      };
    },
  );
  await step(
    'real server outage restores only explicitly approved map scope without tactical history',
    async () => {
      await instance.close();
      offline = true;
      await go(alpha, origin + '/index.html');
      await boot(alpha);
      const value = await snapshot(alpha);
      assert.equal(value.context.online, false);
      assert.equal(value.context.storageScope, alphaScope);
      assert.equal(value.uid, alphaUid);
      assert.equal(value.activeMap, mapId);
      assert.equal(value.contacts.length, 0);
      assert.equal(value.callsign, 'PRIVATE ALPHA SELF');
      await alpha.screenshot({
        path: path.join(artifacts, '02-alpha-approved-offline.png'),
      });
      return { approvedOffline: true, tacticalContactsRestored: 0 };
    },
  );
  await step(
    'reachable server401 blocks cached-app account storage before viewer or TAK initialization',
    async () => {
      await startApp(port);
      await login(alpha, 'alpha');
      const baseline = unloads.length;
      expirePage = alpha;
      await go(alpha, origin + '/');
      await alpha.waitForFunction(() => location.pathname === '/login', {
        timeout,
      });
      await until(
        () => unloads.slice(baseline).some((item) => !item.tak),
        'pre-TAK rejected startup snapshot',
      );
      const startup = unloads
        .slice(baseline)
        .filter((item) => !item.tak)
        .at(-1);
      assert.deepEqual(startup.dbAccess, []);
      assert.equal(await alpha.evaluate(() => !!window.__godsEyeView), false);
      assert.equal(
        await alpha.evaluate(() =>
          localStorage.getItem('gev.tak.operator-offline.v1'),
        ),
        null,
      );
      return { http401: true, indexedDbAccesses: 0, takInitialized: false };
    },
  );
  let bravo, bravoScope;
  await step(
    'cookie changes before account announcement cannot authorize old-scope maps logout or WebSocket',
    async () => {
      await login(alpha, 'alpha');
      await connect(alpha);
      await peerUpdate('alpha');
      await alpha.waitForFunction(
        () => !!window.__godsEyeView.takClient.client.store.get('PEER-ALPHA'),
        { timeout },
      );
      await alpha.evaluate(() => {
        const t = window.__godsEyeView.takClient;
        t.client.setFix({ lat: 34.3, lon: -89.5, source: 'USER' });
        t.client.setSaEnabled(true);
        for (const input of document.querySelectorAll(
          '[data-tak-disclosure]',
        )) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
      bravo = await prepare(context, 'bravo');
      heldStatus = false;
      holdPage = bravo;
      await login(bravo, 'bravo', { pending: true });
      await until(
        () => heldStatus,
        'bravo initial status held after real native cookie login',
      );
      const checks = await alpha.evaluate(async (scope) => {
        const headers = { 'X-TAK-Storage-Scope': scope };
        const maps = await fetch('/api/maps/offline/packs', {
          headers,
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const logout = await fetch('/logout', {
          method: 'POST',
          headers: { ...headers, 'X-TAK-Session': '1' },
          credentials: 'same-origin',
          redirect: 'manual',
        });
        const ws = await new Promise((resolve) => {
          let opened = false,
            frames = 0;
          const socket = new WebSocket(
            location.origin.replace('https:', 'wss:') + '/api/tak/ws',
            ['tak.v1', `tak.scope.${scope}`],
          );
          socket.onopen = () => {
            opened = true;
            socket.close();
          };
          socket.onmessage = () => frames++;
          socket.onerror = () => {};
          socket.onclose = () => resolve({ opened, frames });
          setTimeout(() => {
            socket.close();
            resolve({ opened, frames, timeout: true });
          }, 10000);
        });
        return {
          maps: maps.status,
          mapCode: (await maps.json()).code,
          logout: logout.status,
          ws,
          active: JSON.parse(localStorage.getItem('gev.tak.operator-active.v1'))
            .identity,
        };
      }, alphaScope);
      assert.equal(checks.maps, 409);
      assert.equal(checks.mapCode, 'operator-context-changed');
      assert.equal(checks.logout, 409);
      assert.equal(checks.ws.opened, false);
      assert.equal(checks.ws.frames, 0);
      assert.equal(checks.ws.timeout, undefined);
      assert(checks.active.startsWith(alphaScope + ':'));
      return { mapDenied: 409, logoutDenied: 409, webSocketOpened: false };
    },
  );
  await step(
    'new account announcement retires old tactical tab without signing out the new cookie',
    async () => {
      const baseline = unloads.length,
        posts = logoutPosts;
      releaseStatus();
      releaseStatus = null;
      await boot(bravo);
      await until(
        () =>
          unloads
            .slice(baseline)
            .some((item) => item.label === 'alpha' && item.retired),
        'old alpha cleared-state unload',
      );
      const retired = unloads
        .slice(baseline)
        .find((item) => item.label === 'alpha' && item.retired);
      assert.equal(retired.contacts, 0);
      assert.equal(retired.chats, 0);
      assert.equal(retired.fix, null);
      assert.equal(retired.sa, false);
      assert.equal(retired.permissions, false);
      assert.equal(retired.shares, false);
      assert.equal(retired.vertices, 0);
      assert.equal(retired.draft, false);
      assert.equal(
        logoutPosts,
        posts,
        'Cross-tab retirement never posts logout',
      );
      await section(bravo, 'maps');
      await bravo.waitForFunction(
        () =>
          document
            .querySelector('[data-offline-status]')
            .textContent.includes('No saved maps'),
        { timeout },
      );
      assert.equal(
        await bravo.$eval('[data-offline-list]', (el) =>
          el.textContent.includes('PRIVATE ALPHA AREA'),
        ),
        false,
      );
      const value = await snapshot(bravo);
      bravoScope = value.context.storageScope;
      assert.equal(value.context.principal, 'bravo');
      assert.notEqual(value.uid, alphaUid);
      assert.notEqual(value.callsign, 'PRIVATE ALPHA SELF');
      assert.equal(
        value.contacts.some((c) => c.callsign.includes('ALPHA')),
        false,
      );
      assert.notEqual(value.activeMap, mapId);
      assert(
        value.dbAccess.every(
          (name) =>
            name === 'databases' ||
            name === `gev-offline-maps-v1-${bravoScope}`,
        ),
      );
      return {
        oldContacts: 0,
        newCookieStillAuthorized: true,
        distinctIdentity: true,
      };
    },
  );
  await step(
    'observer UI is receive-only; direct raw CoT bypass is rejected by authenticated gateway',
    async () => {
      await connect(bravo);
      await peerUpdate('bravo');
      await bravo.waitForFunction(
        () => !!window.__godsEyeView.takClient.client.store.get('PEER-BRAVO'),
        { timeout },
      );
      const controls = await bravo.evaluate(() => ({
        text: document.querySelector('[data-tak-gateway]').textContent,
        disabled: [
          '[data-tak-sa]',
          '[data-tak-marker-broadcast]',
          '[data-tak-emergency]',
          '[data-tak-chat-input]',
          '[data-tak-chat-form] button',
          '[data-drawing-broadcast]',
        ].map((selector) => document.querySelector(selector).disabled),
        identity: window.__godsEyeView.takClient.client.identity(),
      }));
      assert(controls.text.includes('RECEIVE ONLY'));
      assert(controls.disabled.every(Boolean));
      await section(bravo, 'marker');
      await fill(bravo, '[data-tak-callsign]', 'LOCAL BRAVO DRAFT');
      await fill(bravo, '[data-tak-lat]', '34');
      await fill(bravo, '[data-tak-lon]', '-89');
      await tap(bravo, '[data-tak-marker-form] button[type="submit"]');
      await bravo.waitForFunction(
        () =>
          window.__godsEyeView.takClient.client.store
            .list()
            .some((c) => c.callsign === 'LOCAL BRAVO DRAFT'),
        { timeout },
      );
      const denied = buildMarker(
        controls.identity,
        { callsign: 'FORBIDDEN OBSERVER PUBLISH', lat: 34, lon: -89 },
        { nowMs },
      );
      const rejection = await bravo.evaluate(
        ({ identity, scope, xml }) =>
          new Promise((resolve, reject) => {
            const socket = new WebSocket(
              location.origin.replace('https:', 'wss:') + '/api/tak/ws',
              ['tak.v1', `tak.scope.${scope}`],
            );
            const timer = setTimeout(() => {
              socket.close();
              reject(new Error('Observer rejection timed out'));
            }, 10000);
            socket.onopen = () =>
              socket.send(
                JSON.stringify({
                  op: 'identity',
                  uid: identity.uid,
                  callsign: identity.callsign,
                }),
              );
            socket.onmessage = ({ data }) => {
              if (!data.startsWith('{')) return;
              const frame = JSON.parse(data);
              if (frame.op === 'identity') socket.send(xml);
              if (frame.op === 'reject') {
                clearTimeout(timer);
                socket.close();
                resolve(frame.reason);
              }
            };
            socket.onerror = () => {};
          }),
        {
          identity: controls.identity,
          scope: bravoScope,
          xml: serializeCotEvent(denied),
        },
      );
      assert.match(rejection, /observer|receive.only/i);
      assert(
        !(peerMessages.get('bravo') || []).some(
          (event) => event.uid === denied.uid,
        ),
      );
      await bravo.screenshot({
        path: path.join(artifacts, '03-bravo-receive-only-phone.png'),
      });
      return {
        receiveOnlyUi: true,
        localMarker: true,
        gatewayRejectedBypass: true,
      };
    },
  );
  await step(
    'shared static shell cannot borrow another account offline approval and native sign-out follows303',
    async () => {
      assert.equal(
        await bravo.evaluate(() =>
          localStorage.getItem('gev.tak.operator-offline.v1'),
        ),
        null,
      );
      await instance.close();
      offline = true;
      await go(bravo, origin + '/index.html');
      await boot(bravo);
      const value = await snapshot(bravo);
      assert.equal(value.context.storageAllowed, false);
      assert.notEqual(value.activeMap, mapId);
      assert.equal(value.contacts.length, 0);
      assert.deepEqual(value.dbAccess, []);
      await startApp(port);
      await login(bravo, 'bravo');
      await connect(bravo);
      await peerUpdate('bravo');
      await bravo.waitForFunction(
        () => !!window.__godsEyeView.takClient.client.store.get('PEER-BRAVO'),
        { timeout },
      );
      await bravo.evaluate(() => {
        const tak = window.__godsEyeView.takClient;
        tak.client.addMarker({
          callsign: 'PRIVATE BRAVO BEFORE LOGOUT',
          lat: 34.3,
          lon: -89.5,
          broadcast: false,
        });
        tak.client.setFix({ lat: 34.3, lon: -89.5, source: 'USER' });
        for (const input of document.querySelectorAll(
          '[data-tak-disclosure]',
        )) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const $ = (selector) => document.querySelector(selector);
        $('[data-drawing-kind]').value = 'route';
        $('[data-drawing-new]').click();
        $('[data-drawing-name]').value = 'PRIVATE BRAVO ROUTE';
        $('[data-drawing-notes]').value = 'PRIVATE BRAVO NOTES';
        $('[data-drawing-color]').value = '#123456';
        $('[data-drawing-fill]').value = '#654321';
        $('[data-drawing-width]').value = '17';
        for (const coordinate of ['34.37, -89.52', '34.38, -89.51']) {
          $('[data-drawing-coordinate]').value = coordinate;
          $('[data-drawing-hae]').value = '25';
          $('[data-drawing-waypoint-name]').value = 'PRIVATE BRAVO WAYPOINT';
          $('[data-drawing-vertex-form]').requestSubmit();
        }
        $('[data-drawing-coordinate]').value = '34.39, -89.50';
        window.__qaFailLogoutOnce = true;
      });
      assert.equal(
        await bravo.evaluate(
          () => document.querySelectorAll('[data-drawing-vertices] li').length,
        ),
        2,
      );
      const beforeLogout = await snapshot(bravo);
      assert(beforeLogout.contacts.length >= 2);
      assert.equal(beforeLogout.fix, true);
      assert.equal(beforeLogout.privacy.authorized, true);
      await section(bravo, 'network');
      const posts = logoutPosts;
      await tap(bravo, '[data-tak-logout]');
      await bravo.waitForFunction(
        () =>
          document
            .querySelector('[data-tak-status]')
            .textContent.includes('Synthetic offline sign-out failure'),
        { timeout },
      );
      const invocation = await bravo.evaluate(() =>
        window.__qaLogoutInvocations.at(-1),
      );
      assert.deepEqual(invocation, {
        contacts: 0,
        fix: null,
        sa: false,
        authorized: false,
        vertices: 0,
        draft: false,
        privateInputs: false,
        colors: [
          { name: 'stroke', value: '#ffffff' },
          { name: 'fill', value: '#ffffff' },
        ],
      });
      assert.equal(
        logoutPosts,
        posts,
        'Synthetic failed transport sends no POST',
      );
      assert.match(
        await bravo.$eval('[data-tak-logout]', (el) => el.textContent),
        /Reopen/,
      );
      await Promise.all([
        bravo.waitForNavigation({ waitUntil: 'domcontentloaded', timeout }),
        tap(bravo, '[data-tak-logout]'),
      ]);
      await boot(bravo);
      assert.equal(
        logoutPosts,
        posts,
        'Reopen after failed logout never revokes a possibly changed cookie',
      );
      await connect(bravo);
      await section(bravo, 'network');
      await tap(bravo, '[data-tak-logout]');
      await bravo.waitForFunction(() => location.pathname === '/login', {
        timeout,
      });
      assert.equal(await bravo.evaluate(() => !!window.__godsEyeView), false);
      assert.equal(
        await bravo.evaluate(
          async () =>
            (await fetch('/api/tak/status', { cache: 'no-store' })).status,
        ),
        401,
      );
      return {
        unapprovedOfflineMap: false,
        logout303: true,
        revokedStatus: 401,
      };
    },
  );
  for (const page of pages) {
    errors.push(...(await readRenderErrors(page)).map(scrub));
  }
  for (const item of interceptions) errors.push(...item.errors.map(scrub));
  assert.deepEqual(
    errors,
    [],
    'No unexpected runtime/render/interception errors',
  );
} catch (error) {
  errors.push(scrub(error.stack || error));
  for (let i = 0; i < pages.length; i++)
    if (!pages[i].isClosed())
      await pages[i]
        .screenshot({ path: path.join(artifacts, `failure-${i}.png`) })
        .catch(() => {});
  console.error(scrub(error.stack || error));
  process.exitCode = 1;
} finally {
  releaseStatus?.();
  for (const item of interceptions) await item.dispose().catch(() => {});
  await browser?.close().catch(() => {});
  if (instance && !offline) await instance.close().catch(() => {});
  for (const socket of peerSockets) socket.destroy();
  if (peer) await new Promise((resolve) => peer.close(resolve));
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      {
        scenarios: results,
        errors,
        touches,
        scope:
          'Synthetic loopback HTTPS/mTLS browser acceptance; no native TAK or physical-phone interoperability claim',
      },
      null,
      2,
    ),
  );
  alphaTls.cleanup();
  bravoTls.cleanup();
  assert(
    path.dirname(path.resolve(directory)) === path.resolve(tmpdir()) &&
      path.basename(directory).startsWith('gev-operator-browser-'),
  );
  await fs.rm(directory, { recursive: true, force: true });
}
