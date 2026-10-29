import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
const worker = readFileSync(
  new URL('../../public/gev-sw.js', import.meta.url),
  'utf8',
);
const origin = 'https://gev.internal.test';
function runWithStorage(fetchImpl, storage) {
  return run(fetchImpl, undefined, {}, storage);
}
function run(
  fetchImpl,
  timers = { setTimeout, clearTimeout },
  hooks = {},
  storage = new Map(),
) {
  const handlers = new Map();
  const requests = [];
  const caches = {
    async has(name) {
      return storage.has(name);
    },
    async keys() {
      return [...storage.keys()];
    },
    async delete(name) {
      await hooks.beforeDelete?.(name);
      return storage.delete(name);
    },
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Map());
      const entries = storage.get(name);
      return {
        async match(key) {
          return entries.get(new URL(key, origin).href)?.clone();
        },
        async put(key, response) {
          await hooks.beforePut?.(name, key);
          entries.set(new URL(key, origin).href, response.clone());
        },
        async delete(key) {
          return entries.delete(new URL(key, origin).href);
        },
        async keys() {
          return [...entries.keys()].map((url) => new Request(url));
        },
      };
    },
  };
  vm.runInNewContext(worker, {
    self: {
      location: { origin },
      addEventListener: (name, fn) => handlers.set(name, fn),
      clients: {
        async get(id) {
          return id === 'approved'
            ? { type: 'window', frameType: 'top-level', url: `${origin}/` }
            : null;
        },
      },
    },
    URL,
    Response,
    TextDecoder,
    Uint8Array,
    AbortController,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    crypto: webcrypto,
    caches,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchImpl(url, options);
    },
    get indexedDB() {
      throw new Error(
        'The worker must never access tactical/map database records',
      );
    },
  });
  return {
    requests,
    storage,
    // Let a cold-started worker finish reading its stored EMCON flag.
    ready: () => new Promise((resolve) => setTimeout(resolve, 0)),
    fetch(path, mode = 'navigate', method = 'GET') {
      let response;
      handlers.get('fetch')({
        request: { url: new URL(path, origin).href, mode, method },
        respondWith(value) {
          response = value;
        },
      });
      return response;
    },
    async message(type, source = 'approved', extra = {}) {
      const replies = [];
      let completion;
      handlers.get('message')({
        data: { type, ...extra },
        source: { id: source },
        ports: [
          {
            postMessage(value) {
              replies.push(value);
            },
          },
        ],
        waitUntil(value) {
          completion = value;
        },
      });
      await completion;
      return replies.at(-1);
    },
  };
}
const hash = (value) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const files = new Map([
    ['/index.html', '<html>PUBLIC APPLICATION SHELL</html>'],
    ['/assets/app.js', '/* synthetic public app */'],
  ]);
  const manifest = {
    schemaVersion: 1,
    revision: hash('fixture revision'),
    files: [...files].map(([path, body]) => ({
      path,
      bytes: Buffer.byteLength(body),
      sha256: hash(body),
    })),
  };
  manifest.totalBytes = manifest.files.reduce(
    (sum, file) => sum + file.bytes,
    0,
  );
  return { files, manifest };
}
test('worker excludes private/API/share/external requests and persists nothing by default', async () => {
  const handle = run(async () => new Response('SYNTHETIC ONLINE RESPONSE'));
  await handle.ready();
  for (const [path, mode, method] of [
    ['/api/tak/status', 'cors', 'GET'],
    ['/api/tak/session', 'cors', 'POST'],
    ['/private.cot', 'navigate', 'GET'],
    ['/?token=secret', 'navigate', 'GET'],
    ['https://other.example/', 'navigate', 'GET'],
    ['/login', 'navigate', 'GET'],
    ['/assets/source.js.map', 'cors', 'GET'],
  ])
    assert.equal(handle.fetch(path, mode, method), undefined);
  assert.equal(handle.requests.length, 0);
  assert.equal(
    await (await handle.fetch('/')).text(),
    'SYNTHETIC ONLINE RESPONSE',
  );
  assert.equal(
    await (await handle.fetch('/assets/app.js', 'cors')).text(),
    'SYNTHETIC ONLINE RESPONSE',
  );
  assert.equal(handle.storage.size, 0);
  assert.equal((await handle.message('GEV_SHELL_STATUS')).result, null);
  assert.equal(handle.storage.size, 0);
});
test('without explicit download, offline navigation is a generic reconnect page without credential reflection', async () => {
  const handle = run(async () => {
    throw new Error('PRIVATE SECRET');
  });
  const response = await handle.fetch('/index.html');
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const html = await response.text();
  assert.match(html, /approved private network/);
  assert.doesNotMatch(html, /PRIVATE SECRET|Authorization/);
  assert.equal(handle.storage.size, 0);
});
test('explicit download verifies every static file, reopens offline and deletes only its own caches', async () => {
  const { files, manifest } = fixture();
  let offline = false;
  let expired = false;
  const handle = run(async (url, options) => {
    if (offline) throw new Error('network unavailable');
    if (expired) return new Response('Sign in', { status: 401 });
    assert.equal(options?.credentials, 'same-origin');
    assert.equal(options?.redirect, 'error');
    return new Response(
      url === '/api/maps/offline/shell'
        ? JSON.stringify(manifest)
        : files.get(url),
    );
  });
  const result = await handle.message('GEV_SHELL_SAVE');
  assert.equal(result.ok, true);
  assert.equal(result.result.totalBytes, manifest.totalBytes);
  assert.equal(handle.storage.size, 2);
  assert.equal(
    (await handle.message('GEV_SHELL_STATUS')).result.revision,
    manifest.revision,
  );
  offline = true;
  assert.equal(
    await (await handle.fetch('/')).text(),
    files.get('/index.html'),
  );
  assert.equal(
    await (await handle.fetch('/assets/app.js', 'cors')).text(),
    files.get('/assets/app.js'),
  );
  assert.equal(handle.fetch('/api/tak/status', 'cors'), undefined);
  offline = false;
  expired = true;
  // An accessible server's auth rejection never falls back to cached HTML.
  assert.equal((await handle.fetch('/')).status, 401);
  handle.storage.set('unrelated-app', new Map());
  assert.equal((await handle.message('GEV_SHELL_DELETE')).ok, true);
  assert.deepEqual([...handle.storage.keys()], ['unrelated-app']);
  offline = true;
  assert.equal((await handle.fetch('/')).status, 503);
});
test('private paths, corrupt files, oversize bodies and unapproved clients cannot commit an offline shell', async () => {
  for (const corruption of [
    'private-path',
    'wrong-hash',
    'over-size',
    'unauthorized',
  ]) {
    const { files, manifest } = fixture();
    if (corruption === 'private-path')
      manifest.files[0].path = '/api/tak/status';
    if (corruption === 'wrong-hash') manifest.files[0].sha256 = hash('other');
    const handle = run(
      async (url) =>
        new Response(
          url === '/api/maps/offline/shell'
            ? JSON.stringify(manifest)
            : `${files.get(url)}${corruption === 'over-size' ? 'extra' : ''}`,
        ),
    );
    const result = await handle.message(
      'GEV_SHELL_SAVE',
      corruption === 'unauthorized' ? 'unapproved' : 'approved',
    );
    assert.equal(result.ok, false, corruption);
    assert.equal(handle.storage.size, 0, corruption);
    if (corruption === 'unauthorized') assert.equal(handle.requests.length, 0);
  }
});
test('manifest retains clean same-origin launch and generated GEV logo icons', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../../public/manifest.webmanifest', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(manifest.start_url, '.');
  assert.equal(manifest.scope, '.');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 3);
  for (const icon of manifest.icons) {
    const image = readFileSync(
      new URL(`../../public/${icon.src}`, import.meta.url),
    );
    const dimension = Number(icon.sizes.split('x')[0]);
    assert.equal(image.readUInt32BE(16), dimension);
    assert.equal(image.readUInt32BE(20), dimension);
  }
});

test('offline application save reports rejected sessions and its own deadline releases a stalled operation', async () => {
  const expired = run(
    async () => new Response('Login required', { status: 401 }),
  );
  const rejected = await expired.message('GEV_SHELL_SAVE');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.sessionExpired, true);
  assert.equal(expired.storage.size, 0);
  const { files, manifest } = fixture();
  let deadline,
    stalled = true,
    entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const handle = run(
    async (url, { signal }) => {
      if (stalled) {
        entered();
        await new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          ),
        );
      }
      return new Response(
        url === '/api/maps/offline/shell'
          ? JSON.stringify(manifest)
          : files.get(url),
      );
    },
    {
      setTimeout(callback, duration) {
        assert.equal(duration, 9 * 60 * 1000);
        deadline = callback;
        return 1;
      },
      clearTimeout() {},
    },
  );
  const pending = handle.message('GEV_SHELL_SAVE');
  await started;
  deadline();
  assert.equal((await pending).ok, false);
  assert.equal(handle.storage.size, 0);
  stalled = false;
  assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
});

test(
  'a later file401 survives earlier worker cancellation and leaves no partial application',
  { timeout: 10_000 },
  async () => {
    const { manifest } = fixture();
    const handle = run(async (url, { signal }) => {
      if (url === '/api/maps/offline/shell')
        return new Response(JSON.stringify(manifest));
      if (url === '/index.html')
        return new Promise((resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Peer aborted', 'AbortError')),
            { once: true },
          ),
        );
      return new Response('Expired session', { status: 401 });
    });
    const result = await handle.message('GEV_SHELL_SAVE');
    assert.equal(result.ok, false);
    assert.equal(result.sessionExpired, true);
    assert.equal(handle.storage.size, 0);
  },
);

test('a failed application refresh preserves the previously committed offline generation', async () => {
  const { files, manifest } = fixture();
  let corrupt = false;
  const handle = run(
    async (url) =>
      new Response(
        url === '/api/maps/offline/shell'
          ? JSON.stringify(manifest)
          : `${files.get(url)}${corrupt ? 'corruption' : ''}`,
      ),
  );
  assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
  const first = (await handle.message('GEV_SHELL_STATUS')).result;
  corrupt = true;
  assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, false);
  const retained = (await handle.message('GEV_SHELL_STATUS')).result;
  assert.equal(retained.cacheName, first.cacheName);
  assert.equal(handle.storage.size, 2);
});

test(
  'accepted cancellation at the final staged write keeps the prior generation and removes the new stage',
  { timeout: 5000 },
  async () => {
    const { files, manifest } = fixture();
    let block = false,
      entered,
      release;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const handle = run(
      async (url) =>
        new Response(
          url === '/api/maps/offline/shell'
            ? JSON.stringify(manifest)
            : files.get(url),
        ),
      undefined,
      {
        async beforePut(name, key) {
          if (
            block &&
            name.startsWith('gev-offline-shell-v1-') &&
            key === '/assets/app.js'
          ) {
            block = false;
            entered();
            await resume;
          }
        },
      },
    );
    assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
    const prior = (await handle.message('GEV_SHELL_STATUS')).result;
    block = true;
    const pending = handle.message('GEV_SHELL_SAVE');
    await paused;
    try {
      assert.equal((await handle.message('GEV_SHELL_CANCEL')).ok, true);
    } finally {
      release();
    }
    assert.equal((await pending).ok, false);
    assert.equal(
      (await handle.message('GEV_SHELL_STATUS')).result.cacheName,
      prior.cacheName,
    );
    assert.equal(handle.storage.size, 2);
  },
);

test(
  'a deferred final pointer put owns commit and cannot falsely acknowledge cancellation',
  { timeout: 5000 },
  async () => {
    const { files, manifest } = fixture();
    let block = false,
      entered,
      release;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const handle = run(
      async (url) =>
        new Response(
          url === '/api/maps/offline/shell'
            ? JSON.stringify(manifest)
            : files.get(url),
        ),
      undefined,
      {
        async beforePut(name) {
          if (block && name === 'gev-offline-shell-state-v1') {
            block = false;
            entered();
            await resume;
          }
        },
      },
    );
    assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
    const prior = (await handle.message('GEV_SHELL_STATUS')).result;
    block = true;
    const pending = handle.message('GEV_SHELL_SAVE');
    await paused;
    try {
      const cancelled = await handle.message('GEV_SHELL_CANCEL');
      assert.equal(cancelled.ok, false);
      assert.match(cancelled.error, /storage is finishing/);
    } finally {
      release();
    }
    assert.equal((await pending).ok, true);
    assert.notEqual(
      (await handle.message('GEV_SHELL_STATUS')).result.cacheName,
      prior.cacheName,
    );
    assert.equal(handle.storage.size, 2);
  },
);

test(
  'application removal owns its storage mutation and prevents a concurrent save from losing its pointer',
  { timeout: 5000 },
  async () => {
    const { files, manifest } = fixture();
    let block = false,
      entered,
      release;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const resume = new Promise((resolve) => {
      release = resolve;
    });
    const handle = run(
      async (url) =>
        new Response(
          url === '/api/maps/offline/shell'
            ? JSON.stringify(manifest)
            : files.get(url),
        ),
      undefined,
      {
        async beforeDelete(name) {
          if (block && name === 'gev-offline-shell-state-v1') {
            block = false;
            entered();
            await resume;
          }
        },
      },
    );
    assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
    block = true;
    const pending = handle.message('GEV_SHELL_DELETE');
    await paused;
    try {
      assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, false);
      assert.equal((await handle.message('GEV_SHELL_CANCEL')).ok, false);
    } finally {
      release();
    }
    assert.equal((await pending).ok, true);
    assert.equal(handle.storage.size, 0);
    assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
  },
);

test('named offline save binds only manifest request and never persists account scope', async () => {
  const { files, manifest } = fixture(),
    scope = 'a'.repeat(64),
    handle = run(async (url) =>
      url === '/api/maps/offline/shell'
        ? new Response(JSON.stringify(manifest))
        : new Response(files.get(url)),
    );
  assert.equal(
    (
      await handle.message('GEV_SHELL_SAVE', 'approved', {
        storageScope: scope,
      })
    ).ok,
    true,
  );
  assert.equal(
    handle.requests[0].options.headers['X-TAK-Storage-Scope'],
    scope,
  );
  assert(
    handle.requests
      .slice(1)
      .every(({ options }) => !options.headers?.['X-TAK-Storage-Scope']),
  );
  for (const entries of handle.storage.values())
    for (const response of entries.values())
      assert(!(await response.clone().text()).includes(scope));
  const refused = run(async () => {
    throw new Error('must not fetch');
  });
  assert.equal(
    (
      await refused.message('GEV_SHELL_SAVE', 'approved', {
        storageScope: 'invalid',
      })
    ).ok,
    false,
  );
  assert.equal(refused.requests.length, 0);
  assert.equal(refused.storage.size, 0);
});

test('named offline manifest scope mismatch propagates session retirement without storing any files', async () => {
  const handle = run(
    async () =>
      new Response('{"code":"operator-context-changed"}', {
        status: 409,
        headers: { 'X-TAK-Account-Context': 'mismatch' },
      }),
  );
  const result = await handle.message('GEV_SHELL_SAVE', 'approved', {
    storageScope: 'a'.repeat(64),
  });
  assert.equal(result.ok, false);
  assert.equal(result.sessionExpired, true);
  assert.equal(handle.storage.size, 0);
});

test('EMCON: the saved app answers everything and nothing reaches the network', async () => {
  const { files, manifest } = fixture();
  const handle = run(async (url) => {
    if (url === '/api/maps/offline/shell')
      return new Response(JSON.stringify(manifest));
    const path = new URL(url, origin).pathname;
    if (files.has(path)) return new Response(files.get(path));
    return new Response('SYNTHETIC ONLINE RESPONSE');
  });
  await handle.ready();
  assert.equal((await handle.message('GEV_SHELL_SAVE')).ok, true);
  assert.equal(
    (await handle.message('GEV_EMCON', 'approved', { active: true })).active,
    true,
  );
  handle.requests.length = 0;
  // Navigations, with or without a query, get the saved app.
  for (const path of ['/', '/index.html', '/?lat=34&lon=-89'])
    assert.equal(
      await (await handle.fetch(path)).text(),
      '<html>PUBLIC APPLICATION SHELL</html>',
    );
  assert.equal(
    await (await handle.fetch('/assets/app.js', 'cors')).text(),
    '/* synthetic public app */',
  );
  // Everything the worker normally lets through is refused here instead.
  for (const [path, mode, method] of [
    ['/api/tak/status', 'cors', 'GET'],
    ['/api/tak/session', 'cors', 'POST'],
    ['https://tile.example.org/1/2/3.png', 'no-cors', 'GET'],
    ['/assets/missing.js', 'cors', 'GET'],
    ['/fonts/x.woff2?v=2', 'cors', 'GET'],
  ]) {
    const response = await handle.fetch(path, mode, method);
    assert.equal(response.type, 'error', path);
  }
  assert.equal((await handle.fetch('/login')).status, 503);
  assert.deepEqual(handle.requests, [], 'no request left the worker');
  // Turning EMCON off restores the normal network-first behaviour.
  assert.equal(
    (await handle.message('GEV_EMCON', 'approved', { active: false })).active,
    false,
  );
  assert.equal(handle.fetch('/api/tak/status', 'cors'), undefined);
});

test('EMCON survives a worker restart and is read before the first navigation', async () => {
  const { files, manifest } = fixture();
  const network = async (url) => {
    if (url === '/api/maps/offline/shell')
      return new Response(JSON.stringify(manifest));
    const path = new URL(url, origin).pathname;
    if (files.has(path)) return new Response(files.get(path));
    return new Response('SYNTHETIC ONLINE RESPONSE');
  };
  const first = run(network);
  await first.ready();
  assert.equal((await first.message('GEV_SHELL_SAVE')).ok, true);
  await first.message('GEV_EMCON', 'approved', { active: true });
  // A fresh worker over the same Cache Storage, as after the browser stops it.
  const restarted = runWithStorage(network, first.storage);
  // Non-shell requests can be the first event after a worker restart. They
  // must wait for the same stored decision as navigation, including writes.
  const early = [
    restarted.fetch('/api/tak/status', 'cors'),
    restarted.fetch('/api/tak/session', 'cors', 'POST'),
    restarted.fetch('https://x.example/stream', 'no-cors'),
  ];
  for (const response of early) {
    assert.ok(response, 'every cold-start fetch is held');
    assert.equal((await response).type, 'error');
  }
  const navigation = restarted.fetch('/?welcome=0');
  assert.ok(navigation, 'a cold navigation waits for the stored flag');
  assert.equal(
    await (await navigation).text(),
    '<html>PUBLIC APPLICATION SHELL</html>',
  );
  assert.deepEqual(restarted.requests, []);
  assert.equal((await restarted.message('GEV_SHELL_SAVE')).ok, false);
  assert.deepEqual(
    restarted.requests,
    [],
    'EMCON also refuses save-message fetches',
  );
  // Unapproved senders cannot switch it off.
  await restarted.message('GEV_EMCON', 'stranger', { active: false });
  assert.equal(
    (await restarted.fetch('https://x.example/', 'no-cors')).type,
    'error',
  );
});

test('EMCON off persists nothing, and leaving EMCON removes what entering stored', async () => {
  const network = async () => new Response('SYNTHETIC ONLINE RESPONSE');
  const handle = run(network);
  await handle.ready();
  // Every page load reports EMCON off; that alone must not create storage.
  assert.equal(
    (await handle.message('GEV_EMCON', 'approved', { active: false })).active,
    false,
  );
  assert.deepEqual([...handle.storage.keys()], []);
  // Entering stores the flag; leaving removes the cache it created.
  await handle.message('GEV_EMCON', 'approved', { active: true });
  assert.equal(handle.storage.size, 1);
  await handle.message('GEV_EMCON', 'approved', { active: false });
  assert.deepEqual([...handle.storage.keys()], []);
});
