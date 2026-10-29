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

The repair run completed `npm test` successfully: **9,667 passed, zero failed,
one skipped** (Windows-only native ACL check) across the main suite and both serialized allocation suites.
No test assertions or allocation budgets were disabled or loosened. The previous
large-string failure was fixed by using a UTF-16 lower bound before iteration,
avoiding V8 flattening a huge string unnecessarily; Unicode edge cases are tested.

`npm run i18n` passes: all 3,125 catalog messages are complete in Spanish,
Russian, Simplified Chinese and Traditional Chinese. The fork's TAK, map, routing,
EMCON and location controls now use the existing translation system. Some
server-supplied diagnostics retain their English fallback. Translated HTML is
escaped, and protocol identifiers remain unchanged.

The production build, boundary checks and formatting pass. All 471 production
assets stage successfully. Staging now publishes atomically, rejects symlinks and
credential files, and has five passing filesystem regression tests. IPA packaging
checks the exact asset inventory and publishes outputs only after its checks pass.

Native fixes separate gateway storage from standalone storage so changing gateways
preserves local maps/preferences. Local listener failures can recover through
Reload. HTTP Host/HEAD handling, download redirects and retired-view permissions
are tightened. These Swift changes remain **uncompiled in this Linux environment**.
The macOS smoke now requires the full application to initialize, retain all 34
layers and render a Cesium frame; its implementation is not evidence of a run.

The repair browser run passed all 12 synthetic TAK scenarios against a fresh
local lab, retaining the original transport and privacy assertions. An earlier
run on the long-lived lab timed out waiting for a submission confirmation;
the peer echo arrived, and the timeout did not recur after the lab restarted.
The cause is not established. Bounded, token-free delivery diagnostics now
accompany failed QA runs. Prior GPS/follow/saved-view verification passed all
12 scenarios; the localization changes also passed focused location/UI tests.
This remains a development candidate, not a full ATAK/iTAK replacement.

## Remaining work required by the requested product

- Direct native TAK TCP/TLS and UDP/Mesh/MANET transport. The current native
  settings open a GEV gateway-hosted console; they do not connect directly to a
  TAK server from the bundled page.
- Backend parity for bundled mode: provider proxies, voice, map downloads and
  other Node APIs need a reachable gateway. Bundling UI code does not embed Node.
- Native durable offline map storage, real-device permission/recovery testing,
  background GPS/transport and actual peer interoperability.
- A capability-by-capability ATAK/iTAK acceptance matrix. Full plugin/hardware
  parity has not been implemented or established by the existing tests.

Do not substitute an older portal-only IPA, claim background operation, or label
synthetic TCP peers as ATAK/WinTAK/iTAK interoperability evidence.

## Delivery record

Changes are on `feature/tak-completion-20261027`. The initial integrated source
is commit `832b13c7`; subsequent fixes are on the same branch.

The public GitHub Actions page explicitly reports: **“Workflows are not currently
being run on this fork due to the scale of GitHub Actions usage. A repository
maintainer can choose to re-enable these.”** This explains the missing builds;
repeated pushes cannot clear it. The cloud GitHub API route separately returns
proxy 403. Applying the pending API allowlist alone will not clear GitHub's pause.

The IPA workflow is now manual-only and refuses private repositories, uses a
standard hosted macOS runner, and does not enable paid runners or change billing.
A maintainer must re-enable workflows on the repository Actions page, then run
**iOS unsigned IPA** for `feature/tak-completion-20261027`. No new IPA has been
produced or retrieved here. See [iLoader instructions](docs/TAK_IOS_IPA.md).
