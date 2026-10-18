// Off-main-thread offline routing: holds one decoded road pack and answers
// route requests, so a state-sized search never blocks the globe.

import { decodeRoadPack } from './roadPack.js';
import { createRoadRouter } from './router.js';
import { offlineDirections } from './offlineDirections.js';

let loaded = null; // { key, router }

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === 'load') {
    try {
      const pack = decodeRoadPack(new Uint8Array(message.bytes));
      loaded = { key: message.key, router: createRoadRouter(pack) };
      self.postMessage({
        type: 'loaded',
        key: message.key,
        ok: true,
        counts: pack.counts,
      });
    } catch (error) {
      loaded = null;
      self.postMessage({
        type: 'loaded',
        key: message.key,
        ok: false,
        error: String(error?.message || error),
      });
    }
    return;
  }
  if (message.type === 'route') {
    if (!loaded || loaded.key !== message.key) {
      self.postMessage({
        type: 'route',
        id: message.id,
        ok: false,
        error: { message: 'Road pack is not loaded', code: 'no-pack' },
      });
      return;
    }
    try {
      const payload = offlineDirections(loaded.router, {
        a: message.a,
        b: message.b,
      });
      self.postMessage({ type: 'route', id: message.id, ok: true, payload });
    } catch (error) {
      self.postMessage({
        type: 'route',
        id: message.id,
        ok: false,
        error: {
          message: String(error?.message || error),
          code: error?.code || 'error',
        },
      });
    }
  }
};
