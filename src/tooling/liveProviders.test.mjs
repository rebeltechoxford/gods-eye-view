import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import * as providers from '../../server/providers/live.js';
import * as portable from '../../src/data/adsbLolFallback.js';

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET') => {
    assert.ok(routes.has(route), `registered route: ${route}`);
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) {
        this.headers[key.toLowerCase()] = value;
      },
      writeHead(status, headers = {}) {
        this.statusCode = status;
        for (const [key, value] of Object.entries(headers))
          this.setHeader(key, value);
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get(route)({ url, method }, response);
    return response;
  };
}

function environment(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
  }
}

test('live entry resolves in Node and aircraft normalization stays independently portable', async () => {
  const entry = await import('gods-eye-view/server/providers/live');
  assert.equal(entry.openSkyProxy, providers.openSkyProxy);
  assert.equal(entry.aisLiveProxy, providers.aisLiveProxy);
  const normalizer = await import('gods-eye-view/sources/adsb-lol');
  assert.equal(
    normalizer.normalizeAdsbLolAircraftState,
    portable.normalizeAdsbLolAircraftState,
  );
});

test('OpenSky state and track routes share tokens, retain cache and use regional fallback', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: 'fixture-client',
    OPENSKY_CLIENT_SECRET: 'fixture-secret',
    OPENSKY_AUTH_MODE: 'oauth',
    OPENSKY_USERNAME: undefined,
    OPENSKY_PASSWORD: undefined,
  });
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'log', () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/token'))
      return Response.json({ access_token: 'fixture-token', expires_in: 1800 });
    if (url.includes('/states/')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      return Response.json({ time: Math.floor(now / 1000), states: [] });
    }
    if (url.includes('/tracks/')) {
      assert.equal(options.headers.Authorization, 'Bearer fixture-token');
      return Response.json({ path: [] });
    }
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  const states = install(providers.openSkyProxy());
  assert.equal(
    (await states('/api/flights', '?lat=30&lon=-97')).statusCode,
    200,
  );
  assert.equal(
    (await states('/api/flights', '?lat=30&lon=-97')).headers[
      'x-opensky-cache'
    ],
    'HIT',
  );
  assert.equal(calls.length, 2);
  const tracks = install(providers.trackBackfillProxies(), true);
  assert.equal(
    (await tracks('/api/flights/track', '?icao24=ABC123')).statusCode,
    200,
  );
  await tracks('/api/flights/track', '?icao24=abc123');
  assert.equal(calls.filter((call) => call.url.includes('/token')).length, 1);
  assert.equal(calls.filter((call) => call.url.includes('/tracks/')).length, 1);
  assert.equal(
    (await tracks('/api/military/track', '?hex=invalid')).statusCode,
    400,
  );
  now += 130_000;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/states/')) return new Response('', { status: 503 });
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  // A fresh request without a usable cached worldwide frame should use the regional feed.
  const fresh = await import(
    `../../server/providers/aircraft/opensky.js?fallback=${now}`
  );
  process.env.OPENSKY_AUTH_MODE = 'anon';
  const fallback = await install(fresh.openSkyProxy())(
    '/api/flights',
    '?lat=30&lon=-97',
  );
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.headers['x-flight-source'], 'adsb.lol');
  assert.equal(JSON.parse(fallback.body).states[0][0], 'abc123');
});

test('OpenSky global snapshot attempts are time-limited, retried once, then fall back', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_USERNAME: undefined,
    OPENSKY_PASSWORD: undefined,
  });
  t.mock.method(console, 'warn', () => {});
  const timedOut = () =>
    Promise.reject(
      new DOMException(
        'The operation was aborted due to timeout',
        'TimeoutError',
      ),
    );
  const load = async (respond) => {
    const attempts = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url.includes('/states/')) {
        assert.ok(options.signal instanceof AbortSignal);
        attempts.push(url);
        return respond(attempts.length);
      }
      if (url.includes('/lat/'))
        return Response.json({
          now: Date.now() / 1000,
          ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
        });
      throw Error(`Unexpected URL: ${url}`);
    });
    const fresh = await import(
      `../../server/providers/aircraft/opensky.js?timeout=${Math.random()}`
    );
    const response = await install(fresh.openSkyProxy())(
      '/api/flights',
      '?lat=30&lon=-97',
    );
    return { response, attempts };
  };
  const recovered = await load((attempt) =>
    attempt === 1
      ? timedOut()
      : Response.json({ time: Math.floor(Date.now() / 1000), states: [] }),
  );
  assert.equal(recovered.attempts.length, 2);
  assert.equal(recovered.response.statusCode, 200);
  assert.equal(recovered.response.headers['x-flight-source'], undefined);
  const stalled = await load(() => timedOut());
  assert.equal(stalled.attempts.length, 2);
  assert.equal(stalled.response.statusCode, 200);
  assert.equal(stalled.response.headers['x-flight-source'], 'adsb.lol');
});

test('military aircraft route preserves fresh cache and stale response after upstream failure', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls > 1) throw Error('offline');
    return Response.json({ ac: [{ hex: 'abc123' }] });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/military');
  assert.equal((await request('/api/military')).body, first.body);
  assert.equal(calls, 1);
  now += 13_000;
  assert.equal((await request('/api/military')).body, first.body);
  assert.equal(calls, 2);
});

test('AIS preview route ingests through the socket, returns tracks and disposes before restart', async (t) => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => upstream.close(resolve));
  });
  environment(t, {
    AISSTREAM_API_KEY: 'fixture-key',
    AISSTREAM_URL: `ws://127.0.0.1:${upstream.address().port}`,
    AISSTREAM_BOUNDING_BOXES: undefined,
    AISSTREAM_MESSAGE_TYPES: undefined,
    AISSTREAM_SILENCE_TIMEOUT_MS: '0',
  });
  upstream.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      assert.equal(JSON.parse(raw).APIKey, 'fixture-key');
      for (const [lat, epoch] of [
        [30, Math.floor(Date.now() / 1000) - 120],
        [30.01, Math.floor(Date.now() / 1000) - 60],
      ]) {
        socket.send(
          JSON.stringify({
            MessageType: 'PositionReport',
            MetaData: {
              MMSI: 123456789,
              latitude: lat,
              longitude: -97,
              time_utc: new Date(epoch * 1000).toISOString(),
            },
            Message: {
              PositionReport: {
                UserID: 123456789,
                Sog: 10,
                Cog: 90,
                TrueHeading: 511,
              },
            },
          }),
        );
      }
    });
  });
  const plugin = providers.aisLiveProxy();
  t.after(() => plugin.closeBundle());
  const request = install(plugin, true);
  let res;
  for (let i = 0; i < 100; i++) {
    res = await request('/api/vessels');
    if (JSON.parse(res.body).rows.length) break;
    await delay(10);
  }
  const data = JSON.parse(res.body);
  assert.equal(data.status, 'live');
  assert.equal(data.rows[0].mmsi, '123456789');
  assert.equal(data.rows[0].heading, null);
  const history = await request('/api/vessels', '/track?mmsi=123456789');
  assert.equal(JSON.parse(history.body).samples.length, 2);
  assert.equal(
    (await request('/api/vessels', '/track?mmsi=bad')).statusCode,
    400,
  );
  assert.equal(sockets.length, 1);
  plugin.closeBundle();
  for (let i = 0; i < 100 && sockets[0].readyState !== 3; i++) await delay(10);
  assert.equal(sockets[0].readyState, 3);
  const restarted = install(plugin);
  await restarted('/api/vessels');
  for (let i = 0; i < 100 && sockets.length < 2; i++) await delay(10);
  assert.equal(sockets.length, 2);
});

test('military aircraft route serves stale cache on an upstream 429 and cools down for Retry-After', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    if (calls === 1) return Response.json({ ac: [{ hex: 'abc123' }] });
    return new Response(JSON.stringify({ error: 'rate limited' }), {
      status: 429,
      headers: { 'Retry-After': '20' },
    });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/military');
  assert.equal(first.statusCode, 200);
  now += 13_000;
  const limited = await request('/api/military');
  assert.equal(calls, 2);
  assert.equal(
    limited.statusCode,
    200,
    'a 429 with a cached body is never relayed',
  );
  assert.equal(limited.body, first.body);
  assert.equal(limited.headers['x-feed-cache'], 'STALE');
  assert.equal(limited.headers['x-ads-b-upstream-status'], '429');
  assert.equal(limited.headers['x-feed-age-ms'], '13000');
  now += 5_000;
  const cooling = await request('/api/military');
  assert.equal(calls, 2, 'no upstream call inside the Retry-After window');
  assert.equal(cooling.headers['x-feed-cache'], 'STALE');
  assert.equal(cooling.headers['x-feed-age-ms'], '18000');
  now += 16_000;
  await request('/api/military');
  assert.equal(calls, 3, 'upstream is retried once Retry-After elapses');
});

test('military aircraft route relays an upstream 429 when nothing is cached', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('{"error":"rate limited"}', { status: 429 });
  });
  const request = install(providers.adsbLolProxy());
  const limited = await request('/api/military');
  assert.equal(limited.statusCode, 429);
  assert.ok(limited.headers['retry-after']);
  const again = await request('/api/military');
  assert.equal(again.statusCode, 429);
  assert.equal(
    calls,
    1,
    'the cooldown still protects upstream with nothing cached',
  );
  assert.ok(
    again.headers['retry-after'],
    'a cooling-down miss carries Retry-After',
  );
});

test('military fallback cancels a stalled 5xx body and starts cooldown at receipt', async (t) => {
  let now = 1_800_000_000_000;
  let calls = 0;
  let cancelled = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    if (++calls === 1) return Response.json({ ac: [] });
    now += 10000;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      {
        status: 503,
        headers: { 'Retry-After': new Date(now + 20000).toUTCString() },
      },
    );
  });
  const request = install(providers.adsbLolProxy());
  await request('/api/military');
  now += 1000;
  const hit = await request('/api/military');
  assert.equal(hit.headers['x-feed-age-ms'], '1000');
  now += 12000;
  const fallback = await request('/api/military');
  assert.equal(fallback.statusCode, 200);
  assert.equal(cancelled, true);
  assert.equal(fallback.headers['x-feed-age-ms'], '23000');
  assert.equal(fallback.headers['x-ads-b-retry-after-seconds'], '20');
  now += 19000;
  await request('/api/military');
  assert.equal(calls, 2);
  now += 2000;
  await request('/api/military');
  assert.equal(calls, 3);
});

test('military cooldown bounds untrusted Retry-After and defaults server errors', async (t) => {
  t.mock.method(console, 'warn', () => {});
  for (const [status, raw, seconds] of [
    [429, '1', 5],
    [429, '99999', 120],
    [503, 'invalid', 15],
  ]) {
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('{}', {
          status,
          headers: { 'Retry-After': raw },
        }),
    );
    const result = await install(providers.adsbLolProxy())('/api/military');
    assert.equal(Number(result.headers['retry-after']), seconds);
  }
});

test('track backfill proxy returns 502 on an oversized upstream body and caches it as an error', async (t) => {
  const tracks = install(providers.trackBackfillProxies(), true);
  let callCount = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      body: (async function* () {
        yield Buffer.alloc(6 * 1024 * 1024, 'x');
      })(),
    };
  });

  const res1 = await tracks('/api/flights/track', '?icao24=def456');
  assert.equal(res1.statusCode, 502);
  assert.deepEqual(JSON.parse(res1.body), {
    error: 'Upstream track response too large',
  });

  // Cached as a 502 (never a 200): a retry inside the window neither
  // reads as an empty track nor spends OpenSky credits on another download.
  const res2 = await tracks('/api/flights/track', '?icao24=def456');
  assert.equal(res2.statusCode, 502);
  assert.equal(callCount, 1);
});

test('military aircraft fetch is time-limited and stale cache has an age limit', async (t) => {
  let now = Date.now();
  let calls = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal, 'upstream has a deadline');
    if (++calls > 1) throw Error('offline');
    return Response.json({ ac: [{ hex: 'abc123' }] });
  });
  const request = install(providers.adsbLolProxy());
  const first = await request('/api/military');
  // Within ten minutes the last-good body is served as STALE...
  now += 9 * 60_000;
  const stale = await request('/api/military');
  assert.equal(stale.headers['x-feed-cache'], 'STALE');
  assert.equal(stale.body, first.body);
  // ...after that the outage is reported instead of old positions.
  now += 2 * 60_000;
  const old = await request('/api/military');
  assert.equal(old.statusCode, 502);
});

test('OpenSky serves a rate-limited STALE snapshot only while it is recent', async (t) => {
  environment(t, {
    OPENSKY_CLIENT_ID: undefined,
    OPENSKY_CLIENT_SECRET: undefined,
    OPENSKY_AUTH_MODE: 'anon',
    OPENSKY_USERNAME: undefined,
    OPENSKY_PASSWORD: undefined,
  });
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let limited = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/states/'))
      return limited
        ? new Response('{}', {
            status: 429,
            headers: { 'x-rate-limit-retry-after-seconds': '60' },
          })
        : Response.json({ time: Math.floor(now / 1000), states: [] });
    if (url.includes('/lat/'))
      return Response.json({
        now: now / 1000,
        ac: [{ hex: 'abc123', lat: 30, lon: -97, alt_baro: 10000 }],
      });
    throw Error(`Unexpected URL: ${url}`);
  });
  const load = async () => {
    const fresh = await import(
      `../../server/providers/aircraft/opensky.js?stale=${Math.random()}`
    );
    return { fresh, request: install(fresh.openSkyProxy()) };
  };
  // Recent: the last-good snapshot is served as STALE through the 429.
  {
    const { request } = await load();
    limited = false;
    await request('/api/flights', '?lat=30&lon=-97');
    limited = true;
    now += 60_000;
    const response = await request('/api/flights', '?lat=30&lon=-97');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-opensky-cache'], 'STALE');
  }
  // A success without X-Rate-Limit-Remaining keeps the base TTL.
  {
    const { request } = await load();
    limited = false;
    await request('/api/flights', '?lat=30&lon=-97');
    now += 20_000;
    let fetched = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      fetched++;
      return original(...args);
    };
    await request('/api/flights', '?lat=30&lon=-97');
    globalThis.fetch = original;
    assert.equal(fetched, 1, 'refreshed after the 9 s base TTL');
  }
  // Too old: the regional fallback answers instead.
  {
    const { request, fresh } = await load();
    limited = false;
    await request('/api/flights', '?lat=30&lon=-97');
    limited = true;
    now += fresh.OPENSKY_MAX_STALE_MS + 60_000;
    const response = await request('/api/flights', '?lat=30&lon=-97');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-flight-source'], 'adsb.lol');
  }
});
