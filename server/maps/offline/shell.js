import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export const SHELL_LIMITS = Object.freeze({
  files: 4096,
  bytes: 128 * 1024 * 1024,
});
const ROOT_FILES = new Set([
  'index.html',
  'manifest.webmanifest',
  'favicon.svg',
  'logo.svg',
  'mic.svg',
  'pin.svg',
  'location.svg',
  'visual-presets.svg',
]);
const DIRECTORIES = new Set([
  'assets',
  'cesium',
  'events',
  'fonts',
  'models',
  'pwa',
]);
const EXTENSIONS = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.geojson',
  '.geojsonl',
  '.wasm',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.svg',
  '.gif',
  '.ktx2',
  '.glb',
  '.gltf',
  '.bin',
  '.xml',
  '.woff',
  '.woff2',
  '.webmanifest',
]);

/** Static, public application files only. Login, API responses and keys never enter a pack. */
export async function createOfflineShellManifest(distDir) {
  const root = await realpath(distDir);
  const files = [];
  let totalBytes = 0;
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (relative || DIRECTORIES.has(entry.name)) await walk(absolute, name);
        continue;
      }
      if (
        (!relative && !ROOT_FILES.has(name)) ||
        (!EXTENSIONS.has(path.extname(name)) &&
          !/^fonts\/licenses\/[A-Za-z0-9_.-]+\.txt$/.test(name))
      )
        continue;
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const resolved = await realpath(absolute);
      if (
        path.relative(root, resolved).startsWith('..') ||
        path.isAbsolute(path.relative(root, resolved))
      )
        throw new Error('Offline shell escaped its build root');
      totalBytes += stat.size;
      if (files.length >= SHELL_LIMITS.files || totalBytes > SHELL_LIMITS.bytes)
        throw new Error('Offline application exceeds its storage budget');
      const bytes = await readFile(resolved);
      if (bytes.byteLength !== stat.size)
        throw new Error(
          'Application changed during offline preparation; retry',
        );
      files.push({
        path: `/${name}`,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  await walk(root);
  if (
    !files.some((file) => file.path === '/index.html') ||
    !files.some(
      (file) => file.path.startsWith('/assets/') && file.path.endsWith('.js'),
    )
  )
    throw new Error('Build the application before saving its offline shell');
  const revision = createHash('sha256')
    .update(JSON.stringify(files))
    .digest('hex');
  return { schemaVersion: 1, revision, totalBytes, files };
}
