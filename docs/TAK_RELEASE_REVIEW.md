# Integrated TAK release review — 2026-10-18

## Candidate and authorization

Repository: `rebeltechoxford/gods-eye-view`. The user authorized verified
integration into `dev/tak-web-foundation` and then `main`. Preserve at least
69% account usage remaining; at most eight agents. Four agents were active.
No operational service, physical receiver or native TAK client was connected
by this review. Private Sites publication is a frontend preview only.

- Claude PR #13 original head: `d98137da502d729e357c122200f0050d3b0f6f93`.
- Development base: `28eb0c9e8e40456546b8dd5f01e25015ee54ea80`.
- MBTiles subset PR #12 head: `4ea69ba4fec9aa8a03998b3290c6ffa7b9f1023d`.
- Preserved device-stream work: `65be70ee`.
- Trusted upstream policy revision: `93ea088f4556a5a65b3292a2d15142d5a6c562bc`.
- Final tested candidate: `9d1e23ce`.
- PR #13 development merge: `12af6161a6baefff3ddf4be77d4f54167dda5a81`.
- Verified identical candidate/merge tree: `a2ed225f3cf4bf7dcb02e13d03686e365a34b3bf`.

The integration preserves contributor commits and adds separate review fixes.
Documentation conflicts preserve both subset downloads and Claude's features.
Server-link and UI conflicts retain both protobuf negotiation and bounded
presence-owned streams. Existing worktrees, stash and phone-test edits remain.

## Findings corrected

- Bound negotiation controls before decoding and correlate response UIDs.
- Prevent online routing after a covered offline-pack failure; bound derived
  index/heap allocations and cancel retired workers/download transactions.
- Stop owned open streams and media when pausing app requests; require saved
  worker confirmation, block cold-start worker egress and preserve shell icons.
  EMCON cannot establish complete device network or radio isolation.
- Expire weather after failed refreshes, reject invalid radar geometry and
  decode partial validity dates across day/month boundaries.
- Distinguish airband carrier frequency from 8.33 kHz channel labels.

## Validation record

Historical evidence is not acceptance of this combined tree:

- PR #13 CI run `39163287486`: all five original jobs passed at its original head.
- PR #12 run `39002517420`: ordinary checks passed; named-operator browser gate
  timed out waiting for saved-map readiness. This historical failure required
  a successful combined-candidate rerun before integration; final CI passed below.
- Device-stream focused run: 86 tests previously passed. Official-server rapid
  same-UID replacement evidence remains incomplete; streams stay opt-in.
- Combined candidate `c174e8df`: all five ordinary CI jobs passed in
  [run 39168092428](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39168092428).
  The restricted run passed setup, adopted formatting, package boundaries,
  layer-token checks, 7,026 ordinary tests (one existing skip), all 14 allocation
  checks, production build and six offline-road browser scenarios. Seven EMCON
  scenarios passed, but two unhandled Cesium request rejections failed its final
  error assertion. This was a failed run, not release acceptance.
- Diagnostic candidate `a8608882`, restricted
  [run 39169076711](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39169076711):
  all the preceding non-EMCON checks passed again, plus six FIS-B and twelve
  protobuf synthetic TAK browser scenarios. Both EMCON rejections occur only
  during saved-app cold reload. Strict page-error assertions remain in place.
  Ordinary CI's Street Level job failed during Puppeteer's browser installation
  (unsettled top-level await), before application execution; the previous job
  passed. The final normal-CI rerun below passed all five jobs.

The restricted workflow records the exact tested revision, tests, build hashes
and browser evidence, and reuses one production build. Tracking regression uses
the existing synthetic Vite lab and deterministic public-provider fixtures.

Runtime candidate `3d762106` passed all five ordinary jobs in
[run 39170222907](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39170222907).
Restricted [run 39170222903](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39170222903)
passed 7,027 ordinary tests (one existing skip), 14 allocation checks, setup,
formatting, boundaries, layer tokens, build, six offline-road scenarios, seven
EMCON scenarios including the strict error assertion, six FIS-B scenarios and
twelve protobuf TAK scenarios. Waiting for the worker acknowledgement corrected
the cold-start errors. The added tracking gate passed 107 checks but failed three
ground-corridor checks because its new offline responder supplied `{}` instead
of the terrain-height API's typed results. The corrected fixture and all tracking
assertions passed in the final run below.

Final candidate `9d1e23ce` passed all five normal CI jobs in
[run 39171560424](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39171560424).
Restricted [run 39171560421](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39171560421)
completed successfully: 7,027 ordinary tests passed with one existing skip,
14 allocation checks passed, and setup, formatting, boundaries, layer tokens
and production build passed. Browser acceptance passed six offline-road,
seven EMCON including strict page-error assertions, six FIS-B and twelve
protobuf TAK scenarios. Tracking passed all 111 checks with zero failures and
zero skips, including ground corridors using actual DEM batches.

PR #13 merged into `dev/tak-web-foundation` as
`12af6161a6baefff3ddf4be77d4f54167dda5a81`. Its tree
`a2ed225f3cf4bf7dcb02e13d03686e365a34b3bf` exactly matches tested `9d1e23ce`.
This accepts the combined candidate with the limitations below; the earlier
failed runs remain part of the record.

The host has WSL1 without usable network namespaces. Runtime review therefore
uses a disposable GitHub Ubuntu VM with Bubblewrap, private home/tmp, scrubbed
environment and loopback-only runtime networking. Dependency provisioning has
network access inside the filesystem/process boundary. Existing ordinary CI
remains required. SwiftShader browser evidence does not establish physical GPU
or iPhone performance, live-provider availability or native TAK interoperability.

## Remaining acceptance

The feature matrix distinguishes implemented workflows, hardware/companion
requirements and gaps. Physical iPhone installation/storage/restart/background
location, native TAK peers, real receiver feeds, current chart editions,
directed/group chat and durable server mission synchronization remain open.
See `../HOW_TO_RUN.md` and `../TAK_TODO.md` for operator and follow-up guides.

Release decision: the verified combined candidate is accepted and merged into
development. Release through [PR #6](https://github.com/rebeltechoxford/gods-eye-view/pull/6)
is the main release record. Do not represent this application as complete ATAK
parity or an operational aviation briefing.

## Private preview and native package

The [owner-private Sites preview](https://gev-tak-field-preview.jesselsullivan.chatgpt.site)
uses the key-free `3d762106` production artifact after verifying all
459 production file hashes. It hosts the frontend and download guides, not the
private Node gateway, raw TCP/TLS uplinks or receiver processes. Browser inspection
verified the local artifact's globe/TAK UI and the hosted ChatGPT access gate.
The application runtime is unchanged by the final `9d1e23ce` fixture/docs correction.
Build provenance: run `39170222903`, artifact `12152800329`; no provider keys.

The retained arm64 IPA from dev `28eb0c9e` has SHA-256
`e412622077b8fc56349bb2fb6ad3df60e0e064a0e0a464c0029cf12619e992b5`.
Native sources and the archive script are unchanged in this candidate; the
wrapper loads the current private web application. Personal signing and physical
iPhone acceptance remain required. No redundant native archive was built.
