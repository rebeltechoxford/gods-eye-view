import test from 'node:test';
import assert from 'node:assert/strict';
import { logoutOperatorSession, signOutOperator } from './session.js';

test('operator logout sends only a same-origin cookie request and reports unconfirmed revocation', async () => {
  let request;
  await logoutOperatorSession(async (...args) => {
    request = args;
    return { ok: true };
  });
  assert.equal(request[0], '/logout');
  assert.equal(request[1].method, 'POST');
  assert.equal(request[1].credentials, 'same-origin');
  assert.equal(request[1].cache, 'no-store');
  assert.equal('body' in request[1], false);
  await assert.rejects(
    logoutOperatorSession(async () => ({ ok: false })),
    /could not be confirmed/,
  );
});

test('named logout binds current scope and refuses a changed account before dispatch', async () => {
  let calls = 0,
    request;
  const fetchImpl = async (...args) => {
    calls++;
    request = args;
    return { ok: true };
  };
  await assert.rejects(
    logoutOperatorSession(fetchImpl, undefined, {
      canRevoke: () => false,
      storageScope: 'a'.repeat(64),
    }),
    /Account changed/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    logoutOperatorSession(fetchImpl, undefined, { storageScope: '../invalid' }),
    /scope/,
  );
  assert.equal(calls, 0);
  await logoutOperatorSession(fetchImpl, undefined, {
    storageScope: 'a'.repeat(64),
  });
  assert.equal(request[1].headers['X-TAK-Storage-Scope'], 'a'.repeat(64));
  assert.equal(request[1].redirect, undefined);
});

test('sign-out clears private page before POST and failed network retry reopens instead of revoking a new cookie', async () => {
  const actions = [];
  let current = true,
    calls = 0;
  const options = {
    context: { multiOperator: true, storageScope: 'a'.repeat(64) },
    isCurrent: () => current,
    retire: ({ redirect }) => {
      actions.push(redirect ? `reopen:${redirect}` : 'clear');
      current = false;
    },
    navigate: (path) => actions.push(path),
    fetchImpl: async () => {
      actions.push('POST');
      calls++;
      throw new TypeError('Offline');
    },
  };
  await assert.rejects(signOutOperator(options), /Offline/);
  assert.deepEqual(actions, ['clear', 'POST']);
  await signOutOperator(options);
  assert.deepEqual(actions, ['clear', 'POST', '/']);
  assert.equal(calls, 1);
});

test('successful scoped sign-out follows native303 login and cookie mismatch reopens without claiming logout', async () => {
  const actions = [];
  let request;
  const options = {
    context: { multiOperator: true, storageScope: 'a'.repeat(64) },
    isCurrent: () => true,
    retire: () => actions.push('clear'),
    navigate: (path) => actions.push(path),
    fetchImpl: async (...args) => {
      request = args;
      actions.push('POST');
      return { ok: true };
    },
  };
  await signOutOperator(options);
  assert.deepEqual(actions, ['clear', 'POST', '/login']);
  assert.equal(request[1].headers['X-TAK-Storage-Scope'], 'a'.repeat(64));
  actions.length = 0;
  await signOutOperator({
    ...options,
    fetchImpl: async () => ({
      ok: false,
      status: 409,
      headers: new Headers({ 'X-TAK-Account-Context': 'mismatch' }),
    }),
  });
  assert.deepEqual(actions, ['clear', '/']);
});
