import test from 'node:test';
import assert from 'node:assert/strict';
import { logoutOperatorSession } from './session.js';

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
