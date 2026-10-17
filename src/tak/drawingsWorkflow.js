import {
  validateGeometry,
  parseTakGeometry,
  GEOMETRY_LIMITS,
} from './geometry.js';
import { validateWaypoint, rangeBearing } from './navigation.js';
import { cotNumber } from './protocol/cot.js';

const clone = (value) => structuredClone(value);

/** Session-only editing. A changed or removed source must be explicitly reloaded. */
export function createDrawingsWorkflow({ client, markPrivate = () => {} }) {
  let draft = null;
  let sourceEvent = null;
  let closed = false;
  function active() {
    if (closed) throw new Error('Drawing editor is closed.');
    if (!draft) throw new Error('Start or select a drawing first.');
    markPrivate();
    return draft;
  }
  function vertex(point) {
    const result = { ...validateWaypoint(point) };
    if (point.hae === '' || point.hae === null || point.hae === undefined)
      result.hae = null;
    else {
      result.hae = cotNumber(point.hae, {
        min: GEOMETRY_LIMITS.minHae,
        max: GEOMETRY_LIMITS.maxHae,
      });
      if (result.hae === null)
        throw new Error(
          'Enter a finite HAE altitude, or leave every altitude blank.',
        );
    }
    for (const key of ['uid', 'type', 'relation', 'callsign', 'remarks'])
      if (point[key] !== undefined) result[key] = String(point[key]);
    if (
      (result.callsign?.length || 0) > GEOMETRY_LIMITS.waypointName ||
      (result.remarks?.length || 0) > GEOMETRY_LIMITS.waypointRemarks
    )
      throw new Error('Waypoint name or notes exceed their limit.');
    return result;
  }
  function at(index) {
    active();
    if (!Number.isInteger(index) || index < 0 || index >= draft.vertices.length)
      throw new Error('Select an existing vertex.');
    return index;
  }
  function conflict() {
    return !!draft?.uid && client.store.get(draft.uid)?.event !== sourceEvent;
  }
  return Object.freeze({
    start(kind = 'polyline') {
      if (closed) throw new Error('Drawing editor is closed.');
      if (!['polyline', 'polygon', 'route'].includes(kind))
        throw new Error('Unknown drawing kind.');
      markPrivate();
      draft = { kind, callsign: '', remarks: '', vertices: [] };
      sourceEvent = null;
    },
    load(uid, { copy = false } = {}) {
      if (closed) throw new Error('Drawing editor is closed.');
      const contact = client.store.get(uid);
      if (!contact) throw new Error('Drawing is no longer available.');
      const parsed = contact.geometryResult || parseTakGeometry(contact.event);
      if (parsed.status !== 'ok')
        throw new Error(
          parsed.reason || 'This contact has no supported geometry.',
        );
      if (!copy && !client.isOwnGeometry(uid))
        throw new Error(
          'Only drawings created in this session can be edited. Use Copy to make your own.',
        );
      markPrivate();
      draft = {
        ...clone(parsed.geometry),
        uid: copy ? undefined : uid,
        callsign: `${contact.callsign}${copy ? ' copy' : ''}`.slice(0, 64),
        remarks: contact.event.detail.remarks?.text || '',
      };
      if (copy) for (const point of draft.vertices) delete point.uid;
      sourceEvent = copy ? null : contact.event;
    },
    state: () => (draft ? { draft: clone(draft), conflict: conflict() } : null),
    settings(changes) {
      active();
      for (const key of ['callsign', 'remarks', 'style', 'route'])
        if (changes[key] !== undefined) draft[key] = clone(changes[key]);
    },
    add(point) {
      active();
      if (draft.vertices.length >= GEOMETRY_LIMITS.vertices)
        throw new Error('A drawing can contain at most 256 vertices.');
      draft.vertices.push(vertex(point));
    },
    replace(index, point) {
      at(index);
      draft.vertices[index] = {
        ...draft.vertices[index],
        ...vertex(point),
        uid: draft.vertices[index].uid,
      };
    },
    remove(index) {
      at(index);
      draft.vertices.splice(index, 1);
    },
    move(index, direction) {
      at(index);
      if (direction !== -1 && direction !== 1)
        throw new Error('Move one vertex at a time.');
      const next = index + direction;
      if (next < 0 || next >= draft.vertices.length) return;
      [draft.vertices[index], draft.vertices[next]] = [
        draft.vertices[next],
        draft.vertices[index],
      ];
    },
    reverse() {
      active().vertices.reverse();
    },
    preview() {
      active();
      return validateGeometry(draft, { authoring: true });
    },
    legs() {
      if (!draft || draft.vertices.length < 2) return [];
      const points = [...draft.vertices];
      if (draft.kind === 'polygon') points.push(points[0]);
      return points.slice(1).map((point, index) => ({
        from: index,
        to: (index + 1) % draft.vertices.length,
        ...rangeBearing(points[index], point),
      }));
    },
    save({ broadcast = false } = {}) {
      active();
      if (conflict())
        throw new Error(
          'Drawing changed or was removed. Reload it or copy this draft before saving.',
        );
      validateGeometry(draft, { authoring: true });
      const result = client.saveGeometry(draft, {
        broadcast,
        expectedEvent: sourceEvent,
      });
      const saved = client.store.get(result.uid);
      if (!saved)
        throw new Error('Drawing could not be retained in this session.');
      sourceEvent = saved.event;
      draft = {
        ...draft,
        ...clone(saved.geometryResult.geometry),
        uid: result.uid,
      };
      return result;
    },
    copyDraft() {
      active();
      delete draft.uid;
      for (const point of draft.vertices) delete point.uid;
      sourceEvent = null;
    },
    clear() {
      draft = null;
      sourceEvent = null;
    },
    destroy() {
      closed = true;
      draft = null;
      sourceEvent = null;
    },
  });
}
