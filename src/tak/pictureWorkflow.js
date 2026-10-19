import { captureTakPicture } from './picture.js';

/** Explicit local retention; this workflow has no transport or live-store writes. */
export function createPictureWorkflow({
  client,
  storage,
  context,
  isCurrent,
  markPrivate,
  onChange = () => {},
  signal,
}) {
  let picture = null;
  let pending = null;
  let locked = false;
  let message =
    'No historical picture is displayed. Restore is always explicit.';
  let error = false;
  function guard() {
    signal?.throwIfAborted();
    if (locked || !context?.storageAllowed || !isCurrent(context))
      throw new Error('Operator account changed; picture access is locked.');
  }
  const state = () => ({
    picture,
    busy: Boolean(pending),
    locked,
    message,
    error,
  });
  const notify = () => onChange(state());
  function hide() {
    pending?.abort();
    pending = null;
    picture = null;
    error = false;
    message =
      'Historical picture hidden. The saved device copy remains until Delete.';
    notify();
  }
  async function perform(action) {
    if (pending || locked) return false;
    const operation = new AbortController();
    pending = operation;
    error = false;
    try {
      guard();
      notify();
      const result = await action(operation.signal);
      guard();
      operation.signal.throwIfAborted();
      if (pending !== operation) return false;
      result();
      return true;
    } catch (cause) {
      if (pending === operation && !operation.signal.aborted && !locked) {
        error = true;
        message = cause?.message || 'Device picture operation failed.';
      }
      return false;
    } finally {
      if (pending === operation) {
        pending = null;
        notify();
      }
    }
  }
  function retire() {
    locked = true;
    pending?.abort();
    pending = null;
    picture = null;
    storage.close();
    message =
      'Historical picture locked. Reopen an approved account to continue.';
    error = false;
    notify();
  }
  signal?.addEventListener('abort', retire, { once: true });
  if (signal?.aborted) retire();
  return Object.freeze({
    state,
    save(consent) {
      return perform(async (operationSignal) => {
        if (consent !== true)
          throw new Error('Check device retention consent before saving.');
        const payload = captureTakPicture(client.store.list(), {
          selfUid: client.identity().uid,
        });
        await storage.save(payload, operationSignal);
        return () => {
          message =
            'Picture saved on this device. Use Restore to display it; the previous device copy was replaced.';
        };
      });
    },
    restore() {
      return perform(async (operationSignal) => {
        const loaded = await storage.restore(operationSignal);
        return () => {
          if (loaded) markPrivate();
          picture = loaded;
          message = loaded
            ? `${loaded.contacts.length} historical items · saved ${new Date(loaded.savedAtMs).toISOString()}. Positions are not live.`
            : 'No saved picture for this account on this device.';
        };
      });
    },
    remove() {
      return perform(async (operationSignal) => {
        await storage.remove(operationSignal);
        return () => {
          picture = null;
          message = 'Saved picture deleted from this device.';
        };
      });
    },
    hide,
    retire,
    destroy() {
      retire();
      signal?.removeEventListener('abort', retire);
    },
  });
}
