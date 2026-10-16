import * as Cesium from 'cesium';
import {
  validateOfflineManifest,
  planOfflineTiles,
  tileKey,
} from './schema.js';

const EMPTY =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
const localSources = new WeakSet();
export const isOfflineSource = (source) => localSources.has(source);

/** A local-only imagery source. Coverage misses never become online requests. */
export function createOfflineImageryProvider(
  { manifest, store },
  sdk = Cesium,
) {
  const pack = validateOfflineManifest(manifest, { requireReady: true });
  const readTile = store.createTileReader
    ? store.createTileReader(pack)
    : (key) => store.getTile(pack.id, key);
  const planned = new Set(planOfflineTiles(pack).map((tile) => tile.key));
  const failed = new Set();
  let destroyed = false,
    empty;
  const blank = () =>
    (empty ||= Promise.resolve().then(() =>
      sdk.Resource.fetchImage({ url: EMPTY }),
    ));
  const tilingScheme = new sdk.WebMercatorTilingScheme();
  return {
    tileWidth: 256,
    tileHeight: 256,
    minimumLevel: 0,
    maximumLevel: pack.maxZoom,
    tilingScheme,
    rectangle: tilingScheme.rectangle,
    hasAlphaChannel: true,
    tileDiscardPolicy: undefined,
    errorEvent: new sdk.Event(),
    credit: new sdk.Credit(
      `${escape(pack.credit)} · Saved map: ${escape(pack.name)} · Downloaded ${escape(pack.acquiredAt)} · Flat ellipsoid terrain`,
      true,
    ),
    getTileCredits() {
      return undefined;
    },
    pickFeatures() {
      return undefined;
    },
    requestImage(x, y, level, request) {
      let key;
      try {
        key = tileKey(level, x, y);
      } catch {
        return blank();
      }
      if (
        destroyed ||
        request?.cancelled ||
        !planned.has(key) ||
        failed.has(key)
      )
        return blank();
      return Promise.resolve()
        .then(() => readTile(key))
        .then(async (tile) => {
          if (destroyed || request?.cancelled || !tile) return blank();
          const blob = new Blob([tile.bytes], { type: tile.contentType });
          const url = URL.createObjectURL(blob);
          try {
            return await sdk.Resource.fetchImage({ url });
          } finally {
            URL.revokeObjectURL(url);
          }
        })
        .catch(() => {
          failed.add(key);
          return blank();
        });
    },
    destroy() {
      destroyed = true;
      failed.clear();
    },
    isDestroyed() {
      return destroyed;
    },
  };
}

/** Each immutable pack receives its own controller cache identity. */
export function offlineSource(manifest, store, sdk = Cesium) {
  const pack = validateOfflineManifest(manifest, { requireReady: true });
  const source = Object.freeze({
    localOnly: true,
    descriptor: Object.freeze({
      id: `offline-${pack.id}`,
      label: `Saved: ${pack.name}`,
      shortLabel: 'SAVED',
      kind: 'offline',
      requiresIon: false,
    }),
    available: true,
    credit: `${escape(pack.credit)} · Downloaded ${escape(pack.acquiredAt)} · Flat ellipsoid terrain`,
    imagery: () => createOfflineImageryProvider({ manifest: pack, store }, sdk),
    terrain: Object.freeze({
      id: 'offline-ellipsoid',
      localOnly: true,
      create: async () => ({ provider: new sdk.EllipsoidTerrainProvider() }),
    }),
  });
  localSources.add(source);
  return source;
}
