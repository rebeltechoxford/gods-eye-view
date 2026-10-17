// The application's on-device road routing: one engine and one account-
// scoped pack store, shared by the Directions source and the TAK panel.
// Packs are stored per operator account, like saved maps; with no resolved
// account (storage not allowed) no pack is used and routing stays online.

import {
  getResolvedOperatorContext,
  isOperatorContextCurrent,
} from '../tak/operatorContext.js';
import { createOfflineRouteEngine } from './offlineEngine.js';
import { openRoadPackStore } from './packStore.js';

let storePromise = null;
let storeScope;

/** The current account's pack store, or null when storage is not allowed. */
export async function openCurrentRoadPackStore({
  context = getResolvedOperatorContext(),
  isCurrent = isOperatorContextCurrent,
  open = openRoadPackStore,
} = {}) {
  if (!context?.storageAllowed || !isCurrent(context)) return null;
  const scope = context.storageScope ?? null;
  if (!storePromise || storeScope !== scope) {
    const previous = storePromise;
    storeScope = scope;
    storePromise = open({ storageScope: scope });
    storePromise.catch(() => {
      if (storeScope === scope) storePromise = null;
    });
    previous?.then((store) => store.close()).catch(() => {});
  }
  return storePromise;
}

export const offlineRouting = createOfflineRouteEngine({
  async listPacks() {
    const store = await openCurrentRoadPackStore();
    return store ? store.list() : [];
  },
  async readPack(id) {
    const store = await openCurrentRoadPackStore();
    if (!store)
      throw new Error('Road pack storage is not available for this account');
    return store.readBytes(id);
  },
});
