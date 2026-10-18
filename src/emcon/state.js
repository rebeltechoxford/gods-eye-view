// EMCON (emissions control) state: one persisted flag that every part of
// the app reads synchronously, so a reload or cold launch starts silent
// before any module can reach the network. Other tabs follow changes
// through the storage event, so no open tab keeps transmitting.

export const EMCON_STORAGE_KEY = 'gev.emcon.v1';

function storageOf(target) {
  try {
    return target?.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Parse a stored record; anything unreadable counts as EMCON off. */
export function parseEmconRecord(text) {
  if (typeof text !== 'string' || text.length > 512) return null;
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1 || value.active !== true) return null;
    const since = Date.parse(value.since);
    return Object.freeze({
      active: true,
      since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    });
  } catch {
    return null;
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.target] The window (tests pass a stand-in).
 * @param {() => number} [options.now]
 */
export function createEmconState({ target = globalThis, now = Date.now } = {}) {
  const storage = storageOf(target);
  let record = null;
  try {
    record = parseEmconRecord(storage?.getItem(EMCON_STORAGE_KEY));
  } catch {
    record = null;
  }
  const listeners = new Set();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener(record);
      } catch {
        /* One faulty listener must not stop the others. */
      }
    }
  };
  const onStorage = (event) => {
    if (event?.key !== EMCON_STORAGE_KEY && event?.key !== null) return;
    if (event?.storageArea && storage && event.storageArea !== storage) return;
    const next = parseEmconRecord(event?.newValue ?? null);
    if (Boolean(next) === Boolean(record)) return;
    record = next;
    notify();
  };
  target?.addEventListener?.('storage', onStorage);

  return Object.freeze({
    /** True while EMCON is on. Cheap enough to call on every request. */
    isActive: () => record !== null,
    current: () => record,
    /**
     * Turn EMCON on or off. Turning it on always takes effect in this tab,
     * even when the device refuses to persist it; the result says whether
     * a reload would keep it.
     */
    set(active) {
      const next = active
        ? Object.freeze({
            active: true,
            since: record?.since ?? new Date(now()).toISOString(),
          })
        : null;
      let persisted = false;
      try {
        if (next)
          storage.setItem(
            EMCON_STORAGE_KEY,
            JSON.stringify({ version: 1, active: true, since: next.since }),
          );
        else storage.removeItem(EMCON_STORAGE_KEY);
        persisted = true;
      } catch {
        persisted = false;
      }
      const changed = Boolean(next) !== Boolean(record);
      record = next;
      if (changed) notify();
      return { active: Boolean(next), persisted };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      listeners.clear();
      target?.removeEventListener?.('storage', onStorage);
    },
  });
}
