import * as Cesium from 'cesium';
import { geometryColorRgba } from './geometry.js';

function color(value, opacity) {
  const rgba = geometryColorRgba(value);
  return new Cesium.Color(
    rgba.red,
    rgba.green,
    rgba.blue,
    rgba.alpha * opacity,
  );
}

/** Geometry HAE is ellipsoidal. Unknown altitude is ground-clamped as a whole. */
export function geometryGraphics(
  geometry,
  { stale = false, draft = false } = {},
) {
  const ground = geometry.vertices.every(
    (point) => point.hae === null || point.hae === undefined,
  );
  const positions = geometry.vertices.map((point) =>
    Cesium.Cartesian3.fromDegrees(point.lon, point.lat, ground ? 0 : point.hae),
  );
  const opacity = stale ? 0.4 : draft ? 0.75 : 1;
  const stroke = color(geometry.style.strokeColor, opacity);
  let material = stroke;
  if (draft || ['dashed', 'dotted'].includes(geometry.style.strokeStyle))
    material = new Cesium.PolylineDashMaterialProperty({
      color: stroke,
      dashLength: geometry.style.strokeStyle === 'dotted' ? 4 : 16,
    });
  else if (geometry.style.strokeStyle === 'outlined')
    material = new Cesium.PolylineOutlineMaterialProperty({
      color: stroke,
      outlineColor: Cesium.Color.BLACK.withAlpha(opacity),
      outlineWidth: 1,
    });
  return {
    polyline: {
      positions:
        geometry.kind === 'polygon' ? [...positions, positions[0]] : positions,
      width: geometry.style.strokeWidth,
      clampToGround: ground,
      arcType: Cesium.ArcType.GEODESIC,
      material,
    },
    polygon:
      geometry.kind === 'polygon'
        ? {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            perPositionHeight: !ground,
            material: color(geometry.style.fillColor, opacity),
            arcType: Cesium.ArcType.GEODESIC,
          }
        : undefined,
  };
}
