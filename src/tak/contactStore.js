// Session-only CoT contact state; no persistent location storage or uploads.
export function createCotStore({ limit = 1000, now = Date.now } = {}) {
  const records = new Map();
  const listeners = new Set();
  function publish() {
    for (const listener of listeners) listener();
  }
  function list() {
    return Array.from(records.values()).sort((a, b) =>
      a.callsign.localeCompare(b.callsign) || a.uid.localeCompare(b.uid));
  }
  return Object.freeze({
    list,
    count: () => records.size,
    get: (uid) => records.get(uid) || null,
    ingest(incoming) {
      let accepted = 0;
      let ignored = 0;
      for (const contact of incoming) {
        if (!contact?.uid || !Number.isFinite(contact.lat) ||
            !Number.isFinite(contact.lon)) {
          ignored++;
          continue;
        }
        const prior = records.get(contact.uid);
        if (prior && prior.eventTimeMs !== null &&
            contact.eventTimeMs !== null &&
            contact.eventTimeMs < prior.eventTimeMs) {
          ignored++;
          continue;
        }
        records.delete(contact.uid);
        records.set(contact.uid, contact);
        accepted++;
        while (records.size > limit) {
          const oldest = records.keys().next().value;
          records.delete(oldest);
        }
      }
      if (accepted) publish();
      return { accepted, ignored };
    },
    clear() {
      if (!records.size) return;
      records.clear();
      publish();
    },
    isStale(contact) {
      return contact?.staleAtMs !== null && contact?.staleAtMs <= now();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
      records.clear();
    },
  });
}
