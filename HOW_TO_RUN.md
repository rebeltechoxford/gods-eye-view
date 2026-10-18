# Run God's Eye View × TAK

The release branch is `main` in `rebeltechoxford/gods-eye-view`; ongoing
integration uses `dev/tak-web-foundation`. The TAK work adds to the existing GEV app;
public globe, layers, HUD, camera, scenes and voice remain available under their
existing provider/key requirements.

The verified candidate is merged into the integration branch. Release through
[PR #6](https://github.com/rebeltechoxford/gods-eye-view/pull/6) brings it to
`main`. See the pull request for the merge record.
[Release checks](docs/TAK_RELEASE_REVIEW.md) passed. Physical-device and native
TAK peer acceptance remain open.

The full GEV globe is the workspace for TAK. Google photorealistic 3D remains
the preferred map when a configured Google/Cesium provider can supply it; the
existing keyless globe is its fallback. The synthetic lab does not replace GEV
with a reduced map application. Additional chart/map choices are optional views
of the same engine, with their own availability, coverage and credits.

The **More maps/charts** selector adds curated Esri, USGS Topo, NOAA ENC and
FAA VFR/IFR references alongside the original quick map controls. Read the
source's coverage, edition/lifecycle and attribution notes. A chart rendering
on the globe does not establish current navigation coverage or operational
acceptance; see [TAK_MAP_SOURCES.md](docs/TAK_MAP_SOURCES.md).

## Open the owner-private preview

Open the [GEV TAK field preview](https://gev-tak-field-preview.jesselsullivan.chatgpt.site)
with its owner account. This Sites deployment serves the built frontend. It
does not run the private Node gateway, TAK Server connection, operator login
service or server-side map storage. Use synthetic data for previewing the UI.

For the local working lab, follow the next section. For operational TAK use,
run the private HTTPS Node host described below and open that authorized origin
in the browser or iPhone wrapper. The preview is not evidence of native-peer,
physical-phone or full ATAK feature acceptance.

## Start the local working project

Install Node **24.14.0 or newer in the 24.x line**, or Node **26.x**, then open
a terminal in the checkout:

```sh
npm ci
npm run tak:lab
```

Open the local URL printed in the terminal. The lab starts GEV and an isolated
synthetic CoT peer, creates a temporary gateway token and permits a local-only
session bootstrap. No TAK account, certificate upload or external TAK service is
needed for this lab. Stop it with **Ctrl+C**.

Open **TAK → NETWORK → Connect**. The lab obtains its local session automatically.
The sample peer is synthetic; it demonstrates the local application/transport
path and does not establish ATAK, iTAK, WinTAK or TAK Server interoperability.

Use **DROP MARKER**, enter a label and coordinates or choose **Map center**,
then **Add marker**. Sharing is an explicit per-marker choice. Observe the
network status and lab peer output to distinguish submission from a disconnected
local marker. **CONTACTS** rows focus the globe. **CHAT** is the current
broadcast chat room. **MY POSITION** can use an operator-set map position or
device geolocation; position broadcast starts only when you enable it.

**SUBMISSIONS** shows each shared item's progress through the gateway: pending,
queued, submitted, rejected or expired. Submitted means the configured transport
accepted the write; it does not confirm a remote peer received it. Local imports
and unshared markers are never automatically resent. See
[delivery semantics](docs/TAK_DELIVERY.md).

**NAVIGATION** accepts DD, DMS, MGRS and UTM coordinates. Validate a coordinate,
focus the globe or create a local marker, and measure horizontal WGS84 range and
true bearing from the map center or a fresh position. The origin is labeled;
map center is not GPS. Turn guidance, magnetic bearings and terrain clearance are not
part of this workflow. See [formats and limits](docs/TAK_FIELD_NAVIGATION.md).

**DRAWINGS / ROUTES** creates lines, filled areas and ordered routes on the
same globe. Choose a kind, name it, then add coordinates or map-center vertices.
You can edit, reorder, reverse or remove vertices and inspect leg distances and
true bearings. Blank altitudes follow the ground; supplied altitudes must cover
every vertex and are ellipsoidal HAE metres. Save locally, or explicitly check
the sharing box for that save. Existing drawings made in this session can be
edited; received drawings can be copied. A newer update blocks a stale edit
until you reload or make a copy. Use the roster to remove an object, and mission
packages for explicit file retention. These are entered paths, with no road
routing or turn guidance. See [formats and limits](docs/TAK_DRAWINGS_ROUTES.md).

**MISSION PACKAGES** inspects a local TAK manifest ZIP before you apply contacts
or save attachments. Importing does not transmit anything. Export only the
contacts and files you explicitly select, then authorize that individual
download. Archives are limited to 32 MiB compressed and expanded, 128 entries
and 8 MiB per file. This is local file exchange, with no server mission sync;
real-client package compatibility still needs acceptance. See
[package formats and limits](docs/TAK_MISSION_PACKAGES.md).

## Run GEV without a TAK network

```sh
npm run dev
```

Open the printed local URL. The gateway is off unless configured. Import
`docs/examples/synthetic-contact.cot` using **TAK → IMPORT COT FILE**, or paste
CoT XML. Imported data stays local. The sample's original timestamp can make it
stale; a stale contact is labeled and eventually removed. Markers created while
disconnected remain local and are not silently broadcast on reconnect.

The TAK panel retains positions/chat in page memory. Reloading drops that
session data. Device UID/callsign/team/role may persist locally so identity can
remain stable; position and chat are not browser-persisted by this foundation.
Contact state is bounded by 2,000 contacts, 8 MiB of serialized contact data
and 100,000 retained XML nodes. When a limit is reached, the oldest nonself
contacts are evicted locally, or an oversized update is refused without
replacing the prior contact. The panel displays a capacity notice. Chat remains
bounded separately; these limits do not promise a frame rate on every EUD.

## Privacy controls

Loading TAK data or setting a private position activates privacy protection for
the page session. AI/voice context and imagery, public share links, scene
capture/export and recording are blocked until their individual permissions in
**PRIVATE DATA PERMISSIONS** are explicitly enabled. AI / voice, public links /
scenes and recording have separate switches; allowing one does not authorize
the others. Each permission lasts for this page session only. Clear a switch or
press **Revoke all permissions** to withdraw it. In-flight captures are invalidated
and protected active voice/recording is stopped when its permission is revoked.
Hiding or clearing contacts keeps protection active because the camera position
can still reveal a tactical location. Each category covers its named destinations;
authorize it only when those destinations are appropriate for the current data.

Embedded/clean/recording views hide TAK controls. Private contacts are kept out
of the public GEV layer registry and share-state formats.

## Connect an authorized real TAK Server

This requires credentials issued for a TAK Server you are authorized to use.
The configuration below serves one operator. Development/lab access stays on
direct loopback; the production host also supports private HTTPS access.
For multiple people, use [named operators](docs/TAK_MULTIOPERATOR.md): up to
eight accounts, separate issued client certificates, operator/receive-only
roles and isolated gateway streams, replay and saved-map storage. TAK Server
group membership must be provisioned and tested on the authorized server;
callsigns and team colors do not grant access.

Keep certificate files outside Git. Set these values in the gitignored `.env`
file, substituting your actual authorized server and absolute certificate paths:

The repository also ignores common private certificate/key file extensions and
`.tak-secrets/` as a second safeguard; keeping them outside the checkout remains
the preferred practice.

```dotenv
TAK_GATEWAY=1
TAK_GATEWAY_TOKEN=<random-token-of-24-to-128-allowed-characters>
TAK_SERVER=<authorized-hostname>:8089
TAK_SERVER_PROTOCOL=tls
TAK_SERVER_P12=<absolute-path-to-client.p12>
TAK_SERVER_P12_PASSWORD=<certificate-password>
TAK_SERVER_CA=<absolute-path-to-trusted-ca.pem>
```

Token characters are `A-Z`, `a-z`, `0-9`, `.`, `_`, `~` and `-`. Generate a
random token locally, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

PEM files are an alternative: set `TAK_SERVER_CERT` and `TAK_SERVER_KEY` instead
of `TAK_SERVER_P12`/`TAK_SERVER_P12_PASSWORD`. Keep the CA file. TLS certificate
and hostname verification remain enabled. Never place these values in `VITE_*`
variables or frontend code.

Start `npm run dev`, open its loopback URL, enter the gateway token in
**TAK → NETWORK** and press **Connect**. Changes to server environment/certificates
require a restart. A connected browser only establishes the gateway connection;
also inspect the **TAK Server** uplink state and test an authorized peer in both
directions before calling the connection interoperable.

LAN mesh UDP is an opt-in gateway bridge, configured with `TAK_MESH=1` and
`TAK_MESH_INTERFACE=<authorized-interface-IPv4>`. Browser JavaScript does not
open raw UDP sockets. Enable it only on an authorized TAK segment. Mesh and TAK
Server do not bridge to each other unless `TAK_BRIDGE=1` is explicitly set.
The mesh link decodes TAK protocol v1 (protobuf) datagrams as well as XML and
sends XML, which every TAK client must accept. To let an authorized TAK Server
switch the streaming connection to v1 when it offers it, add
`TAK_SERVER_PROTOBUF=1` and use one of its `tls` streaming inputs (TAK Server
5.7 does not offer v1 on `stcp`/`tcp`, and `prototls` inputs are unsupported);
the default stays XML. The TAK panel's uplink line shows v1 counts and the
negotiated server encoding. Scope, evidence and limits are in
[TAK_PROTOCOL_V1.md](docs/TAK_PROTOCOL_V1.md). Private/group chat and native
plugins remain unsupported unless listed otherwise in [TAK_TODO.md](TAK_TODO.md).

## Run the private HTTPS console on an EUD

`npm run tak:serve` is a Node HTTPS server for the built application and its
existing provider APIs. It does not run Vite. Every app/API request requires an
operator session; keys, certificates and provider administration stay on the
server. This is an internal host, with no public or wildcard binding, reverse
proxy, remote MCP endpoint or remote token bootstrap.

First obtain a server certificate whose SAN matches your chosen internal DNS
name or IP, issued by a CA your EUD trusts. Keep its private key outside Git.
Configure a gitignored `.env.production.local`, for example:

```dotenv
TAK_GATEWAY_TOKEN=<random-operator-token-of-24-to-128-allowed-characters>
TAK_HTTPS_CERT=<absolute-path-to-server-certificate-chain.pem>
TAK_HTTPS_KEY=<absolute-path-to-server-private-key.pem>
TAK_HTTPS_HOST=10.20.30.40
TAK_HTTPS_PORT=8443
TAK_BROWSER_ORIGIN=https://tak.internal:8443
```

The address/name above is an example. Use the server's actual private address
and a DNS name resolving to it; the certificate must cover that name. With an
IP origin, use that private IP in the certificate SAN. The origin must match
exactly, including its nondefault port, with no trailing slash. Default binding
is `127.0.0.1:8443`; a nonloopback bind requires `TAK_BROWSER_ORIGIN` explicitly.
Allowed connections are loopback or RFC1918 IPv4. Public, wildcard, link-local,
CGNAT and IPv6 ULA addresses, forwarded headers and cross-origin requests are
refused. Do not expose or forward this listener to the public Internet.

For named accounts, keep the same `TAK_HTTPS_*` listener settings and set
`TAK_GATEWAY_USERS_FILE` to the protected JSON described in the
[account setup guide](docs/TAK_MULTIOPERATOR.md). Each enabled account needs
its own PEM client certificate/key and trusted TAK CA. Remove global
`TAK_SERVER`, mesh and bridge settings in this mode; they are rejected to
prevent accidental stream sharing. Login uses the account name and its own
random token. The server keeps only token hashes in the account file.

```sh
npm ci
npm run build
npm run tak:serve
```

Open the printed HTTPS origin on the authorized private network. Sign in with
the operator token, then use **TAK → NETWORK → Connect**. The HTTPS session
authenticates that connection; no second token entry or browser-held TAK
certificate is required. **Sign out** clears local tactical state and revokes
the server session. Sessions are memory-only, capped at 32 and expire after
eight hours of idle time or eight hours total; restarting the host requires
sign-in again. Expired active WebSockets are revoked, and the client clears
private state and returns to sign-in when it receives that expiry response.

Named mode additionally limits each account to four sessions/connections.
Receive-only accounts can view their authorized stream and work with local
maps, files and drafts; they cannot publish positions, chat, alerts or objects.
Changing accounts in another tab clears the previous tab's tactical state and
reopens the app. Map requests and WebSockets bind the expected account to the
server session so a stale tab cannot operate as the replacement account.

Named device identities and map databases use separate account/configuration
namespaces. **Save app for offline use** also explicitly approves that account
for later network-outage reopening. A rejected login/status is never treated
as an offline fallback. Sign-out revokes the approval. These namespaces are
not encryption or protection from someone controlling the same unlocked
browser profile; use separate OS/browser profiles for that boundary.

The production host retains GEV's provider middleware and built globe/layers,
voice and PWA assets. Existing provider credentials and coverage requirements
still apply. `/api/setup` and `/mcp` remain unavailable on the private host;
perform credential administration locally. Production framing stays disabled.
Optional **Add to Home Screen** uses the authenticated HTTPS manifest. Offline
maps and application storage require the explicit Saved Maps actions below;
installation alone does not download them. Tactical contacts/chat stay in page
memory, and reliable background GPS is not supplied by the browser.

`TAK_HTTPS_*` protects browser-to-GEV traffic. The separate `TAK_SERVER_*`
settings above, or each named account's `server` entry, protect the
gateway-to-TAK Server connection. Configure both sides when using an authorized
real server. HTTPS login alone does not establish TAK peer delivery or browser
GPS permission.

Local tests use temporary synthetic certificates and loopback HTTPS/WSS. A
real phone with its issued/trusted certificate, private-network reachability,
GPS permissions and authorized TAK peer still needs acceptance. No public
deployment, private LAN listener or device trust-store change was performed
to produce those local results.

## Install the iPhone package through AltStore Classic

Download the retained [unsigned arm64 IPA](https://gev-tak-field-preview.jesselsullivan.chatgpt.site/downloads/GEVTAK-unsigned.ipa)
from the owner-private preview. It requires personal signing before installation;
it is a wrapper that opens your private HTTPS app, not a bundled Node gateway.

The unsigned device package was built and validated on real macOS/Xcode and
started in an iPhone simulator. The verified handoff copy is
`output/ios/28eb0c9e/GEVTAK-unsigned.ipa`, with adjacent `SHA256SUMS`,
`provenance.json` and a simulator screenshot. The same package is in the
[verified build artifact](https://github.com/rebeltechoxford/gods-eye-view/actions/runs/39002095999)
while GitHub retains it. Its SHA-256 is
`e412622077b8fc56349bb2fb6ad3df60e0e064a0e0a464c0029cf12619e992b5`.
Its source is PR test-merge `2a59b57aefa4af8b41d282ea613e065d8332fd5a`,
whose tree `941cc2a09065064f4519b11c7593e31d7115345d` matches development
`28eb0c9e`. Native sources and `scripts/build-ios-ipa.sh` are unchanged in the
current candidate, so this retained wrapper is reused; it loads the current
private web app. Rebuild when native sources change. The recorded iOS job
passed. The archive was built
with Xcode 26.6 and started on an iPhone 17 / iOS 26.5 simulator; this does not
establish a physical-phone or configured-private-endpoint result.

1. Set up [AltStore Classic/AltServer on Windows](https://faq.altstore.io/altstore-classic/how-to-install-altstore-windows)
   for your own iPhone. Apple authentication and personal signing stay in that
   tooling; the repository and CI need no Apple credentials.
2. Import the unsigned IPA through AltStore's **My Apps → +** and complete the
   device's required signing/trust/Developer Mode steps. Free-account apps
   require [seven-day refresh](https://faq.altstore.io/altstore-classic/your-altstore).
3. Open **GEV TAK**, enter your approved private HTTPS origin, such as
   `https://gev.internal:8443`, then use the web operator login. The phone must
   reach that private host and trust its matching certificate. System TLS
   validation remains enabled; the app provides no certificate bypass.

The IPA is a native container for this full private web application. Keep it
visible for foreground GPS. Downloads require consent before the system Files
picker; native exports are limited to 256 MiB, so use smaller map packs for
phone export. `data:` downloads and reliable background TAK/GPS are not
implemented. Physical-device login/WSS, media/GPS, Files and disconnected
WebKit acceptance remain open. The desktop offline gate does not establish
those iOS behaviors. See [TAK_IOS_IPA.md](docs/TAK_IOS_IPA.md) for the source,
reproducible Mac build and device acceptance checklist.

## Retain topographic maps on the server and phone

On the built private HTTPS app, open **TAK → SAVED MAPS / OFFLINE**. Use the
10 km box around the map center or enter west/south/east/north bounds. Choose
minimum/maximum zoom; the panel counts tiles before requesting anything. The
first supported source is USGS Topographic. This downloads raster map images,
not 3D elevation meshes. Google 3D remains an online base; other imagery and
charts have separate download permissions. Authorized local MBTiles raster imports are available below.

Leave **Also retain on this device** checked, then choose **Download area**.
The server retains verified tiles on disk; the browser copies and verifies a
separate pack in IndexedDB, selects it on the same GEV globe, and saves the
built app/Cesium workers for disconnected launch. Watch the separate map/app
results. A partial copy is not ready. Use Cancel, then Refresh and Resume or
Save to this device to reuse verified retained tiles after interruption.

For a local raster package, use **IMPORT LOCAL MBTILES** in the same panel.
Select the original `.mbtiles` file, enter a map name, source/publisher and the
license or permission notice; supply its edition/effective date when known.
An optional source URL is retained as text and never fetched. Explicitly check
permission to copy and retain this particular file, then choose **Import
MBTiles**. The default creates server and device copies and saves the offline
app. **Source / license / edition** shows the retained notices and original
file SHA-256. These notices survive `.gevmap` backups.

To retain part of a larger file, set the area and minimum/maximum zoom in the
controls above, then enable **Limit import to area and zooms entered above**.
The unchecked default imports the whole file. A subset retains only existing
tiles intersecting those limits; boundary tiles remain whole and sparse gaps
remain blank. The panel shows the maximum cell count before upload. The entire
original file still uploads and counts against quota, and its hash, original
metadata and notices remain separate from the recorded selection. Showing or
reopening a saved subset frames the requested area.

Named accounts default to 128 MiB per pack and 256 MiB per account. During
import the original SQLite file and normalized output both need reserved space.

Only standalone, checkpointed SQLite MBTiles with 256 px PNG/JPEG Web Mercator
raster tiles are supported. Limits remain 5,000 tiles, plus account/file/space
budgets; vectors, 512 px tiles, terrain and GeoTIFF are unsupported. The server
has a 15-second upload deadline and five-second inactivity limit. Cancelled or
failed uploads require reselecting the original file and permission checkbox;
there is no byte-upload resume. A completed server copy remains usable if a
later device copy fails: use **Save to this device** or **Verify / refresh device
copy**. Incomplete imported packs require the original file again; the USGS
resume action does not repair them. Whole NOAA chart bundles can exceed the
5,000-tile limit; explicitly select a smaller area/detail to import a subset.
The exercised retained NOAA file was an `SG_AREA` service-area overlay with
observed May 2024 dates, not a verified current navigational chart. Read the
[MBTiles format, permissions and limits](docs/TAK_MBTILES_IMPORT.md).

Limits are 5,000 tiles and 512 MiB per pack, 32 packs and 2 GiB per store, with
four concurrent upstream requests. Download smaller adjacent areas when the
area/detail exceeds those limits. The displayed size estimate is approximate;
actual image sizes, available device quota and server disk space decide whether
the download completes.

Server files default to `gods-eye-view/offline-maps` under `LOCALAPPDATA`,
`XDG_DATA_HOME`, or `~/.local/share`. An absolute `TAK_MAP_PACKS_DIR` can select
another private directory outside the checkout and built public directory.
One running server owns a cache directory. Keep its manifests and tile files
together for backup; stop the server before copying the directory.

**Show saved map** uses only the local device pack and flat ellipsoid terrain.
Coverage/detail misses remain blank rather than silently contacting an online
map source. A selected saved pack is remembered for startup. Choose an online
map explicitly to return to the normal GEV sources.

Map copies and the app shell remain after logout/reload until explicitly
deleted. Anyone with access to this browser profile can open them offline;
download only on an appropriate device. No operator token, session response,
TAK contact, message or GPS fix is stored in these map/application caches.
The OS/browser can still evict website storage or the user can clear it:
export a **.gevmap backup** and retain the server copy. Restore a backup with
the file control; its schema, source, bounds, size and every tile hash are
checked. Delete device/server copies separately; **Remove offline app** removes
only the cached app. Ordinary browsing does not opt in to application caching.

After downloading, close/reopen the app with the server and all networks
unreachable and inspect the saved area. Repeat on the actual target phone;
desktop Chromium evidence does not establish iOS WebKit storage behavior. The
local development lab can create/copy packs, but saving a launchable offline
app requires `npm run build` and the production HTTPS host. Read
[the source/download ledger](docs/TAK_OFFLINE_MAP_PLAN.md) for licensed sources,
terrain and chart import work that remains.

## Drive offline with road packs

Driving directions can be computed on the phone with no signal. Build a road
pack at home from an OpenStreetMap extract, for example Geofabrik's
`mississippi-latest.osm.pbf`:

```sh
node scripts/build-road-pack.mjs --input mississippi-latest.osm.pbf \
  --name Mississippi --out mississippi.gevroads
```

Put the `.gevroads` file and its `.gevroads.json` manifest in
`GEV_ROAD_PACK_DIR` on the private host (default `gods-eye-view/road-packs`
under `LOCALAPPDATA`, `XDG_DATA_HOME` or `~/.local/share`). On the phone open
**TAK → OFFLINE ROADS / ROUTING** and choose **Download to this device**. On
the built private HTTPS app this also saves the app for offline launch, as a
saved map does. Turn on Directions and choose Drive: when both ends are inside
an installed pack, the route is computed on the device, never sent to a router,
and its summary ends in `· offline`. Other trips and walking/cycling stay
online.

Car routing only, from OSM roads: no turn restrictions, traffic, closures or
live guidance. Read [what the router knows and the evidence](docs/TAK_OFFLINE_ROADS.md).
A physical iPhone has not yet been tested; install a pack, enable airplane
mode, relaunch from the home screen and route before relying on it.

## Reproduce verification

```sh
npm run doctor -- --json
npm run format:check
npm run check:boundaries
npm test
npm run build
npm run build:panel
```

After the production build, these gates start their own temporary
loopback HTTPS servers and synthetic fixtures; run them sequentially:

```sh
npm run qa:tak:private
npm run qa:maps:offline
npm run qa:maps:mbtiles
node scripts/qa-offline-roads.mjs --https --pack-dir <road pack directory>
```

Their reports and screenshots are written under `qa-artifacts/`. The latest
integrated CI evidence is recorded in the
[release review](docs/TAK_RELEASE_REVIEW.md).
These are local/synthetic checks, with separate physical-phone and authorized
TAK-peer acceptance still required.

With `npm run tak:lab` running on its default port, verify the browser and the
synthetic peer's marker/chat return path with:

```sh
npm run qa:tak -- --url http://127.0.0.1:4174 --lab
```

For a normal local-only dev server, use `npm run qa:tak -- --url
http://localhost:5173` with the URL it printed. `--gateway` exercises a configured
local gateway without assuming a particular peer; set `TAK_QA_TOKEN` in the
harness process environment when automatic lab bootstrap is disabled. `--lab`
also asserts the lab-specific synthetic replies. Other options: `--headful`,
`--timeout <milliseconds>` and
`--artifact-dir <directory>`. Evidence goes to gitignored `qa-artifacts/tak/`.
The harness stubs public HTTP data and imagery and uses synthetic TAK fixtures;
it does not test a real TAK peer. App fonts and icons are self-hosted by default.
`--fonts` permits optional external Google font stylesheet/font requests when
present; the default app has no Google-font network dependency. TAK and public
data stay synthetic in either mode. The repeated map texture is a bundled image
fixture, not geographic imagery acceptance.
Existing GEV browser gates and acceptance
scope are documented in [the implementation plan](docs/TAK_IMPLEMENTATION_PLAN.md).

For a synthetic 2,000-contact desktop stress check against the local lab:

```sh
node scripts/qa-tak-stress.mjs --url http://127.0.0.1:4174 --expect-cached
```

It imports bounded batches, measures updates/render scheduling/clear, checks
contact and roster limits, preserves all 30 GEV registrations and checks
teardown/render errors. Results go to gitignored `qa-artifacts/tak/stress.json`.
Headless SwiftShader, intercepted providers and synthetic map tiles are a
desktop regression fixture, not real-phone, live-layer or GPU performance
acceptance. Run without competing browser/test jobs when comparing timings.

If startup fails, check the declared Node version, rerun `npm ci`, and run the
doctor command. If the gateway stays off, verify that the token is configured
and valid. A browser showing `LIVE` with a disconnected uplink is not peer
delivery. See [TAK_TODO.md](TAK_TODO.md) for remaining work and acceptance gaps.
