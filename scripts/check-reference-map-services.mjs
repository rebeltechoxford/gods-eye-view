#!/usr/bin/env node
/** Bounded public-source smoke test, separate from deterministic repository tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { REFERENCE_MAPS } from '../src/maps/referenceCatalog.js';

const dir = 'qa-artifacts/reference-map-services';
await fs.mkdir(dir, { recursive: true });
const results = [];
async function acquire(url) {
  const response = await fetch(url, {
    headers: { Origin: 'http://localhost:4176' },
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  assert(response.ok, `${response.status} ${url}`);
  assert(
    ['*', 'http://localhost:4176'].includes(
      response.headers.get('access-control-allow-origin'),
    ),
    `CORS unavailable: ${url}`,
  );
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      assert(length <= 8 * 1024 * 1024, 'sample size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks, length);
  return {
    bytes,
    type: response.headers.get('content-type'),
    cors: response.headers.get('access-control-allow-origin'),
  };
}
function tileAt(lon, lat, level) {
  return {
    level,
    x: Math.floor(((lon + 180) / 360) * 2 ** level),
    y: Math.floor(
      ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) *
        2 ** level,
    ),
  };
}
for (const source of REFERENCE_MAPS) {
  try {
    let metadata = null,
      url,
      tile = null;
    if (source.sourceType === 'wms') {
      const query = new URLSearchParams({
        service: 'WMS',
        request: 'GetMap',
        version: '1.3.0',
        crs: 'EPSG:3857',
        layers: source.layers,
        bbox: '-8500000,4680000,-8450000,4730000',
        width: '256',
        height: '256',
        format: 'image/png',
        transparent: 'true',
        styles: '',
      });
      url = `${source.url}?${query}`;
    } else {
      const response = await acquire(`${source.url}?f=pjson`);
      metadata = JSON.parse(response.bytes);
      assert(!metadata.error, `${source.id}: JSON service error`);
      assert(
        metadata.tileInfo?.lods?.length > 0,
        `${source.id}: no tile scheme`,
      );
      assert.equal(metadata.tileInfo.spatialReference.wkid, 102100);
      if (source.minimumChartLevel !== undefined) {
        assert.equal(metadata.minLOD, source.minimumChartLevel);
        assert.equal(metadata.maxLOD, source.maximumLevel);
      }
      // FAA's valid lower overview levels can intentionally be transparent.
      // Level9 provides real IFR chart detail at this synthetic location.
      tile = tileAt(
        -89.5192,
        34.3665,
        source.id.startsWith('faa-ifr-') ? 9 : (source.minimumChartLevel ?? 8),
      );
      url = `${source.url}/tile/${tile.level}/${tile.y}/${tile.x}`;
    }
    const response = await acquire(url);
    const image = await sharp(response.bytes).metadata();
    assert.equal(image.width, 256);
    assert.equal(image.height, 256);
    const stats = await sharp(response.bytes).stats();
    assert(
      stats.entropy > 0,
      `${source.id}: selected sample is an empty coverage tile`,
    );
    await fs.writeFile(path.join(dir, `${source.id}.sample`), response.bytes);
    const result = {
      id: source.id,
      status: 'passed',
      at: new Date().toISOString(),
      url,
      tile,
      bytes: response.bytes.length,
      image: { width: image.width, height: image.height, format: image.format },
      cors: response.cors,
      metadata: metadata && {
        currentVersion: metadata.currentVersion,
        minLOD: metadata.minLOD,
        maxLOD: metadata.maxLOD,
        lods: metadata.tileInfo.lods.length,
        copyrightText: metadata.copyrightText,
      },
    };
    results.push(result);
    console.log(
      `ok ${source.id}: ${image.format} ${response.bytes.length} bytes`,
    );
  } catch (error) {
    results.push({ id: source.id, status: 'failed', error: error.message });
    console.error(`FAIL ${source.id}: ${error.message}`);
  }
}
await fs.writeFile(
  path.join(dir, 'results.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      scope:
        '8 pinned public service samples at synthetic Oxford MS/Chesapeake positions; no private TAK data',
      results,
    },
    null,
    2,
  ),
);
if (results.some(({ status }) => status !== 'passed')) process.exitCode = 1;
