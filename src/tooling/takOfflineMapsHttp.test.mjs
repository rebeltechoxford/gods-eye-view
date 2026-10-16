import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import connect from 'connect';
import { takGatewayProxy } from '../../server/providers/tak.js';
import { startTakHttpsServer } from '../../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from './takTlsFixtures.mjs';
import { createOfflineMapsHandler } from '../../server/maps/offline/http.js';
import { OfflinePackError } from '../../server/maps/offline/store.js';

const token = 'synthetic-offline-operator-token-0123456789';
const image = await readFile(
  new URL(
    '../../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const input = {
  name: 'Synthetic authenticated map',
  bounds: { west: -90, south: 34, east: -89, north: 35 },
  minZoom: 0,
  maxZoom: 0,
};
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-offline-http-'));
  return {
    root,
    cleanup: async () => {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(root).startsWith('gev-offline-http-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}
function request(
  origin,
  pathname,
  { method = 'GET', headers = {}, body, ca } = {},
) {
  return new Promise((resolve, reject) => {
    const req = (origin.startsWith('https:') ? https : http).request(
      origin + pathname,
      {
        method,
        ca,
        headers: {
          ...(body !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            bytes: Buffer.concat(chunks),
            json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function ready(read) {
  for (let i = 0; i < 100; i++) {
    const manifest = (await read()).json();
    if (manifest.state === 'ready') return manifest;
    if (manifest.state === 'failed') throw new Error(manifest.error);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic map did not become ready');
}

test('loopback offline routes require an ephemeral header token and exact mutation Origin; dev cannot claim an offline shell', async (t) => {
  const directory = await temporary(t);
  let calls = 0;
  const middleware = connect();
  const server = http.createServer(middleware);
  const plugin = takGatewayProxy({
    env: { TAK_GATEWAY: '1', TAK_GATEWAY_TOKEN: token },
    offlineMaps: {
      root: path.join(directory.root, 'packs'),
      fetchImpl: async () => {
        calls++;
        return new Response(image, {
          headers: { 'content-type': 'image/jpeg' },
        });
      },
    },
  });
  plugin.configureServer({ middlewares: middleware, httpServer: server });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await plugin.closeBundle();
    await new Promise((resolve) => server.close(resolve));
    await directory.cleanup();
  });
  const endpoint = '/api/maps/offline/packs';
  assert.equal((await request(origin, endpoint)).status, 401);
  assert.equal(
    (await request(origin, endpoint + `?token=${token}`)).status,
    401,
  );
  await assert.rejects(access(path.join(directory.root, 'packs')));
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await request(origin, endpoint, { headers })).status, 200);
  assert.equal(
    (
      await request(origin, endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(origin, endpoint, {
        method: 'POST',
        headers: { ...headers, Origin: 'http://evil.example' },
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(origin, endpoint, {
        headers: { ...headers, 'X-Forwarded-For': '127.0.0.1' },
      })
    ).status,
    403,
  );
  const created = await request(origin, endpoint, {
    method: 'POST',
    headers: { ...headers, Origin: origin },
    body: JSON.stringify(input),
  });
  assert.equal(created.status, 202);
  const id = created.json().id;
  const manifest = await ready(() =>
    request(origin, `${endpoint}/${id}`, { headers }),
  );
  assert.equal(manifest.completedTiles, 1);
  const tile = await request(origin, `${endpoint}/${id}/tiles/0/0/0`, {
    headers,
  });
  assert.equal(tile.status, 200);
  assert.deepEqual(tile.bytes, image);
  assert.equal(
    tile.headers['x-content-sha256'],
    manifest.tiles['0/0/0'].sha256,
  );
  assert.equal(tile.headers['cache-control'], 'no-store');
  assert.equal(
    (await request(origin, '/api/maps/offline/shell', { headers })).status,
    409,
  );
  assert.equal(
    (await request(origin, `${endpoint}/${id}/tiles/0/00/0`, { headers }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(origin, endpoint, {
        method: 'POST',
        headers: { ...headers, Origin: origin },
        body: 'x'.repeat(2049),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await request(origin, `${endpoint}/${id}`, {
        method: 'DELETE',
        headers: { ...headers, Origin: origin },
      })
    ).status,
    204,
  );
  assert.equal(calls, 1);
});

test('private HTTPS offline routes retain the cookie wall, mutation CSRF guard and authenticated built-shell inventory', async (t) => {
  const directory = await temporary(t);
  const certs = createTakTlsFixtures();
  const dist = path.join(directory.root, 'dist');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await writeFile(
    path.join(dist, 'index.html'),
    '<!doctype html><title>Synthetic</title>',
  );
  await writeFile(
    path.join(dist, 'assets/app.js'),
    'globalThis.synthetic=true',
  );
  const instance = await startTakHttpsServer({
    env: {
      TAK_GATEWAY_TOKEN: token,
      TAK_HTTPS_CERT: certs.file('server.pem'),
      TAK_HTTPS_KEY: certs.file('server.key'),
    },
    distRoot: dist,
    port: 0,
    providerPlugins: [],
    offlineMaps: {
      root: path.join(directory.root, 'packs'),
      fetchImpl: async () =>
        new Response(image, { headers: { 'content-type': 'image/jpeg' } }),
    },
  });
  t.after(async () => {
    await instance.close();
    certs.cleanup();
    await directory.cleanup();
  });
  const send = (pathname, options = {}) =>
    request(instance.origin, pathname, {
      ca: certs.read('ca.pem'),
      ...options,
    });
  const endpoint = '/api/maps/offline/packs';
  assert.equal((await send(endpoint)).status, 401);
  assert.equal(
    (await send(endpoint, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
    401,
  );
  await assert.rejects(access(path.join(directory.root, 'packs')));
  const loginBody = new URLSearchParams({ token }).toString();
  const login = await send('/login', {
    method: 'POST',
    headers: {
      Origin: instance.origin,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: loginBody,
  });
  assert.equal(login.status, 303);
  const headers = { Cookie: login.headers['set-cookie'][0].split(';')[0] };
  assert.equal(
    (
      await send(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })
    ).status,
    403,
  );
  const create = await send(endpoint, {
    method: 'POST',
    headers: { ...headers, Origin: instance.origin },
    body: JSON.stringify(input),
  });
  assert.equal(create.status, 202);
  const pack = await ready(() =>
    send(`${endpoint}/${create.json().id}`, { headers }),
  );
  assert.equal((await send(`${endpoint}/${pack.id}/tiles/0/0/0`)).status, 401);
  assert.equal(
    (await send(`${endpoint}/${pack.id}/tiles/0/0/0`, { headers })).status,
    200,
  );
  const shell = await send('/api/maps/offline/shell', { headers });
  assert.equal(shell.status, 200);
  assert.match(shell.json().revision, /^[0-9a-f]{64}$/);
  assert.ok(shell.json().files.some((file) => file.path === '/assets/app.js'));
  assert.equal(
    (
      await send('/logout', {
        method: 'POST',
        headers: { ...headers, Origin: instance.origin },
      })
    ).status,
    303,
  );
  assert.equal((await send(endpoint, { headers })).status, 401);
});

test('cancel remains available after ordinary mutation budget is exhausted and has its own bounded budget', async (t) => {
  let cancellations = 0;
  const handler = createOfflineMapsHandler({
    authorize: () => ({ ok: true }),
    now: () => 0,
    store: {
      create() {
        throw new OfflinePackError('SYNTHETIC', 'Synthetic invalid request');
      },
      cancel() {
        cancellations++;
        return { state: 'cancelled' };
      },
    },
  });
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await request(origin, '/api/maps/offline/packs', {
          method: 'POST',
          body: '{}',
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await request(origin, '/api/maps/offline/packs', {
        method: 'POST',
        body: '{}',
      })
    ).status,
    429,
  );
  const action =
    '/api/maps/offline/packs/12345678-1234-4234-8234-123456789012/cancel';
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await request(origin, action, { method: 'POST' })).status,
      200,
    );
  assert.equal((await request(origin, action, { method: 'POST' })).status, 429);
  assert.equal(cancellations, 4);
});
