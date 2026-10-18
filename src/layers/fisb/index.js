// FIS-B Weather: the weather and airspace picture your own 978 MHz receiver
// hears, decoded on the host (/api/fisb). METAR stations are colored by
// flight category; NOTAM/TFR, AIRMET, SIGMET, G-AIRMET and SUA areas are
// outlined; NEXRAD precipitation is draped as one image. Clicking a station or
// an area shows its text. Nothing here reaches the internet.

import * as Cesium from 'cesium';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from '../../data/contextStore.js';
import { isPointerFree } from '../../data/inputOwnership.js';
import { resolveImageryHost } from '../../maps/imageryHost.js';
import { governorRequestRender } from '../../renderGovernor.js';
import {
  FISB_LAYER_ID,
  FISB_LAYER_NAME,
  FISB_LAYER_SOURCE,
  FISB_REFRESH_MS,
} from './policy.js';
import {
  currentOverlays,
  fisbStatusText,
  reportCard,
  reportColor,
  stationCard,
  stationColor,
  stationsFromTexts,
} from './presentation.js';
import { composeRadar } from './radar.js';
import { createFisbSource } from './source.js';

export { FISB_LAYER_ID } from './policy.js';

const NM = 1852;
const CIRCLE_STEPS = 48;
const RADAR_ALPHA = 0.75;

function circlePositions(lon, lat, radiusM) {
  const positions = [];
  const latRad = Cesium.Math.toRadians(lat);
  for (let i = 0; i <= CIRCLE_STEPS; i++) {
    const angle = (i / CIRCLE_STEPS) * Math.PI * 2;
    const dLat = (radiusM * Math.cos(angle)) / 111_320;
    const dLon =
      (radiusM * Math.sin(angle)) /
      (111_320 * Math.max(0.01, Math.cos(latRad)));
    positions.push(Cesium.Cartesian3.fromDegrees(lon + dLon, lat + dLat));
  }
  return positions;
}

/**
 * @param {object} [options]
 * @param {ReturnType<typeof createFisbSource>} [options.source]
 * @param {() => number} [options.now]
 * @param {(canvas:HTMLCanvasElement) => object} [options.createInputHandler]
 */
export function createFisbLayer({
  source = createFisbSource(),
  now = Date.now,
  host = resolveImageryHost,
  createInputHandler = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
} = {}) {
  let viewer = null;
  let tileset = null;
  let dataSource = null;
  let enabled = false;
  let clickHandler = null;
  let picture = null;
  let radar = null;
  let state = { configured: null, error: null, lastUpdate: null };
  let imagery = null;
  let imageryCollection = null;
  let radarKey = null;
  let selected = null;
  let requestGeneration = 0;

  function clearPicture() {
    picture = null;
    radar = null;
    source.reset?.();
    clearSelection();
    clearImagery();
    dataSource?.entities.removeAll();
    governorRequestRender('fisb-clear');
  }

  function clearImagery() {
    if (imagery && imageryCollection && !imageryCollection.isDestroyed?.())
      imageryCollection.remove(imagery, true);
    imagery = null;
    imageryCollection = null;
    radarKey = null;
  }

  function drawRadar() {
    const key = `${radar?.[64]?.revision}|${radar?.[63]?.revision}`;
    if (imagery && key === radarKey) return;
    clearImagery();
    if (!enabled || !viewer) return;
    const image = composeRadar([radar?.[64], radar?.[63]]);
    if (!image) {
      radarKey = key;
      return;
    }
    const { collection, kind } = host({ viewer, tileset }) || {};
    if (!collection || kind === 'none') return;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(image.width, image.height);
    pixels.data.set(image.rgba);
    context.putImageData(pixels, 0, 0);
    const provider = new Cesium.SingleTileImageryProvider({
      url: canvas.toDataURL('image/png'),
      tileWidth: image.width,
      tileHeight: image.height,
      rectangle: Cesium.Rectangle.fromDegrees(
        image.west,
        image.south,
        image.east,
        image.north,
      ),
    });
    imagery = collection.addImageryProvider(provider);
    imagery.alpha = RADAR_ALPHA;
    imageryCollection = collection;
    radarKey = key;
  }

  function addStation(station) {
    const color = Cesium.Color.fromCssColorString(stationColor(station));
    const position = Cesium.Cartesian3.fromDegrees(station.lon, station.lat);
    const entity = dataSource.entities.add({
      id: `fisb:station:${station.id}`,
      position,
      point: {
        pixelSize: station.hasMetar ? 9 : 6,
        color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.8),
        outlineWidth: 1.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevFisb = {
      kind: 'station',
      station,
      lon: station.lon,
      lat: station.lat,
    };
  }

  function addOverlay(report, overlay, index) {
    const color = Cesium.Color.fromCssColorString(reportColor(report));
    const id = `fisb:report:${report.id}:${overlay.id}:${index}`;
    const anchor = { lon: 0, lat: 0 };
    let entity;
    if (overlay.shape === 'circle') {
      const [vertex] = overlay.vertices;
      if (!vertex) return;
      anchor.lon = vertex.lon;
      anchor.lat = vertex.lat;
      entity = dataSource.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(vertex.lon, vertex.lat),
        polyline: {
          positions: circlePositions(
            vertex.lon,
            vertex.lat,
            Math.max(0.2, vertex.radiusNm) * NM,
          ),
          width: 2,
          material: color.withAlpha(0.9),
          clampToGround: true,
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
    } else {
      const points = overlay.vertices.filter(
        (v) =>
          Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]),
      );
      if (!points.length) return;
      anchor.lon = points.reduce((sum, v) => sum + v[0], 0) / points.length;
      anchor.lat = points.reduce((sum, v) => sum + v[1], 0) / points.length;
      const positions = points.map(([lon, lat]) =>
        Cesium.Cartesian3.fromDegrees(lon, lat),
      );
      if (overlay.shape === 'point' || positions.length === 1) {
        entity = dataSource.entities.add({
          id,
          position: positions[0],
          point: {
            pixelSize: 5,
            color: color.withAlpha(0.9),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
      } else if (overlay.shape === 'polygon' && positions.length >= 3) {
        entity = dataSource.entities.add({
          id,
          position: Cesium.Cartesian3.fromDegrees(anchor.lon, anchor.lat),
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(positions),
            material: color.withAlpha(0.14),
            classificationType: Cesium.ClassificationType.BOTH,
            arcType: Cesium.ArcType.GEODESIC,
          },
          polyline: {
            positions: [...positions, positions[0]],
            width: 2,
            material: color.withAlpha(0.9),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
      } else {
        entity = dataSource.entities.add({
          id,
          position: positions[0],
          polyline: {
            positions,
            width: 2,
            material: color.withAlpha(0.9),
            clampToGround: true,
            classificationType: Cesium.ClassificationType.BOTH,
          },
        });
      }
    }
    entity.gevFisb = { kind: 'report', report, overlay, ...anchor };
  }

  function addReportPoint(report) {
    const [lon, lat] = report.position;
    const entity = dataSource.entities.add({
      id: `fisb:report:${report.id}`,
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize: 5,
        color: Cesium.Color.fromCssColorString(reportColor(report)).withAlpha(
          0.9,
        ),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    entity.gevFisb = { kind: 'report', report, overlay: null, lon, lat };
  }

  function render() {
    if (!dataSource) return;
    const keep = selected?.gevFisb;
    clearSelection();
    dataSource.entities.suspendEvents();
    dataSource.entities.removeAll();
    if (picture && enabled) {
      const at = now();
      for (const report of picture.reports ?? []) {
        const overlays = currentOverlays(report, at);
        if (overlays.length)
          overlays.forEach((overlay, i) => addOverlay(report, overlay, i));
        else if (!report.overlays?.length && Array.isArray(report.position))
          addReportPoint(report);
      }
      for (const station of stationsFromTexts(picture.texts))
        addStation(station);
    }
    dataSource.entities.resumeEvents();
    drawRadar();
    // Keep a selection across refreshes when its subject is still there.
    if (keep) {
      const match = dataSource.entities.values.find(
        (entity) =>
          entity.gevFisb?.kind === keep.kind &&
          (keep.kind === 'station'
            ? entity.gevFisb.station.id === keep.station.id
            : entity.gevFisb.report.id === keep.report.id),
      );
      if (match) select(match);
    }
    governorRequestRender('fisb-update');
  }

  function select(entity) {
    const item = entity.gevFisb;
    const at = now();
    const card =
      item.kind === 'station'
        ? stationCard(item.station, at)
        : reportCard(item.report, item.overlay, at);
    const position = Cesium.Cartesian3.fromDegrees(item.lon, item.lat);
    entity.gevDisplayPosition = () => position;
    entity.gevTrackedId = entity.id;
    entity.gevLabelModel = card;
    registerEntityContext(entity, {
      id: entity.id,
      layerId: FISB_LAYER_ID,
      dataSource,
      layerName: FISB_LAYER_NAME,
      source: FISB_LAYER_SOURCE,
      label: card.title,
      latitude: item.lat,
      longitude: item.lon,
      properties: { kind: item.kind, text: card.details.join('\n') },
    });
    selected = entity;
    selectEntityContext(entity);
    governorRequestRender('fisb-selection');
  }

  function clearSelection() {
    if (!selected) return;
    selected = null;
    clearSelectedEntityContextForLayer(FISB_LAYER_ID);
    removeEntityContextsForLayer(FISB_LAYER_ID);
  }

  function installInteraction() {
    if (clickHandler || !viewer?.scene?.canvas) return;
    clickHandler = createInputHandler(viewer.scene.canvas);
    clickHandler.setInputAction((click) => {
      if (!enabled || !isPointerFree()) return;
      const picked = viewer.scene.pick(click.position);
      const entity = picked?.id;
      if (entity?.gevFisb && dataSource?.entities.contains(entity)) {
        select(entity);
        return;
      }
      if (selected) {
        clearSelection();
        governorRequestRender('fisb-selection');
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function releaseInteraction() {
    clickHandler?.destroy();
    clickHandler = null;
  }

  const layer = {
    id: FISB_LAYER_ID,
    name: FISB_LAYER_NAME,
    icon: '🛩️',
    source: FISB_LAYER_SOURCE,
    updateInterval: FISB_REFRESH_MS,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(FISB_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      return true;
    },

    async enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      installInteraction();
      render();
      return true;
    },

    async disable() {
      enabled = false;
      requestGeneration++;
      releaseInteraction();
      clearPicture();
      if (dataSource) {
        dataSource.show = false;
      }
      governorRequestRender('fisb-disable');
      return true;
    },

    async update(_viewer, { signal } = {}) {
      const generation = ++requestGeneration;
      try {
        const result = await source.fetchPicture({ signal });
        if (signal?.aborted || generation !== requestGeneration) return false;
        state = {
          configured: result.configured,
          missing: result.missing === true,
          error: null,
          lastUpdate: now(),
        };
        picture = result.configured ? result.picture : null;
        radar = result.configured ? result.radar : null;
        if (enabled) render();
        return true;
      } catch (error) {
        if (signal?.aborted || generation !== requestGeneration) return false;
        state = {
          ...state,
          error: error?.message || 'FIS-B route unavailable',
        };
        // A failed refresh cannot establish that a weather or airspace
        // product is still current. Do not leave its old geometry on the map.
        clearPicture();
        return false;
      }
    },

    getStats() {
      const stations = picture ? stationsFromTexts(picture.texts).length : 0;
      const reports = picture?.reports?.length ?? 0;
      const base = {
        count: stations + reports,
        lastUpdate: state.lastUpdate,
        source: FISB_LAYER_SOURCE,
      };
      if (state.error) return { ...base, status: 'error', error: state.error };
      if (state.configured === false)
        return {
          ...base,
          status: state.missing ? 'unavailable' : 'idle',
          ...(state.missing ? { error: 'This host has no FIS-B route' } : {}),
          statusMessage:
            'Set FISB_FEEDS on the host to a 978 MHz receiver (docs/FISB.md)',
        };
      if (state.configured === null) return { ...base, loading: true };
      return {
        ...base,
        status: 'live',
        statusMessage: fisbStatusText(picture, radar),
      };
    },

    /** The photoreal tileset, for draping radar while the globe is hidden. */
    attachTileset(next) {
      tileset = next || null;
    },

    destroy() {
      enabled = false;
      requestGeneration++;
      releaseInteraction();
      clearPicture();
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      viewer = null;
    },
  };
  return layer;
}
