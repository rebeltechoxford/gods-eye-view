import { openExistingOfflinePackStore } from './store.js';
import { validateOfflineManifest } from './schema.js';

/** A saved selection is explicit; navigator.onLine is not proof of reachability. */
export async function readSelectedOfflinePack({
  openStore = openExistingOfflinePackStore,
  signal,
} = {}) {
  let store;
  try {
    signal?.throwIfAborted();
    store = await openStore();
    if (!store) return null;
    const id = await store.getSelectedPackId();
    if (!id) {
      store.close();
      return null;
    }
    const manifest = await store.getManifest(id);
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
