import {
  mkdir,
  open,
  lstat,
  readFile,
  realpath,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import { MAX_TAK_PRINCIPALS } from './principals.js';

export const PRINCIPAL_MAP_BYTES = 256 * 1024 * 1024;
export const PRINCIPAL_MAP_LIMITS = Object.freeze({
  totalBytes: PRINCIPAL_MAP_BYTES,
  packBytes: 128 * 1024 * 1024,
  packs: 8,
  concurrency: 1,
});
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const refuse = () => {
  throw new Error(
    'Principal map storage is unavailable or its eight retained account reservations are full',
  );
};

/** Eight durable reservations bound retired-account disk allocations without deleting any work. */
export function createPrincipalMapRoots(base, forbiddenRoots) {
  const root = path.resolve(base, 'operators');
  let admission = Promise.resolve();
  const fold = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  function check(value) {
    if (
      forbiddenRoots.some(
        (denied) =>
          fold(value) === fold(path.resolve(denied)) ||
          fold(value).startsWith(fold(path.resolve(denied) + path.sep)),
      )
    )
      refuse();
  }
  return (id) => {
    const allocation = admission
      .catch(() => {})
      .then(async () => {
        if (!ID.test(id)) refuse();
        check(root);
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (fold(await realpath(root)) !== fold(root)) refuse();
        const slots = path.join(root, '.slots');
        await mkdir(slots, { mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        if (
          (await lstat(slots)).isSymbolicLink() ||
          !(await lstat(slots)).isDirectory()
        )
          refuse();
        const owners = new Set();
        const empty = [];
        for (let index = 0; index < MAX_TAK_PRINCIPALS; index++) {
          const file = path.join(slots, `${index}.json`);
          try {
            const metadata = await lstat(file);
            if (
              !metadata.isFile() ||
              metadata.isSymbolicLink() ||
              metadata.size > 128
            )
              refuse();
            const value = JSON.parse(await readFile(file, 'utf8'));
            if (!ID.test(value.id) || Object.keys(value).length !== 1) refuse();
            owners.add(value.id);
          } catch (error) {
            if (error.code === 'ENOENT') empty.push(file);
            else throw error;
          }
        }
        for (const entry of await readdir(root))
          if (entry !== '.slots' && !owners.has(entry)) refuse();
        if (!owners.has(id)) {
          let claimed = false;
          for (const file of empty) {
            let handle;
            try {
              handle = await open(file, 'wx', 0o600);
              await handle.writeFile(JSON.stringify({ id }));
              await handle.sync();
              claimed = true;
              break;
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
            } finally {
              await handle?.close();
            }
          }
          if (!claimed) refuse();
        }
        return path.join(root, id);
      });
    admission = allocation.then(
      () => {},
      () => {},
    );
    return allocation;
  };
}
