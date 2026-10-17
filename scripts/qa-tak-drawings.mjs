#!/usr/bin/env node
/** Real phone-sized GEV/Cesium editor; local fixture imagery, no native-peer claim. */
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
const args = process.argv.slice(2);
const option = (name, fallback) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const base = new URL(option('--url', 'http://127.0.0.1:4174'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
const dir = path.resolve(option('--artifact-dir', 'qa-artifacts/tak-drawings'));
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const results = [],
  errors = [],
  touches = [];
let browser, page, interception, monitor;
async function step(name, action) {
  console.log(`running ${name}`);
  const evidence = await action();
  results.push({ name, evidence, passed: true });
  console.log(`ok ${results.length} ${name}`);
}
async function tap(selector) {
  const element = await page.waitForSelector(selector, { visible: true });
  try {
    await element.evaluate(async (node) => {
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      const animations = [];
      for (let parent = node; parent; parent = parent.parentElement)
        animations.push(
          ...parent
            .getAnimations()
            .filter(
              (a) =>
                (a.pending || a.playState === 'running') &&
                Number.isFinite(a.effect?.getComputedTiming().endTime),
            ),
        );
      await Promise.all(
        animations.map((animation) => animation.finished.catch(() => {})),
      );
    });
    const bounds = await element.evaluate((node) => {
      const rect = node.getBoundingClientRect(),
        x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2,
        hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        width: rect.width,
        height: rect.height,
        ready: !node.disabled && !!hit && (hit === node || node.contains(hit)),
        inView: x >= 0 && y >= 0 && x < innerWidth && y < innerHeight,
      };
    });
    assert(
      bounds.ready && bounds.inView,
      `Inaccessible touch target ${selector}: ${JSON.stringify(bounds)}`,
    );
    assert(
      bounds.height >= 44 ||
        selector.includes('summary') ||
        selector.includes('broadcast'),
      `Touch target too short: ${selector}`,
    );
    touches.push({ selector, ...bounds });
    await page.touchscreen.tap(bounds.x, bounds.y);
  } finally {
    await element.dispose();
  }
}
async function fill(selector, text) {
  await tap(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.type(text);
  assert.equal(await page.$eval(selector, (node) => node.value), text);
}
async function wait(predicate, ...values) {
  const handle = await page.waitForFunction(
    predicate,
    { timeout: 90000 },
    ...values,
  );
  await handle.dispose();
}
async function add(coordinate, name) {
  await fill('[data-drawing-coordinate]', coordinate);
  if (name) await fill('[data-drawing-waypoint-name]', name);
  const before = await page.$$eval(
    '[data-drawing-vertices] li',
    (nodes) => nodes.length,
  );
  await tap('[data-drawing-add]');
  await wait(
    (count) =>
      document.querySelectorAll('[data-drawing-vertices] li').length === count,
    before + 1,
  );
}
async function state() {
  return page.evaluate(() => {
    const { viewer, takClient } = window.__godsEyeView;
    const source = viewer.dataSources.getByName('TAK contacts')[0];
    return {
      contacts: takClient.client.store.list().map((contact) => ({
        uid: contact.uid,
        callsign: contact.callsign,
        geometry: contact.geometryResult,
        time: contact.event.timeMs,
      })),
      entities: source.entities.values.map((entity) => ({
        id: entity.id,
        line: !!entity.polyline,
        polygon: !!entity.polygon,
        billboard: entity.billboard?.show?.getValue(),
      })),
      privacy: takClient.privacy(),
      submissions: takClient.client.submissions(),
      status: document.querySelector('[data-drawing-status]')?.textContent,
    };
  });
}
try {
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--enable-webgl',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  page = await browser.newPage();
  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  page.setDefaultTimeout(90000);
  monitor = watchPage(page, { name: 'tak-drawings', errors });
  await hookRenderErrors(page);
  interception = await interceptFixtures(page, {
    origin: base.origin,
    async handle(request) {
      const url = new URL(request.url());
      const reply = (status, contentType, body) =>
        request.respond({
          status,
          contentType,
          headers: { 'Access-Control-Allow-Origin': '*' },
          body,
        });
      if (url.origin === base.origin && url.pathname === '/api/tak/status')
        return reply(200, 'application/json', '{"enabled":false}');
      if (url.hostname === 'terrain.reearth.land')
        return reply(400, 'text/plain', 'Synthetic unavailable terrain');
      if (
        /\/tile\/\d+\/\d+\/\d+$/.test(url.pathname) ||
        /\/\d+\/\d+\/\d+\.png$/.test(url.pathname)
      )
        return reply(200, 'image/jpeg', tile);
      if (url.origin !== base.origin || url.pathname.startsWith('/api/'))
        return reply(200, 'application/json', '{}');
      return request.continue();
    },
  });
  const url = new URL(base);
  url.hash = 'lat=34&lon=179&alt=400000&map=osm&b=0';
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await wait(
    () =>
      !!window.__godsEyeView?.takClient?.drawings &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
  );
  if (
    await page.evaluate(() =>
      document
        .getElementById('first-run-launcher')
        ?.classList.contains('visible'),
    )
  ) {
    await tap('.first-run-explore');
    await wait(
      () =>
        !document
          .getElementById('first-run-launcher')
          ?.classList.contains('visible'),
    );
  }
  await tap('.tak-web-launcher');
  await wait(() => !document.getElementById('tak-web-panel').hidden);
  await tap('[data-tak-section="drawings"] summary');
  await wait(
    () => document.querySelector('[data-tak-section="drawings"]').open,
  );
  await step(
    'phone creates and previews a dateline route with three real vertices before local save',
    async () => {
      await page.select('[data-drawing-kind]', 'route');
      await tap('[data-drawing-new]');
      await fill('[data-drawing-name]', 'SYNTHETIC DATELINE ROUTE');
      await add('34, 179', 'START');
      await add('34.1, -179', 'BEND');
      await add('34.2, -178', 'FINISH');
      const preview = await state();
      assert.equal(preview.contacts.length, 0);
      assert.equal(preview.privacy.private, true);
      assert.equal(
        preview.entities.find((entry) => entry.id === 'tak-draft:editor')?.line,
        true,
      );
      await tap('[data-drawing-save]');
      await wait(
        () => window.__godsEyeView.takClient.client.store.count() === 1,
      );
      const saved = await state(),
        contact = saved.contacts[0];
      assert.equal(contact.geometry.geometry.kind, 'route');
      assert.equal(contact.geometry.geometry.vertices.length, 3);
      assert.equal(
        saved.entities.find((entry) => entry.id === `tak:${contact.uid}`)?.line,
        true,
      );
      assert.equal(
        saved.entities.find((entry) => entry.id === `tak:${contact.uid}`)
          ?.billboard,
        false,
      );
      assert.deepEqual(saved.submissions, []);
      return saved;
    },
  );
  await step(
    'phone reorders and edits a saved route without duplicating its UID or waypoint IDs',
    async () => {
      const original = (await state()).contacts[0],
        ids = original.geometry.geometry.vertices.map((point) => point.uid);
      await tap('[data-drawing-action="up"][data-index="2"]');
      await tap('[data-drawing-action="edit"][data-index="0"]');
      await fill('[data-drawing-coordinate]', '34.001, 179');
      await tap('[data-drawing-add]');
      await wait(
        () =>
          document.querySelector('[data-drawing-add]').textContent ===
          'Add vertex',
      );
      await tap('[data-drawing-save]');
      await wait(
        (prior) =>
          window.__godsEyeView.takClient.client.store.list()[0].event.timeMs >
          prior,
        original.time,
      );
      const updated = (await state()).contacts[0];
      assert.equal(updated.uid, original.uid);
      assert.deepEqual(
        updated.geometry.geometry.vertices.map((point) => point.uid),
        [ids[0], ids[2], ids[1]],
      );
      assert.equal(updated.geometry.geometry.vertices[0].lat, 34.001);
      return updated;
    },
  );
  await step(
    'editing a loaded route preserves waypoint notes and translucent stroke',
    async () => {
      await page.evaluate(() => {
        const client = window.__godsEyeView.takClient.client,
          contact = client.store.list()[0];
        const geometry = structuredClone(contact.geometryResult.geometry);
        geometry.style.strokeColor = 0x80ffffff | 0;
        geometry.vertices[0].remarks = 'SYNTHETIC waypoint notes';
        client.saveGeometry(
          { ...geometry, uid: contact.uid, callsign: contact.callsign },
          { expectedEvent: contact.event },
        );
      });
      await tap('[data-drawing-edit]');
      await tap('[data-drawing-action="edit"][data-index="0"]');
      await fill('[data-drawing-coordinate]', '34.002, 179');
      await tap('[data-drawing-add]');
      await wait(
        () =>
          document.querySelector('[data-drawing-add]').textContent ===
          'Add vertex',
      );
      await fill('[data-drawing-name]', 'RENAMED ROUTE');
      await tap('[data-drawing-save]');
      await wait(
        () =>
          window.__godsEyeView.takClient.client.store.list()[0].callsign ===
          'RENAMED ROUTE',
      );
      const geometry = (await state()).contacts[0].geometry.geometry;
      assert.equal(geometry.style.strokeColor >>> 24, 128);
      assert.equal(geometry.vertices[0].remarks, 'SYNTHETIC waypoint notes');
    },
  );
  await step(
    'invalid mixed heights remain an unsaved draft and remove the previous preview',
    async () => {
      await tap('[data-drawing-action="edit"][data-index="0"]');
      await fill('[data-drawing-hae]', '500');
      await tap('[data-drawing-add]');
      await wait(
        () =>
          document.querySelector('[data-drawing-add]').textContent ===
          'Add vertex',
      );
      assert.equal(
        await page.$eval('[data-drawing-save]', (node) => node.disabled),
        true,
      );
      assert.equal(
        (await state()).entities.some(
          (entry) => entry.id === 'tak-draft:editor',
        ),
        false,
      );
      assert.equal(
        (await state()).contacts[0].geometry.geometry.vertices[0].hae,
        null,
      );
      await tap('[data-drawing-edit]');
      await wait(() => !document.querySelector('[data-drawing-save]').disabled);
    },
  );
  await step(
    'phone creates an actual polygon with closed outline and safe literal text',
    async () => {
      await page.select('[data-drawing-kind]', 'polygon');
      await tap('[data-drawing-new]');
      await fill('[data-drawing-name]', '<img src=x onerror=alert(1)>');
      await add('34, 179');
      await add('34.1, -179');
      await add('35, -179');
      await tap('[data-drawing-save]');
      await wait(
        () => window.__godsEyeView.takClient.client.store.count() === 2,
      );
      const current = await state(),
        area = current.contacts.find(
          (contact) => contact.geometry.geometry.kind === 'polygon',
        );
      assert.equal(
        current.entities.find((entry) => entry.id === `tak:${area.uid}`)
          ?.polygon,
        true,
      );
      assert.equal(
        await page.$$eval('.tak-drawings img', (nodes) => nodes.length),
        0,
      );
      await tap('[data-drawing-focus]');
      await fs.mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'phone-drawings.png') });
      return current;
    },
  );
  await step(
    'new peer update prevents stale editor save until an explicit copy',
    async () => {
      await page.evaluate(async () => {
        const { serializeCotEvent } = await import('/src/tak/protocol/cot.js');
        const client = window.__godsEyeView.takClient.client;
        const uid = document.querySelector('[data-drawing-saved]').value,
          contact = client.store.get(uid);
        const now = Date.now() + 1000;
        client.importXml(
          serializeCotEvent({
            ...contact.event,
            timeMs: now,
            startMs: now,
            staleMs: now + 86400000,
          }),
        );
      });
      await wait(() => document.querySelector('[data-drawing-save]').disabled);
      assert.match(
        await page.$eval(
          '[data-drawing-validation]',
          (node) => node.textContent,
        ),
        /Source changed/,
      );
      await tap('[data-drawing-copy-draft]');
      await wait(() => !document.querySelector('[data-drawing-save]').disabled);
      await tap('[data-drawing-save]');
      await wait(
        () => window.__godsEyeView.takClient.client.store.count() === 3,
      );
    },
  );
  await step(
    'clear and repeated teardown release draft geometry, DOM and private editor inputs',
    async () => {
      await tap('[data-drawing-clear]');
      await wait(
        () => document.querySelector('[data-drawing-editor]').disabled,
      );
      assert.equal(
        (await state()).entities.some(
          (entry) => entry.id === 'tak-draft:editor',
        ),
        false,
      );
      assert.equal((await state()).privacy.private, true);
      const cleanup = await page.evaluate(() => {
        const { takClient, viewer } = window.__godsEyeView;
        takClient.drawings.destroy();
        takClient.drawings.destroy();
        const sections = document.querySelectorAll(
          '[data-tak-section="drawings"]',
        ).length;
        takClient.destroy();
        takClient.destroy();
        return {
          sections,
          sources: viewer.dataSources.getByName('TAK contacts').length,
        };
      });
      assert.deepEqual(cleanup, { sections: 0, sources: 0 });
      return cleanup;
    },
  );
  errors.push(...(await readRenderErrors(page)), ...interception.errors);
  assert.deepEqual(errors, []);
  console.log(`Drawing browser acceptance: ${results.length} passed.`);
} catch (error) {
  process.exitCode = 1;
  errors.push(error.stack || String(error));
  console.error(error);
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
        mode: 'real GEV/Cesium/touch; synthetic imagery, no native TAK peer or physical phone',
        results,
        touches,
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
