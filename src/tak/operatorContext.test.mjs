import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOperatorContextManager,
  OPERATOR_ACTIVE_KEY,
  OPERATOR_OFFLINE_KEY,
  hasLegacyOfflineShell,
} from './operatorContext.js';
import {
  offlineDatabaseName,
  openExistingOfflinePackStore,
  createOfflinePackStore,
} from '../maps/offline/store.js';
import { readSelectedOfflinePack } from '../maps/offline/boot.js';
const A = 'a'.repeat(64),
  B = 'b'.repeat(64);
const status = (storageScope = A, principal = 'alpha', role = 'operator') => ({
  enabled: true,
  sessionAuthenticated: true,
  multiOperator: true,
  storageScope,
  principal,
  role,
});
const response = (value, code = 200) =>
  new Response(JSON.stringify(value), { status: code });
function fixture(fetchImpl = async () => response(status()), options = {}) {
  const values = options.values || new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const events = new EventTarget();
  const manager = createOperatorContextManager({
    fetchImpl,
    storage,
    eventTarget: events,
    hasLegacyShell: async () => false,
    ...options,
  });
  const event = (value, key = OPERATOR_ACTIVE_KEY, { queued = false } = {}) => {
    if (!queued) {
      if (key === null) values.clear();
      else if (value === null) values.delete(key);
      else values.set(key, value);
    }
    const e = new Event('storage');
    Object.assign(e, { key, newValue: value, storageArea: storage });
    events.dispatchEvent(e);
  };
  return { manager, values, storage, event };
}
const networkFailure = async () => {
  throw new TypeError('Failed to fetch');
};
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('one validated same-origin context resolves before identity use, without credentials in persistence', async () => {
  const calls = [];
  const f = fixture(async (...args) => {
    calls.push(args);
    return response(status());
  });
  assert.equal(f.manager.identityStorageKey(), null);
  const [first, second] = await Promise.all([
    f.manager.resolve(),
    f.manager.resolve(),
  ]);
  assert.equal(first, second);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/tak/status');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(f.manager.identityStorageKey(), `gev.tak.identity.v1.${A}`);
  assert.equal(first.principal, 'alpha');
  assert.equal(first.role, 'operator');
  assert(Object.isFrozen(first));
  assert.equal(f.values.has(OPERATOR_OFFLINE_KEY), false);
  f.manager.activateOffline();
  assert.deepEqual(JSON.parse(f.values.get(OPERATOR_OFFLINE_KEY)), {
    version: 1,
    multiOperator: true,
    principal: 'alpha',
    role: 'operator',
    storageScope: A,
  });
  f.manager.destroy();
});

test('different account, role and credential scopes never share identity or IndexedDB names', async () => {
  const a = fixture(),
    b = fixture(async () => response(status(B, 'bravo', 'observer')));
  await a.manager.resolve();
  await b.manager.resolve();
  assert.notEqual(
    a.manager.identityStorageKey(),
    b.manager.identityStorageKey(),
  );
  assert.notEqual(offlineDatabaseName(A), offlineDatabaseName(B));
  assert.equal(offlineDatabaseName(), 'gev-offline-maps-v1');
  for (const bad of ['', '../other', 'A'.repeat(64), 'a'.repeat(65), {}, 1])
    assert.throws(() => offlineDatabaseName(bad), /scope/);
  a.manager.destroy();
  b.manager.destroy();
});

test('named context rejects missing, malformed and ambiguous authority fields', async (t) => {
  for (const [name, value] of [
    ['missing scope', { ...status(), storageScope: undefined }],
    ['upper scope', { ...status(), storageScope: A.toUpperCase() }],
    ['missing principal', { ...status(), principal: undefined }],
    ['wrong role', { ...status(), role: 'admin' }],
    ['unauthenticated', { ...status(), sessionAuthenticated: false }],
    ['role smuggled into legacy', { enabled: true, role: 'operator' }],
    ['wrong multi flag', { ...status(), multiOperator: 'true' }],
    ['array', []],
    ['missing enabled', {}],
  ])
    await t.test(name, async () => {
      const f = fixture(async () => response(value));
      assert.equal((await f.manager.resolve()).storageAllowed, false);
      assert.equal(f.manager.identityStorageKey(), null);
      f.manager.destroy();
    });
});

test('explicit offline approval restores only its account during genuine network failure', async () => {
  const online = fixture();
  await online.manager.resolve();
  online.manager.activateOffline();
  online.manager.destroy();
  const offline = fixture(networkFailure, { values: online.values });
  const value = await offline.manager.resolve();
  assert.equal(value.online, false);
  assert.equal(value.storageScope, A);
  assert.equal(value.gateway, null);
  assert.equal(
    offline.manager.identityStorageKey(),
    `gev.tak.identity.v1.${A}`,
  );
  assert.throws(() => offline.manager.activateOffline(), /Sign in online/);
  offline.manager.destroy();
});

test('network failure without approval cannot guess a legacy or last-used named namespace', async () => {
  for (const values of [
    new Map(),
    new Map([
      [
        OPERATOR_ACTIVE_KEY,
        JSON.stringify({
          version: 1,
          multiOperator: true,
          identity: `${A}:alpha:operator`,
        }),
      ],
    ]),
  ]) {
    const f = fixture(networkFailure, { values });
    assert.equal((await f.manager.resolve()).storageAllowed, false);
    f.manager.destroy();
  }
});

test('401 and 403 revoke approval; an offline reload cannot revive the rejected account', async () => {
  for (const code of [401, 403]) {
    const online = fixture();
    await online.manager.resolve();
    online.manager.activateOffline();
    online.manager.destroy();
    const denied = fixture(async () => response({ error: 'Sign in' }, code), {
      values: online.values,
    });
    const value = await denied.manager.resolve();
    assert.equal(value.storageAllowed, false);
    assert.equal(value.sessionExpired, true);
    assert.equal(denied.values.has(OPERATOR_OFFLINE_KEY), false);
    denied.manager.destroy();
    const offline = fixture(networkFailure, {
      values: online.values,
      hasLegacyShell: async () => true,
    });
    assert.equal((await offline.manager.resolve()).storageAllowed, false);
    offline.manager.destroy();
  }
});

test('malformed online status never falls back to approved account data', async () => {
  const online = fixture();
  await online.manager.resolve();
  online.manager.activateOffline();
  online.manager.destroy();
  const denied = fixture(
    async () => response({ ...status(), storageScope: 'malformed' }),
    { values: online.values },
  );
  assert.equal((await denied.manager.resolve()).storageAllowed, false);
  assert.equal(denied.values.has(OPERATOR_OFFLINE_KEY), false);
  denied.manager.destroy();
});

test('valid changed online scope opens its own account and retires old offline approval', async () => {
  const old = fixture();
  await old.manager.resolve();
  old.manager.activateOffline();
  old.manager.destroy();
  const next = fixture(async () => response(status(B, 'bravo')), {
    values: old.values,
  });
  assert.equal((await next.manager.resolve()).storageScope, B);
  assert.equal(next.values.has(OPERATOR_OFFLINE_KEY), false);
  assert.equal(next.manager.identityStorageKey(), `gev.tak.identity.v1.${B}`);
  next.manager.destroy();
});

test('storage changes retire old-tab access once, including in-flight initial resolution', async () => {
  const f = fixture();
  const context = await f.manager.resolve();
  let invalidations = 0;
  f.manager.subscribe(() => {
    invalidations++;
    f.manager.clearOffline();
  });
  f.event(JSON.stringify({ identity: `${A}:alpha:operator` }));
  assert.equal(invalidations, 0);
  f.event(JSON.stringify({ identity: `${B}:bravo:observer` }));
  assert.equal(invalidations, 1);
  assert.equal(f.manager.isCurrent(context), false);
  assert.equal(f.manager.identityStorageKey(), null);
  f.manager.destroy();
  const slow = deferred(),
    pending = fixture(() => slow.promise);
  const resolved = pending.manager.resolve();
  pending.event(JSON.stringify({ identity: `${B}:bravo:operator` }));
  slow.resolve(response(status()));
  assert.equal((await resolved).storageAllowed, false);
  assert.equal(
    JSON.parse(pending.values.get(OPERATOR_ACTIVE_KEY)).identity,
    `${B}:bravo:operator`,
    'retired old response must not publish its old account over the new tab',
  );
  pending.manager.destroy();
});

test('queued old logout/account events cannot retire a freshly authenticated matching context', async () => {
  const f = fixture(async () => response(status(B, 'bravo', 'observer')));
  const context = await f.manager.resolve();
  let invalidations = 0;
  f.manager.subscribe(() => invalidations++);
  for (const oldValue of [
    null,
    JSON.stringify({ identity: `${A}:alpha:operator` }),
  ]) {
    f.event(oldValue, OPERATOR_ACTIVE_KEY, { queued: true });
    assert.equal(invalidations, 0);
    assert.equal(f.manager.isCurrent(context), true);
  }
  // Even a stale matching event must observe a genuine newer account change.
  f.values.set(
    OPERATOR_ACTIVE_KEY,
    JSON.stringify({ identity: `${A}:alpha:operator` }),
  );
  f.event(
    JSON.stringify({ identity: `${B}:bravo:observer` }),
    OPERATOR_ACTIVE_KEY,
    { queued: true },
  );
  assert.equal(invalidations, 1);
  assert.equal(f.manager.isCurrent(context), false);
  f.manager.destroy();
});

test('destroy removes storage listeners; local sign-out retires access and keeps map bytes separate', async () => {
  const f = fixture();
  await f.manager.resolve();
  f.manager.activateOffline();
  let count = 0;
  f.manager.subscribe(() => count++);
  f.manager.clearOffline();
  assert.equal(count, 1);
  assert.equal(f.manager.identityStorageKey(), null);
  assert.equal(f.values.has(OPERATOR_OFFLINE_KEY), false);
  f.manager.destroy();
  f.event(null, null);
  assert.equal(count, 1);
});

test('bounded fetch timeout uses prior explicit approval without waiting for an unresponsive fetch implementation', async () => {
  const f = fixture();
  await f.manager.resolve();
  f.manager.activateOffline();
  f.manager.destroy();
  const hang = fixture(() => new Promise(() => {}), {
    values: f.values,
    timeoutMs: 5,
  });
  assert.equal((await hang.manager.resolve()).storageScope, A);
  hang.manager.destroy();
});

test('caller cancellation does not perform a map restore or corrupt shared authenticated context', async () => {
  const wait = deferred(),
    f = fixture(() => wait.promise),
    controller = new AbortController();
  const cancelled = f.manager.resolve(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  wait.resolve(response(status()));
  assert.equal((await f.manager.resolve()).storageScope, A);
  f.manager.destroy();
});

test('oversized and invalid UTF-8 status bodies are refused rather than persisted', async () => {
  for (const body of ['x'.repeat(17000), new Uint8Array([255])]) {
    const f = fixture(async () => new Response(body));
    assert.equal((await f.manager.resolve()).storageAllowed, false);
    f.manager.destroy();
  }
});

test('validated legacy/lab context retains the original identity namespace', async () => {
  const f = fixture(async () => response({ enabled: false }));
  const value = await f.manager.resolve();
  assert.equal(value.multiOperator, false);
  assert.equal(f.manager.identityStorageKey(), 'gev.tak.identity.v1');
  f.manager.destroy();
});

test('legacy offline migration needs an existing saved shell and never overrides named/logout history', async () => {
  const migrated = fixture(networkFailure, {
    hasLegacyShell: async () => true,
  });
  assert.equal((await migrated.manager.resolve()).multiOperator, false);
  assert.equal(migrated.manager.identityStorageKey(), 'gev.tak.identity.v1');
  migrated.manager.destroy();
  for (const record of [
    { version: 1, multiOperator: true, identity: null },
    { version: 1, multiOperator: false, identity: null },
  ]) {
    const f = fixture(networkFailure, {
      hasLegacyShell: async () => true,
      values: new Map([[OPERATOR_ACTIVE_KEY, JSON.stringify(record)]]),
    });
    assert.equal((await f.manager.resolve()).storageAllowed, false);
    f.manager.destroy();
  }
});

test('legacy migration reads only existing shell state and refuses absent or corrupt caches', async () => {
  let opens = 0;
  assert.equal(
    await hasLegacyOfflineShell({
      origin: 'https://internal.test',
      cachesRef: {
        has: async () => false,
        open: async () => {
          opens++;
        },
      },
    }),
    false,
  );
  assert.equal(opens, 0);
  const state = {
    revision: A,
    cacheName: `gev-offline-shell-v1-${A}-123`,
    files: ['/index.html'],
  };
  const cachesRef = {
    has: async () => true,
    open: async () => ({ match: async () => response(state) }),
  };
  assert.equal(
    await hasLegacyOfflineShell({ origin: 'https://internal.test', cachesRef }),
    true,
  );
  state.cacheName = 'foreign';
  assert.equal(
    await hasLegacyOfflineShell({ origin: 'https://internal.test', cachesRef }),
    false,
  );
});

test('unresolved/retired account boot does not touch IndexedDB; named boot passes exact scoped capability', async () => {
  let opens = 0;
  assert.equal(
    await readSelectedOfflinePack({
      context: null,
      openStore: async () => {
        opens++;
      },
    }),
    null,
  );
  assert.equal(opens, 0);
  const f = fixture();
  const context = await f.manager.resolve();
  const options = [];
  assert.equal(
    await readSelectedOfflinePack({
      context,
      isCurrent: f.manager.isCurrent,
      openStore: async (value) => {
        options.push(value);
        return null;
      },
    }),
    null,
  );
  assert.equal(options[0].storageScope, A);
  assert.equal(options[0].isCurrent(), true);
  f.manager.clearOffline();
  assert.equal(options[0].isCurrent(), false);
  assert.equal(
    await readSelectedOfflinePack({
      context,
      isCurrent: f.manager.isCurrent,
      openStore: async () => {
        opens++;
      },
    }),
    null,
  );
  assert.equal(opens, 0);
  f.manager.destroy();
});

test('account invalidation during asynchronous selection closes store and never returns its manifest', async () => {
  const f = fixture(),
    context = await f.manager.resolve(),
    wait = deferred();
  let closed = 0;
  const selected = readSelectedOfflinePack({
    context,
    isCurrent: f.manager.isCurrent,
    openStore: async () => ({
      getSelectedPackId: () => wait.promise,
      getManifest: async () => {
        throw new Error('must not read');
      },
      close: () => closed++,
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  f.manager.clearOffline();
  wait.resolve('anything');
  assert.equal(await selected, null);
  assert.equal(closed, 1);
  f.manager.destroy();
});

test('existing database discovery selects only exact current scope and never creates another account database', async () => {
  let opened = 0;
  const indexedDB = {
    databases: async () => [{ name: offlineDatabaseName(A) }],
    open: () => {
      opened++;
      throw new Error('wrong account opened');
    },
  };
  assert.equal(
    await openExistingOfflinePackStore({ indexedDB, storageScope: B }),
    null,
  );
  assert.equal(opened, 0);
  await assert.rejects(
    openExistingOfflinePackStore({
      indexedDB,
      storageScope: A,
      isCurrent: () => false,
    }),
    /context changed/,
  );
  assert.equal(opened, 0);
});

test('store refuses data that completes after account retirement', async () => {
  const wait = deferred();
  let current = true;
  const store = await createOfflinePackStore({
    driver: { list: () => wait.promise, close() {} },
    storageManager: null,
    isCurrent: () => current,
  });
  const reading = store.listPacks();
  current = false;
  wait.resolve([]);
  await assert.rejects(reading, /context changed/);
  store.close();
});

test('cross-tab active record retires capabilities before storage-event delivery or offline approval', async () => {
  const f = fixture(),
    context = await f.manager.resolve();
  f.values.set(
    OPERATOR_ACTIVE_KEY,
    JSON.stringify({
      version: 1,
      multiOperator: true,
      identity: `${B}:bravo:operator`,
    }),
  );
  assert.equal(f.manager.isCurrent(context), false);
  assert.equal(f.manager.identityStorageKey(), null);
  assert.throws(() => f.manager.activateOffline(), /Sign in online/);
  f.manager.destroy();
});

test('a late denied old-tab response cannot erase the new account offline approval', async () => {
  const wait = deferred(),
    old = fixture(() => wait.promise),
    pending = old.manager.resolve();
  const next = fixture(async () => response(status(B, 'bravo')), {
    values: old.values,
  });
  await next.manager.resolve();
  next.manager.activateOffline();
  old.event(old.values.get(OPERATOR_ACTIVE_KEY));
  wait.resolve(response({ error: 'Expired old cookie' }, 401));
  assert.equal((await pending).storageAllowed, false);
  assert.equal(
    JSON.parse(old.values.get(OPERATOR_OFFLINE_KEY)).storageScope,
    B,
  );
  assert.equal(
    JSON.parse(old.values.get(OPERATOR_ACTIVE_KEY)).identity,
    `${B}:bravo:operator`,
  );
  old.manager.destroy();
  next.manager.destroy();
});

test('unavailable browser metadata cannot authorize guessed legacy offline access', async () => {
  const f = fixture(networkFailure, {
    storage: null,
    hasLegacyShell: async () => true,
  });
  assert.equal((await f.manager.resolve()).storageAllowed, false);
  f.manager.destroy();
});

test('a late old-account status cannot win before cross-tab event delivery', async () => {
  for (const code of [200, 401]) {
    const wait = deferred(),
      old = fixture(() => wait.promise),
      pending = old.manager.resolve();
    const next = fixture(async () => response(status(B, 'bravo')), {
      values: old.values,
    });
    await next.manager.resolve();
    next.manager.activateOffline();
    wait.resolve(
      response(code === 200 ? status() : { error: 'Expired' }, code),
    );
    assert.equal((await pending).storageAllowed, false);
    assert.equal(
      JSON.parse(old.values.get(OPERATOR_ACTIVE_KEY)).identity,
      `${B}:bravo:operator`,
    );
    assert.equal(
      JSON.parse(old.values.get(OPERATOR_OFFLINE_KEY)).storageScope,
      B,
    );
    old.manager.destroy();
    next.manager.destroy();
  }
});

test('old-tab retirement cleanup cannot sign out or remove the new account approval', async () => {
  const old = fixture();
  await old.manager.resolve();
  old.manager.activateOffline();
  const next = fixture(async () => response(status(B, 'bravo')), {
    values: old.values,
  });
  await next.manager.resolve();
  next.manager.activateOffline();
  old.manager.subscribe(() => old.manager.clearOffline());
  old.event(old.values.get(OPERATOR_ACTIVE_KEY));
  assert.equal(old.manager.identityStorageKey(), null);
  assert.equal(
    JSON.parse(old.values.get(OPERATOR_ACTIVE_KEY)).identity,
    `${B}:bravo:operator`,
  );
  assert.equal(
    JSON.parse(old.values.get(OPERATOR_OFFLINE_KEY)).storageScope,
    B,
  );
  old.manager.destroy();
  next.manager.destroy();
});
