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
import { buildGeometry, GEOMETRY_STALE_MS } from './geometryCot.js';

export const IDENTITY_STORAGE_KEY = 'gev.tak.identity.v1';
export const SA_INTERVAL_MS = 10_000;
export const SWEEP_INTERVAL_MS = 5_000;

/**
 * @param {object} deps
 * @param {(handlers:{onXml:Function,onControl:Function,onState:Function})=>ReturnType<import('./transport.js').createGatewayTransport>} deps.createTransport
 * @param {{get:(k:string)=>?string, set:(k:string,v:string)=>void}} [deps.storage]
 * @param {?string} [deps.identityStorageKey] Validated account key; null keeps identity ephemeral.
 * @param {()=>boolean} [deps.canShare] Browser role/context policy; gateway still authorizes every write.
 * @param {()=>number} [deps.now]
 * @param {(fn:Function, ms:number)=>any} [deps.setInterval]
 * @param {(h:any)=>void} [deps.clearInterval]
 */
export function createTakClient({
  createTransport,
  storage = { get: () => null, set: () => {} },
  identityStorageKey = IDENTITY_STORAGE_KEY,
  canShare: mayShare = () => true,
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
  const ownGeometries = new Set();
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
  let ownPositionSubmitted = false;
  let presenceStop = null;

  let identity = loadIdentity();
  store.setSelfUid(identity.uid);

  function loadIdentity() {
    try {
      const raw = identityStorageKey ? storage.get(identityStorageKey) : null;
      if (raw) return normalizeIdentity(JSON.parse(raw));
    } catch {
      // corrupt or unavailable storage: mint a fresh identity
    }
    const fresh = createIdentity();
    saveIdentity(fresh);
    return fresh;
  }

  function saveIdentity(value) {
    if (!identityStorageKey) return;
    try {
      storage.set(
        identityStorageKey,
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
      else if (message?.op === 'presence') {
        if (
          message.enabled !== false ||
          message.uid !== identity.uid ||
          presenceStop?.state !== 'requested' ||
          message.id !== presenceStop.id
        )
          return;
        presenceStop = { ...presenceStop, state: 'confirmed' };
        if (saEnabled) beacon();
      } else if (message?.op === 'submission') {
        if (delivery.update(message) && message.state === 'rejected')
          lastReject = {
            reason:
              message.reason ||
              message.routes.find((route) => route.reason)?.reason ||
              'Submission rejected by uplink',
            atMs: now(),
          };
      } else if (message?.op === 'reject') {
        if (message.command === 'presence' && message.id === presenceStop?.id)
          presenceStop = { ...presenceStop, state: 'refused' };
        lastReject = {
          reason: String(message.reason || 'rejected'),
          atMs: now(),
        };
      }
      notify();
    },
    onState(state, detail) {
      if (destroyed) return;
      linkState = state;
      linkDetail = detail || '';
      if (state !== 'open') {
        delivery.interrupt();
        ownPositionSubmitted = false;
        if (presenceStop?.state === 'requested')
          presenceStop = { ...presenceStop, state: 'unconfirmed' };
      }
      if (state === 'open') presenceStop = null;
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
    if (
      presenceStop?.state === 'requested' &&
      event.uid === identity.uid &&
      cotKind(event.type) === 'sa'
    ) {
      counters.txLocalOnly++;
      return {
        sent: false,
        reason:
          'Device presence stop confirmation is pending; position kept local',
      };
    }
    if (destroyed || !mayShare()) {
      counters.txLocalOnly++;
      return {
        sent: false,
        reason: 'This account is receive-only; kept local',
      };
    }
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
    if (sent) {
      counters.tx++;
      if (event.uid === identity.uid && cotKind(event.type) === 'sa') {
        ownPositionSubmitted = true;
        presenceStop = null;
      }
    } else {
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
    if (presenceStop?.state === 'requested')
      return { sent: false, reason: 'presence-stop-pending' };
    if (
      fix.source === 'GPS' &&
      (!canReportPosition() || !isGpsFixFresh(fix, now()))
    ) {
      stopOwnPresence();
      return { sent: false, reason: 'position-unavailable' };
    }
    return emit(buildSelfSa(identity, fix, { nowMs: now() }), true);
  }

  function restartSaTimer() {
    if (saTimer) stopEvery(saTimer);
    saTimer = saEnabled ? every(beacon, SA_INTERVAL_MS) : null;
  }

  function stopOwnPresence() {
    if (!ownPositionSubmitted || gateway?.server?.deviceStreams !== true)
      return;
    ownPositionSubmitted = false;
    presenceStop = { state: 'requested', id: null };
    const id = transport.stopPresence?.();
    if (typeof id === 'string') presenceStop = { ...presenceStop, id };
    else {
      presenceStop = { ...presenceStop, state: 'unconfirmed' };
      if (linkState === 'open')
        transport.disconnect(
          'Device presence stop unavailable; connection closed, route stop unconfirmed',
        );
    }
    notify();
  }

  function refreshPositionAvailability() {
    if (destroyed) return;
    if (
      fix?.source === 'GPS' &&
      (!canReportPosition() || !isGpsFixFresh(fix, now()))
    )
      stopOwnPresence();
  }

  function clearPrivateState() {
    stopOwnPresence();
    transport.cancelSubmissions?.();
    delivery.clear();
    saEnabled = false;
    restartSaTimer();
    fix = null;
    emergencyActive = false;
    gateway = null;
    ownMarkers.clear();
    sharedMarkers.clear();
    ownGeometries.clear();
    store.clear();
    notify();
  }

  return Object.freeze({
    store,
    canShare: () => !destroyed && !sessionExpired && mayShare(),
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
      stopOwnPresence();
      sessionExpired = false;
      const authentication =
        token && typeof token === 'object'
          ? {
              session: token.session === true,
              ...(token.storageScope
                ? { storageScope: token.storageScope }
                : {}),
            }
          : { token };
      transport.connect({ ...authentication, identity });
    },
    disconnect() {
      stopOwnPresence();
      transport.disconnect();
    },
    link: () => ({
      state: linkState,
      detail: linkDetail,
      gateway,
      lastReject,
      sessionExpired,
      presenceStop: presenceStop ? { ...presenceStop } : null,
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
      if (!fix) stopOwnPresence();
      refreshPositionAvailability();
      if (saEnabled && fix) beacon();
      notify();
    },
    fix: () => fix,
    refreshPositionAvailability,
    /** Turn the periodic self-SA broadcast on/off. */
    setSaEnabled(enabled) {
      if (destroyed) return;
      if (enabled && !mayShare())
        throw new CotValidationError(
          'This account is receive-only; position sharing is unavailable',
        );
      saEnabled = !!enabled;
      restartSaTimer();
      if (!saEnabled) stopOwnPresence();
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
          ownGeometries.delete(uid);
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
      let deletion = null;
      if (broadcast && sharedMarkers.has(uid)) {
        const currentTime = now();
        const revision = Math.max(currentTime, contact.event.timeMs + 1);
        if (revision > currentTime + 60_000)
          throw new CotValidationError(
            'Object has a future timestamp. Remove locally without broadcasting, or wait for its revision.',
          );
        deletion = buildDelete(identity, uid, contact.type, {
          nowMs: revision,
        });
      }
      store.remove(uid);
      const wasShared = sharedMarkers.delete(uid);
      ownMarkers.delete(uid);
      ownGeometries.delete(uid);
      if (broadcast && wasShared) {
        return {
          removed: true,
          ...submit(deletion),
        };
      }
      return { removed: true, sent: false };
    },
    isOwnMarker: (uid) => ownMarkers.has(uid),
    isOwnGeometry: (uid) =>
      ownGeometries.has(uid) && store.get(uid)?.geometryResult?.status === 'ok',
    /** Save a complete drawing; updates require the exact snapshot being edited. */
    saveGeometry(input, { broadcast = false, expectedEvent = null } = {}) {
      if (destroyed) throw new CotValidationError('TAK client is closed');
      const prior = input.uid ? store.get(input.uid) : null;
      if (
        input.uid &&
        (!ownGeometries.has(input.uid) ||
          !prior ||
          prior.event !== expectedEvent)
      )
        throw new CotValidationError(
          'Drawing changed, was removed, or belongs to another session. Reload or copy it.',
        );
      const currentTime = now();
      const revision = Math.max(
        currentTime,
        (prior?.event.timeMs ?? -Infinity) + 1,
      );
      if (revision > currentTime + 60_000)
        throw new CotValidationError(
          'Drawing has a future timestamp. Copy it into a new drawing instead.',
        );
      const event = buildGeometry(identity, input, {
        nowMs: revision,
        staleMs: GEOMETRY_STALE_MS - (revision - currentTime),
        ...(prior ? { expectedRevision: prior.event.timeMs } : {}),
      });
      if (store.apply(event, 'local') !== 'contact')
        throw new CotValidationError(
          'Drawing exceeds the session resource budget or is older than its stored version.',
        );
      ownMarkers.add(event.uid);
      ownGeometries.add(event.uid);
      const result = broadcast ? submit(event) : { sent: false };
      if (!broadcast) counters.txLocalOnly++;
      if (result.sent) sharedMarkers.add(event.uid);
      for (const uid of ownMarkers) {
        if (!store.get(uid)) {
          ownMarkers.delete(uid);
          ownGeometries.delete(uid);
          sharedMarkers.delete(uid);
        }
      }
      notify();
      return { uid: event.uid, ...result };
    },

    sendChat(message, chatroom = ALL_CHAT_ROOMS) {
      if (destroyed || !mayShare())
        throw new CotValidationError(
          'This account is receive-only; chat sending is unavailable',
        );
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
      if (!mayShare())
        throw new CotValidationError(
          'This account is receive-only; network alerts are unavailable',
        );
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
    destroy({ forgetIdentity = false } = {}) {
      if (destroyed) return;
      stopOwnPresence();
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
      ownGeometries.clear();
      fix = null;
      saEnabled = false;
      emergencyActive = false;
      gateway = null;
      lastReject = null;
      linkState = 'closed';
      ownPositionSubmitted = false;
      presenceStop = null;
      if (forgetIdentity) identity = createIdentity();
    },
  });
}
