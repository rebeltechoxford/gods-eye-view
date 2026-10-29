import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartographic } from 'cesium';
import {
  COORDINATE_FORMATS,
  formatCoordinate,
  parseCoordinate,
  fromUtm,
  toUtm,
  fromUps,
  toUps,
  utmZone,
  rangeBearing,
  validateWaypoint,
} from './navigation.js';
import {
  createNavigationWorkflow,
  navigationOrigin,
} from './navigationWorkflow.js';
import { createNavigationFocus } from './navigationCamera.js';

function near(actual, expected, tolerance, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} versus ${expected} (±${tolerance})`,
  );
}

test('DD and DMS identify WGS84 axis order and retain hemisphere through conversion', () => {
  const point = parseCoordinate(' 38.88927, -77.05020 ');
  assert.deepEqual(point, { lat: 38.88927, lon: -77.0502 });
  assert.deepEqual(parseCoordinate('-33.8688 151.2093'), {
    lat: -33.8688,
    lon: 151.2093,
  });
  const dms = parseCoordinate('38°53\'21.372"N 077°03\'00.720"W', 'DMS');
  near(dms.lat, point.lat, 1e-10);
  near(dms.lon, point.lon, 1e-10);
  assert.deepEqual(parseCoordinate('33 30 0 S, 151 15 0 E', 'DMS'), {
    lat: -33.5,
    lon: 151.25,
  });
  near(
    parseCoordinate(formatCoordinate(point, 'DMS'), 'DMS').lat,
    point.lat,
    0.000002,
  );
});

test('strict coordinate parsing rejects coercion, missing axes, trailing payload and invalid DMS', () => {
  for (const value of [
    '',
    ' ',
    '1',
    ',2',
    'null, 2',
    'NaN 0',
    'Infinity,0',
    '1e1,2',
    '0x20,3',
    '91,0',
    '0,-181',
    '0,0 trailing',
    '1,2,3',
    '1'.repeat(161),
  ])
    assert.throws(() => parseCoordinate(value));
  for (const value of [null, undefined, 0, {}, []])
    assert.throws(() => parseCoordinate(value));
  for (const value of [
    '90 0 0.1 N 0 0 0 E',
    '0 60 0 N 0 0 0 E',
    '0 0 60 N 0 0 0 E',
    '-1 0 0 N 0 0 0 E',
    '1 0 0 E 0 0 0 N',
    '1 N 1 E',
  ])
    assert.throws(() => parseCoordinate(value, 'DMS'));
  assert.throws(() => parseCoordinate('1,2', 'UNKNOWN'));
  assert.throws(() => validateWaypoint({ lat: '0', lon: 0 }));
});

test('DMS rounding carries seconds/minutes without emitting 60 or crossing a pole', () => {
  const text = formatCoordinate(
    { lat: 89.99999999, lon: -179.99999999 },
    'DMS',
  );
  assert.equal(text, '90°00′00.00″N 180°00′00.00″W');
  assert.deepEqual(parseCoordinate(text, 'DMS'), { lat: 90, lon: -180 });
});

test('UTM numerical checkpoints match independent official PROJ examples in both hemispheres', () => {
  // https://proj.org/en/stable/operations/projections/utm.html (centimetre output).
  // Examples default to GRS80; WGS84 differs by far less than their 1cm rounding.
  for (const item of [
    {
      point: { lat: 56, lon: 12 },
      zone: 32,
      hemisphere: 'N',
      easting: 687071.44,
      northing: 6210141.33,
    },
    {
      point: { lat: -44, lon: 174 },
      zone: 59,
      hemisphere: 'S',
      easting: 740526.32,
      northing: 5123750.87,
    },
  ]) {
    const projected = toUtm(item.point, { zone: item.zone });
    near(projected.easting, item.easting, 0.01);
    near(projected.northing, item.northing, 0.01);
    assert.equal(projected.hemisphere, item.hemisphere);
    const inverse = fromUtm(item);
    near(inverse.lat, item.point.lat, 1e-7);
    near(inverse.lon, item.point.lon, 1e-7);
  }
});

test('UTM Norway/Svalbard zones, equator and antimeridian boundaries are explicit', () => {
  for (const [lat, lon, zone] of [
    [60, 3, 32],
    [60, 11.999, 32],
    [60, 12, 33],
    [75, 0, 31],
    [75, 9, 33],
    [75, 21, 35],
    [75, 33, 37],
    [56, 2.9999, 31],
    [64, 5, 31],
    [71.9999, 9, 32],
    [72, 9, 33],
    [84, 9, 33],
    [0, -180, 1],
    [0, 180, 60],
  ])
    assert.equal(utmZone({ lat, lon }), zone);
  const equator = toUtm({ lat: 0, lon: 3 });
  near(equator.easting, 500000, 1e-8);
  near(equator.northing, 0, 1e-8);
  assert.deepEqual(
    fromUtm({ zone: 31, hemisphere: 'S', easting: 500000, northing: 10000000 }),
    { lat: 0, lon: 3 },
  );
  for (const lat of [-80, -60, -0.00001, 0, 38.88927, 60, 75, 84])
    for (const lon of [-179.9, -77.05, 0, 5, 15, 25, 38, 179.9]) {
      const inverse = fromUtm(toUtm({ lat, lon }));
      near(inverse.lat, lat, 1e-8, 'latitude roundtrip');
      near(inverse.lon, lon, 1e-8, 'longitude roundtrip');
    }
});

test('adjacent-zone UTM projections crossing the dateline return canonical longitude', () => {
  for (const [point, zone] of [
    [{ lat: 60, lon: -179 }, 60],
    [{ lat: -60, lon: 179 }, 1],
  ]) {
    const encoded = toUtm(point, { zone });
    const decoded = fromUtm(encoded);
    near(decoded.lat, point.lat, 1e-8);
    near(decoded.lon, point.lon, 1e-8);
  }
});

test('UTM input requires hemisphere, metre values and bounded projection domain', () => {
  assert.deepEqual(parseCoordinate('31 N 500000 0', 'UTM'), { lat: 0, lon: 3 });
  assert.deepEqual(parseCoordinate('31S 500000 10000000', 'UTM'), {
    lat: 0,
    lon: 3,
  });
  for (const value of [
    '0 N 500000 0',
    '61 N 500000 0',
    '31 U 500000 0',
    '31 N 99999 0',
    '31 N 900001 0',
    '31 N 500000 -1',
    '31 S 500000 10000001',
    '31 N 500000 9999999',
    '31 S 500000 0',
    '31 N 5e5 0',
    '31 N 500000 0 trailing',
  ])
    assert.throws(() => parseCoordinate(value, 'UTM'));
  assert.throws(() => toUtm({ lat: 0, lon: 40 }, { zone: 31 }));
});

test('MGRS accepts separated full references, preserves cell precision and rejects invalid grids', () => {
  const point = parseCoordinate('18s uj 23394 07396', 'MGRS');
  // Zone 18, UJ 100km square, easting 23394 / northing 07396 metres.
  // Check the decoded centre against independent UTM projection arithmetic.
  const projected = toUtm(point);
  near(projected.easting, 323394.5, 0.001);
  near(projected.northing, 4307396.5, 0.001);
  assert.equal(point.cellSizeM, 1);
  assert.equal(parseCoordinate('18SUJ2307', 'MGRS').cellSizeM, 1000);
  assert.equal(parseCoordinate('18SUJ', 'MGRS').cellSizeM, 100000);
  const coarse = parseCoordinate('31XEP', 'MGRS');
  assert.ok(
    coarse.lat >= 72 && coarse.lat <= 84 && coarse.lon >= 0 && coarse.lon <= 9,
  );
  for (const value of [
    '0SUJ2339407396',
    '61SUJ2339407396',
    '18IUJ2339407396',
    '18SUI2339407396',
    '18SUJ233940739',
    '18SUJ233940739600',
    '18SAJ2339407396',
    '32XJA0000000000',
    '31NAZ0000000000',
    '31NAA0000099999',
    '31NAA!',
  ])
    assert.throws(() => parseCoordinate(value, 'MGRS'), value);
});

test('MGRS roundtrips representative zones/hemispheres and labels polar limits without losing DD/DMS', () => {
  for (const point of [
    { lat: 38.88927, lon: -77.0502 },
    { lat: -33.8688, lon: 151.2093 },
    { lat: 60, lon: 5 },
    { lat: 75, lon: 15 },
    { lat: -79.9, lon: -179.9 },
    { lat: 83.9, lon: 40 },
    { lat: 84, lon: 9 },
    { lat: -80, lon: 5 },
  ]) {
    const parsed = parseCoordinate(formatCoordinate(point, 'MGRS'), 'MGRS');
    near(parsed.lat, point.lat, 0.00002);
    near(parsed.lon, point.lon, 0.0001);
  }
  for (const lat of [-90, -80.001, 84.001, 90]) {
    for (const format of ['MGRS', 'UTM'])
      assert.throws(() => formatCoordinate({ lat, lon: 0 }, format), /UPS/);
    for (const format of ['DD', 'DMS'])
      assert.equal(
        parseCoordinate(formatCoordinate({ lat, lon: 0 }, format), format).lat,
        lat,
      );
  }
  assert.deepEqual(COORDINATE_FORMATS, ['DD', 'DMS', 'MGRS', 'UTM', 'UPS']);
});

test('coarse MGRS cells crossing Svalbard, Norway and the southern limit are clipped to their declared grid', () => {
  // These 100km cells extend outside the named geographic zone/band. Retaining
  // the dependency's SW point (its zero-digit behaviour) would put them outside.
  const svalbard = parseCoordinate('33XTV', 'MGRS');
  assert.ok(svalbard.lat >= 72 && svalbard.lat < 72.02);
  assert.ok(svalbard.lon >= 9 && svalbard.lon < 9.2);
  const north = parseCoordinate('33XVP', 'MGRS');
  assert.ok(north.lat < 84 && north.lat > 83.6 && north.lon >= 9);
  const norway = parseCoordinate('32VJH', 'MGRS');
  assert.ok(norway.lat >= 56 && norway.lon >= 3);
  const south = parseCoordinate('31CDM', 'MGRS');
  assert.ok(south.lat >= -80 && south.lon >= 0);
});

test('range and TRUE initial bearing use WGS84 ellipsoid rather than spherical/grid approximations', () => {
  const east = rangeBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
  near(east.distanceM, 111319.490793, 0.001);
  near(east.trueBearingDeg, 90, 1e-9);
  const north = rangeBearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  near(north.distanceM, 110574.388558, 0.001);
  near(north.trueBearingDeg, 0, 1e-9);
  const west = rangeBearing({ lat: 0, lon: 0 }, { lat: 0, lon: -1 });
  near(west.trueBearingDeg, 270, 1e-9);
  const across = rangeBearing({ lat: 0, lon: 179.9 }, { lat: 0, lon: -179.9 });
  near(across.distanceM, 22263.898158, 0.001);
  near(across.trueBearingDeg, 90, 1e-9);
});

test('coincident points/poles have no invented bearing; antipodal calculations fail promptly', () => {
  assert.deepEqual(rangeBearing({ lat: 0, lon: -180 }, { lat: 0, lon: 180 }), {
    distanceM: 0,
    trueBearingDeg: null,
  });
  assert.deepEqual(rangeBearing({ lat: 90, lon: 0 }, { lat: 90, lon: 90 }), {
    distanceM: 0,
    trueBearingDeg: null,
  });
  assert.equal(
    rangeBearing({ lat: 90, lon: 0 }, { lat: 89, lon: 20 }).trueBearingDeg,
    null,
  );
  assert.throws(
    () => rangeBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 179.9 }),
    /antipodal/,
  );
  assert.throws(() => rangeBearing({ lat: NaN, lon: 0 }, { lat: 0, lon: 0 }));
});

test('measurement origins distinguish operator positions and refuse stale/stopped/background GPS', () => {
  const fix = { lat: 38, lon: -77, source: 'GPS', observedAtMs: 1000, ce: 7.5 };
  const args = {
    kind: 'position',
    fix,
    nowMs: 2000,
    foreground: true,
    gpsActive: true,
  };
  assert.deepEqual(navigationOrigin(args).point, { lat: 38, lon: -77 });
  assert.match(navigationOrigin(args).label, /DEVICE GPS.*±8 m/);
  for (const changes of [
    { nowMs: 32000 },
    { foreground: false },
    { gpsActive: false },
    { fix: null },
  ])
    assert.equal(navigationOrigin({ ...args, ...changes }).point, null);
  assert.match(
    navigationOrigin({
      ...args,
      fix: { ...fix, source: 'USER' },
      gpsActive: false,
    }).label,
    /OPERATOR-SET.*not device GPS/,
  );
  assert.match(
    navigationOrigin({ kind: 'map', mapCenter: { lat: 0, lon: 0 } }).label,
    /MAP CENTER.*not device GPS/,
  );
  assert.equal(navigationOrigin({ kind: 'map', mapCenter: null }).point, null);
});

test('waypoint workflow protects invalid input too, never sets GPS or broadcasts a local marker', () => {
  const calls = [],
    focuses = [];
  let privacy = 0;
  const client = {
    addMarker: (marker) => {
      calls.push(marker);
      return { uid: 'synthetic-waypoint', sent: false };
    },
  };
  const workflow = createNavigationWorkflow({
    client,
    focusTarget: (point) => focuses.push(point),
    markPrivate: () => privacy++,
  });
  assert.throws(() => workflow.focus(), /Validate/);
  assert.throws(() => workflow.enter('invalid', 'DD'));
  assert.equal(privacy, 1);
  assert.equal(workflow.target(), null);
  workflow.enter('38,-77', 'DD');
  workflow.focus();
  assert.deepEqual(focuses, [{ lat: 38, lon: -77 }]);
  assert.equal(
    workflow.addMarker(' Local waypoint ').uid,
    'synthetic-waypoint',
  );
  assert.deepEqual(calls, [
    { lat: 38, lon: -77, callsign: 'Local waypoint', broadcast: false },
  ]);
  assert.throws(() => workflow.addMarker(' '));
  assert.throws(() => workflow.addMarker('bad\nlabel'));
  assert.throws(() => workflow.addMarker('x'.repeat(121)));
  assert.equal(calls.length, 1);
  assert.throws(() => workflow.enter('invalid replacement', 'DD'));
  assert.equal(
    workflow.target(),
    null,
    'invalid input cannot retain a formerly valid waypoint',
  );
  workflow.enter('38,-77', 'DD');
  workflow.invalidate();
  assert.equal(workflow.target(), null);
  assert.throws(() => workflow.addMarker('stale'), /Validate/);
});

test('clear/destroy discard private waypoint state and retired workflows cannot navigate', () => {
  const workflow = createNavigationWorkflow({
    client: {},
    focusTarget: () => assert.fail('retired focus'),
    markPrivate: () => {},
  });
  assert.equal(
    workflow.fromPoint({ lat: 0, lon: 3 }, 'DD'),
    '0.000000, 3.000000',
  );
  assert.ok(Object.isFrozen(workflow.target()));
  workflow.clear();
  assert.equal(workflow.target(), null);
  workflow.enter('0,3', 'DD');
  workflow.destroy();
  workflow.destroy();
  assert.equal(workflow.target(), null);
  assert.throws(() => workflow.focus(), /closed/);
  assert.throws(() => workflow.enter('0,3', 'DD'), /closed/);
});

test('camera focus claims existing navigation ownership before moving and never invents waypoint altitude', () => {
  const calls = [];
  const viewer = {
    selectedEntity: {},
    scene: { globe: { getHeight: () => undefined } },
    camera: { flyTo: (options) => calls.push(options) },
  };
  const focus = createNavigationFocus(viewer, (move) => {
    assert.equal(calls.length, 0);
    calls.push('ownership');
    return move();
  });
  assert.equal(focus({ lat: 38, lon: -77 }), true);
  assert.equal(calls[0], 'ownership');
  const location = Cartographic.fromCartesian(calls[1].destination);
  near((location.latitude * 180) / Math.PI, 38, 1e-9);
  near((location.longitude * 180) / Math.PI, -77, 1e-9);
  near(location.height, 12000, 1e-6);
  assert.equal(viewer.selectedEntity, undefined);
  let attempted = false;
  createNavigationFocus(viewer, () => {
    attempted = true;
    return false;
  })({ lat: 0, lon: 0 });
  assert.equal(attempted, true);
  assert.equal(calls.length, 2, 'a denied camera owner cannot move');
});

test('UPS matches independent PROJ 9.5.1 EPSG:5041/5042 vectors in both polar regions', () => {
  // Generated with pyproj 3.7.2, Transformer.from_crs(4326, 5041/5042,
  // always_xy=True). These are independent fixtures, not our inverse output.
  const vectors = [
    [85, 0, 2000000, 1444542.6086173223],
    [85, 90, 2555457.3913826775, 2000000],
    [84, 45, 2471447.6804798758, 1528552.319520124],
    [89.9, -135, 1992149.4287935556, 2007850.5712064444],
    [-80, 0, 2000000, 3112951.1369549055],
    [-85, 90, 2555457.3913826775, 2000000],
    [-85, 180, 2000000, 1444542.6086173223],
    [-89.9, -45, 1992149.4287935556, 2007850.5712064444],
  ];
  for (const [lat, lon, easting, northing] of vectors) {
    const hemisphere = lat < 0 ? 'S' : 'N';
    const grid = toUps({ lat, lon });
    assert.equal(grid.hemisphere, hemisphere);
    near(grid.easting, easting, 1e-6, 'PROJ easting');
    near(grid.northing, northing, 1e-6, 'PROJ northing');
    const point = fromUps({ hemisphere, easting, northing });
    near(point.lat, lat, 1e-9, 'PROJ inverse latitude');
    near(point.lon, lon, 1e-9, 'PROJ inverse longitude');
    const rounded = parseCoordinate(
      formatCoordinate({ lat, lon }, 'UPS'),
      'UPS',
    );
    assert.ok(rangeBearing({ lat, lon }, rounded).distanceM < 0.1);
  }
});

test('UPS pole convention and strict parsing retain hemisphere without inventing a longitude', () => {
  for (const [lat, hemisphere] of [
    [90, 'N'],
    [-90, 'S'],
  ]) {
    assert.equal(
      formatCoordinate({ lat, lon: 123 }, 'UPS'),
      `${hemisphere} 2000000.0 2000000.0`,
    );
    assert.deepEqual(
      parseCoordinate(`${hemisphere.toLowerCase()} 2000000 2000000`, 'UPS'),
      { lat, lon: 0 },
    );
  }
  for (const bad of [
    'N 1e6 2000000',
    'Z 2000000 2000000',
    'N -1 2000000',
    'N 4000001 2000000',
    'N 0 0',
    'S 0 0',
    'N 2000000 2000000 trailing',
    '31 N 2000000 2000000',
    'N NaN 2000000',
  ])
    assert.throws(() => parseCoordinate(bad, 'UPS'));
  for (const lat of [-79.999, 0, 83.999])
    assert.throws(() => toUps({ lat, lon: 0 }), /UPS/);
  for (const easting of [null, undefined, '2000000', NaN, Infinity])
    assert.throws(() =>
      fromUps({ hemisphere: 'N', easting, northing: 2000000 }),
    );
  // Opposite-hemisphere shape with the south domain radius is not valid in north UPS.
  assert.throws(
    () =>
      fromUps({
        hemisphere: 'N',
        easting: 2000000,
        northing: 3112951.1369549055,
      }),
    /UPS/,
  );
});
