// Browser account context only: no tokens, cookies, locations or tactical data.
export const OPERATOR_ACTIVE_KEY = 'gev.tak.operator-active.v1';
export const OPERATOR_OFFLINE_KEY = 'gev.tak.operator-offline.v1';
const SCOPE = /^[a-f0-9]{64}$/;
const PRINCIPAL = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_RECORD_LENGTH = 1024;
const blocked = (reason, sessionExpired = false) =>
  Object.freeze({
    storageAllowed: false,
    online: false,
    multiOperator: false,
    storageScope: null,
    principal: null,
    role: null,
    gateway: null,
    reason,
    sessionExpired,
  });
function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}
const fingerprint = (context) =>
  context?.storageAllowed
    ? context.multiOperator
      ? `${context.storageScope}:${context.principal}:${context.role}`
      : 'legacy'
    : null;
function contextFromStatus(value, online = true) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.enabled !== 'boolean'
  )
    throw new Error('Invalid operator status');
  if (value.multiOperator === true) {
    if (
      value.enabled !== true ||
      value.sessionAuthenticated !== true ||
      typeof value.principal !== 'string' ||
      !PRINCIPAL.test(value.principal) ||
      typeof value.storageScope !== 'string' ||
      !SCOPE.test(value.storageScope) ||
      !['operator', 'observer'].includes(value.role)
    )
      throw new Error('Invalid named operator status');
    return Object.freeze({
      storageAllowed: true,
      online,
      multiOperator: true,
      storageScope: value.storageScope,
      principal: value.principal,
      role: value.role,
      gateway: online ? Object.freeze({ ...value }) : null,
    });
  }
  if (
    (value.multiOperator !== undefined && value.multiOperator !== false) ||
    value.storageScope !== undefined ||
    value.role !== undefined ||
    (value.principal !== undefined && value.principal !== 'local-operator') ||
    (value.sessionAuthenticated !== undefined &&
      typeof value.sessionAuthenticated !== 'boolean')
  )
    throw new Error('Ambiguous operator status');
  return Object.freeze({
    storageAllowed: true,
    online,
    multiOperator: false,
    storageScope: null,
    principal: 'local-operator',
    role: null,
    gateway: online ? Object.freeze({ ...value }) : null,
  });
}
function metadata(context) {
  return {
    version: 1,
    multiOperator: context.multiOperator,
    principal: context.principal,
    role: context.role,
    storageScope: context.storageScope,
  };
}
function parseMetadata(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_RECORD_LENGTH) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1) return null;
    return contextFromStatus(
      {
        enabled: true,
        sessionAuthenticated: true,
        ...(value.multiOperator === true
          ? {
              multiOperator: true,
              principal: value.principal,
              role: value.role,
              storageScope: value.storageScope,
            }
          : value.multiOperator === false &&
              value.storageScope === null &&
              value.role === null &&
              value.principal === 'local-operator'
            ? {}
            : { multiOperator: 'invalid' }),
      },
      false,
    );
  } catch {
    return null;
  }
}
async function boundedText(response, limit) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit)
      throw new Error('Operator status exceeds its budget');
    return text;
  }
  const reader = response.body.getReader(),
    parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Operator status exceeds its budget');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
/** Migration only: a pre-account saved shell must already exist, never create it. */
export async function hasLegacyOfflineShell({
  cachesRef = globalThis.caches,
  origin = globalThis.location?.origin,
} = {}) {
  try {
    if (
      !origin ||
      !cachesRef?.has ||
      !(await cachesRef.has('gev-offline-shell-state-v1'))
    )
      return false;
    const response = await (
      await cachesRef.open('gev-offline-shell-state-v1')
    ).match(new URL('/__gev_offline_shell_state__', origin).href);
    if (!response) return false;
    const state = JSON.parse(await boundedText(response, 1024 * 1024));
    return (
      /^gev-offline-shell-v1-[a-f0-9-]+$/.test(state?.cacheName) &&
      /^[a-f0-9]{64}$/.test(state.revision) &&
      Array.isArray(state.files) &&
      state.files.length <= 4096 &&
      state.files.includes('/index.html') &&
      (await cachesRef.has(state.cacheName))
    );
  } catch {
    return false;
  }
}
/** Injectable lifecycle owner for context resolution, approval and cross-tab retirement. */
export function createOperatorContextManager({
  fetchImpl = globalThis.fetch,
  storage = defaultStorage(),
  eventTarget = globalThis.window,
  timeoutMs = 5000,
  hasLegacyShell = hasLegacyOfflineShell,
} = {}) {
  let current = null,
    pending = null,
    destroyed = false,
    retiredIdentity = null;
  const listeners = new Set();
  const read = (key) => {
    try {
      return storage?.getItem ? storage.getItem(key) : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (key, value) => {
    if (!storage?.setItem) throw new Error('Account storage is unavailable');
    storage.setItem(key, value);
  };
  const remove = (key) => {
    try {
      storage?.removeItem(key);
    } catch {}
  };
  function isCurrent(value) {
    if (!current?.storageAllowed || current !== value || destroyed)
      return false;
    const raw = read(OPERATOR_ACTIVE_KEY);
    if (raw === undefined) return current.online;
    try {
      return (
        raw?.length <= MAX_RECORD_LENGTH &&
        JSON.parse(raw)?.identity === fingerprint(current)
      );
    } catch {
      return false;
    }
  }
  function refuse(reason, expired = false, expectedActive) {
    // A retired tab's late response cannot revoke the new tab's approval.
    if (current || destroyed) return current ?? blocked(reason, expired);
    if (read(OPERATOR_ACTIVE_KEY) !== expectedActive)
      return blocked('Operator account changed while resolving status');
    remove(OPERATOR_OFFLINE_KEY);
    try {
      write(
        OPERATOR_ACTIVE_KEY,
        JSON.stringify({ version: 1, multiOperator: true, identity: null }),
      );
    } catch {}
    return blocked(reason, expired);
  }
  function invalidate(reason = 'Operator account changed') {
    if (destroyed || (current && !current.storageAllowed)) return;
    retiredIdentity = fingerprint(current) ?? retiredIdentity;
    current = blocked(reason);
    for (const listener of listeners) {
      try {
        listener(reason);
      } catch {}
    }
  }
  function onStorage(event) {
    if (
      (event.key !== OPERATOR_ACTIVE_KEY && event.key !== null) ||
      (event.storageArea && event.storageArea !== storage)
    )
      return;
    let next;
    try {
      next =
        event.newValue?.length <= MAX_RECORD_LENGTH
          ? JSON.parse(event.newValue)
          : null;
    } catch {
      next = null;
    }
    if (next?.identity !== fingerprint(current))
      invalidate('Operator account changed in another tab');
  }
  eventTarget?.addEventListener?.('storage', onStorage);
  function publish(context) {
    const approval = parseMetadata(read(OPERATOR_OFFLINE_KEY));
    if (approval && fingerprint(approval) !== fingerprint(context))
      remove(OPERATOR_OFFLINE_KEY);
    try {
      write(
        OPERATOR_ACTIVE_KEY,
        JSON.stringify({
          version: 1,
          multiOperator: context.multiOperator,
          identity: fingerprint(context),
        }),
      );
    } catch {
      /* Online use may remain ephemeral without browser persistence. */
    }
  }
  async function resolve(signal) {
    signal?.throwIfAborted();
    if (destroyed) return blocked('Operator context is closed');
    if (current) return current;
    if (!pending)
      pending = (async () => {
        const initialActive = read(OPERATOR_ACTIVE_KEY);
        const controller = new AbortController();
        let timer;
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(
            () => {
              const error = new DOMException(
                'Operator server unreachable',
                'TimeoutError',
              );
              controller.abort(error);
              reject(error);
            },
            Math.max(1, Math.min(timeoutMs, 15000)),
          );
        });
        let response;
        try {
          try {
            response = await Promise.race([
              fetchImpl('/api/tak/status', {
                credentials: 'same-origin',
                cache: 'no-store',
                redirect: 'error',
                signal: controller.signal,
              }),
              deadline,
            ]);
          } catch {
            const approval = parseMetadata(read(OPERATOR_OFFLINE_KEY));
            const active = read(OPERATOR_ACTIVE_KEY);
            if (active !== initialActive)
              return blocked('Operator account changed while resolving status');
            if (approval) {
              try {
                if (
                  active?.length <= MAX_RECORD_LENGTH &&
                  JSON.parse(active)?.identity === fingerprint(approval)
                )
                  return approval;
              } catch {}
              return blocked(
                'Offline approval no longer matches the active account',
              );
            }
            let legacy = active === null;
            try {
              const record = JSON.parse(active);
              legacy ||=
                record?.version === 1 &&
                record.multiOperator === false &&
                record.identity === 'legacy';
            } catch {}
            if (legacy) {
              let legacyTimer;
              const saved = await Promise.race([
                Promise.resolve()
                  .then(hasLegacyShell)
                  .catch(() => false),
                new Promise((resolve) => {
                  legacyTimer = setTimeout(() => resolve(false), 1000);
                }),
              ]).finally(() => clearTimeout(legacyTimer));
              if (saved) {
                const context = contextFromStatus({ enabled: false }, false);
                if (!current) publish(context);
                return context;
              }
            }
            return blocked(
              'Reconnect and sign in before opening account storage',
            );
          }
          if (response.status === 401 || response.status === 403) {
            return refuse('Operator session expired', true, initialActive);
          }
          if (!response.ok || response.status !== 200)
            return refuse('Operator status was refused', false, initialActive);
          try {
            const context = contextFromStatus(
              JSON.parse(
                await Promise.race([
                  boundedText(response, MAX_STATUS_BYTES),
                  deadline,
                ]),
              ),
            );
            if (read(OPERATOR_ACTIVE_KEY) !== initialActive) {
              try {
                if (
                  JSON.parse(read(OPERATOR_ACTIVE_KEY))?.identity !==
                  fingerprint(context)
                )
                  return blocked(
                    'Operator account changed while resolving status',
                  );
              } catch {
                return blocked(
                  'Operator account changed while resolving status',
                );
              }
            }
            if (!current) publish(context);
            return context;
          } catch {
            return refuse(
              'Operator status could not be validated',
              false,
              initialActive,
            );
          }
        } finally {
          clearTimeout(timer);
        }
      })().then((result) => {
        if (!destroyed && !current) current = result;
        return current ?? blocked('Operator context is closed');
      });
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      const abort = () =>
        reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener('abort', abort);
          if (!signal.aborted) resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  }
  return Object.freeze({
    resolve,
    current: () => current,
    isCurrent,
    identityStorageKey(base = 'gev.tak.identity.v1') {
      if (typeof base !== 'string' || !base || base.length > 100)
        throw new Error('Invalid identity storage key');
      return isCurrent(current)
        ? current.multiOperator
          ? `${base}.${current.storageScope}`
          : base
        : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activateOffline() {
      if (!isCurrent(current) || !current.online)
        throw new Error(
          'Sign in online before approving offline account access',
        );
      write(OPERATOR_OFFLINE_KEY, JSON.stringify(metadata(current)));
      return current;
    },
    clearOffline({ invalidateContext = true } = {}) {
      const expected = fingerprint(current) ?? retiredIdentity;
      let owns = false;
      try {
        owns =
          !!expected &&
          JSON.parse(read(OPERATOR_ACTIVE_KEY))?.identity === expected;
      } catch {}
      // Retiring an old tab must not erase a newly signed-in account's approval.
      if (owns) remove(OPERATOR_OFFLINE_KEY);
      if (invalidateContext && owns) {
        try {
          write(
            OPERATOR_ACTIVE_KEY,
            JSON.stringify({
              version: 1,
              multiOperator: current?.multiOperator === true,
              identity: null,
            }),
          );
        } catch {}
      }
      if (invalidateContext) invalidate('Operator offline access cleared');
    },
    invalidate,
    destroy() {
      if (destroyed) return;
      invalidate('Operator context closed');
      destroyed = true;
      eventTarget?.removeEventListener?.('storage', onStorage);
      listeners.clear();
    },
  });
}
let shared;
const manager = (options) => (shared ||= createOperatorContextManager(options));
export const resolveOperatorContext = (options = {}) =>
  manager(options).resolve(options.signal);
export const getResolvedOperatorContext = () => shared?.current() ?? null;
export const isOperatorContextCurrent = (context) =>
  shared?.isCurrent(context) === true;
export const identityStorageKey = (base) => manager().identityStorageKey(base);
export const subscribeOperatorContextInvalidation = (listener) =>
  manager().subscribe(listener);
export const activateOfflineOperatorContext = () => manager().activateOffline();
export const clearOfflineOperatorContext = (options) =>
  manager().clearOffline(options);
