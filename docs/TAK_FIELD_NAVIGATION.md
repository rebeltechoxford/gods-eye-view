# Field coordinates and waypoint navigation

The TAK panel adds **COORDINATES / NAVIGATION** to the existing GEV globe. It
accepts decimal degrees, degrees/minutes/seconds, MGRS and UTM without external
geocoding or additional dependencies. Every coordinate uses **WGS84**. This is
a waypoint/range tool; it does not compute a route, terrain clearance, magnetic
declination, elevation or a device GPS fix.

1. Choose an input format and enter a coordinate, then press **Validate
   coordinate**. Readouts show all four supported representations. Examples:
   - DD: `38.88927, -77.05020` (latitude first).
   - DMS: `38°53′21.37″N 77°03′00.72″W` (hemispheres required).
   - MGRS: `18S UJ 22185 06486` (spaces optional; precision is explicit).
   - UTM: `18 N 322185.1 4306486.7` (zone, **hemisphere**, easting and northing
     in metres; N/S here is not an MGRS latitude band).
2. **Use map center** or **Use my position** can fill the waypoint. Map-center
   and operator-set positions are clearly labelled as not device GPS. The tool
   refuses a GPS fix that is stale, stopped or backgrounded.
3. Choose the measurement origin. Range is WGS84 ellipsoidal surface distance;
   bearing is the initial **true-north bearing**, not grid or magnetic bearing.
   Camera moves and position updates refresh the readout. Coincident points and
   pole origins have no invented bearing. Nearly antipodal calculations report
   unavailable rather than invoking an unbounded geodesic iteration.
4. **Focus waypoint** releases the existing camera follow owner and frames an
   overview through GEV navigation. The framing height is not waypoint altitude.
   **Add local waypoint marker** uses the existing TAK client with sharing
   explicitly disabled. It does not change or broadcast self position.

UTM/MGRS covers 80°S…84°N, including Norway/Svalbard zone exceptions. Polar UPS
and alternate datums are unavailable; DD/DMS still works at the poles. MGRS
represents a grid area: the tool uses its centre, clipped at grid-zone/band
boundaries, and reports the square width. Extra readout digits never improve
input or GPS accuracy. Inputs are bounded and reject missing fields, invalid
numeric coercion, out-of-range coordinates, invalid grid squares and trailing
content. Editing input invalidates the previous waypoint before another action.

Entered coordinates/labels and map-derived waypoints activate the existing
sticky TAK privacy guard before parsing or navigation. They remain in page
memory; there is no geocoding, persistence, automatic clipboard/export or
network publication. Clear removes the waypoint without lifting privacy.
Logout/session expiry clears the form and in-memory waypoint. Destroy removes
the panel, subscriptions, camera listener, timer and event handlers. Mobile
controls retain 44 px targets and 16 px input text.

## Verification and references

`node --test src/tak/navigation.test.mjs` exercises numerical UTM checkpoints
from the official PROJ examples, northern/southern and zone-edge roundtrips,
strict DD/DMS/MGRS/UTM validation, grid precision/polar limits, ellipsoidal
range/true bearing, GPS freshness, unshared marker construction, privacy,
camera ownership and retired-workflow cleanup. Browser and physical-device
acceptance must be recorded separately; unit tests do not establish either.

On 2026-10-16, supported Node 24.19.0 passed all 16 focused numerical/workflow
tests, including 64 UTM boundary roundtrips and explicit coarse-grid/dateline
cases. A combined run with existing client, privacy and position tests passed
39/39, with no skips or failures. The package-boundary check passed with these modules assigned to the
existing application owner. The initial MGRS test exposed an incorrectly
labelled reference fixture, corrected against independent UTM arithmetic; a
separate regression covers `mgrs` 2.1.0 returning a zero-area southwest point
for a zero-digit 100 km reference. No unit check was relaxed.

The combined field-integration app passed all 13 scenarios of
`node scripts/qa-tak-navigation.mjs --url http://127.0.0.1:4174
--artifact-dir qa-artifacts/field-navigation-final` at
`2026-10-17T01:25:14Z`, Windows, Node 24.19.0 and Chrome 152. The gate used 31
physical touches and real form input across all four formats; it checked local
marker creation with zero TAK transmissions, public-camera follow release and
completed focus, private sharing protection, synthetic GPS freshness, local
sign-out cleanup and repeated teardown. At a 390 × 844 viewport, ten controls
measured at least 44 px tall with 16 px text, and the inspected screenshot
contained 16 textured Cesium terrain tiles. Evidence: the `results.json` and
`phone-navigation.png` in that artifact directory; no uncaught, render or fixture
errors occurred. The sign-out scenario deliberately returns synthetic HTTP503
to verify clearing before the POST; real session revocation is covered by the
separate private-HTTPS gate. GPS and map imagery are synthetic, and this does
not establish physical-phone or operational TAK-peer acceptance.

That browser run also caught a real startup incompatibility: the existing
`mgrs` package exposes a CommonJS default through Node but named-only ESM through
Vite. A namespace import with a reflective default fallback now supports both
without requesting a nonexistent ESM export; all 39 targeted tests passed again
after that correction.

The existing `mgrs` 2.1.0 dependency supplies MGRS conversion; its existing
licensing and provenance remain applicable. UTM uses an independent arithmetic
implementation of the published fourth-order Kruger series. Existing Cesium
WGS84 ellipsoidal geodesics supply range/bearing. No Android TAK source is used.

- [PROJ: UTM parameters and numerical examples](https://proj.org/en/stable/operations/projections/utm.html)
- [PROJ: Transverse Mercator mathematical definition](https://proj.org/en/stable/operations/projections/tmerc.html)
- [USGS: UTM northings/eastings and MGRS relationship](https://www.usgs.gov/faqs/how-are-utm-coordinates-measured-usgs-topographic-maps)
- [NGA: coordinate systems and MGRS references](https://earth-info.nga.mil/index.php?dir=coordsys&action=coordsys)
- [Existing mgrs conversion API and license information](https://github.com/proj4js/mgrs)
- [Cesium EllipsoidGeodesic API](https://cesium.com/learn/cesiumjs/ref-doc/EllipsoidGeodesic.html)
