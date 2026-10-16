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
  byteLength,
} from './protocol/cot.js';

export const DEFAULT_CONTACT_LIMIT = 2000;
export const DEFAULT_CHAT_LIMIT = 500;
export const DEFAULT_TRAIL_POINTS = 32;
export const DEFAULT_CONTACT_BYTES_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_XML_NODE_LIMIT = 100_000;
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

/** Count distinct retained XML objects, including preserved parsed extensions. */
function retainedXmlNodes(event, maximum) {
  const pending = [...(event.detail.extras || [])];
  if (event.detail.raw) pending.push(event.detail.raw);
  const seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (seen.size > maximum) return seen.size;
    if (Array.isArray(node.children)) pending.push(...node.children);
  }
  return seen.size;
}

export function createTakStore({
  limit = DEFAULT_CONTACT_LIMIT,
  chatLimit = DEFAULT_CHAT_LIMIT,
  trailPoints = DEFAULT_TRAIL_POINTS,
  byteLimit = DEFAULT_CONTACT_BYTES_LIMIT,
  xmlNodeLimit = DEFAULT_XML_NODE_LIMIT,
  staleRetainMs = DEFAULT_STALE_RETAIN_MS,
  now = Date.now,
} = {}) {
  /** @type {Map<string, TakContact>} insertion order = least recently updated first */
  const contacts = new Map();
  const contactResources = new Map();
  let serializedBytes = 0;
  let xmlNodes = 0;
  let evictedContacts = 0;
  let rejectedContacts = 0;
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

  function forgetContact(uid) {
    if (!contacts.delete(uid)) return false;
    const cost = contactResources.get(uid);
    serializedBytes -= cost.bytes;
    xmlNodes -= cost.nodes;
    contactResources.delete(uid);
    return true;
  }

  function rejectHeavyContact() {
    rejectedContacts++;
    publish();
    return false;
  }

  function upsertContact(event, origin) {
    const prior = contacts.get(event.uid);
    if (prior && event.timeMs < prior.event.timeMs) return false;
    let xml;
    try {
      xml = serializeCotEvent(event);
    } catch {
      return rejectHeavyContact();
    }
    if (
      prior &&
      event.timeMs === prior.event.timeMs &&
      xml === serializeCotEvent(prior.event)
    )
      return false;
    const cost = {
      bytes: byteLength(xml),
      nodes: retainedXmlNodes(event, xmlNodeLimit),
    };
    if (cost.bytes > byteLimit || cost.nodes > xmlNodeLimit || limit < 1)
      return rejectHeavyContact();
    const priorCost = contactResources.get(event.uid);
    let proposedBytes = serializedBytes - (priorCost?.bytes || 0) + cost.bytes;
    let proposedNodes = xmlNodes - (priorCost?.nodes || 0) + cost.nodes;
    let proposedCount = contacts.size + (prior ? 0 : 1);
    const exceeds = () =>
      proposedCount > limit ||
      proposedBytes > byteLimit ||
      proposedNodes > xmlNodeLimit;
    const victims = [];
    for (const uid of contacts.keys()) {
      if (!exceeds()) break;
      if (uid === selfUid || uid === event.uid) continue;
      const removed = contactResources.get(uid);
      proposedBytes -= removed.bytes;
      proposedNodes -= removed.nodes;
      proposedCount--;
      victims.push(uid);
    }
    // A protected self contact still counts toward every resource limit. Refuse
    // an update before changing prior contacts when no eviction can make it fit.
    if (exceeds()) return rejectHeavyContact();
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
    for (const uid of victims) {
      forgetContact(uid);
      evictedContacts++;
    }
    forgetContact(event.uid);
    contacts.set(event.uid, contact);
    contactResources.set(event.uid, cost);
    serializedBytes += cost.bytes;
    xmlNodes += cost.nodes;
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
      if (event.timeMs < (contacts.get(target)?.event.timeMs ?? -Infinity))
        return 'ignored';
      if (target && target !== selfUid && forgetContact(target)) {
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
      if (event.timeMs < (contacts.get(event.uid)?.event.timeMs ?? -Infinity))
        return 'ignored';
      if (forgetContact(event.uid)) {
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
    resourceStats: () => ({
      contacts: contacts.size,
      serializedBytes,
      xmlNodes,
      contactLimit: limit,
      byteLimit,
      xmlNodeLimit,
      evictedContacts,
      rejectedContacts,
    }),
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
      if (!forgetContact(uid)) return false;
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
          forgetContact(uid);
          removed++;
        }
      }
      if (removed) publish();
      return removed;
    },
    clear() {
      if (!contacts.size && !chats.length) return;
      contacts.clear();
      contactResources.clear();
      serializedBytes = 0;
      xmlNodes = 0;
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
      contactResources.clear();
      serializedBytes = 0;
      xmlNodes = 0;
      chats.length = 0;
      chatIds.clear();
      selfUid = null;
    },
  });
}
