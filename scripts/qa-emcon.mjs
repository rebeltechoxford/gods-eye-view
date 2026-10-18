#!/usr/bin/env node
/**
 * EMCON acceptance: observe app request pause and owned stream shutdown.
 *
 *   npm run build
 *   node scripts/qa-emcon.mjs [--pack-dir <road packs>] [--window 30000]
 *
 * The built private HTTPS app runs under a non-loopback name (gev.test), as
 * on a phone, and Chromium is forced through a recording proxy for every
 * connection, loopback included. Emissions are counted where they cannot
 * hide: every request and WebSocket upgrade that reaches the app server,
 * and every new proxy tunnel. Existing tunnels stay open: a live WebSocket
 * witness must be closed by the application itself, not by the test proxy.
 *
 * Scenario: sign in, save the offline app, import a synthetic contact,
 * enable network layers (and optionally install a road pack), engage EMCON
 * through the button, then exercise the app for a window: layer refresh and
 * enable attempts, camera moves, TAK connect, saved-map refresh, direct
 * fetch/WebSocket/beacon attempts and (with --pack-dir) an offline drive.
 * Then reload and boot under EMCON. Both windows must show zero emissions.
 * Finally leave EMCON and confirm the app reconnects.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
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
const HOST = 'gev.test';
const packDir = option('--pack-dir', null);
const windowMs = Number(option('--window', '30000'));
const timeout = Number(option('--timeout', '180000'));
const artifactDir = option('--artifact-dir', 'qa-artifacts/emcon');
const distRoot = path.resolve(option('--dist', 'dist'));
await fs.access(path.join(distRoot, 'gev-sw.js')).catch(() => {
  throw new Error('Run npm run build first');
});
await fs.mkdir(artifactDir, { recursive: true });

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// Keep live public feeds out of the synthetic server.
for (const name of ['AISSTREAM_API_KEY', 'LOCAL_RECEIVER_FEEDS'])
  delete process.env[name];

const certificates = createTakTlsFixtures({ serverHosts: [HOST] });
const spki = createHash('sha256')
  .update(
    new X509Certificate(certificates.read('server.pem')).publicKey.export({
      type: 'spki',
      format: 'der',
    }),
  )
  .digest('base64');
const token = randomBytes(32).toString('hex');
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-emcon-'));
const appPort = await freePort();
const origin = `https://${HOST}:${appPort}`;
const server = await startTakHttpsServer({
  env: {
    TAK_HTTPS_HOST: '127.0.0.1',
    TAK_GATEWAY_TOKEN: token,
    TAK_HTTPS_CERT: certificates.file('server.pem'),
    TAK_HTTPS_KEY: certificates.file('server.key'),
    TAK_BROWSER_ORIGIN: origin,
  },
  distRoot,
  port: appPort,
  offlineMaps: { root: path.join(fixtureRoot, 'maps') },
  roadPacks: { root: packDir ? path.resolve(packDir) : fixtureRoot },
});

// Everything the app server receives, with a monotonically increasing clock.
const serverLog = [];
let streamWitness = null;
const log = (kind, req) =>
  serverLog.push({
    at: Date.now(),
    kind,
    method: req.method,
    url: String(req.url).split('?')[0].slice(0, 160),
  });
server.server.prependListener('request', (req) => log('request', req));
server.server.prependListener('upgrade', (req, socket) => {
  log('upgrade', req);
  if (!new URL(req.url, origin).searchParams.has('emconWitness')) return;
  const witness = { bytes: 0, closed: false };
  socket.on('data', (chunk) => {
    witness.bytes += chunk.length;
  });
  socket.once('close', () => {
    witness.closed = true;
  });
  streamWitness = witness;
});

// The recording proxy: tunnels only to the app, refuses and records the rest.
const proxyLog = [];
const tunnels = new Set();
const proxy = http.createServer((req, res) => {
  proxyLog.push({ at: Date.now(), kind: 'http', target: req.url });
  res.writeHead(403).end();
});
proxy.on('clientError', (error, socket) => socket.destroy());
proxy.on('connect', (req, client, head) => {
  client.on('error', () => client.destroy());
  proxyLog.push({ at: Date.now(), kind: 'connect', target: req.url });
  if (req.url !== `${HOST}:${appPort}`) {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(appPort, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const pair = { client, upstream };
  tunnels.add(pair);
  const drop = () => {
    tunnels.delete(pair);
    client.destroy();
    upstream.destroy();
  };
  client.on('error', drop).on('close', drop);
  upstream.on('error', drop).on('close', drop);
});
proxy.listen(0, '127.0.0.1');
await new Promise((resolve) => proxy.once('listening', resolve));
const cutTunnels = () => {
  for (const { client, upstream } of [...tunnels]) {
    client.destroy();
    upstream.destroy();
  }
};
// Chromium's own services (sign-in, GCM, autofill, component updates) are
// the browser's, not the app's. Listed by exact host and reported apart.
const BROWSER_SERVICE_HOSTS = new Set([
  'accounts.google.com',
  'android.clients.google.com',
  'clients2.google.com',
  'content-autofill.googleapis.com',
  'update.googleapis.com',
  'optimizationguide-pa.googleapis.com',
  'safebrowsing.googleapis.com',
]);
const proxyHost = (entry) => {
  try {
    return entry.kind === 'connect'
      ? entry.target.replace(/:\d+$/, '')
      : new URL(entry.target).hostname;
  } catch {
    return entry.target;
  }
};
// The browser re-checks the service-worker script after navigations. It
// carries no app data and the page cannot suppress it.
const isWorkerUpdateCheck = (entry) =>
  entry.kind === 'request' &&
  entry.method === 'GET' &&
  entry.url === '/gev-sw.js';
function emissionsSince(t) {
  const server = serverLog.filter((entry) => entry.at >= t);
  const proxied = proxyLog.filter((entry) => entry.at >= t);
  const workerChecks = server.filter(isWorkerUpdateCheck);
  const browserServices = proxied.filter((entry) =>
    BROWSER_SERVICE_HOSTS.has(proxyHost(entry)),
  );
  const appServer = server.filter((entry) => !isWorkerUpdateCheck(entry));
  const hostOf = (url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  };
  const appHosts = new Set(
    appRequests
      .filter((entry) => entry.at >= t)
      .map((entry) => hostOf(entry.url)),
  );
  const browserInitiated = proxied.filter(
    (entry) =>
      !BROWSER_SERVICE_HOSTS.has(proxyHost(entry)) &&
      proxyHost(entry) !== HOST &&
      !appHosts.has(proxyHost(entry)),
  );
  // A tunnel to the app host counts as the app's unless the server saw only
  // update checks in the same window.
  const appProxy = proxied.filter(
    (entry) =>
      !BROWSER_SERVICE_HOSTS.has(proxyHost(entry)) &&
      !browserInitiated.includes(entry) &&
      !(
        proxyHost(entry) === HOST &&
        appServer.length === 0 &&
        workerChecks.length > 0
      ),
  );
  return {
    server: appServer,
    proxy: appProxy,
    workerChecks,
    browserServices: [...browserServices, ...browserInitiated],
  };
}

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
  protocolTimeout: timeout,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    // Chromium's own background services are not the app; keep them quiet
    // so the proxy count is the app's alone.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--no-pings',
    '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,Translate,CertificateTransparencyComponentUpdater',
    `--proxy-server=http://127.0.0.1:${proxy.address().port}`,
    '--proxy-bypass-list=<-loopback>',
    `--ignore-certificate-errors-spki-list=${spki}`,
  ],
});
const page = await browser.newPage();
page.setDefaultTimeout(timeout);

// Second witness: every request the app's own contexts (page, its workers
// and the service worker) put on the wire, as the browser saw it. A proxy
// connection to a host none of them asked for was opened by the browser.
const appRequests = [];
const watched = new WeakSet();
async function watchSession(session, label) {
  if (!session || watched.has(session)) return;
  watched.add(session);
  session.on('Network.requestWillBeSent', ({ request }) =>
    appRequests.push({ at: Date.now(), label, url: request.url }),
  );
  await session.send('Network.enable').catch(() => {});
}
await watchSession(await page.target().createCDPSession(), 'page');
page.on(
  'workercreated',
  (worker) => void watchSession(worker.client, 'worker'),
);
const watchWorkerTarget = async (target) => {
  if (target.type() === 'service_worker')
    await watchSession(await target.createCDPSession(), 'service-worker');
};
browser.on('targetcreated', (target) => void watchWorkerTarget(target));
for (const target of browser.targets()) await watchWorkerTarget(target);
const pageErrors = [];
page.on('pageerror', (error) =>
  pageErrors.push(String(error?.message || error)),
);

const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  const evidence = await fn();
  results.push({
    name,
    ms: Date.now() - started,
    ...(evidence ? { evidence } : {}),
  });
  console.log(`ok ${results.length} ${name} (${Date.now() - started} ms)`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function booted() {
  await page.waitForFunction(() =>
    window.__godsEyeView?.dataManager?.layers?.get('directions'),
  );
  await page.waitForFunction(() =>
    document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  const welcome = await page
    .waitForSelector('#first-run-launcher.visible', { timeout: 5000 })
    .catch(() => null);
  if (welcome) {
    await page.click('.first-run-explore');
    await page.waitForFunction(
      () =>
        !document
          .getElementById('first-run-launcher')
          ?.classList.contains('visible'),
    );
  }
}
async function openTak() {
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector('.tak-web-launcher');
      if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
      return toggle?.getAttribute('aria-expanded') === 'true';
    },
    { polling: 1000 },
  );
}
async function closeTak() {
  await page.waitForFunction(
    () => {
      const toggle = document.querySelector('.tak-web-launcher');
      if (toggle?.getAttribute('aria-expanded') === 'true') toggle.click();
      return toggle?.getAttribute('aria-expanded') !== 'true';
    },
    { polling: 1000 },
  );
}
async function openSection(name) {
  await page.$eval(`[data-tak-section="${name}"]`, (element) => {
    element.open = true;
    element.dispatchEvent(new Event('toggle'));
    element.scrollIntoView();
  });
}
async function confirmDialog(accept) {
  await page.waitForSelector('[data-emcon="dialog"]', { visible: true });
  await page.click(`[data-emcon="${accept ? 'accept' : 'cancel'}"]`);
}
const SYNTHETIC_CONTACT = () => {
  const time = new Date().toISOString();
  const stale = new Date(Date.now() + 3600_000).toISOString();
  return `<event version="2.0" uid="SYNTHETIC-EMCON-CONTACT" type="a-f-G-U-C" how="h-e" time="${time}" start="${time}" stale="${stale}"><point lat="34.3664" lon="-89.5193" hae="150" ce="10" le="10"/><detail><contact callsign="SYNTHETIC EMCON"/></detail></event>`;
};

const summary = { origin, windowMs };
try {
  await step('native login on a non-loopback HTTPS origin', async () => {
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await page.type('input[name="token"]', token);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('form button'),
    ]);
    await booted();
  });
  await step('the app is saved for offline launch', async () => {
    await openTak();
    await openSection('maps');
    await page.click('[data-offline-shell]');
    await page.waitForFunction(
      () =>
        /Offline application saved/.test(
          document.querySelector('[data-offline-status]')?.textContent || '',
        ),
      { timeout },
    );
  });
  await step(
    'field data before EMCON: a contact and network layers',
    async () => {
      await openSection('import');
      await page.$eval(
        '[data-tak-xml]',
        (element, xml) => {
          element.value = xml;
        },
        SYNTHETIC_CONTACT(),
      );
      await page.click('[data-tak-import]');
      await page.waitForFunction(
        () => window.__godsEyeView.takClient.client.store.count() >= 1,
      );
      await page.evaluate(async () => {
        const manager = window.__godsEyeView.dataManager;
        for (const id of ['earthquakes', 'flights'])
          await manager.setEnabled(id, true).catch(() => {});
      });
      if (packDir) {
        await openSection('roads');
        await page.waitForSelector(
          '[data-roads-available] [data-roads-action="download"]',
        );
        await page.click(
          '[data-roads-available] [data-roads-action="download"]',
        );
        await page.waitForFunction(
          () =>
            /installed and verified/.test(
              document.querySelector('[data-roads-status]')?.textContent || '',
            ),
          { timeout },
        );
      }
      await sleep(3000);
      const online = serverLog.length;
      assert.ok(
        online > 20,
        `the app talks to its server normally (${online})`,
      );
      // An extra real stream is independent of the TAK client's disconnect
      // hook. It keeps sending status requests until the page guard closes it.
      await page.evaluate(() => {
        const socket = new WebSocket(
          `wss://${location.host}/api/tak/ws?emconWitness=1`,
          ['tak.v1'],
        );
        const witness = { socket, replies: 0, closed: false };
        window.__emconStreamWitness = witness;
        let interval;
        socket.addEventListener('message', ({ data }) => {
          const message = JSON.parse(data);
          if (message.op === 'hello')
            socket.send(
              JSON.stringify({
                op: 'identity',
                uid: 'GEV-00000000-0000-4000-8000-000000000001',
                callsign: 'SYNTHETIC EMCON STREAM',
              }),
            );
          if (message.op === 'identity')
            interval = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ op: 'status' }));
            }, 100);
          if (message.op === 'status') witness.replies++;
        });
        socket.addEventListener('close', () => {
          clearInterval(interval);
          witness.closed = true;
        });
      });
      await page.waitForFunction(
        () => window.__emconStreamWitness?.replies >= 3,
      );
      assert.ok(
        streamWitness?.bytes > 0,
        'server observed live WebSocket traffic',
      );
      assert.equal(streamWitness.closed, false);
      return {
        serverRequestsBeforeEmcon: online,
        liveStreamBytesBeforeEmcon: streamWitness.bytes,
      };
    },
  );

  let engagedAt;
  await step('EMCON engages from its button after confirmation', async () => {
    await closeTak();
    await page.waitForSelector('[data-emcon="toggle"]', { visible: true });
    await page.screenshot({ path: path.join(artifactDir, 'emcon-off.png') });
    await page.click('[data-emcon="toggle"]');
    await confirmDialog(true);
    engagedAt = Date.now();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-emcon="toggle"]')
          ?.getAttribute('aria-pressed') === 'true',
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem('gev.emcon.v1') !== null),
      true,
    );
    await page.waitForFunction(
      () => window.__emconStreamWitness?.closed === true,
    );
    const closeDeadline = Date.now() + 5000;
    while (!streamWitness.closed && Date.now() < closeDeadline)
      await sleep(20);
    assert.equal(
      streamWitness.closed,
      true,
      'the app closed its existing stream',
    );
    summary.existingStreamClosedByApp = true;
    await page.waitForFunction(() =>
      /saved app cache-only/.test(
        document.querySelector('[data-emcon="banner"]')?.textContent || '',
      ),
    );
    await page.screenshot({
      path: path.join(artifactDir, 'emcon-engaged.png'),
    });
  });

  // Requests already on the wire when EMCON engaged may still land; give
  // them two seconds, then the strict window starts.
  await sleep(2000);
  const settled = emissionsSince(engagedAt);
  summary.inFlightAtEngage = settled.server.length + settled.proxy.length;

  const strictStart = Date.now();
  await step(
    `no observed app requests for ${windowMs / 1000} s under EMCON`,
    async () => {
      const probes = await page.evaluate(async () => {
        const out = {};
        const manager = window.__godsEyeView.dataManager;
        out.flightsStillOn = manager.isEnabled('flights');
        await manager.setEnabled('cctv', true).catch(() => {});
        out.cctvRefused = !manager.isEnabled('cctv');
        out.refreshRan = await manager.refreshLayer('flights');
        out.fetch = await fetch('/api/tak/status').then(
          () => 'sent',
          (error) => error.name,
        );
        out.thirdParty = await fetch(
          'https://tile.openstreetmap.org/0/0/0.png',
        ).then(
          () => 'sent',
          (error) => error.name,
        );
        try {
          new WebSocket(`wss://${location.host}/api/tak/ws`);
          out.websocket = 'opened';
        } catch (error) {
          out.websocket = error.name;
        }
        out.beacon = navigator.sendBeacon('/api/realtime/debug-log', '{}');
        const image = new Image();
        out.image = await new Promise((resolve) => {
          image.onload = () => resolve('loaded');
          image.onerror = () => resolve('blocked');
          image.src = 'https://tile.openstreetmap.org/1/0/0.png';
        });
        out.contacts = window.__godsEyeView.takClient.client.store.count();
        const { viewer } = window.__godsEyeView;
        const Cartesian3 = viewer.camera.position.constructor;
        viewer.camera.setView({
          destination: Cartesian3.fromDegrees(-90.18, 32.3, 400000),
        });
        return out;
      });
      assert.equal(probes.flightsStillOn, true, 'enabled layers stay on');
      assert.equal(probes.cctvRefused, true, 'new network layers are refused');
      assert.equal(probes.refreshRan, false, 'refreshes are frozen');
      assert.equal(probes.fetch, 'EmconError');
      assert.equal(probes.thirdParty, 'EmconError');
      assert.equal(probes.websocket, 'EmconError');
      assert.equal(probes.beacon, false);
      assert.equal(probes.image, 'blocked');
      assert.ok(probes.contacts >= 1, 'received contacts stay on screen');
      // The TAK panel refuses to connect and the saved-map list stays local.
      await openSection('maps');
      if (packDir) {
        await page.evaluate(() =>
          window.__godsEyeView.dataManager.setEnabled('directions', true),
        );
        await page.evaluate(() => {
          const module =
            window.__godsEyeView.dataManager.layers.get('directions').module;
          module.placeEndpoint('a', { lat: 34.3664, lon: -89.5193 });
          module.placeEndpoint('b', { lat: 34.2576, lon: -88.7034 });
        });
        await page.waitForFunction(() => {
          const stats = window.__godsEyeView.dataManager.layers
            .get('directions')
            .module.getStats();
          return stats.count > 0 || (stats.error && !stats.loading);
        });
        probes.drive = await page.evaluate(
          () =>
            window.__godsEyeView.dataManager.layers
              .get('directions')
              .module.getStats().coverage,
        );
        assert.match(probes.drive, /offline/);
      }
      const remaining = windowMs - (Date.now() - strictStart);
      if (remaining > 0) await sleep(remaining);
      const leaks = emissionsSince(strictStart);
      await page.screenshot({
        path: path.join(artifactDir, 'emcon-window.png'),
      });
      assert.deepEqual(
        leaks.server,
        [],
        'nothing from the app reached its server',
      );
      assert.deepEqual(leaks.proxy, [], 'no app connection left the browser');
      return {
        ...probes,
        browserWorkerUpdateChecks: leaks.workerChecks.length,
        browserServiceConnections: leaks.browserServices.map(proxyHost),
      };
    },
  );

  await step('a reload boots from the saved app and stays silent', async () => {
    const reloadAt = Date.now();
    const response = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(response.fromServiceWorker(), true);
    await booted();
    await page.waitForSelector('[data-emcon="banner"]:not([hidden])');
    await sleep(15000);
    const leaks = emissionsSince(reloadAt);
    await page.screenshot({
      path: path.join(artifactDir, 'emcon-after-reload.png'),
    });
    assert.deepEqual(
      leaks.server,
      [],
      'nothing from the app reached its server',
    );
    assert.deepEqual(leaks.proxy, [], 'no app connection left the browser');
    assert.ok(
      leaks.workerChecks.length <= 2,
      'at most the browser update check',
    );
    return {
      browserWorkerUpdateChecks: leaks.workerChecks.length,
      browserServiceConnections: leaks.browserServices.map(proxyHost),
    };
  });

  await step(
    'leaving EMCON from the TAK panel reloads and reconnects',
    async () => {
      const leaveAt = Date.now();
      await openTak();
      await page.click('[data-emcon="toggle-panel"]');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        confirmDialog(true),
      ]);
      await booted();
      await sleep(3000);
      assert.equal(
        await page.$eval('[data-emcon="toggle"]', (b) =>
          b.getAttribute('aria-pressed'),
        ),
        'false',
      );
      const resumed = emissionsSince(leaveAt).server.length;
      assert.ok(resumed > 0, 'the app talks to its server again');
      return { serverRequestsAfterLeaving: resumed };
    },
  );

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
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
  console.log(`Passed ${results.length} EMCON scenarios.`);
} catch (error) {
  await page
    .screenshot({ path: path.join(artifactDir, 'failure.png') })
    .catch(() => {});
  console.error(error?.stack || error);
  console.error('server log tail:', JSON.stringify(serverLog.slice(-15)));
  console.error('proxy log tail:', JSON.stringify(proxyLog.slice(-15)));
  process.exitCode = 1;
} finally {
  await browser.close();
  proxy.close();
  cutTunnels();
  await server.close();
  certificates.cleanup();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
