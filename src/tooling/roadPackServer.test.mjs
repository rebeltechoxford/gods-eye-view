import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ROAD_PACKS_ROUTE,
  createRoadPacksHandler,
  isRoadPackRequest,
  listRoadPacks,
} from '../../server/routing/packs.js';
import { validateRoadPackManifest } from '../routing/packManifest.js';
import { syntheticPack, gridSpec } from '../testSupport/roadGraph.mjs';

const ID = '5351b743-09b8-41fe-acd3-0436e449dece';

function manifestFor(bytes, overrides = {}) {
  return {
    manifestVersion: 1,
    id: ID,
    name: 'Synthetic Oxford',
    file: 'oxford.gevroads',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    profile: 'car',
    bounds: { west: -89.6, south: 34.3, east: -89.4, north: 34.4 },
    edition: '2026-10-17T00:27:03.000Z',
    builtAt: '2026-10-17T08:22:56.596Z',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    ...overrides,
  };
}

async function packDirectory(t, extra = async () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'gev-road-packs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = syntheticPack(gridSpec(4, 4));
  await writeFile(path.join(dir, 'oxford.gevroads'), bytes);
  await writeFile(
    path.join(dir, 'oxford.gevroads.json'),
    JSON.stringify(manifestFor(bytes)),
  );
  await extra(dir, bytes);
  return { dir, bytes };
}

async function serve(t, root, authorize = () => ({ ok: true })) {
  const handler = createRoadPacksHandler({ root, authorize });
  const server = http.createServer((req, res) => {
    if (isRoadPackRequest(req)) handler(req, res);
    else res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (pathname, init) => fetch(base + pathname, init);
}

test('manifests are validated strictly on both sides', () => {
  const bytes = syntheticPack(gridSpec(2, 2));
  const good = manifestFor(bytes);
  assert.equal(validateRoadPackManifest(good).name, 'Synthetic Oxford');
  const { file, ...published } = good;
  assert.equal(validateRoadPackManifest(published).file, undefined);
  for (const bad of [
    { ...good, manifestVersion: 2 },
    { ...good, id: 'not-a-uuid' },
    { ...good, file: '../etc/passwd' },
    { ...good, file: 'pack.zip' },
    { ...good, sha256: 'abc' },
    { ...good, profile: 'foot' },
    { ...good, bounds: { west: 1, south: 1, east: 0, north: 2 } },
    { ...good, edition: '2026-10-17' },
    { ...good, name: 'a\u0000b' },
  ])
    assert.throws(() => validateRoadPackManifest(bad), TypeError);
});

test('the server lists and streams packs, with resumable ranges', async (t) => {
  const { dir, bytes } = await packDirectory(t);
  const get = await serve(t, dir);
  const list = await (await get(ROAD_PACKS_ROUTE)).json();
  assert.equal(list.packs.length, 1);
  assert.equal(list.packs[0].id, ID);
  assert.equal(list.packs[0].file, undefined, 'server file names stay private');
  // The phone re-validates every listed pack, so a listing entry must pass.
  assert.equal(validateRoadPackManifest(list.packs[0]).id, ID);
  const full = await get(`${ROAD_PACKS_ROUTE}/${ID}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  const tail = await get(`${ROAD_PACKS_ROUTE}/${ID}`, {
    headers: { Range: 'bytes=100-' },
  });
  assert.equal(tail.status, 206);
  assert.equal(
    tail.headers.get('content-range'),
    `bytes 100-${bytes.length - 1}/${bytes.length}`,
  );
  assert.deepEqual(
    new Uint8Array(await tail.arrayBuffer()),
    bytes.subarray(100),
  );
  assert.equal(
    (
      await get(`${ROAD_PACKS_ROUTE}/${ID}`, {
        headers: { Range: `bytes=${bytes.length}-` },
      })
    ).status,
    416,
  );
  assert.equal(
    (await get(`${ROAD_PACKS_ROUTE}/00000000-0000-4000-8000-000000000000`))
      .status,
    404,
  );
  assert.equal(
    (await get(`${ROAD_PACKS_ROUTE}/..%2Foxford.gevroads`)).status,
    404,
  );
  assert.equal((await get(ROAD_PACKS_ROUTE, { method: 'POST' })).status, 405);
});

test('unauthorized requests are refused before any pack is read', async (t) => {
  const { dir } = await packDirectory(t);
  const get = await serve(t, dir, () => ({ ok: false, status: 401 }));
  const response = await get(ROAD_PACKS_ROUTE);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'ACCESS');
});

test('mismatched, symlinked, duplicate or broken entries are never listed', async (t) => {
  const { dir } = await packDirectory(t, async (root, bytes) => {
    // Size mismatch.
    await writeFile(path.join(root, 'short.gevroads'), bytes.subarray(0, 100));
    await writeFile(
      path.join(root, 'short.gevroads.json'),
      JSON.stringify(
        manifestFor(bytes, {
          id: '11111111-1111-4111-8111-111111111111',
          file: 'short.gevroads',
        }),
      ),
    );
    // Symlinked pack file.
    await symlink(
      path.join(root, 'oxford.gevroads'),
      path.join(root, 'linked.gevroads'),
    );
    await writeFile(
      path.join(root, 'linked.gevroads.json'),
      JSON.stringify(
        manifestFor(bytes, {
          id: '22222222-2222-4222-8222-222222222222',
          file: 'linked.gevroads',
        }),
      ),
    );
    // Duplicate id and a manifest naming another file.
    await writeFile(
      path.join(root, 'copy.gevroads.json'),
      JSON.stringify(manifestFor(bytes, { file: 'oxford.gevroads' })),
    );
    await writeFile(path.join(root, 'broken.gevroads.json'), '{not json');
  });
  const packs = await listRoadPacks(dir);
  assert.deepEqual(
    packs.map((pack) => pack.id),
    [ID],
  );
  assert.deepEqual(await listRoadPacks(path.join(dir, 'missing')), []);
});
