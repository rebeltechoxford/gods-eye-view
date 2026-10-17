import { createHash } from 'node:crypto';
import {
  cotKind,
  parseCotEvent,
  serializeCotEvent,
} from '../../../src/tak/protocol/cot.js';
import { createRateLimiter } from '../../../src/tak/protocol/router.js';

export const DEVICE_STREAM_LIMITS = Object.freeze({
  principal: 4,
  process: 32,
  identities: 32,
  presenceMs: 30_000,
  pending: 256,
  pendingBytes: 1024 * 1024,
  wireRate: 200,
  wireBurst: 1000,
  wireBytesPerSecond: 1024 * 1024,
  deliveryBytesPerSecond: 4 * 1024 * 1024,
  replayEntries: 2000,
  replayBytes: 8 * 1024 * 1024,
  seenEntries: 8192,
});
const processSlots = new Set();
const uidClaims = new Map();
let processPendingBytes = 0;
const DEVICE_UID =
  /^GEV-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function byteBudget(now, initial) {
  let tokens = initial,
    at = now();
  return (bytes, rate, burst = rate * 2) => {
    const time = now();
    tokens = Math.min(burst, tokens + (Math.max(0, time - at) * rate) / 1000);
    at = time;
    if (bytes > tokens) return false;
    tokens -= bytes;
    return true;
  };
}

/** Server-only stream ownership. No identity/location is invented by this module. */
export function createDeviceStreamPool({
  config,
  createServer,
  onReceive,
  allowEvent = () => true,
  onStatus = () => {},
  now = Date.now,
  setInterval: every = setInterval,
  clearInterval: stopEvery = clearInterval,
  readOnly = false,
}) {
  if (config?.protocol !== 'tls')
    throw new TypeError('Device streams require verified TLS');
  const owner = Symbol('principal-device-pool'),
    devices = new Map(),
    refs = new Map(),
    pending = new Set();
  const sharedReplay = new Map();
  let shared = null,
    closed = false,
    pendingBytes = 0,
    sequence = 0;
  const counters = {
    rx: 0,
    invalid: 0,
    wireLimited: 0,
    deliveryLimited: 0,
    duplicate: 0,
  };

  const validRef = (record) => {
    try {
      return record.authorized() === true;
    } catch {
      return false;
    }
  };
  const validMembers = (device) => [...device.refs.values()].filter(validRef);
  const streamCount = () =>
    (shared ? 1 : 0) + [...devices.values()].filter((d) => d.stream).length;
  function trimReplay(map) {
    const partitions = devices.size + 1;
    const count = Math.max(
      1,
      Math.floor(DEVICE_STREAM_LIMITS.replayEntries / partitions),
    );
    const bytes = Math.floor(DEVICE_STREAM_LIMITS.replayBytes / partitions);
    for (const [uid, item] of map) if (item.staleMs <= now()) map.delete(uid);
    let used = [...map.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (map.size > count || used > bytes) {
      const uid = map.keys().next().value;
      used -= map.get(uid).bytes;
      map.delete(uid);
    }
  }
  function remember(map, xml, event) {
    const kind = cotKind(event.type);
    if (kind === 'delete') {
      map.delete(event.detail.links[0]?.uid);
      return;
    }
    if (event.type === 'b-a-o-can') {
      map.delete(event.uid);
      return;
    }
    if (!['sa', 'marker', 'alert', 'drawing'].includes(kind)) return;
    if (event.timeMs < (map.get(event.uid)?.timeMs ?? -Infinity)) return;
    map.delete(event.uid);
    map.set(event.uid, {
      xml,
      timeMs: event.timeMs,
      staleMs: event.staleMs,
      bytes: Buffer.byteLength(xml),
    });
    trimReplay(map);
  }
  function pruneSeen(device) {
    for (const [key, at] of device.seen)
      if (now() - at >= 60_000) device.seen.delete(key);
    const limit = Math.max(
      1,
      Math.floor(DEVICE_STREAM_LIMITS.seenEntries / Math.max(1, devices.size)),
    );
    while (device.seen.size > limit)
      device.seen.delete(device.seen.keys().next().value);
  }
  function rebalance() {
    // Attaching a UID reduces every partition's share immediately, including
    // partitions that receive no subsequent writes.
    trimReplay(sharedReplay);
    for (const device of devices.values()) {
      trimReplay(device.replay);
      pruneSeen(device);
    }
  }
  function deliver(device, xml, event, context, digest) {
    const members = validMembers(device);
    if (!members.length) return;
    pruneSeen(device);
    if (device.seen.has(digest)) {
      counters.duplicate++;
      return;
    }
    // Fixed aggregate budget with an equal reserved share per live device.
    // A copied feed does not consume another recipient's frame allowance.
    const rate =
      DEVICE_STREAM_LIMITS.deliveryBytesPerSecond / Math.max(1, devices.size);
    if (!device.deliveryBytes(Buffer.byteLength(xml), rate)) {
      counters.deliveryLimited++;
      return;
    }
    device.seen.set(digest, now());
    pruneSeen(device);
    remember(device.replay, xml, event);
    for (const member of members) {
      try {
        onReceive(member.ref, xml, event, {
          ...context,
          recipientUid: device.uid,
        });
      } catch {
        /* one receiver cannot interrupt another */
      }
    }
  }
  function ingress(stream, xml) {
    if (
      closed ||
      stream.closed ||
      (stream.uid
        ? devices.get(stream.uid)?.stream !== stream
        : shared !== stream)
    )
      return;
    const bytes = typeof xml === 'string' ? Buffer.byteLength(xml) : Infinity;
    if (
      bytes > 64 * 1024 ||
      !stream.frames.take() ||
      !stream.bytes(bytes, DEVICE_STREAM_LIMITS.wireBytesPerSecond)
    ) {
      counters.wireLimited++;
      return;
    }
    let event, normalized;
    try {
      event = parseCotEvent(xml);
      normalized = serializeCotEvent(event);
      if (
        event.staleMs <= now() ||
        event.timeMs > now() + 60_000 ||
        !allowEvent(event)
      )
        return;
    } catch {
      counters.invalid++;
      return;
    }
    counters.rx++;
    const digest = createHash('sha256').update(normalized).digest('hex');
    const context = Object.freeze({
      source: stream.uid ? 'device' : 'shared',
      ownerUid: stream.uid,
      epoch: stream.epoch,
    });
    if (stream.uid) {
      const device = devices.get(stream.uid);
      if (device?.deadline <= now()) {
        endPresence(device);
        return;
      }
      if (device) deliver(device, normalized, event, context, digest);
    } else {
      remember(sharedReplay, normalized, event);
      for (const device of devices.values())
        if (!device.stream) deliver(device, normalized, event, context, digest);
    }
  }
  function finish(record) {
    if (!pending.delete(record)) return;
    pendingBytes -= record.bytes;
    processPendingBytes -= record.bytes;
    record.done = true;
  }
  function closeStream(stream) {
    if (!stream || stream.closed) return;
    stream.closed = true;
    processSlots.delete(stream);
    for (const record of [...pending])
      if (record.stream === stream) {
        stream.link?.cancel(record);
      }
    stream.link?.close();
    for (const record of [...pending])
      if (record.stream === stream)
        record.onOutcome({
          state: 'rejected',
          reason:
            'Device stream closed before write confirmation; peer receipt unknown',
        });
  }
  function openStream(uid) {
    if (
      streamCount() >= DEVICE_STREAM_LIMITS.principal ||
      processSlots.size >= DEVICE_STREAM_LIMITS.process
    )
      return null;
    const stream = {
      uid,
      id: `server:${++sequence}`,
      closed: false,
      epoch: 0,
      state: 'connecting',
      presenceWritten: false,
      frames: createRateLimiter({
        rate: DEVICE_STREAM_LIMITS.wireRate,
        burst: DEVICE_STREAM_LIMITS.wireBurst,
        now,
      }),
      bytes: byteBudget(now, DEVICE_STREAM_LIMITS.wireBytesPerSecond * 2),
      link: null,
    };
    processSlots.add(stream);
    try {
      stream.link = createServer({
        config,
        now,
        onXml: (xml) => ingress(stream, xml),
        onStatus(status) {
          if (closed || stream.closed) return;
          if (stream.state === 'connected' && status.state !== 'connected') {
            stream.epoch++;
            stream.presenceWritten = false;
            for (const record of [...pending])
              if (record.stream === stream) stream.link?.cancel(record);
          }
          stream.state = status.state;
          onStatus();
        },
      });
      return stream;
    } catch (error) {
      processSlots.delete(stream);
      throw error;
    }
  }
  function ensureShared() {
    const needed = [...devices.values()].some(
      (device) => !device.stream && device.refs.size,
    );
    if (!needed) {
      const prior = shared;
      shared = null;
      closeStream(prior);
      return true;
    }
    if (!shared) shared = openStream(null);
    return !!shared;
  }
  function endPresence(device) {
    const stream = device.stream;
    device.stream = null;
    device.presenceOwner = null;
    device.deadline = 0;
    closeStream(stream);
    ensureShared();
    onStatus();
  }
  function detach(ref) {
    const member = refs.get(ref);
    if (!member) return;
    refs.delete(ref);
    const device = devices.get(member.uid);
    device.refs.delete(ref);
    for (const record of [...pending])
      if (record.ref === ref) record.stream.link?.cancel(record);
    if (device.presenceOwner === ref) endPresence(device);
    if (!device.refs.size) {
      devices.delete(member.uid);
      if (uidClaims.get(member.uid) === owner) uidClaims.delete(member.uid);
      closeStream(device.stream);
      device.replay.clear();
      device.seen.clear();
    }
    ensureShared();
    rebalance();
    onStatus();
  }
  function attach(ref, { uid, callsign, authorized }) {
    if (
      closed ||
      !DEVICE_UID.test(uid || '') ||
      typeof callsign !== 'string' ||
      !callsign.trim() ||
      callsign.length > 40 ||
      /[\x00-\x1f\x7f]/.test(callsign) ||
      typeof authorized !== 'function'
    )
      return { ok: false, reason: 'Identity invalid' };
    if (refs.has(ref) && refs.get(ref).uid !== uid)
      return { ok: false, reason: 'Identity changed' };
    if (uidClaims.has(uid) && uidClaims.get(uid) !== owner)
      return { ok: false, reason: 'Identity unavailable' };
    if (!validRef({ authorized }))
      return { ok: false, reason: 'Identity unavailable' };
    let device = devices.get(uid);
    if (device && device.callsign !== callsign) {
      if (device.refs.size !== 1 || !device.refs.has(ref))
        return { ok: false, reason: 'Identity conflicts with another tab' };
      endPresence(device);
      device.callsign = callsign;
    }
    if (!device) {
      if (devices.size >= DEVICE_STREAM_LIMITS.identities)
        return { ok: false, reason: 'Identity capacity reached' };
      device = {
        uid,
        callsign,
        refs: new Map(),
        stream: null,
        presenceOwner: null,
        deadline: 0,
        replay: new Map(),
        seen: new Map(),
        deliveryBytes: byteBudget(
          now,
          DEVICE_STREAM_LIMITS.deliveryBytesPerSecond * 2,
        ),
      };
      devices.set(uid, device);
      uidClaims.set(uid, owner);
    }
    const member = { ref, uid, authorized };
    refs.set(ref, member);
    device.refs.set(ref, member);
    if (!ensureShared()) {
      detach(ref);
      return { ok: false, reason: 'Upstream stream capacity reached' };
    }
    rebalance();
    onStatus();
    return { ok: true };
  }
  function send(xml, event, tracking) {
    if (closed) return false;
    if (cotKind(event.type) === 'ping' && !tracking?.deviceRef) {
      let sent = false;
      for (const stream of [
        shared,
        ...[...devices.values()].map((d) => d.stream),
      ].filter(Boolean))
        sent = stream.link.send(xml, event) !== false || sent;
      return sent;
    }
    const member = refs.get(tracking?.deviceRef),
      device = member && devices.get(member.uid);
    if (
      readOnly ||
      !device ||
      !validRef(member) ||
      tracking?.canWrite?.() === false
    )
      return false;
    if (device.stream && device.deadline <= now()) endPresence(device);
    const bytes = typeof xml === 'string' ? Buffer.byteLength(xml) : Infinity;
    if (
      bytes > 64 * 1024 ||
      pending.size >= DEVICE_STREAM_LIMITS.pending ||
      pendingBytes + bytes > DEVICE_STREAM_LIMITS.pendingBytes ||
      processPendingBytes + bytes > DEVICE_STREAM_LIMITS.pendingBytes * 8
    )
      return false;
    const isSa = cotKind(event.type) === 'sa' && event.uid === device.uid;
    // TAK Server binds a stream to the first contact@endpoint it observes.
    // Only a fresh authorized self-SA may claim that binding, including after
    // reconnect; a marker/control must never register a different UID first.
    if (!isSa && event.detail.endpoint) return false;
    if (isSa) {
      if (
        event.detail.callsign !== device.callsign ||
        event.detail.endpoint !== '*:-1:stcp' ||
        event.staleMs <= now() ||
        event.timeMs > now() + 60_000 ||
        event.timeMs < now() - 30_000
      )
        return false;
      if (device.presenceOwner && device.presenceOwner !== member.ref)
        return false;
      if (!device.stream) {
        const wasShared = shared;
        if (
          wasShared &&
          ![...devices.values()].some((d) => d !== device && !d.stream)
        ) {
          shared = null;
          closeStream(wasShared);
        }
        device.stream = openStream(device.uid);
        if (!device.stream) {
          ensureShared();
          return false;
        }
      }
      device.presenceOwner = member.ref;
      device.deadline = Math.min(
        event.staleMs,
        now() + DEVICE_STREAM_LIMITS.presenceMs,
      );
    }
    const stream = device.stream || shared;
    if (!stream || stream.closed) return false;
    const record = {
      stream,
      ref: member.ref,
      owner: tracking?.owner,
      bytes,
      epoch: stream.epoch,
      done: false,
    };
    pending.add(record);
    pendingBytes += bytes;
    processPendingBytes += bytes;
    const canWrite = () =>
      !closed &&
      !stream.closed &&
      refs.get(member.ref) === member &&
      validRef(member) &&
      stream.epoch === record.epoch &&
      (!isSa ||
        (device.presenceOwner === member.ref && device.deadline > now())) &&
      tracking?.canWrite?.() !== false;
    try {
      record.onOutcome = (outcome) => {
        if (record.done) return;
        if (outcome.state !== 'queued') finish(record);
        if (isSa && outcome.state === 'submitted' && canWrite())
          stream.presenceWritten = true;
        tracking?.onState?.(outcome);
      };
      const accepted =
        stream.link.send(xml, event, {
          owner: record,
          canWrite,
          onState: record.onOutcome,
        }) !== false;
      if (!accepted) finish(record);
      return accepted;
    } catch {
      finish(record);
      return false;
    }
  }
  function tick() {
    for (const member of [...refs.values()])
      if (!validRef(member)) detach(member.ref);
    for (const device of devices.values())
      if (device.stream && device.deadline <= now()) endPresence(device);
  }
  const timer = every(tick, 1000);
  timer?.unref?.();
  return Object.freeze({
    id: 'server',
    kind: 'server',
    attach,
    detach,
    send,
    stopPresence(ref) {
      const member = refs.get(ref),
        device = member && devices.get(member.uid);
      if (!device || (device.presenceOwner && device.presenceOwner !== ref))
        return false;
      endPresence(device);
      return true;
    },
    cancel(ownerRef) {
      for (const record of [...pending])
        if (record.owner === ownerRef) record.stream.link?.cancel(record);
    },
    replay(ref) {
      const member = refs.get(ref),
        device = member && devices.get(member.uid);
      if (!device || !validRef(member)) return [];
      const items = new Map(!device.stream ? sharedReplay : []);
      for (const [uid, item] of device.replay)
        if (item.timeMs >= (items.get(uid)?.timeMs ?? -Infinity))
          items.set(uid, item);
      return [...items.values()].filter((item) => item.staleMs > now());
    },
    rememberPublic(xml) {
      const digest = createHash('sha256').update(xml).digest('hex');
      for (const device of devices.values()) {
        device.seen.set(digest, now());
        pruneSeen(device);
      }
    },
    status() {
      const streams = [
        shared,
        ...[...devices.values()].map((d) => d.stream),
      ].filter(Boolean);
      return {
        state: streams.some((s) => s.state === 'connected')
          ? 'connected'
          : streams.length
            ? 'connecting'
            : 'idle',
        endpoint: `tls://${config.host}:${config.port}`,
        deviceStreams: true,
        streams: streams.length,
        devices: devices.size,
        queue: pending.size,
        queueBytes: pendingBytes,
        ...counters,
        presence: [...devices.values()].map((d) => ({
          uid: d.uid,
          active: !!d.stream,
          presenceSent: !!d.stream?.presenceWritten,
          expiresAt: d.deadline,
        })),
      };
    },
    close() {
      if (closed) return;
      closed = true;
      stopEvery(timer);
      closeStream(shared);
      shared = null;
      for (const device of devices.values()) {
        closeStream(device.stream);
        if (uidClaims.get(device.uid) === owner) uidClaims.delete(device.uid);
      }
      devices.clear();
      refs.clear();
      pending.clear();
      pendingBytes = 0;
      sharedReplay.clear();
    },
  });
}
