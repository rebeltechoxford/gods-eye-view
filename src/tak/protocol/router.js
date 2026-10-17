// CoT router: the switchboard between transports (browser socket, mesh
// multicast, TAK Server stream, loopback...). Portable; used by the Node
// gateway and usable in-browser for local-only operation.
//
// Responsibilities:
// - parse/validate inbound XML once, then hand peers re-serialised XML
//   (raw input is never relayed verbatim);
// - suppress duplicates (mesh networks flood the same event repeatedly);
// - never echo an event back out of the link it arrived on;
// - rate-limit each link so one noisy peer cannot starve the others;
// - apply a forwarding policy (which link may feed which).

import {
  CotValidationError,
  MAX_COT_EVENT_BYTES,
  byteLength,
  parseCotEvent,
  serializeCotEvent,
} from './cot.js';

export const DEFAULT_DEDUP_WINDOW_MS = 60_000;
export const DEFAULT_DEDUP_CAPACITY = 8192;
export const DEFAULT_DEDUP_BYTES = 8 * 1024 * 1024;

/** Exact normalized report, so same-timestamp corrections are not discarded. */
export function cotDedupKey(event) {
  return serializeCotEvent(event);
}

/** Bounded time-windowed set. */
export function createDedupCache({
  windowMs = DEFAULT_DEDUP_WINDOW_MS,
  capacity = DEFAULT_DEDUP_CAPACITY,
  maxBytes = DEFAULT_DEDUP_BYTES,
  now = Date.now,
} = {}) {
  const seen = new Map(); // key -> first-seen ms (insertion ordered)
  let bytes = 0;
  function remove(key) {
    if (seen.delete(key)) bytes -= key.length * 2;
  }
  function prune(t) {
    for (const [key, at] of seen) {
      if (t - at < windowMs && seen.size <= capacity && bytes <= maxBytes)
        break;
      remove(key);
    }
  }
  return Object.freeze({
    /** True if the key was already seen inside the window; records it otherwise. */
    check(key) {
      const t = now();
      prune(t);
      const at = seen.get(key);
      if (at !== undefined && t - at < windowMs) return true;
      remove(key); // re-insert at the tail to keep time order
      seen.set(key, t);
      bytes += key.length * 2;
      if (seen.size > capacity || bytes > maxBytes) prune(t);
      return false;
    },
    size: () => seen.size,
    bytes: () => bytes,
    clear() {
      seen.clear();
      bytes = 0;
    },
  });
}

/** Token bucket: `rate` tokens/second, up to `burst`. */
export function createRateLimiter({
  rate = 50,
  burst = 200,
  now = Date.now,
} = {}) {
  let tokens = burst;
  let last = now();
  return Object.freeze({
    take() {
      const t = now();
      tokens = Math.min(burst, tokens + (Math.max(0, t - last) / 1000) * rate);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  });
}

/**
 * @typedef {object} CotLink
 * @property {string} id Unique link id ("browser:3", "mesh", "server").
 * @property {string} kind 'browser' | 'mesh' | 'server' | 'loopback' | ...
 * @property {(xml:string, event:import('./cot.js').CotEvent)=>void} send
 * @property {{rate?:number, burst?:number}} [limits] Inbound rate limit.
 */

/**
 * @typedef {object} RouteDecision
 * @property {import('./cot.js').CotEvent} event
 * @property {CotLink} from
 * @property {CotLink} to
 */

/**
 * @param {object} [options]
 * @param {(decision:RouteDecision)=>boolean} [options.policy] Forwarding rule; default: all.
 * @param {(entry:object)=>void} [options.onAudit] Receives accept/drop records.
 * @param {()=>number} [options.now]
 */
export function createCotRouter({
  policy = () => true,
  onAudit = () => {},
  now = Date.now,
  dedup,
} = {}) {
  /** @type {Map<string, {link:CotLink, limiter:ReturnType<typeof createRateLimiter>, rx:number, tx:number, dropped:number}>} */
  const links = new Map();
  const listeners = new Set();
  const seen = dedup || createDedupCache({ now });
  const counters = {
    received: 0,
    accepted: 0,
    duplicate: 0,
    invalid: 0,
    limited: 0,
    forwarded: 0,
  };

  function audit(entry) {
    try {
      onAudit({ at: now(), ...entry });
    } catch {
      // Audit sinks must never break routing.
    }
  }

  function addLink(link) {
    if (!link || typeof link.id !== 'string' || !link.id)
      throw new TypeError('CoT link requires an id');
    if (typeof link.send !== 'function')
      throw new TypeError(`CoT link ${link.id} requires send()`);
    if (links.has(link.id))
      throw new Error(`CoT link ${link.id} already registered`);
    links.set(link.id, {
      link,
      limiter: createRateLimiter({ ...link.limits, now }),
      rx: 0,
      tx: 0,
      dropped: 0,
    });
    return () => removeLink(link.id);
  }

  function removeLink(id) {
    return links.delete(id);
  }

  function fanOut(event, xml, fromState) {
    for (const state of links.values()) {
      if (state === fromState) continue; // never echo to the origin link
      const from = fromState?.link || { id: 'local', kind: 'local' };
      let allowed = false;
      try {
        allowed = policy({ event, from, to: state.link }) === true;
      } catch {
        allowed = false;
      }
      if (!allowed) continue;
      try {
        if (state.link.send(xml, event) === false) {
          state.dropped++;
          continue;
        }
        state.tx++;
        counters.forwarded++;
      } catch (error) {
        state.dropped++;
        audit({
          action: 'send-failed',
          link: state.link.id,
          uid: event.uid,
          reason: String(error?.message || error),
        });
      }
    }
    for (const listener of listeners) {
      try {
        listener(event, { from: fromState?.link || null, xml });
      } catch {
        // A faulty subscriber cannot interrupt delivery to the others.
      }
    }
  }

  /**
   * Accept raw XML from a link (or null for locally originated events).
   * @param {string} xml
   * @param {string|null} fromId
   * @returns {{ok:true, event:object}|{ok:false, reason:string}}
   */
  function receiveXml(xml, fromId = null) {
    const state = fromId ? links.get(fromId) : null;
    if (fromId && !state) return { ok: false, reason: 'unknown-link' };
    counters.received++;
    if (state) state.rx++;
    if (state && !state.limiter.take()) {
      counters.limited++;
      state.dropped++;
      return { ok: false, reason: 'rate-limited' };
    }
    if (typeof xml !== 'string' || byteLength(xml) > MAX_COT_EVENT_BYTES) {
      counters.invalid++;
      audit({ action: 'reject', link: fromId, reason: 'oversized' });
      return { ok: false, reason: 'oversized' };
    }
    let event;
    try {
      event = parseCotEvent(xml);
    } catch (error) {
      counters.invalid++;
      const reason =
        error instanceof CotValidationError ? error.message : 'parse-error';
      audit({ action: 'reject', link: fromId, reason });
      return { ok: false, reason };
    }
    return deliver(event, state);
  }

  /** Accept an already-validated CotEvent (e.g. built locally). */
  function publish(event, fromId = null) {
    const state = fromId ? links.get(fromId) : null;
    if (fromId && !state) return { ok: false, reason: 'unknown-link' };
    counters.received++;
    return deliver(event, state);
  }

  /** A parsed/authorized ingress event still consumes the originating link's budget. */
  function publishValidated(event, fromId) {
    const state = links.get(fromId);
    if (!state) return { ok: false, reason: 'unknown-link' };
    counters.received++;
    state.rx++;
    if (!state.limiter.take()) {
      counters.limited++;
      state.dropped++;
      return { ok: false, reason: 'rate-limited' };
    }
    return deliver(event, state);
  }

  function deliver(event, state) {
    let xml;
    try {
      xml = serializeCotEvent(event);
      if (byteLength(xml) > MAX_COT_EVENT_BYTES)
        throw new CotValidationError(
          'Serialized CoT exceeds the event size limit',
        );
    } catch (error) {
      counters.invalid++;
      return { ok: false, reason: String(error?.message || error) };
    }
    if (seen.check(xml)) {
      counters.duplicate++;
      return { ok: false, reason: 'duplicate', event };
    }
    counters.accepted++;
    audit({
      action: 'accept',
      link: state?.link.id || 'local',
      uid: event.uid,
      type: event.type,
    });
    fanOut(event, xml, state);
    return { ok: true, event };
  }

  return Object.freeze({
    addLink,
    removeLink,
    receiveXml,
    publish,
    publishValidated,
    /** Subscribe to every accepted event. Returns an unsubscribe function. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats() {
      return {
        ...counters,
        dedupSize: seen.size(),
        links: Array.from(links.values(), (s) => ({
          id: s.link.id,
          kind: s.link.kind,
          rx: s.rx,
          tx: s.tx,
          dropped: s.dropped,
        })),
      };
    },
    destroy() {
      links.clear();
      listeners.clear();
      seen.clear();
    },
  });
}
