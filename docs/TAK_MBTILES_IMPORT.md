# Local raster MBTiles import

This slice imports an operator-selected local MBTiles file into the existing
saved-map format. It adds no arbitrary URL downloader and never fetches URLs
from the file or its provenance. The existing pinned USGS download path and
version 1 manifests remain unchanged.

The integrated workflow includes the bounded backend/portable format, phone-sized
file controls, upload/conversion progress, cancellation, server-to-device copy,
private-map selection and retained offline reopening. The production Chromium
acceptance below uses synthetic operator-owned rasters. Physical iOS/Android
storage, restart and field acceptance remain unverified.

## Accepted input

- A standalone, checkpointed SQLite MBTiles file, at least 100 bytes and within
  the account's existing pack limit. A WAL-dependent database must first be
  checkpointed by its producer; the server does not open neighboring files.
- Flat `metadata`/`tiles` tables or a bounded normalized `tiles` join view using
  SQLite core features. Virtual/shadow tables, recursive views, writes,
  extensions and attached databases are rejected.
- Web Mercator raster tiles, exactly 256 × 256 pixels, PNG or ordinary 8-bit
  baseline/extended-sequential/progressive JPEG. Tile zooms are integers 0–23.
  MBTiles TMS rows become XYZ using `y = 2^z - 1 - tile_row`.
- At most 5,000 unique tiles, each at most 2 MiB. Metadata is UTF-8, at most
  64 entries and 64 KiB overall, with at most 16 KiB per value. Required `name`
  and supported `format` metadata must exist. Declared zoom limits must agree
  with the actual inventory for a whole-file import. An optional bounded area/zoom
  subset must remain within the source's declared zoom range; its actual extrema
  may be narrower.
- The operator supplies a pack name, source title, license/permission notice,
  optional edition and informational HTTP(S) source URL, and explicitly asserts
  permission to copy and retain it. URL userinfo is rejected. This assertion is
  recorded as `operator-asserted`; the application has not independently
  verified the data's license or edition.

For a larger supported archive, enable **Limit import to area and zooms entered
above** and use the West/East/South/North and zoom fields. It is off by default.
The selected potential grid must fit the same 5,000-tile cap; sparse sources can
contain fewer actual retained tiles. Boundary tiles remain whole. The entire
original file still uploads, is hashed and counts against the same source/output
quota. Original metadata stays intact while `provenance.selection` records the
requested area/zooms; gaps stay blank. See [subset implementation and acceptance](TAK_MBTILES_SUBSET_PLAN.md).

Vector PBF, WebP, 512-pixel tiles, GeoTIFF, PMTiles, other projections and 3D
terrain are unsupported. Static PNG imports reject APNG and compressed ancillary
ICC/text chunks (`iCCP`, `zTXt`, `iTXt`) in this initial slice. PNG chunks and
checksums are checked, and image data inflates only to its exact 256-pixel row
budget. JPEG markers, frame dimensions and scans are checked; this is not a full
JPEG entropy decoder. Actual browser decoding remains a separate acceptance
requirement. Rejected files can be converted by their producer to the supported
static raster form, subject to the original license.

## Portable retained format

Version 2 retains the common version 1 ready/partial state, IDs, bounds, zooms,
tile hashes, MIME and byte counts. It uses `sourceId: 'operator-mbtiles'` and an
explicit sorted `plannedKeys` array so sparse archives remain sparse. Missing
tiles stay blank; they never become a public fallback request.

`provenance` retains the original file SHA-256 and size, import time, original
CRS/scheme/tile size (`EPSG:3857`, `tms`, 256), permission assertion, source
title, license notice, edition and bounded original metadata. Original metadata
and notices survive validated `.gevmap` export/import. It is inert text; source
URLs are not navigation/fetch instructions. Cesium HTML credits escape every
supplied field. Credits say **Imported** and show edition separately; import
time is not the original survey date, acquisition date or chart effective date.

The existing device copy, verified tile reader, backup codec and local-only
imagery provider accept both versions. Imported maps use flat ellipsoid terrain
and the existing owned provider lifecycle. A complete import remains ready on
restart. If retained tiles are missing/corrupt, the library reports partial and
requires reimporting the original MBTiles file; it cannot repair these tiles
through USGS or a provenance URL.

All saved-map workflows are conservatively private already. UI actions mark the
viewer private before source registration/selected-ID changes/rendering, and
startup restoration marks it before creating the local source. Version 2 must
retain these guards. Permission to retain a map does not authorize AI/voice
screenshots, public sharing/export or recording; the separate page-memory
disclosure permissions still apply. Saved map files/backups are not encrypted
and browser profiles or host filesystem access remain part of the security
boundary. Account namespaces prevent accidental cross-account restoration;
they do not protect against another person controlling the same browser profile.

## Authenticated HTTP contract

All routes are beneath `/api/maps/offline` and use the existing private HTTPS
cookie wall. Named accounts also require their exact `X-TAK-Storage-Scope` on
every read and write; mutation Origin must exactly match the configured private
host. Dev/lab uses its existing guarded loopback Bearer token. No credential is
placed in a URL, manifest, child environment or returned job status.

| Request                    | Result                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /imports`            | JSON `{name,fileBytes,sourceTitle,sourceUrl?,license,edition?,authorized:true,selection?:{bounds,minZoom,maxZoom}}`; 202 with an `awaiting-upload` job. Request cap 16 KiB. |
| `PUT /imports/:id/file`    | Raw file, exact `Content-Length`, `Content-Type: application/vnd.sqlite3`, no transfer encoding. 202 acknowledges complete staging; conversion continues.                   |
| `GET /imports/:id`         | Bounded state/progress: `awaiting-upload`, `uploading`, `validating`, `converting`, `ready`, `failed` or `cancelled`; ready includes `packId`.                              |
| `POST /imports/:id/cancel` | No body; stops the owned upload/worker, waits for its active parent write, then removes staging.                                                                            |
| `DELETE /imports/:id`      | No body; removes the transient job and its unfinished staging, 204. It does not delete an already committed pack.                                                           |

The existing `/packs` list and `/packs/:id` manifest/tile/delete routes handle
completed imports. List summaries omit sparse key lists and raw original
metadata; the authenticated full manifest retains the original notices.

The upload has the host's existing 15-second request deadline plus a five-second
inactivity timeout. Large files or slow links can therefore be rejected honestly
within the account's size cap. Unstarted uploads expire after five minutes.
There is one active upload/conversion per store and at most four transient job
records. Failed/complete records may be retired for a new import. Cancellation
and restart do not implement resumable byte uploads: reselect the original file.
Ordinary interrupted staging is discarded on startup; committed packs persist.

## Quotas and process isolation

The default limits remain 512 MiB/pack and 2 GiB/store; named-account defaults
remain 128 MiB/pack and 256 MiB/account. The entire declared SQLite source is
reserved before upload. Source plus normalized output, temporary writes and
manifest allowance count against the same existing quota while converting.
An otherwise valid large archive can be refused because both copies temporarily
need space. No route bypasses that bound or deletes an existing pack to fit.

SQLite is synchronous, so validation runs in one disposable Node child with a
30-second wall deadline and 64 MiB V8 heap. Its environment contains only Windows
system directory variables if required and its private temporary directory; it
inherits no tokens, credentials or Node options. SQLite uses read-only,
defensive/query-only/untrusted-schema controls, a 32 MiB hard heap cap, bounded
cache, no mmap, and an authorizer rejecting extension/write/attach/recursive
operations. Additional SQLite statement limits are used when the runtime exposes
them. Rows cross IPC one at a time with an awaited parent acknowledgement.

The parent checks cancellation and authorization before/after writes and before
atomic publication. It waits for actual worker exit **and** the current parent
callback to quiesce before removing staging. If termination cannot be confirmed,
the internal `MBTILES_WORKER_UNCONFIRMED` result quarantines the store: subsequent
imports are refused, staging/reservations stay charged, and a private marker
blocks automatic startup cleanup. The marker's owned PID is not returned over
HTTP. Host recovery must verify the old worker is gone before removing that
specific quarantined staging directory. A full disk can prevent the marker;
the running host still stays quarantined and recovery must inspect owned
processes before restarting. This branch does not claim a successful kill.

## Continuation authorization seam

`createOfflineMapsHandler({createContinuationAuthorization})` accepts a
server-only factory called after initial request authorization. It returns an
authorization callback for that one upload. The HTTPS implementation captures
the exact initial session ID/object, principal, configuration generation and
expected storage scope. It revalidates that original session and current enabled
principal generation/scope; a replacement cookie/account cannot adopt the job.
The loopback host pins its installation generation and initially accepted token.
This continuation does not replace socket/Host/Origin checks at request ingress.

The importer awaits callbacks and treats false, exceptions, rejected promises or
a 250 ms callback deadline as denied. A bounded monitor also stops an idle or
computing job after revocation. The atomic directory commit rechecks authority
after rename and rolls back unpublished output on revocation. No further awaited
operation separates the final authorization result from in-memory publication.

## Focused evidence and remaining acceptance

The focused tests use actual synthetic SQLite files, original raster fixtures,
temporary private stores and generated local HTTPS certificates. They cover flat
and normalized views, TMS inversion, sparse portable backups/notices, bounded
image decoding, malicious/corrupt databases, coordinate/metadata/tile/file limits,
quota accounting, atomic durability, restart, disk failure and cleanup.

They also cover actual HTTPS login/Origin/scope rejection, cross-principal
read/mutation denial, legacy single-operator imports, logout/account switch and
credential rotation during a paused background write, callback rejection/hang,
and revocation at ready-manifest commit. Deferred writes prove cancellation and
shutdown do not race cleanup. Injected child failure proves unconfirmed kills
quarantine rather than allowing another import. Slow partial JSON requests
spanning logout receive HTTP 401 and reserve no import/download job.

At backend source freeze, Node 24.19.0 passed **68 focused tests**: 34 new
portable/reader/import/HTTPS cases and 34 existing offline regression cases.
Node 26.7.0 also passed all **21 reader/import tests**, using its built-in
SQLite API. Package/import boundaries, scoped formatting and whitespace checks
passed. These tests are not a complete repository build or browser gate.

The final production HTTPS/Chromium phone gate passed **6/6 cases** on
2026-10-17 at 04:06:58 UTC (Node 24.19.0, Chrome 152, 390-pixel viewport), with
no recorded browser/interception errors. It used generated local certificates,
a named synthetic operator and an actual 638,976-byte file-input upload:

- Per-file rights were required before HTTP upload; controls retained 44-pixel
  touch targets. Authenticated, scope-bound transfer retained three exact tiles,
  the original SHA-256, complete notices and the app shell on device.
- Actual Cesium rendering produced 20 textured tiles and 4,096 decoded colors;
  pixel samples verified TMS north/south inversion and transparent sparse gaps.
  All 30 GEV layers remained present. An 8 KiB notice stayed complete in an
  opaque 342 × 160-pixel scroll region with keyboard access and nine unobstructed
  interior hit tests; the privacy hint wrapped within the phone panel.
- One actual cancel request waited for a paused backend tile write, preserved an
  existing ready map and required fresh file selection/rights. The real HTTPS
  listener then closed; a fresh page reopened the cached app and imported map
  while network connectivity still appeared available.
- Private-map selection and outage restoration kept AI/voice, sharing and
  recording permissions blocked; scene exports were refused. File/source fields
  and rights cleared before the actual scope-bound logout request.

Sanitized evidence is generated by `scripts/qa-tak-mbtiles.mjs`; this accepted run
is retained locally as `qa-artifacts/mbtiles-operable-credit-final/results.json`.
These synthetic pixels do not establish real chart freshness, geographic survey
accuracy, operational TAK interoperability or physical-phone acceptance. No bulk
provider acquisition, native application or physical phone was used for this gate.

Primary references: [MBTiles 1.3](https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md),
[Node 24.14 SQLite controls](https://nodejs.org/download/release/v24.14.0/docs/api/sqlite.html),
[Node 24.19 SQLite limits](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html),
[Node SQLite API](https://nodejs.org/api/sqlite.html),
[SQLite security guidance](https://sqlite.org/security.html),
[SQLite hard heap limit](https://sqlite.org/pragma.html#pragma_hard_heap_limit).
