import test from 'node:test';
import assert from 'node:assert/strict';
import { createMobileSession } from './mobile.js';

function environment(secure = true) {
  const windowRef = new EventTarget(),
    documentRef = new EventTarget();
  Object.assign(windowRef, { isSecureContext: secure, innerHeight: 800 });
  windowRef.top = windowRef;
  windowRef.self = windowRef;
  const navigatorRef = { onLine: true };
  return { windowRef, documentRef, navigatorRef };
}
test('install prompts require a user action and listeners are revoked on teardown', async () => {
  const env = environment();
  const session = createMobileSession({ ...env, registerWorker: false });
  let prompts = 0;
  const event = new Event('beforeinstallprompt', { cancelable: true });
  event.prompt = async () => {
    prompts++;
  };
  event.userChoice = Promise.resolve({ outcome: 'accepted' });
  env.windowRef.dispatchEvent(event);
  assert.equal(prompts, 0);
  assert.equal(session.state().installAvailable, true);
  assert.equal(await session.install(), 'accepted');
  assert.equal(prompts, 1);
  assert.equal(session.state().installAvailable, false);
  env.navigatorRef.onLine = false;
  env.windowRef.dispatchEvent(new Event('offline'));
  assert.equal(session.state().online, false);
  session.destroy();
  env.windowRef.dispatchEvent(event);
  assert.equal(session.state().installAvailable, false);
  assert.equal(await session.install(), 'closed');
});
test('service workers are limited to secure production top-level contexts and late registration is inert', async () => {
  for (const secure of [false, true]) {
    const env = environment(secure);
    let calls = 0;
    env.navigatorRef.serviceWorker = {
      register: async () => {
        calls++;
        return {};
      },
    };
    const session = createMobileSession({ ...env, registerWorker: false });
    await Promise.resolve();
    assert.equal(calls, 0);
    session.destroy();
    const active = createMobileSession({ ...env, registerWorker: true });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, secure ? 1 : 0);
    active.destroy();
  }
  const env = environment();
  let calls = 0;
  env.navigatorRef.serviceWorker = {
    register: async () => {
      calls++;
    },
  };
  const session = createMobileSession({ ...env, registerWorker: true });
  session.destroy();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 0);
});
