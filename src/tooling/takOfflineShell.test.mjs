import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createOfflineShellManifest } from '../../server/maps/offline/shell.js';

test('offline shell includes built app/workers but excludes source, APIs, maps, keys and hidden files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-shell-'));
  try {
    const paths = [
      'index.html',
      'assets/app-123.js',
      'assets/app.css',
      'cesium/Workers/geometry.js',
      'cesium/Assets/test.json',
      'models/model.glb',
      'events/data.geojsonl',
      'fonts/font.css',
      'fonts/symbols.woff2',
      'fonts/licenses/symbols-APACHE.txt',
      'api/tak/status.json',
      'src/key.js',
      '.env',
      'assets/test.js.map',
      'assets/key.pem',
      'assets/.secret.json',
    ];
    for (const name of paths) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), `fixture:${name}`);
    }
    const result = await createOfflineShellManifest(root);
    assert.deepEqual(
      result.files.map((file) => file.path).sort(),
      paths
        .slice(0, 10)
        .map((name) => `/${name}`)
        .sort(),
    );
    assert.equal(
      result.totalBytes,
      result.files.reduce((sum, file) => sum + file.bytes, 0),
    );
    assert.equal(
      result.files.find((file) => file.path === '/index.html').sha256,
      createHash('sha256').update('fixture:index.html').digest('hex'),
    );
    assert.equal(
      (await createOfflineShellManifest(root)).revision,
      result.revision,
    );
    await writeFile(path.join(root, 'assets/app-123.js'), 'changed');
    assert.notEqual(
      (await createOfflineShellManifest(root)).revision,
      result.revision,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline shell refuses an unbuilt directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-shell-empty-'));
  try {
    await assert.rejects(
      createOfflineShellManifest(root),
      /Build the application/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
