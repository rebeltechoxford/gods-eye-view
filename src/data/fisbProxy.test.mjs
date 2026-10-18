import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import {
  FISB_ROUTE,
  createFisbHandler,
  fisbProxy,
  parseFisbFeeds,
  stationPosition,
} from '../../server/providers/fisb.js';
import { localProviderPlugins } from '../../server/providers/local.js';
import { gdl90Frame } from '../sources/fisb/gdl90.js';
import { parseRawLine } from '../sources/fisb/decode.js';

const CAPTURE = readFileSync(
  new URL('./fixtures/fisb/tg30-subset.978', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter(Boolean);

function quietLogger() {
  const lines = [];
  return { lines, warn: (l) => lines.push(l), info: (l) => lines.push(l) };
}

async function call(handler, url = '/', method = 'GET') {
  const res = {
    writeHead(status, headers) {
      Object.assign(this, { status, headers });
    },
    end(body) {
      this.body = body;
    },
  };
  await handler.handle({ url, method }, res);
  return { ...res, json: JSON.parse(res.body) };
}

async function until(check, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('FISB_FEEDS accepts local dump978 TCP and GDL 90 UDP inputs only', () => {
  const { configured, feeds } = parseFisbFeeds(
    'dump978=tcp://127.0.0.1:30978, gdl90=udp://0.0.0.0:4000,dump978=tcp://stratux.local:30978',
  );
  assert.equal(configured, true);
  assert.deepEqual(
    feeds.map(({ kind, label, host, port }) => ({ kind, label, host, port })),
    [
      {
        kind: 'dump978',
        label: 'dump978-fa raw #1',
        host: '127.0.0.1',
        port: 30978,
      },
      { kind: 'gdl90', label: 'GDL 90 UDP #2', host: '0.0.0.0', port: 4000 },
      {
        kind: 'dump978',
        label: 'dump978-fa raw #3',
        host: 'stratux.local',
        port: 30978,
      },
    ],
  );
  const reasons = Object.fromEntries(
    [
      'dump978=tcp://8.8.8.8:30978',
      'dump978=tcp://169.254.169.254:30978',
      'dump978=tcp://example.com:30978',
      'dump978=udp://127.0.0.1:30978',
      'dump978=tcp://127.0.0.1',
      'dump978=tcp://user:pw@127.0.0.1:30978',
      'dump978=tcp://0.0.0.0:30978',
      'adsb=tcp://127.0.0.1:30978',
      'nonsense',
    ].map((entry) => [entry, parseFisbFeeds(entry).feeds[0].reason]),
  );
  for (const [entry, reason] of Object.entries(reasons))
    assert.ok(reason, `${entry} is rejected`);
  assert.deepEqual(parseFisbFeeds(undefined), { configured: false, feeds: [] });
});

test('an unconfigured route answers configured:false and opens nothing', async () => {
  const handler = createFisbHandler({ feedsValue: '', logger: quietLogger() });
  const { status, json } = await call(handler);
  assert.equal(status, 200);
  assert.deepEqual(json, { configured: false, feeds: [] });
  assert.equal(handler.isRunning(), false);
  assert.equal((await call(handler, '/radar?product=63')).status, 404);
});

test('constructing the plugin reads nothing and connects nowhere', () => {
  let connects = 0;
  const plugin = fisbProxy({ connectImpl: () => connects++ });
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  assert.equal(connects, 0);
  assert.ok(localProviderPlugins().some((p) => p.name === 'fisb-proxy'));
});

test('dump978-fa raw lines over real TCP become the FIS-B picture', async (t) => {
  const server = net.createServer((socket) => {
    // Lines split across writes, with a downlink and a comment mixed in.
    const text = ['-00ff00;', '# comment', ...CAPTURE].join('\n') + '\n';
    for (let i = 0; i < text.length; i += 1000)
      socket.write(text.slice(i, i + 1000));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const handler = createFisbHandler({
    feedsValue: `dump978=tcp://127.0.0.1:${port}`,
    logger: quietLogger(),
  });
  t.after(() => {
    handler.stop();
    server.close();
  });
  assert.equal(handler.isRunning(), false);
  await call(handler); // the first request starts the input
  await until(
    async () => (await call(handler)).json.counts.uplinks === CAPTURE.length,
  );
  const { json } = await call(handler);
  assert.equal(json.configured, true);
  assert.equal(json.feeds[0].status, 'live');
  assert.equal(json.feeds[0].uplinks, CAPTURE.length);
  assert.equal(json.counts.decodeErrors, 0);
  const metars = json.texts.filter((text) => text.kind === 'METAR');
  assert.ok(metars.length > 0);
  // Most METAR stations resolve to a map position on the host.
  assert.ok(
    metars.filter((text) => text.position).length >= metars.length * 0.9,
  );
  assert.ok(json.reports.some((report) => report.overlays.length));
  assert.ok(
    !JSON.stringify(json).includes('127.0.0.1'),
    'addresses stay on the host',
  );
  const radar = await call(handler, '/radar?product=64');
  assert.equal(radar.status, 200);
  assert.equal(radar.json.productId, 64);
  assert.equal((await call(handler, '/radar?product=70')).status, 400);
  assert.equal((await call(handler, '/', 'POST')).status, 405);
});

test('a dropped dump978 connection is retried and reported', async (t) => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    if (connections === 1) socket.destroy();
    else socket.write(CAPTURE[0] + '\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const handler = createFisbHandler({
    feedsValue: `dump978=tcp://127.0.0.1:${server.address().port}`,
    logger: quietLogger(),
  });
  t.after(() => {
    handler.stop();
    server.close();
  });
  await call(handler);
  await until(async () => (await call(handler)).json.counts.uplinks === 1);
  assert.ok(connections >= 2);
});

test('GDL 90 datagrams from a local sender are decoded; corrupt frames are counted', async (t) => {
  const probe = dgram.createSocket('udp4');
  await new Promise((resolve) => probe.bind(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const handler = createFisbHandler({
    feedsValue: `gdl90=udp://127.0.0.1:${port}`,
    logger: quietLogger(),
  });
  const sender = dgram.createSocket('udp4');
  t.after(() => {
    handler.stop();
    sender.close();
  });
  await call(handler);
  await until(
    async () => (await call(handler)).json.feeds[0].status !== 'connecting',
  );
  const uplinks = CAPTURE.slice(0, 10).map((line) => parseRawLine(line).bytes);
  for (const uplink of uplinks) {
    const frame = gdl90Frame(7, Uint8Array.from([0, 0, 0, ...uplink]));
    await new Promise((resolve) =>
      sender.send(frame, port, '127.0.0.1', resolve),
    );
  }
  const corrupt = gdl90Frame(7, Uint8Array.from([0, 0, 0, ...uplinks[0]]));
  corrupt[100] ^= 0xff;
  await new Promise((resolve) =>
    sender.send(corrupt, port, '127.0.0.1', resolve),
  );
  await until(
    async () => (await call(handler)).json.counts.uplinks === uplinks.length,
  );
  const { json } = await call(handler);
  assert.equal(json.feeds[0].status, 'live');
  assert.equal(json.feeds[0].uplinks, uplinks.length);
  assert.equal(json.feeds[0].rejected, 1);
  assert.equal(json.feeds[0].dropped, 0);
});

test('inputs close after the idle time with no requests', async (t) => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const handler = createFisbHandler({
    feedsValue: `dump978=tcp://127.0.0.1:${server.address().port}`,
    logger: quietLogger(),
    idleMs: 50,
  });
  t.after(() => {
    handler.stop();
    server.close();
  });
  await call(handler);
  assert.equal(handler.isRunning(), true);
  await until(() => !handler.isRunning());
  assert.equal(FISB_ROUTE, '/api/fisb');
});

test('station identifiers resolve through the bundled US airport table', () => {
  const [lon, lat] = stationPosition('KUOX');
  assert.ok(Math.abs(lon - -89.5368) < 0.01 && Math.abs(lat - 34.3843) < 0.01);
  assert.deepEqual(stationPosition('TUL'), stationPosition('KTUL'));
  assert.ok(stationPosition('PANC'), 'Alaska');
  assert.equal(stationPosition('ZZZZ'), null);
  assert.equal(stationPosition(null), null);
});
