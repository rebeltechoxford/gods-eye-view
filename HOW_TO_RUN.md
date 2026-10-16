# Run God's Eye View × TAK

Use this repository's `dev/tak-web-foundation` development line from
`rebeltechoxford/gods-eye-view`. The TAK work adds to the existing GEV app;
public globe, layers, HUD, camera, scenes and voice remain available under their
existing provider/key requirements.

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

## Privacy controls

Loading TAK data or setting a private position activates privacy protection for
the page session. AI/voice context and imagery, public share links, scene
capture/export and recording are blocked until the TAK disclosure checkbox is
explicitly enabled. Hiding or clearing contacts keeps protection active because
the camera position can still reveal a tactical location. Revoke disclosure by
clearing the checkbox. The checkbox is a broad session permission; use it only
when every enabled destination is appropriate for the current data.

Embedded/clean/recording views hide TAK controls. Private contacts are kept out
of the public GEV layer registry and share-state formats.

## Connect an authorized real TAK Server

This requires credentials issued for a TAK Server you are authorized to use.
The current gateway is a **single local operator** service: browser access is
restricted to direct loopback connections. It is not a shared multiuser or
public hosting service.

Keep certificate files outside Git. Set these values in the gitignored `.env`
file, substituting your actual authorized server and absolute certificate paths:

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
Protocol-v1 protobuf, private/group chat and native plugins remain unsupported
unless listed otherwise in [TAK_TODO.md](TAK_TODO.md).

## Reproduce verification

```sh
npm run doctor -- --json
npm run format:check
npm run check:boundaries
npm test
npm run build
npm run build:panel
```

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
it does not test a real TAK peer. Add `--fonts` for visual review with the app's
Google-hosted fonts; only Google font stylesheet/font requests are allowed
through that mode, while TAK and public data stay synthetic. The repeated map
texture is a bundled image fixture, not geographic imagery acceptance.
Existing GEV browser gates and acceptance
scope are documented in [the implementation plan](docs/TAK_IMPLEMENTATION_PLAN.md).

If startup fails, check the declared Node version, rerun `npm ci`, and run the
doctor command. If the gateway stays off, verify that the token is configured
and valid. A browser showing `LIVE` with a disconnected uplink is not peer
delivery. See [TAK_TODO.md](TAK_TODO.md) for remaining work and acceptance gaps.
