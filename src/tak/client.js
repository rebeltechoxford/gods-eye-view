// TAK client controller: identity, inbound/outbound CoT, SA beacon, markers,
// chat and import. DOM- and Cesium-free; the browser shell (index.js) injects
// the transport, storage and timers so every flow is testable in Node.

import {
  CotValidationError,
  parseCotDocument,
  parseCotEvent,
  serializeCotEvent,
  cotKind,
} from './protocol/cot.js';
import {
  ALL_CHAT_ROOMS,
  buildChat,
  buildDelete,
  buildEmergency,
  buildMarker,
  buildSelfSa,
  createIdentity,
  normalizeIdentity,
} from './protocol/builders.js';
import { createTakStore } from './store.js';
import { isGpsFixFresh } from './position.js';
import { createSubmissionStore } from './delivery.js';

export const IDENTITY_STORAGE_KEY = 'gev.tak.identity.v1';
export const SA_INTERVAL_MS = 10_000;
export const SWEEP_INTERVAL_MS = 5_000;

/**
 * @param {object} deps
 * @param {(handlers:{onXml:Function,onControl:Function,onState:Function})=>ReturnType<import('./transport.js').createGatewayTransport>} deps.createTransport
 * @param {{get:(k:string)=>?string, set:(k:string,v:string)=>void}} [deps.storage]
 * @param {()=>number} [deps.now]
 * @param {(fn:Function, ms:number)=>any} [deps.setInterval]
 * @param {(h:any)=>void} [deps.clearInterval]
 */
export function createTakClient({
  createTransport,
  storage = { get: () => null, set: () => {} },
  now = Date.now,
  canReportPosition = () => true,
  setInterval: every = (fn, ms) => setInterval(fn, ms),
  clearInterval: stopEvery = (h) => clearInterval(h),
}) {
  const store = createTakStore({ now });
  const delivery = createSubmissionStore({ now });
  let submissionSeq = 0;
  const listeners = new Set();
  const counters = { rx: 0, rxRejected: 0, tx: 0, txLocalOnly: 0 };
  const ownMarkers = new Set();
  const sharedMarkers = new Set();
  let linkState = 'idle';
  let linkDetail = '';
  let gateway = null; // last status from the gateway
  let lastReject = null;
  let fix = null; // {lat, lon, hae?, course?, speed?, source:'GPS'|'USER'}
  let saEnabled = false;
  let saTimer = null;
  let emergencyActive = false;
  let destroyed = false;
  let sessionExpired = false;

  let identity = loadIdentity();
  store.setSelfUid(identity.uid);

  function loadIdentity() {
    try {
      const raw = storage.get(IDENTITY_STORAGE_KEY);
      if (raw) return normalizeIdentity(JSON.parse(raw));
    } catch {
      // corrupt or unavailable storage: mint a fresh identity
    }
    const fresh = createIdentity();
    saveIdentity(fresh);
    return fresh;
  }

  function saveIdentity(value) {
    try {
      storage.set(
        IDENTITY_STORAGE_KEY,
        JSON.stringify({
          uid: value.uid,
          callsign: value.callsign,
          team: value.team,
          role: value.role,
        }),
      );
    } catch {
      // identity persistence is a convenience only
    }
  }

  function notify() {
    if (destroyed) return;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // isolate listener faults
      }
    }
  }

  const transport = createTransport({
    onXml(xml) {
      if (destroyed) return;
      let event;
      try {
        event = parseCotEvent(xml);
      } catch {
        counters.rxRejected++;
        return;
      }
      counters.rx++;
      store.apply(event, 'network');
    },
    onControl(message) {
      if (destroyed) return;
      if (message?.op === 'session-expired') {
        sessionExpired = true;
        clearPrivateState();
        lastReject = {
          reason: 'Operator session expired; sign in again',
          atMs: now(),
        };
      } else if (message?.op === 'hello' || message?.op === 'status')
        gateway = message.status || null;
      else if (message?.op === 'submission') {
        if (delivery.update(message) && message.state === 'rejected')
          lastReject = {
            reason:
              message.reason ||
              message.routes.find((route) => route.reason)?.reason ||
              'Submission rejected by uplink',
            atMs: now(),
          };
      } else if (message?.op === 'reject')
        lastReject = {
          reason: String(message.reason || 'rejected'),
          atMs: now(),
        };
      notify();
    },
    onState(state, detail) {
      if (destroyed) return;
      linkState = state;
      linkDetail = detail || '';
      if (state !== 'open') delivery.interrupt();
      if (state === 'open' && saEnabled) beacon();
      notify();
    },
  });

  const unsubscribeStore = store.subscribe(notify);
  const sweepTimer = every(() => {
    store.sweep();
    if (delivery.sweep()) notify();
  }, SWEEP_INTERVAL_MS);

  function submit(event) {
    const id = `${identity.uid}-${++submissionSeq}`;
    delivery.add({
      id,
      uid: event.uid,
      kind: cotKind(event.type),
      staleMs: event.staleMs,
      sent: true,
    });
    const xml = serializeCotEvent(event);
    const sent = transport.submit
      ? transport.submit(id, xml)
      : transport.send(xml);
    if (sent) counters.tx++;
    else {
      counters.txLocalOnly++;
      delivery.update({
        id,
        state: 'rejected',
        routes: [],
        reason: 'Not connected or browser send buffer full; kept local',
      });
    }
    notify();
    return { sent, submissionId: id };
  }

  /**
   * Apply locally and, when asked and connected, send to the network.
   * @returns {{sent:boolean}}
   */
  function emit(event, broadcast) {
    if (destroyed) return { sent: false };
    store.apply(event, 'local');
    if (!broadcast) {
      counters.txLocalOnly++;
      return { sent: false };
    }
    return submit(event);
  }

  function beacon() {
    if (!saEnabled || !fix || destroyed) return { sent: false };
    if (
      fix.source === 'GPS' &&
      (!canReportPosition() || !isGpsFixFresh(fix, now()))
    )
      return { sent: false, reason: 'position-unavailable' };
    return emit(buildSelfSa(identity, fix, { nowMs: now() }), true);
  }

  function restartSaTimer() {
    if (saTimer) stopEvery(saTimer);
    saTimer = saEnabled ? every(beacon, SA_INTERVAL_MS) : null;
  }

  function clearPrivateState() {
    transport.cancelSubmissions?.();
    delivery.clear();
    saEnabled = false;
    restartSaTimer();
    fix = null;
    emergencyActive = false;
    gateway = null;
    ownMarkers.clear();
    sharedMarkers.clear();
    store.clear();
    notify();
  }

  return Object.freeze({
    store,
    submissions: () => delivery.list(),
    identity: () => identity,
    /** Update callsign/team/role; the uid is stable for the device. */
    setIdentity(changes) {
      if (destroyed) return identity;
      identity = normalizeIdentity({
        ...identity,
        ...changes,
        uid: identity.uid,
      });
      saveIdentity(identity);
      transport.identify?.(identity);
      if (saEnabled) beacon();
      notify();
      return identity;
    },
    connect(token) {
      if (destroyed) return;
      sessionExpired = false;
      const authentication =
        token && typeof token === 'object'
          ? { session: token.session === true }
          : { token };
      transport.connect({ ...authentication, identity });
    },
    disconnect() {
      transport.disconnect();
    },
    link: () => ({
      state: linkState,
      detail: linkDetail,
      gateway,
      lastReject,
      sessionExpired,
    }),
    clearPrivateState,
    counters: () => ({ ...counters }),
    requestStatus: () => {
      if (!destroyed) transport.requestStatus();
    },

    /** Set our own position; source 'GPS' (device) or 'USER' (operator-set). */
    setFix(next) {
      if (destroyed) return;
      const validated = next
        ? buildSelfSa(identity, next, { nowMs: now() })
        : null;
      fix = next
        ? Object.freeze({
            ...next,
            ...validated.point,
            observedAtMs: Number.isFinite(next.observedAtMs)
              ? next.observedAtMs
              : now(),
            source: next.source === 'GPS' ? 'GPS' : 'USER',
          })
        : null;
      if (saEnabled && fix) beacon();
      notify();
    },
    fix: () => fix,
    /** Turn the periodic self-SA broadcast on/off. */
    setSaEnabled(enabled) {
      if (destroyed) return;
      saEnabled = !!enabled;
      restartSaTimer();
      if (saEnabled) beacon();
      notify();
    },
    saEnabled: () => saEnabled,
    beacon,

    addMarker({ callsign, lat, lon, remarks, type, broadcast = true }) {
      if (destroyed) throw new CotValidationError('TAK client is closed');
      const event = buildMarker(
        identity,
        { callsign, lat, lon, remarks, type },
        { nowMs: now() },
      );
      ownMarkers.add(event.uid);
      const result = emit(event, broadcast);
      if (result.sent) sharedMarkers.add(event.uid);
      // Keep ownership bookkeeping bounded by the session's contact store.
      for (const uid of ownMarkers) {
        if (!store.get(uid)) {
          ownMarkers.delete(uid);
          sharedMarkers.delete(uid);
        }
      }
      return { uid: event.uid, ...result };
    },
    /** Remove a contact locally; markers we created are also deleted for peers. */
    removeContact(uid, { broadcast = true } = {}) {
      const contact = store.get(uid);
      if (!contact || contact.origin === 'self')
        return { removed: false, sent: false };
      store.remove(uid);
      const wasShared = sharedMarkers.delete(uid);
      ownMarkers.delete(uid);
      if (broadcast && wasShared) {
        return {
          removed: true,
          ...submit(buildDelete(identity, uid, contact.type, { nowMs: now() })),
        };
      }
      return { removed: true, sent: false };
    },
    isOwnMarker: (uid) => ownMarkers.has(uid),

    sendChat(message, chatroom = ALL_CHAT_ROOMS) {
      const event = buildChat(
        identity,
        { message, chatroom, point: fix || undefined },
        { nowMs: now() },
      );
      return emit(event, true);
    },

    /** Raise or cancel a 911-style alert at our current fix. */
    setEmergency(active, kind = '911 Alert') {
      if (destroyed) return { sent: false };
      if (!fix)
        throw new CotValidationError(
          'Set your position before raising an alert',
        );
      if (
        active &&
        fix.source === 'GPS' &&
        (!canReportPosition() || !isGpsFixFresh(fix, now()))
      )
        throw new CotValidationError(
          'A fresh foreground GPS fix is required before raising an alert.',
        );
      const event = buildEmergency(identity, fix, {
        kind,
        cancel: !active,
        nowMs: now(),
      });
      emergencyActive = !!active;
      const result = emit(event, true);
      notify();
      return result;
    },
    emergencyActive: () => emergencyActive,

    /** Import an offline CoT file into the session (never re-broadcast). */
    importXml(xml) {
      if (destroyed) throw new CotValidationError('TAK client is closed');
      const { events, rejected } = parseCotDocument(xml);
      if (!events.length)
        throw new CotValidationError(
          'No CoT events contain valid positions or messages.',
        );
      const applied = store.applyAll(events, 'import');
      return { ...applied, rejected: rejected.length };
    },

    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopEvery(sweepTimer);
      if (saTimer) stopEvery(saTimer);
      unsubscribeStore();
      transport.disconnect();
      listeners.clear();
      store.destroy();
      delivery.clear();
      ownMarkers.clear();
      sharedMarkers.clear();
      fix = null;
      saEnabled = false;
      emergencyActive = false;
      gateway = null;
      lastReject = null;
      linkState = 'closed';
    },
  });
}
