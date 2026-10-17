import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalBrowserGeometry } from '../../server/providers/tak/browserGeometry.js';
import { buildGeometry } from '../tak/geometryCot.js';
import { parseTakGeometry } from '../tak/geometry.js';
import { parseCotEvent, serializeCotEvent } from '../tak/protocol/cot.js';
import { IDENTITY, T0 } from '../tak/protocol/fixtures.mjs';

const source = () =>
  buildGeometry(
    IDENTITY,
    {
      kind: 'route',
      callsign: 'SYNTHETIC ROUTE',
      remarks: 'Test only',
      vertices: Array.from({ length: 40 }, (_, index) => ({
        lat: 34 + index * 0.001,
        lon: -89,
        type: 'b-m-p-w',
        callsign: `CP${index}`,
      })),
    },
    { nowMs: T0 },
  );
test('browser canonicalization retains the complete route and own waypoint identities beyond semantic link32', () => {
  const event = source(),
    result = canonicalBrowserGeometry(event, IDENTITY);
  assert.equal(result.uid, event.uid);
  assert.equal(parseTakGeometry(result).geometry.vertices.length, 40);
  assert.deepEqual(
    parseTakGeometry(result).geometry,
    parseTakGeometry(event).geometry,
  );
});
test('browser geometry refuses foreign object/waypoint/parent IDs and arbitrary extensions before publication', () => {
  const event = source(),
    xml = serializeCotEvent(event);
  const foreign = {
    ...IDENTITY,
    uid: 'GEV-22222222-2222-4222-8222-222222222222',
  };
  assert.throws(() => canonicalBrowserGeometry(event, foreign), /owned/);
  for (const invalid of [
    xml.replace(`uid="${IDENTITY.uid}"`, `uid="${foreign.uid}"`),
    xml.replace(
      'parent_callsign="' + IDENTITY.callsign + '"',
      'parent_callsign="OTHER"',
    ),
    xml.replace(
      '</detail>',
      '<fileshare url="https://invalid.example/secret"/></detail>',
    ),
    xml.replace('<contact ', '<contact endpoint="secret" '),
    xml.replace('<link point=', '<link url="https://invalid.example/" point='),
    xml.replace('</detail>', '<remarks>second</remarks></detail>'),
    xml.replace(/uid="[^"]+-WP-[^"]+"/, 'uid="FOREIGN-WAYPOINT"'),
  ])
    assert.throws(() =>
      canonicalBrowserGeometry(parseCotEvent(invalid), IDENTITY),
    );
});
