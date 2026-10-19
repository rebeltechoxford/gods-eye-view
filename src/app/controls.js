import { catalogControlServices } from './catalog.js';
import { StyleManager } from '../ui/composition.js';
import {
  DEFAULT_START_VIEW,
  flyToStartView,
  formatStartViewPlace,
  readStartView,
} from '../ui/startView.js';
import { initCockpitCloudEffects } from '../cockpitCloudEffects.js';
import * as Cesium from 'cesium';

/** Construct the existing controls and camera presentation. */
export function createApplicationControls({
  scene: { viewer, mapStackController, operations, savedMapBounds },
  loaderStatus,
  Controls = StyleManager,
  services,
  catalog,
  placeSearch,
  defer,
}) {
  // Initialize the style manager (post-processing, HUD, locations, share links)
  const styleManager = new Controls(viewer, {
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
      loaderStatus.textContent = 'Opening saved map area...';
      const { west, south, east, north } = savedMapBounds;
      viewer.camera.setView({
        destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
      });
    } else {
      const startView = readStartView();
      loaderStatus.textContent = `Flying to ${startView ? startView.label || formatStartViewPlace(startView) : 'Austin, TX'}...`;
      defer(flyToStartView(viewer, startView || DEFAULT_START_VIEW));
    }
  } else {
    loaderStatus.textContent = 'Restoring shared view...';
  }

  return { styleManager, weatherEffects, cockpitCloudEffects };
}
