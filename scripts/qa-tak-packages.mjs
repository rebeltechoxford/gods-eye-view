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
  monitors = [];
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
  interception = await interceptFixtures(page, {
    origin: address.origin,
    handle(request) {
      const url = new URL(request.url());
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
  await page.waitForFunction(() => !!window.__godsEyeView?.takClient?.packages);
  await page.evaluate(() => {
    document.querySelector('.first-run-explore')?.click();
    document.querySelector('.tak-web-launcher').click();
    document.querySelector('[data-tak-section="packages"]').open = true;
  });
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
  const click = async (name) => {
    const element = await page.$(query(name));
    await element.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await element.tap();
  };
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
      const button = await page.$('[data-tak-package-save]');
      await button.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await button.tap();
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
      for (let attempt = 0; attempt < 4; attempt++) await button.tap();
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
      await page.$eval('[data-tak-package-uid="PACKAGE-SYNTHETIC-1"]', (el) => {
        el.checked = true;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await (await page.$(query('attachments'))).uploadFile(attachmentPath);
      await click('export');
      await status('Allow this selected package');
      assert.equal(downloads.length, priorDownloads);
      await page.$eval(query('authorize'), (el) => {
        el.checked = true;
      });
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
      await page.$eval(query('authorize'), (el) => {
        el.checked = true;
      });
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
      { status: 'failed', syntheticOnly: true, results, error: error.message },
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
