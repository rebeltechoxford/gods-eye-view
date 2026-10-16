# God's Eye View × TAK implementation and acceptance plan

Updated: 2026-10-16. Work is integrated into `dev/tak-web-foundation` in
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

| Order | Deliverable                                | Completion criteria                                                                                                                                                                                                                                                    | Independent of live credentials?                                                    |
| ----- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1     | Reproducible repository baseline           | Fetch fork; inspect branch/PR state and instructions; preserve local changes; use supported Node and `npm ci`; record all gate results and environment.                                                                                                                | Yes                                                                                 |
| 2     | Audit and repair local prototype           | Strict numeric/coordinate/time/altitude handling, no ID collisions, bounded imports/state, time-driven stale cleanup, shared overlay text/navigation, deterministic teardown, keyboard/phone/embed behavior and private-data capture safeguards.                       | Yes                                                                                 |
| 3     | Secure gateway and bounded transport       | Disabled unless configured; authenticated same-origin browser session, fixed authorized server, verified mTLS, fail-closed authorization/UID ownership, bounded framing/queues/rate/clients, disconnect/cleanup/reconnect, no automatic network bridge or replay leak. | Yes, with local TLS fixtures; real server config remains separate                   |
| 4     | Genuine end-to-end exchange                | Operator creates and explicitly shares contact/marker; authorized real peer receives it; peer update returns correctly; inspect type/UID/time/stale/position; repeat rejection/disconnect cases. Record peer/server versions.                                          | Live acceptance requires authorized peers/server; local implementation/tests do not |
| 5     | Contacts, status, tracks and self position | Accurate identity/source/accuracy/freshness, bounded histories, correct stale/delete semantics, explicit foreground position broadcast, send/fail/unsent status and navigation handoffs.                                                                               | Mostly; peer interpretation requires live acceptance                                |
| 6     | Chat, recipients and groups                | Authentic sender, allowlisted group subscriptions/recipients, scoped replay/history, dedup/order, limits and truthful send/delivery states. Group revocation prevents future reads and writes.                                                                         | Mostly; real multi-peer acceptance remains required                                 |
| 7     | Shared drawings and routes                 | Focused editable objects with ownership/conflicts/deletes, compatible CoT representations and peer roundtrips; preserve existing GEV whiteboard and directions.                                                                                                        | Mostly                                                                              |
| 8     | Mission packages and attachments           | Safe manifest/archive import, authorized upload/download, hashing/limits/path validation, group scope and sync/conflict recovery; real-client package roundtrip.                                                                                                       | Mostly                                                                              |
| 9     | Coordinate and navigation tools            | Defined datum/units and supported formats, tested conversions and measurement/range/bearing, route/waypoint workflow; clear map-center versus GPS source.                                                                                                              | Yes                                                                                 |
| 10    | GPS/offline resilience                     | Permission/source/accuracy UI, bounded explicit retention/cache, restart/eviction/unsent/reconnect handling, approved offline maps; document foreground/background limits.                                                                                             | Mostly; device/browser tests required                                               |
| 11    | Supported video and sensors                | Named authorized transports/codecs/metadata with resource cleanup, privacy and access tests; native/hardware adapters only where required and verified.                                                                                                                | Fixture work yes; live integration needs authorized sources/hardware                |
| 12    | Versioned parity and release acceptance    | ATAK-CIV, iTAK and WinTAK each tested against the matrix; supported subsets, plugin gaps, hardware needs and remaining failures published.                                                                                                                             | No for peer/hardware acceptance; documentation remains independent                  |

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

Browser acceptance must use the production build through the supported preview
server and the existing browser. The repository's existing commands include:

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

| Area                  | Required scenarios                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser access        | Missing/wrong credentials, forged/missing Origin as applicable, refused protocol, session revocation, arbitrary browser-supplied upstream and cross-group read/write.                                                 |
| Identity and commands | Forged UID/callsign ownership, deletion/update of another principal's objects, group/recipient changes, imported content accidentally becoming outbound, replayed/duplicate commands.                                 |
| TLS                   | Trusted authorized client succeeds; untrusted CA, wrong server name, missing/invalid client certificate and expired certificate fail; no insecure bypass. Keep test keys synthetic.                                   |
| Malformed input       | DTD/entity, nested/oversized XML, invalid encoding/attributes, non-finite/out-of-range coordinates, timestamp abuse, stream fragments/coalescing/truncation and unsupported protobuf.                                 |
| Limits                | Bounded frames/events/contact history, per-session/link rate, connection count, slow browser/backpressure, replay/queue capacity and upstream flood. Refusal cannot crash the app or grow memory without bound.       |
| Recovery              | Upstream refused/offline, browser refresh, disconnect while write/capture is pending, bounded backoff, re-authentication, stale contacts, no silent resend/broadcast or cross-network bridge.                         |
| Lifetime              | Gateway shutdown closes sockets/timers/subscriptions; late callbacks cannot revive retired sessions. Browser destroy removes overlay/UI/geolocation/watchers and cancels focus/reconnect work.                        |
| Privacy               | TAK absent from AI image/structured requests, public MCP tools, HUD summaries, logs/analytics, links/scenes/exports and embedded handoffs. Exercise races during enable/disable/capture, not just empty steady state. |

## Evidence and integration record

The initial inventory is based on integration commit `aee71aba`. The handoff's
eleven parser/store passes are historical and narrow. The local
`feature/tak-foundation` gateway was unverified at intake. Audit found missing
server-side device/object authorization and unsafe interoperability claims.
The additive hardening now registers authenticated device identity, enforces
own-device/own-marker action policy and restricts browsers to one local operator
on direct loopback. Distinct users, roles and TAK Server groups remain planned.

The prototype audit also replaced native Cesium text with shared overlay cards,
added navigation ownership and timed stale refresh, repaired rolling chat and
geolocation cleanup, bounded transport/state and prevented implicit private-data
disclosure. The local lab starts an isolated synthetic peer and a transient
authenticated gateway without operational credentials or a LAN connection.
None of these changes establishes real ATAK/iTAK/WinTAK acceptance.

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
- Final full suite/build/browser results are recorded when their runs finish.

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

## Current external prerequisites

No authorized live TAK Server credentials, certificate material or real-client
devices are established by this inventory. These constrain only live-server,
peer and hardware acceptance. Local protocol, gateway TLS/auth failures,
privacy, lifecycle, browser operation and the existing GEV regression work can
continue without them. Do not contact arbitrary systems to fill the gap.

The final handoff must include a Markdown run guide that works for the verified
local configuration and a separate Markdown remaining-work list. Explain which
features work locally, how to observe actual gateway/peer state and which live
credentials or hardware are truly needed. Do not require the operator to relay
routine progress between coding agents or treat missing third-party setup as
proof that completed local work failed.
