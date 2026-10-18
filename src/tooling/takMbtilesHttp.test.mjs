import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import https from 'node:https';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startTakHttpsServer } from '../../server/standalone/tak-https.mjs';
import { createTakTlsFixtures } from './takTlsFixtures.mjs';

const Database = sqlite.Database || sqlite.DatabaseSync;
const tokens = {
  alpha: 'synthetic-mbtiles-alpha-operator-token-123456',
  bravo: 'synthetic-mbtiles-bravo-operator-token-123456',
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function setup(t, named = true, options = {}) {
  const alpha = createTakTlsFixtures({
    clientName: 'MBTiles Alpha',
    authorityName: 'MBTiles Alpha',
  });
  const bravo = named
    ? createTakTlsFixtures({
        clientName: 'MBTiles Bravo',
        authorityName: 'MBTiles Bravo',
      })
    : null;
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-mbtiles-http-'));
  let app;
  t.after(async () => {
    await app?.close();
    alpha.cleanup();
    bravo?.cleanup();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^gev-mbtiles-http-/);
    await rm(root, { recursive: true, force: true });
  });
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  await writeFile(
    path.join(dist, 'index.html'),
    '<!doctype html><title>Synthetic MBTiles host</title>',
  );
  const env = {
    TAK_HTTPS_CERT: alpha.file('server.pem'),
    TAK_HTTPS_KEY: alpha.file('server.key'),
    TAK_GATEWAY_TOKEN: tokens.alpha,
  };
  let configuration;
  if (named) {
    configuration = {
      schemaVersion: 1,
      principals: [
        ['alpha', alpha],
        ['bravo', bravo],
      ].map(([id, fixture]) => ({
        id,
        role: 'operator',
        enabled: true,
        tokenSha256: hash(tokens[id]),
        server: { host: '127.0.0.1', port: 9, ...fixture.clientConfig },
      })),
    };
    env.TAK_GATEWAY_USERS_FILE = path.join(root, 'principals.json');
    await writeFile(env.TAK_GATEWAY_USERS_FILE, JSON.stringify(configuration));
  }
  app = await startTakHttpsServer({
    env,
    distRoot: dist,
    port: 0,
    providerPlugins: [],
    offlineMaps: {
      root: path.join(root, 'maps'),
      fetchImpl: async () => {
        throw new Error(
          'No metadata URL or public tile fetch is permitted in this fixture',
        );
      },
      ...options,
    },
  });
  const image = await readFile(
    new URL(
      '../../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
      import.meta.url,
    ),
  );
  const file = path.join(root, 'source.mbtiles'),
    db = new Database(file);
  db.exec(
    "CREATE TABLE metadata(name TEXT,value TEXT); INSERT INTO metadata VALUES('name','Approved synthetic raster'),('format','jpg'); CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB)",
  );
  db.prepare('INSERT INTO tiles VALUES(?,?,?,?)').run(2, 1, 0, image);
  db.close();
  const bytes = await readFile(file);
  const input = {
    name: 'Local approved map',
    fileBytes: bytes.length,
    sourceTitle: 'Synthetic own map',
    license: 'Owned fixture, copy permitted',
    edition: '',
    authorized: true,
  };
  const request = (
    pathname,
    {
      method = 'GET',
      cookie,
      scope,
      origin,
      body,
      type = 'application/json',
    } = {},
  ) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        app.origin + pathname,
        {
          ca: alpha.read('ca.pem'),
          method,
          headers: {
            ...(cookie ? { Cookie: cookie } : {}),
            ...(scope ? { 'X-TAK-Storage-Scope': scope } : {}),
            ...(origin ? { Origin: origin } : {}),
            ...(body !== undefined
              ? {
                  'Content-Type': type,
                  'Content-Length': Buffer.byteLength(body),
                }
              : {}),
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
  const login = async (
    id = 'alpha',
    { cookie: previousCookie, token = tokens[id] } = {},
  ) => {
    const response = await request('/login', {
      cookie: previousCookie,
      method: 'POST',
      origin: app.origin,
      type: 'application/x-www-form-urlencoded',
      body: new URLSearchParams({
        ...(named ? { principal: id } : {}),
        token,
      }).toString(),
    });
    assert.equal(response.status, 303);
    const cookie = response.headers['set-cookie'][0].split(';')[0];
    const status = (await request('/api/tak/status', { cookie })).json();
    return { cookie, scope: status.storageScope };
  };
  const readJob = async (id, session) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await request(
        `/api/maps/offline/imports/${id}`,
        session,
      );
      assert.equal(response.status, 200);
      const value = response.json();
      if (['ready', 'failed', 'cancelled'].includes(value.state)) return value;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Authenticated MBTiles fixture did not finish');
  };
  return {
    root,
    app,
    alpha,
    request,
    login,
    readJob,
    bytes,
    input,
    image,
    configuration,
    writeConfiguration: () =>
      writeFile(env.TAK_GATEWAY_USERS_FILE, JSON.stringify(configuration)),
  };
}

for (const target of ['imports', 'packs'])
  test(`slow HTTPS POST /${target} cannot reserve a job after logout during its JSON body`, async (t) => {
    const f = await setup(t),
      alpha = await f.login();
    // Warm the scoped handler; observe its actual body reader without consuming
    // data or adding an alternate authorization hook to production code.
    assert.equal(
      (await f.request('/api/maps/offline/packs', alpha)).status,
      200,
    );
    const pathname = `/api/maps/offline/${target}`;
    let observed;
    const seeing = new Promise((resolve) => {
      observed = resolve;
    });
    const listener = (req) => {
      if (req.method === 'POST' && req.url === pathname) observed(req);
    };
    f.app.server.on('request', listener);
    const value =
      target === 'imports'
        ? f.input
        : {
            name: 'Never authorized job',
            bounds: { west: -1, south: -1, east: 1, north: 1 },
            minZoom: 0,
            maxZoom: 0,
          };
    const body = JSON.stringify(value),
      halfway = Math.floor(body.length / 2);
    const request = https.request(f.app.origin + pathname, {
      ca: f.alpha.read('ca.pem'),
      method: 'POST',
      headers: {
        Cookie: alpha.cookie,
        Origin: f.app.origin,
        'X-TAK-Storage-Scope': alpha.scope,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    const result = new Promise((resolve, reject) => {
      request.on('error', reject);
      request.on('response', (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
    });
    request.write(body.slice(0, halfway));
    const incoming = await seeing;
    const deadline = Date.now() + 5000;
    while (!incoming.listenerCount('readable') && Date.now() < deadline)
      await new Promise(setImmediate);
    assert.ok(
      incoming.listenerCount('readable'),
      'Actual JSON reader must be awaiting remainder before logout',
    );
    try {
      assert.equal(
        (
          await f.request('/logout', {
            ...alpha,
            method: 'POST',
            origin: f.app.origin,
          })
        ).status,
        303,
      );
      request.end(body.slice(halfway));
      assert.equal(await result, 401);
    } finally {
      f.app.server.removeListener('request', listener);
      request.destroy();
    }
    const replacement = await f.login();
    assert.deepEqual(
      (await f.request('/api/maps/offline/packs', replacement)).json().packs,
      [],
    );
    const directory = path.join(f.root, 'maps', 'operators', 'alpha');
    const entries = await readdir(directory);
    assert.deepEqual(
      entries.filter((name) => !['.lock', '.imports'].includes(name)),
      [],
    );
    if (entries.includes('.imports'))
      assert.deepEqual(await readdir(path.join(directory, '.imports')), []);
  });

test('real private HTTPS import inherits login, exact Origin and named scope; other principals cannot read or mutate it', async (t) => {
  const f = await setup(t),
    { request } = f,
    api = '/api/maps/offline/imports';
  const selection = {
    bounds: { west: -89, south: -80, east: -1, north: -10 },
    minZoom: 2,
    maxZoom: 2,
  };
  assert.equal(
    (
      await request(api, {
        method: 'POST',
        origin: f.app.origin,
        body: JSON.stringify(f.input),
      })
    ).status,
    401,
  );
  const alpha = await f.login(),
    bravo = await f.login('bravo');
  for (const session of [
    { cookie: alpha.cookie },
    { cookie: bravo.cookie, scope: alpha.scope },
  ]) {
    const result = await request(api, {
      ...session,
      method: 'POST',
      origin: f.app.origin,
      body: JSON.stringify(f.input),
    });
    assert.equal(result.status, 409);
    assert.equal(result.json().code, 'operator-context-changed');
  }
  assert.equal(
    (
      await request(api, {
        ...alpha,
        method: 'POST',
        origin: 'https://evil.invalid',
        body: JSON.stringify(f.input),
      })
    ).status,
    403,
  );
  const created = await request(api, {
    ...alpha,
    method: 'POST',
    origin: f.app.origin,
    body: JSON.stringify({ ...f.input, selection }),
  });
  assert.equal(created.status, 202);
  const id = created.json().id;
  assert.equal((await request(`${api}/${id}`, bravo)).status, 404);
  assert.equal(
    (
      await request(`${api}/${id}/file`, {
        ...bravo,
        scope: alpha.scope,
        method: 'PUT',
        origin: f.app.origin,
        body: f.bytes,
        type: 'application/vnd.sqlite3',
      })
    ).status,
    409,
  );
  const upload = await request(`${api}/${id}/file`, {
    ...alpha,
    method: 'PUT',
    origin: f.app.origin,
    body: f.bytes,
    type: 'application/vnd.sqlite3',
  });
  assert.equal(upload.status, 202);
  const job = await f.readJob(id, alpha);
  assert.equal(job.state, 'ready', job.error);
  const manifest = await request(
    `/api/maps/offline/packs/${job.packId}`,
    alpha,
  );
  assert.equal(manifest.status, 200);
  assert.equal(manifest.json().schemaVersion, 2);
  assert.deepEqual(manifest.json().provenance.selection, selection);
  assert.deepEqual(manifest.json().plannedKeys, ['2/1/3']);
  assert.equal(
    (await request(`/api/maps/offline/packs/${job.packId}`, bravo)).status,
    404,
  );
  const tile = await request(
    `/api/maps/offline/packs/${job.packId}/tiles/2/1/3`,
    alpha,
  );
  assert.equal(tile.status, 200);
  assert.deepEqual(tile.bytes, f.image);
  assert.equal(
    (
      await request(`${api}/${id}`, {
        ...bravo,
        method: 'DELETE',
        origin: f.app.origin,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`${api}/${id}`, {
        ...alpha,
        method: 'DELETE',
        origin: f.app.origin,
      })
    ).status,
    204,
  );
});

test('real HTTPS logout aborts a pending MBTiles upload; a replacement cookie cannot finish the old write', async (t) => {
  const f = await setup(t),
    alpha = await f.login(),
    api = '/api/maps/offline/imports';
  const created = await f.request(api, {
    ...alpha,
    method: 'POST',
    origin: f.app.origin,
    body: JSON.stringify(f.input),
  });
  const id = created.json().id;
  const upload = https.request(f.app.origin + `${api}/${id}/file`, {
    ca: f.alpha.read('ca.pem'),
    method: 'PUT',
    headers: {
      Cookie: alpha.cookie,
      Origin: f.app.origin,
      'X-TAK-Storage-Scope': alpha.scope,
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Length': f.bytes.length,
    },
  });
  const stopped = new Promise((resolve) => {
    upload.on('error', () => resolve());
    upload.on('response', (res) => {
      res.resume();
      res.on('end', resolve);
    });
  });
  upload.write(f.bytes.subarray(0, 128));
  for (let n = 0; n < 100; n++) {
    const status = (await f.request(`${api}/${id}`, alpha)).json();
    if (status.state === 'uploading') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const logout = await f.request('/logout', {
    ...alpha,
    method: 'POST',
    origin: f.app.origin,
  });
  assert.equal(logout.status, 303);
  await Promise.race([
    stopped,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Revoked upload was not stopped')),
        3000,
      ).unref(),
    ),
  ]);
  const replacement = await f.login(),
    result = await f.readJob(id, replacement);
  assert.equal(result.state, 'failed');
  const list = (await f.request('/api/maps/offline/packs', replacement)).json();
  assert.deepEqual(list.packs, []);
});

test('single-operator HTTPS retains legacy cookie imports without a named-scope requirement', async (t) => {
  const f = await setup(t, false),
    session = await f.login(),
    api = '/api/maps/offline/imports';
  assert.equal(session.scope, undefined);
  const response = await f.request(api, {
    ...session,
    method: 'POST',
    origin: f.app.origin,
    body: JSON.stringify(f.input),
  });
  assert.equal(response.status, 202);
  const id = response.json().id;
  assert.equal(
    (
      await f.request(`${api}/${id}/file`, {
        ...session,
        method: 'PUT',
        origin: f.app.origin,
        body: f.bytes,
        type: 'application/vnd.sqlite3',
      })
    ).status,
    202,
  );
  const job = await f.readJob(id, session);
  assert.equal(job.state, 'ready', job.error);
});

for (const mode of ['credential rotation', 'logout', 'account switch'])
  test(`named ${mode} revokes a pinned background conversion before atomic publication`, async (t) => {
    let entered, release;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    let first = true;
    const f = await setup(t, true, {
      writeImpl: async (handle, bytes) => {
        if (first) {
          first = false;
          entered();
          await paused;
        }
        await handle.writeFile(bytes);
        await handle.sync();
      },
    });
    const alpha = await f.login(),
      api = '/api/maps/offline/imports';
    const created = await f.request(api, {
      ...alpha,
      method: 'POST',
      origin: f.app.origin,
      body: JSON.stringify(f.input),
    });
    const id = created.json().id;
    await f.request(`${api}/${id}/file`, {
      ...alpha,
      method: 'PUT',
      origin: f.app.origin,
      body: f.bytes,
      type: 'application/vnd.sqlite3',
    });
    await waiting;
    const rotated = 'synthetic-rotated-alpha-operator-token-123456789';
    try {
      if (mode === 'credential rotation') {
        f.configuration.principals[0].tokenSha256 = hash(rotated);
        await f.writeConfiguration();
        f.app.reloadPrincipals();
      } else if (mode === 'logout') {
        assert.equal(
          (
            await f.request('/logout', {
              ...alpha,
              method: 'POST',
              origin: f.app.origin,
            })
          ).status,
          303,
        );
      } else {
        const bravo = await f.login('bravo', { cookie: alpha.cookie });
        assert.equal((await f.request(`${api}/${id}`, bravo)).status, 404);
        assert.equal(
          (
            await f.request(`${api}/${id}`, {
              cookie: bravo.cookie,
              scope: alpha.scope,
            })
          ).status,
          409,
        );
      }
    } finally {
      release();
    }
    assert.equal((await f.request(`${api}/${id}`, alpha)).status, 401);
    const replacement = await f.login('alpha', {
      token: mode === 'credential rotation' ? rotated : tokens.alpha,
    });
    if (mode === 'credential rotation')
      assert.notEqual(replacement.scope, alpha.scope);
    const result = await f.readJob(id, replacement);
    assert.equal(result.state, 'failed');
    assert.deepEqual(
      (await f.request('/api/maps/offline/packs', replacement)).json().packs,
      [],
    );
    const serialized = JSON.stringify(result);
    for (const secret of [alpha.cookie, tokens.alpha, rotated])
      assert.equal(serialized.includes(secret), false);
  });
