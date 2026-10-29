#!/usr/bin/env node
// Copy the complete production app, not a reduced mobile page.
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'dist');
const target = path.join(root, 'ios/GEVTAK/WebApp');
await readFile(path.join(source, 'index.html'));
const entries = [];
async function inspect(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isSymbolicLink()) throw new Error(`Refusing bundle symlink: ${relative}`);
    if (item.isDirectory()) await inspect(path.join(directory, item.name), relative);
    else if (item.isFile()) entries.push({ path: relative, sha256: createHash('sha256').update(await readFile(path.join(directory, item.name))).digest('hex') });
  }
}
await inspect(source);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await writeFile(path.join(target, 'bundle-manifest.json'), JSON.stringify({ format: 1, files: entries.sort((a,b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
console.log(`Staged the complete GEV build: ${entries.length} files`);
