# God's Eye View × TAK implementation and acceptance plan

Updated: 2026-10-17 UTC. Work is integrated into `dev/tak-web-foundation` in
`rebeltechoxford/gods-eye-view`; `main` is outside this work's execution authority.
The fetched/inspected starting checkpoint is
`aee71aba3e39f908c4df4cf797108ab472b9ee4d`. Local candidate code is evidence to
audit, not a dependency on another agent or a promise of completed features.

The target is a functioning web-native TAK application on GEV's existing
architecture. [TAK_FEATURE_MATRIX.md](TAK_FEATURE_MATRIX.md) is the capability
inventory and the source of truth for parity claims. Complete each practical
slice with tests, usable operator controls and a reproducible run path. Record
the remaining peer/service/hardware prerequisites explicitly.

## Invariants for every slice

- Preserve every existing GEV catalog layer, source, HUD/voice/camera workflow,
  scene, public share format, package export, credits and lifecycle contract.
  Feature unavailability remains visible rather than being hidden or simulated
  as success.
- Keep portable CoT/model code separate from DOM/Cesium and Node transports.
  Mount TAK through existing app construction/cleanup; use the shared navigation
  and world-overlay owners. Do not rewrite the globe or make TAK a replacement
  public-data catalog.
- Keep certificates/private keys and privileged credentials server-side and out
  of Git/bundles. Fixed configured upstreams, TLS verification and gateway
  authorization are mandatory. Client-visible filtering never grants access.
- Keep TAK state separate from public GEV state and all egress surfaces. No
  implicit screenshot, AI/voice, analytics, log, public tool, share-link, scene
  or export disclosure. Imports remain local unless the operator explicitly
  shares a selected object through an authorized action.
- Use synthetic fixtures and isolated local transports first. Label local
  acceptance, transport write, server acceptance and actual peer receipt as
  distinct results. Unsupported framing or feature families must be visible.
- Preserve lockfile/runtime policy and strengthen checks when fixing defects.
  No force-push, discarded local work, public deployment, paid service or
  unauthorized network connection is needed for the local slices.

## Ordered delivery

The requested map expansion is an additive workstream on this same full GEV
workspace: curated Esri/topo/terrain/ocean, USGS, NOAA ENC and FAA VFR/IFR choices,
followed by trusted operator-configured WMS/WMTS/XYZ. Preserve the existing five
quick controls and conditional Google 3D startup. Source verification, limits,
licensing and the implementation proposal are in [TAK_MAP_SOURCES.md](TAK_MAP_SOURCES.md).
Chart service metadata and a listed option do not by themselves establish live
rendering, coverage or navigation acceptance.

| Order | Deliverable                                | Completion criteria                                                                                                                                                                                                                                                    | Independent of live credentials?                                                                                      |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1     | Reproducible repository baseline           | Fetch fork; inspect branch/PR state and instructions; preserve local changes; use supported Node and `npm ci`; record all gate results and environment.                                                                                                                | Yes                                                                                                                   |
| 2     | Audit and repair local prototype           | Strict numeric/coordinate/time/altitude handling, no ID collisions, bounded imports/state, time-driven stale cleanup, shared overlay text/navigation, deterministic teardown, keyboard/phone/embed behavior and private-data capture safeguards.                       | Yes                                                                                                                   |
| 3     | Secure gateway and bounded transport       | Disabled unless configured; authenticated same-origin browser session, fixed authorized server, verified mTLS, fail-closed authorization/UID ownership, bounded framing/queues/rate/clients, disconnect/cleanup/reconnect, no automatic network bridge or replay leak. | Yes, with local TLS fixtures; real server config remains separate                                                     |
| 3a    | Internal HTTPS host and EUD session        | Serve production assets and established provider APIs through Node HTTPS; pinned private listener/origin, operator login wall, secure bounded sessions, logout/expiry revocation, no remote bootstrap/admin/MCP, bounded static serving and cleanup.                   | Local implementation/fixtures yes; issued device certificate, private routing and real-EUD acceptance remain external |
| 4     | Genuine end-to-end exchange                | Operator creates and explicitly shares contact/marker; authorized real peer receives it; peer update returns correctly; inspect type/UID/time/stale/position; repeat rejection/disconnect cases. Record peer/server versions.                                          | Live acceptance requires authorized peers/server; local implementation/tests do not                                   |
| 5     | Contacts, status, tracks and self position | Accurate identity/source/accuracy/freshness, bounded histories, correct stale/delete semantics, explicit foreground position broadcast, send/fail/unsent status and navigation handoffs.                                                                               | Mostly; peer interpretation requires live acceptance                                                                  |
| 6     | Chat, recipients and groups                | Authentic sender, allowlisted group subscriptions/recipients, scoped replay/history, dedup/order, limits and truthful send/delivery states. Group revocation prevents future reads and writes.                                                                         | Mostly; real multi-peer acceptance remains required                                                                   |
| 7     | Shared drawings and routes                 | Focused editable objects with ownership/conflicts/deletes, compatible CoT representations and peer roundtrips; preserve existing GEV whiteboard and directions.                                                                                                        | Mostly                                                                                                                |
| 8     | Mission packages and attachments           | Safe manifest/archive import, authorized upload/download, hashing/limits/path validation, group scope and sync/conflict recovery; real-client package roundtrip.                                                                                                       | Mostly                                                                                                                |
| 9     | Coordinate and navigation tools            | Defined datum/units and supported formats, tested conversions and measurement/range/bearing, route/waypoint workflow; clear map-center versus GPS source.                                                                                                              | Yes                                                                                                                   |
| 10    | GPS/offline resilience                     | Permission/source/accuracy UI, bounded explicit retention/cache, restart/eviction/unsent/reconnect handling, approved offline maps; document foreground/background limits.                                                                                             | Mostly; device/browser tests required                                                                                 |
| 11    | Supported video and sensors                | Named authorized transports/codecs/metadata with resource cleanup, privacy and access tests; native/hardware adapters only where required and verified.                                                                                                                | Fixture work yes; live integration needs authorized sources/hardware                                                  |
| 12    | Versioned parity and release acceptance    | ATAK-CIV, iTAK and WinTAK each tested against the matrix; supported subsets, plugin gaps, hardware needs and remaining failures published.                                                                                                                             | No for peer/hardware acceptance; documentation remains independent                                                    |

Order 4 is the first network acceptance milestone. Do not postpone authorization
or privacy behind additional collaboration features. Implement browser workflows
progressively without claiming complete ATAK parity or interpreting a mock peer
as a field test.

## Baseline and regression gates

Use the runtime declared in `package.json`: Node `>=24.14.0 <25` or
`>=26 <27`. Install from `package-lock.json`; retain the recorded Node/npm
versions. The checked-in CI exercises Node 24.14.0 and 26.x on Linux and a
Windows onboarding path.

```sh
npm ci
npm run doctor -- --json
npm run format:check
npm run check:boundaries
npm test
npm run build
npm run build:panel
```

For a PR that changes shared layer serialization, run
`npm run layer-token:check -- --base-ref origin/main` as CI does. TAK should not
consume public layer/share tokens simply to persist private contacts.

Browser acceptance uses the production build through the supported local preview
for legacy GEV gates, and `npm run tak:serve` for private HTTPS/EUD hosting. Vite
dev/preview is not the production internal host. Existing commands include:

```sh
npm run qa:street-level:fixtures -- --strict --url http://localhost:4173
npm run qa:panel-resize -- --url http://localhost:4173
npm run qa:map-source-tray
npm run test:track
```

The map-source tray uses `QA_BASE_URL` for a non-default URL. Inspect each
script's supported options and prerequisites before invoking it.
Street Level fixtures need the documented dummy Mapillary token at build/preview
time; a dummy token must never be sent to the real provider. Tracking or live
voice checks may depend on providers/credentials; record skips precisely.
When voice wiring changes, run both recorded-audio modes documented in
[VOICE-OWNERSHIP.md](VOICE-OWNERSHIP.md) when configured. Run targeted tests
while developing, then the required repository gates on the final revision.

For new TAK browser coverage, exercise import, rejected input, marker creation,
roster focus while another camera owner is active, private-data isolation,
clear/disconnect/reconnect, narrow panels, keyless startup and app teardown.
Include embedded/MCP panel startup; private network controls should be unavailable
there unless explicitly authenticated and intended. Retain screenshots/logs as
local synthetic evidence, excluded from Git when they contain private data.

## Gateway negative and resilience acceptance

| Area                  | Required scenarios                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser access        | Missing/wrong credentials, forged/missing Origin as applicable, refused protocol, session revocation, arbitrary browser-supplied upstream and cross-group read/write.                                                                                            |
| Internal HTTPS host   | Real TLS login/cookie/WSS, pinned Host/Origin and actual private socket, refused public/wildcard/proxy access, 2 KiB login and rate/session limits, cookie logout/expiry, source-map/traversal/symlink rejection, protected existing provider APIs and shutdown. |
| Identity and commands | Forged UID/callsign ownership, deletion/update of another principal's objects, group/recipient changes, imported content accidentally becoming outbound, replayed/duplicate commands.                                                                            |
| TLS                   | Trusted authorized client succeeds; untrusted CA, wrong server name, missing/invalid client certificate and expired certificate fail; no insecure bypass. Keep test keys synthetic.                                                                              |
| Malformed input       | DTD/entity, nested/oversized XML, invalid encoding/attributes, non-finite/out-of-range coordinates, timestamp abuse, stream fragments/coalescing/truncation and unsupported protobuf.                                                                            |
| Limits                | Bounded frames/events/contact history, per-session/link rate, connection count, slow browser/backpressure, replay/queue capacity and upstream flood. Refusal cannot crash the app or grow memory without bound.                                                  |
| Recovery              | Upstream refused/offline, browser refresh, disconnect while write/capture is pending, bounded backoff, re-authentication, stale contacts, no silent resend/broadcast or cross-network bridge.                                                                    |
| Lifetime              | Gateway shutdown closes sockets/timers/subscriptions; late callbacks cannot revive retired sessions. Browser destroy removes overlay/UI/geolocation/watchers and cancels focus/reconnect work.                                                                   |
| Privacy               | TAK absent from AI image/structured requests, public MCP tools, HUD summaries, logs/analytics, links/scenes/exports and embedded handoffs. Exercise races during enable/disable/capture, not just empty steady state.                                            |

## Evidence and integration record

The initial inventory is based on integration commit `aee71aba`. The handoff's
eleven parser/store passes are historical and narrow. The local
`feature/tak-foundation` gateway was unverified at intake. Audit found missing
server-side device/object authorization and unsafe interoperability claims.
The additive hardening now registers authenticated device identity and enforces
own-device/own-marker action policy for one operator. Dev/lab stays on loopback;
the production Node host additionally permits an explicit private HTTPS listener
with a pinned authority and authenticated secure-cookie session. Distinct users,
roles were subsequently added in the named-operator milestone below. Broader
TAK Server membership and revocation acceptance remain open.

The prototype audit also replaced native Cesium text with shared overlay cards,
added navigation ownership and timed stale refresh, repaired rolling chat and
geolocation cleanup, bounded transport/state and prevented implicit private-data
disclosure. The local lab starts an isolated synthetic peer and a transient
authenticated gateway without operational credentials or a LAN connection.
None of these changes establishes real ATAK/iTAK/WinTAK acceptance.

The private host serves the existing built GEV app and preserves provider order
by installing established preview middleware without starting Vite. An operator
login protects static assets and every provider API. Credentials/private keys
stay server-side; `/api/setup`, `/mcp`, remote token bootstrap, public/wildcard
listeners and proxies are unavailable. Cookies are random, HttpOnly, Secure and
SameSite=Strict, memory-only, capped at 32 and limited to eight hours idle/total.
Private WSS always uses the revocable cookie session, even if a caller also
offers the valid operator token. That token cannot preserve a socket after
logout/expiry. Local real HTTPS/WSS tests cover this rejection, the login/body/
rate limits, protected provider APIs, PWA MIME, static exclusions, lifecycle
cleanup and certificate failures. A default-provider startup/shutdown smoke also
passed on loopback with temporary certificates and no TAK upstream. Final gate
totals are recorded by the final revision sweep; physical EUD and private LAN
acceptance remain open.

The contact store additionally bounds aggregate serialized payloads at 8 MiB and
retained XML nodes at 100,000, alongside the 2,000-contact limit. Accepted updates
evict the oldest nonself contacts as needed; an individually oversized update
does not mutate its prior contact, and self state cannot bypass the budget.
Extensions remain intact for interoperability. Resource accounting covers
update/delete/cancel/remove/sweep/clear/destroy, with a visible anonymous capacity
notice. Overlay snapshots cache unchanged immutable contact/card state while
preserving clock staleness, type/altitude/trail/emergency changes and cleanup.
The local 2,000-contact Chromium stress fixture confirmed bounded overflow,
150 roster rows, all 30 GEV registrations and teardown without render errors;
one-contact updates dirtied one entity after caching instead of 2,000. Initial
concurrent SwiftShader runs had inconsistent frame intervals, so matched
frame-time comparison and physical EUD performance remain open acceptance work.

### Reproduced intake baseline, 2026-10-16

The intake run used supported Node 26.7.0, npm 9.6.6 and the machine's older
Git 2.24. Evidence was captured before correcting the confirmed TAK defects.

| Gate                           | Intake result and interpretation                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Locked installation            | `npm ci` passed.                                                                                                                                                                                                        |
| Production build               | `npm run build` passed.                                                                                                                                                                                                 |
| Existing tracking browser gate | `npm run test:track`: 109 passed, 0 failed, 0 skipped.                                                                                                                                                                  |
| Adopted formatting             | Failed on five TAK files; confirmed formatting debt, not waived.                                                                                                                                                        |
| Boundaries                     | Failed on TAK ownership/import integration; corrected by explicit architectural ownership rather than bypassing the gate.                                                                                               |
| Full unit suite                | 6,342 tests: 6,312 passed, 20 failed, 10 skipped. Eighteen failures involved fixture Git operations on Git 2.24, one exposed the real native-label policy defect, and one exposed a cross-platform fixture-path defect. |

Final verification uses supported Node 24.19.0 and modern bundled Git 2.53 to
exercise the fixture Git options as intended. The native-label defect and
portable fixture-path defect are repaired in source; the final suite result
must remain visible below before integration.

### Hardened local verification, 2026-10-16

- Gateway verification: 31 focused tests passed on Node 24.19.0, including real
  local HTTP/WebSocket/TCP/TLS sockets. The TLS cases accepted a trusted mTLS
  roundtrip and refused wrong CA, wrong hostname, expired server certificate,
  untrusted client and missing client certificate; queued CoT did not flush
  before TLS validation. Other cases covered identity/marker ownership,
  directed-chat denial, bootstrap Origin, control rate/size, backpressure,
  expiry and bounded/paced replay. Certificates/keys were temporary synthetic
  fixtures, not committed credentials or a real TAK Server.
- The first gateway-disabled TAK UI run reached ten passing product scenarios
  (all 30 GEV registrations, imports/invalid coordinates, markers, follow handoff,
  timed staleness/expiry, chat rollover, privacy, phone/embed and cleanup) before
  a development-server reload interrupted its final error read. This interrupted
  run is not the final browser pass; rerun with stable source/HMR disabled.
- Final TAK browser run: `node scripts/qa-tak.mjs --url
http://127.0.0.1:4176 --lab --fonts` passed all 12 scenarios at
  `2026-10-16T18:40:19Z`, Windows, Node 26.7.0, Chrome 152.0.7977.75. It verified
  all 30 GEV registrations; actual import/invalid-coordinate controls; local
  and disconnected marker state; stable keyed roster nodes during a physical
  pointer-down/update/pointer-up; follow release and safe completed camera
  focus; real clock-driven stale presentation/expiry; rolling 500-message chat
  at message 501; share/scene disclosure guards, authorization/revocation and
  sticky hide/clear policy; explicit bootstrap; a marker correction returning
  through the actual local TCP peer with the same UID and network origin; and
  returned synthetic peer chat. Phone bounds, 44 px controls, 16 px form text,
  sticky header, embedded isolation and teardown passed, with no uncaught
  browser/promise/Cesium render errors.
- Local evidence: `qa-artifacts/tak/results.json`, `desktop-private-tak.png`,
  `desktop-lab-return.png` and `phone-tak.png`. All three captures reported
  imagery ready, bloom off and actual icon fonts loaded; pixels were inspected.
  Public APIs/imagery were synthetic/intercepted, the repeated map texture was
  bundled Natural Earth, and only Google CSS/font origins were allowed through
  `--fonts`. This validates tested presentation and local transport, not
  geographic imagery fidelity, real phone GPS/background behavior, all GEV
  features or real TAK interoperability.
- Earlier evidence attempts exposed missing font/tile fixtures, automatic Vite
  config restarts and an intermittent detached-roster-button click. The lab now
  disables watching/HMR for repeatable runs, the harness waits for actual fonts/
  imagery, and keyed rows plus an explicit 2000 m focus range repair the product
  interaction/camera defects. Final full suite/build results are recorded when
  their runs finish.
- Private production HTTPS/PWA acceptance at runtime checkpoint `5de0d82c`:
  `npm run qa:tak:private` passed all 12 scenarios at
  `2026-10-16T19:37:31Z`, Windows, Node 24.19.0, Chrome 152.0.7977.75. It checked
  native form login, credentialed manifest/worker, cookie-only identity ACK,
  phone controls and measured GPS freshness, explicit per-marker sharing,
  aggregate-capacity notices, a real loopback outage/same-port restart, logout
  revocation of an independent authenticated WSS connection, real connected and
  disconnected session expiry, and a labelled simulated initial-status401.
  Tactical state, consent, GPS and inputs were cleared before redirect; no app
  errors, tactical caches or fixture/credential persistence were found. The
  native-form run exposed and repaired the login document's no-referrer
  `Origin:null` incompatibility; strict Origin validation remains enabled.
  Evidence: `qa-artifacts/tak-private/results.json` and three numbered synthetic
  screenshots. Certificates were temporary, Chromium trust was pinned only to
  the synthetic leaf key, and public/provider requests were intercepted. This
  establishes neither real phone trust/GPS/background behavior nor real TAK
  peer interoperability.

### Frozen foundation release sweep, 2026-10-16

The runtime checkpoint is `5de0d82c`; `cc51688e` adds the final production
browser gate and evidence. Verification used Windows, Node 24.19.0 and Git
2.53. No operational TAK credentials or physical EUD were involved.

- Full `npm test`: 6,502 ordinary tests, 6,492 passed, 10 existing skips,
  zero failures; the separate allocation runs passed 1 + 13 tests. A prior
  loaded run failed the existing 40 ms CCTV idle-timer case; all 21 CCTV tests
  passed alone, followed by the successful complete rerun. Checks were not
  relaxed. Log: `.gev-cache/tak-release-tests-quiet.log`.
- Production build and `build:panel` passed. Existing large-chunk warnings
  remain visible. Formatting checked 1,381 adopted files; import/package
  boundaries and all 29 published layer tokens passed. `npm audit --omit=dev`
  reported zero vulnerabilities.
- The production HTTPS/PWA gate passed all 12 scenarios locally on Chrome
  152.0.7977.75 and again in Linux CI. It covers native login, protected
  manifest/worker, cookie-only identity acknowledgement, phone layout/GPS,
  explicit marker sharing, capacity notices, actual server outage/restart,
  independent socket revocation on logout, connected/disconnected expiry,
  clear-before-redirect and simulated initial HTTP 401 cleanup. Unrequested
  app/tactical persistence stayed absent.
- Fresh `qa:tak -- --url http://127.0.0.1:4174 --lab --fonts` passed all 12
  scenarios on Node 24.19.0, including the two-way synthetic TCP marker/chat
  path. The fixture explicitly rejects synthetic terrain to select the real
  ellipsoid fallback and uses the existing `b=0` view option for readable,
  stable captures. The initial screenshot-readiness timeout is retained in
  the failed-run logs; no application check was removed.
- PR #3 targets `dev/tak-web-foundation`. Its first CI run passed both Node
  matrix jobs, Windows onboarding and Street Level/panel gates; its TAK job
  passed the 12 HTTPS scenarios before the old screenshot fixture timed out.
  The corrected foundation gates later passed at `81b50adb`, and PR #3
  merged into `dev/tak-web-foundation` as `9edd6148`. `main` remains unchanged.

The curated-map browser gate subsequently passed all 13 scenarios on
2026-10-16 (Chrome 152), including all 30 layer registrations, the five original
quick-map identities, all eight added map/chart choices, real Cesium geometry,
coverage limits, source failures, credits and the phone selector. Desktop and
phone screenshots were inspected in `qa-artifacts/reference-maps-final/`.
The fixture now uses direct CDP Fetch routing: Puppeteer 25's interception
left Cesium module-worker imports pending despite successful script responses.
This changes only the test harness; application workers and CSP remain intact.
Unknown fixture requests still fail closed, and unexpected protocol failures
remain errors. Five focused tests cover routing, cancellation identity,
failure retention and explicitly owned browser teardown; they are included in
ordinary unit-test discovery. The corrected local TAK rerun passed its first
11 functional scenarios, then caught pending fixture requests after an
intentionally closed embedded page. Explicit helper disposal now precedes
that close. The final local reruns passed all 12 TAK scenarios and all 12
production HTTPS/session scenarios, with real globe meshes and expected fixture
teardown. Linux CI also passed the 12 HTTPS scenarios, then exposed a phone
resize measurement race in the TAK gate. The repair clamps to the real dynamic
viewport, listens to window resize with teardown, and tests stale visual
viewport and keyboard changes. Five mobile tests pass; the strict phone bounds
assertion remains. The final foundation CI passed before PR #3 was integrated.

### Final preservation checks, 2026-10-16

Locked development dependencies received compatible patches: `sharp` 0.35.4 →
0.35.5 with matching platform binaries and `@img/sharp-libvips-*` 1.3.4 packages,
and `source-map-js` 1.2.1 → 1.2.2, addressing the
[sharp advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) and
[source-map-js advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
Full `npm audit` after the update reported zero vulnerabilities on 2026-10-16
(`.gev-cache/security-patch-audit.json`). No major-version or declared-range
changes were made, and existing license fields and notices were retained.

- The combined offline app served at `http://127.0.0.1:4175` passed the existing
  GEV tracking harness: `node scripts/track-regression.mjs --url
http://127.0.0.1:4175` reported 109 passed, zero failed and zero skipped, with
  all 30 layer registrations retained. Log: `.gev-cache/offline-final-tracking.log`.
- A fresh synthetic 2,000-contact stress run against merged foundation
  `9edd6148` completed at `2026-10-16T21:20:36Z`, using Windows, Node 24.19.0 and
  Chrome 152 with headless SwiftShader. Updating one contact changed one entity
  in 6.2 ms; frame intervals had a 16.4 ms median and 234.8 ms p95. The roster
  stayed bounded at 150 rows, all 30 GEV layer registrations remained, clear
  removed all contacts/entities/overlay entries, and repeated destroy removed
  the TAK roots and overlay source without errors. Evidence:
  `qa-artifacts/tak/stress.json` and `.gev-cache/final-stress.log` in the original
  checkout.

These checks establish the tested preservation and cleanup behavior. Synthetic
providers and desktop SwiftShader timings do not establish physical-phone frame
performance, live public-layer behavior or real TAK-peer interoperability.

For each accepted slice, append a compact record with:

1. Revision, scope and feature-matrix rows affected.
2. Supported runtime/OS and exact commands or browser scenario.
3. Results, including failures, warnings, skipped provider/device checks and
   artifact paths when useful.
4. Real peer/server versions and authorized transport when tested; otherwise
   explicitly say local/synthetic only.
5. Remaining implementation work and external prerequisites, with next action.

Keep PRs focused. Use a feature branch, review the final diff and gate results,
then integrate verified in-scope changes into `dev/tak-web-foundation`. Retain
upstream compatibility and avoid merging into `main`. Remote CI results, when
available, supplement local evidence instead of replacing browser or live-peer
acceptance.

## Field workflow integration, 2026-10-17 UTC

The next additive slice provides three operator workflows within the existing
TAK panel: [coordinate/navigation tools](TAK_FIELD_NAVIGATION.md),
[local mission ZIP files](TAK_MISSION_PACKAGES.md), and
[correlated submission state](TAK_DELIVERY.md). The original 30 GEV catalog
registrations, map choices and navigation owner remain in place. The privacy
slice separates AI/voice, sharing/scenes and recording permissions; a selected
mission-package export has its own single-download consent.

The first combined full run on Windows/Node 24.19.0 reported 6,629 passes,
10 existing skips and one failure: a real-TLS rejection test expected an exact
30,000 ms queued-data timeout while using a moving wall clock. The transport
correctly subtracts elapsed time from that deadline. Verification uses an
injected queue clock while retaining real certificate/socket rejection and the
exact expiry/reconnect assertions. No transport timeout is relaxed.

Browser testing caught a real startup defect in the new coordinate module:
`mgrs` exposes different CommonJS and browser ESM exports. A namespace adapter
now supports both; the subsequent navigation gate passed all 13 scenarios.
Mission-package startup fixtures also wait for the actual initialized welcome
dialog before touching controls. Existing privacy/offline fixtures were updated
to exercise all three permissions and to distinguish a same-document map URL
update from the required login document transition. Their private-state,
HTTP401 and actual login assertions remain mandatory.

New navigation/package browser gates run in the existing private TAK CI job.
The run guide and remaining-work ledger now describe implemented local file
exchange and coordinate/submission behavior separately from server mission
sync, routes and genuine peer/device acceptance. Final combined command results
are recorded below. Product source was validated at `ae07782d`; merging the
verified privacy PR #7 (`9ca7bcf6`) added no further product diff. Final evidence
documentation is committed with this field-workflow integration.

| Gate                                    | Result and local evidence                                                                                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported runtime / setup               | Windows, Node 24.19.0; `node scripts/setup-doctor.mjs --json` ready. Provider keys remain unconfigured, so key-dependent live GEV sources are not claimed tested.                                                                               |
| Full test runner                        | `node scripts/run-unit-tests.mjs`: 6,631 ordinary passes, zero failures, 10 pre-existing skips, followed by all 14 serialized allocation passes. `.gev-cache/field-unit-verified.log`.                                                          |
| Formatting / boundaries / tokens        | 1,418 adopted source files; import directions, package ownership and published layer-token check against `origin/main` passed. All 30 runtime GEV layer registrations remain.                                                                   |
| Production / embedded builds            | `vite build` and `node scripts/build-panel.mjs` passed; existing large-chunk warnings remain. `.gev-cache/field-build.log`, `.gev-cache/field-panel-build.log`.                                                                                 |
| Dependency audit                        | Full locked dependency `npm audit --json` reported zero vulnerabilities. `.gev-cache/field-audit.json`.                                                                                                                                         |
| Synthetic TAK / disclosure / submission | 12/12 browser scenarios; actual TCP/WebSocket lab, visible correlated marker/chat status, no auto-send on Connect, scoped privacy, phone/embed and cleanup. `qa-artifacts/field-tak-final/`.                                                    |
| Phone coordinates / navigation          | 13/13 browser scenarios; four coordinate formats, actual camera ownership, fresh GPS versus operator/map origin, 44 px controls and cleanup. `qa-artifacts/field-navigation-final/`.                                                            |
| Phone mission-package files             | 8/8 browser scenarios; actual file selection, inspection, bounded stable selection, selected export/download, cancellation and cleanup. `qa-artifacts/field-packages-final/`. Independent Python ZIP/XML/hash checks also passed 36 assertions. |
| Private production HTTPS / session      | 12/12 scenarios; real loopback TLS/login/WSS, rejection, logout/expiry and cleared navigation/package inputs before departure. `qa-artifacts/field-private-final/`.                                                                             |
| Retained server/device maps             | 8/8 scenarios; actual server shutdown and fresh saved-app launch, decoded imagery/fonts, verified files/resume/deletion, actual HTTP401 and all three permissions cleared before login. `qa-artifacts/field-offline-final/`.                    |

All browser evidence uses synthetic contacts and local/intercepted providers.
It establishes neither current real-world chart editions nor physical-phone
performance or real TAK Server/ATAK/iTAK/WinTAK acceptance. Failed intermediate
runs remain in `.gev-cache/field-unit-final.log`,
`qa-artifacts/field-packages/` and the earlier privacy CI records; their causes
and corrections are described above rather than being counted as passes.

## Drawings and routes integration

The next additive slice implements actual `u-d-f` line/polygon and `b-m-r`
route geometry, a phone editor, ordered waypoint identities, local drafts,
explicit per-save sharing, immutable-source conflict checks and gateway-owned
updates/deletes. GEV whiteboard, public directions, camera gesture ownership and
all existing layers remain separate. Geometry is limited to 256 vertices per
object and 16,384 retained vertices across the contact store.

Focused local evidence: 64 geometry/client/store/renderer tests, 40 drawing/
gateway tests and seven real Chromium phone touch scenarios passed. The latter
cover dateline routes, stable edit/reorder, preserved waypoint notes and stroke
opacity, invalid mixed heights, polygon rendering, safe labels, update conflicts
and teardown. The full Node 24.19 Windows runner passed 6,669 ordinary tests
with ten existing skips, then all 14 serialized allocation checks. Production
and embedded builds, 1,430-file formatting, import/ownership boundaries and
published layer tokens passed. CI includes the phone drawing gate and an
expanded privacy reset check for real draft geometry and pending inputs.
Native-peer geometry acceptance, turn guidance and broader native shape types
remain open; see [drawing evidence](TAK_DRAWINGS_ROUTES.md).

The drawings milestone merged through PR #9 as development `3afdc368` after all
five repository jobs passed. All six checks on the development-to-main review
PR #6 subsequently passed, including the macOS iPhone archive/simulator job.
The review test-merge `cb65b392` has the same file tree as development; main
remains unchanged. The run guide links the independently hash-verified IPA.

## Named operator isolation

The private HTTPS host adds an optional closed-schema account file with up to
eight named principals and four sessions per principal. Each enabled account
has distinct pinned mTLS material, an independent gateway/router/replay/queue,
server-enforced operator or receive-only rights and its own bounded server map
directory. Legacy single-operator HTTPS and loopback lab configurations remain
available. Global server/mesh bridging is rejected in named mode.

The browser resolves authenticated account context before opening device map
storage or restoring identity. Named namespaces and explicit saved-app offline
approval prevent account mixups on network outage; HTTP authorization failures
never invoke that fallback. Cross-tab changes retire the old client, GPS,
private editor state and disclosures. Requests also carry expected context on
maps, saved-shell manifests, WSS and logout to cover shared-cookie changes
before a storage event arrives. Scope identifiers provide binding, not access
authority or encryption. Logout clears the page synchronously before dispatch;
an unconfirmed request leaves an explicit reopen/sign-in path.

Focused verification covers 59 server HTTPS/gateway/TLS cases and 116 browser
context/client/transport/session/PWA/offline/font cases using synthetic
identities. The dedicated production browser gate exercises actual loopback
HTTPS/WSS, separate mTLS connections, saved maps, account switching, receive-only
rights, real server outage and rejected access; its final run evidence and CI
results are tracked in [PR #10](https://github.com/rebeltechoxford/gods-eye-view/pull/10).
Actual TAK Server IN/OUT membership and revocation,
native directed-reply routing and physical EUD acceptance remain open. See
[account setup and security contract](TAK_MULTIOPERATOR.md).

The integrated application at `f3e7e773` passed the full local Node 24.19 Windows
runner: **6,721 ordinary passes**, ten existing skips, zero failures, then all
**14 allocation checks** (`.gev-cache/operators-unit-full.log`). Review also
fixed queued historical storage events retiring a newly authenticated matching
account, an expected expired-session redirect reported as a startup crash, and
undersized native login controls. The account-context regression file now has
35 passing tests, including genuine account changes and delayed old responses.
Production and panel builds, formatting, import/package boundaries and published
layer tokens passed. The production browser gate remains a separate acceptance
requirement. Its fixture handling requires exact Chrome request/document or
renderer-abort evidence before classifying a canceled request; unmatched IDs,
other frames and unrelated protocol failures still fail the gate.

## Official TAK Server core transport acceptance

The actual GEV gateway at `6c8a11a2` passed eight checks through official TAK
Server `5.7-RELEASE-14` core on 2026-10-17 UTC: verified mutual TLS and three
certificate rejection cases, web-protocol marker delivery, peer correction
back to GEV, broadcast GeoChat/reply and separation from an independently
configured server group. Peers were synthetic TLS clients. The server used a
documented loopback bind patch; its complete WAR build failed. Source hashes,
runtime versions, exact evidence, confinement and cleanup are recorded in
[real-server acceptance](TAK_REAL_SERVER_ACCEPTANCE.md). This advances server
transport acceptance without claiming native-client or stock-distribution
acceptance.

A subsequent real-server experiment found that one shared TLS stream maps only
its first endpoint UID. Separate device streams routed independently, but the
experimental `t-x-c-t` endpoint control entered latest-SA replay at its protocol
placeholder point. It must not become an implicit position-free registration
feature. Directed chat requires a reviewed device-routing and explicit-presence
design; broadcast remains the supported chat mode.

Named-account PR #10 merged as `8c96791c` after all five CI jobs passed. The new
PR #6 iOS job `38999554419` passed archive/payload/policy and iPhone 17 simulator
checks; test-merge `34edc257` has the same file tree as dev. The downloaded IPA
hash is recorded in the run guide. Fresh repository CI `38999554396` passed
Node 24, Node 26 and Windows, but the named-account browser gate failed with
unmatched `Fetch.fulfillRequest: Invalid InterceptionId` errors. That failure
is retained and under investigation; the earlier 28 local browser passes do
not erase it.

## Local MBTiles integration, 2026-10-17 UTC

The phone workflow now accepts an authorized local raster MBTiles file, retains
its original hash and source/license/edition notices, and creates private server
and device copies through the existing saved-map library. Uploads, SQLite work,
quotas and continuation authorization are bounded; cancellation waits for active
writes, and unconfirmed worker termination quarantines staging. Supported input
and exclusions are recorded in [the import contract](TAK_MBTILES_IMPORT.md).

The integrated Windows Node 24.19 runner passed **6,783 ordinary tests**, ten
existing platform skips, zero failures and all **14 allocation checks**. Setup
doctor, formatting (1,452 source files), import/package boundaries, published
layer tokens, production build and embedded-panel build passed. Local evidence
is in `.gev-cache/mbtiles-full-unit.log`, `mbtiles-format.log`,
`mbtiles-build.log` and `mbtiles-panel-build.log`. Existing large-bundle warnings
remain visible; no threshold was changed.

All **six** production Chromium phone scenarios passed after the final saved-map
credit fix: actual File/HTTPS import, source notices and server/device retention,
Cesium pixels/TMS inversion/sparse blank coverage, cancellation, real stopped-
server fresh-page reopening, and logout clearing private form data before its
request. The 390 × 844 viewport retained all 30 GEV registrations. The complete
long notice remains keyboard-scrollable and unobstructed, verified by nine
interior hit tests and screenshot review. These are synthetic Chromium results,
not physical-phone acceptance. `npm run qa:maps:mbtiles` now runs in CI.

The browser-fixture correction requires navigation initiation before a failed
interception and a matching successful document commit before retiring its old
request. Twenty-seven focused regressions include mismatched/late/unrelated
navigation failures; unmatched protocol errors still fail. The earlier candidate
passed all five jobs in [CI run 39000173643](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39000173643).
That run predates the complete UI and final causal correction; a fresh final-head
run is required before merging [PR #11](https://github.com/rebeltechoxford/gods-eye-view/pull/11).

A complete real NOAA MBTiles bundle exceeded the unchanged 5,000-tile cap. A
small read-only experiment extracted one valid tile under the same resource
limits, but production area/zoom selection is a separate increment described in
[the subset plan](TAK_MBTILES_SUBSET_PLAN.md). Neither test establishes source
currency, operational chart coverage, 3D terrain or a license to retain arbitrary
commercial map data.

## TAK protocol v1 lab run

TAK Protocol Version 1 (protobuf) receive on the mesh and opt-in TAK Server
stream negotiation are described, with scope and limits, in
[TAK_PROTOCOL_V1.md](TAK_PROTOCOL_V1.md). Recorded on 2026-10-17 UTC with Node
`24.14.0` on Linux x64:

- The codec decodes four payloads built by an independent Google protobuf
  `7.36.1` oracle from the published TAK descriptors, and re-encodes them
  byte-identically, including mesh and stream framing.
- Full unit suite: **6,857 passed**, one existing skip, zero failures (6,806
  before this change). Formatting, import/package boundaries, setup doctor, the
  layer-token check against `origin/main` and the production build passed.
- `npm run tak:lab -- --protobuf` with
  `npm run qa:tak -- --url http://127.0.0.1:4174 --lab --protobuf` passed all
  **12** Chromium scenarios (Chromium `141.0.7390.37`, 07:46Z). The gate
  requires the server uplink to report a negotiated `v1` encoding and the panel
  to show `TAK protocol v1`.
  The lab's marker correction and chat reply therefore crossed binary frames
  both ways through the real gateway. The same `--protobuf` gate against the
  XML-only lab failed at that wait, as intended.
- The official TAK Server 5.7 negotiation and conversion source was read and
  the codec aligned to it. That source was not built or run here.

These are synthetic results. Real ATAK-CIV, WinTAK and iTAK v1 mesh traffic and
a running TAK Server v1 negotiation remain open in [TAK_TODO.md](../TAK_TODO.md).

## Current external prerequisites

The official-source local server lab used fresh synthetic credentials; no
operational credentials or real-client devices are established by this inventory.
These constrain only operational-server, native-peer and hardware acceptance.
Local protocol, gateway TLS/auth failures,
privacy, lifecycle, browser operation and the existing GEV regression work can
continue without them. Do not contact arbitrary systems to fill the gap.

Private EUD acceptance additionally needs an issued HTTPS certificate trusted by
the actual phone, matching SAN/internal DNS, reachable private addressing and
device GPS permission. Test login, Connect, logout/expiry, foreground/background
behavior and authorized peer exchange on that device. No public deployment,
private LAN listener or device trust-store modification was performed by the
synthetic localhost tests. See [HOW_TO_RUN.md](../HOW_TO_RUN.md) for the explicit
server-side configuration and [TAK_TODO.md](../TAK_TODO.md) for remaining work.

The final handoff must include a Markdown run guide that works for the verified
local configuration and a separate Markdown remaining-work list. Explain which
features work locally, how to observe actual gateway/peer state and which live
credentials or hardware are truly needed. Do not require the operator to relay
routine progress between coding agents or treat missing third-party setup as
proof that completed local work failed.
