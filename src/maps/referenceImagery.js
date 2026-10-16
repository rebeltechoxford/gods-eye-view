import * as Cesium from 'cesium';
import { referenceMap } from './referenceCatalog.js';

/** A decoded transparent pixel, reused by each provider; never a network tile. */
export const EMPTY_CHART_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==';

/** Preserve Cesium scheduling; valid empty coverage is distinct from an outage. */
export function boundChartProvider(provider, descriptor, blankImage) {
  let empty;
  const blank = () => (empty ||= Promise.resolve().then(blankImage));
  return {
    tileWidth: provider.tileWidth,
    tileHeight: provider.tileHeight,
    minimumLevel: 0,
    maximumLevel: descriptor.maximumLevel,
    tilingScheme: provider.tilingScheme,
    rectangle: provider.rectangle,
    credit: provider.credit,
    errorEvent: provider.errorEvent,
    hasAlphaChannel: true,
    tileDiscardPolicy: undefined,
    getTileCredits: (...args) => provider.getTileCredits?.(...args),
    pickFeatures: () => undefined,
    requestImage(x, y, level, request) {
      if (
        level < descriptor.minimumChartLevel ||
        level > descriptor.maximumLevel
      )
        return blank();
      let result;
      try {
        result = provider.requestImage(x, y, level, request);
      } catch (error) {
        if (error?.statusCode === 404) return blank();
        throw error;
      }
      if (!result) return result;
      return Promise.resolve(result).catch((error) => {
        if (error?.statusCode === 404) return blank();
        throw error;
      });
    },
  };
}

/** Only curated IDs choose an upstream. Construction is lazy at map selection. */
export async function createReferenceImagery(
  id,
  { signal } = {},
  sdk = Cesium,
) {
  const descriptor = referenceMap(id);
  if (!descriptor) throw new TypeError(`Unknown reference map: ${id}`);
  signal?.throwIfAborted();
  let provider;
  if (descriptor.sourceType === 'wms') {
    provider = new sdk.WebMapServiceImageryProvider({
      url: descriptor.url,
      layers: descriptor.layers,
      parameters: {
        version: '1.3.0',
        format: 'image/png',
        transparent: true,
        styles: '',
      },
      crs: 'EPSG:3857',
      tilingScheme: new sdk.WebMercatorTilingScheme(),
      tileWidth: 256,
      tileHeight: 256,
      maximumLevel: descriptor.maximumLevel,
      enablePickFeatures: false,
      credit: descriptor.credit,
    });
  } else {
    provider = await sdk.ArcGisMapServerImageryProvider.fromUrl(
      descriptor.url,
      {
        enablePickFeatures: false,
        credit: descriptor.credit,
        maximumLevel: descriptor.maximumLevel,
        // Cesium otherwise probes a missing tile at metadata's highest LOD (23),
        // even though FAA's actual caches stop much earlier. Our adapter owns
        // empty-coverage handling and must never acquire that out-of-range tile.
        ...(descriptor.minimumChartLevel === undefined
          ? {}
          : { tileDiscardPolicy: new sdk.NeverTileDiscardPolicy() }),
      },
    );
  }
  if (signal?.aborted) {
    provider.destroy?.();
    signal.throwIfAborted();
  }
  return descriptor.minimumChartLevel === undefined
    ? provider
    : boundChartProvider(provider, descriptor, () =>
        sdk.Resource.fetchImage({ url: EMPTY_CHART_TILE }),
      );
}
