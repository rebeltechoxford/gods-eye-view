# Retained offline maps and terrain

Source audit: 2026-10-16. The first bounded USGS raster-pack implementation is
on `feature/tak-offline-iphone`; eight production browser scenarios passed with
synthetic tiles and a real closed-server outage on desktop Chromium at a phone
viewport. This evidence is separate from focused tests and physical-phone
acceptance. The broader chart/3D-terrain inputs below remain
planned. Physical-phone acceptance has not been performed. The requested behavior is to choose an area/detail level,
download it, and retain it locally until explicitly deleted. A phone must be
able to reopen and render the saved area with all network access disabled.
Keeping tiles only on the desktop server does not satisfy that requirement.
The user selected both server and phone storage; both should be the default
download targets, with separate readiness and storage status for each copy.

## Source permissions and supported acquisition

| Existing source or dataset                                 | Offline acquisition finding                                                                                                                                                                                                                 | Initial implementation policy                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| USGS Topographic / The National Map                        | USGS explicitly permits downloaded map services/data. Current USGSTopo metadata enables `exportTilesAllowed` with a 100,000-tile export cap.                                                                                                | First approved area-download source. Bound region, levels, bytes and concurrency. Retain service/source credits and timestamp.                                                          |
| US Topo / historical topographic sheets                    | Official GeoTIFF/GeoPDF downloads exist. Some older roads and Alaska/Hawaii imagery carry commercial notices.                                                                                                                               | Accept permitted operator-provided raster packages; retain original collar/metadata notices. Do not erase notices during conversion.                                                    |
| USGS 3DEP elevation                                        | Downloadable DEMs include Cloud Optimized GeoTIFF products.                                                                                                                                                                                 | Later elevation-pack input; this is height data, not a rendered topographic map. Preserve horizontal/vertical reference and units.                                                      |
| NOAA ENC chart display                                     | NOAA explicitly supplies regional raster MBTiles, updated weekly.                                                                                                                                                                           | Prefer official downloadable MBTiles over scraping the live WMS. Retain acquisition/source edition and chart limitations.                                                               |
| FAA VFR / IFR                                              | Official current GeoTIFF ZIP products are downloadable. The three ArcGIS tile endpoints currently disable tile export.                                                                                                                      | Use official chart files/imports. Do not infer permission for bulk tile harvesting from public interactive access. Preserve effective dates, legend and notices.                        |
| Esri Topographic / Terrain / Ocean                         | All three current services report `exportTilesAllowed: false`; public access is not a blanket offline license.                                                                                                                              | No generic download button for these endpoints. Support an explicitly licensed operator package or a separately configured approved export source.                                      |
| Google photorealistic 3D / Map Tiles                       | Google restricts prefetch/storage and offline use except applicable agreement exceptions.                                                                                                                                                   | Keep online capability; do not build a permanent Google tile downloader.                                                                                                                |
| Cesium ion World Terrain / Bing / other Asset Depot assets | Standard ion terms restrict offline Data Output, with specific exceptions and separate third-party terms.                                                                                                                                   | Do not mirror these assets without a suitable agreement. An API key alone is not offline authorization.                                                                                 |
| OSM standard raster tile server                            | Its usage policy explicitly forbids offline-area prefetch/bulk download.                                                                                                                                                                    | No downloads from `tile.openstreetmap.org`. Operator-owned or licensed OSM-derived packs remain possible.                                                                               |
| Mapterhorn elevation                                       | The project explicitly documents bounded PMTiles area extracts; terrain data has regional source-specific attribution/licenses.                                                                                                             | Candidate global elevation path. Import/extract through the documented distribution and preserve source attribution; do not label all source data with one blanket license.             |
| Re:Earth keyless terrain                                   | The current service supplies TMS-Geographic quantized meshes with ellipsoidal heights and bundled attribution. Its site describes open data licenses, best-effort capacity and possible rate limits; it publishes no pre-rendered archives. | Retain its metadata and source credits. Prefer approved bounded packs or self-hosting upstream sources rather than assuming unlimited bulk extraction from the live conversion service. |

Primary sources:

- [USGS map-service/data terms](https://www.usgs.gov/faqs/what-are-terms-uselicensing-map-services-and-data-national-map),
  [USGSTopo metadata](https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer?f=pjson),
  [US Topo copyright exceptions](https://www.usgs.gov/faqs/are-usgs-topographic-maps-copyrighted),
  [3DEP downloads and formats](https://www.usgs.gov/faqs/what-types-elevation-datasets-are-available-what-formats-do-they-come-and-where-can-i-download).
- [NOAA offline MBTiles](https://distribution.charts.noaa.gov/ncds/index.html),
  [NOAA GIS distribution guidance](https://nauticalcharts.noaa.gov/data/gis-data-and-services.html),
  [NOAA data licensing](https://nauticalcharts.noaa.gov/data/data-licensing.html).
- [FAA VFR downloads](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/),
  [FAA IFR downloads](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/ifr/).
- [Esri offline export capability](https://developers.arcgis.com/rest/services-reference/enterprise/export-tiles-map-service/),
  [Esri item access/use constraints](https://doc.arcgis.com/en/arcgis-online/reference/access-use-constraints.htm),
  [Google Map Tiles policy](https://developers.google.com/maps/documentation/tile/policies),
  [Cesium ion terms, section 2.2.2](https://cesium.com/legal/terms-of-service),
  [OSMF tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- [Mapterhorn area extracts](https://mapterhorn.com/data-access/),
  [Mapterhorn source attribution](https://mapterhorn.com/attribution/),
  [Re:Earth terrain formats, datums and operating model](https://terrain.reearth.land/).

The source audit inspected metadata/pages. A later bounded source check used
the implemented server store to retain one real USGS tile over the public
National Mall test area: zoom 10, 43,463 bytes, verified JPEG, at
2026-10-16T20:24:05Z. No public bulk download or ArcGIS export job was started.
`exportTilesAllowed` describes server capability;
it is not itself a substitute for the source's license. ArcGIS export jobs
produce TPK/TPKX/cache datasets, which require a supported import/conversion
path rather than being called MBTiles.

## Focused first slice

1. Add a Saved Maps workflow to the existing full GEV workspace. Choose an
   area and minimum/maximum detail, show tile count and estimated size, and
   select server, this device, or both. Start with USGS Topographic and a
   normalized raster tile pack. Do not change the original map defaults or
   expose arbitrary upstream URL fetching.
2. Store completed server packs in a private operator-controlled directory
   outside Git and public assets. Store device packs in IndexedDB or OPFS,
   separately from service-worker application caches. Use a manifest plus
   bounded tile blobs keyed by pack ID and z/x/y. Jobs need progress,
   interruption/resume, cancellation, quota failure handling and atomic
   completion. A partial pack must not be labeled ready.
3. Render a selected saved pack through a Cesium imagery provider and the
   existing map controller. Local reads must not construct an online ArcGIS
   provider or fetch metadata. Missing area/zoom tiles show a clear coverage
   state and neutral globe, without silently fetching a public fallback.
4. Add an actual offline application shell. `public/gev-sw.js` at the foundation checkpoint
   deliberately stores nothing and serves a reconnect screen; changing only
   map storage would still leave a disconnected phone unable to open GEV.
   Cache versioned static code, styles, required local fonts, Cesium assets and
   geometry workers. Keep API, login, gateway, CoT, AI and credential responses
   out of every cache. An offline map viewer must not pretend its expired
   server login authorizes gateway access. Reconnect uses normal server auth.
5. Retain completed map packs until explicit deletion. App updates, ordinary
   logout and a stale chart edition must not silently delete a user's saved
   public/owned maps. Tactical data still follows its separate retention and
   logout policy. Mark old editions and unavailable online functions honestly.
   Keep map names/bounds out of AI, analytics and public share URLs.

The source registry is currently composed at controller construction and
share/voice maps use a fixed portable ID list. The implementation needs an
explicit local-pack registration/selection seam with owned provider cleanup;
changing the selected pack must not reuse the previous pack's cached imagery.
Local pack IDs should not become invented public share links.

Each manifest should retain source ID, title, coverage, CRS/tiling scheme,
tile format/size, zoom limits, tile count, bytes, hashes, acquisition time,
source/edition dates, attribution/license notices and ready/partial status.
Elevation packs additionally require height units and vertical datum. Preserve
the original source metadata alongside any normalized manifest.

## Implemented bounds and verification

The first slice accepts only the pinned USGS Topo XYZ source, PNG/JPEG tiles at
256 pixels, and validated area/zoom parameters. It caps each pack at 5,000 tiles
and 512 MiB, the aggregate store at 2 GiB, each tile at 2 MiB, and downloading at
four concurrent requests. Server manifests and tile writes are durable; explicit
resume reuses only verified retained bytes. Device copies use IndexedDB and
check SHA-256, length and MIME. `.gevmap` backups support bounded export/import.
The server cache is private and outside public assets/Git by default; production
access uses the existing HTTPS operator session, while dev/lab requires its
existing guarded loopback token. No arbitrary URL downloader was added.

`scripts/qa-offline-maps.mjs` passed **8/8 scenarios** on 2026-10-16 at
21:00:54 UTC, using Chrome 152.0.7977.75 on Windows x64 at 390 × 844. The
local HTTPS listener used generated fixture certificates trusted only by the
test browser's leaf SPKI. All map acquisition in this gate used synthetic image
bytes; it made **zero external bulk downloads**. Its evidence is saved locally
under `qa-artifacts/offline-maps/results.json` and three screenshots.

1. Native HTTPS login and the Saved Maps UI retained 21 verified tiles on both
   server and device. The explicitly saved app contained 452 cache entries and
   44,207,116 bytes, including 110 Cesium worker files and 19 independently
   hash-verified font/CSS/license/provenance files.
2. Actual Cesium imagery decoded 256-pixel images with 2,730 sampled colors and
   produced 20 textured globe tiles, preserving all 30 GEV layer registrations.
   Requested terrain geometry sampled zero height; source, pack and flat
   ellipsoid credits were present.
   All six area/zoom inputs measured 165 × 44 pixels, inside their labels and
   the panel at the 390-pixel viewport.
3. A real browser export produced a 256,728-byte `.gevmap`; device deletion and
   file-input restoration retained 21 tiles with independently checked hashes.
4. Cancellation retained eight tiles. Resuming and using the visible row's
   cancel control retained 12, then another resume completed the 85-tile pack.
   Device copying and explicit deletion also passed. Observed download
   concurrency never exceeded four.
5. Synthetic contact/chat data and the runtime operator token were absent from
   saved app responses and localStorage. API/login/logout responses and
   credential cookies were excluded from app caches.
6. The test closed the actual HTTPS listener, opened a fresh page, and received
   the saved root document from the service worker while `navigator.onLine`
   remained true. A stale `map=osm` share hash did not override the selected
   saved pack. Actual globe input panned the local map with 20 textured tiles
   and no online map/terrain requests; tactical contacts/chat were not restored.
   The saved Material Symbols face loaded and rendered the `public` ligature
   as a single 24-pixel glyph, with no external Google font requests.
7. Restarting the server on the same port retained its pack. Explicit UI
   deletion left zero server packs, device packs/tiles and saved app caches.
8. Advancing the server's injected clock caused a real service-worker manifest
   request to receive HTTP 401. Before redirecting to login, the departing app
   cleared its synthetic contact/chat, USER fix, disclosure authorization and
   private form inputs.

The separate real-source check described above retained one USGS JPEG tile
(43,463 bytes, zoom 10, public National Mall test area) at 20:24:05 UTC. This
checks the fixed acquisition path against the actual service; it does not turn
the synthetic browser gate into a live bulk-download or operational field test.

Focused worker regression tests also cover expiry during a later concurrent
asset request, preserving the HTTP 401 reason when sibling requests abort,
and the save/cancel/delete commit races. An accepted cancellation before commit
removes the staging generation and preserves the previous saved app. Once
pointer commit starts, cancellation is refused; delete and save cannot mutate
the app cache concurrently. The final worker test file passed 11/11 tests.

The final run includes the phone numeric-field CSS correction and self-hosted
existing fonts. Fourteen unchanged font binaries total 309,408 bytes; source
hashes and retained OFL/Apache notices are in `public/fonts/provenance.json`.
The gate verifies every cached font, stylesheet, license and provenance file
against those hashes. Its image fixtures establish local rendering and input
behavior, not real geographic alignment: the disconnected screenshot at
0°/0° and 50 km altitude shows a nearly uniform pale area from the repeated
synthetic imagery/view. The separate real-tile check below establishes visible
geographic map detail locally; real-device alignment, editions and navigation
acceptance remain separate requirements.

This verification caught and repaired a production-host omission: the build
and worker included fonts, while the authenticated static host initially
refused the `/fonts` directory. The host now allows that build directory;
its 10-test real-TLS suite verifies font/CSS/license MIME and bytes after
login, existing static redirects to login before authorization, API HTTP 401,
and refusal of an unapproved private directory. A separate closed-store
regression verifies that an old server-store reference cannot cancel/delete
a replacement writer's retained pack or lock after shutdown.

Physical iOS/Android installation, storage persistence, eviction/restart
behavior and disconnected field use remain unverified.

### Real one-tile geographic rendering check

A separate bounded check passed at 2026-10-16 21:07:33 UTC using the same built
private HTTPS host and Saved Maps UI. It acquired exactly one actual USGS Topo
tile over the public National Mall area: XYZ `14/4685/6268`, source endpoint
`/tile/14/6268/4685`, HTTP 200 JPEG, 34,900 bytes, SHA-256
`f0f57148ba36ed828cff9d3b8d6f0038fe8b122d0ff1858fc52c3c9f445e6f4c`.
The small selected box was west −77.0369, east −77.0364, south 38.8852,
north 38.8857; planning asserted one tile before starting. The Node fetch
fixture allowed only that fixed USGS URL and one acquisition request.

The UI saved server/device copies and the app, then selected the local map.
A controlled downward camera at the public Lincoln Memorial coordinates
(38.88927, −77.0502; 1,300 m) produced actual canvas pixels showing river,
road/traffic-circle geometry and park labels. After the actual server stopped,
a fresh cached page rendered the same map while `navigator.onLine` remained
true, with no online map/terrain/font requests. The central 220-pixel sample
contained 10,919 distinct colors online and 10,694 offline, with luminance
ranges of 227 and 201. Raw Cesium canvas captures and full UI screenshots were
visually inspected; the empty area north of the retained tile remained blank
rather than fetching an online fallback.

Evidence is local under `qa-artifacts/offline-national-mall/`: `results.json`,
`online-national-mall-canvas.png`, `offline-national-mall-canvas.png`, and the
corresponding `-ui.png` captures. This was Windows Chromium at a 390 × 844
phone viewport with a synthetic operator and generated local TLS fixture;
it was not a physical phone, operational TAK test or bulk download. The
one-off runner stayed in ignored `.gev-cache`; it changed no shipped runtime
or browser harness. Real-device alignment, edition and navigation acceptance
remain separate work.

## Supported-runtime regression record

The combined offline/foundation source at `49aaf7de` passed the complete local
Node 24.19.0 suite with Git 2.53: 6,554 ordinary tests, 6,544 passes, ten existing
skips and no failures, followed by all 14 isolated allocation tests. The later
closed-store mutation guard passed its replacement-writer regression; the
font-directory host correction passed all ten real local HTTPS tests. The final
eight-scenario browser run above includes both corrections.

Formatting checked 1,397 source files; import/package boundaries and all 29
published layer tokens passed. Production and portable panel builds passed
(10.73 and 11.30 seconds), with existing chunk-size warnings retained.
`npm audit --omit=dev` reported zero production vulnerabilities. Complete final
CI evidence is linked from [PR #5](https://github.com/rebeltechoxford/gods-eye-view/pull/5).

## File imports and elevation

Raster MBTiles and raster PMTiles are appropriate portable inputs. MBTiles is
SQLite and uses TMS tile rows: convert to XYZ with `y = 2^z - 1 - tile_row`.
PMTiles supports range reads and browser local-file sources. Container support
does not establish the data license, and a vector PBF archive is not a raster
map: it requires a style, glyphs/sprites and a rendering path. Validate format,
size, coordinates, metadata and image dimensions; reject unsupported content
with a useful reason.

An initial server-side MBTiles import can normalize raster tiles for transfer
to the phone, avoiding a new mandatory SQLite/WASM browser runtime. A raster
PMTiles reader can use a local Blob/OPFS source. GeoTIFF imports need geographic
metadata, reprojection and overview/tile creation; merely decoding TIFF pixels
with an image library is insufficient. Narrow supported CRS/format choices or
use a reviewed conversion tool, and state that scope explicitly.

Rendered contour/topographic imagery and shaded-relief imagery do not create
3D terrain. Offline terrain needs a separate local Cesium terrain provider for
quantized mesh, decoded heightmaps or another supported elevation format.
3DEP DEM and Mapterhorn Terrarium raster tiles need decoding/tiling and datum
handling before they can replace online terrain. Do not treat NAVD88/MSL and
WGS84 ellipsoidal heights as interchangeable. Until this is implemented, the
offline map pack must clearly report flat ellipsoid terrain.

Format references: [MBTiles 1.3](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md),
[PMTiles concepts](https://docs.protomaps.com/pmtiles/),
[PMTiles local FileSource implementation](https://github.com/protomaps/PMTiles/blob/main/js/src/index.ts).

## Device persistence and acceptance

Request `navigator.storage.persist()` from the download action, record whether
it was granted, and use `estimate()` plus reserved headroom before writing.
Handle quota exhaustion without deleting existing packs. Browser storage is
not an unconditional lifetime guarantee: platform eviction, explicit site-data
clearing, app removal or device loss can remove it. Offer pack export and a
server copy as a durable backup. Safari supports the Storage API and grants
persistence heuristically, including Home Screen installation; do not promise
a fixed available disk capacity. See [WebKit storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)
and [Chrome persistent storage guidance](https://web.dev/articles/persistent-storage).

Acceptance must include a fresh page/process reopen with the app server and
all other networking unreachable, not just `navigator.onLine = false` or a
server-cache hit. Verify saved-area rendering, geographic alignment, offline
credits, Cesium worker readiness, zoom/coverage misses, device quota refusal,
interrupted/resumed writes, app update, delete/reimport and no credential/API
cache entries. Test desktop and mobile-sized Chromium automatically, then
actual installed iOS Safari and Android Chrome before claiming physical-phone
field readiness. GPS availability/background execution remains device/browser
dependent; disconnected maps do not establish native EUD parity.
