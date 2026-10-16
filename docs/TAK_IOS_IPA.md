# iPhone IPA and AltStore delivery plan

Status: the Swift/WKWebView shell, Xcode project and unsigned IPA workflow are
implemented on `feature/tak-ios-ipa`. No Xcode build or iOS workflow run is
verified yet. Windows cannot compile the app. The IPA must not be described as
built until CI succeeds, or as ready on an iPhone until personally signed,
installed and tested on that device.

## Implemented connected package

The small Swift application contains `WKWebView` and loads the existing
private HTTPS GEV application. This preserves the server-served globe,
layers, HUD, voice, camera controls and TAK workflows instead of creating another
UI. Use an explicit operator-configured HTTPS origin, keep all top-level
navigation pinned to that origin, and open approved external links separately.
Keep actual internal hostnames, credentials, certificates and map data out of
the public repository, build inputs, logs and artifacts.

Load `/login` in the web view and retain the current same-origin HTTP/WS cookie
flow. The wrapper must not collect an Apple ID, embed the operator token or
inject tokens into JavaScript. Use `WKWebsiteDataStore.default()` for normal
website data; Apple documents that it persists website data to disk. The
gateway's eight-hour session expiry, logout and restart invalidation still
apply. [Apple: website data stores](https://developer.apple.com/documentation/webkit/wkwebsitedatastore)

Preserve normal platform certificate validation. No trust-all navigation
delegate, HTTP fallback or broad ATS exception. A private CA must be installed
and trusted on the phone, or the server must present a chain the phone already
trusts. Manually installing a CA profile alone does not enable SSL trust.
[Apple: server trust](https://developer.apple.com/documentation/foundation/performing-manual-server-trust-authentication),
[Apple: manually installed certificates](https://support.apple.com/en-us/102390)

This first connected wrapper is a packaging milestone. It does **not** complete
the requirement for persistent maps on both the server and phone.

The initial native UI accepts an HTTPS origin only, without a path, query,
fragment or credentials. Literal IPs must be RFC1918 IPv4 or loopback; an
internal DNS name is explicitly chosen by the operator and resolved by iOS.
That approved hostname must resolve to the private deployment, including when
it uses an organization's real DNS suffix and a normally issued certificate.
The wrapper does not infer private routing from a suffix or replace TLS with a
DNS preflight. The HTTPS server enforces its private listener/address policy;
the exact configured origin and normal certificate validation remain required.
Loopback names the phone itself, so a remote gateway needs its reachable private
address. Native Back, Reload and server settings retain the existing web app.
External HTTPS navigation requires confirmation showing the destination URL;
other external schemes are refused. Subframe public media remain available,
but their microphone/camera requests are denied. The configured main frame
receives normal system media prompts only while active.

Main-frame JavaScript alert, confirm and text prompts use native dialogs titled
with the configured origin. Other frames cannot open these dialogs. Exports
from that main frame can use same-origin HTTPS or same-origin blob downloads.
Each requires native confirmation warning about private data, followed by the
system Files save picker. Unknown sizes and advertised sizes above 256 MiB are
refused; in-progress size checks cancel overruns, and the completed file is
checked again. Cross-origin redirects and arbitrary file paths are refused.
Temporary exports use file protection and backup exclusion and are deleted on
completion, cancellation, local clearing or next app launch. This is an
explicit file export, not persistent offline-map storage.
[Apple: web dialogs](https://developer.apple.com/documentation/webkit/wkuidelegate),
[Apple: downloads](https://developer.apple.com/documentation/webkit/wkdownloaddelegate)

An opaque native cover hides the app's window while inactive; actual app
switcher snapshots need device acceptance. The wrapper cannot prevent a
foreground OS screenshot or external recorder. Use the website's **TAK →
NETWORK → Sign out** to revoke a server session. Native server settings clear
this device's WebKit cookies/site data before changing origins; that local
clear does not claim server-side sign-out.

The iOS deployment target is 16.0. Location/media purpose strings are included,
with no background modes, native GPS service, injected scripts, message bridge,
native HTTP transport or embedded operator token. WebKit's normal geolocation
permission behavior is used: Apple's separate geolocation delegate is iOS27
API and is deliberately not called from this Xcode26 build.
[Apple: location purpose](https://developer.apple.com/documentation/bundleresources/information-property-list/nslocationwheninuseusagedescription),
[Apple: media permission delegate](<https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:requestmediacapturepermissionfor:initiatedbyframe:type:decisionhandler:)>),
[Apple: geolocation delegate availability](<https://developer.apple.com/documentation/webkit/wkuidelegate/webview(_:requestgeolocationpermissionfor:initiatedbyframe:decisionhandler:)>)

## Persistent maps and offline startup

The current service worker deliberately caches no application or TAK data.
Neither a wrapper nor ordinary browser caching makes offline maps reliable.
`WKWebsiteDataStore.default()` persistence also does not make WebKit storage
nonpurgeable: WebKit describes quotas, eviction and best-effort storage, with
persistent mode granted heuristically. [WebKit: storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/)

Implement server map packs and phone downloads as a separate verified slice.
Use only sources licensed for offline retention, with explicit coverage, zoom,
edition, size and deletion controls. Prefer native Application Support storage
for required phone packs, with file protection and no cloud backup for
redownloadable map content. Do not put required packs in a purgeable cache.
[Apple: file storage](https://developer.apple.com/documentation/foundation/using-the-file-system-effectively),
[Apple: backup exclusions](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup)

There are two different origin designs to prove before promising offline startup:

- A remote HTTPS app keeps today's authentication boundary. Service-worker
  availability in `WKWebView` needs an app-bound-domain design and device tests.
  `WKAppBoundDomains` is an Info.plist list of at most ten domains; enabling
  `limitsNavigationsToAppBoundDomains` restricts top-level navigation. An arbitrary
  host entered after installation is not automatically added. Do not publish a
  customer's internal hostname to solve this. [WebKit: app-bound domains](https://webkit.org/blog/10882/app-bound-domains/),
  [WebKit: service workers for app-bound domains](https://bugs.webkit.org/show_bug.cgi?id=210451)
- A bundled copy of the full GEV build can supply an offline shell under a local
  origin. It cannot transparently become the remote HTTPS origin: Apple forbids
  a custom scheme handler for schemes WebKit already handles, including HTTPS.
  Keep offline-map access in a narrow native bridge and keep online TAK access
  on the existing authenticated origin, or separately design and test native
  session transport. Do not weaken the gateway's Origin/cookie checks.
  [Apple: URL scheme handlers](<https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/seturlschemehandler(_:forurlscheme:)>)

Any map bridge must validate the calling web view, main frame and exact origin;
expose bounded pack/tile operations rather than arbitrary paths, URLs or native
evaluation. Offline startup, map decoding and logout/local-lock behavior need
real device acceptance. Private TAK contacts, chat and credentials stay outside
map storage.

## Swift wrapper versus Capacitor 8

The Swift wrapper is the smaller first step because it preserves the existing
same-origin app. Native map storage, GPS and other bridges still require
deliberate implementation.

Capacitor offers a plugin system but does not remove that work. Version 8 needs
macOS and Xcode 26 or later; SPM is the default iOS dependency manager.
[Capacitor: environment](https://capacitorjs.com/docs/getting-started/environment-setup),
[Capacitor: upgrading to 8](https://capacitorjs.com/docs/updating/8-0)

Its normal bundled iOS origin is `capacitor://localhost`; that is cross-origin
from the private HTTPS gateway. Its `server.url` option is documented for live
reload and not production. Do not select it as an apparent shortcut around the
authentication design. Native HTTP/cookie patches and each plugin introduce
additional behavior to review. [Capacitor: configuration](https://capacitorjs.com/docs/config)

## Building and personal signing

Windows cannot run Xcode. The workflow uses a standard
GitHub-hosted macOS runner: GitHub documents these as free for public
repositories, and its macOS 26 image includes Xcode 26. Check the selected
runner's actual SDK/tool versions during the build; avoid paid larger runners.
[GitHub: standard runners](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#standard-github-hosted-runners-for-public-repositories),
[GitHub: macOS image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md)

The workflow [`.github/workflows/ios-ipa.yml`](../.github/workflows/ios-ipa.yml)
runs on pushes to **feature/tak-ios-ipa** and PR changes to its owned paths. It
does not require changing `main`. Manual dispatch is also included for later
use when GitHub exposes the workflow. It selects the installed Xcode26.6 on
`macos-26` and the repository's existing pinned checkout/upload actions. There
is no npm install, third-party native package, Apple account, provisioning
service or signing secret.

On a Mac with stable Xcode26 selected:

```sh
bash scripts/build-ios-ipa.sh --smoke
```

The script runs pure Swift endpoint-policy cases, archives an arm64
**iPhoneOS device application** with signing disabled, validates its platform,
bundle identity, permissions and lack of provisioning/ATS exceptions, then
packages and checks `Payload/GEVTAK.app`. ZIP integrity and excluded credential
file types are checked. `--smoke` separately builds the simulator app, boots a
temporary iPhone, installs/launches the unconfigured setup screen and saves a
screenshot. No private endpoint, real GPS or TAK peer is used by that smoke.

The `GEVTAK-unsigned-<commit>` artifact contains `GEVTAK-unsigned.ipa`,
`provenance.json`, `SHA256SUMS` and the simulator setup screenshot, retained
seven days. Provenance records actual toolchain/SDK, source commit/dirty state,
architecture, validation flags and IPA SHA-256. Intermediate build directories
and the temporary simulator are cleaned up. These commands remain unrun on
Xcode until CI supplies that evidence; a simulator build is not a device IPA.
The unsigned output cannot be installed directly.

Compare the IPA hash to `SHA256SUMS` before personal signing. On Windows:

```powershell
Get-FileHash -Algorithm SHA256 .\GEVTAK-unsigned.ipa
```

AltStore Classic and AltServer provide the personal signing/install step on
Windows. Apple account authentication stays with that tooling. AltStore's
documentation describes seven-day expiry/refresh for free sideloaded apps and
the three-active-app limit. Signing refresh, Developer Mode and device trust are
user/device operations that this repository cannot silently perform.
[AltStore: Windows setup](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows),
[AltStore: refresh and limits](https://faq.altstore.io/altstore-classic/your-altstore)

## Acceptance before calling the IPA ready

Verify the generated IPA through actual AltStore installation, strict TLS
rejection, login/logout/expiry, WSS return traffic, all GEV registrations,
WebGL/workers, touch controls, downloads/imports and permitted media/GPS flows.
Test downloaded maps after app termination, phone restart and network removal;
test storage exhaustion, interrupted downloads and deletion too.

An iPhone wrapper does not establish reliable background GPS or persistent TAK
sockets. Native permission/background work is separate, and foreground Safari
or Chromium results do not prove WKWebView behavior.
[Apple: background execution](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time),
[Apple: background location](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)

Native downloads may also
need local-network permission even though Apple exempts traffic originating
directly in WKWebView. [Apple: local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)

Native downloads/Files, Google3D/WebGL/workers, voice/media, keyboard/rotation,
location permission and inactive snapshots remain unverified on WKWebView.
The bounded export handler still needs actual Files/device acceptance;
there is no native map-pack storage bridge in this slice. Packaging the same web
UI does not establish complete GEV or ATAK parity on iOS. Existing public
map/imagery services still receive their normal area requests.

The icon is rendered from the existing MIT `public/logo.svg`. Its original
copyright/license is included in `ios/GEVTAK/NOTICE.txt` and copied into the app.
No Android application or plugin code is reused.

Remaining external acceptance inputs are a real iPhone, its trusted private
HTTPS endpoint and network, personal signing, and an authorized TAK peer. They
block those device/live checks, not independent implementation or synthetic
tests.
