// First module evaluated by src/main.js: read the persisted EMCON flag and
// install the network guard before any application module can transmit.
// The security policy forbids inline scripts, so this import order is the
// earliest point the page controls.

import { createEmconState } from './state.js';
import { installEmconGuard } from './guard.js';

export const emconState = createEmconState();
let confirmedWorker = null;
let syncGeneration = 0;
export const emconGuard = installEmconGuard(globalThis, {
  isActive: emconState.isActive,
  isWorkerReady: () =>
    confirmedWorker !== null &&
    confirmedWorker === globalThis.navigator?.serviceWorker?.controller,
});

/**
 * Tell the saved-app service worker whether to answer every request from
 * its cache. Messages are local IPC, not network traffic. Resolves when the
 * worker acknowledges, or after a second when there is no worker.
 */
export function syncEmconWorker(
  active,
  container = globalThis.navigator?.serviceWorker,
) {
  const generation = ++syncGeneration;
  confirmedWorker = null;
  const worker = container?.controller;
  if (!worker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (ok) => {
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      if (
        ok &&
        active &&
        generation === syncGeneration &&
        container.controller === worker &&
        emconState.isActive()
      )
        confirmedWorker = worker;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 1000);
    channel.port1.onmessage = ({ data }) =>
      finish(data?.ok === true && data.active === active);
    try {
      worker.postMessage({ type: 'GEV_EMCON', active }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

// On a saved-app cold launch the guard is already active, but static files
// must wait for the worker's cache-only acknowledgment. Scene construction
// starts Cesium asset requests immediately, so main awaits this bounded sync
// before starting the application. A timeout does not open the guard.
export const emconStartupReady = syncEmconWorker(emconState.isActive());
// Keep the worker aligned when another tab changes state.
emconState.subscribe((record) => {
  if (record) emconGuard.stopActive();
  void syncEmconWorker(Boolean(record));
});
globalThis.navigator?.serviceWorker?.addEventListener?.(
  'controllerchange',
  () => {
    void syncEmconWorker(emconState.isActive());
  },
);
