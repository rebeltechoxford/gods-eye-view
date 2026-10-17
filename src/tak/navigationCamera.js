import { Cartesian3, Cartographic } from 'cesium';
import { validateWaypoint } from './navigation.js';

/** Use the same explicit-navigation owner as contact focus/public GEV controls. */
export function createNavigationFocus(viewer, navigate = (fly) => fly()) {
  return (target) => {
    const point = validateWaypoint(target);
    return navigate(() => {
      const surface = viewer.scene.globe.getHeight(
        Cartographic.fromDegrees(point.lon, point.lat),
      );
      viewer.selectedEntity = undefined;
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(
          point.lon,
          point.lat,
          // Do not dive beneath unresolved mountain terrain. This is an overview
          // framing height, never a waypoint altitude or a measured elevation.
          Math.max(12000, (Number.isFinite(surface) ? surface : 0) + 2500),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 1.2,
      });
      return true;
    });
  };
}
