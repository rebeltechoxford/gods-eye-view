# Offline driving directions

Driving directions work with no signal once a road pack covering the trip is
on the phone. The router runs in the browser, so a trip inside an installed
pack never leaves the device: neither the private host nor any third-party
router sees it. Trips outside every installed pack, and walking or cycling,
keep using the existing online route proxy.

Scope: car routing only, from OpenStreetMap roads. This is route planning
(the route on the globe and its turn list), not live turn-by-turn navigation.

## Use it

1. **Build a pack at home** from an OpenStreetMap extract, for example the
   Geofabrik Mississippi extract
   (`https://download.geofabrik.de/north-america/us/mississippi-latest.osm.pbf`):

   ```sh
   node scripts/build-road-pack.mjs --input mississippi-latest.osm.pbf \
     --name Mississippi --out mississippi.gevroads
   ```

   `--bbox W,S,E,N` keeps only an area of a larger extract. Without it the
   pack covers the bounding box of the roads it kept. The builder writes the
   pack and its manifest, `<out>.json`, with SHA-256, size, coverage, OSM
   edition and ODbL attribution. It reads the extract once, streaming; the
   extract must be sorted by type then ID, which Geofabrik, OSM France and
   BBBike extracts are.

2. **Publish it on the private host.** Put both files in `GEV_ROAD_PACK_DIR`.
   The default is `gods-eye-view/road-packs` under `LOCALAPPDATA`,
   `XDG_DATA_HOME` or `~/.local/share`. The server lists only packs whose
   manifest validates and whose file is a regular file of exactly the stated
   size; symlinks, duplicates and file names never reach the phone.

3. **Install it on the phone.** Open **TAK → OFFLINE ROADS / ROUTING** and
   choose **Download to this device**. The download is resumable in 4 MiB
   chunks and is checked against the manifest SHA-256 before it is marked
   ready. On the built private HTTPS app the same action then saves the app
   for offline launch and approves offline storage for the signed-in account,
   as a saved map does. Without both, a cold launch with no signal has no app
   to open, or no account allowed to read the pack. The status line says
   whether this happened.

4. **Route.** Turn on Directions, choose Drive and place A and B. When both
   ends are inside an installed pack, the route is computed on the device and
   the summary ends in `· offline`. The pack's attribution is shown.

When several installed packs cover a trip, the smallest one is used. Packs
are stored per operator account in IndexedDB (`gev-road-packs-v1-<scope>`)
and are removed with **Remove**. The browser can still evict website storage:
keep the server copy and download again if a pack disappears.

## What the router knows

- Roads a car may use: motorway through service roads. Excluded: `area=yes`,
  `impassable=yes`, emergency-access and parking-aisle service roads,
  reversible or alternating ways, and access denied by `motorcar`,
  `motor_vehicle`, `vehicle` or `access` (most specific wins).
- One-way streets, including the implied one-way of motorways and
  roundabouts.
- Speed: 90% of a posted `maxspeed` (mph or km/h), capped at 130 km/h,
  otherwise a default per road class (105 km/h motorway down to 15 km/h
  living street). Times are estimates.
- Disconnected fragments under 50 junctions are dropped, so a trip cannot
  start in an isolated private lot. Each end snaps to the nearest road within
  2 km.
- The search is A\* on travel time with an admissible heuristic, so the route
  is the fastest under this model.

It does **not** know turn restrictions, turn or signal delays, live traffic,
closures, ferries, tolls, height or weight limits, or time-dependent access.
Check the route against the road in front of you.

A trip with one end outside every pack (Oxford to Memphis needs Tennessee)
goes online. If online routing is unreachable too, the error says to install
a pack covering the trip. There is no stitching across packs, so build one
pack covering every region a trip may span.

## Pack format and protection

`GEVROAD1` version 1 (`src/routing/roadPack.js`): a 64-byte header, JSON
metadata and typed-array sections for junctions, directed road segments,
shape points, road records and an interned string table. Decoding validates
every section size, offset, index, coordinate and UTF-8 string before use,
within fixed limits. The phone verifies SHA-256 at install and again on every
load, so a pack damaged in storage is refused rather than routed on. The
worker that decodes and routes is retired and replaced if it fails or does
not answer within 60 seconds.

Server API (session-authorized on the private HTTPS app, gateway token in the
local lab, rate limited, GET/HEAD only):

- `GET /api/routing/packs` lists validated manifests without file names.
- `GET /api/routing/packs/<uuid>` streams one pack, with `Range` support for
  resume.

Road data is © OpenStreetMap contributors under the ODbL. A pack is a derived
database: keeping it on your own host and devices is private use; publishing
it triggers the ODbL share-alike terms.

## Evidence

Measured on 2026-10-17 in the development container:

- **Mississippi pack:** built from the OSM France `us-south` extract with
  `--bbox -91.70,30.10,-88.05,35.05` (OSM edition 2026-10-17T00:27Z). Result:
  96.2 MiB, 876,340 junctions, 1,084,806 road segments, 212 s, 1.49 GB peak
  memory.
- **Correctness:** on that pack, A\* matched an exhaustive Dijkstra search on
  39 of 39 random trips. Oxford to Tupelo is 50 mi / 59 min, to Jackson
  161 mi / 2 h 43 min, to Gulfport 319 mi.
- **Cost on the device:** in Node 24 the pack decodes in 130 ms and indexes in
  640 ms. It holds about 150 MiB in the worker: the 96 MiB file as zero-copy
  views plus 51 MiB of indexes. Statewide routes take 50–210 ms.
- **Unit tests:** `src/routing/*.test.mjs` and
  `src/tooling/roadPack*.test.mjs` cover OSM tagging, the pack codec, the PBF
  builder (synthetic PBF), router correctness and one-way handling, turn
  phrasing, offline-first fallback, engine pack selection, damaged packs, hung
  workers, shared loads, and the server listing, ranges and refusals.
- **Browser, development lab** (`scripts/qa-offline-roads.mjs`, Chromium,
  every online router refused): install through the panel, drive on the
  device, walking refused with the offline explanation, reload and drive
  again.
- **Browser, built private HTTPS app with a real outage**
  (`scripts/qa-offline-roads.mjs --https`, 390 × 844 phone viewport): native
  login, install with the app saved for offline launch, then the server is
  stopped. A fresh page loads from the saved app (`fromServiceWorker`,
  `/api/tak/status` unreachable) and routes Oxford to Tupelo on the device in
  about 2 s.

Reproduce:

```sh
GEV_ROAD_PACK_DIR=<dir> npm run tak:lab
node scripts/qa-offline-roads.mjs --url http://127.0.0.1:4174

npm run build
node scripts/qa-offline-roads.mjs --https --pack-dir <dir>
```

Screenshots and `results.json` go to `qa-artifacts/offline-roads/` and
`qa-artifacts/offline-roads-https/`.

## Not yet verified

- A physical iPhone. Desktop Chromium does not establish iOS WebKit storage
  quota for a ~100 MiB pack, worker memory, or eviction. Install the pack and
  the offline app on the phone, enable airplane mode, relaunch from the home
  screen and route.
- Larger regions. The format limits allow far larger packs than a state, but
  phone memory sets the practical size. Measure before building multi-state
  packs.
- Turn-by-turn guidance while driving (position tracking, rerouting, voice)
  is not implemented.
