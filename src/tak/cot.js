// Independent browser-side Cursor on Target (CoT) interchange.
// No ATAK-CIV application source is incorporated into this MIT-licensed module.
export const MAX_COT_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_COT_EVENTS = 1000;

function safeText(value, maxLength = 128) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function finiteCoordinate(value, min, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : null;
}

function parseTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function cotAffiliation(type) {
  const code = safeText(type).split('-');
  if (code[0] !== 'a') return 'marker';
  switch (code[1]) {
    case 'f':
      return 'friendly';
    case 'h':
      return 'hostile';
    case 'n':
      return 'neutral';
    case 'u':
      return 'unknown';
    default:
      return 'unknown';
  }
}

/** Normalize only geographic CoT events. Unusable records are rejected. */
export function normalizeCotRecord(input, receivedAtMs = Date.now()) {
  if (!input || typeof input !== 'object') return null;
  // Never truncate an identity: distinct long UIDs must not become one contact.
  const uid = String(input.uid ?? '').trim();
  const lat = finiteCoordinate(input.lat, -90, 90);
  const lon = finiteCoordinate(input.lon, -180, 180);
  if (!uid || uid.length > 160 || lat === null || lon === null) return null;
  const type = safeText(input.type || 'b-m-p-s-p-i');
  const altitudeM = finiteCoordinate(input.hae, -10000, 1000000);
  const eventTimeMs = parseTimestamp(input.time);
  const staleAtMs = parseTimestamp(input.stale);
  const callsign = safeText(input.callsign || uid, 120);
  return Object.freeze({
    uid,
    callsign,
    type,
    affiliation: cotAffiliation(type),
    lat,
    lon,
    altitudeM,
    how: safeText(input.how || 'h-g-i-g-o'),
    eventTimeMs,
    staleAtMs,
    receivedAtMs,
  });
}

function childByLocalName(parent, name) {
  return (
    Array.from(parent?.children || []).find(
      (node) => node.localName === name,
    ) || null
  );
}

/**
 * Parse an individual CoT event or an offline collection of events.
 * Live TCP/TLS and authentication deliberately do not run in the browser.
 * Inject parseXml only for tests; in production DOMParser is used.
 */
export function parseCotXml(xml, { parseXml } = {}) {
  if (typeof xml !== 'string' || !xml.trim()) {
    throw new Error('Provide a CoT XML document.');
  }
  if (new TextEncoder().encode(xml).byteLength > MAX_COT_DOCUMENT_BYTES) {
    throw new Error('CoT import exceeds the 1 MiB limit.');
  }
  // Browser DOMParser is not a general-purpose safe XML network parser.
  // Refuse entity declarations and DTDs before passing the data to it.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('CoT documents cannot contain DTD or entity declarations.');
  }
  const parse =
    parseXml ||
    ((value) => new DOMParser().parseFromString(value, 'application/xml'));
  const document = parse(xml);
  if (!document || typeof document.getElementsByTagName !== 'function') {
    throw new Error('Invalid CoT XML document.');
  }
  if (document.getElementsByTagName('parsererror').length) {
    throw new Error('Malformed CoT XML document.');
  }
  const eventNodes = Array.from(document.getElementsByTagName('*')).filter(
    (node) => node.localName === 'event',
  );
  if (!eventNodes.length) throw new Error('No CoT events found.');
  if (eventNodes.length > MAX_COT_EVENTS) {
    throw new Error('CoT document contains too many events.');
  }
  const contacts = [];
  let rejected = 0;
  for (const event of eventNodes) {
    const point = childByLocalName(event, 'point');
    const contact = childByLocalName(
      childByLocalName(event, 'detail'),
      'contact',
    );
    const record = normalizeCotRecord({
      uid: event.getAttribute('uid'),
      type: event.getAttribute('type'),
      how: event.getAttribute('how'),
      time: event.getAttribute('time'),
      stale: event.getAttribute('stale'),
      lat: point?.getAttribute('lat'),
      lon: point?.getAttribute('lon'),
      hae: point?.getAttribute('hae'),
      callsign: contact?.getAttribute('callsign'),
    });
    if (record) contacts.push(record);
    else rejected++;
  }
  if (!contacts.length) throw new Error('No CoT events with valid positions.');
  return { contacts, rejected };
}
