#!/usr/bin/env node
/** Synthetic phone UI / HTTPS / mTLS / IndexedDB acceptance for retained TAK pictures. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import puppeteer from 'puppeteer';
import { startTakHttpsServer } from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';
import { createCotStreamFramer } from '../src/tak/protocol/stream.js';
import { parseCotEvent } from '../src/tak/protocol/cot.js';
import { interceptFixtures } from './qa-fixtureInterception.mjs';
import {
  hookRenderErrors,
  readRenderErrors,
  redact,
} from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const distRoot = path.resolve(option('--dist', 'dist'));
const artifacts = path.resolve(
  option('--artifact-dir', 'qa-artifacts/tak-picture'),
);
const timeout = Number(option('--timeout', '180000'));
assert(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 300000);
await fs.access(path.join(distRoot, 'gev-sw.js'));
await fs.mkdir(artifacts, { recursive: true });
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), 'gev-picture-browser-'),
);
const credentials = [],
  sockets = new Set(),
  interceptions = [],
  results = [],
  errors = [];
const peerEvents = [],
  socketCommands = [],
  logoutSnapshots = [];
const tokens = {
  alpha: randomBytes(32).toString('hex'),
  bravo: randomBytes(32).toString('hex'),
};
const digest = (value) => createHash('sha256').update(value).digest('hex');
const scrub = (value) =>
  Object.values(tokens).reduce(
    (text, token) => text.replaceAll(token, 'REDACTED'),
    redact(value),
  );
let server,
  browser,
  peer,
  page,
  origin,
  offline = false,
  peerConnections = 0;
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);

async function step(name, action) {
  console.log(`running ${name}`);
  const started = Date.now();
  await action();
  results.push({ name, passed: true, elapsedMs: Date.now() - started });
  console.log(`ok ${results.length} ${name}`);
}
async function tap(selector) {
  const element = await page.waitForSelector(selector, { visible: true });
  let listener, timer;
  try {
    await element.evaluate(async (node) => {
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const point = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect(),
        x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        usable:
          !node.disabled &&
          !!hit &&
          (hit === node || node.contains(hit)) &&
          x >= 0 &&
          y >= 0 &&
          x < innerWidth &&
          y < innerHeight,
      };
    });
    assert(point.usable, `Inaccessible phone target ${selector}`);
    const marker = `QA picture touch ${randomBytes(8).toString('hex')}`;
    const delivered = new Promise((resolve, reject) => {
      listener = (message) => {
        if (message.text() === marker) resolve();
      };
      page.on('console', listener);
      timer = setTimeout(
        () => reject(new Error(`Phone click was not delivered: ${selector}`)),
        10000,
      );
    });
    void delivered.catch(() => {});
    await element.evaluate(
      (node, marker) =>
        node.addEventListener('click', () => console.debug(marker), {
          once: true,
        }),
      marker,
    );
    await Promise.all([page.touchscreen.tap(point.x, point.y), delivered]);
  } finally {
    clearTimeout(timer);
    if (listener) page.off('console', listener);
    await element.dispose();
  }
}
async function section(name) {
  const selector = `[data-tak-section="${name}"]`;
  if (!(await page.$eval(selector, (element) => element.open)))
    await tap(`${selector} summary`);
}
async function boot() {
  await page.waitForFunction(() => !!window.__godsEyeView?.takClient?.picture);
  await page.waitForFunction(() =>
    document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  if (await page.$('#first-run-launcher.visible'))
    await tap('.first-run-explore');
  if (await page.$eval('#tak-web-panel', (element) => element.hidden))
    await tap('.tak-web-launcher');
  await page.waitForSelector('#tak-web-panel:not([hidden])');
}
async function login(id) {
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
  await page.type('input[name="principal"]', id);
  await page.type('input[name="token"]', tokens[id]);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    tap('form button[type="submit"]'),
  ]);
  await boot();
  assert.equal((await state()).principal, id);
}
async function connect() {
  await section('network');
  await tap('[data-tak-connect]');
  await page.waitForFunction(
    () => window.__godsEyeView.takClient.client.link().state === 'open',
  );
  const deadline = Date.now() + timeout;
  while (!peerConnections && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert(
    peerConnections > 0,
    'the local mTLS peer accepted the real gateway connection',
  );
}
async function logout() {
  await section('network');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    tap('[data-tak-logout]'),
  ]);
  assert.equal(new URL(page.url()).pathname, '/login');
  const retired = logoutSnapshots.at(-1);
  assert(retired, 'logout request was observed');
  assert.equal(
    retired.count,
    0,
    'logout hides the historical picture before its request',
  );
  assert.equal(retired.live, 0);
}
async function state() {
  return page.evaluate(() => {
    const tak = window.__godsEyeView.takClient;
    const value = tak.picture.state();
    const source = window.__godsEyeView.viewer.dataSources.getByName(
      'TAK historical picture',
    )[0];
    return {
      principal: tak.operatorContext().principal,
      scope: tak.operatorContext().storageScope,
      count: value.picture?.contacts.length || 0,
      uids: value.picture?.contacts.map((contact) => contact.uid) || [],
      live: tak.client.store.count(),
      busy: value.busy,
      error: value.error,
      privacy: tak.privacy(),
      drawn: source?.show === false ? 0 : source?.entities.values.length || 0,
      status:
        document.querySelector('[data-picture-status]')?.textContent || '',
      roster: document.querySelector('[data-picture-list]')?.textContent || '',
    };
  });
}
async function idle() {
  await page.waitForFunction(
    () => !window.__godsEyeView.takClient.picture.state().busy,
  );
}
async function persisted() {
  return page.evaluate(async () => {
    const scope = window.__godsEyeView.takClient.operatorContext().storageScope;
    const name = `gev-tak-picture-v1-${scope}`;
    if (!(await indexedDB.databases()).some((db) => db.name === name))
      return null;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const value = await new Promise((resolve, reject) => {
        const request = db
          .transaction('pictures', 'readonly')
          .objectStore('pictures')
          .get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return value ? JSON.parse(value) : null;
    } finally {
      db.close();
    }
  });
}
async function importContact(id) {
  const now = Date.now();
  const xml = `<event version="2.0" uid="PICTURE-${id}" type="a-f-G-U-C" how="m-g" time="${new Date(now - 60000).toISOString()}" start="${new Date(now - 60000).toISOString()}" stale="${new Date(now - 1000).toISOString()}"><point lat="34.3665" lon="-89.5192" hae="100" ce="10" le="10"/><detail><contact callsign="PICTURE-${id}"/></detail></event>`;
  await section('import');
  await page.type('[data-tak-xml]', xml);
  await tap('[data-tak-import]');
  await page.waitForFunction(
    (uid) => !!window.__godsEyeView.takClient.client.store.get(uid),
    {},
    `PICTURE-${id}`,
  );
}
async function save() {
  await section('picture');
  await tap('[data-picture-consent]');
  await tap('[data-picture-save]');
  await idle();
  assert.equal((await state()).error, false);
  assert.equal(
    await page.$eval('[data-picture-consent]', (element) => element.checked),
    false,
    'consent is consumed by each save',
  );
  const record = await persisted();
  assert.equal(record.contacts.length, 1);
  return record;
}
async function restore(uid) {
  await section('picture');
  await tap('[data-picture-restore]');
  await page.waitForFunction(
    (uid) =>
      window.__godsEyeView.takClient.picture
        .state()
        .picture?.contacts.some((contact) => contact.uid === uid),
    {},
    uid,
  );
  await idle();
  const snapshot = await state();
  assert.deepEqual(snapshot.uids, [uid]);
  assert.equal(snapshot.live, 0, 'restoring never fills the live store');
  assert(snapshot.drawn > 0, 'historical geometry is actually in Cesium');
  assert.match(snapshot.roster, /HISTORY/);
  assert.match(snapshot.roster, /EXPIRED/);
  assert.deepEqual(snapshot.privacy, { private: true, authorized: false });
  assert.deepEqual(
    peerEvents,
    [],
    'no historical CoT reached the synthetic mTLS peer',
  );
  assert.equal(
    socketCommands.filter((op) => op === 'cot' || op === 'send').length,
    0,
  );
}
async function newPage() {
  const next = await browser.newPage();
  next.setDefaultTimeout(timeout);
  await next.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
  });
  await hookRenderErrors(next);
  await next.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  next.on('pageerror', (error) => errors.push(scrub(error.stack || error)));
  next.on('console', (message) => {
    if (
      /An error occurred while rendering|initialization failed|listener error/i.test(
        message.text(),
      )
    )
      errors.push(scrub(message.text()));
  });
  next.on('dialog', (dialog) => void dialog.accept());
  const network = await next.createCDPSession();
  await network.send('Network.enable');
  network.on('Network.webSocketFrameSent', ({ response }) => {
    try {
      socketCommands.push(JSON.parse(response.payloadData).op);
    } catch {}
  });
  const interception = await interceptFixtures(next, {
    origin,
    includePaths: ['/logout'],
    handle: async (request) => {
      const url = new URL(request.url());
      if (url.origin === origin) {
        if (url.pathname === '/logout') logoutSnapshots.push(await state());
        if (
          url.pathname.startsWith('/api/') &&
          !/^\/api\/(?:tak|maps)\//.test(url.pathname)
        )
          return request.respond({
            status: 200,
            contentType: 'application/json',
            body: '{}',
          });
        return request.continue();
      }
      if (!url.protocol.startsWith('http')) return request.continue();
      if (offline) return request.abort();
      const imagery = /\/tile\/\d+\/\d+\/\d+$|\/\d+\/\d+\/\d+\.png$/.test(
        url.pathname,
      );
      return request.respond({
        status: imagery ? 200 : 404,
        contentType: imagery ? 'image/jpeg' : 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: imagery ? tile : '{}',
      });
    },
  });
  interceptions.push(interception);
  return next;
}

try {
  for (const id of ['alpha', 'bravo'])
    credentials.push(
      createTakTlsFixtures({
        clientName: `Picture ${id}`,
        authorityName: `Picture ${id}`,
      }),
    );
  const [alpha] = credentials;
  peer = tls.createServer(
    {
      cert: alpha.read('server.pem'),
      key: alpha.read('server.key'),
      ca: credentials.map((item) => item.read('ca.pem')),
      requestCert: true,
      rejectUnauthorized: true,
    },
    (socket) => {
      assert(socket.authorized);
      peerConnections++;
      const framer = createCotStreamFramer({
        onEvent: (xml) => {
          const event = parseCotEvent(xml);
          if (event.type === 't-x-c-t') {
            // The connected gateway keeps its transport alive independently
            // of historical restoration. Validate and answer that heartbeat;
            // every non-heartbeat event remains a forbidden transmission.
            assert.match(event.uid, /^GEV-GATEWAY-[a-f0-9-]+-ping$/);
            assert.equal(event.point.lat, 0);
            assert.equal(event.point.lon, 0);
            assert.match(xml, /<detail\s*\/>/);
            socket.write(xml.replace('type="t-x-c-t"', 'type="t-x-c-t-r"'));
          } else peerEvents.push(xml);
        },
      });
      socket.on('data', (bytes) => framer.push(bytes.toString()));
    },
  );
  peer.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const usersFile = path.join(directory, 'users.json');
  await fs.writeFile(
    usersFile,
    JSON.stringify({
      schemaVersion: 1,
      principals: ['alpha', 'bravo'].map((id, index) => ({
        id,
        role: 'operator',
        enabled: true,
        tokenSha256: digest(tokens[id]),
        server: {
          host: '127.0.0.1',
          port: peer.address().port,
          cert: credentials[index].file('client.pem'),
          key: credentials[index].file('client.key'),
          ca: alpha.file('ca.pem'),
        },
      })),
    }),
  );
  server = await startTakHttpsServer({
    env: {
      TAK_HTTPS_HOST: '127.0.0.1',
      TAK_GATEWAY_USERS_FILE: usersFile,
      TAK_HTTPS_CERT: alpha.file('server.pem'),
      TAK_HTTPS_KEY: alpha.file('server.key'),
    },
    distRoot,
    port: 0,
    providerPlugins: [],
    offlineMaps: {
      root: path.join(directory, 'maps'),
      fetchImpl: async (url) => {
        assert(String(url).startsWith('https://basemap.nationalmap.gov/'));
        return new Response(tile, {
          headers: { 'Content-Type': 'image/jpeg' },
        });
      },
    },
  });
  origin = server.origin;
  const spki = createHash('sha256')
    .update(
      new X509Certificate(alpha.read('server.pem')).publicKey.export({
        type: 'spki',
        format: 'der',
      }),
    )
    .digest('base64');
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      `--ignore-certificate-errors-spki-list=${spki}`,
    ],
  });
  page = await newPage();
  let alphaScope, alphaRecord, bravoScope;
  await step(
    'phone save requires fresh consent and writes a real private IndexedDB record',
    async () => {
      await login('alpha');
      await connect();
      alphaScope = (await state()).scope;
      await importContact('ALPHA');
      await section('picture');
      await tap('[data-picture-save]');
      await idle();
      assert.equal((await state()).error, true);
      assert.equal(
        await persisted(),
        null,
        'refused consent writes no retained picture',
      );
      alphaRecord = await save();
      assert.match(alphaRecord.contacts[0].xml, /PICTURE-ALPHA/);
      assert(
        Date.parse(alphaRecord.contacts[0].xml.match(/stale="([^"]+)"/)[1]) <
          Date.now(),
      );
    },
  );
  await step(
    'reload needs explicit restore; historical expired contacts do not become live or rebroadcast',
    async () => {
      await page.goto(`${origin}/?welcome=0`, {
        waitUntil: 'domcontentloaded',
      });
      await boot();
      assert.equal((await state()).count, 0);
      assert.equal((await state()).live, 0);
      await connect();
      await restore('PICTURE-ALPHA');
      assert.deepEqual(
        await persisted(),
        alphaRecord,
        'restore preserves original timestamps and payload',
      );
      await page.screenshot({
        path: path.join(artifacts, 'historical-phone.png'),
      });
    },
  );
  await step(
    'hide and Clear remove historical display without erasing storage or privacy',
    async () => {
      await tap('[data-picture-hide]');
      assert.equal((await state()).count, 0);
      assert.equal((await state()).drawn, 0);
      await restore('PICTURE-ALPHA');
      await tap('[data-tak-clear]');
      assert.equal((await state()).count, 0);
      assert.equal((await state()).privacy.private, true);
      assert.deepEqual(await persisted(), alphaRecord);
    },
  );
  await step(
    'actual sign-out hides the picture; a second account cannot restore the first',
    async () => {
      await restore('PICTURE-ALPHA');
      await logout();
      await login('bravo');
      bravoScope = (await state()).scope;
      assert.notEqual(bravoScope, alphaScope);
      await section('picture');
      await tap('[data-picture-restore]');
      await idle();
      assert.equal((await state()).count, 0);
      assert.equal(await persisted(), null);
      await importContact('BRAVO');
      await save();
      await logout();
      await login('alpha');
      assert.equal((await state()).scope, alphaScope);
      await restore('PICTURE-ALPHA');
    },
  );
  await step(
    'Delete removes only the current account copy, including after reload',
    async () => {
      await tap('[data-picture-delete]');
      await idle();
      assert.equal(await persisted(), null);
      assert.equal((await state()).count, 0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await boot();
      await section('picture');
      await tap('[data-picture-restore]');
      await idle();
      assert.equal((await state()).count, 0);
      await logout();
      await login('bravo');
      assert.equal((await state()).scope, bravoScope);
      await restore('PICTURE-BRAVO');
    },
  );
  await step(
    'saved app and approved account restore history with the real private server stopped',
    async () => {
      await section('maps');
      await page.evaluate(() => {
        for (const [key, value] of Object.entries({
          name: 'Picture offline fixture',
          west: -90,
          east: -89,
          south: 34,
          north: 35,
          min: 0,
          max: 0,
        })) {
          const input = document.querySelector(`[data-offline-${key}]`);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await tap('[data-offline-form] button[type="submit"]');
      await page.waitForFunction(() =>
        /Server map, device map and offline app ready/.test(
          document.querySelector('[data-offline-status]')?.textContent || '',
        ),
      );
      await server.close();
      server = null;
      offline = true;
      errors.push(...(await readRenderErrors(page)));
      await interceptions.at(-1).dispose();
      await page.close();
      page = await newPage();
      const response = await page.goto(`${origin}/`, {
        waitUntil: 'domcontentloaded',
      });
      assert.equal(
        response.fromServiceWorker(),
        true,
        'fresh launch came from the saved shell',
      );
      await boot();
      assert.equal(
        await page.evaluate(() =>
          fetch('/api/tak/status', { cache: 'no-store' }).then(
            () => true,
            () => false,
          ),
        ),
        false,
      );
      assert.equal((await state()).live, 0);
      assert.equal((await state()).count, 0);
      await restore('PICTURE-BRAVO');
      await page.screenshot({
        path: path.join(artifacts, 'historical-server-stopped.png'),
      });
    },
  );
  errors.push(...(await readRenderErrors(page)));
  assert.deepEqual(errors, []);
  for (const interception of interceptions)
    assert.deepEqual(interception.errors, []);
  await fs.writeFile(
    path.join(artifacts, 'results.json'),
    JSON.stringify(
      {
        status: 'passed',
        date: new Date().toISOString(),
        browser: await browser.version(),
        results,
        peerEvents: peerEvents.length,
      },
      null,
      2,
    ),
  );
  console.log(`Passed ${results.length} retained TAK picture scenarios.`);
} catch (error) {
  await page
    ?.screenshot({ path: path.join(artifacts, 'failure.png') })
    .catch(() => {});
  console.error(scrub(error?.stack || error));
  process.exitCode = 1;
} finally {
  for (const interception of interceptions) await interception.dispose();
  await browser?.close();
  await server?.close();
  for (const socket of sockets) socket.destroy();
  if (peer?.listening) await new Promise((resolve) => peer.close(resolve));
  for (const fixture of credentials) fixture.cleanup();
  await fs.rm(directory, { recursive: true, force: true });
}
