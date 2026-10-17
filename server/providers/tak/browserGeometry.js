import { parseTakGeometry } from '../../../src/tak/geometry.js';
import {
  buildGeometry,
  ownsGeometryUid,
} from '../../../src/tak/geometryCot.js';

const FIELDS = Object.freeze({
  contact: ['callsign'],
  remarks: [],
  archive: [],
  strokeColor: ['value'],
  fillColor: ['value'],
  strokeWeight: ['value'],
  strokeStyle: ['value'],
  link_attr: [
    'color',
    'stroke',
    'type',
    'method',
    'direction',
    'routetype',
    'order',
    'planningmethod',
    'prefix',
  ],
});
const PARENT_FIELDS = [
  'uid',
  'type',
  'relation',
  'parent_callsign',
  'production_time',
];
const VERTEX_FIELDS = [
  'point',
  'uid',
  'type',
  'relation',
  'callsign',
  'remarks',
];

/** Validate the browser-only geometry subset, then rebuild every outbound field. */
export function canonicalBrowserGeometry(event, identity) {
  if (!identity || !ownsGeometryUid(identity, event.uid))
    throw new Error('Drawing UID is not owned by this identity');
  const parsed = parseTakGeometry(event);
  if (parsed.status !== 'ok')
    throw new Error(parsed.reason || 'Unsupported drawing geometry');
  const children = event.detail?.raw?.children;
  if (!Array.isArray(children))
    throw new Error('Drawing requires parsed detail');
  const parents = [];
  for (const node of children) {
    const attrs = node.attrs || {};
    const allowed =
      node.name === 'link'
        ? Object.hasOwn(attrs, 'point')
          ? VERTEX_FIELDS
          : PARENT_FIELDS
        : FIELDS[node.name];
    if (
      !allowed ||
      node.namespaces?.xmlns ||
      node.children?.length ||
      (node.name !== 'remarks' && node.text?.trim()) ||
      Object.keys(attrs).some((key) => !allowed.includes(key))
    )
      throw new Error('Unsupported browser drawing extension or routing field');
    if (node.name === 'link' && !Object.hasOwn(attrs, 'point'))
      parents.push(node);
  }
  if (
    parents.length !== 1 ||
    parents[0].attrs.relation !== 'p-p' ||
    parents[0].attrs.uid !== identity.uid ||
    parents[0].attrs.parent_callsign !== identity.callsign
  )
    throw new Error('Drawing creator identity mismatch');
  for (const name of Object.keys(FIELDS))
    if (children.filter((node) => node.name === name).length > 1)
      throw new Error('Duplicate browser drawing detail');
  return buildGeometry(
    identity,
    {
      ...parsed.geometry,
      uid: event.uid,
      callsign: event.detail.callsign,
      remarks: event.detail.remarks?.text || '',
    },
    { nowMs: event.timeMs, staleMs: event.staleMs - event.timeMs },
  );
}
