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

test('window resize updates subscribers without a visualViewport API', () => {
  const env = environment();
  const session = createMobileSession({ ...env, registerWorker: false });
  const snapshots = [];
  session.subscribe(() => snapshots.push(session.state()));
  env.windowRef.innerHeight = 844;
  env.windowRef.dispatchEvent(new Event('resize'));
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].viewportHeight, 844);
  assert.equal(snapshots[0].keyboardInset, 0);
  env.windowRef.innerHeight = 390;
  env.windowRef.dispatchEvent(new Event('resize'));
  assert.equal(snapshots[1].viewportHeight, 390);
  session.destroy();
});

test('a delayed visual viewport cannot retain desktop height, and keyboard resize/scroll insets stay current', () => {
  const env = environment();
  env.windowRef.innerHeight = 900;
  const visual = new EventTarget();
  Object.assign(visual, { height: 900, offsetTop: 0 });
  env.windowRef.visualViewport = visual;
  const session = createMobileSession({ ...env, registerWorker: false });
  const snapshots = [];
  session.subscribe(() => snapshots.push(session.state()));
  env.windowRef.innerHeight = 844;
  env.windowRef.dispatchEvent(new Event('resize'));
  assert.equal(snapshots[0].viewportHeight, 844);
  assert.equal(snapshots[0].keyboardInset, 0);
  visual.height = 844;
  visual.dispatchEvent(new Event('resize'));
  assert.equal(snapshots[1].viewportHeight, 844);
  visual.height = 500;
  visual.offsetTop = 60;
  visual.dispatchEvent(new Event('resize'));
  assert.equal(snapshots[2].viewportHeight, 500);
  assert.equal(snapshots[2].keyboardInset, 284);
  visual.offsetTop = 80;
  visual.dispatchEvent(new Event('scroll'));
  assert.equal(snapshots[3].keyboardInset, 264);
  session.destroy();
});

test('destroy removes the actual window, document and visual viewport listeners', () => {
  class TrackedTarget extends EventTarget {
    listeners = new Map();
    addEventListener(type, listener, options) {
      super.addEventListener(type, listener, options);
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener, options) {
      super.removeEventListener(type, listener, options);
      const entries = this.listeners.get(type);
      entries?.delete(listener);
      if (!entries?.size) this.listeners.delete(type);
    }
  }
  const windowRef = new TrackedTarget();
  const documentRef = new TrackedTarget();
  const visual = new TrackedTarget();
  Object.assign(visual, { height: 800, offsetTop: 0 });
  Object.assign(windowRef, {
    isSecureContext: true,
    innerHeight: 800,
    visualViewport: visual,
  });
  const session = createMobileSession({
    windowRef,
    documentRef,
    navigatorRef: {},
    registerWorker: false,
  });
  assert.equal(windowRef.listeners.get('resize').size, 1);
  assert.equal(visual.listeners.get('resize').size, 1);
  assert.equal(visual.listeners.get('scroll').size, 1);
  let notifications = 0;
  session.subscribe(() => notifications++);
  session.destroy();
  session.destroy();
  assert.equal(windowRef.listeners.size, 0);
  assert.equal(documentRef.listeners.size, 0);
  assert.equal(visual.listeners.size, 0);
  windowRef.dispatchEvent(new Event('resize'));
  visual.dispatchEvent(new Event('resize'));
  visual.dispatchEvent(new Event('scroll'));
  assert.equal(notifications, 0);
});
