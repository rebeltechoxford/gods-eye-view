// Session-only submission metadata. No payloads, positions, credentials or peer
// receipt claims are retained. A socket write is not an application-level ACK.
export const SUBMISSION_LIMIT = 200;
export const SUBMISSION_WINDOW_MS = 30_000;
export const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATES = new Set(['queued', 'submitted', 'rejected', 'expired']);
const TERMINAL = new Set(['submitted', 'rejected', 'expired']);

export function summarizeSubmission(routes) {
  return routes.some((route) => route.state === 'queued')
    ? 'queued'
    : routes.some((route) => route.state === 'submitted')
      ? 'submitted'
      : routes.length && routes.every((route) => route.state === 'expired')
        ? 'expired'
        : 'rejected';
}

export function createSubmissionStore({ now = Date.now } = {}) {
  const records = new Map();
  function replace(record) {
    records.set(record.id, Object.freeze(record));
    while (records.size > SUBMISSION_LIMIT)
      records.delete(records.keys().next().value);
  }
  return Object.freeze({
    add({ id, uid, kind, staleMs, sent }) {
      const at = now();
      replace({
        id,
        uid,
        kind,
        state: sent ? 'pending' : 'rejected',
        reason: sent
          ? 'Awaiting gateway authorization'
          : 'Not connected or browser send buffer full; kept local',
        routes: Object.freeze([]),
        createdAtMs: at,
        updatedAtMs: at,
        expiresAtMs: Math.min(staleMs, at + SUBMISSION_WINDOW_MS),
      });
    },
    update(message) {
      const prior = records.get(message?.id);
      if (
        !prior ||
        TERMINAL.has(prior.state) ||
        !STATES.has(message.state) ||
        !Array.isArray(message.routes) ||
        message.routes.length > 2
      )
        return false;
      const routes = [];
      const seen = new Set();
      for (const route of message.routes) {
        if (
          !['server', 'mesh'].includes(route?.id) ||
          seen.has(route.id) ||
          !STATES.has(route.state) ||
          (route.reason !== undefined &&
            (typeof route.reason !== 'string' || route.reason.length > 240))
        )
          return false;
        seen.add(route.id);
        routes.push(
          Object.freeze({
            id: route.id,
            state: route.state,
            ...(route.reason ? { reason: route.reason } : {}),
          }),
        );
      }
      if (
        message.reason !== undefined &&
        (typeof message.reason !== 'string' || message.reason.length > 240)
      )
        return false;
      if (summarizeSubmission(routes) !== message.state) return false;
      replace({
        ...prior,
        state: message.state,
        reason: message.reason || '',
        routes: Object.freeze(routes),
        updatedAtMs: now(),
      });
      return true;
    },
    interrupt() {
      for (const record of records.values())
        if (!TERMINAL.has(record.state)) {
          const routes = Object.freeze(
            record.routes.map((route) =>
              route.state === 'queued'
                ? Object.freeze({
                    ...route,
                    state: 'rejected',
                    reason:
                      'Browser connection ended; unwritten attempt cancelled',
                  })
                : route,
            ),
          );
          replace({
            ...record,
            state: summarizeSubmission(routes),
            routes,
            reason:
              'Browser connection ended; peer receipt unconfirmed and will not be retried',
            updatedAtMs: now(),
          });
        }
    },
    sweep() {
      let changed = false;
      for (const record of records.values())
        if (!TERMINAL.has(record.state) && record.expiresAtMs <= now()) {
          const routes = Object.freeze(
            record.routes.map((route) =>
              route.state === 'queued'
                ? Object.freeze({
                    ...route,
                    state: 'expired',
                    reason: 'Fresh submission window expired',
                  })
                : route,
            ),
          );
          replace({
            ...record,
            state: routes.some((route) => route.state === 'submitted')
              ? 'submitted'
              : 'expired',
            routes,
            reason: 'Fresh submission window expired; peer receipt unconfirmed',
            updatedAtMs: now(),
          });
          changed = true;
        }
      return changed;
    },
    list: () => Array.from(records.values()),
    clear: () => records.clear(),
  });
}
