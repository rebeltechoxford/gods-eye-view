// Session-only TAK state: contacts/markers, alerts and GeoChat.
// Portable (no DOM/Cesium). Nothing here is persisted or uploaded; the
// network layer decides what leaves the page.

import {
  cotAffiliation,
  cotDeleteTarget,
  cotDisplayName,
  cotKind,
  isCotStale,
  serializeCotEvent,
} from './protocol/cot.js';

export const DEFAULT_CONTACT_LIMIT = 2000;
export const DEFAULT_CHAT_LIMIT = 500;
export const DEFAULT_TRAIL_POINTS = 32;
/** How long a stale contact stays (greyed) before the sweep removes it. */
export const DEFAULT_STALE_RETAIN_MS = 10 * 60 * 1000;

/**
 * @typedef {object} TakContact
 * @property {string} uid
 * @property {string} callsign
 * @property {string} type
 * @property {string} kind cotKind()
 * @property {string} affiliation cotAffiliation()
 * @property {{lat:number, lon:number, hae:?number, ce:?number, le:?number}} point
 * @property {import('./protocol/cot.js').CotEvent} event Latest accepted event.
 * @property {'self'|'local'|'network'|'import'} origin
 * @property {number} receivedAtMs
 * @property {{lat:number, lon:number, timeMs:number}[]} trail Oldest first.
 * @property {boolean} emergency
 */

/**
 * @typedef {object} TakChatMessage
 * @property {string} id messageId (or event uid)
 * @property {string} chatroom
 * @property {string} senderUid
 * @property {string} senderCallsign
 * @property {string} text
 * @property {number} timeMs
 * @property {boolean} outgoing
 */

function senderUidOf(event) {
  const link = event.detail.links.find((l) => l.relation === 'p-p');
  if (link) return link.uid;
  // GeoChat.<senderUid>.<room>.<messageId>; ATAK sender uids carry no dots.
  if (!event.uid.startsWith('GeoChat.')) return '';
  return event.uid.slice(8).split('.')[0] || '';
}

const chatKey = ({ senderUid, chatroom, id }) =>
  JSON.stringify([senderUid, chatroom, id]);

export function createTakStore({
  limit = DEFAULT_CONTACT_LIMIT,
  chatLimit = DEFAULT_CHAT_LIMIT,
  trailPoints = DEFAULT_TRAIL_POINTS,
  staleRetainMs = DEFAULT_STALE_RETAIN_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, TakContact>} insertion order = least recently updated first */
  const contacts = new Map();
  /** @type {TakChatMessage[]} */
  const chats = [];
  const chatIds = new Set();
  const listeners = new Set();
  let selfUid = null;
  let batching = 0;
  let dirty = false;
  let destroyed = false;

  function publish() {
    if (batching) {
      dirty = true;
      return;
    }
    dirty = false;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Listener faults must not corrupt state delivery to others.
      }
    }
  }

  function upsertContact(event, origin) {
    const prior = contacts.get(event.uid);
    if (prior && event.timeMs < prior.event.timeMs) return false;
    if (
      prior &&
      event.timeMs === prior.event.timeMs &&
      serializeCotEvent(event) === serializeCotEvent(prior.event)
    )
      return false;
    const point = event.point;
    let trail = prior ? prior.trail : [];
    const last = trail[trail.length - 1];
    if (
      cotKind(event.type) === 'sa' &&
      (!last ||
        last.lat !== point.lat ||
        last.lon !== point.lon ||
        last.hae !== point.hae)
    ) {
      trail = [
        ...trail,
        {
          lat: point.lat,
          lon: point.lon,
          hae: point.hae,
          timeMs: event.timeMs,
        },
      ].slice(-trailPoints);
    }
    const contact = Object.freeze({
      uid: event.uid,
      callsign: cotDisplayName(event),
      type: event.type,
      kind: cotKind(event.type),
      affiliation: cotAffiliation(event.type),
      point,
      event,
      origin: event.uid === selfUid ? 'self' : origin,
      receivedAtMs: now(),
      trail,
      emergency: !!event.detail.emergency && !event.detail.emergency.cancel,
    });
    contacts.delete(event.uid);
    contacts.set(event.uid, contact);
    while (contacts.size > limit) {
      // Evict the least recently updated contact that is not ourselves.
      let victim = null;
      for (const key of contacts.keys()) {
        if (key !== selfUid) {
          victim = key;
          break;
        }
      }
      if (victim === null) break;
      contacts.delete(victim);
    }
    return true;
  }

  function addChat(event) {
    const chat = event.detail.chat;
    const id = chat?.messageId || event.uid;
    const senderUid = senderUidOf(event);
    const chatroom = chat?.chatroom || chat?.id || 'All Chat Rooms';
    const key = chatKey({ senderUid, chatroom, id });
    if (chatIds.has(key)) return false;
    chats.push(
      Object.freeze({
        id,
        chatroom,
        senderUid,
        senderCallsign: chat?.senderCallsign || senderUid || 'Unknown',
        text: event.detail.remarks?.text || '',
        timeMs: event.detail.remarks?.timeMs ?? event.timeMs,
        outgoing: !!selfUid && senderUid === selfUid,
      }),
    );
    chatIds.add(key);
    while (chats.length > chatLimit) chatIds.delete(chatKey(chats.shift()));
    return true;
  }

  /**
   * Apply one event. Returns what happened, for status reporting.
   * @param {import('./protocol/cot.js').CotEvent} event
   * @param {'local'|'network'|'import'} [origin]
   * @returns {'contact'|'chat'|'deleted'|'cancelled'|'ignored'}
   */
  function apply(event, origin = 'network') {
    if (destroyed) return 'ignored';
    const kind = cotKind(event.type);
    if (kind === 'ping') return 'ignored';
    if (kind === 'delete') {
      const target = cotDeleteTarget(event);
      if (target && target !== selfUid && contacts.delete(target)) {
        publish();
        return 'deleted';
      }
      return 'ignored';
    }
    if (kind === 'chat') {
      // Delivery/read receipts are protocol control, not message bodies. They
      // must not occupy the message's dedup slot before its text arrives.
      if (event.type !== 'b-t-f') return 'ignored';
      if (!addChat(event)) return 'ignored';
      publish();
      return 'chat';
    }
    if (event.type === 'b-a-o-can') {
      // Cancel: the alert uid is "<sender>-9-1-1".
      if (contacts.delete(event.uid)) {
        publish();
        return 'cancelled';
      }
      return 'ignored';
    }
    if (!event.point) return 'ignored';
    if (!upsertContact(event, origin)) return 'ignored';
    publish();
    return 'contact';
  }

  return Object.freeze({
    apply,
    /** Apply many events with a single notification. */
    applyAll(events, origin) {
      const result = {
        contact: 0,
        chat: 0,
        deleted: 0,
        cancelled: 0,
        ignored: 0,
      };
      batching++;
      try {
        for (const event of events) result[apply(event, origin)]++;
      } finally {
        batching--;
      }
      if (dirty) publish();
      return result;
    },
    setSelfUid(uid) {
      if (destroyed) return;
      selfUid = uid || null;
    },
    selfUid: () => selfUid,
    get: (uid) => contacts.get(uid) || null,
    count: () => contacts.size,
    /** Contacts sorted for display: emergencies, self, then callsign. */
    list() {
      return Array.from(contacts.values()).sort(
        (a, b) =>
          Number(b.emergency) - Number(a.emergency) ||
          Number(b.origin === 'self') - Number(a.origin === 'self') ||
          a.callsign.localeCompare(b.callsign) ||
          a.uid.localeCompare(b.uid),
      );
    },
    chats: (chatroom = null) =>
      chatroom ? chats.filter((c) => c.chatroom === chatroom) : chats.slice(),
    isStale: (contact) => isCotStale(contact?.event, now()),
    remove(uid) {
      if (destroyed) return false;
      if (!contacts.delete(uid)) return false;
      publish();
      return true;
    },
    /** Drop contacts stale for longer than the retain window. */
    sweep() {
      if (destroyed) return 0;
      const cutoff = now() - staleRetainMs;
      let removed = 0;
      for (const [uid, contact] of contacts) {
        if (uid === selfUid) continue;
        if (contact.event.staleMs <= cutoff) {
          contacts.delete(uid);
          removed++;
        }
      }
      if (removed) publish();
      return removed;
    },
    clear() {
      if (!contacts.size && !chats.length) return;
      contacts.clear();
      chats.length = 0;
      chatIds.clear();
      publish();
    },
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      listeners.clear();
      contacts.clear();
      chats.length = 0;
      chatIds.clear();
      selfUid = null;
    },
  });
}
