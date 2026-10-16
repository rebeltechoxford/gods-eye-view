import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import {
  cotKind,
  parseCotEvent,
  serializeCotEvent,
} from '../../../src/tak/protocol/cot.js';
import { createCotStreamFramer } from '../../../src/tak/protocol/stream.js';

export const SERVER_QUEUE_LIMIT = 256;
export const SERVER_QUEUE_BYTES_LIMIT = 1024 * 1024;
export const SERVER_WRITE_BUFFER_BYTES_LIMIT = 256 * 1024;
export const SERVER_QUEUE_MAX_AGE_MS = 30_000;
export const SERVER_BACKOFF_MS = Object.freeze({ min: 1_000, max: 30_000 });
export const SERVER_IDLE_TIMEOUT_MS = 120_000;
export const TAK_STREAM_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Public TAK streaming XML wire format: a declaration for every event, no trailing separator. */
export function encodeTakStreamEvent(event) {
  return TAK_STREAM_DECLARATION + serializeCotEvent(event);
}

export function loadTlsOptions(config, readFile = readFileSync) {
  const t = config.tls;
  const options = {
    servername: net.isIP(config.host) ? undefined : config.host,
    minVersion: 'TLSv1.2',
  };
  if (t.p12) {
    options.pfx = readFile(t.p12);
    if (t.p12Password !== null && t.p12Password !== undefined)
      options.passphrase = String(t.p12Password);
  } else {
    options.cert = readFile(t.cert);
    options.key = readFile(t.key);
  }
  if (t.ca) options.ca = readFile(t.ca);
  options.rejectUnauthorized = true;
  return options;
}

/** Bounded XML uplink. Queued sends are attempts, never peer delivery acknowledgements. */
export function createServerLink({
  config,
  onXml,
  onStatus = () => {},
  connect,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const counters = {
    rx: 0,
    tx: 0,
    queued: 0,
    droppedQueue: 0,
    droppedExpired: 0,
    coalesced: 0,
    reconnects: 0,
    discarded: 0,
  };
  const queue = [];
  let queueBytes = 0;
  let socket = null;
  let state = 'connecting';
  let lastError = null;
  let backoff = SERVER_BACKOFF_MS.min;
  let timer = null;
  let closed = false;
  let blocked = false;
  const framer = createCotStreamFramer({
    onEvent: (xml) => {
      counters.rx++;
      onXml(xml);
    },
    onDiscard: (_reason, count) => {
      counters.discarded += count;
    },
  });
  const status = () => ({
    state,
    lastError,
    endpoint: `${config.protocol}://${config.host}:${config.port}`,
    ...counters,
    queue: queue.length,
    queueBytes,
    bufferedBytes: socket?.writableLength || 0,
  });
  const report = () => onStatus(status());
  function removeAt(index) {
    const [entry] = queue.splice(index, 1);
    queueBytes -= entry.bytes;
    return entry;
  }
  function expire() {
    const t = now();
    for (let i = queue.length - 1; i >= 0; i--) {
      if (
        queue[i].staleMs <= t ||
        t - queue[i].queuedAt >= SERVER_QUEUE_MAX_AGE_MS
      ) {
        removeAt(i);
        counters.droppedExpired++;
      }
    }
  }
  function defaultConnect() {
    return config.protocol === 'tls'
      ? tls.connect({
          host: config.host,
          port: config.port,
          ...loadTlsOptions(config),
        })
      : net.connect({ host: config.host, port: config.port });
  }
  function scheduleReconnect() {
    if (closed || timer !== null) return;
    state = 'reconnecting';
    report();
    const delay = backoff;
    backoff = Math.min(SERVER_BACKOFF_MS.max, backoff * 2);
    timer = setTimer(() => {
      timer = null;
      counters.reconnects++;
      start();
    }, delay);
  }
  function flush() {
    expire();
    while (queue.length && socket && state === 'connected' && !blocked) {
      const entry = queue[0];
      if (
        (socket.writableLength || 0) + entry.bytes >
        SERVER_WRITE_BUFFER_BYTES_LIMIT
      ) {
        blocked = true;
        break;
      }
      removeAt(0);
      try {
        blocked = socket.write(entry.xml) === false;
        counters.tx++;
      } catch {
        lastError = 'WRITE_FAILED';
        socket.destroy();
        break;
      }
    }
  }
  function start() {
    if (closed) return;
    state = 'connecting';
    blocked = false;
    framer.reset();
    expire();
    let s;
    try {
      s = (connect || defaultConnect)(config);
    } catch (error) {
      lastError = error?.code || 'CONNECT_FAILED';
      scheduleReconnect();
      return;
    }
    socket = s;
    s.setEncoding?.('utf8');
    s.setKeepAlive?.(true, 30_000);
    s.setTimeout?.(SERVER_IDLE_TIMEOUT_MS);
    s.on(config.protocol === 'tls' ? 'secureConnect' : 'connect', () => {
      if (closed || socket !== s) return;
      if (config.protocol === 'tls' && s.authorized !== true) {
        lastError = 'TLS_UNAUTHORIZED';
        s.destroy();
        return;
      }
      state = 'connected';
      lastError = null;
      backoff = SERVER_BACKOFF_MS.min;
      report();
      flush();
    });
    s.on('drain', () => {
      if (socket === s) {
        blocked = false;
        flush();
      }
    });
    s.on('data', (chunk) => {
      if (socket === s && state === 'connected')
        framer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    s.on('timeout', () => {
      lastError = 'IDLE_TIMEOUT';
      s.destroy();
    });
    s.on('error', (error) => {
      lastError = error?.code || 'CONNECTION_FAILED';
    });
    s.on('close', () => {
      if (socket !== s) return;
      socket = null;
      blocked = false;
      if (!closed) scheduleReconnect();
    });
  }
  start();
  return Object.freeze({
    id: 'server',
    kind: 'server',
    limits: { rate: 200, burst: 1000 },
    send(xml, parsedEvent) {
      if (closed) return false;
      let event;
      try {
        event = parsedEvent || parseCotEvent(xml);
      } catch {
        counters.discarded++;
        return false;
      }
      expire();
      if (event.staleMs <= now()) {
        counters.droppedExpired++;
        return false;
      }
      if (
        cotKind(event.type) === 'ping' &&
        (!socket || state !== 'connected' || blocked)
      )
        return false;
      let framed;
      try {
        framed = encodeTakStreamEvent(event);
      } catch {
        counters.discarded++;
        return false;
      }
      const bytes = Buffer.byteLength(framed);
      if (bytes > SERVER_WRITE_BUFFER_BYTES_LIMIT) {
        counters.discarded++;
        return false;
      }
      const target =
        event.type === 't-x-d-d' ? event.detail.links[0]?.uid : event.uid;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].uid === target) {
          removeAt(i);
          counters.coalesced++;
        }
      }
      queue.push({
        uid: event.uid,
        xml: framed,
        bytes,
        staleMs: event.staleMs,
        queuedAt: now(),
      });
      queueBytes += bytes;
      counters.queued++;
      while (
        queue.length > SERVER_QUEUE_LIMIT ||
        queueBytes > SERVER_QUEUE_BYTES_LIMIT
      ) {
        removeAt(0);
        counters.droppedQueue++;
      }
      flush();
      return true;
    },
    status,
    close() {
      if (closed) return;
      closed = true;
      state = 'closed';
      if (timer !== null) clearTimer(timer);
      timer = null;
      queue.length = 0;
      queueBytes = 0;
      socket?.destroy();
      socket = null;
    },
  });
}
