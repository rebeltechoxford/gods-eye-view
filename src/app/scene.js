import { createApplicationOperations } from './operations.js';
import * as Cesium from 'cesium';
import {
  createApplicationViewer,
  installTrackpadPinchZoom,
} from '../app/viewer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { loadPhotorealisticTileset } from '../mapStartup.js';
import { initLogoGaze } from '../logoGaze.js';
import {
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';
import { readSelectedOfflinePack } from '../maps/offline/boot.js';
import { offlineSource } from '../maps/offline/imagery.js';
import { markTakDataPrivate } from '../tak/privacy.js';
import { isEmbedded } from './embed.js';
import {
  resolveOperatorContext,
  subscribeOperatorContextInvalidation,
} from '../tak/operatorContext.js';

/** Construct the application globe using the caller's local configuration. */
export async function createApplicationScene({
  requestServices,
  googleApiKey,
  googleTokens = null,
  cesiumToken,
  credits,
  MapController = MapStackController,
  mapOptions = {},
  loaderStatus,
  signal,
  defer,
}) {
  // Account authorization precedes both retained map reads and TAK identity boot.
  // Embedded views never restore a private retained map from the host profile.
  const accountContext = isEmbedded()
    ? null
    : await resolveOperatorContext({ signal });
  if (accountContext?.sessionExpired) {
    window.location.replace('/login');
    throw new DOMException('Operator session expired', 'AbortError');
  }
  const accountLifetime = new AbortController();
  const accountSignal = AbortSignal.any([signal, accountLifetime.signal]);
  let savedMap = null,
    mapStackController = null;
  if (accountContext)
    defer(
      subscribeOperatorContextInvalidation(() => {
        accountLifetime.abort(
          new DOMException('Operator account changed', 'AbortError'),
        );
        savedMap?.store.close();
        for (const stack of mapStackController?.getStacks() || [])
          if (stack.id.startsWith('offline-'))
            mapStackController.removeLocalSource(stack.id);
      }),
    );
  const operations = createApplicationOperations({
    requests: requestServices,
    signal,
  });
  defer(initLogoGaze());
  const previousKey = window.__GOOGLE_MAPS_API_KEY__;
  if (googleApiKey) {
    window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
    defer(() => {
      if (window.__GOOGLE_MAPS_API_KEY__ !== googleApiKey) return;
      if (previousKey === undefined) delete window.__GOOGLE_MAPS_API_KEY__;
      else window.__GOOGLE_MAPS_API_KEY__ = previousKey;
    });
  }
  loaderStatus.textContent = 'Configuring viewer...';
  // Provider attribution stays visible, including clean-view and recording.
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  document.body.appendChild(creditContainer);
  defer(() => creditContainer.remove());
  const viewer = createApplicationViewer({
    container: 'cesiumContainer',
    creditContainer,
  });
  defer(() => {
    uninstallRenderGovernor(viewer);
    if (!viewer.isDestroyed()) viewer.destroy();
  });
  defer(installTrackpadPinchZoom(viewer));
  registerDataCredits(viewer, credits);
  configureCreditKeyboardAccess(document);
  // Read existing opt-in storage before starting any default map/terrain fetch.
  savedMap = accountContext
    ? await readSelectedOfflinePack({
        signal: accountSignal,
        context: accountContext,
      })
    : null;
  if (savedMap) {
    defer(() => savedMap.store.close());
    markTakDataPrivate(viewer);
  }
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? 'Loading Google 3D Tiles...'
      : 'Loading the keyless globe...';
  const photoreal = savedMap
    ? { tileset: null, errors: [], route: 'saved-map' }
    : await loadPhotorealisticTileset(Cesium, {
        googleApiKey,
        googleTokens,
        cesiumToken,
      });
  const tileset = photoreal.tileset;
  // A provider can finish after cancellation; retain ownership of its result.
  defer(() => {
    if (tileset && !tileset.isDestroyed()) {
      if (!viewer.scene.primitives.remove(tileset)) tileset.destroy();
    }
  });
  signal.throwIfAborted();
  if (tileset) {
    viewer.scene.primitives.add(tileset);
    // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
    // Google Photorealistic 3D Tiles provide their own terrain/elevation.
    viewer.scene.globe.show = false;
    console.info(`[Init] Google 3D Tiles loaded via ${photoreal.route}.`);
  } else {
    if (photoreal.errors.length) {
      const tileError = photoreal.errors.at(-1);
      console.warn(
        '[Init] Google 3D Tiles unavailable, using the keyless globe:',
        tileError,
      );
      const tileErrorDetail = describeError(tileError);
      loaderStatus.textContent = `Google 3D Tiles unavailable (${tileErrorDetail}). Loading the keyless globe...`;
    }
    viewer.scene.globe.show = true;
  }

  loaderStatus.textContent = 'Initializing systems...';

  accountSignal.throwIfAborted();
  mapStackController = new MapController(viewer, {
    requestRender: governorRequestRender,
    ...mapOptions,
    googleTileset: tileset,
    cesiumToken,
    initialStack: tileset ? 'photoreal' : 'esri-imagery',
    ...(savedMap && (googleApiKey || googleTokens || cesiumToken)
      ? {
          createGoogleTileset: async ({ signal: mapSignal }) => {
            mapSignal?.throwIfAborted();
            const result = await loadPhotorealisticTileset(Cesium, {
              googleApiKey,
              googleTokens,
              cesiumToken,
            });
            if (!result.tileset)
              throw (
                result.errors.at(-1) || new Error('Google 3D is unavailable')
              );
            if (mapSignal?.aborted) {
              if (!result.tileset.isDestroyed()) result.tileset.destroy();
              mapSignal.throwIfAborted();
            }
            return result.tileset;
          },
        }
      : {}),
    // Task 5 (height-datum fix): rebroadcast stack changes as a window
    // CustomEvent so data layers (CCTV per-regime ground resolution) can
    // react without coupling MapStackController to layer modules. Fires on
    // 'switching'/'ready'/'error'; listeners derive the surface regime from
    // live scene state, so intermediate emissions are harmless.
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  const initialMap = savedMap
    ? mapStackController.registerLocalSource(
        offlineSource(savedMap.manifest, savedMap.store),
      )
    : tileset
      ? 'photoreal'
      : 'esri-imagery';
  await mapStackController.setStack(initialMap, {
    silent: true,
  });

  accountSignal.throwIfAborted();
  signal.throwIfAborted();
  return {
    viewer,
    tileset,
    mapStackController,
    operations,
    savedMapBounds: savedMap?.manifest.bounds || null,
  };
}
