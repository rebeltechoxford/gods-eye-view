# GPT handoff — GEV / TAK / iLoader candidate

Updated 2026-10-29. Working branch: `feature/tak-completion-20261027`.

## Run it

Use Node 24.14+ within 24.x, or Node 26.x:

```sh
npm ci
npm run tak:lab
```

Open the local address printed by the lab on the same computer. The full GEV app
runs with an isolated synthetic TCP TAK peer. Open TAK and choose Connect; then
try a shared marker and chat. `npm run dev` starts the app without that peer.
Stop with Ctrl+C. [HOW_TO_RUN.md](HOW_TO_RUN.md) covers production gateway setup,
provider requirements, local storage and the existing tools.

On a Mac with Xcode 26, `bash scripts/build-ios-ipa.sh --smoke` builds the unsigned
device IPA. [docs/TAK_IOS_IPA.md](docs/TAK_IOS_IPA.md) explains iLoader installation.
The unsigned IPA contains no signing identity or operator credential. iLoader's
signing flow is separate from authentication to a GEV TAK gateway.

## Sources integrated

- Public upstream `bilawalsidhu/gods-eye-view` main at `f2c6ff08`, version 0.3.0.
- Fork release main `1138576c` / TAK integration `9d5f1ffb`.
- Claude location/follow/saved-start-view changes at `1f63a229`.
- `feature/tak-night-two` at `96de0906`: polar UPS navigation and explicitly
  retained historical TAK pictures, plus the corresponding location changes.

The public upstream merge spans 1,371 commits after the common base. Its new
providers, languages, controls, voice capabilities and rendering work are part
of this candidate. The merged catalog has 34 layers, including the fork's FIS-B
layer. Passing catalog and synthetic tests does not establish every provider's
live availability or every iOS hardware capability.

## Review of the foundation and corrections

A CoT parser, map overlay and gateway are a foundation, not proof of an ATAK/iTAK
replacement. The original handoff's transport intentions must be distinguished
from implementations and real peer/device evidence. The early runbook in this
workspace described a much older prototype; it is superseded by this document.

This integration preserves the gateway's operator isolation, TLS verification,
private-map ownership, EMCON and tactical-data disclosure controls. In particular,
new upstream share-link entry points now respect TAK privacy. Offline reference
maps remain appended to the frozen share-code enum so existing links keep their
meaning. The OpenSky rate governor no longer treats an absent quota header as
zero remaining requests. Airband now starts a valid audio session and rejects
samples from an earlier tuning epoch. Expired-certificate tests create a genuinely
expired certificate with explicit dates supported by current OpenSSL.

Install metadata supports path-prefixed web deployments and maskable icons.
The icon subset now includes new upstream glyphs. Its build uses a commit-pinned
Google source TTF, checks its SHA-256, verifies output ligatures and records binary
hashes; it does not invent glyph coverage or disable integrity checks.

The native source now bundles every production web asset instead of loading only
a remote portal. A bounded, read-only loopback server supplies the local origin.
Startup has no remote login gate. The server settings panel can be dismissed back
to the local app. Downloads are restricted to the active trusted origin (including
its blob exports). Remote TLS validation remains enabled. Every staged asset is
hashed and checked again inside the IPA by the packaging script.

## Validation and release status

The full web build and all 12 synthetic TAK browser scenarios passed, including
34-layer startup, CoT import, marker submission, chat updates, privacy checks,
phone-width controls and teardown. Icon provenance/coverage tests pass. The full unit run completed 9,646 tests: 9,643 passed, 2 failed, 1 skipped.
One failure is the untranslated-UI audit described below. The other was the
200 ms large-string timing assertion during concurrent browser/build work;
both tests in that file passed on an isolated rerun (70.6 ms for the large-string
case), without changing the threshold. All 12 GPS/follow/saved-view browser
checks passed. Package boundaries, formatting and setup-doctor checks passed.
All 471 staged iOS web files match both `dist` and their recorded SHA-256 hashes.

This is a development candidate, not a certified full-feature iPhone release.
The upstream translation audit exposes English-only copy in the fork's TAK,
offline-map, routing and location additions. That check remains enabled and is
an open defect; existing upstream catalogs are retained.

Native source cannot be compiled on this Linux machine. macOS build, simulator
rendering and physical-iPhone acceptance remain outstanding. The saved cloud
network draft includes `api.github.com`, but runtime API requests return proxy
403 until that setting is applied; Git access and the public Actions web page
are separate capabilities. Do not report an IPA until a successful run produces
and validates one.

## Remaining work required by the requested product

- Direct native TAK TCP/TLS and UDP/Mesh/MANET transport. The current native
  settings open a GEV gateway-hosted console; they do not connect directly to a
  TAK server from the bundled page.
- Backend parity for bundled mode: provider proxies, voice, map downloads and
  other Node APIs need a reachable gateway. Bundling UI code does not embed Node.
- Native durable offline map storage, real-device permission/recovery testing,
  background GPS/transport and actual peer interoperability.
- Complete localization of the fork's added controls.
- A capability-by-capability ATAK/iTAK acceptance matrix. Full plugin/hardware
  parity has not been implemented or established by the existing tests.

Do not substitute an older portal-only IPA, claim background operation, or label
synthetic TCP peers as ATAK/WinTAK/iTAK interoperability evidence.

## Delivery record

The candidate was pushed to `origin/feature/tak-completion-20261027`; integration
commit `832b13c7` includes the upstream merge and local-bundle source. The public
Actions page did not show a run for this branch after the push, so automatic build
startup is not confirmed. With access to the repository, dispatch **iOS unsigned
IPA** for this branch and inspect its result. No new IPA was retrieved or produced
in this environment. The cloud startup draft has been updated for this candidate;
saving it does not apply the pending API network setting or publish an environment.
