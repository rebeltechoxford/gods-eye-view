# Retained offline maps and terrain

Source audit: 2026-10-16. This is an implementation proposal, not an implemented
offline feature. The requested behavior is to choose an area/detail level,
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

Only metadata/pages were inspected for this proposal. No export job or public
bulk download was started. `exportTilesAllowed` describes server capability;
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
4. Add an actual offline application shell. `public/gev-sw.js` currently
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
