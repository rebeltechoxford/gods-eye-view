import * as Cesium from 'cesium';
import { geometryGraphics } from './geometryGraphics.js';
import {
  registerPickOwner,
  unregisterPickOwner,
  resolvePickId,
} from '../data/pickRegistry.js';
import {
  bindTrackingClickGesture,
  isTrackingSelectionGesture,
} from '../data/trackingClickGesture.js';

/** World-overlay source id for TAK callsign cards. */
export const TAK_OVERLAY_SOURCE_ID = 'tak-contacts';
export const TAK_SYMBOL_PX = 26;
export const TAK_FOCUS_RANGE_M = 2000;

/** MIL-STD-2525-style frame fills by affiliation family. */
export const TAK_AFFILIATION_COLORS = Object.freeze({
  friendly: '#80e0ff',
  hostile: '#ff8080',
  neutral: '#aaffaa',
  unknown: '#ffff80',
  marker: '#f0cd70',
});
const SELF_COLOR = '#64c4ff';
const EMERGENCY_COLOR = '#ff3b30';

/**
 * Draw a symbol frame: friendly = rounded rectangle, hostile = diamond,
 * neutral = square, unknown = quatrefoil, marker = pin dot. Stale symbols are
 * translucent with a dashed outline; emergencies get a red ring.
 * Returns a canvas (cached per visual key by the caller).
 */
export function drawTakSymbol(
  { affiliation, stale = false, emergency = false, self = false },
  size = TAK_SYMBOL_PX,
) {
  const canvas = document.createElement('canvas');
  const scale = 2; // crisp on high-DPR displays
  canvas.width = canvas.height = size * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  const c = size / 2;
  const r = size * 0.32;
  ctx.globalAlpha = stale ? 0.45 : 1;
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#000';
  if (stale) ctx.setLineDash([3, 2]);
  ctx.fillStyle = self
    ? SELF_COLOR
    : TAK_AFFILIATION_COLORS[affiliation] || TAK_AFFILIATION_COLORS.unknown;
  ctx.beginPath();
  switch (affiliation) {
    case 'friendly':
      if (typeof ctx.roundRect === 'function')
        ctx.roundRect(c - r * 1.25, c - r * 0.85, r * 2.5, r * 1.7, 3);
      else ctx.rect(c - r * 1.25, c - r * 0.85, r * 2.5, r * 1.7);
      break;
    case 'hostile':
      ctx.moveTo(c, c - r * 1.3);
      ctx.lineTo(c + r * 1.3, c);
      ctx.lineTo(c, c + r * 1.3);
      ctx.lineTo(c - r * 1.3, c);
      ctx.closePath();
      break;
    case 'neutral':
      ctx.rect(c - r, c - r, r * 2, r * 2);
      break;
    case 'unknown': {
      const lobe = r * 0.62;
      ctx.arc(c, c - lobe, lobe, Math.PI * 0.75, Math.PI * 2.25);
      ctx.arc(c + lobe, c, lobe, Math.PI * 1.25, Math.PI * 2.75);
      ctx.arc(c, c + lobe, lobe, Math.PI * 1.75, Math.PI * 3.25);
      ctx.arc(c - lobe, c, lobe, Math.PI * 0.25, Math.PI * 1.75);
      ctx.closePath();
      break;
    }
    default:
      ctx.arc(c, c, r * 0.8, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  if (self) {
    ctx.setLineDash([]);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(c, c, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  if (emergency) {
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = EMERGENCY_COLOR;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(c, c, size * 0.47, 0, Math.PI * 2);
    ctx.stroke();
  }
  return canvas;
}

function symbolKey(contact, stale) {
  return `${contact.affiliation}|${stale}|${contact.emergency}|${contact.origin === 'self'}`;
}

function accentOf(contact) {
  if (contact.emergency) return EMERGENCY_COLOR;
  if (contact.origin === 'self') return SELF_COLOR;
  return (
    TAK_AFFILIATION_COLORS[contact.affiliation] ||
    TAK_AFFILIATION_COLORS.unknown
  );
}

export function isAirborne(contact) {
  const dimension = contact.type.split('-')[2];
  return (
    (dimension === 'A' || dimension === 'P') &&
    Number.isFinite(contact.point.hae)
  );
}

function absoluteHeight(contact) {
  return (
    isAirborne(contact) ||
    (contact.geometryResult?.status === 'ok' &&
      contact.geometryResult.geometry.altitudeMode === 'absolute')
  );
}

/** CoT HAE is already ellipsoidal; never apply the MSL geoid correction. */
export function cotTrailPositions(contact) {
  const airborne = isAirborne(contact);
  return contact.trail
    .filter((point) => !airborne || Number.isFinite(point.hae))
    .map((point) =>
      Cesium.Cartesian3.fromDegrees(
        point.lon,
        point.lat,
        airborne ? point.hae : 0,
      ),
    );
}

function detailLines(contact, stale) {
  const lines = [];
  const geometry = contact.geometryResult;
  if (geometry?.status === 'ok') {
    lines.push(
      `${geometry.geometry.kind.toUpperCase()} · ${geometry.geometry.vertices.length} vertices`,
    );
    if (geometry.geometry.kind === 'route')
      lines.push(
        `${geometry.geometry.route.method} · ${geometry.geometry.route.direction}`,
      );
  } else if (geometry && geometry.status !== 'not-geometry')
    lines.push(`Geometry ${geometry.status}: ${geometry.reason}`);
  if (Number.isFinite(contact.point.hae))
    lines.push(`HAE ${Math.round(contact.point.hae)} m`);
  const group = contact.event.detail.group;
  if (group?.name || group?.role)
    lines.push([group.name, group.role].filter(Boolean).join(' · '));
  const track = contact.event.detail.track;
  if (Number.isFinite(track?.speed) && track.speed > 0.5) {
    lines.push(
      `${Math.round(track.speed * 3.6)} km/h${Number.isFinite(track.course) ? ` · ${Math.round(track.course)}°` : ''}`,
    );
  }
  if (contact.emergency)
    lines.push(contact.event.detail.emergency?.type || 'EMERGENCY');
  if (stale) lines.push('STALE');
  return lines;
}

/**
 * Cesium presentation of TAK state. Symbols and trails live in a dedicated
 * data source (separate from GEV's public-data layers and share links);
 * callsign cards use the shared world-overlay host as the repository requires.
 *
 * @param {Cesium.Viewer} viewer
 * @param {{setEntries:Function, clearSource:Function, setVisible:Function}} overlays
 * @param {{onActivate?:(uid:string)=>void}} [options]
 */
export function createCotOverlay(
  viewer,
  overlays,
  { onActivate = () => {}, navigate = (fly) => fly() } = {},
) {
  const dataSource = new Cesium.CustomDataSource('TAK contacts');
  const symbols = new Map();
  const entities = new Map(); // uid -> {entity, trail, key}
  let disposed = false;
  let visible = true;
  let draftEntity = null;
  registerPickOwner(
    'tak',
    (id) =>
      id.startsWith('tak:') ||
      id.startsWith('tak-trail:') ||
      id.startsWith('tak-draft:'),
  );
  const clicks = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  bindTrackingClickGesture(clicks, (click, gesture) => {
    if (disposed || !visible || !isTrackingSelectionGesture(gesture)) return;
    const id = resolvePickId(viewer.scene.pick(click.position));
    if (id?.startsWith('tak:')) onActivate(id.slice(4));
  });
  void viewer.dataSources
    .add(dataSource)
    .then(() => {
      if (disposed) viewer.dataSources.remove(dataSource, true);
    })
    .catch((error) => console.warn('[TAK] Layer unavailable', error));

  function symbolFor(contact, stale) {
    const key = symbolKey(contact, stale);
    let canvas = symbols.get(key);
    if (!canvas) {
      canvas = drawTakSymbol({
        affiliation: contact.affiliation,
        stale,
        emergency: contact.emergency,
        self: contact.origin === 'self',
      });
      symbols.set(key, canvas);
    }
    return { key, canvas };
  }

  function positionOf(contact) {
    const { lat, lon, hae } = contact.point;
    return Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      absoluteHeight(contact) ? hae : 0,
    );
  }

  function upsert(contact, stale) {
    const position = positionOf(contact);
    const { key, canvas } = symbolFor(contact, stale);
    const airborne = isAirborne(contact);
    let record = entities.get(contact.uid);
    if (!record) {
      const entity = dataSource.entities.add({
        id: `tak:${contact.uid}`,
        name: contact.callsign,
        position,
        billboard: {
          image: canvas,
          width: TAK_SYMBOL_PX,
          height: TAK_SYMBOL_PX,
          heightReference: airborne
            ? Cesium.HeightReference.NONE
            : Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      record = { entity, trail: null, key, airborne };
      entities.set(contact.uid, record);
    } else {
      record.entity.position = position;
      record.entity.name = contact.callsign;
      if (record.key !== key) {
        record.entity.billboard.image = canvas;
        record.key = key;
      }
      if (record.airborne !== airborne) {
        record.entity.billboard.heightReference = airborne
          ? Cesium.HeightReference.NONE
          : Cesium.HeightReference.CLAMP_TO_GROUND;
        record.airborne = airborne;
      }
    }
    const geometry = contact.geometryResult;
    if (geometry?.status === 'ok') {
      const graphics = geometryGraphics(geometry.geometry, { stale });
      record.entity.polyline = graphics.polyline;
      record.entity.polygon = graphics.polygon;
      record.entity.billboard.show = false;
    } else {
      record.entity.polyline = undefined;
      record.entity.polygon = undefined;
      record.entity.billboard.show =
        !geometry || geometry.status === 'not-geometry';
    }
    // Trail: recent positions of moving SA contacts.
    if (contact.trail.length >= 2) {
      const positions = cotTrailPositions(contact);
      if (!record.trail) {
        record.trail = dataSource.entities.add({
          id: `tak-trail:${contact.uid}`,
          polyline: {
            positions,
            width: 2,
            clampToGround: !airborne,
            material: Cesium.Color.fromCssColorString(
              accentOf(contact),
            ).withAlpha(stale ? 0.25 : 0.6),
          },
        });
      } else {
        record.trail.polyline.positions = positions;
        record.trail.polyline.clampToGround = !airborne;
        record.trail.polyline.material = Cesium.Color.fromCssColorString(
          accentOf(contact),
        ).withAlpha(stale ? 0.25 : 0.6);
      }
    } else if (record.trail) {
      dataSource.entities.remove(record.trail);
      record.trail = null;
    }
  }

  function remove(uid) {
    const record = entities.get(uid);
    if (!record) return;
    dataSource.entities.remove(record.entity);
    if (record.trail) dataSource.entities.remove(record.trail);
    entities.delete(uid);
  }

  return Object.freeze({
    /**
     * Reconcile the scene with the store's contacts (diffed by uid).
     * @param {import('./store.js').TakContact[]} contacts
     * @param {(c:object)=>boolean} isStale
     */
    render(contacts, isStale) {
      if (disposed) return;
      const live = new Set();
      const cards = [];
      dataSource.entities.suspendEvents();
      try {
        for (const contact of contacts) {
          live.add(contact.uid);
          const stale = isStale(contact);
          const prior = entities.get(contact.uid);
          // Store contacts are immutable snapshots. A status notification or a
          // different contact's update must not dirty every Cesium entity/card.
          if (prior?.contact === contact && prior.stale === stale) {
            cards.push(prior.card);
            continue;
          }
          upsert(contact, stale);
          const { lat, lon, hae } = contact.point;
          const height = absoluteHeight(contact) ? hae : 0;
          const card = {
            id: contact.uid,
            position: Cesium.Cartesian3.fromDegrees(lon, lat, height),
            // Lifted anchor so the horizon test judges the real surface.
            cullPosition: Cesium.Cartesian3.fromDegrees(lon, lat, height + 500),
            variant: 'card',
            cardStyle: 'tactical',
            collisionGroup: 'ambient-card',
            horizonCull: true,
            terrainOcclusion: false,
            interactive: true,
            gapPx: TAK_SYMBOL_PX / 2 + 6,
            verticalOnly: true,
            title: contact.callsign,
            details: detailLines(contact, stale),
            accent: accentOf(contact),
            priority: contact.emergency
              ? 3000
              : contact.origin === 'self'
                ? 2000
                : stale
                  ? 100
                  : 1000,
            protected: contact.emergency || contact.origin === 'self',
            accessibilityLabel: `Focus ${contact.callsign}`,
            activate: () => onActivate(contact.uid),
          };
          const record = entities.get(contact.uid);
          record.contact = contact;
          record.stale = stale;
          record.card = card;
          cards.push(card);
        }
        for (const uid of Array.from(entities.keys())) {
          if (!live.has(uid)) remove(uid);
        }
      } finally {
        dataSource.entities.resumeEvents();
      }
      overlays.setEntries(TAK_OVERLAY_SOURCE_ID, cards, { visible });
      viewer.scene.requestRender();
    },
    setVisible(next) {
      visible = next !== false;
      dataSource.show = visible;
      overlays.setVisible(TAK_OVERLAY_SOURCE_ID, visible);
      viewer.scene.requestRender();
    },
    isVisible: () => visible,
    /** Draft remains private and is removed on clear, expiry, logout and teardown. */
    setDraftGeometry(geometry) {
      if (disposed) return;
      if (draftEntity) dataSource.entities.remove(draftEntity);
      draftEntity = geometry
        ? dataSource.entities.add({
            id: 'tak-draft:editor',
            ...geometryGraphics(geometry, { draft: true }),
          })
        : null;
      viewer.scene.requestRender();
    },
    focusDraft() {
      if (disposed || !draftEntity) return false;
      return navigate(() => {
        viewer.selectedEntity = undefined;
        void viewer
          .flyTo(draftEntity, { duration: 1.2 })
          .catch((error) => console.warn('[TAK] Cannot focus drawing', error));
        return true;
      });
    },
    focus(uid) {
      if (disposed) return;
      const record = entities.get(uid);
      if (!record) return;
      const geometry = record.contact.geometryResult;
      if (geometry && !['ok', 'not-geometry'].includes(geometry.status))
        return false;
      return navigate(() => {
        viewer.selectedEntity = record.entity;
        void viewer
          .flyTo(record.entity, {
            duration: 1.2,
            offset: new Cesium.HeadingPitchRange(
              viewer.camera.heading || 0,
              Cesium.Math.toRadians(-40),
              geometry?.status === 'ok' ? 0 : TAK_FOCUS_RANGE_M,
            ),
          })
          .catch((error) => console.warn('[TAK] Cannot focus contact', error));
        return true;
      });
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      clicks.destroy();
      unregisterPickOwner('tak');
      overlays.clearSource(TAK_OVERLAY_SOURCE_ID);
      viewer.dataSources.remove(dataSource, true);
      entities.clear();
      symbols.clear();
    },
  });
}
