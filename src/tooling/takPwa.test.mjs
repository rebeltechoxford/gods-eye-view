import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const worker = readFileSync(
  new URL('../../public/gev-sw.js', import.meta.url),
  'utf8',
);
function run(fetchImpl) {
  let handle;
  vm.runInNewContext(worker, {
    self: {
      location: { origin: 'https://gev.internal.test' },
      addEventListener: (_name, fn) => {
        handle = fn;
      },
    },
    URL,
    Response,
    fetch: fetchImpl,
    get caches() {
      throw new Error('Worker must never access persistent response storage');
    },
    get indexedDB() {
      throw new Error('Worker must never access mission storage');
    },
  });
  return (request) => {
    let response;
    handle({
      request,
      respondWith(value) {
        response = value;
      },
    });
    return response;
  };
}
test('PWA shell leaves private/API/assets requests untouched and never persists an online response', async () => {
  let requests = 0;
  const secretResponse = new Response('SYNTHETIC PRIVATE RESPONSE');
  const handle = run(async () => {
    requests++;
    return secretResponse;
  });
  for (const [url, mode, method] of [
    ['/api/tak/status', 'cors', 'GET'],
    ['/api/tak/session', 'cors', 'POST'],
    ['/api/tak/ws', 'websocket', 'GET'],
    ['/assets/app.js', 'cors', 'GET'],
    ['/private.cot', 'navigate', 'GET'],
    ['/?token=secret', 'navigate', 'GET'],
    ['https://other.example/', 'navigate', 'GET'],
  ])
    assert.equal(
      handle({
        url: new URL(url, 'https://gev.internal.test').href,
        mode,
        method,
      }),
      undefined,
    );
  assert.equal(requests, 0);
  assert.equal(
    await handle({
      url: 'https://gev.internal.test/',
      mode: 'navigate',
      method: 'GET',
    }),
    secretResponse,
  );
  assert.equal(requests, 1);
});
test('offline startup produces only a fixed reconnect screen with no request/credential reflection', async () => {
  const handle = run(async () => {
    throw new Error('network unavailable at PRIVATE SECRET');
  });
  const response = await handle({
    url: 'https://gev.internal.test/index.html',
    mode: 'navigate',
    method: 'GET',
    headers: { Authorization: 'secret' },
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const html = await response.text();
  assert.match(html, /approved private network/);
  assert.equal(html.includes('PRIVATE SECRET'), false);
  assert.equal(html.includes('Authorization'), false);
});
test('manifest contains clean same-origin launch and generated icons from the existing repo logo', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../../public/manifest.webmanifest', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 2);
  for (const icon of manifest.icons) {
    const image = readFileSync(
      new URL(`../../public${icon.src}`, import.meta.url),
    );
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(image.readUInt32BE(16), size);
    assert.equal(image.readUInt32BE(20), size);
  }
});
