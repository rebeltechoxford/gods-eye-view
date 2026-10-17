#!/usr/bin/env node
// Real local browser file controls + download acceptance. Synthetic data only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { inspectMissionPackage } from '../src/tak/packages.js';
import { readPackageZip, writePackageZip } from '../src/tak/packagesZip.js';
import { interceptFixtures } from './qa-fixtureInterception.mjs';
import { saveFailureArtifacts, watchPage } from './qa-browserEvidence.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const address = new URL(option('--url', 'http://127.0.0.1:4174'));
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname),
  'Synthetic gate requires an explicit loopback app',
);
const artifactDir = path.resolve(
  option('--artifact-dir', 'qa-artifacts/tak-packages'),
);
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), 'gev-tak-package-qa-'),
);
await fs.mkdir(artifactDir, { recursive: true });
const fixtures = new URL(
  '../src/tak/fixtures/mission-package-v2.zip',
  import.meta.url,
);
const original = new Uint8Array(await fs.readFile(fixtures));
const imagery = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const files = await readPackageZip(original);
const bad = writePackageZip(
  [...files].map(([name, data]) => ({
    name,
    data: name.endsWith('.cot')
      ? new TextEncoder().encode(
          new TextDecoder()
            .decode(data)
            .replace('lat="34.3665"', 'lat="invalid"'),
        )
      : data,
  })),
);
const invalidPath = path.join(temporary, 'invalid.zip'),
  attachmentPath = path.join(temporary, 'selected.txt');
await fs.writeFile(invalidPath, bad);
await fs.writeFile(attachmentPath, 'Synthetic selected attachment only.');
const downloads = [],
  errors = [],
  results = [],
  monitors = [],
  touchTrace = [];
let browser, interception;
const wait = async (read, description, maximum = 20000) => {
  const deadline = Date.now() + maximum;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
};
const step = async (name, run) => {
  await run();
  results.push({ name, passed: true });
  console.log(`ok ${results.length} ${name}`);
};
try {
  browser = await puppeteer.launch({
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    headless: true,
    protocolTimeout: 120000,
    defaultViewport: {
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
    },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: temporary,
    eventsEnabled: true,
  });
  cdp.on('Browser.downloadWillBegin', (event) =>
    downloads.push({
      guid: event.guid,
      name: event.suggestedFilename,
      state: 'started',
    }),
  );
  cdp.on('Browser.downloadProgress', (event) => {
    const item = downloads.find((download) => download.guid === event.guid);
    if (item) item.state = event.state;
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  monitors.push(watchPage(page, { name: 'mission-packages', errors }));
  let failStartup;
  const startupFailure = new Promise((_, reject) => {
    failStartup = reject;
  });
  void startupFailure.catch(() => {});
  const onStartupError = (error) =>
    failStartup(new Error(`Application startup failed: ${error.message}`));
  page.on('pageerror', onStartupError);
  // Use real touch input only after finite transitions and scrolling settle.
  // The click observer distinguishes a CDP dispatch from a delivered DOM click.
  async function touch(selector, { panelOpen } = {}) {
    const trace = { selector, startedAt: Date.now() };
    touchTrace.push(trace);
    if (touchTrace.length > 128) touchTrace.shift();
    const element = await page.waitForSelector(selector, { visible: true });
    let observer, listener, timer;
    try {
      await element.evaluate((el) =>
        el.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      await page.waitForFunction(
        (selector) => {
          const element = document.querySelector(selector);
          if (!element || element.disabled) return false;
          for (let node = element; node; node = node.parentElement)
            if (
              node
                .getAnimations()
                .some(
                  (animation) =>
                    (animation.pending || animation.playState === 'running') &&
                    Number.isFinite(
                      animation.effect?.getComputedTiming().endTime,
                    ),
                )
            )
              return false;
          const rect = element.getBoundingClientRect(),
            x = rect.x + rect.width / 2,
            y = rect.y + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return (
            x >= 0 &&
            x <= innerWidth &&
            y >= 0 &&
            y <= innerHeight &&
            !!hit &&
            (hit === element || element.contains(hit))
          );
        },
        { polling: 'raf', timeout: 10000 },
        selector,
      );
      const point = await element.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      trace.point = point;
      const marker = `QA package touch ${trace.startedAt} ${touchTrace.length} ${selector}`;
      let rejectClick;
      const clicked = new Promise((resolve, reject) => {
        rejectClick = reject;
        listener = (message) => {
          if (message.text() === marker) resolve();
        };
        page.on('console', listener);
      });
      void clicked.catch(() => {});
      observer = await element.evaluateHandle((el, marker) => {
        const clicked = () => console.debug(marker);
        el.addEventListener('click', clicked, { once: true });
        return { dispose: () => el.removeEventListener('click', clicked) };
      }, marker);
      timer = setTimeout(
        () =>
          rejectClick(
            new Error(
              `Physical package touch did not deliver a click: ${selector}`,
            ),
          ),
        10000,
      );
      await Promise.all([page.touchscreen.tap(point.x, point.y), clicked]);
      trace.acknowledgedAt = Date.now();
      if (panelOpen !== undefined)
        await page.waitForFunction(
          (open) =>
            document.querySelector('#tak-web-panel')?.hidden === !open &&
            document
              .querySelector('.tak-web-launcher')
              ?.getAttribute('aria-expanded') === String(open),
          { timeout: 10000 },
          panelOpen,
        );
    } catch (error) {
      trace.error = error.message;
      throw error;
    } finally {
      clearTimeout(timer);
      if (listener) page.off('console', listener);
      await observer?.evaluate((value) => value.dispose()).catch(() => {});
      await Promise.allSettled([element.dispose(), observer?.dispose()]);
    }
  }
  interception = await interceptFixtures(page, {
    origin: address.origin,
    handle(request) {
      const url = new URL(request.url());
      // An explicit non-404 error selects Cesium's real ellipsoid fallback.
      if (url.hostname === 'terrain.reearth.land')
        return request.respond({
          status: 400,
          contentType: 'text/plain',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: 'Synthetic terrain unavailable',
        });
      if (
        request.method() === 'GET' &&
        ((url.origin === 'https://tile.openstreetmap.org' &&
          /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) ||
          (url.origin === 'https://services.arcgisonline.com' &&
            /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(
              url.pathname,
            )))
      )
        return request.respond({
          status: 200,
          contentType: 'image/jpeg',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: imagery,
        });
      if (url.origin !== address.origin)
        return request.respond({
          status: 400,
          contentType: 'text/plain',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: 'Synthetic external service unavailable',
        });
      if (
        url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/api/tak/')
      )
        return request.respond({
          status: 200,
          contentType: 'application/json',
          body: '{}',
        });
      return request.continue();
    },
  });
  address.hash =
    'lat=34.3665&lon=-89.5192&alt=50000&heading=0&pitch=-70&map=osm&b=0';
  await page.goto(address.href, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  try {
    await Promise.race([
      (async () => {
        await page.waitForFunction(
          () => !!window.__godsEyeView?.takClient?.packages,
        );
        await page.waitForFunction(() => {
          const loading = document.getElementById('loading-screen');
          return (
            !loading ||
            loading.classList.contains('hidden') ||
            getComputedStyle(loading).display === 'none'
          );
        });
        // Share hashes suppress welcome. Wait for initialization/removal instead
        // of clicking a hidden HTML template before it has a registered handler.
        await page.waitForFunction(() => {
          const welcome = document.getElementById('first-run-launcher');
          return !welcome || welcome.dataset.initialized === 'true';
        });
        if (await page.$('#first-run-launcher.visible')) {
          await touch('#first-run-launcher.visible .first-run-explore');
          await page.waitForFunction(
            () => !document.querySelector('#first-run-launcher.visible'),
          );
        }
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await touch('.tak-web-launcher', { panelOpen: true });
        await page.waitForSelector('#tak-web-panel:not([hidden])');
        await touch('[data-tak-section="packages"] > summary');
        await page.waitForFunction(
          () => document.querySelector('[data-tak-section="packages"]').open,
        );
      })(),
      startupFailure,
    ]);
  } finally {
    page.off('pageerror', onStartupError);
  }
  const query = (name) => `[data-tak-package-${name}]`;
  const fill = (name, value) =>
    page.$eval(
      query(name),
      (el, text) => {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      value,
    );
  const click = (name) => touch(query(name));
  const status = (pattern) =>
    page.waitForFunction(
      (source) =>
        new RegExp(source, 'i').test(
          document.querySelector('[data-tak-package-status]').textContent,
        ),
      {},
      pattern,
    );
  const count = () =>
    page.evaluate(() => window.__godsEyeView.takClient.client.store.count());
  const state = () =>
    page.evaluate(() => ({
      privacy: window.__godsEyeView.takClient.privacy(),
      tx: window.__godsEyeView.takClient.client.counters().tx,
    }));
  const before = await state();
  await step(
    'phone controls are touch sized and export consent starts off',
    async () => {
      const controls = await page.$$eval(
        '.tak-package-panel button, .tak-package-panel summary',
        (elements) =>
          elements
            .filter((el) => !el.disabled)
            .map((el) => ({
              text: el.textContent,
              height: el.getBoundingClientRect().height,
            })),
      );
      assert(
        controls.every((control) => control.height >= 44),
        JSON.stringify(controls),
      );
      assert.equal(
        await page.$eval(query('authorize'), (el) => el.checked),
        false,
      );
    },
  );
  await step(
    'invalid final CoT leaves contacts untouched and cannot enable import',
    async () => {
      const prior = await count();
      await (await page.$(query('file'))).uploadFile(invalidPath);
      await click('inspect');
      await status('no valid point');
      assert.equal(await count(), prior);
      assert.equal(await page.$eval(query('apply'), (el) => el.disabled), true);
    },
  );
  await step(
    'deflated Python ZIP is inspected before one explicit local import',
    async () => {
      const prior = await count();
      await (await page.$(query('file'))).uploadFile(fileURLToPath(fixtures));
      await click('inspect');
      await status('fully validated');
      assert.equal(await count(), prior);
      assert.equal((await state()).privacy.private, true);
      await click('apply');
      await status('Imported 1 contact');
      assert.equal(await count(), prior + 1);
      assert.equal((await state()).tx, before.tx);
    },
  );
  await step(
    'one attachment downloads only after its own explicit save action',
    async () => {
      assert.equal(downloads.length, 0);
      await touch('[data-tak-package-save]');
      const download = await wait(
        () =>
          downloads.find(
            (item) => item.name === 'brief.txt' && item.state === 'completed',
          ),
        'chosen attachment download',
      );
      assert.match(
        await fs.readFile(path.join(temporary, download.name), 'utf8'),
        /Synthetic local-only/,
      );
      assert.equal((await state()).privacy.authorized, false);
      for (let attempt = 0; attempt < 4; attempt++)
        await touch('[data-tak-package-save]');
      await status('Download memory limit');
      await wait(
        () =>
          downloads.filter((item) => item.state === 'completed').length === 4,
        'four bounded attachment downloads',
      );
      assert.equal(downloads.length, 4, 'fifth retained URL is refused');
    },
  );
  await step(
    'contact chooser bounds visible rows and selected UIDs while keeping stable nodes',
    async () => {
      await page.evaluate(() => {
        const store = window.__godsEyeView.takClient.client.store;
        const source = store.get('PACKAGE-SYNTHETIC-1').event;
        store.applyAll(
          Array.from({ length: 200 }, (_, i) => ({
            ...source,
            uid: `BOUNDED-${String(i).padStart(3, '0')}`,
          })),
          'import',
        );
      });
      assert.equal(
        await page.$$eval(
          '[data-tak-package-uid]',
          (elements) => elements.length,
        ),
        150,
      );
      const bounded = await page.evaluate(() => {
        const before = document.querySelector('[data-tak-package-uid]');
        const uid = before.dataset.takPackageUid;
        const store = window.__godsEyeView.takClient.client.store;
        const original = store.get(uid).event;
        store.apply({ ...original, timeMs: original.timeMs + 1 }, 'import');
        const identity =
          before === document.querySelector('[data-tak-package-uid]');
        const inputs = [...document.querySelectorAll('[data-tak-package-uid]')];
        for (const input of inputs.slice(0, 128)) {
          input.checked = true;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return {
          identity,
          selected: inputs.filter((input) => input.checked).length,
        };
      });
      assert.equal(bounded.identity, true);
      assert.equal(bounded.selected, 127);
      await fill('filter', 'PACKAGE-SYNTHETIC-1');
      assert.equal(
        await page.$$eval(
          '[data-tak-package-uid]',
          (elements) => elements.length,
        ),
        1,
      );
      await click('clear');
      assert.match(
        await page.$eval(query('count'), (el) => el.textContent),
        /0 selected/,
      );
    },
  );
  await step(
    'export is limited to checked records/files and consumes only one-action permission',
    async () => {
      const priorDownloads = downloads.length;
      await page.evaluate(() => {
        const client = window.__godsEyeView.takClient.client;
        const original = client.store.get('PACKAGE-SYNTHETIC-1').event;
        client.store.apply(
          { ...original, uid: 'PACKAGE-UNSELECTED' },
          'import',
        );
      });
      await fill('name', 'Synthetic chosen package');
      await fill('filter', 'PACKAGE-SYNTHETIC-1');
      await touch('[data-tak-package-uid="PACKAGE-SYNTHETIC-1"]');
      await (await page.$(query('attachments'))).uploadFile(attachmentPath);
      await click('export');
      await status('Allow this selected package');
      assert.equal(downloads.length, priorDownloads);
      await click('authorize');
      await click('export');
      await status('offered for download');
      const download = await wait(
        () =>
          downloads.find(
            (item) => item.name.endsWith('.zip') && item.state === 'completed',
          ),
        'selected package download',
      );
      const info = await inspectMissionPackage(
        new Uint8Array(await fs.readFile(path.join(temporary, download.name))),
      );
      assert.deepEqual(
        info.contents
          .filter((item) => item.kind === 'cot')
          .map((item) => item.uid),
        ['PACKAGE-SYNTHETIC-1'],
      );
      assert.deepEqual(
        info.contents
          .filter((item) => item.kind === 'attachment')
          .map((item) => item.path.split('/').at(-1)),
        ['selected.txt'],
      );
      assert.equal(
        await page.$eval(query('authorize'), (el) => el.checked),
        false,
      );
      assert.equal((await state()).privacy.authorized, false);
      assert.equal((await state()).tx, before.tx);
    },
  );
  await step(
    'clearing during asynchronous file read cancels export and resets all consent',
    async () => {
      const prior = downloads.length;
      await page.evaluate(() => {
        const original = window.FileReader;
        window.__qaRestorePackageReader = () => {
          window.FileReader = original;
        };
        window.FileReader = class extends original {
          readAsArrayBuffer() {
            window.__qaPendingPackageReader = this;
          }
          abort() {
            window.__qaPackageReaderAborted = true;
            super.abort();
          }
        };
      });
      await click('authorize');
      await click('export');
      await page.waitForFunction(() => !!window.__qaPendingPackageReader);
      await click('clear');
      await page.evaluate(async () => {
        window.__qaPendingPackageReader.dispatchEvent(new Event('load'));
        window.__qaRestorePackageReader();
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      assert.equal(downloads.length, prior);
      assert.equal(
        await page.evaluate(() => window.__qaPackageReaderAborted),
        true,
      );
      assert.equal(
        await page.$eval(query('authorize'), (el) => el.checked),
        false,
      );
      assert.equal(
        await page.$eval(query('attachments'), (el) => el.files.length),
        0,
      );
      assert.equal(
        await page.$eval(query('preview'), (el) => el.children.length),
        0,
      );
      await page.screenshot({
        path: path.join(artifactDir, 'phone-package-cleared.png'),
      });
    },
  );
  await step(
    'session teardown removes package controls and no uncaught error occurred',
    async () => {
      await page.evaluate(() =>
        window.__godsEyeView.takClient.packages.destroy(),
      );
      assert.equal(await page.$('.tak-package-panel'), null);
      assert.deepEqual([...errors, ...interception.errors], []);
    },
  );
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(
      {
        status: 'passed',
        syntheticOnly: true,
        noRealTakAcceptance: true,
        node: process.version,
        browser: await browser.version(),
        touchTrace,
        results,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (browser)
    await saveFailureArtifacts({ dir: artifactDir, browser, monitors, error });
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(
      {
        status: 'failed',
        syntheticOnly: true,
        touchTrace,
        results,
        error: error.message,
      },
      null,
      2,
    ),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await interception?.dispose();
  await browser?.close();
  const actual = path.resolve(temporary),
    parent = path.resolve(os.tmpdir()) + path.sep;
  if (
    actual.startsWith(parent) &&
    path.basename(actual).startsWith('gev-tak-package-qa-')
  )
    await fs.rm(actual, { recursive: true });
}
