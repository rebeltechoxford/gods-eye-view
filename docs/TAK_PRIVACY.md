# Private TAK disclosure permissions

The TAK panel has separate page-session switches for AI / voice, public sharing /
scene capture and exports, and recording. Every switch starts off. Allowing one
use does not authorize another, and **Revoke all permissions** withdraws all three.
These switches are not persisted. Logout and detected session expiry clear them.

Private coordinates, imported contacts and selected private files activate the
sticky per-viewer guard. Clearing or hiding contacts does not remove it: camera
position or an authored scene can still disclose a location. The permission is
scoped to the named use, not an assertion that every destination is trusted.
Destination-specific decisions remain necessary when new workflows are added.

AI gates cover voice connection/context, pointer and viewport images and HUD
summaries. Sharing gates cover public links, scene capture/export and embedded
view replies. Recording mode has its own gate and stops when that permission is
revoked. Async capture/export tickets are invalidated on any permission change;
this conservatively cancels in-flight work even if another category changed.
Unknown scopes and callers without a category require all permissions while
private state is present. Per-file mission-package download consent is independent
and does not turn on these session-wide switches.

## Verification

Node 24.19 unit tests exercise independent permission gates, unknown-use refusal,
state-copy isolation and revoke/re-enable races. Real browser controls verify that
enabling AI keeps public link composition blocked, explicitly enabling sharing
permits it, and revoking clears every switch. The synthetic lab browser gate
passed all 12 scenarios. The production HTTPS gate passed all 12 scenarios,
including private-state cleanup before logout/expiry navigation.

The first full local unit run reported 6,547 passes, 10 pre-existing skips and one
Street Level timing failure. Its unchanged selection/enablement assertions now
use the existing controlled-clock seam instead of a short real-time sleep;
the 19 focused mesh/privacy tests passed. Full integrated validation is recorded
in the implementation plan after the remaining feature branches are assembled.

Two private-browser runs exposed a fixture interception race rather than a failed
app check. Diagnostic evidence identified an invalid Fetch ID for an old document's
request after Chrome committed a different loader in the same frame. The fixture
helper now correlates that exact request/loader transition; unrelated frames,
unknown loaders, document requests and unexpected protocol errors still fail.
All six helper tests passed, followed by the 12-scenario production browser gate.
Evidence remains in the ignored `qa-artifacts/scoped-privacy*` folders and
`.gev-cache/scoped-privacy*` logs. No real peer/device acceptance is inferred.
