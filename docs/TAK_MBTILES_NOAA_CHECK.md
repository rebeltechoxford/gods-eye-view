# Bounded NOAA MBTiles compatibility check

On 2026-10-17 at 03:39:58 UTC, one file was downloaded from NOAA's official
[NCDS MBTiles distribution](https://distribution.charts.noaa.gov/ncds/index.html):
[ncds_21.mbtiles](https://distribution.charts.noaa.gov/ncds/mbtiles/ncds_21.mbtiles).
The downloader allowed only this exact HTTPS URL, rejected redirects, capped
bytes at 64 MiB and used a 90-second deadline. No other package, public bulk
tile acquisition or operational TAK system was contacted.

| Observation                 | Result                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| HTTP response               | 200; `Content-Type: application/vnd`                                                                                |
| Declared and received bytes | 36,691,968                                                                                                          |
| SHA-256                     | `33ed95c59b85514accbcb1deb8eb23f155d47a4b3c3e9a6ca88e70f9d98e616c`                                                  |
| HTTP Last-Modified          | `Tue, 28 May 2024 21:43:54 GMT`                                                                                     |
| Official metadata           | `name: ncds_21`, `date_creat: 05 28 2024, 17:43`, `size: 34.99`                                                     |
| Internal declared metadata  | `name: SG_AREA`, `format: png`, zoom 0–13; bounds −138.092778, 44.700833, −129.917222, 52.489722; empty attribution |

The [official metadata query](https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/ncds_tilecache_metadata/MapServer/0/query?where=1%3D1&outFields=name%2Cdate_creat%2Cbaseline%2Csize&returnGeometry=false&f=json)
advertised that package and date. The distribution page described weekly
baseline updates when checked. The observed package's metadata and HTTP date
are from May 2024; this check does not reconcile that discrepancy or establish
current chart editions, effective dates or navigation suitability. NOAA's
[source licensing guidance](https://nauticalcharts.noaa.gov/data/data-licensing.html)
also distinguishes Coast Survey data from external contributors' conditions;
retain the original notices rather than infer one blanket license.

## Actual unchanged importer result

At 03:41:15 UTC, Node 24.19.0 ran the committed `7347855f` reader against this
exact file, using its normal read-only SQLite controls, 30-second process
deadline and unchanged 5,000-tile cap. It rejected the file in 152 ms with:

```text
MBTiles has duplicate coordinates or exceeds 5000 tiles
```

The actual server-store import path then staged the same file with the existing
named-account limits (128 MiB/pack, 256 MiB/account, one tile worker). It reached
the same rejection, reported a failed job, retained **zero packs**, and released
its input/output reservations. The fixture prohibited metadata/source URL or
USGS fetches. The temporary server store was closed and its empty directories
removed through the normal bounded cleanup path.

A separate scratch-only diagnostic used the same reader's fixed SQL,
authorizer, heap limits and maximum 5,001-row inventory. It changed only the
composite error wording and printed selected declared metadata. The inventory
reached row 5,001 after 5,000 distinct coordinates, confirming that the row cap
was reached. It did not count the whole archive or continue image decoding.
PNG is therefore a **declared** format here; this was not an accepted/decoded
NOAA chart rendering test.

The whole published package is unsupported by this bounded slice. An approved
producer-prepared archive within the existing limits would require its own
validation and browser acceptance. This check did not crop the package, raise a
limit or add NOAA URL downloading to the application.

The single original file, response summary, official metadata snapshot and
compatibility results remain local under ignored
`.gev-cache/noaa-mbtiles-compatibility/`; no chart binary was committed. This
evidence is separate from synthetic importer tests, browser rendering,
physical-phone persistence and any certified navigation claim.
