import {
  byteLength,
  parseCotEvent,
  serializeCotEvent,
} from './protocol/cot.js';
import { createTakStore } from './store.js';

export const PICTURE_MAX_BYTES = 1024 * 1024;
export const PICTURE_MAX_CONTACTS = 500;
const origins = new Set(['local', 'network', 'import']);
const timestamp = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

/** Explicitly capture latest contacts, never own GPS, chat or send ownership. */
export function captureTakPicture(contacts, { selfUid, now = Date.now } = {}) {
  const rows = contacts.filter(
    (contact) => contact.uid !== selfUid && contact.origin !== 'self',
  );
  if (!rows.length)
    throw new Error('No contacts or drawings to save. Own GPS is excluded.');
  if (rows.length > PICTURE_MAX_CONTACTS)
    throw new Error(
      `A device picture holds at most ${PICTURE_MAX_CONTACTS} contacts.`,
    );
  const payload = JSON.stringify({
    version: 1,
    savedAtMs: now(),
    contacts: rows.map((contact) => ({
      xml: serializeCotEvent(contact.event),
      receivedAtMs: contact.receivedAtMs,
      origin: contact.origin,
    })),
  });
  // Use the same validation as restoration, including the full encoded budget.
  readTakPicture(payload);
  return payload;
}

/** Parse a bounded historical picture without touching the live client/store. */
export function readTakPicture(payload) {
  if (typeof payload !== 'string' || byteLength(payload) > PICTURE_MAX_BYTES)
    throw new Error('Device picture exceeds the 1 MiB limit.');
  let value;
  try {
    value = JSON.parse(payload);
  } catch {
    throw new Error('Device picture is not valid JSON.');
  }
  if (
    value?.version !== 1 ||
    !timestamp(value.savedAtMs) ||
    !Array.isArray(value.contacts) ||
    !value.contacts.length ||
    value.contacts.length > PICTURE_MAX_CONTACTS
  )
    throw new Error('Device picture has an invalid header or contact count.');
  const store = createTakStore({
    limit: PICTURE_MAX_CONTACTS,
    byteLimit: PICTURE_MAX_BYTES,
  });
  const contacts = [];
  const seen = new Set();
  try {
    for (const row of value.contacts) {
      if (!timestamp(row?.receivedAtMs) || !origins.has(row?.origin))
        throw new Error('Device picture has invalid contact provenance.');
      const event = parseCotEvent(row.xml);
      if (seen.has(event.uid) || store.apply(event, 'import') !== 'contact')
        throw new Error(
          'Device picture contains duplicate or unsupported events.',
        );
      seen.add(event.uid);
      const contact = store.get(event.uid);
      contacts.push(
        Object.freeze({
          ...contact,
          callsign: `HISTORY · ${contact.callsign}`,
          origin: 'snapshot',
          receivedAtMs: row.receivedAtMs,
          historical: Object.freeze({
            savedAtMs: value.savedAtMs,
            source: row.origin,
          }),
        }),
      );
    }
    if (
      store.count() !== contacts.length ||
      store.resourceStats().evictedContacts
    )
      throw new Error(
        'Device picture exceeds the geometry or XML resource budget.',
      );
    return Object.freeze({
      savedAtMs: value.savedAtMs,
      contacts: Object.freeze(contacts),
    });
  } finally {
    store.destroy();
  }
}
