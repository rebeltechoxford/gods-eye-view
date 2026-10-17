import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import {
  cotKind,
  parseCotEvent,
  serializeCotEvent,
} from '../../../src/tak/protocol/cot.js';
import { createRateLimiter } from '../../../src/tak/protocol/router.js';
import {
  TAK_NEGOTIATION_TIMEOUT_MS,
  TAK_PROTOCOL_VERSION,
  buildTakProtocolRequest,
  cotEventToTakPayload,
  createTakStreamReader,
  encodeTakStreamFrame,
  mayBeTakProtocolControl,
  readTakProtocolControl,
  takPayloadToCot,
} from '../../../src/tak/protocol/takProto.js';

export const SERVER_QUEUE_LIMIT = 256;
export const SERVER_QUEUE_BYTES_LIMIT = 1024 * 1024;
export const SERVER_WRITE_BUFFER_BYTES_LIMIT = 256 * 1024;
export const SERVER_QUEUE_MAX_AGE_MS = 30_000;
export const SERVER_BACKOFF_MS = Object.freeze({ min: 1_000, max: 30_000 });
export const SERVER_IDLE_TIMEOUT_MS = 120_000;
/** Router ingress budget for the server link. */
export const SERVER_LIMITS = Object.freeze({ rate: 200, burst: 1000 });
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
  if (t.material)
    return {
      ...options,
      cert: t.material.cert,
      key: t.material.key,
      ca: t.material.ca,
      rejectUnauthorized: true,
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

/**
 * Bounded streaming uplink. XML by default; with `config.protobuf` it asks
 * a server that offers TAK protocol v1 to switch this connection to it,
 * following the published negotiation. Queued sends are attempts, never
 * peer delivery acknowledgements.
 */
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
    protocolControl: 0,
    protocolDenied: 0,
    protocolErrors: 0,
    protobufIncomplete: 0,
    protobufLimited: 0,
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
  let expiryTimer = null;
  const writing = new Set();
  // Per-connection encoding: xml -> requested -> v1 (or back to xml if denied).
  // A timed-out request disables further requests for this link's lifetime.
  const negotiation = {
    encoding: 'xml',
    offered: [],
    timer: null,
    disabled: false,
  };
  function outcome(entry, state, reason) {
    if (entry.finished) return;
    if (state !== 'queued') entry.finished = true;
    try {
      entry.tracking?.onState?.({ state, ...(reason ? { reason } : {}) });
    } catch {
      /* isolated observer */
    }
  }
  function armExpiry() {
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
    if (!closed && queue.length) {
      const deadline = Math.min(
        ...queue.map((entry) =>
          Math.min(entry.staleMs, entry.queuedAt + SERVER_QUEUE_MAX_AGE_MS),
        ),
      );
      expiryTimer = setTimer(
        () => {
          expiryTimer = null;
          expire();
          armExpiry();
        },
        Math.max(1, deadline - now()),
      );
      expiryTimer?.unref?.();
    }
  }
  function clearNegotiationTimer() {
    if (negotiation.timer !== null) clearTimer(negotiation.timer);
    negotiation.timer = null;
  }
  function requestProtobuf(control) {
    const s = socket;
    negotiation.encoding = 'requested';
    reader.hold();
    try {
      s.write(
        TAK_STREAM_DECLARATION +
          buildTakProtocolRequest({ uid: control.uid, nowMs: now() }),
      );
    } catch {
      lastError = 'WRITE_FAILED';
      s.destroy();
      return;
    }
    negotiation.timer = setTimer(() => {
      negotiation.timer = null;
      if (socket !== s || negotiation.encoding !== 'requested') return;
      // The negotiation is indeterminate: reconnect and stay on XML.
      negotiation.disabled = true;
      lastError = 'TAK_PROTOCOL_TIMEOUT';
      s.destroy();
    }, TAK_NEGOTIATION_TIMEOUT_MS);
    negotiation.timer?.unref?.();
  }
  // Negotiation events describe this connection, not the tactical picture:
  // they are consumed here and never reach the router or browsers.
  function receiveControl(control) {
    counters.protocolControl++;
    if (control.kind === 'support') {
      negotiation.offered = control.versions;
      if (
        config.protobuf &&
        !negotiation.disabled &&
        negotiation.encoding === 'xml' &&
        control.versions.includes(TAK_PROTOCOL_VERSION) &&
        socket &&
        state === 'connected'
      )
        requestProtobuf(control);
    } else if (
      control.kind === 'response' &&
      negotiation.encoding === 'requested' &&
      control.status !== null
    ) {
      clearNegotiationTimer();
      if (control.status) {
        negotiation.encoding = 'v1';
        reader.acceptProtobuf();
      } else {
        negotiation.encoding = 'xml';
        counters.protocolDenied++;
        reader.release();
      }
      report();
      queueMicrotask(flush);
    }
  }
  const protobufLimiter = createRateLimiter({ ...SERVER_LIMITS, now });
  const reader = createTakStreamReader({
    onXml: (xml) => {
      if (mayBeTakProtocolControl(xml)) {
        let control = null;
        try {
          control = readTakProtocolControl(xml);
        } catch {
          counters.discarded++;
          return;
        }
        if (control) return receiveControl(control);
      }
      counters.rx++;
      onXml(xml);
    },
    onPayload: (payload) => {
      // Same budget as the router, applied before conversion work.
      if (!protobufLimiter.take()) {
        counters.protobufLimited++;
        return;
      }
      let result;
      try {
        result = takPayloadToCot(payload);
      } catch {
        counters.discarded++;
        return;
      }
      if (result.incomplete) counters.protobufIncomplete++;
      if (result.xml === null) return;
      counters.rx++;
      onXml(result.xml);
    },
    onDiscard: (_reason, count) => {
      counters.discarded += count;
    },
    onError: () => {
      counters.protocolErrors++;
      lastError = 'TAK_PROTOCOL_ERROR';
      socket?.destroy();
    },
  });
  const status = () => ({
    state,
    lastError,
    endpoint: `${config.protocol}://${config.host}:${config.port}`,
    ...counters,
    encoding: negotiation.encoding,
    protobufRequested: !!config.protobuf && !negotiation.disabled,
    protocolOffered: [...negotiation.offered],
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
        outcome(removeAt(i), 'expired', 'Fresh submission window expired');
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
    while (
      queue.length &&
      writing.size < SERVER_QUEUE_LIMIT &&
      socket &&
      state === 'connected' &&
      negotiation.encoding !== 'requested' &&
      !blocked
    ) {
      const entry = queue[0];
      if (entry.tracking?.canWrite && !entry.tracking.canWrite()) {
        outcome(
          removeAt(0),
          'rejected',
          'Originating browser is no longer authorized',
        );
        continue;
      }
      if (
        (socket.writableLength || 0) + entry.bytes >
        SERVER_WRITE_BUFFER_BYTES_LIMIT
      ) {
        blocked = true;
        break;
      }
      let frame = entry.xml;
      if (negotiation.encoding === 'v1') {
        try {
          frame = encodeTakStreamFrame(cotEventToTakPayload(entry.event));
        } catch {
          outcome(
            removeAt(0),
            'rejected',
            'Event cannot be encoded as TAK protocol v1',
          );
          counters.discarded++;
          continue;
        }
      }
      removeAt(0);
      writing.add(entry);
      try {
        blocked =
          socket.write(frame, (error) => {
            writing.delete(entry);
            outcome(
              entry,
              error ? 'rejected' : 'submitted',
              error ? 'Upstream write failed; peer receipt unknown' : undefined,
            );
            if (queue.length) queueMicrotask(flush);
          }) === false;
        counters.tx++;
      } catch {
        writing.delete(entry);
        outcome(
          entry,
          'rejected',
          'Upstream write failed; peer receipt unknown',
        );
        lastError = 'WRITE_FAILED';
        socket.destroy();
        break;
      }
    }
    armExpiry();
  }
  function start() {
    if (closed) return;
    state = 'connecting';
    blocked = false;
    reader.reset();
    clearNegotiationTimer();
    negotiation.encoding = 'xml';
    negotiation.offered = [];
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
    // Bytes, not text: a negotiated connection switches to binary frames.
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
      if (socket === s && state === 'connected') reader.push(chunk);
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
      for (const entry of writing)
        outcome(
          entry,
          'rejected',
          'Connection closed before write confirmation; peer receipt unknown',
        );
      writing.clear();
      socket = null;
      blocked = false;
      clearNegotiationTimer();
      negotiation.encoding = 'xml';
      reader.reset();
      if (!closed) scheduleReconnect();
    });
  }
  start();
  return Object.freeze({
    id: 'server',
    kind: 'server',
    limits: SERVER_LIMITS,
    send(xml, parsedEvent, tracking) {
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
        (!socket ||
          state !== 'connected' ||
          blocked ||
          negotiation.encoding === 'requested')
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
          outcome(removeAt(i), 'rejected', 'Superseded by a newer submission');
          counters.coalesced++;
        }
      }
      queue.push({
        uid: target,
        event,
        xml: framed,
        bytes,
        staleMs: event.staleMs,
        queuedAt: now(),
        tracking,
      });
      const entry = queue.at(-1);
      queueBytes += bytes;
      counters.queued++;
      while (
        queue.length > SERVER_QUEUE_LIMIT ||
        queueBytes > SERVER_QUEUE_BYTES_LIMIT
      ) {
        outcome(removeAt(0), 'rejected', 'Upstream queue capacity reached');
        counters.droppedQueue++;
      }
      outcome(entry, 'queued');
      flush();
      return true;
    },
    /** Cancel only unwritten submissions belonging to this opaque connection. */
    cancel(owner) {
      if (!owner) return;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].tracking?.owner === owner)
          outcome(
            removeAt(i),
            'rejected',
            'Submission cancelled before upstream write',
          );
      }
      armExpiry();
    },
    status,
    close() {
      if (closed) return;
      closed = true;
      state = 'closed';
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (expiryTimer !== null) clearTimer(expiryTimer);
      expiryTimer = null;
      clearNegotiationTimer();
      for (const entry of queue)
        outcome(entry, 'rejected', 'Gateway closed before upstream write');
      for (const entry of writing)
        outcome(
          entry,
          'rejected',
          'Gateway closed before write confirmation; peer receipt unknown',
        );
      writing.clear();
      queue.length = 0;
      queueBytes = 0;
      socket?.destroy();
      socket = null;
    },
  });
}
