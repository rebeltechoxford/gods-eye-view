import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';
import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { isLocalIpv4, parseTapAddress } from '../../src/data/tapAddress.js';
import { createFisbStore } from '../../src/sources/fisb/store.js';
import { gdl90Uplinks } from '../../src/sources/fisb/gdl90.js';
import {
  isLocalReceiverAddress,
  resolveLocalReceiverAddresses,
} from './local-receivers.js';

/**
 * FIS-B weather from the operator's own 978 MHz UAT receiver.
 *
 * Inputs come only from the `FISB_FEEDS` environment value:
 *
 * - `dump978=tcp://host:port` reads dump978-fa's raw output port
 *   (`--raw-port 30978`): one `+<hex>;…` line per uplink.
 * - `gdl90=udp://bind-host:port` listens for GDL 90 datagrams, as broadcast
 *   by Stratux-class receivers to port 4000. Datagrams from addresses other
 *   than loopback or RFC1918 are dropped.
 *
 * Hosts follow the receiver-tap rule (loopback, RFC1918, `localhost`,
 * `*.local`); a UDP bind host may also be `0.0.0.0`. Nothing connects or
 * listens until the first request, and inputs close again after
 * {@link FISB_IDLE_MS} without a request.
 */

export const FISB_ROUTE = '/api/fisb';
export const FISB_FEEDS_ENV = 'FISB_FEEDS';
export const FISB_IDLE_MS = 10 * 60_000;
/** A feed with no uplink for this long is reported quiet. */
export const FISB_QUIET_MS = 60_000;
const MAX_FEEDS = 4;
const MAX_LINE = 4096;
const MAX_DATAGRAM = 8192;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5_000;
const LOG_PREFIX = '[fisb]';

const KIND_LABELS = Object.freeze({
  dump978: 'dump978-fa raw',
  gdl90: 'GDL 90 UDP',
});

function parseEntry(entry) {
  const separator = entry.indexOf('=');
  if (separator <= 0) return { kind: null, reason: 'expected kind=url' };
  const kind = entry.slice(0, separator).trim();
  const raw = entry.slice(separator + 1).trim();
  if (!KIND_LABELS[kind])
    return { kind: null, reason: 'kind must be dump978 or gdl90' };
  const scheme = kind === 'dump978' ? 'tcp:' : 'udp:';
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { kind, reason: 'not a valid URL' };
  }
  if (url.protocol !== scheme)
    return { kind, reason: `${kind} needs a ${scheme.slice(0, -1)}:// URL` };
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  )
    return { kind, reason: 'only scheme, host and port are allowed' };
  if (!url.port) return { kind, reason: 'a port is required' };
  if (kind === 'gdl90' && url.hostname === '0.0.0.0')
    return { kind, host: '0.0.0.0', port: Number(url.port) };
  const address = parseTapAddress(`${url.hostname}:${url.port}`);
  if (!address)
    return {
      kind,
      reason: 'host must be loopback, RFC1918, localhost or *.local',
    };
  return { kind, host: address.host, port: address.port };
}

/**
 * Parse `FISB_FEEDS` (`kind=url[,kind=url…]`). Labels name the input kind
 * only, so addresses never reach the browser.
 * @param {string|undefined} value
 */
export function parseFisbFeeds(value) {
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const feeds = entries.map((entry, index) => {
    const parsed =
      index < MAX_FEEDS
        ? parseEntry(entry)
        : { kind: null, reason: `at most ${MAX_FEEDS} feeds are read` };
    const base = parsed.kind ? KIND_LABELS[parsed.kind] : `entry ${index + 1}`;
    return {
      id: `fisb-${index + 1}`,
      kind: parsed.kind,
      label: entries.length > 1 ? `${base} #${index + 1}` : base,
      ...(parsed.reason
        ? { reason: parsed.reason }
        : { host: parsed.host, port: parsed.port }),
    };
  });
  return { configured: feeds.length > 0, feeds };
}

/** Resolve a feed host to one validated local address. */
async function resolveHost(host, lookupImpl) {
  if (isLocalIpv4(host) || host === '0.0.0.0') return host;
  const addresses = await resolveLocalReceiverAddresses(host, lookupImpl);
  const ipv4 = addresses.find((row) => row.family === 4);
  return (ipv4 ?? addresses[0]).address;
}

/**
 * Keep a TCP connection to dump978-fa's raw port, reconnecting with backoff.
 * @returns {{stop:Function, state:object}}
 */
function startRawTcp(
  feed,
  { onUplinkLine, lookupImpl, log, connectImpl = net.connect },
) {
  const state = { status: 'connecting', connectedAt: null };
  let socket = null;
  let timer = null;
  let stopped = false;
  let delay = RECONNECT_MIN_MS;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(connect, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  };

  async function connect() {
    if (stopped) return;
    let address;
    try {
      address = await resolveHost(feed.host, lookupImpl);
    } catch (error) {
      state.status = 'unreachable';
      log(feed, 'unreachable', error.code || 'UNRESOLVED');
      schedule();
      return;
    }
    if (stopped) return;
    let buffer = '';
    socket = connectImpl({ host: address, port: feed.port });
    socket.setEncoding?.('latin1');
    socket.setTimeout?.(CONNECT_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.setTimeout?.(0);
      state.status = 'connected';
      state.connectedAt = Date.now();
      delay = RECONNECT_MIN_MS;
      log(feed, 'connected');
    });
    socket.on('timeout', () => socket.destroy(new Error('connect timeout')));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length <= MAX_LINE) onUplinkLine(line);
      }
      // A line that never ends is dropped rather than buffered forever.
      if (buffer.length > MAX_LINE) buffer = '';
    });
    socket.on('error', (error) => {
      log(feed, 'unreachable', error.code || error.message);
    });
    socket.on('close', () => {
      socket = null;
      if (stopped) return;
      state.status = 'unreachable';
      schedule();
    });
  }

  connect();
  return {
    state,
    stop() {
      stopped = true;
      clearTimeout(timer);
      socket?.destroy();
      socket = null;
      state.status = 'stopped';
    },
  };
}

/** Listen for GDL 90 datagrams from local senders. */
function startGdl90Udp(
  feed,
  { onUplink, lookupImpl, log, createSocket = dgram.createSocket },
) {
  const state = { status: 'connecting', rejected: 0, dropped: 0 };
  let socket = null;
  let stopped = false;
  (async () => {
    let address;
    try {
      address = await resolveHost(feed.host, lookupImpl);
    } catch (error) {
      state.status = 'invalid';
      log(feed, 'unreachable', error.code || 'UNRESOLVED');
      return;
    }
    if (stopped) return;
    socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', (error) => {
      state.status = 'unreachable';
      log(feed, 'unreachable', error.code || error.message);
      socket?.close();
      socket = null;
    });
    socket.on('message', (message, rinfo) => {
      if (
        !isLocalReceiverAddress(rinfo.address) ||
        message.length > MAX_DATAGRAM
      ) {
        state.dropped++;
        return;
      }
      const { uplinks, rejected } = gdl90Uplinks(message);
      state.rejected += rejected;
      for (const uplink of uplinks) onUplink(uplink);
    });
    socket.bind(feed.port, address, () => {
      state.status = 'connected';
      log(feed, 'connected');
    });
  })();
  return {
    state,
    stop() {
      stopped = true;
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
      socket = null;
      state.status = 'stopped';
    },
  };
}

const AIRPORTS_URL = new URL(
  '../../src/data/local_data/us_airports/us-airports.json',
  import.meta.url,
);
let airports = null;

/**
 * Position of a FIS-B station identifier: as given, or `K` + a three-letter
 * identifier (winds aloft and PIREPs use those).
 * @returns {[number, number]|null} `[lon, lat]`
 */
export function stationPosition(station, table = loadAirports()) {
  if (typeof station !== 'string' || !table) return null;
  return (
    table[station] ??
    (station.length === 3 ? table[`K${station}`] : null) ??
    null
  );
}

function loadAirports() {
  if (airports === null) {
    try {
      airports = JSON.parse(readFileSync(AIRPORTS_URL, 'utf8'));
    } catch {
      airports = false;
    }
  }
  return airports || null;
}

/** Add map positions to text and reports that carry only a station. */
function withPositions(snapshot, lookup) {
  return {
    ...snapshot,
    texts: snapshot.texts.map((text) => ({
      ...text,
      position: lookup(text.station),
    })),
    reports: snapshot.reports.map((report) => ({
      ...report,
      position: report.overlays.length ? null : lookup(report.station),
    })),
  };
}

/**
 * Build the route handler. Exposed for tests; the plugin wraps it.
 * @param {object} [options]
 */
export function createFisbHandler({
  feedsValue = process.env[FISB_FEEDS_ENV],
  lookupImpl = dnsLookup,
  connectImpl,
  createSocket,
  now = Date.now,
  logger = console,
  idleMs = FISB_IDLE_MS,
  lookupStation = stationPosition,
} = {}) {
  const config = parseFisbFeeds(feedsValue);
  for (const feed of config.feeds)
    if (feed.reason)
      logger.warn(
        `${LOG_PREFIX} ${FISB_FEEDS_ENV} ${feed.id} (${feed.label}) rejected: ${feed.reason}. It will not be read.`,
      );
  const lastStatus = new Map();
  const log = (feed, status, code) => {
    if (lastStatus.get(feed.id) === status) return;
    lastStatus.set(feed.id, status);
    const line = `${LOG_PREFIX} ${feed.label} ${status}${code ? ` (${code})` : ''}`;
    if (status === 'connected') logger.info?.(line);
    else logger.warn(line);
  };

  const store = createFisbStore({ now });
  const perFeed = new Map();
  let running = null;
  let idleTimer = null;

  function start() {
    if (running) return;
    running = new Map();
    for (const feed of config.feeds) {
      if (feed.reason) continue;
      const counters = { uplinks: 0, lastUplinkAt: null };
      perFeed.set(feed.id, counters);
      const onUplink = (bytes) => {
        const result = store.ingestUplink(bytes, now());
        if (result) {
          counters.uplinks++;
          counters.lastUplinkAt = now();
        }
      };
      const onUplinkLine = (line) => {
        if (store.ingestRawLine(line, now())) {
          counters.uplinks++;
          counters.lastUplinkAt = now();
        }
      };
      running.set(
        feed.id,
        feed.kind === 'dump978'
          ? startRawTcp(feed, {
              onUplinkLine,
              lookupImpl,
              log,
              ...(connectImpl ? { connectImpl } : {}),
            })
          : startGdl90Udp(feed, {
              onUplink,
              lookupImpl,
              log,
              ...(createSocket ? { createSocket } : {}),
            }),
      );
    }
  }

  function stop() {
    if (!running) return;
    for (const input of running.values()) input.stop();
    running = null;
    lastStatus.clear();
  }

  function touch() {
    start();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
    idleTimer.unref?.();
  }

  function feedStatus(feed) {
    if (feed.reason)
      return {
        label: feed.label,
        kind: feed.kind,
        status: 'invalid',
        uplinks: 0,
        ageMs: null,
      };
    const input = running?.get(feed.id);
    const counters = perFeed.get(feed.id) ?? { uplinks: 0, lastUplinkAt: null };
    const ageMs =
      counters.lastUplinkAt === null
        ? null
        : Math.max(0, now() - counters.lastUplinkAt);
    let status = input?.state.status ?? 'stopped';
    if (status === 'connected')
      status = ageMs !== null && ageMs <= FISB_QUIET_MS ? 'live' : 'quiet';
    return {
      label: feed.label,
      kind: feed.kind,
      status,
      uplinks: counters.uplinks,
      ageMs,
      // GDL 90 frames that failed their CRC or were the wrong size.
      ...(feed.kind === 'gdl90'
        ? {
            rejected: input?.state.rejected ?? 0,
            dropped: input?.state.dropped ?? 0,
          }
        : {}),
    };
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(res, 405, { error: 'Method Not Allowed' });
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '');
    if (!config.configured) {
      if (path === '' || path === '/')
        return send(res, 200, { configured: false, feeds: [] });
      return send(res, 404, { error: 'Not Found' });
    }
    touch();
    if (path === '' || path === '/') {
      return send(res, 200, {
        configured: true,
        generatedAt: now(),
        feeds: config.feeds.map(feedStatus),
        ...withPositions(store.snapshot(now()), lookupStation),
      });
    }
    if (path === '/radar') {
      const product = Number(url.searchParams.get('product'));
      if (product !== 63 && product !== 64)
        return send(res, 400, { error: 'product must be 63 or 64' });
      return send(res, 200, store.radarBlocks(product, now()));
    }
    return send(res, 404, { error: 'Not Found' });
  }

  return {
    handle,
    config,
    store,
    stop() {
      clearTimeout(idleTimer);
      stop();
    },
    isRunning: () => running !== null,
  };
}

/**
 * Vite plugin mounting `GET /api/fisb` and `GET /api/fisb/radar?product=63|64`.
 * Construction reads no configuration and opens nothing.
 * @param {object} [options] Passed to {@link createFisbHandler}.
 * @returns {import('vite').Plugin}
 */
export function fisbProxy(options = {}) {
  const install = (server) => {
    const handler = createFisbHandler(options);
    server.httpServer?.once?.('close', () => handler.stop());
    server.middlewares.use(FISB_ROUTE, (req, res) => handler.handle(req, res));
  };
  return {
    name: 'fisb-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
