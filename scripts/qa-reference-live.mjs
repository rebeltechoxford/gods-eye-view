#!/usr/bin/env node
/** Explicit live, bounded Chromium/Cesium FAA+NOAA smoke; synthetic positions. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { referenceMap } from '../src/maps/referenceCatalog.js';

const args = process.argv.slice(2),
  at = args.indexOf('--url');
const base = new URL(at < 0 ? 'http://127.0.0.1:4176' : args[at + 1]);
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
  'local module server required',
);
const dir = 'qa-artifacts/reference-live';
await fs.mkdir(dir, { recursive: true });
const requests = [],
  errors = [];
const sources = ['faa-vfr', 'noaa-enc'].map(referenceMap);
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setRequestInterception(true);
page.on('request', (request) => {
  const url = new URL(request.url());
  if (url.origin === base.origin && url.pathname === '/__qa-reference-provider')
    return void request.respond({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Public chart provider samples</title><h1>Public chart provider samples</h1><p>Synthetic Oxford MS / Chesapeake positions; no private contacts. Samples do not establish navigational suitability.</p>',
    });
  if (url.origin === base.origin)
    return void request.continue().catch(() => {});
  const source = sources.find(({ url: root }) =>
    request.url().startsWith(root),
  );
  if (!source || requests.filter(({ id }) => id === source.id).length >= 3)
    return void request.abort().catch(() => {});
  requests.push({ id: source.id, url: request.url() });
  void request.continue().catch(() => {});
});
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(new URL('/__qa-reference-provider', base).href);
  const results = await page.evaluate(async () => {
    const { createReferenceImagery } =
      await import('/src/maps/referenceImagery.js');
    const samples = [
      { id: 'faa-vfr', lon: -89.5192, lat: 34.3665, level: 8 },
      { id: 'noaa-enc', lon: -76.3, lat: 38.9, level: 10 },
    ];
    const output = [];
    for (const sample of samples) {
      const provider = await createReferenceImagery(sample.id);
      const { lon, lat, level } = sample;
      const x = Math.floor(((lon + 180) / 360) * 2 ** level),
        y = Math.floor(
          ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) *
            2 ** level,
        );
      const bounds = provider.tilingScheme.tileXYToRectangle(x, y, level);
      const image = await provider.requestImage(x, y, level);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, 256, 256).data;
      const values = new Set();
      for (let index = 0; index < pixels.length; index += 16)
        values.add(pixels[index]);
      const section = document.createElement('section'),
        title = document.createElement('h2');
      title.textContent = `${sample.id}: z${level}/${x}/${y}`;
      section.append(title, canvas);
      document.body.append(section);
      output.push({
        ...sample,
        x,
        y,
        width: image.width,
        height: image.height,
        uniqueSampledRed: values.size,
        minimumLevel: provider.minimumLevel,
        maximumLevel: provider.maximumLevel,
        containsPosition:
          bounds.west <= (lon * Math.PI) / 180 &&
          bounds.east >= (lon * Math.PI) / 180 &&
          bounds.south <= (lat * Math.PI) / 180 &&
          bounds.north >= (lat * Math.PI) / 180,
        boundsDegrees: Object.fromEntries(
          ['west', 'south', 'east', 'north'].map((key) => [
            key,
            (bounds[key] * 180) / Math.PI,
          ]),
        ),
      });
    }
    return output;
  });
  for (const result of results) {
    assert.equal(result.width, 256);
    assert.equal(result.height, 256);
    assert(result.containsPosition);
    assert(result.uniqueSampledRed > 1, `${result.id}: blank sample`);
  }
  assert.equal(results[0].minimumLevel, 0);
  assert.equal(results[0].maximumLevel, 12);
  const noaa = new URL(requests.find(({ id }) => id === 'noaa-enc').url);
  assert.equal(noaa.searchParams.get('crs'), 'EPSG:3857');
  assert.equal(noaa.searchParams.get('version'), '1.3.0');
  assert.equal(noaa.searchParams.get('layers'), '0,1,2,3,4,5,6,7,8,9,10,11,12');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: `${dir}/public-samples.png`, fullPage: true });
  await fs.writeFile(
    `${dir}/results.json`,
    JSON.stringify(
      {
        status: 'passed',
        at: new Date().toISOString(),
        scope:
          'Actual public FAA VFR and NOAA ENC; real browser CORS, Cesium factories/projection, canvas decoding; synthetic positions, bounded3requests/source',
        results,
        requests,
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Public Chromium/Cesium samples: FAA VFR + NOAA ENC passed');
} catch (error) {
  await fs.writeFile(
    `${dir}/results.json`,
    JSON.stringify(
      {
        status: 'failed',
        at: new Date().toISOString(),
        requests,
        errors,
        failure: error.stack,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
