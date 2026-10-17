# TAK drawings and routes

This slice adds an original, portable CoT geometry model and emitter. It supports ordered polylines, simple regional polygons and routes with waypoint metadata. Globe rendering, editing, sharing and gateway authorization are separate integration owners; parser tests alone do not verify those workflows. Native ATAK/iTAK/WinTAK acceptance and live TAK Server geometry exchange remain unverified.

## Format research and licensing

Primary format references were inspected at ATAK-CIV commit `889eee292c43d3d2eafdd1f2fbf378ad5cd89ecc` on 2026-10-16. The implementation and synthetic tests were written independently; no Android source or native fixtures were copied. ATAK-CIV’s [license](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/889eee292c43d3d2eafdd1f2fbf378ad5cd89ecc/LICENSE.md) must be reviewed before any future code reuse. This project’s MIT license does not grant permission to incorporate GPL application code.

- [EditablePolyline.java, lines 1476–1532](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/889eee292c43d3d2eafdd1f2fbf378ad5cd89ecc/atak/ATAK/app/src/main/java/com/atakmap/android/editableShapes/EditablePolyline.java#L1476): ordered direct `detail/link` elements carry `point="lat,lon[,HAE]"`; constituent waypoint links also carry identity/type/relation/name/remarks. A closed ring repeats its first point at the end.
- [DrawingShape.java](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/889eee292c43d3d2eafdd1f2fbf378ad5cd89ecc/atak/ATAK/app/src/main/java/com/atakmap/android/drawing/mapItems/DrawingShape.java#L165): drawing type `u-d-f`; its event point serves as a separate shape anchor.
- [Route.java, lines 1793–1827](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/889eee292c43d3d2eafdd1f2fbf378ad5cd89ecc/atak/ATAK/app/src/main/java/com/atakmap/android/routes/Route.java#L1793): route type `b-m-r` and `link_attr` route settings. Legacy `stroke` is an integer; fractional common stroke weight can coexist with its truncated legacy value. Waypoint/control types are `b-m-p-w` and `b-m-p-c`.
- [StrokeFillDetailHandler.java, lines 18–65](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/889eee292c43d3d2eafdd1f2fbf378ad5cd89ecc/atak/ATAK/app/src/main/java/com/atakmap/android/cot/detail/StrokeFillDetailHandler.java#L18): signed integer ARGB stroke/fill colors, numeric stroke weight and named line styles. Fill is emitted for closed shapes.

## Portable API

`src/tak/geometry.js` imports no CoT parser, rendering, browser or Node code. `parseTakGeometry(event)` returns one of:

- `{ status: 'ok', geometry }`
- `{ status: 'not-geometry' }`
- `{ status: 'unsupported', reason }`
- `{ status: 'invalid', reason }`

Invalid or unsupported geometry must have an explicit warning and must never be substituted with the event’s anchor point as if it were a valid drawing. Original parsed CoT XML is retained unchanged, including unknown namespaced extensions. Geometry reads direct raw detail children, because the generic semantic `detail.links` summary is bounded to 32 entries and omits vertex fields.

`validateGeometry(input, { authoring: true })` accepts route draft waypoint names/types without IDs. Canonical/wire validation requires complete UID/type/constituent relation whenever waypoint metadata is supplied. Ordinary point-only vertices are allowed. The returned model and its children are frozen:

```js
{
  kind: 'polyline' | 'polygon' | 'route',
  vertices: [{ lat, lon, hae, uid, type, relation, callsign, remarks }],
  closed, altitudeMode: 'ground' | 'absolute',
  style: { strokeColor, fillColor, strokeWidth, strokeStyle },
  route: null | {
    method, direction, routeType, order,
    transportationType, planningMethod, prefix
  },
  bounds: { west, east, south, north, crossesAntimeridian, longitudeSpan }
}
```

All numeric author input must be actual finite numbers. Peer coordinates use strict decimal parsing. Latitude/longitude ranges are ±90/±180 degrees; height is WGS84 ellipsoidal HAE in metres from −12,000 to 1,000,000. Missing HAE and the CoT unknown sentinel become `null`, never zero. All-null geometry clamps to ground; all-finite geometry uses per-vertex absolute ellipsoidal heights. Mixed known/unknown altitude is explicitly unsupported, including local drafts. The event anchor does not replace the actual vertices.

Shortest-edge longitude unwrapping supports dateline crossings. Exactly half-world longitude edges and antipodal edges require intermediate vertices. Polygons must be simple, have nonzero spherical area and no duplicate/overlapping edges. Regional polygon rings spanning at least 180 degrees, winding around a pole or touching a pole are unsupported. Bounds describe vertices; they are not a terrain envelope or navigation clearance guarantee. Open routes may return to their starting location without becoming polygons. Holes, circles, rectangles with separate native semantics, multipolygons, route cues and routing engines are outside this subset.

Style colors accept signed 32-bit ARGB or unsigned 32-bit equivalents and normalize to signed integers. `geometryColorRgba()` returns normalized RGBA channels for a renderer. Default author stroke is white, width 3; polygon fill alpha is 0x33 and open fill is transparent. Width range is 0.5–32. Line styles are `solid`, `dashed`, `dotted`, `outlined`; a renderer must report any unsupported visual style rather than claim native visual parity.

Exported route enums are `ROUTE_METHODS`, `ROUTE_DIRECTIONS`, `ROUTE_TYPES`, `ROUTE_ORDERS`. Defaults are Driving/Infil/Primary/Ascending Check Points, transportation Ground, planning Infil and prefix CP. Recognized methods are Driving, Walking, Flying, Swimming and Watercraft; unsupported enum values return an explicit unsupported result. Planning/transport labels remain bounded descriptive text, not an executable routing request.

## Authoring, ownership and revisions

`src/tak/geometryCot.js` exports:

```js
buildGeometry(identity, input, { nowMs, staleMs, expectedRevision });
buildGeometryDelete(identity, targetUid, targetType, options);
ownsGeometryUid(identity, uid);
ownsGeometryWaypointUid(geometryUid, uid);
```

Input contains `kind`, `vertices`, optional `style`/`route`, required `callsign`, optional `remarks`, and optional existing `uid`. A new feature receives `GEV-MARKER-<device UUID>-<random UUID>`, matching the existing identity-owned marker namespace. Every authored route vertex receives `<geometry UID>-WP-<random UUID>` plus constituent relation `c`. An edit retains supplied waypoint IDs only inside that feature’s namespace, mints IDs for new points, and replaces the whole vertex list. A copy without a feature UID remints every waypoint ID. The builder selects only known fields; it does not relay caller-supplied extensions, credentials, arbitrary namespaced data or URLs.

Optional `expectedRevision` is the previous event’s millisecond `timeMs`; the new event time must be strictly later. The calling client must also compare it against the currently stored revision immediately before saving, and reject missing/changed contacts. The pure builder cannot detect another writer’s state. Newer complete events replace old geometry through the existing store; older updates cannot overwrite it. Deletion uses the existing `t-x-d-d` target-link contract and requires the author’s feature namespace. Gateway authentication/authorization remains mandatory; UID formatting alone is not access control.

No helper automatically transmits data or fetches URLs. The client must require an explicit per-action sharing choice. Package import/export can preserve the full original CoT, subject to its separate selected-package disclosure permission. Unknown extension preservation for inbound/relayed data must never bypass the browser publish allowlist.

## Resource limits and evidence

Each feature has at most 256 unique vertices (257 serialized point links only for polygon closure), at most 1,024 direct detail children, bounded 64-character waypoint names and 256-character waypoint remarks. Author feature names/remarks are bounded to 64/256 characters. An outbound event must fit the existing 64 KiB CoT limit in full; it is rejected rather than truncating vertices or metadata. Aggregate store/renderer budgets belong to the integration layer.

Focused verification on Node 24: `node --test src/tak/geometry.test.mjs` — 29 tests pass. Tests use independently authored synthetic XML, covering ordered vertices beyond generic link 32, closed/dateline geometry, unknown/negative/zero HAE, malformed coordinates, self-intersections/degeneracy, resource/style limits, partial peer waypoint metadata, immutable parse results, opaque extension preservation, stable own-waypoint edits, copied/foreign IDs, canonical field stripping, full replacement/deletion and revision ordering. This is format-level evidence, not real-peer interoperability or a physical-phone field test.
