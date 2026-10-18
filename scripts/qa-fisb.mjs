#!/usr/bin/env node
/**
 * FIS-B Weather acceptance in Chromium against the built private HTTPS app.
 *
 *   npm run build
 *   node scripts/qa-fisb.mjs
 *
 * A synthetic 978 MHz receiver (a local TCP server speaking dump978-fa's raw
 * format) rebroadcasts a small current FIS-B picture around Oxford, MS every
 * few seconds: three METARs and a TAF, a TFR (NOTAM text and polygon), an
 * AIRMET and NEXRAD blocks. The app server reads it through FISB_FEEDS. The
 * gate checks the route stays behind sign-in, then signs in, turns on the
 * layer, checks what it draws, clicks a station for its card, and turns the
 * layer off again.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { startTakHttpsServer } from '../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from '../src/tooling/takTlsFixtures.mjs';
import { syntheticFisbLines } from '../src/testSupport/fisbUplinks.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : argv[index + 1];
};
const timeout = Number(option('--timeout', '180000'));
const artifactDir = option('--artifact-dir', 'qa-artifacts/fisb');
const distRoot = path.resolve(option('--dist', 'dist'));
await fs.access(path.join(distRoot, 'index.html')).catch(() => {
  throw new Error('Run npm run build first');
});
await fs.mkdir(artifactDir, { recursive: true });

// The synthetic receiver: every client gets the picture now and every 5 s.
const receiverClients = new Set();
const receiver = net.createServer((socket) => {
  receiverClients.add(socket);
  socket.on('error', () => {});
  socket.on('close', () => receiverClients.delete(socket));
  socket.write(syntheticFisbLines(Date.now()).join('\n') + '\n');
});
await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
const rebroadcast = setInterval(() => {
  const text = syntheticFisbLines(Date.now()).join('\n') + '\n';
  for (const socket of receiverClients) socket.write(text);
}, 5000);

for (const name of ['AISSTREAM_API_KEY', 'LOCAL_RECEIVER_FEEDS'])
  delete process.env[name];
process.env.FISB_FEEDS = `dump978=tcp://127.0.0.1:${receiver.address().port}`;

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
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gev-fisb-'));
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
const page = await browser.newPage();
page.setDefaultTimeout(timeout);
const errors = [];
page.on('pageerror', (error) => errors.push(String(error?.message || error)));

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
  await page.waitForFunction(() =>
    window.__godsEyeView?.dataManager?.layers?.get('fisb'),
  );
  await page.waitForFunction(() =>
    document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  const welcome = await page
    .waitForSelector('#first-run-launcher.visible', { timeout: 5000 })
    .catch(() => null);
  if (welcome) await page.click('.first-run-explore');
}

const fisbStats = () =>
  page.evaluate(() => {
    const row = window.__godsEyeView.dataManager
      .getAll()
      .find((layer) => layer.id === 'fisb');
    return { enabled: row.enabled, ...row.stats };
  });

const drawn = () =>
  page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const source = viewer.dataSources.getByName('fisb')[0];
    const entities = source?.entities.values ?? [];
    return {
      show: source?.show ?? false,
      stations: entities
        .filter((e) => e.gevFisb?.kind === 'station')
        .map((e) => e.gevFisb.station.station)
        .sort(),
      polygons: entities
        .filter((e) => e.polygon)
        .map((e) => e.gevFisb.report.kind),
      imagery: viewer.imageryLayers.length,
    };
  });

const summary = { origin };
try {
  await step('the FIS-B route stays behind sign-in', async () => {
    const response = await page.goto(`${origin}/api/fisb`, {
      waitUntil: 'domcontentloaded',
    });
    const text = await response.text();
    assert.equal(response.status(), 401);
    assert.ok(
      !/"configured"\s*:\s*true/.test(text),
      'no FIS-B data before sign-in',
    );
    return { status: response.status() };
  });

  await step('sign in and boot the app', async () => {
    await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded' });
    await page.type('input[name="token"]', token);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('form button'),
    ]);
    // Look straight down on north Mississippi.
    await page.goto(
      `${origin}/?welcome=0#lat=34.2&lon=-89.3&alt=450000&heading=0&pitch=-90`,
      {
        waitUntil: 'domcontentloaded',
      },
    );
    await booted();
  });

  let imageryBefore = 0;
  await step(
    'turning the layer on draws stations, a TFR, an AIRMET and radar',
    async () => {
      imageryBefore = (await drawn()).imagery;
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('fisb', true),
      );
      await page.waitForFunction(
        () => {
          const row = window.__godsEyeView.dataManager
            .getAll()
            .find((l) => l.id === 'fisb');
          return /3 METARs/.test(row?.stats?.statusMessage || '');
        },
        { timeout: 90_000, polling: 1000 },
      );
      await page.waitForFunction(
        () => {
          const source =
            window.__godsEyeView.viewer.dataSources.getByName('fisb')[0];
          return (
            (source?.entities.values ?? []).filter((e) => e.polygon).length >= 2
          );
        },
        { timeout: 30_000 },
      );
      const now = await drawn();
      const stats = await fisbStats();
      assert.equal(now.show, true);
      assert.deepEqual(now.stations, ['KMEM', 'KTUP', 'KUOX']);
      assert.deepEqual(now.polygons.sort(), ['AIRMET', 'NOTAM']);
      assert.equal(now.imagery, imageryBefore + 1, 'NEXRAD image draped');
      assert.match(
        stats.statusMessage,
        /1 ground station · 3 METARs · 2 NOTAM\/AIRMET\/SIGMET · NEXRAD/,
      );
      await page.screenshot({ path: path.join(artifactDir, 'fisb-on.png') });
      return {
        stations: now.stations,
        polygons: now.polygons,
        status: stats.statusMessage,
      };
    },
  );

  await step(
    'clicking a station shows its METAR and flight category',
    async () => {
      await page.evaluate(() => {
        window.__fisbSelections = [];
        window.addEventListener('gev:entity-selected', (event) =>
          window.__fisbSelections.push({
            layerId: event.detail?.layerId,
            label: event.detail?.label,
            text: event.detail?.properties?.text,
          }),
        );
      });
      const point = await page.evaluate(() => {
        const { viewer } = window.__godsEyeView;
        const entity = viewer.dataSources
          .getByName('fisb')[0]
          .entities.values.find((e) => e.gevFisb?.station?.station === 'KTUP');
        viewer.scene.render();
        const position = entity.position.getValue(viewer.clock.currentTime);
        const screen = viewer.scene.cartesianToCanvasCoordinates(position);
        const rect = viewer.scene.canvas.getBoundingClientRect();
        return screen
          ? { x: rect.left + screen.x, y: rect.top + screen.y }
          : null;
      });
      assert.ok(point, 'KTUP is on screen');
      await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => window.__fisbSelections.length > 0, {
        timeout: 10_000,
      });
      const [selection] = await page.evaluate(() => window.__fisbSelections);
      assert.equal(selection.layerId, 'fisb');
      assert.equal(selection.label, 'KTUP · IFR');
      assert.match(selection.text, /METAR KTUP \d{6}Z 20008KT 3SM BR OVC008/);
      await new Promise((resolve) => setTimeout(resolve, 800));
      await page.screenshot({ path: path.join(artifactDir, 'fisb-card.png') });
      return selection;
    },
  );

  await step('turning the layer off removes everything it drew', async () => {
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('fisb', false),
    );
    await page.waitForFunction(() => {
      const source =
        window.__godsEyeView.viewer.dataSources.getByName('fisb')[0];
      return source && !source.show && source.entities.values.length === 0;
    });
    assert.equal((await drawn()).imagery, imageryBefore);
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
  console.log(`Passed ${results.length} FIS-B scenarios.`);
} catch (error) {
  await page
    .screenshot({ path: path.join(artifactDir, 'failure.png') })
    .catch(() => {});
  console.error(error?.stack || error);
  console.error('page errors:', errors.slice(-10));
  process.exitCode = 1;
} finally {
  clearInterval(rebroadcast);
  await browser.close();
  for (const socket of receiverClients) socket.destroy();
  receiver.close();
  await server.close();
  certificates.cleanup();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
}
