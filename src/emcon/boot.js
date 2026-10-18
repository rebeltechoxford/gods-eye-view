// First module evaluated by src/main.js: read the persisted EMCON flag and
// install the network guard before any application module can transmit.
// The security policy forbids inline scripts, so this import order is the
// earliest point the page controls.

import { createEmconState } from './state.js';
import { installEmconGuard } from './guard.js';

export const emconState = createEmconState();
export const emconGuard = installEmconGuard(globalThis, {
  isActive: emconState.isActive,
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
  const worker = container?.controller;
  if (!worker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), 1000);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    try {
      worker.postMessage({ type: 'GEV_EMCON', active }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

// Keep the worker aligned at every start and when another tab changes it.
void syncEmconWorker(emconState.isActive());
emconState.subscribe((record) => void syncEmconWorker(Boolean(record)));
