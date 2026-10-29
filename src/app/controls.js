import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import {
  DEFAULT_START_VIEW,
  flyToStartView,
  formatStartViewPlace,
  restoreStartViewPrivacy,
  START_VIEW_STORAGE_KEY,
} from '../ui/startView.js';
import { identityStorageKey } from '../tak/operatorContext.js';
import { isEmbedded } from './embed.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import * as Cesium from 'cesium';
import { t } from '../i18n/index.js';

/**
 * Construct the existing controls and camera presentation. `initialShareCode`
 * opens a share code (the `<code>` of `/share/<code>`) at start-up, for a host
 * whose address does not carry one.
 */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations, savedMapBounds },
  loaderStatus,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
  initialShareCode = null,
}) {
  // Bind persistence to the already-resolved operator. Never expose another
  // account's view (or a personal view in an embed), and restore sticky privacy
  // before constructing HUD/share consumers, even when a link overrides the view.
  const embedded = isEmbedded();
  const startViewStorageKey = embedded
    ? null
    : identityStorageKey(START_VIEW_STORAGE_KEY);
  const canUseStartViewStorage = () =>
    !embedded &&
    startViewStorageKey !== null &&
    identityStorageKey(START_VIEW_STORAGE_KEY) === startViewStorageKey;
  const startView = restoreStartViewPrivacy(viewer, {
    storageKey: startViewStorageKey,
    embedded,
  });
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
    startViewStorageKey,
    canUseStartViewStorage,
    services: {
      ...services,
      ...operations.surface.controlServices,
      searchAndFlyTo: operations.searchAndFlyTo,
      fetchRegionalBrief: (...args) =>
        operations.requests.regional.getBrief(...args),
      ...catalogControlServices(catalog),
    },
    requestServices: operations.requests,
    mapStackController,
    placeSearch,
    // A share code to open at start-up instead of the page's address.
    initialShareCode,
  });
  // An explicit device map survives stale public map= fields in old URLs.
  // Camera, visual, panel and layer restoration keep their existing authority.
  if (savedMapBounds) styleManager.shareLinkManager?.claimRestoreLane('map');
  defer(() => styleManager.orbitController.stop());
  defer(() => styleManager.hud.destroy());
  defer(() => styleManager.dispose());
  // The previous multi-canvas weather compositor remains disabled. Cockpit
  // clouds use a separate, capped low-resolution GPU pass that never attaches
  // Cesium fog or post-process stages and is fully stopped in map mode.
  const weatherEffects = null;
  const cockpitCloudEffects = initCockpitCloudEffects(viewer, {
    weatherService: operations.requests.weather,
  });
  defer(() => cockpitCloudEffects?.destroy());

  // Without a share link or saved map area, open on this device's start view
  // (Location tray, "Start here"), else the built-in default.
  if (!styleManager.hasShareState) {
    if (savedMapBounds) {
      loaderStatus.textContent = t('Opening saved map area...');
      const { west, south, east, north } = savedMapBounds;
      viewer.camera.setView({
        destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
      });
    } else {
      const view = startView || DEFAULT_START_VIEW;
      loaderStatus.textContent =
        view === DEFAULT_START_VIEW
          ? t('Flying to Austin, TX...')
          : t('Flying to {place}...', {
              place: view.label || formatStartViewPlace(view),
            });
      defer(flyToStartView(viewer, view));
    }
  } else {
    loaderStatus.textContent = t('Restoring shared view...');
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
