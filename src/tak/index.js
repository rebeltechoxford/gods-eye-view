import './tak.css';
import { parseCotXml, normalizeCotRecord } from './cot.js';
import { createCotStore } from './contactStore.js';
import { createCotOverlay } from './cotOverlay.js';
import { createTakPanel } from './ui.js';

/**
 * TAK web-preview entry point. The production map and all GEV capabilities
 * remain owned by God's Eye View; CoT state is isolated and session-only.
 */
export function initTakWebClient({ viewer }) {
  const store = createCotStore();
  const overlay = createCotOverlay(viewer);
  let localSequence = 0;
  const panel = createTakPanel({
    listContacts: store.list,
    isStale: store.isStale,
    onImport(xml) {
      const { contacts, rejected } = parseCotXml(xml);
      const { accepted, ignored } = store.ingest(contacts);
      return 'Imported ' + accepted + ' CoT contacts' +
        (ignored || rejected ? ' (' + (ignored + rejected) + ' skipped).' : '.');
    },
    onMarker({ callsign, lat, lon }) {
      const now = new Date();
      const stale = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const marker = normalizeCotRecord({
        uid: 'local-map-marker-' + now.getTime() + '-' + localSequence++,
        callsign,
        type: 'b-m-p-s-p-i',
        how: 'h-g-i-g-o',
        lat, lon,
        time: now.toISOString(),
        stale: stale.toISOString(),
      });
      if (!marker) throw new Error('Marker requires valid coordinates.');
      store.ingest([marker]);
      overlay.focus(marker.uid);
      return 'Local marker added. It has not been broadcast to TAK Server.';
    },
    onClear: () => store.clear(),
    onFocus: (uid) => overlay.focus(uid),
  });
  const unsubscribe = store.subscribe(() => {
    overlay.render(store.list(), store.isStale);
    panel.render();
  });
  overlay.render(store.list(), store.isStale);
  return Object.freeze({
    destroy() {
      unsubscribe();
      panel.destroy();
      overlay.destroy();
      store.destroy();
    },
  });
}
