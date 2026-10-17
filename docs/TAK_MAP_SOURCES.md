# GEV × TAK map and chart sources

Source review: 2026-10-16. The full GEV engine, with Google photorealistic 3D
when configured, remains the TAK workspace. These are optional map/chart views,
not a replacement globe or reduced application. A working public URL is an
availability observation, not an unlimited license, offline-download permission
or certified navigation system.

## Integrated architecture

| Module                                                              | Existing responsibility and extension point                                                                                                                                              |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/maps/catalog.js`                                               | Existing five identities plus eight optional curated references; original quick controls and defaults remain intact.                                                                     |
| `src/maps/defaultSources.js`                                        | Prefers loaded Google 3D, then existing keyless imagery; selects the exact reference factory lazily and shares existing terrain.                                                         |
| `src/maps/registry.js`                                              | Indexes supplied source descriptors/providers. Add source definitions here through existing composition, keeping provider policy out of the controller.                                  |
| `src/maps/imagery.js`, `referenceCatalog.js`, `referenceImagery.js` | Existing imagery plus portable descriptors and lazy pinned ArcGIS/WMS factories with scale, coverage and attribution policy.                                                             |
| `src/maps/controller.js`                                            | Owns activation, generation races, cached imagery/terrain/tilesets, credits, recovery and subscriber notification. Reuse it; avoid duplicating its state in a TAK-specific map switcher. |
| `src/maps/terrain.js`                                               | Cesium ion world terrain or keyless Re:Earth/Mapterhorn mesh, with explicit ellipsoid fallback. Shaded-relief imagery is not a terrain-height source.                                    |
| `src/maps/google3d.js`                                              | Direct Google key, short-lived server token and Cesium ion routes to Google photorealistic 3D Tiles. Keep this workspace capability and its existing provider restrictions/credits.      |

A provider outage or absent key must show the true state. Keep all public layers,
TAK contacts, camera/HUD/voice and scene workflows available while switching
maps. Preserve source lifetime cleanup, current map/imagery-host notifications,
share restoration and credits. The synthetic QA harness deliberately selects
OSM and substitutes imagery; that test choice is not the product default.

Public tile/WMS providers observe the requested tile or bounding-box area,
including when the camera follows a tactical location. No CoT/contact payload,
gateway credentials or private key is sent to these providers. Strict location
privacy requires an approved private map source or separately licensed offline
maps. The separate Saved Maps workflow already retains bounded USGS packs on
server/device and reopens the saved application offline; local raster MBTiles
import is the next focused extension described in [TAK_MBTILES_IMPORT.md](TAK_MBTILES_IMPORT.md).
This public-source catalog itself remains online. Existing Google,
Esri and OSM basemaps have the same network-location property.

## Curated service inventory

The endpoints below were probed directly, without credentials, on the review
date. ArcGIS error JSON must be checked even when HTTP status is 200. CORS was
tested using `Origin: http://localhost:4176`; successful service access does not
by itself validate every tile, browser/coverage combination or operational use.

| Source ID      | Pinned endpoint                                                                                                    | Observed limits/coverage and terms                                                                                                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esri-topo`    | `https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer`                                  | HTTP 200, CORS `*`, 256 px tiles, Web Mercator, advertised levels 0–23. Global reference coverage; legacy raster, not a current continuously maintained topo product. Keep all service contributors in credits.                                                |
| `esri-terrain` | `https://services.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer`                              | HTTP 200, CORS `*`, 256 px, Web Mercator, levels 0–13. Shaded relief/bathymetry reference imagery; elevation still comes from the terrain provider. Credit Esri, USGS and NOAA. Legacy raster.                                                                 |
| `esri-ocean`   | `https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer`                          | HTTP 200, CORS `*`, 256 px, Web Mercator, levels 0–16. Ocean bathymetry reference, not an ENC. Credit Esri, Garmin, GEBCO, NOAA NGDC and other contributors. No retirement date for this specific base endpoint was established in this review.                |
| `usgs-topo`    | `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer`                                          | HTTP 200, CORS `*`, 256 px, Web Mercator, 24 advertised levels. US detail with broad reference context; metadata reports refresh September 4, 2026. Service describes National Map/public-domain source data; preserve its complete contributor credit.        |
| `noaa-enc`     | `https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/WMSServer` | WMS 1.3.0 GetCapabilities HTTP 200, Origin-echo CORS, EPSG:3857 supported. NOAA-charted US waters; no chart coverage elsewhere. Use the Maritime extension, not the empty parent MapServer. Credit NOAA Office of Coast Survey.                                |
| `faa-vfr`      | `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer`                     | HTTP 200 metadata; minLOD **8**, maxLOD **12**. US sectional coverage is discontinuous, not global. Valid Oxford-area tiles at levels 8–11 returned 200 and Origin-echo CORS; low levels 6/7 returned 404 as expected.                                         |
| `faa-ifr-low`  | `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer`                       | HTTP 200 metadata; minLOD **7**, maxLOD **12**. Low-altitude/area chart coverage; inspect tile availability and edition metadata, not just broad fullExtent. Credit FAA Aeronautical Information Services.                                                     |
| `faa-ifr-high` | `https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer`                          | HTTP 200 metadata; minLOD **5**, maxLOD **9**. Service describes CONUS/Alaska high-altitude enroute charts, revised every 56 days. Credit FAA Aeronautical Information Services. `IFR_AreaHigh` is not the service: that guessed name returned JSON error 404. |

All three FAA services advertise 24 tileInfo levels despite narrower actual
`minLOD`/`maxLOD`. Enforce the latter. A sample sectional request
`.../VFR_Sectional/MapServer/tile/8/101/64` returned 200, approximately 49 KiB,
`application/octet-stream` and working CORS. Chromium/Cesium image decoding,
CORS, projection and request parameters were subsequently verified for FAA VFR
and NOAA ENC; see the evidence below.

Do not set a high minimum level over a large rectangle blindly: Cesium may fan
out many minimum-level tiles at an orbital view. A bounded adapter can retain
the root tiling level, serve one transparent placeholder below the chart's
minimum level, enforce maximum level and show a zoom/coverage hint. An absent
tile is a coverage state, not necessarily a broken provider. Keep an appropriate
underlay/neutral context rather than replacing GEV with an empty screen.

## NOAA layer and freshness details

The parent [ENCOnline MapServer metadata](https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer?f=pjson)
explicitly identifies itself as a vehicle for the Maritime extension with no
ENC chart features. The extension's WMS capabilities returned the layers below;
use the whole depiction, not layer 0 alone:

| Layer | Meaning                                       |
| ----- | --------------------------------------------- |
| `0`   | Information about chart display               |
| `1`   | Natural/man-made and port features            |
| `2`   | Depths and currents                           |
| `3`   | Seabed, obstructions and pipelines            |
| `4`   | Traffic routes                                |
| `5`   | Special areas                                 |
| `6`   | Buoys, beacons, lights, fog signals and radar |
| `7`   | Services and small craft facilities           |
| `8`   | Data quality                                  |
| `9`   | Low accuracy                                  |
| `10`  | Additional chart information                  |
| `11`  | Shallow-water pattern                         |
| `12`  | Overscale warning                             |

Pin WMS version/CRS and layers/styles. EPSG:3857 avoids the WMS 1.3.0
EPSG:4326 latitude/longitude axis-order trap. Bound image dimensions and requests;
retain copyright and chart-update metadata. The service describes weekly Friday
updates with possible downtime. [NOAA's official GIS services page](https://nauticalcharts.noaa.gov/data/gis-data-and-services.html)
and [viewer announcement](https://www.nauticalcharts.noaa.gov/updates/noaa-releases-new-navigational-chart-viewers/)
establish this service path. The [official FAQ](https://nauticalcharts.noaa.gov/learn/faq.html)
states that the viewer/chart-display images are not suitable for navigation;
label the GEV depiction accordingly rather than claiming certified navigation.

Do not restore old RNC tile URLs. NOAA
[retired the RNC tile/viewer service in 2021](https://nauticalcharts.noaa.gov/updates/coast-survey-to-shut-down-the-raster-navigational-chart-tile-service-and-other-related-services/)
as part of its paper/raster sunset. New nautical work should use current ENC
products/services. NOAA's [data licensing policy](https://www.nauticalcharts.noaa.gov/data/data-licensing.html)
documents CC0 for acquired data and distinct attribution terms for contributed
data; retain source credits and product metadata rather than applying GEV's MIT
license to charts.

An actual extension GetMap request was also verified: WMS 1.3.0, EPSG:3857,
layers `0,1,2,3,4,5,6,7,8,9,10,11,12`, bounds
`-8500000,4680000,-8450000,4730000`, 256×256, transparent PNG. It returned
HTTP 200, Origin-echo CORS and a valid PNG signature, 20,128 bytes. This is one
bounded Chesapeake-area response, not whole-coverage or browser acceptance.

## FAA provenance and edition handling

The [FAA data portal](https://www.faa.gov/data/aero_data) links the official
Aeronautical Data Delivery Service. The chart item records are owned by
`AeronauticalInformationServices_FAA`, marked public, and specify public use plus
the need to monitor chart alerts/notices:

- [VFR Sectional item](https://www.arcgis.com/home/item.html?id=6ab79dc5de5743adb3e3b6e3c803aa59).
- [IFR Area/Low item](https://www.arcgis.com/home/item.html?id=97ab03c55bb442b897daeba53a5cc85d).
- [IFR High item](https://www.arcgis.com/home/item.html?id=0cb4491ce486481e9d81de2234b13332).

[FAA VFR downloads](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/)
and [IFR downloads](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/ifr/)
provide authoritative georeferenced products and edition schedules. The review
date's current download cycle was September 3, 2026, with October 29 next; the
sectional metadata also identified the September 3 update. Do not hard-code that
date as future freshness. Show each integrated service's own edition/metadata
and keep the chart-legend/alerts links. Insets and coverage vary; HTTP 200 service
metadata is not proof that every coordinate or zoom has chart pixels.

## Esri lifecycle and use constraints

Esri's [current retirement announcement](https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/announcements/sunsetting-legacy-basemaps)
states that legacy raster basemaps have not been updated since 2021 and schedules
World Topographic Map/World Terrain Base retirement for December 2029.
World Navigation Charts retires March 2028 without a replacement; it is not a
substitute for the current FAA services above. Keep mature/retirement status
visible in the catalog and plan a modern provider alternative.

Esri [requires attribution](https://doc.arcgis.com/en/arcgis-online/reference/display-copyrights.htm)
and [item-specific terms](https://doc.arcgis.com/en/arcgis-online/reference/access-use-constraints.htm).
Do not infer unlimited commercial/offline redistribution rights from a keyless
URL. Modern ArcGIS basemap services have account/API-key requirements; offer
those only when operator configured. Preserve current Esri Satellite behavior
while adding optional reference maps with clear provenance.

## Implemented slice and next extensions

1. Implemented: the five existing quick map controls and Google 3D startup behavior remain.
   Add a grouped optional reference/chart selector backed by descriptors with
   stable ID, family, source type, coverage, min/max level, source/edition,
   attribution, terms link and lifecycle status. Never show an unconfigured
   paid/keyed provider as available.
2. Implemented: lazy, pinned ArcGIS raster and NOAA WMS factories preserve terrain,
   controller lifecycle, camera state and public/TAK layers. Test scale/coverage
   placeholders, image decoding, switch races, credits, fallback and no
   cross-provider request or resource leak.
3. Implemented: curated FAA/NOAA fixtures and separate bounded live checks.
   Test currentness metadata, map scale/axis order and correct chart placement;
   retain offline deterministic GEV/TAK browser gates. A fixture rendering pass
   does not prove live chart availability or navigational suitability.
4. Next: operator-configured WMS/WMTS/XYZ definitions through trusted configuration
   only. Use fixed source IDs and URLs, required credits/coverage/CRS/limits and
   explicit credential handling. Prefer direct CORS sources. If a server proxy
   is necessary, resolve an allowlisted ID to fixed upstream configuration,
   validate redirects/DNS and bound requests/caches; never accept a raw upstream
   URL from query strings, share links, browser forms or model/tool arguments.
   Signed/private credentials stay server-side. Do not introduce arbitrary
   plugins, remote executable style code or an unrestricted proxy.

The FAA adapter keeps Cesium's root minimum at level 0, reuses a decoded
transparent pixel below the service minimum and caps the advertised maximum.
Valid out-of-coverage HTTP 404 tiles are transparent; network/HTTP 5xx failures
remain errors and use the controller's existing OSM fallback policy after
three tile errors. A `NeverTileDiscardPolicy` prevents Cesium's automatic
missing-image probe at misleading metadata level 23 for FAA. Other ArcGIS
providers keep their normal missing-tile policy. Empty low-scale/coverage
areas expose the existing globe; no chart data is invented. Use the displayed
coverage/zoom hints. The charts do not add a new terrain-height model.

## Reproducing verification

Start the synthetic local app with `npm run tak:lab`, then use:

```sh
node scripts/qa-reference-maps.mjs --url http://127.0.0.1:4174
```

This hermetic gate uses the real UI, controller and Cesium providers with local
imagery/metadata fixtures. It checks all 30 existing GEV layers and a retained
synthetic TAK contact, the five original chips, eight optional selections,
credits, FAA request limits/transparent decoding, NOAA WMS parameters,
controller fallback and phone control size. `--fonts` explicitly permits
Google's font/CSS endpoints for manual screenshots; default network fixtures
remain deterministic. Evidence is written under `qa-artifacts/reference-maps`.

Two separate commands intentionally contact only the pinned public services:

```sh
node scripts/check-reference-map-services.mjs
node scripts/qa-reference-live.mjs --url http://127.0.0.1:4174
```

On 2026-10-16, the first passed all 8 metadata/image samples with decoded,
nonblank 256px images, checking real FAA min/max metadata and CORS headers.
The IFR samples use level 9 because valid lower overview tiles at the synthetic
Oxford MS location were transparent. The second passed actual Chromium/Cesium
FAA VFR and NOAA ENC image requests, browser CORS/canvas decoding, projected
tile bounds containing the synthetic Oxford/Chesapeake positions, and complete
NOAA 13-layer WMS 1.3 EPSG:3857 parameters. It permits at most 3 public requests per
source and opens a blank local module page; no tactical app state is involved.
Evidence is under `qa-artifacts/reference-map-services` and
`qa-artifacts/reference-live`, including a public-sample screenshot.

These checks establish their specific endpoints and rendering paths at the
recorded time. They do not establish all-region coverage, edition correctness
for a journey, service uptime, offline rights or certified navigation.

The eight curated sources and separate bounded USGS offline acquisition are
implemented. Operator-defined WMS/WMTS/XYZ configuration, other approved-source
acquisition and offline elevation remain future work. Service metadata
alone is not an acceptance pass; the bounded live and deterministic browser
checks above cover their stated scope.
