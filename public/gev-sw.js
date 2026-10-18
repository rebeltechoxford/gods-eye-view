// Explicit application caching only. No login/API/CoT/GPS/messages/credentials or external imagery.
const PREFIX = 'gev-offline-shell-v1-';
const STATE = 'gev-offline-shell-state-v1';
const STATE_URL = new URL('/__gev_offline_shell_state__', self.location.origin)
  .href;
const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>GEV TAK · Offline</title><style>body{background:#0a0a0f;color:#e8eaed;font:17px/1.6 system-ui;max-width:32rem;margin:12vh auto;padding:24px}a{display:inline-block;padding:12px;color:#64c4ff}</style></head><body><h1>GEV TAK · Offline</h1><p>Reconnect to your approved private network, then reopen the app.</p><p>No offline application has been saved on this device. Previous tactical positions and messages are not restored.</p><a href="/">Try again</a></body></html>`;
const EMCON_URL = new URL('/__gev_emcon_state__', self.location.origin).href;
let saving = null;
let deleting = false;
// EMCON (emissions control): null until read from Cache Storage after a
// cold start, then true or false. While true, every request is answered
// here from the saved application or refused; nothing reaches the network.
let emcon = null;
let emconLoad = null;
function loadEmcon() {
  emconLoad ||= (async () => {
    try {
      // Reading must not create the state cache as a side effect.
      const response = (await caches.has(STATE))
        ? await (await caches.open(STATE)).match(EMCON_URL)
        : null;
      const value = response ? await response.json() : null;
      if (emcon === null) emcon = value?.active === true;
    } catch {
      if (emcon === null) emcon = false;
    }
  })();
  // A message may have changed the flag since it was first read.
  return emconLoad.then(() => emcon);
}
async function storeEmcon(active) {
  emcon = active;
  const cache = await caches.open(STATE);
  if (active)
    await cache.put(
      EMCON_URL,
      new Response(JSON.stringify({ active: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  else await cache.delete(EMCON_URL);
}
async function emconResponse(request) {
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (sameOrigin && ['GET', 'HEAD'].includes(request.method)) {
    const state = await readState();
    const navigation = request.mode === 'navigate';
    const key =
      navigation && ['/', '/index.html'].includes(url.pathname)
        ? '/index.html'
        : url.pathname;
    if (state?.files?.includes(key)) {
      const cached = await (await caches.open(state.cacheName)).match(key);
      if (cached) return cached;
    }
    if (navigation)
      return new Response(OFFLINE_PAGE, {
        status: 503,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      });
  }
  return Response.error();
}
loadEmcon();
const hex = (buffer) =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
function allowedPath(value) {
  if (/^\/fonts\/licenses\/[A-Za-z0-9_.-]+\.txt$/.test(value)) return true;
  if (
    [
      '/index.html',
      '/manifest.webmanifest',
      '/favicon.svg',
      '/logo.svg',
    ].includes(value)
  )
    return true;
  return (
    /^\/(assets|cesium|events|fonts|models|pwa)\/[A-Za-z0-9_./-]+$/.test(
      value,
    ) &&
    !value.includes('..') &&
    !value.split('/').some((part) => part.startsWith('.')) &&
    /\.(?:js|css|json|geojson|geojsonl|wasm|png|jpg|jpeg|webp|svg|gif|ktx2|glb|gltf|bin|xml|woff2?)$/.test(
      value,
    )
  );
}
async function readState() {
  if (!(await caches.has(STATE))) return null;
  const response = await (await caches.open(STATE)).match(STATE_URL);
  try {
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}
async function bounded(response, limit) {
  if (
    response.status === 401 ||
    (response.status === 409 &&
      response.headers?.get('X-TAK-Account-Context') === 'mismatch')
  ) {
    const error = new Error('Operator session expired; sign in again');
    error.sessionExpired = true;
    throw error;
  }
  if (!response.ok || response.status !== 200 || !response.body)
    throw new Error(
      'Application unavailable or sign-in expired; reconnect and retry',
    );
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > limit)
        throw new Error('Application exceeds its manifest budget');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
function validate(value) {
  if (
    value?.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.revision) ||
    !Array.isArray(value.files) ||
    value.files.length < 2 ||
    value.files.length > 4096
  )
    throw new Error('Invalid offline application manifest');
  let total = 0;
  const seen = new Set();
  for (const file of value.files) {
    if (
      !allowedPath(file?.path) ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 64 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid offline application file');
    seen.add(file.path);
    total += file.bytes;
  }
  if (
    !seen.has('/index.html') ||
    total !== value.totalBytes ||
    total > 128 * 1024 * 1024
  )
    throw new Error('Offline application exceeds its storage budget');
  return value;
}
async function saveShell(port, storageScope) {
  if (saving || deleting)
    throw new Error('An offline application operation is already running');
  const abort = new AbortController();
  const operation = { abort, phase: 'copying' };
  saving = operation;
  const deadline = setTimeout(() => abort.abort(), 9 * 60 * 1000);
  let cacheName = null;
  let committed = false;
  try {
    const response = await fetch('/api/maps/offline/shell', {
      ...(storageScope
        ? { headers: { 'X-TAK-Storage-Scope': storageScope } }
        : {}),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal: abort.signal,
    });
    const manifest = validate(
      JSON.parse(
        new TextDecoder().decode(await bounded(response, 2 * 1024 * 1024)),
      ),
    );
    // Stage a new generation even for the same revision, so verifying a saved
    // application repairs eviction/corruption without damaging the prior copy.
    cacheName = `${PREFIX}${manifest.revision}-${crypto.randomUUID()}`;
    const cache = await caches.open(cacheName);
    let next = 0;
    let completed = 0;
    let bytes = 0;
    async function copy() {
      try {
        while (next < manifest.files.length) {
          abort.signal.throwIfAborted();
          const file = manifest.files[next++];
          const result = await fetch(file.path, {
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
            signal: abort.signal,
          });
          const data = await bounded(result, file.bytes);
          if (
            data.byteLength !== file.bytes ||
            hex(await crypto.subtle.digest('SHA-256', data)) !== file.sha256
          )
            throw new Error(
              'Application file integrity failed; reconnect and retry',
            );
          await cache.put(
            file.path,
            new Response(data, { headers: result.headers, status: 200 }),
          );
          completed++;
          bytes += data.byteLength;
          port.postMessage({
            progress: true,
            completed,
            total: manifest.files.length,
            bytes,
            totalBytes: manifest.totalBytes,
          });
        }
      } catch (error) {
        abort.abort();
        throw error;
      }
    }
    const copies = await Promise.allSettled([copy(), copy(), copy(), copy()]);
    const failed =
      copies.find(
        (result) =>
          result.status === 'rejected' && result.reason?.sessionExpired,
      ) || copies.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    // Accept cancellation through the last staged write. Claim the pointer
    // transition synchronously before its first await: Cache.put cannot be
    // aborted or safely rolled back once another client can read the new state.
    abort.signal.throwIfAborted();
    operation.phase = 'committing';
    const state = {
      revision: manifest.revision,
      cacheName,
      files: manifest.files.map((file) => file.path),
      totalBytes: manifest.totalBytes,
      savedAt: new Date().toISOString(),
    };
    await (
      await caches.open(STATE)
    ).put(
      STATE_URL,
      new Response(JSON.stringify(state), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    committed = true;
    for (const name of await caches.keys())
      if (name.startsWith(PREFIX) && name !== cacheName)
        await caches.delete(name);
    return state;
  } finally {
    clearTimeout(deadline);
    if (!committed && cacheName) await caches.delete(cacheName);
    if (saving === operation) saving = null;
  }
}
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('message', (event) => {
  if (event.data?.type === 'GEV_EMCON') {
    event.waitUntil(
      (async () => {
        const client = await self.clients.get(event.source?.id);
        if (
          !client ||
          client.type !== 'window' ||
          new URL(client.url).origin !== self.location.origin ||
          typeof event.data.active !== 'boolean'
        )
          return;
        await storeEmcon(event.data.active);
        event.ports?.[0]?.postMessage({ ok: true, active: emcon });
      })(),
    );
    return;
  }
  const port = event.ports?.[0];
  if (
    !port ||
    ![
      'GEV_SHELL_STATUS',
      'GEV_SHELL_SAVE',
      'GEV_SHELL_DELETE',
      'GEV_SHELL_CANCEL',
    ].includes(event.data?.type)
  )
    return;
  event.waitUntil(
    (async () => {
      try {
        const client = await self.clients.get(event.source?.id);
        if (
          !client ||
          client.type !== 'window' ||
          client.frameType !== 'top-level' ||
          new URL(client.url).origin !== self.location.origin
        )
          throw new Error('Top-level app required');
        let result;
        const scope = event.data.storageScope;
        if (
          scope !== undefined &&
          (typeof scope !== 'string' || !/^[a-f0-9]{64}$/.test(scope))
        )
          throw new Error('Invalid offline application account scope');
        if (event.data.type === 'GEV_SHELL_SAVE')
          result = await saveShell(port, scope);
        else if (event.data.type === 'GEV_SHELL_DELETE') {
          if (saving || deleting)
            throw new Error('Wait for the current application operation first');
          deleting = true;
          try {
            for (const name of await caches.keys())
              if (name === STATE || name.startsWith(PREFIX))
                await caches.delete(name);
          } finally {
            deleting = false;
          }
          result = null;
        } else if (event.data.type === 'GEV_SHELL_CANCEL') {
          if (saving?.phase === 'committing' || deleting)
            throw new Error(
              'Application storage is finishing; cancellation is no longer available',
            );
          saving?.abort.abort();
          result = null;
        } else result = await readState();
        port.postMessage({ ok: true, result });
      } catch (error) {
        port.postMessage({
          ok: false,
          sessionExpired: error.sessionExpired === true,
          error: String(error.message || 'Offline operation failed').slice(
            0,
            240,
          ),
        });
      }
    })(),
  );
});
// The saved application, network first: which requests it covers.
function shellRoute(request) {
  if (request.method !== 'GET') return null;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return null;
  const navigation =
    request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname);
  if (!navigation && !allowedPath(url.pathname)) return null;
  return { url, navigation };
}
async function shellResponse(request, { url, navigation }) {
  try {
    return await fetch(request);
  } catch (error) {
    const state = await readState();
    const key = navigation ? '/index.html' : url.pathname;
    if (state?.files?.includes(key)) {
      const cached = await (await caches.open(state.cacheName)).match(key);
      if (cached) return cached;
    }
    if (!navigation) throw error;
    return new Response(OFFLINE_PAGE, {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
}
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (emcon === true) {
    event.respondWith(emconResponse(request));
    return;
  }
  const route = shellRoute(request);
  if (emcon === null) {
    // Cold start: the stored flag is still loading. Navigations and saved-app
    // files wait for it; other requests keep their normal path, where the
    // page guard refuses them under EMCON.
    const sameOriginNavigation =
      request.mode === 'navigate' &&
      new URL(request.url).origin === self.location.origin;
    if (route || sameOriginNavigation)
      event.respondWith(
        loadEmcon().then((active) => {
          if (active) return emconResponse(request);
          return route ? shellResponse(request, route) : fetch(request);
        }),
      );
    return;
  }
  if (route) event.respondWith(shellResponse(request, route));
});
