// Serve prebuilt offline road packs to authorized browsers, read-only.
// An operator builds packs at home (scripts/build-road-pack.mjs) and places
// each <name>.gevroads with its <name>.gevroads.json manifest in the pack
// directory. Browsers list them and download one for on-device routing.
// Paths never come from a request: a pack is found by the UUID in a
// validated manifest, and its file must be a regular file of the stated size.

import { lstat, readFile, readdir, realpath, open } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRateLimiter } from '../../src/tak/protocol/router.js';
import {
  ROAD_PACK_MANIFEST_VERSION,
  validateRoadPackManifest,
} from '../../src/routing/packManifest.js';

export { ROAD_PACK_MANIFEST_VERSION, validateRoadPackManifest };

export const ROAD_PACKS_ROUTE = '/api/routing/packs';
export const ROAD_PACK_SERVER_LIMITS = Object.freeze({
  maxPacks: 64,
  maxManifestBytes: 16 * 1024,
  maxPackBytes: 1024 * 1024 * 1024,
});
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRoadPackRequest(req) {
  const pathname = String(req.url || '').split('?')[0];
  return (
    pathname === ROAD_PACKS_ROUTE || pathname.startsWith(ROAD_PACKS_ROUTE + '/')
  );
}

export function defaultRoadPackRoot(env = process.env) {
  return (
    env.GEV_ROAD_PACK_DIR ||
    path.join(
      env.LOCALAPPDATA ||
        env.XDG_DATA_HOME ||
        path.join(os.homedir(), '.local', 'share'),
      'gods-eye-view',
      'road-packs',
    )
  );
}

/** Validated packs in `root` whose files exist with the stated size. */
export async function listRoadPacks(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const realRoot = await realpath(root);
  const packs = [];
  const ids = new Set();
  for (const entry of entries) {
    if (packs.length >= ROAD_PACK_SERVER_LIMITS.maxPacks) break;
    if (!entry.isFile() || !entry.name.endsWith('.gevroads.json')) continue;
    try {
      const manifestPath = path.join(realRoot, entry.name);
      const info = await lstat(manifestPath);
      if (
        !info.isFile() ||
        info.size > ROAD_PACK_SERVER_LIMITS.maxManifestBytes
      )
        continue;
      const manifest = validateRoadPackManifest(
        JSON.parse(await readFile(manifestPath, 'utf8')),
      );
      if (`${manifest.file}.json` !== entry.name || ids.has(manifest.id))
        continue;
      const file = path.join(realRoot, manifest.file);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.size !== manifest.bytes) continue;
      ids.add(manifest.id);
      packs.push(manifest);
    } catch {
      // An invalid or partial manifest is ignored, never served.
    }
  }
  return packs.sort((a, b) => a.name.localeCompare(b.name));
}

function parseRange(header, size) {
  if (header === undefined) return null;
  const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(String(header).trim());
  if (!match) return false;
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return false;
  return { start, end };
}

/**
 * @param {object} options
 * @param {string} options.root Pack directory.
 * @param {(req:object)=>{ok:boolean,status?:number}} options.authorize
 */
export function createRoadPacksHandler({ root, authorize, now = Date.now }) {
  const reads = createRateLimiter({ rate: 20, burst: 40, now });
  const json = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  return async function handleRoadPacks(req, res) {
    if (!['GET', 'HEAD'].includes(req.method))
      return json(res, 405, { error: 'Method Not Allowed', code: 'METHOD' });
    const allowed = authorize(req);
    if (!allowed?.ok)
      return json(res, allowed?.status || 401, {
        error: 'Authorized road pack access required',
        code: 'ACCESS',
      });
    if (!reads.take())
      return json(res, 429, {
        error: 'Too many road pack requests',
        code: 'RATE',
      });
    const pathname = String(req.url || '').split('?')[0];
    const packs = await listRoadPacks(root);
    if (pathname === ROAD_PACKS_ROUTE)
      return json(res, 200, {
        packs: packs.map(({ file, ...pack }) => pack),
      });
    const id = pathname.slice(ROAD_PACKS_ROUTE.length + 1).toLowerCase();
    const manifest = UUID.test(id)
      ? packs.find((pack) => pack.id === id)
      : null;
    if (!manifest)
      return json(res, 404, { error: 'Unknown road pack', code: 'MISSING' });
    const range = parseRange(req.headers.range, manifest.bytes);
    if (range === false) {
      res.writeHead(416, { 'Content-Range': `bytes */${manifest.bytes}` });
      return res.end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : manifest.bytes - 1;
    const handle = await open(
      path.join(await realpath(root), manifest.file),
      'r',
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== manifest.bytes)
        return json(res, 409, {
          error: 'Road pack changed on the server',
          code: 'CHANGED',
        });
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        ETag: `"${manifest.sha256}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(range
          ? { 'Content-Range': `bytes ${start}-${end}/${manifest.bytes}` }
          : {}),
      });
      if (req.method === 'HEAD') return res.end();
      const stream = handle.createReadStream({ start, end, autoClose: false });
      await new Promise((resolve, reject) => {
        stream.on('error', reject);
        res.on('close', resolve);
        stream.pipe(res);
      });
    } finally {
      await handle.close();
    }
  };
}
