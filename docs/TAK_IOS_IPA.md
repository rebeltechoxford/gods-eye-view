# iPhone IPA and AltStore delivery plan

Status: researched, not implemented or built. No iOS workflow has been added or
run. The verified web foundation remains the checkpoint; an IPA must not be
described as working until it has been built, personally signed, installed and
tested on a real iPhone.

## Recommended first native package

Use a small Swift application containing `WKWebView` that loads the existing
private HTTPS GEV application. This preserves the complete server-served globe,
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

Windows cannot run Xcode. A later, explicit build workflow can use a standard
GitHub-hosted macOS runner: GitHub documents these as free for public
repositories, and its macOS 26 image includes Xcode 26. Check the selected
runner's actual SDK/tool versions during the build; avoid paid larger runners.
[GitHub: standard runners](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#standard-github-hosted-runners-for-public-repositories),
[GitHub: macOS image inventory](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md)

The planned output is an unsigned **device** application built for `iphoneos`,
packaged as `Payload/<app>.app` in an IPA. Disable build-time signing and verify
the resulting architecture and bundle contents. This recipe remains untested
for this project; a simulator build is not a device IPA, and the unsigned output
cannot be installed directly. Use no Apple account or signing secrets in CI.

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

Remaining external acceptance inputs are a real iPhone, its trusted private
HTTPS endpoint and network, personal signing, and an authorized TAK peer. They
block those device/live checks, not independent implementation or synthetic
tests.
