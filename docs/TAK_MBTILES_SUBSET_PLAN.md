# Bounded MBTiles area/zoom subsets

The bounded backend, portable record and phone controls are implemented on
`feature/tak-mbtiles-subsets`, with synthetic and retained-source browser
acceptance below. The real published
[NOAA check](TAK_MBTILES_NOAA_CHECK.md) rejected the complete 36,691,968-byte
archive at the unchanged 5,000-tile limit. A subset must not raise that limit or
make an oversized original file admissible.

## Smallest contract

Add one optional closed `selection: {bounds, minZoom, maxZoom}` to the existing
authenticated import-create JSON. Omission retains the existing whole-file
behavior. Reuse the portable Mercator planner and its 5,000-cell maximum for
the selected area/zooms. This initial conservative policy can reject a very wide
sparse selection whose theoretical grid exceeds 5,000 even if fewer tiles are
present; explain that refusal instead of raising a budget or scanning arbitrary
coverage to invent a preview.

The UI offers an unchecked-by-default **Limit import to area and zooms entered above**
checkbox, using the existing West/East/South/North and min/max zoom fields. The
existing **Use 10 km around map center** action can populate them. Do not label
that action as the current viewport extent. A later real-view-rectangle helper
would need to handle sky/undefined camera bounds; it is not necessary here.
Show the selected limits before upload and retain the existing per-file rights
assertion. Do not infer an AOI from the archive's `center` or a metadata URL.

The whole selected SQLite file still uploads through the same exact-length,
15-second/inactivity-bounded route and reserves its **entire original size**.
Named defaults stay 128 MiB/pack and 256 MiB/account; legacy defaults stay
512 MiB/pack and 2 GiB/store. Staging plus output and manifest allowances use
the same quota. A source exceeding its account's file limit still requires
producer-side preparation outside GEV. No partial database range fetching,
network source, automatic external converter or retained raw-file library is
needed.

## Bounded reader changes

Generate at most two X intervals per zoom from the validated planner, merging
low-zoom antimeridian overlap. Convert XYZ Y limits into inclusive TMS row
limits. Query each disjoint range with one fixed prepared statement:

```sql
SELECT zoom_level, tile_column, tile_row, length(tile_data),
       typeof(zoom_level), typeof(tile_column), typeof(tile_row), typeof(tile_data)
FROM tiles
WHERE zoom_level = ? AND tile_column BETWEEN ? AND ? AND tile_row BETWEEN ? AND ?
LIMIT ?
```

The six parameters fit the existing SQLite variable limit of ten. Never build
SQL from metadata, a supplied WHERE clause or a URL. Use a global remaining
inventory budget plus one overflow row across all ranges, not a fresh 5,000
allowance per range. Reject duplicates and invalid integer/blob types within
the selection. Merge overlapping ranges before querying; do not silently dedup
malicious duplicate database rows. The second payload pass uses the same ranges
and validates against the exact captured key/size inventory before emitting.

This works with flat tables and supported normalized `tiles` join views.
Indexes can make it cheap, but index presence is not a security guarantee:
views can defeat pushdown or force materialization. Retain the single killable
child, 30-second total wall deadline across **all** queries, 32 MiB SQLite hard
heap, 64 MiB V8 heap, authorizer, no extensions/attach/recursion, bounded IPC and
one active conversion. Do not grant each range a new process or deadline. A
valid but expensive archive may fail honestly. Existing unconfirmed-kill
quarantine, callback quiescence, cancellation and pinned continuation authority
must enclose the entire operation and final commit.

## Extents, notices and integrity

Only tile rows intersecting the selected area/zooms are normalized. Boundary
tiles remain whole 256-pixel images; this is tile selection, not pixel clipping.
Preserve exact sparse `plannedKeys`; missing keys stay transparent without an
online fallback. Handle crossing-antimeridian selections as two disjoint
longitude intervals. Derive a coverage envelope from the actual selected tile
intervals using the complement of their largest uncovered circular gap, with
world coverage represented explicitly. Do not use naive min/max longitude to
frame dateline-adjacent keys as almost the whole world. Keep the requested AOI
separately for initial camera framing when a low-zoom tile spans far beyond it.

Retain the original file hash/size and all original metadata, source notices,
projection/scheme, edition and permission assertion. Add a bounded optional
selection record to version 2 provenance; no need for a new container or job
framework. Original metadata zoom/bounds describe the **source**, so validate
their syntax/ranges but do not require them to equal the selected inventory's
min/max. Normalized manifest bounds/zooms describe the retained subset. Credits
must identify it as an imported subset, distinguish import time from source
edition, escape all supplied text and retain the complete notices in backups.
All existing saved-map disclosure guards run before showing/restoring it;
permission to retain an AOI does not authorize AI, sharing or recording.

SHA-256 remains computed over the entire uploaded file within its unchanged
byte cap. SQLite `quick_check` skips index/table consistency and UNIQUE checks,
so do not treat it as enough to trust an indexed subset's completeness. Use
`integrity_check(1)` for subset mode in the same killable worker and unchanged
deadline; this can refuse an otherwise valid expensive source, rather than
extend the budget. Whole-file legacy behavior remains unchanged. This check
does not verify origin/authenticity or foreign keys. There is no general SQLite
file CRC to claim. Validate selected PNG chunks/CRCs and bounded decompression or
JPEG structure exactly as today. Invalid coordinates/duplicate keys and image
contents **outside** the selection are not fully enumerated or decoded; do not
claim full-archive tile validation. Actual browser decode/pixels remain required.

## Required acceptance

- Whole-file imports and version 1 USGS behavior remain unchanged.
- Flat and normalized views return identical exact selected keys, including
  TMS inversion, boundary inclusion, sparse gaps, empty selection, multiple
  zooms and dateline/low-zoom overlap.
- One selected duplicate, invalid storage type, excessive selected rows,
  malformed raster or metadata still fails. Out-of-selection rows cannot
  increase memory, escape the SQL authorizer or reset the process deadline.
- Cross-join/materialized views, cancellation/expiry during successive ranges,
  logout/rotation before commit, disk failure, quotas and unconfirmed-worker
  cleanup remain fail closed. Full source and output are charged together.
- Backup/export/import preserves original metadata plus requested subset;
  selected-map rendering, true outage reopening, private disclosure protection,
  explicit deletion and notices are checked through the actual phone-sized UI.

Separately, an import-create response lost before the client learns its ID can
leave an awaiting-upload reservation until the existing five-minute expiry.
Small account-bound idempotent-create/recovery would improve retry UX later;
it should not become a generalized upload-resume framework or weaken quotas.

## Read-only source experiment

On 2026-10-17 at 03:59:50 and 04:00:16 UTC, Node 24.19.0 ran a scratch-only
variant of the existing hardened child against the **same retained file** from
the NOAA check. No second download or full-file copy occurred. Its only query
changes selected an explicit fixed range and stopped equating the source's
original 0–13 metadata to the subset's zoom; original metadata stayed intact.
It used the stronger `integrity_check(1)` and retained the existing 30-second
deadline, 32 MiB SQLite heap, 64 MiB V8 heap, 5,000-tile cap, authorizer, IPC and
PNG validation.

| Item                                                 | Observed result                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Requested AOI                                        | West −134.05, east −133.95, south 48.95, north 49.05                                          |
| Zoom                                                 | 10 only                                                                                       |
| Planner and retained key                             | Exactly `10/130/351`, original TMS row 672                                                    |
| Actual tile envelope                                 | West −134.296875, east −133.9453125, south 48.92249926375824, north 49.1529696561704          |
| Raster                                               | 256-pixel PNG, 3,836 bytes; CRC/structure/bounded inflation accepted                          |
| Tile SHA-256                                         | `f21d976514f8d8afaff2ac4481cc93f700d487ed78a31c53c1f1602845c3e5ac`                            |
| Worker duration including whole-file integrity check | 196–198 ms in these two local runs                                                            |
| Query plan                                           | Normalized `map`/`images` join using `map_index` for zoom/X range and `images_id` for tile ID |

The one derived PNG was opened locally: it decoded to sparse line/label imagery,
including a clipped Forster Seamount label. Source metadata identifies
`SG_AREA`, raster overlay, and a `ServiceArea` legend; empty attribution/credits
do not independently prove blanket rights or chart content. The original source
hash remains `33ed95c59b85514accbcb1deb8eb23f155d47a4b3c3e9a6ca88e70f9d98e616c`.
This establishes a small **research subset's** format compatibility, not whole
archive acceptance, geographic/edition correctness or implemented GEV subset
import/browser rendering. The observed 2024 source-date discrepancy remains.

Scratch code, selected-tile PNG and JSON evidence are local under ignored
`.gev-cache/noaa-mbtiles-compatibility/`. They are not shipped. All workers
exited; no listener, browser or retained server-store copy was started by this
experiment. It preceded the production implementation below.

## Implemented backend and focused evidence

Import creation now accepts the optional closed `selection` object above.
Whole-file omission and version 1 USGS behavior are unchanged. The request is
validated before job reservation and again before the worker starts; the parent
also rejects a worker key outside the selected plan. Full-file SHA-256 and byte
reservation remain in force. Version 2 provenance retains the requested
selection, original metadata and source hash; full manifests and bounded list
summaries expose the selected extent/zooms. The actual sparse tile envelope is
validated independently, including antimeridian wrapping. Latitude comparisons
allow only 1e-9 degrees for cross-engine transcendental rounding.

The child reuses one prepared six-parameter statement over disjoint TMS ranges,
with one global row allowance and unchanged process/heap/IPC limits. Selected
imports use the stronger whole-database integrity check. A real corrupt-index
fixture changes one valid index cell while leaving its table intact:
`quick_check(1)` still says `ok`, an indexed lookup silently misses the row, and
`integrity_check(1)` rejects it before import. This tests the actual SQLite file
format rather than substituting a success/failure response.

At this backend freeze, Node 24.19.0 passed **84 focused cases**, including
selected flat/normalized reads, original source metadata, multi-zoom and
dateline ranges, low-zoom overlap, empty/sparse selections, duplicate/malformed
rows, oversized potential grids, exact backups, quotas, paused-write revocation,
actual named HTTPS scope isolation and existing offline regressions. Node
26.7.0 passed **29 reader/import cases** through its built-in SQLite API,
including source-range contradiction checks added after the initial sweep.

The unmodified production reader then accepted the same retained NOAA file on
both runtimes: exactly `10/130/351`, PNG 3,836 bytes and the same tile/source
hashes recorded above, with original source maximum zoom 13 retained. Durations
including whole-file integrity check were 201 ms on Node 24 and 195 ms on Node
26 in these local runs. No second download or full source copy was used for
these reader checks. Evidence is retained under ignored
`.gev-cache/noaa-mbtiles-compatibility/production-subset-{24,26}.json`.

The source's observed 2024 dates remain explicit and unverified for current
navigation.

## Phone-sized browser acceptance

`node scripts/qa-mbtiles.mjs --subset` passed **6/6 production HTTPS/Chromium
cases** at 2026-10-17 04:16:03 UTC (Node 24.19.0, Chrome 152, 390-pixel
viewport). Its explicit subset UI retained three exact raster rows from a
four-row source; the out-of-zoom row was not copied. Original source zoom
metadata, whole-file SHA/size, source notices and the separate selection survived
server/device copy and a real closed-listener fresh-page outage. Existing pixel,
TMS, sparse-gap, cancellation, disclosure, 44-pixel control and scoped-logout
checks remained in force. The default command retains whole-file UI behavior.
The uploader's eight focused tests also passed, including a selection snapshot
that cannot change while the asynchronous file header is read.

A separate ignored scratch smoke then used the **same single retained NOAA
file**, through the actual file input, checkbox and area/zoom controls. It passed
**3/3 stages** at 2026-10-17 04:18:49 UTC: full 36,691,968-byte scoped HTTPS
upload, verified server/device copy of exactly `10/130/351`, actual Cesium canvas
rendering, then a stopped real listener and fresh-page saved-app/map reopening.
No second provider download occurred. The original `SG_AREA` name and source
0–13 zoom metadata, full source hash, requested AOI, subset label and explicit
May 2024/unverified-currentness notice remained available offline.

Actual retained tile textures were attached to four rendered geometry tiles;
the decoded image contained 127 colors and 382 dark line/label pixels. Both
online and outage screenshots visibly showed the curved service-area boundary
and clipped **Forster Se…** label, with blank coverage beyond the retained tile.
Screenshots and a bounded unobstructed crop confirmed visible ink against its
white raster background. Initial fresh offline camera framing used the requested
AOI center (−134°, 49°, approximately 13.7 km camera height), before the explicit
visual inspection view. All 30 GEV layers remained registered, terrain stayed
ellipsoid, no public fallback was requested, and private-map capture/sharing
remained blocked. Browser/server processes closed cleanly.

The first scratch attempt stopped at an overly broad direct framebuffer-count
assertion although its screenshot showed the curve. That failed measurement is
retained separately; the accepted run uses actual captured screenshot pixels
and matching retained imagery texture coordinates. The production renderer was
not changed for the probe. Accepted local artifacts are
`qa-artifacts/mbtiles-subset/results.json` and
`qa-artifacts/mbtiles-noaa-subset-accepted/{results.json,01-noaa-online-canvas.png,02-noaa-offline-canvas.png}`.

This source is the observed **SG_AREA service-area overlay**, not evidence that
every NOAA regional MBTiles package contains a current navigational chart.
The metadata/HTTP 2024 versus advertised weekly-update discrepancy remains
unresolved. No surveyed geographic correctness, operational route safety,
physical-phone storage/background behavior or native application acceptance is
claimed. The real-source smoke used a synthetic account and phone emulation.

Primary references: [MBTiles 1.3](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md),
[SQLite query planning](https://sqlite.org/queryplanner.html),
[SQLite security controls](https://sqlite.org/security.html),
[SQLite quick_check](https://sqlite.org/pragma.html#pragma_quick_check).
