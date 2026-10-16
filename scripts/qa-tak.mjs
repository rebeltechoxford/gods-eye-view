#!/usr/bin/env node
/**
 * Synthetic TAK browser acceptance against a running GEV server.
 *   node scripts/qa-tak.mjs --url http://localhost:4174
 *   TAK_QA_TOKEN=<synthetic token> node scripts/qa-tak.mjs --url ... --gateway
 * Options: --lab (also verifies synthetic lab replies), --fonts (allow only
 * Google CSS/font requests for visual evidence), --headful,
 * --artifact-dir <path>, --timeout <milliseconds>.
 * TAK fixtures and imagery are hermetic. This does not prove real TAK peer
 * interoperability. --gateway exercises only the configured local gateway.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import {
  hookRenderErrors,
  readRenderErrors,
  redact,
  saveFailureArtifacts,
  watchPage,
} from './qa-browserEvidence.mjs';

const argv = process.argv.slice(2);
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  assert(
    argv[index + 1] && !argv[index + 1].startsWith('--'),
    `${name} needs a value`,
  );
  return argv[index + 1];
}
const appUrl = new URL(option('--url', 'http://localhost:4173'));
assert(
  ['localhost', '127.0.0.1', '[::1]'].includes(appUrl.hostname),
  'QA runs only against an explicitly local app',
);
const lab = argv.includes('--lab');
const gateway = argv.includes('--gateway') || lab;
const fonts = argv.includes('--fonts');
const token = process.env.TAK_QA_TOKEN || '';
const artifactDir = option('--artifact-dir', 'qa-artifacts/tak');
const timeout = Number(option('--timeout', '90000'));
assert(
  Number.isFinite(timeout) && timeout >= 1000,
  '--timeout must be at least 1000 milliseconds',
);
const expectedLayers = [
  ...LAYER_STATE_REGISTRY.map((entry) => entry.id),
  'local-adsb',
].sort();
const tile = await fs.readFile(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);

function cot({
  uid,
  callsign = uid,
  lat = 34.3665,
  lon = -89.5192,
  staleMs = Date.now() + 300000,
  timeMs = Date.now(),
}) {
  const time = new Date(timeMs).toISOString();
  return `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="h-e" time="${time}" start="${time}" stale="${new Date(staleMs).toISOString()}"><point lat="${lat}" lon="${lon}" hae="9999999" ce="15" le="9999999"/><detail><contact callsign="${callsign}"/></detail></event>`;
}
function chat(index) {
  const time = new Date(Date.now() + index).toISOString();
  return `<event version="2.0" uid="GeoChat.QA-SENDER.All Chat Rooms.qa-${index}" type="b-t-f" how="h-g-i-g-o" time="${time}" start="${time}" stale="${new Date(Date.now() + 86400000).toISOString()}"><point lat="0" lon="0" hae="9999999" ce="9999999" le="9999999"/><detail><__chat messageId="qa-${index}" chatroom="All Chat Rooms" id="All Chat Rooms" senderCallsign="SYNTHETIC QA"><chatgrp uid0="QA-SENDER" uid1="All Chat Rooms" id="All Chat Rooms"/></__chat><link uid="QA-SENDER" type="a-f-G-U-C" relation="p-p"/><remarks time="${time}">QA message ${index}</remarks></detail></event>`;
}

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 120000,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(argv.includes('--headful')
      ? []
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const errors = [];
const monitors = [];
const results = [];
const visualStates = [];
let imageryRequests = 0;
let externalRequests = 0;
let localApiRequests = 0;
const step = async (name, run) => {
  const start = Date.now();
  await run();
  results.push({ name, passed: true, elapsedMs: Date.now() - start });
  console.log(`ok ${results.length} ${name}`);
};

async function newPage(name, embed = false) {
  const page = await browser.newPage();
  page.setDefaultTimeout(timeout);
  monitors.push(
    watchPage(page, {
      name,
      errors,
      isError: (text) => /listener error|initialization failed/i.test(text),
    }),
  );
  await hookRenderErrors(page);
  await page.evaluateOnNewDocument(() => {
    const active = new Map();
    const every = globalThis.setInterval.bind(globalThis);
    const stop = globalThis.clearInterval.bind(globalThis);
    globalThis.setInterval = (fn, ms, ...args) => {
      const id = every(fn, ms, ...args);
      active.set(id, ms);
      return id;
    };
    globalThis.clearInterval = (id) => {
      active.delete(id);
      return stop(id);
    };
    window.__qaIntervals = () => [...active.values()];
    window.__qaUnhandled = [];
    window.addEventListener('unhandledrejection', (event) =>
      window.__qaUnhandled.push(String(event.reason?.stack || event.reason)),
    );
  });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const address = new URL(request.url());
    const knownTile =
      request.method() === 'GET' &&
      ((address.origin === 'https://services.arcgisonline.com' &&
        /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(
          address.pathname,
        )) ||
        (address.origin === 'https://tile.openstreetmap.org' &&
          /^\/\d+\/\d+\/\d+\.png$/.test(address.pathname)));
    const respond = (value) => request.respond(value).catch(() => {});
    if (
      fonts &&
      ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(
        address.origin,
      )
    ) {
      void request.continue().catch(() => {});
      return;
    }
    if (knownTile) {
      imageryRequests++;
      return respond({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: tile,
      });
    }
    if (
      address.origin === 'https://services.arcgisonline.com' &&
      address.pathname.endsWith('/World_Imagery/MapServer')
    ) {
      return respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
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
      });
    }
    if (
      address.origin === appUrl.origin &&
      address.pathname.startsWith('/api/') &&
      !address.pathname.startsWith('/api/tak/')
    ) {
      localApiRequests++;
      const body =
        address.pathname === '/api/openai/hud-summary'
          ? { summary: 'Synthetic QA globe ready' }
          : {};
      return respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    }
    if (
      address.protocol.startsWith('http') &&
      address.origin !== appUrl.origin
    ) {
      externalRequests++;
      // No live providers, model services, fonts or third-party telemetry.
      return respond({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: '{}',
      });
    }
    void request.continue().catch(() => {});
  });
  page.on('dialog', (dialog) => void dialog.accept());
  const address = new URL(appUrl);
  if (embed) address.searchParams.set('embed', '1');
  address.hash =
    'lat=34.3665&lon=-89.5192&alt=50000&heading=0&pitch=-70&map=osm';
  await page.goto(address.href, { waitUntil: 'domcontentloaded', timeout });
  await page.waitForFunction(
    () =>
      !!window.__godsEyeView?.dataManager && !!window.__godsEyeView?.takClient,
    { timeout },
  );
  await page.evaluate(() =>
    document.querySelector('.first-run-explore')?.click(),
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.style.display === 'none' ||
      document.getElementById('loading-screen')?.classList.contains('hidden') ||
      getComputedStyle(document.getElementById('loading-screen')).display ===
        'none',
    { timeout },
  );
  if (!embed) {
    if (fonts)
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
    await page.click('.tak-web-launcher');
    await page.waitForSelector('#tak-web-panel:not([hidden])');
  }
  return page;
}
async function section(page, name) {
  await page.$eval(`[data-tak-section="${name}"]`, (el) => {
    el.open = true;
  });
}
async function fill(page, selector, value) {
  await page.$eval(
    selector,
    (el, text) => {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    String(value),
  );
}
async function press(page, selector) {
  const point = await page.$eval(selector, (el) => {
    el.scrollIntoView({ block: 'center' });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
}
async function importXml(page, xml) {
  await section(page, 'import');
  await fill(page, '[data-tak-xml]', xml);
  await press(page, '[data-tak-import]');
}
async function marker(page, callsign, share) {
  await section(page, 'marker');
  await fill(page, '[data-tak-callsign]', callsign);
  await fill(page, '[data-tak-lat]', 34.37);
  await fill(page, '[data-tak-lon]', -89.52);
  await page.$eval(
    '[data-tak-marker-broadcast]',
    (el, checked) => {
      el.checked = checked;
    },
    share,
  );
  await press(page, '[data-tak-marker-form] button[type="submit"]');
  await page.waitForFunction(
    (label) =>
      window.__godsEyeView.takClient.client.store
        .list()
        .some(
          (c) => c.callsign === label || c.callsign === `${label} (lab peer)`,
        ),
    {},
    callsign,
  );
}
async function captureEvidence(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.__godsEyeView.viewer.scene.requestRender();
  });
  await page.waitForFunction(
    () => window.__godsEyeView.viewer.scene.globe.tilesLoaded,
    { timeout: 20000 },
  );
  visualStates.push(
    await page.evaluate((label) => {
      const gev = window.__godsEyeView;
      const camera = gev.viewer.camera.positionCartographic;
      return {
        name: label,
        heightM: camera.height,
        lat: (camera.latitude * 180) / Math.PI,
        lon: (camera.longitude * 180) / Math.PI,
        imageryReady: gev.viewer.scene.globe.tilesLoaded,
        bloom: gev.viewer.scene.postProcessStages.bloom.enabled,
        takVisible: gev.takClient.overlay.isVisible(),
        contacts: gev.takClient.client.store.count(),
        iconsLoaded: [...document.fonts].some(
          (font) =>
            font.family.includes('Material Symbols Outlined') &&
            font.status === 'loaded',
        ),
      };
    }, name),
  );
  await page.screenshot({
    path: path.join(artifactDir, `${name}.png`),
    fullPage: true,
  });
}

try {
  await fs.mkdir(artifactDir, { recursive: true });
  const page = await newPage('desktop');
  await step(
    'keyless boot retains the complete existing GEV layer catalog',
    async () => {
      const state = await page.evaluate(() => ({
        layers: [...window.__godsEyeView.dataManager.layers.keys()].sort(),
        network: window.__godsEyeView.takClient.client.link().state,
        map: window.__godsEyeView.mapStackController.getActiveId(),
      }));
      assert.deepEqual(state.layers, expectedLayers);
      assert.equal(state.layers.length, 30);
      assert.equal(state.map, 'osm');
      assert(
        ['idle', 'closed'].includes(state.network),
        'page must not auto-connect',
      );
    },
  );
  await step(
    'real import controls accept synthetic CoT and reject invalid coordinates',
    async () => {
      await importXml(
        page,
        cot({ uid: 'QA-IMPORT', callsign: 'SYNTHETIC IMPORT' }),
      );
      await page.waitForFunction(
        () => !!window.__godsEyeView.takClient.client.store.get('QA-IMPORT'),
      );
      assert.match(
        await page.$eval('[data-tak-status]', (el) => el.textContent),
        /Imported 1 contact/,
      );
      await importXml(page, cot({ uid: 'QA-INVALID', lat: '' }));
      assert.equal(
        await page.evaluate(() =>
          window.__godsEyeView.takClient.client.store.get('QA-INVALID'),
        ),
        null,
      );
      assert(
        await page.$eval('[data-tak-status]', (el) =>
          el.classList.contains('tak-web-error'),
        ),
        'invalid-only import reports an error',
      );
    },
  );
  await step(
    'local and disconnected shared markers report local-only status',
    async () => {
      await marker(page, 'QA LOCAL MARKER', false);
      assert.match(
        await page.$eval('[data-tak-status]', (el) => el.textContent),
        /local|not shared/i,
      );
      await marker(page, 'QA DISCONNECTED SHARE', true);
      assert.match(
        await page.$eval('[data-tak-status]', (el) => el.textContent),
        /local|not shared|not connected/i,
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.client.counters().tx,
        ),
        0,
      );
    },
  );
  await step(
    'TAK roster focus releases an existing public viewer follow owner',
    async () => {
      await page.evaluate(() => {
        const gev = window.__godsEyeView;
        const source = [...Array(gev.viewer.dataSources.length).keys()]
          .map((i) => gev.viewer.dataSources.get(i))
          .find((s) => s.name === 'TAK contacts');
        const position = source.entities.values
          .find((e) => e.position)
          ?.position.getValue(gev.viewer.clock.currentTime);
        const target = gev.viewer.entities.add({
          id: 'qa-public-follow',
          position,
        });
        gev.viewer.trackedEntity = target;
      });
      await fill(page, '[data-tak-filter]', 'SYNTHETIC IMPORT');
      await page.waitForFunction(
        () => document.querySelectorAll('.tak-web-contact').length === 1,
      );
      const point = await page.$eval('.tak-web-contact', (el) => {
        window.__qaContactButton = el;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.evaluate(
        async (xml) => {
          window.__godsEyeView.takClient.client.importXml(xml);
          await new Promise(requestAnimationFrame);
        },
        cot({ uid: 'QA-IMPORT', callsign: 'SYNTHETIC IMPORT', lat: 34.36651 }),
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__qaContactButton ===
            document.querySelector(
              '[data-tak-uid="QA-IMPORT"] .tak-web-contact',
            ),
        ),
        true,
        'contact update keeps the pointer-down button attached',
      );
      await page.mouse.up();
      await page.waitForFunction(
        () => !window.__godsEyeView.viewer.trackedEntity,
      );
      await page.waitForFunction(
        () => !window.__godsEyeView.viewer.camera._currentFlight,
      );
      const height = await page.evaluate(
        () => window.__godsEyeView.viewer.camera.positionCartographic.height,
      );
      assert(
        height >= 500 && height < 10000,
        `TAK focus keeps a useful above-ground view (${height} m)`,
      );
      await fill(page, '[data-tak-filter]', '');
      await page.evaluate(() =>
        window.__godsEyeView.viewer.entities.removeById('qa-public-follow'),
      );
    },
  );
  await step(
    'freshness changes on the clock and long-stale contacts expire',
    async () => {
      await importXml(
        page,
        cot({
          uid: 'QA-STALE',
          callsign: 'QA CLOCK CHECK',
          staleMs: Date.now() + 4000,
        }),
      );
      await fill(page, '[data-tak-filter]', 'QA CLOCK CHECK');
      await page.waitForFunction(
        () =>
          !!document.querySelector(
            '[data-tak-uid="QA-STALE"] .tak-web-contact',
          ),
      );
      await page.evaluate(() => {
        window.__qaStaleButton = document.querySelector(
          '[data-tak-uid="QA-STALE"] .tak-web-contact',
        );
      });
      assert.equal(
        await page.evaluate(() =>
          window.__godsEyeView.takClient.client.store.isStale(
            window.__godsEyeView.takClient.client.store.get('QA-STALE'),
          ),
        ),
        false,
      );
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll('.tak-web-contact')].some(
            (el) =>
              el.textContent.includes('QA CLOCK CHECK') &&
              el
                .querySelector(':scope > span')
                ?.textContent.split(' · ')
                .includes('STALE'),
          ),
        { timeout: 22000 },
      );
      assert.equal(
        await page.evaluate(
          () =>
            window.__qaStaleButton ===
            document.querySelector(
              '[data-tak-uid="QA-STALE"] .tak-web-contact',
            ),
        ),
        true,
        'clock refresh preserves the contact button',
      );
      await importXml(
        page,
        cot({
          uid: 'QA-EXPIRED',
          staleMs: Date.now() - 660000,
          timeMs: Date.now() - 720000,
        }),
      );
      await page.evaluate(() =>
        window.__godsEyeView.takClient.client.store.sweep(),
      );
      assert.equal(
        await page.evaluate(() =>
          window.__godsEyeView.takClient.client.store.get('QA-EXPIRED'),
        ),
        null,
      );
      await fill(page, '[data-tak-filter]', '');
    },
  );
  await step(
    'rolling 500-message chat updates the visible tail at message 501',
    async () => {
      const xml = `<events>${Array.from({ length: 500 }, (_, index) => chat(index)).join('')}</events>`;
      await page.evaluate(
        (value) => window.__godsEyeView.takClient.client.importXml(value),
        xml,
      );
      await section(page, 'chat');
      await page.waitForFunction(() =>
        document
          .querySelector('[data-tak-chat]')
          ?.textContent.includes('QA message 499'),
      );
      await page.evaluate(
        (value) => window.__godsEyeView.takClient.client.importXml(value),
        chat(500),
      );
      await page.waitForFunction(() =>
        document
          .querySelector('[data-tak-chat]')
          ?.textContent.includes('QA message 500'),
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.client.store.chats().length,
        ),
        500,
      );
      assert.equal(
        await page.$$eval('[data-tak-chat] p', (els) => els.length),
        60,
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.client.store.chats()[0].text,
        ),
        'QA message 1',
      );
    },
  );
  await step(
    'private TAK data blocks disclosure by default and hide/clear retain protection',
    async () => {
      await captureEvidence(page, 'desktop-private-tak');
      assert.deepEqual(
        await page.evaluate(() => window.__godsEyeView.takClient.privacy()),
        { private: true, authorized: false },
      );
      const egress = await page.evaluate(async () => ({
        copied:
          await window.__godsEyeView.styleManager.shareLinkManager.copyLink(),
        hash: window.__godsEyeView.styleManager.shareLinkManager._buildHashParams(),
        captured: window.__godsEyeView.sceneDirector.captureShot(),
        exported: window.__godsEyeView.sceneDirector.exportProject(),
      }));
      assert.deepEqual(egress, {
        copied: false,
        hash: null,
        captured: false,
        exported: false,
      });
      await press(page, '[data-tak-disclosure]');
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.privacy().authorized,
        ),
        true,
      );
      await press(page, '[data-tak-disclosure]');
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.privacy().authorized,
        ),
        false,
      );
      await press(page, '[data-tak-visible]');
      assert.equal(
        await page.evaluate(() =>
          window.__godsEyeView.takClient.overlay.isVisible(),
        ),
        false,
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.privacy().authorized,
        ),
        false,
      );
      await press(page, '[data-tak-clear]');
      await page.waitForFunction(
        () => window.__godsEyeView.takClient.client.store.count() === 0,
      );
      assert.equal(
        await page.evaluate(
          () => window.__godsEyeView.takClient.client.store.chats().length,
        ),
        0,
      );
      assert.deepEqual(
        await page.evaluate(() => window.__godsEyeView.takClient.privacy()),
        { private: true, authorized: false },
      );
      assert.equal(
        await page.evaluate(() =>
          [...window.__godsEyeView.dataManager.layers.keys()].some((id) =>
            id.startsWith('tak'),
          ),
        ),
        false,
      );
    },
  );
  if (gateway) {
    await step(
      'explicit authenticated local gateway connect and shared marker submission',
      async () => {
        await section(page, 'network');
        await fill(page, '[data-tak-token]', token);
        await press(page, '[data-tak-connect]');
        await page.waitForFunction(
          () => window.__godsEyeView.takClient.client.link().state === 'open',
        );
        await marker(page, 'QA GATEWAY MARKER', true);
        assert(
          await page.evaluate(
            () => window.__godsEyeView.takClient.client.counters().tx > 0,
          ),
        );
        assert.match(
          await page.$eval('[data-tak-status]', (el) => el.textContent),
          /gateway|submitted|sent|queued|shared/i,
        );
        if (lab) {
          await page.waitForFunction(() =>
            window.__godsEyeView.takClient.client.store
              .list()
              .some((c) => c.callsign === 'QA GATEWAY MARKER (lab peer)'),
          );
          const reply = await page.evaluate(() => {
            const c = window.__godsEyeView.takClient.client.store
              .list()
              .find(
                (entry) => entry.callsign === 'QA GATEWAY MARKER (lab peer)',
              );
            return {
              uid: c.uid,
              origin: c.origin,
              remarks: c.event.detail.remarks?.text,
            };
          });
          assert.equal(reply.origin, 'network');
          assert.match(reply.remarks, /Synthetic local peer received/);
          await section(page, 'chat');
          await fill(page, '[data-tak-chat-input]', 'QA lab roundtrip');
          await press(page, '[data-tak-chat-form] button[type="submit"]');
          await page.waitForFunction(() =>
            window.__godsEyeView.takClient.client.store
              .chats()
              .some(
                (message) =>
                  message.text === 'SYNTHETIC peer received: QA lab roundtrip',
              ),
          );
          await press(page, '[data-tak-visible]');
          await captureEvidence(page, 'desktop-lab-return');
        }
        await section(page, 'network');
        await press(page, '[data-tak-disconnect]');
        await page.waitForFunction(() =>
          ['idle', 'closed'].includes(
            window.__godsEyeView.takClient.client.link().state,
          ),
        );
      },
    );
  }
  await step(
    'phone-sized TAK controls remain inside the viewport',
    async () => {
      await page.setViewport({ width: 390, height: 844 });
      const box = await page.$eval('#tak-web-panel', (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: innerWidth,
          height: innerHeight,
          overflow: el.scrollHeight > el.clientHeight,
        };
      });
      assert(
        box.left >= -1 &&
          box.right <= box.width + 1 &&
          box.top >= -1 &&
          box.bottom <= box.height + 1,
        JSON.stringify(box),
      );
      assert(box.overflow, 'long content remains internally scrollable');
      const phoneControls = await page.$$eval(
        '#tak-web-panel button, #tak-web-panel input:not([type="checkbox"]):not([type="file"]), #tak-web-panel select, #tak-web-panel textarea, #tak-web-panel summary',
        (els) =>
          els
            .filter((el) => el.getBoundingClientRect().height > 0)
            .map((el) => ({
              tag: el.tagName,
              text: (el.getAttribute('aria-label') || el.textContent || '')
                .trim()
                .slice(0, 40),
              height: el.getBoundingClientRect().height,
              font: parseFloat(getComputedStyle(el).fontSize),
            })),
      );
      assert(
        phoneControls.every((control) => control.height >= 43.5),
        JSON.stringify(phoneControls),
      );
      assert(
        phoneControls
          .filter((control) =>
            ['INPUT', 'SELECT', 'TEXTAREA'].includes(control.tag),
          )
          .every((control) => control.font >= 16),
        'phone form text prevents automatic focus zoom',
      );
      const sticky = await page.$eval('#tak-web-panel', (el) => {
        el.scrollTop = el.scrollHeight;
        const header = el.querySelector('.tak-web-header');
        const r = header.getBoundingClientRect();
        const panel = el.getBoundingClientRect();
        return {
          position: getComputedStyle(header).position,
          headerTop: r.top,
          headerBottom: r.bottom,
          panelTop: panel.top,
          panelBottom: panel.bottom,
        };
      });
      assert.equal(sticky.position, 'sticky');
      assert(
        sticky.headerTop >= sticky.panelTop - 1 &&
          sticky.headerBottom <= sticky.panelBottom + 1,
        JSON.stringify(sticky),
      );
      await page.$eval('#tak-web-panel', (el) => {
        el.scrollTop = 0;
      });
      await captureEvidence(page, 'phone-tak');
    },
  );
  await step(
    'embedded view has no visible TAK controls and never auto-connects',
    async () => {
      const embedded = await newPage('embedded', true);
      const state = await embedded.evaluate(() => ({
        visible: [...document.querySelectorAll('.tak-web-root')].some(
          (el) => getComputedStyle(el).display !== 'none',
        ),
        link: window.__godsEyeView.takClient.client.link().state,
        contacts: window.__godsEyeView.takClient.client.store.count(),
      }));
      assert.equal(state.visible, false);
      assert(['idle', 'closed'].includes(state.link));
      assert.equal(state.contacts, 0);
      await embedded.close();
    },
  );
  await step(
    'destroy releases TAK UI, overlay, store and owned periodic work',
    async () => {
      const cleanup = await page.evaluate(() => {
        const tak = window.__godsEyeView.takClient;
        const before = window.__qaIntervals().length;
        tak.destroy();
        tak.destroy();
        return {
          before,
          after: window.__qaIntervals().length,
          roots: document.querySelectorAll('.tak-web-root').length,
          contacts: tak.client.store.count(),
          dataSources: [
            ...Array(window.__godsEyeView.viewer.dataSources.length).keys(),
          ].map((i) => window.__godsEyeView.viewer.dataSources.get(i).name),
          link: tak.client.link().state,
        };
      });
      assert.equal(cleanup.roots, 0);
      assert.equal(cleanup.contacts, 0);
      assert(!cleanup.dataSources.includes('TAK contacts'));
      assert(cleanup.before - cleanup.after >= 2, JSON.stringify(cleanup));
      assert(['idle', 'closed'].includes(cleanup.link));
    },
  );
  await step(
    'no uncaught browser, promise or Cesium rendering failures',
    async () => {
      errors.push(
        ...(await readRenderErrors(page)).map(
          (value) => `scene.renderError: ${value}`,
        ),
      );
      errors.push(...(await page.evaluate(() => window.__qaUnhandled)));
      assert.deepEqual(errors, []);
    },
  );
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status: 'passed',
        node: process.version,
        platform: process.platform,
        browser: await browser.version(),
        url: appUrl.origin,
        syntheticOnly: true,
        localGateway: gateway,
        localSyntheticPeerRoundtrip: lab,
        externalFontsAllowed: fonts,
        visualStates,
        imageryRequests,
        externalRequestsIntercepted: externalRequests,
        localApiRequestsStubbed: localApiRequests,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    `Passed ${results.length} synthetic TAK browser scenarios; no real TAK peer interoperability claimed.`,
  );
} catch (error) {
  await saveFailureArtifacts({ dir: artifactDir, browser, monitors, error });
  await fs.writeFile(
    path.join(artifactDir, 'results.json'),
    JSON.stringify(
      {
        date: new Date().toISOString(),
        status: 'failed',
        url: appUrl.origin,
        syntheticOnly: true,
        localGateway: gateway,
        localSyntheticPeerRoundtrip: lab,
        externalFontsAllowed: fonts,
        visualStates,
        results,
        error: redact(error?.message || error),
      },
      null,
      2,
    ),
  );
  console.error(redact(error?.stack || error));
  process.exitCode = 1;
} finally {
  await browser.close();
}
