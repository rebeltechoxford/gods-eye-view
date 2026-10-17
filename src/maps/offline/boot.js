import { openExistingOfflinePackStore } from './store.js';
import { validateOfflineManifest } from './schema.js';
import {
  getResolvedOperatorContext,
  isOperatorContextCurrent,
} from '../../tak/operatorContext.js';

/** A saved selection is explicit; navigator.onLine is not proof of reachability. */
export async function readSelectedOfflinePack({
  openStore = openExistingOfflinePackStore,
  signal,
  context = getResolvedOperatorContext(),
  isCurrent = isOperatorContextCurrent,
} = {}) {
  let store;
  try {
    signal?.throwIfAborted();
    if (!context?.storageAllowed || !isCurrent(context)) return null;
    const ensure = () => {
      signal?.throwIfAborted();
      if (!isCurrent(context))
        throw new Error('Offline map account context changed');
    };
    store = await openStore({
      storageScope: context.storageScope,
      isCurrent: () => isCurrent(context),
    });
    ensure();
    if (!store) return null;
    const id = await store.getSelectedPackId();
    ensure();
    if (!id) {
      store.close();
      return null;
    }
    const manifest = await store.getManifest(id);
    ensure();
    if (!manifest) {
      await store.setSelectedPackId(null);
      store.close();
      return null;
    }
    validateOfflineManifest(manifest, { requireReady: true });
    signal?.throwIfAborted();
    return { store, manifest };
  } catch (error) {
    store?.close();
    if (signal?.aborted) signal.throwIfAborted();
    console.warn(
      '[SavedMaps] Saved map could not be restored:',
      error?.message || String(error),
    );
    return null;
  }
}
