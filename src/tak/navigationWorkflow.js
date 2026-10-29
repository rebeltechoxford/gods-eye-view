import { t } from '../i18n/index.js';
import {
  formatCoordinate,
  parseCoordinate,
  validateWaypoint,
} from './navigation.js';
import { isGpsFixFresh } from './position.js';

export function navigationOrigin({
  kind,
  fix,
  mapCenter,
  gpsActive,
  foreground,
  nowMs = Date.now(),
}) {
  if (kind === 'map') {
    return mapCenter
      ? {
          point: validateWaypoint(mapCenter),
          label: t('MAP CENTER · not device GPS'),
        }
      : { point: null, label: t('Map center is looking at space.') };
  }
  if (!fix)
    return {
      point: null,
      label: t('No position set. Use MY POSITION controls first.'),
    };
  if (fix.source === 'GPS') {
    if (!foreground || !gpsActive || !isGpsFixFresh(fix, nowMs))
      return {
        point: null,
        label: t(
          'Device GPS is stale, stopped or backgrounded. Range/bearing paused.',
        ),
      };
    return {
      point: validateWaypoint(fix),
      label: t('DEVICE GPS · {accuracy}', {
        accuracy: Number.isFinite(fix.ce)
          ? t('±{metres} m reported accuracy', { metres: Math.ceil(fix.ce) })
          : t('accuracy unknown'),
      }),
    };
  }
  return {
    point: validateWaypoint(fix),
    label: t('OPERATOR-SET POSITION · not device GPS'),
  };
}

/** Memory-only waypoint actions. Every entered location protects public egress. */
export function createNavigationWorkflow({ client, focusTarget, markPrivate }) {
  let target = null;
  let destroyed = false;
  function active() {
    if (destroyed) throw new Error(t('Field navigation is closed.'));
  }
  function requireTarget() {
    active();
    if (!target) throw new Error(t('Validate a waypoint first.'));
    return target;
  }
  return Object.freeze({
    target: () => target,
    enter(text, format) {
      active();
      markPrivate();
      target = null;
      target = Object.freeze(parseCoordinate(text, format));
      return target;
    },
    fromPoint(point, format) {
      active();
      markPrivate();
      target = null;
      const input = formatCoordinate(validateWaypoint(point), format);
      target = Object.freeze(validateWaypoint(point));
      return input;
    },
    invalidate() {
      active();
      markPrivate();
      target = null;
    },
    focus() {
      const point = requireTarget();
      markPrivate();
      return focusTarget(validateWaypoint(point));
    },
    addMarker(label) {
      const point = requireTarget();
      if (
        typeof label !== 'string' ||
        !label.trim() ||
        label.trim().length > 120 ||
        /[\x00-\x1f\x7f]/.test(label)
      )
        throw new Error(t('Enter a waypoint label of 1…120 characters.'));
      markPrivate();
      return client.addMarker({
        ...validateWaypoint(point),
        callsign: label.trim(),
        broadcast: false,
      });
    },
    clear() {
      target = null;
    },
    destroy() {
      target = null;
      destroyed = true;
    },
  });
}
