import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import {
  startTakHttpsServer,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  HTTPS_BROWSER_CSP,
} from '../../server/standalone/tak-https.mjs';
import { BROWSER_CSP } from '../../build/vite.js';
import { createTakTlsFixtures } from './takTlsFixtures.mjs';
import { IDENTITY } from '../tak/protocol/fixtures.mjs';

let fixtures;
let directory;
const token = 'synthetic-https-operator-token-0123456789';
before(() => {
  fixtures = createTakTlsFixtures();
  directory = mkdtempSync(path.join(tmpdir(), 'gev-tak-dist-'));
  mkdirSync(path.join(directory, 'assets'));
  mkdirSync(path.join(directory, 'fonts/licenses'), { recursive: true });
  mkdirSync(path.join(directory, 'private'));
  writeFileSync(path.join(directory, 'fonts/synthetic.woff2'), 'wOF2SYNTHETIC');
  writeFileSync(
    path.join(directory, 'private/synthetic.woff2'),
    'DO NOT SERVE',
  );
  writeFileSync(
    path.join(directory, 'fonts/gev-fonts.css'),
    '@font-face{font-family:Synthetic;src:url(./synthetic.woff2)}',
  );
  writeFileSync(
    path.join(directory, 'fonts/licenses/synthetic.txt'),
    'Synthetic license fixture.',
  );
  writeFileSync(
    path.join(directory, 'index.html'),
    '<!doctype html><title>Synthetic private console</title>',
  );
  writeFileSync(
    path.join(directory, 'assets/app.js'),
    'globalThis.synthetic=true;',
  );
  writeFileSync(path.join(directory, 'assets/app.js.map'), 'DO NOT SERVE');
  writeFileSync(
    path.join(directory, 'assets/synthetic.geojsonl'),
    '{"type":"Feature","properties":{"synthetic":true},"geometry":{"type":"Point","coordinates":[-89,34]}}\n',
  );
  writeFileSync(path.join(directory, '.env'), 'DO NOT SERVE');
  writeFileSync(
    path.join(directory, 'manifest.webmanifest'),
    '{"name":"Synthetic private console"}',
  );
  writeFileSync(
    path.join(directory, 'gev-sw.js'),
    'self.addEventListener("fetch",()=>{});',
  );
});
after(() => {
  fixtures?.cleanup();
  if (
    directory &&
    path.dirname(path.resolve(directory)) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith('gev-tak-dist-')
  )
    rmSync(directory, { recursive: true, force: true });
});

async function app(t, options = {}) {
  const instance = await startTakHttpsServer({
    env: {
      TAK_GATEWAY_TOKEN: token,
      TAK_HTTPS_CERT: fixtures.file('server.pem'),
      TAK_HTTPS_KEY: fixtures.file('server.key'),
    },
    distRoot: directory,
    port: 0,
    providerPlugins: [
      {
        name: 'existing-provider',
        configurePreviewServer({ middlewares }) {
          middlewares.use('/api/existing', (_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.end('{"preserved":true}');
          });
        },
      },
    ],
    ...options,
  });
  t.after(instance.close);
  return instance;
}
function request(
  instance,
  pathname = '/',
  {
    method = 'GET',
    cookie,
    origin,
    body,
    headers = {},
    ca = fixtures.read('ca.pem'),
  } = {},
) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      instance.origin + pathname,
      {
        method,
        ca,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(origin ? { Origin: origin } : {}),
          ...(body !== undefined
            ? {
                'Content-Type': 'application/x-www-form-urlencoded',
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
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
async function login(instance) {
  const response = await request(instance, '/login', {
    method: 'POST',
    origin: instance.origin,
    body: new URLSearchParams({ token }).toString(),
  });
  assert.equal(response.status, 303);
  assert.match(
    response.headers['set-cookie'][0],
    /HttpOnly; Secure; SameSite=Strict/,
  );
  assert.ok(!response.body.includes(token));
  return response.headers['set-cookie'][0].split(';')[0];
}
function websocket(instance, cookie, protocols = ['tak.v1']) {
  const ws = new WebSocket(
    instance.origin.replace('https:', 'wss:') + '/api/tak/ws',
    protocols,
    {
      ca: fixtures.read('ca.pem'),
      origin: instance.origin,
      headers: cookie ? { Cookie: cookie } : {},
    },
  );
  ws.on('error', () => {});
  return ws;
}

test('production browser policy preserves GEV CSP and guarded provider APIs/static/PWA assets', async (t) => {
  assert.equal(HTTPS_BROWSER_CSP, BROWSER_CSP);
  const instance = await app(t);
  assert.equal((await request(instance)).headers.location, '/login');
  assert.equal((await request(instance, '/api/existing')).status, 401);
  assert.equal(
    (await request(instance, '/assets/synthetic.geojsonl')).headers.location,
    '/login',
  );
  const loginPage = await request(instance, '/login');
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers['referrer-policy'], 'same-origin');
  assert.ok(!loginPage.body.includes(token));
  const cookie = await login(instance);
  const dataset = await request(instance, '/assets/synthetic.geojsonl', {
    cookie,
  });
  assert.equal(dataset.status, 200);
  assert.equal(
    dataset.headers['content-type'],
    'application/x-ndjson; charset=utf-8',
  );
  assert.equal(JSON.parse(dataset.body.trim()).properties.synthetic, true);
  assert.equal((await request(instance, '/', { cookie })).status, 200);
  assert.equal(
    JSON.parse((await request(instance, '/api/existing', { cookie })).body)
      .preserved,
    true,
  );
  const status = JSON.parse(
    (await request(instance, '/api/tak/status', { cookie })).body,
  );
  assert.equal(status.sessionAuthenticated, true);
  assert.equal(status.bootstrapAllowed, false);
  assert.ok(!('token' in status));
  assert.equal(
    (await request(instance, '/manifest.webmanifest', { cookie })).headers[
      'content-type'
    ],
    'application/manifest+json',
  );
  assert.match(
    (await request(instance, '/gev-sw.js', { cookie })).headers['content-type'],
    /^application\/javascript/,
  );
  const asset = await request(instance, '/assets/app.js', {
    cookie,
    method: 'HEAD',
  });
  assert.equal(asset.status, 200);
  assert.equal(asset.body, '');
  assert.equal(asset.headers['referrer-policy'], 'no-referrer');
  assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  assert.match(asset.headers['strict-transport-security'], /max-age/);
  const range = await request(instance, '/assets/app.js', {
    cookie,
    headers: { Range: 'bytes=0-5' },
  });
  assert.equal(range.status, 206);
  assert.equal(range.body, 'global');
});

test('private static font assets and notices remain behind login with their correct MIME types', async (t) => {
  const instance = await app(t);
  const files = [
    ['/fonts/synthetic.woff2', 'font/woff2', 'wOF2SYNTHETIC'],
    [
      '/fonts/gev-fonts.css',
      'text/css; charset=utf-8',
      '@font-face{font-family:Synthetic;src:url(./synthetic.woff2)}',
    ],
    [
      '/fonts/licenses/synthetic.txt',
      'text/plain; charset=utf-8',
      'Synthetic license fixture.',
    ],
  ];
  for (const [url] of files) {
    const denied = await request(instance, url);
    assert.equal(denied.status, 303);
    assert.equal(denied.headers.location, '/login');
    assert.equal(denied.headers['cache-control'], 'no-store');
  }
  assert.equal((await request(instance, '/api/tak/status')).status, 401);
  const cookie = await login(instance);
  for (const [url, mime, body] of files) {
    const served = await request(instance, url, { cookie });
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], mime);
    assert.equal(served.headers['cache-control'], 'no-store');
    assert.equal(served.body, body);
  }
  assert.equal(
    (await request(instance, '/private/synthetic.woff2', { cookie })).status,
    404,
  );
});

test('HTTPS login rejects wrong token, origin/proxy/CORS/body overflow and never remotely bootstraps a token', async (t) => {
  const instance = await app(t);
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        origin: instance.origin,
        body: 'token=wrong',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        body: `token=${token}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        origin: 'null',
        body: `token=${token}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        origin: 'https://evil.example',
        body: `token=${token}`,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(instance, '/login', {
        headers: { 'X-Forwarded-For': '127.0.0.1' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'OPTIONS',
        origin: instance.origin,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(instance, '/login', {
        method: 'POST',
        origin: instance.origin,
        body: 'x'.repeat(2049),
      })
    ).status,
    413,
  );
  const cookie = await login(instance);
  const response = await request(instance, '/api/tak/session', {
    method: 'POST',
    cookie,
    origin: instance.origin,
    headers: { 'X-TAK-Session': '1' },
  });
  assert.equal(response.status, 403);
  assert.ok(!response.body.includes(token));
  await assert.rejects(
    request(instance, '/login', { ca: fixtures.read('other-ca.pem') }),
  );
});

test('static allowlist rejects traversal, source maps, setup/MCP and files outside the build', async (t) => {
  const privateDirectory = path.join(fixtures.directory, 'private-assets');
  mkdirSync(privateDirectory);
  writeFileSync(path.join(privateDirectory, 'secret.js'), 'DO NOT SERVE');
  const link = path.join(directory, 'assets/linked-directory');
  symlinkSync(
    privateDirectory,
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const instance = await app(t);
  const cookie = await login(instance);
  for (const pathname of [
    '/.env',
    '/assets/app.js.map',
    '/server/providers/tak/config.js',
    '/src/tak/client.js',
    '/api/setup/status',
    '/mcp',
    '/assets/%2e%2e/%2eenv',
    '/assets/%252e%252e/.env',
    '/assets/%5c.env',
    '/assets/linked-directory/secret.js',
  ])
    assert.equal(
      (await request(instance, pathname, { cookie })).status,
      404,
      pathname,
    );
  assert.equal(
    (
      await request(instance, '/assets/app.js', {
        cookie,
        method: 'POST',
        origin: instance.origin,
      })
    ).status,
    405,
  );
});

test('authenticated WSS cookie needs no token echo and logout immediately revokes the open connection', async (t) => {
  const instance = await app(t);
  const cookie = await login(instance);
  const unauthenticated = websocket(instance);
  const [, denied] = await once(unauthenticated, 'unexpected-response');
  assert.equal(denied.statusCode, 403);
  denied.resume();
  const ws = websocket(instance, cookie);
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  ws.send(
    JSON.stringify({
      op: 'identity',
      uid: IDENTITY.uid,
      callsign: IDENTITY.callsign,
    }),
  );
  const deadline = Date.now() + 2000;
  while (!messages.some((message) => message.op === 'identity')) {
    if (Date.now() > deadline)
      throw new Error('Missing identity acknowledgment');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const closing = once(ws, 'close');
  assert.equal(
    (
      await request(instance, '/logout', {
        method: 'POST',
        cookie,
        origin: instance.origin,
      })
    ).status,
    303,
  );
  assert.equal((await closing)[0], 1008);
  assert.equal(
    (await request(instance, '/api/existing', { cookie })).status,
    401,
  );
  assert.ok(
    messages.every((message) => !JSON.stringify(message).includes(token)),
  );
});

test('expired sessions fail HTTP and existing WSS revalidation', async (t) => {
  let now = Date.now();
  const instance = await app(t, { now: () => now });
  const cookie = await login(instance);
  const ws = websocket(instance, cookie);
  await once(ws, 'open');
  now += SESSION_TTL_MS + 1;
  const closing = once(ws, 'close');
  ws.send('{"op":"status"}');
  assert.equal((await closing)[0], 1008);
  assert.equal(
    (await request(instance, '/api/existing', { cookie })).status,
    401,
  );
});

test('an offered raw token cannot bypass private WSS cookie logout or expiry', async (t) => {
  for (const action of ['logout', 'expiry']) {
    let now = Date.now();
    const instance = await app(t, { now: () => now });
    const cookie = await login(instance);
    const rawOnly = websocket(instance, undefined, [
      'tak.v1',
      `tak.token.${token}`,
    ]);
    const [, denied] = await once(rawOnly, 'unexpected-response');
    assert.equal(denied.statusCode, 403);
    denied.resume();
    const ws = websocket(instance, cookie, ['tak.v1', `tak.token.${token}`]);
    const acknowledged = new Promise((resolve) =>
      ws.on('message', (message) => {
        if (JSON.parse(message.toString()).op === 'identity') resolve();
      }),
    );
    await once(ws, 'open');
    ws.send(
      JSON.stringify({
        op: 'identity',
        uid: IDENTITY.uid,
        callsign: IDENTITY.callsign,
      }),
    );
    await acknowledged;
    assert.equal(ws.protocol, 'tak.v1');
    const closing = once(ws, 'close');
    if (action === 'logout')
      await request(instance, '/logout', {
        method: 'POST',
        cookie,
        origin: instance.origin,
      });
    else {
      now += SESSION_TTL_MS + 1;
      instance.gateway.recheckSessions();
    }
    assert.equal((await closing)[0], 1008, action);
  }
});

test('production startup fails closed for missing/expired/wrong-host certs and wildcard/public binding', async () => {
  const base = {
    TAK_GATEWAY_TOKEN: token,
    TAK_HTTPS_CERT: fixtures.file('server.pem'),
    TAK_HTTPS_KEY: fixtures.file('server.key'),
  };
  for (const env of [
    { ...base, TAK_HTTPS_CERT: '' },
    { ...base, TAK_GATEWAY_TOKEN: '' },
    { ...base, TAK_HTTPS_HOST: '0.0.0.0' },
    { ...base, TAK_HTTPS_HOST: '8.8.8.8' },
    { ...base, TAK_HTTPS_HOST: '192.168.1.2' },
    { ...base, TAK_HTTPS_CERT: fixtures.file('expired.pem') },
    { ...base, TAK_HTTPS_CERT: fixtures.file('wrong-host.pem') },
  ])
    await assert.rejects(
      startTakHttpsServer({
        env,
        distRoot: directory,
        providerPlugins: [],
        port: 0,
      }),
    );
});

test('login attempts and concurrent authenticated sessions are bounded', async (t) => {
  let now = Date.now();
  const limited = await app(t, { now: () => now });
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await request(limited, '/login', {
          method: 'POST',
          origin: limited.origin,
          body: 'token=wrong',
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await request(limited, '/login', {
        method: 'POST',
        origin: limited.origin,
        body: `token=${token}`,
      })
    ).status,
    429,
  );
  now += 60_001;
  await login(limited);
  const capped = await app(t, { now: () => now });
  for (let i = 0; i < 32; i++) {
    await login(capped);
    now += 12_001;
  }
  assert.equal(
    (
      await request(capped, '/login', {
        method: 'POST',
        origin: capped.origin,
        body: `token=${token}`,
      })
    ).status,
    503,
  );
});

test('production adapter uses preview hooks in order, excludes setup/duplicate gateway, and closes partially installed providers', async (t) => {
  const order = [];
  const instance = await app(t, {
    providerPlugins: [
      {
        name: 'first',
        configureServer() {
          throw new Error('Development hook must never run');
        },
        configurePreviewServer() {
          order.push('first');
          return () => order.push('after');
        },
        closeBundle() {
          order.push('close-first');
        },
      },
      {
        name: 'tak-gateway',
        configurePreviewServer() {
          throw new Error('Duplicate gateway must never run');
        },
      },
      {
        name: 'gev-key-setup',
        configurePreviewServer() {
          throw new Error('Settings endpoint must never mount');
        },
      },
      {
        name: 'second',
        configurePreviewServer() {
          order.push('second');
        },
      },
    ],
  });
  assert.deepEqual(order, ['first', 'second', 'after']);
  await instance.close();
  assert.deepEqual(order, ['first', 'second', 'after', 'close-first']);
  let closed = 0;
  await assert.rejects(
    app(t, {
      providerPlugins: [
        {
          name: 'broken',
          configurePreviewServer() {
            throw new Error('Synthetic install failure');
          },
          closeBundle() {
            closed++;
          },
        },
      ],
    }),
    /Synthetic install failure/,
  );
  assert.equal(closed, 1);
});
