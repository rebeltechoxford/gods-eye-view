import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GEOMETRY_LIMITS,
  validateGeometry,
  parseTakGeometry,
  unwrapGeometryLongitudes,
  geometryColorRgba,
  signedGeometryColor,
} from './geometry.js';
import {
  buildGeometry,
  buildGeometryDelete,
  ownsGeometryUid,
  ownsGeometryWaypointUid,
} from './geometryCot.js';
import {
  parseCotEvent,
  serializeCotEvent,
  cotDeleteTarget,
} from './protocol/cot.js';
import { createTakStore } from './store.js';

const now = Date.parse('2026-10-17T12:00:00Z');
const identity = {
  uid: 'GEV-11111111-2222-4333-8444-555555555555',
  callsign: 'SYNTHETIC AUTHOR',
  team: 'Cyan',
  role: 'Team Member',
};
const other = { ...identity, uid: 'GEV-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
const point = (lat, lon, hae = null) => ({ lat, lon, hae });
const line = {
  kind: 'polyline',
  callsign: 'Synthetic line',
  vertices: [point(34, -89), point(34.01, -89.02), point(34.02, -89.01)],
};
const polygon = {
  kind: 'polygon',
  callsign: 'Synthetic polygon',
  vertices: [point(34, 179), point(34, -179), point(35, -179), point(35, 179)],
};
const route = {
  kind: 'route',
  callsign: 'Synthetic route',
  vertices: [point(34, -89), point(34.01, -89.02), point(34.02, -89.01)],
};
function peer(links, extras = '', type = 'u-d-f') {
  const time = new Date(now).toISOString(),
    stale = new Date(now + 86400000).toISOString();
  return parseCotEvent(
    `<event version="2.0" uid="SYNTHETIC-PEER-GEOMETRY" type="${type}" how="h-e" time="${time}" start="${time}" stale="${stale}"><point lat="34" lon="-89" hae="9999999" ce="9999999" le="9999999"/><detail><contact callsign="SYNTHETIC PEER"/>${links}${extras}</detail></event>`,
  );
}
const links = (...points) => points.map((p) => `<link point="${p}"/>`).join('');
const result = (event) => {
  const parsed = parseTakGeometry(event);
  assert.equal(parsed.status, 'ok', parsed.reason);
  return parsed.geometry;
};

test('primary exporter layout parses ordered direct link points into real geometry', () => {
  const event = peer(
    links('34,-89', '34.01,-89.02', '34.02,-89.01'),
    '<strokeColor value="-1"/><strokeWeight value="4.0"/>',
  );
  const geometry = result(event);
  assert.equal(geometry.kind, 'polyline');
  assert.equal(geometry.altitudeMode, 'ground');
  assert.deepEqual(
    geometry.vertices.map(({ lat, lon, hae }) => ({ lat, lon, hae })),
    line.vertices,
  );
  assert.equal(geometry.style.strokeWidth, 4);
  assert(Object.isFrozen(geometry));
  assert(Object.isFrozen(geometry.vertices));
  assert(Object.isFrozen(geometry.vertices[0]));
  assert.throws(() => {
    geometry.vertices[0].lat = 0;
  }, TypeError);
});

test('repeated closing point makes one simple polygon, including a dateline crossing', () => {
  const geometry = result(
    peer(
      links('34,179', '34,-179', '35,-179', '35,179', '34,179'),
      '<fillColor value="872415231"/>',
    ),
  );
  assert.equal(geometry.kind, 'polygon');
  assert.equal(geometry.closed, true);
  assert.equal(geometry.vertices.length, 4);
  assert.deepEqual(
    unwrapGeometryLongitudes(geometry.vertices),
    [179, 181, 181, 179],
  );
  assert.deepEqual(geometry.bounds, {
    west: 179,
    east: -179,
    south: 34,
    north: 35,
    crossesAntimeridian: true,
    longitudeSpan: 2,
  });
  const emitted = buildGeometry(identity, polygon, { nowMs: now });
  assert.equal(result(emitted).kind, 'polygon');
  assert.equal(
    emitted.detail.raw.children.filter(
      (node) => node.name === 'link' && node.attrs.point,
    ).length,
    5,
  );
  assert(
    Math.abs(emitted.point.lon) > 179,
    'event anchor stays near the dateline instead of Greenwich',
  );
});

test('route links retain waypoint/control UID, names, remarks and route settings', () => {
  const event = peer(
    '<link point="34,-89,100" uid="CP-A" type="b-m-p-w" relation="c" callsign="Start" remarks="Synthetic only"/><link point="34.01,-89.02,110" uid="CP-B" type="b-m-p-c" relation="c" callsign="Turn"/>',
    '<link_attr color="4294901760" stroke="3" method="Walking" direction="Exfil" routetype="Secondary" order="Descending Check Points" type="Ground" planningmethod="Manual" prefix="RP"/><strokeColor value="-65536"/><strokeWeight value="3.5"/>',
    'b-m-r',
  );
  const geometry = result(event);
  assert.equal(geometry.kind, 'route');
  assert.equal(geometry.altitudeMode, 'absolute');
  assert.deepEqual(
    geometry.vertices.map((p) => [p.uid, p.type, p.callsign, p.remarks]),
    [
      ['CP-A', 'b-m-p-w', 'Start', 'Synthetic only'],
      ['CP-B', 'b-m-p-c', 'Turn', null],
    ],
  );
  assert.equal(geometry.style.strokeColor, -65536);
  assert.equal(geometry.style.strokeWidth, 3.5);
  assert.deepEqual(geometry.route, {
    method: 'Walking',
    direction: 'Exfil',
    routeType: 'Secondary',
    order: 'Descending Check Points',
    transportationType: 'Ground',
    planningMethod: 'Manual',
    prefix: 'RP',
  });
});

test('all unknown HAE is ground; finite ellipsoidal heights remain exact, including zero and negatives', () => {
  const ground = result(peer(links('34,-89,9999999.0', '34.1,-89.1')));
  assert.equal(ground.altitudeMode, 'ground');
  assert.deepEqual(
    ground.vertices.map((p) => p.hae),
    [null, null],
  );
  const absolute = result(peer(links('34,-89,0', '34.1,-89.1,-15')));
  assert.equal(absolute.altitudeMode, 'absolute');
  assert.deepEqual(
    absolute.vertices.map((p) => p.hae),
    [0, -15],
  );
  const mixed = parseTakGeometry(peer(links('34,-89,0', '34.1,-89.1')));
  assert.equal(mixed.status, 'unsupported');
  assert.match(mixed.reason, /Mixed/);
  assert.equal('geometry' in mixed, false);
  assert.throws(
    () =>
      validateGeometry({ ...line, vertices: [point(1, 1, 10), point(2, 2)] }),
    /Mixed/,
  );
});

test('non-geometry, unsupported types and invalid geometry are distinguishable without changing raw XML', () => {
  assert.deepEqual(parseTakGeometry({ type: 'a-f-G-U-C' }), {
    status: 'not-geometry',
  });
  assert.equal(parseTakGeometry({ type: 'u-d-c-c' }).status, 'unsupported');
  const event = peer(links('34,-89', 'invalid,-89.1'));
  const before = serializeCotEvent(event),
    raw = event.detail.raw;
  assert.equal(parseTakGeometry(event).status, 'invalid');
  assert.equal(event.detail.raw, raw);
  assert.equal(serializeCotEvent(event), before);
});

test('unknown namespaced extensions survive parse/display and CoT reserialization', () => {
  const event = peer(
    links('34,-89', '34.1,-89.1'),
    '<sensor xmlns:x="urn:synthetic" x:mode="preserve"><x:payload id="opaque"/></sensor><remarks>Fixture only</remarks>',
  );
  const before = serializeCotEvent(event);
  assert.equal(result(event).vertices.length, 2);
  assert.equal(serializeCotEvent(event), before);
  assert.match(before, /x:payload/);
  assert.match(before, /x:mode="preserve"/);
  assert.equal(
    parseTakGeometry(
      peer(
        '<link xmlns="urn:foreign" point="34,-89"/><link point="34.1,-89.1"/>',
      ),
    ).status,
    'unsupported',
  );
});

test('every malformed coordinate is refused, never coerced to an equator/origin vertex', async (t) => {
  for (const value of ['', ' ', 'NaN', 'Infinity', '0x10', 'true', '91', '-91'])
    await t.test(`latitude ${JSON.stringify(value)}`, () => {
      const parsed = parseTakGeometry(peer(links(`${value},1`, '2,3')));
      assert.equal(parsed.status, 'invalid');
      assert.equal('geometry' in parsed, false);
    });
  for (const value of ['181', '-181', 'Infinity', ''])
    assert.equal(
      parseTakGeometry(peer(links(`1,${value}`, '2,3'))).status,
      'invalid',
    );
  for (const value of ['', 'NaN', '9999998', '1000001', '-12001'])
    assert.equal(
      parseTakGeometry(peer(links(`1,1,${value}`, '2,3,0'))).status,
      'invalid',
    );
  assert.throws(
    () =>
      validateGeometry({
        ...line,
        vertices: [{ lat: '', lon: 0 }, point(1, 1)],
      }),
    /Latitude/,
  );
  assert.throws(
    () =>
      validateGeometry({
        ...line,
        vertices: [{ lat: true, lon: 0 }, point(1, 1)],
      }),
    /Latitude/,
  );
  assert.equal(
    parseTakGeometry(peer(links('1,1,0,1', '2,3,0'))).status,
    'invalid',
  );
});

test('only direct vertices count and resource limits reject complete shapes without truncation', () => {
  assert.equal(
    parseTakGeometry(
      peer('<wrapper><link point="1,1"/><link point="2,2"/></wrapper>'),
    ).status,
    'invalid',
  );
  const many = Array.from(
    { length: 257 },
    (_, i) => `<link point="1,${i / 1000}"/>`,
  ).join('');
  assert.equal(parseTakGeometry(peer(many)).status, 'invalid');
  const vertices = Array.from({ length: 256 }, (_, i) =>
    point(
      30 + Math.sin((i * 2 * Math.PI) / 256) * 0.1,
      10 + Math.cos((i * 2 * Math.PI) / 256) * 0.1,
    ),
  );
  assert.equal(
    validateGeometry({ kind: 'polygon', vertices }).vertices.length,
    256,
  );
  assert.throws(
    () =>
      unwrapGeometryLongitudes(Array.from({ length: 258 }, () => point(1, 1))),
    /256/,
  );
  assert.equal(
    parseTakGeometry({
      type: 'u-d-f',
      detail: {
        raw: {
          children: Array.from(
            { length: GEOMETRY_LIMITS.detailChildren + 1 },
            () => ({ name: 'x' }),
          ),
        },
      },
    }).status,
    'invalid',
  );
});

test('simple polygon validation rejects intersections, overlap, duplicates and degeneracy', async (t) => {
  const cases = [
    ['self crossing', [point(0, 0), point(0, 3), point(2, 0), point(2, 2)]],
    [
      'duplicate vertex',
      [point(0, 0), point(0, 2), point(1, 2), point(0, 2), point(1, 0)],
    ],
    [
      'adjacent backtrack',
      [point(0, 0), point(0, 3), point(0, 2), point(2, 2), point(2, 0)],
    ],
    ['zero area', [point(0, 0), point(0, 1), point(0, 2)]],
    ['two corners', [point(0, 0), point(1, 1)]],
  ];
  for (const [name, vertices] of cases)
    await t.test(name, () =>
      assert.throws(
        () => validateGeometry({ kind: 'polygon', vertices }),
        /intersect|repeat|overlap|degenerate|at least/,
      ),
    );
  assert.throws(
    () =>
      validateGeometry({
        ...polygon,
        vertices: [...polygon.vertices, { ...polygon.vertices[0], hae: 1 }],
      }),
    /closing altitude/,
  );
  assert.throws(
    () => validateGeometry({ ...line, vertices: [point(1, 1), point(1, 1)] }),
    /distinct|closed/,
  );
});

test('ambiguous global/polar geometry is explicitly unsupported while dateline lines and loops remain usable', () => {
  assert.throws(
    () =>
      validateGeometry({
        kind: 'polygon',
        vertices: [point(10, -170), point(11, 0), point(10, 170)],
      }),
    /half the world|pole/,
  );
  assert.throws(
    () =>
      validateGeometry({
        kind: 'polygon',
        vertices: [point(90, 0), point(80, 20), point(80, 30)],
      }),
    /Pole/,
  );
  assert.equal(
    parseTakGeometry(peer(links('0,0', '0,180'))).status,
    'unsupported',
  );
  assert.equal(
    validateGeometry({ ...line, vertices: [point(0, 179), point(0, -179)] })
      .bounds.longitudeSpan,
    2,
  );
  assert.equal(
    validateGeometry({
      ...route,
      vertices: [point(1, 1), point(2, 2), point(1, 1)],
    }).closed,
    false,
  );
});

test('style and route metadata remain bounded, canonical ARGB and validated enums', () => {
  assert.equal(signedGeometryColor(0xffff0000), -65536);
  assert.deepEqual(geometryColorRgba(-65536), {
    red: 1,
    green: 0,
    blue: 0,
    alpha: 1,
  });
  assert.deepEqual(geometryColorRgba(0x3364c4ff), {
    red: 100 / 255,
    green: 196 / 255,
    blue: 1,
    alpha: 51 / 255,
  });
  for (const value of [NaN, Infinity, 0, 33, '3'])
    assert.throws(
      () => validateGeometry({ ...line, style: { strokeWidth: value } }),
      /Stroke/,
    );
  assert.throws(() => signedGeometryColor(1.1), /integer/);
  assert.throws(
    () => validateGeometry({ ...line, style: { fillColor: -1 } }),
    /fill/,
  );
  assert.equal(
    parseTakGeometry(peer(links('1,1', '2,2'), '<strokeColor value="1.5"/>'))
      .status,
    'invalid',
  );
  assert.equal(
    parseTakGeometry(
      peer(
        links('1,1', '2,2'),
        '<strokeWeight value="3"/><strokeWeight value="4"/>',
      ),
    ).status,
    'invalid',
  );
  assert.equal(
    parseTakGeometry(
      peer(links('1,1', '2,2'), '<link_attr method="Teleport"/>', 'b-m-r'),
    ).status,
    'unsupported',
  );
  assert.equal(
    parseTakGeometry(
      peer(
        links('1,1', '2,2'),
        '<strokeColor value="-1"/><link_attr color="-65536"/>',
        'b-m-r',
      ),
    ).status,
    'invalid',
  );
});

test('draft route metadata is allowed only for authoring and canonical wire links require complete metadata', () => {
  const draft = {
    ...route,
    vertices: route.vertices.map((p, i) => ({
      ...p,
      type: 'b-m-p-w',
      callsign: `WP${i + 1}`,
    })),
  };
  assert.throws(() => validateGeometry(draft), /requires a UID/);
  assert.equal(
    validateGeometry(draft, { authoring: true }).vertices[0].callsign,
    'WP1',
  );
  assert.throws(
    () => validateGeometry({ ...draft, kind: 'polyline' }, { authoring: true }),
    /requires a UID/,
  );
  assert.equal(
    result(buildGeometry(identity, draft, { nowMs: now })).vertices.every(
      (p) => !!p.uid && p.relation === 'c',
    ),
    true,
  );
  assert.equal(
    parseTakGeometry(
      peer(
        '<link point="1,1" uid="x" type="b-m-p-w" relation="p-p"/><link point="2,2"/>',
        '',
        'b-m-r',
      ),
    ).status,
    'unsupported',
  );
  assert.equal(
    parseTakGeometry(
      peer(
        '<link point="1,1" uid="x" type="b-m-p-w"/><link point="2,2"/>',
        '',
        'b-m-r',
      ),
    ).status,
    'unsupported',
  );
  const ownDraft = result(buildGeometry(identity, route, { nowMs: now }));
  assert.equal(
    validateGeometry(
      {
        ...ownDraft,
        vertices: ownDraft.vertices.map(({ relation, ...p }) => p),
      },
      { authoring: true },
    ).vertices[0].relation,
    'c',
  );
});

test('authored route waypoints are stable on edits, reminted on copies and bound to the geometry namespace', () => {
  const created = buildGeometry(identity, route, { nowMs: now });
  const original = result(created);
  assert(ownsGeometryUid(identity, created.uid));
  assert(!ownsGeometryUid(other, created.uid));
  assert.equal(created.detail.callsign, route.callsign);
  assert.notEqual(created.uid, original.vertices[0].uid);
  assert.equal(
    new Set(original.vertices.map((p) => p.uid)).size,
    original.vertices.length,
  );
  assert(
    original.vertices.every((p) => ownsGeometryWaypointUid(created.uid, p.uid)),
  );
  const edited = buildGeometry(
    identity,
    {
      ...original,
      uid: created.uid,
      callsign: 'Edited',
      vertices: [...original.vertices, point(34.03, -89)],
    },
    { nowMs: now + 1, expectedRevision: now },
  );
  const update = result(edited);
  assert.equal(edited.uid, created.uid);
  assert.deepEqual(
    update.vertices.slice(0, 3).map((p) => p.uid),
    original.vertices.map((p) => p.uid),
  );
  assert(ownsGeometryWaypointUid(created.uid, update.vertices[3].uid));
  const copied = buildGeometry(
    identity,
    { ...original, callsign: 'Copy' },
    { nowMs: now + 2 },
  );
  assert.notEqual(copied.uid, created.uid);
  assert(
    result(copied).vertices.every(
      (p) =>
        ownsGeometryWaypointUid(copied.uid, p.uid) &&
        !original.vertices.some((prior) => prior.uid === p.uid),
    ),
  );
  assert.throws(
    () =>
      buildGeometry(
        other,
        { ...original, uid: created.uid, callsign: 'Foreign' },
        { nowMs: now },
      ),
    /not owned/,
  );
  assert.throws(
    () =>
      buildGeometry(
        identity,
        {
          ...original,
          uid: created.uid,
          callsign: 'Bad',
          vertices: [
            { ...original.vertices[0], uid: 'FOREIGN-WAYPOINT' },
            ...original.vertices.slice(1),
          ],
        },
        { nowMs: now },
      ),
    /Waypoint UID/,
  );
});

test('builder ignores unknown caller extension fields and canonical parsing retains every vertex beyond semantic link32', () => {
  const vertices = Array.from({ length: 40 }, (_, i) =>
    point(34 + i / 10000, -89 + i / 10000),
  );
  const event = buildGeometry(
    identity,
    {
      ...line,
      vertices,
      extras: [{ name: 'marti', attrs: { secret: 'MUST_NOT_EXPORT' } }],
      namespaces: { 'xmlns:x': 'urn:untrusted' },
    },
    { nowMs: now },
  );
  const xml = serializeCotEvent(event);
  assert.equal(result(event).vertices.length, 40);
  assert(!xml.includes('MUST_NOT_EXPORT'));
  assert(!xml.includes('urn:untrusted'));
  assert.match(xml, /relation="p-p"/);
  assert.match(xml, /<archive\/>/);
  const fractional = buildGeometry(
    identity,
    { ...route, style: { strokeWidth: 3.5 } },
    { nowMs: now },
  );
  assert.match(serializeCotEvent(fractional), /stroke="3"/);
  assert.equal(result(fractional).style.strokeWidth, 3.5);
});

test('local revision checks, full replacements and deletes use existing store semantics', () => {
  const store = createTakStore();
  store.setSelfUid(identity.uid);
  const first = buildGeometry(identity, line, { nowMs: now });
  store.apply(first, 'local');
  assert.throws(
    () =>
      buildGeometry(
        identity,
        { ...line, uid: first.uid },
        { nowMs: now, expectedRevision: now },
      ),
    /newer revision/,
  );
  const update = buildGeometry(
    identity,
    { ...line, uid: first.uid, vertices: [point(35, -89), point(36, -90)] },
    { nowMs: now + 1, expectedRevision: now },
  );
  store.apply(update, 'local');
  store.apply(first, 'network');
  assert.equal(result(store.get(first.uid).event).vertices[0].lat, 35);
  const deletion = buildGeometryDelete(identity, first.uid, first.type, {
    nowMs: now + 2,
    expectedRevision: now + 1,
  });
  assert.equal(cotDeleteTarget(deletion), first.uid);
  assert.equal(store.apply(deletion, 'local'), 'deleted');
  assert.equal(store.count(), 0);
  assert.throws(
    () => buildGeometryDelete(other, first.uid, first.type),
    /not owned/,
  );
  store.destroy();
});

test('outbound geometry and text remain within protocol budgets without dropping waypoints', () => {
  const vertices = Array.from({ length: 256 }, (_, i) => ({
    ...point(34 + i / 10000, -89 + i / 10000),
    callsign: `WP${i}`,
    remarks: 'a'.repeat(256),
    type: 'b-m-p-w',
  }));
  assert.throws(
    () => buildGeometry(identity, { ...route, vertices }, { nowMs: now }),
    /64 KiB/,
  );
  assert.throws(
    () =>
      buildGeometry(
        identity,
        { ...line, callsign: 'a'.repeat(65) },
        { nowMs: now },
      ),
    /name/,
  );
  assert.throws(
    () =>
      buildGeometry(
        identity,
        { ...line, remarks: 'a'.repeat(257) },
        { nowMs: now },
      ),
    /256/,
  );
  assert.throws(
    () => buildGeometry(identity, line, { nowMs: now, staleMs: 86400001 }),
    /times/,
  );
});
