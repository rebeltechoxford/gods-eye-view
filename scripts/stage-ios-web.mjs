#!/usr/bin/env node
// Stage exactly the production bytes inventoried for the native app.
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function stageBundledWeb(source, target) {
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink())
    throw new Error('Build root must be an ordinary directory');
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = await mkdtemp(
    path.join(path.dirname(target), '.gev-web-stage-'),
  );
  const backup = temporary + '-previous';
  const entries = [];
  let replaced = false;
  async function copy(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, item.name);
      if (item.isSymbolicLink())
        throw new Error(`Refusing bundle symlink: ${relative}`);
      if (relative === 'bundle-manifest.json')
        throw new Error('Build contains a reserved bundle manifest');
      if (
        /^\.env(?:\.|$)/i.test(item.name) ||
        /\.(?:pem|p12|pfx|key)$/i.test(item.name)
      )
        throw new Error(`Refusing private build file: ${relative}`);
      const destination = path.join(temporary, relative);
      if (item.isDirectory()) {
        await mkdir(destination);
        await copy(path.join(directory, item.name), relative);
      } else if (item.isFile()) {
        const info = await lstat(path.join(directory, item.name));
        if (!info.isFile() || info.size > 128 * 1024 * 1024)
          throw new Error(`Unsupported bundle file: ${relative}`);
        const bytes = await readFile(path.join(directory, item.name));
        await writeFile(destination, bytes, { flag: 'wx' });
        entries.push({
          path: relative,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
      } else throw new Error(`Unsupported bundle entry: ${relative}`);
    }
  }
  try {
    await copy(source);
    if (!entries.some((entry) => entry.path === 'index.html'))
      throw new Error('Build is missing index.html');
    const manifest = {
      format: 1,
      files: entries.sort((a, b) => a.path.localeCompare(b.path)),
    };
    await writeFile(
      path.join(temporary, 'bundle-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    try {
      await rename(target, backup);
      replaced = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if (replaced) await rename(backup, target);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = await stageBundledWeb(
    path.join(root, 'dist'),
    path.join(root, 'ios/GEVTAK/WebApp'),
  );
  console.log(`Staged the complete GEV build: ${manifest.files.length} files`);
}
