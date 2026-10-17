import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
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
      'mic.svg',
      'pin.svg',
      'location.svg',
      'visual-presets.svg',
      'api/tak/status.json',
      'src/key.js',
      '.env',
      'assets/test.js.map',
      'assets/key.pem',
      'assets/.secret.json',
      'unrelated.svg',
    ];
    for (const name of paths) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), `fixture:${name}`);
    }
    const result = await createOfflineShellManifest(root);
    assert.deepEqual(
      result.files.map((file) => file.path).sort(),
      paths
        .slice(0, 14)
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

test('preserved voice and dock root icons are explicitly inventoried without allowing arbitrary root SVG files', async () => {
  const sources = await Promise.all(
    [
      '../../src/voice/control.js',
      '../../src/ui/templates/command-dock.html',
      '../../src/ui/styles/command-dock-trays.css',
    ].map((file) => readFile(new URL(file, import.meta.url), 'utf8')),
  );
  const icons = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/\/([a-zA-Z0-9_-]+\.svg)/g)].map((match) => match[1]),
    ),
  );
  assert.deepEqual([...icons].sort(), [
    'location.svg',
    'mic.svg',
    'pin.svg',
    'visual-presets.svg',
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-shell-icons-'));
  try {
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html>');
    await writeFile(path.join(root, 'assets/app.js'), '// built fixture');
    await writeFile(path.join(root, 'unrelated.svg'), '<svg/>');
    const expected = new Map();
    for (const icon of icons) {
      const bytes = await readFile(
        new URL(`../../public/${icon}`, import.meta.url),
      );
      await writeFile(path.join(root, icon), bytes);
      expected.set(
        `/${icon}`,
        createHash('sha256').update(bytes).digest('hex'),
      );
    }
    const manifest = await createOfflineShellManifest(root);
    for (const [name, sha256] of expected)
      assert.equal(
        manifest.files.find((file) => file.path === name)?.sha256,
        sha256,
        name,
      );
    assert.equal(
      manifest.files.some((file) => file.path === '/unrelated.svg'),
      false,
    );
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^gev-shell-icons-/);
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
