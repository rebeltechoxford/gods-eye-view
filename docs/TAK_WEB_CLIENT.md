# God's Eye View × TAK: web client foundation

Status: **local web application and single-operator gateway foundation**.
The implementation adds bounded CoT XML, contact/marker/chat workflows and an
opt-in local gateway to GEV. The synthetic lab exercises actual local TCP and
WebSocket transport. Real TAK Server, ATAK-CIV, iTAK and WinTAK interoperability
has not been established by that lab or the fixture suite. Complete ATAK parity
is not claimed.

Start with [HOW_TO_RUN.md](../HOW_TO_RUN.md). Scope and evidence live in the
[feature matrix](TAK_FEATURE_MATRIX.md), [implementation plan](TAK_IMPLEMENTATION_PLAN.md)
and [remaining work](../TAK_TODO.md).

## Architecture and ownership

```text
GEV browser: existing globe, layers, HUD, camera, scenes, voice
  TAK panel → client/store → same-origin WebSocket /api/tak/ws
             ↓                              ↓
  dedicated Cesium overlay          Node gateway: auth + policy + router
  shared world-overlay cards          ├─ configured TLS/TCP server link
                                      └─ optional authorized UDP mesh link
```

- `src/tak/protocol/` owns portable XML/CoT parsing, validation, serialization,
  builders, stream framing and routing. It has no DOM/Cesium/Node dependencies.
  Inputs are bounded and DTD/entity declarations refused. The browser and gateway
  share protocol handling; the gateway additionally enforces outbound policy.
- `store.js` owns bounded, page-memory contacts, tracks, alerts and deduplicated
  chat. UID/time ordering and stale retention remain separate from display
  presentation. `client.js` owns stable device identity, current fix, explicit
  position broadcast, local/imported/shared objects, chat and transport state.
  Identity preferences can persist; positions/chat do not.
- `transport.js` authenticates to the same-origin gateway, registers the device
  identity and reports bounded reconnect states. Submitting a frame is not peer
  acknowledgement. Disconnected markers/imports are not automatically published
  later.
- `cotOverlay.js` owns a dedicated `CustomDataSource` for affiliation frames,
  stale presentation, emergencies and trails; callsign cards use the existing
  world-overlay host. Records are diffed by UID. Focus uses GEV navigation
  ownership; private records are not registered as public GEV layers.
- `ui.js` owns the operator panel and its listeners. `index.js` composes the
  client, overlay, geolocation and panel, mounts through `src/app/tools.js`, and
  releases sockets, timers, watches, subscriptions and rendering on teardown.
- `server/providers/tak.js` composes `config.js`, `gateway.js`, `meshLink.js`
  and `serverLink.js` as server-owned resources. Upstreams come from operator
  configuration, never a browser/model-supplied address.

Keep GEV's existing rendering, catalog, public sources, camera/cockpit, HUD,
annotations/director, voice/tools, provider setup, share formats and credits.
The feature matrix inventories those capabilities rather than treating the TAK
panel as a replacement application.

## Gateway access and authorization

The current gateway serves **one local operator**, not multiple users. Enabling
it requires `TAK_GATEWAY=1` and a valid random `TAK_GATEWAY_TOKEN` of 24–128
allowed characters. Dev/lab browser upgrades require a direct loopback socket,
matching loopback host/port, same Origin, no forwarding headers, `tak.v1` and
the valid token. The production `npm run tak:serve` host additionally supports
an explicitly configured private HTTPS origin and revocable secure-cookie
session; the private WSS listener always requires that session. Public listeners
and reverse proxies are outside this implementation. See the run guide for
the certificate, private address and pinned-origin requirements.

The authenticated session registers a `GEV-<UUIDv4>` device identity before
publishing. The gateway enforces its supported own-device/own-marker namespace
and action policy. Arbitrary imported events, identity impersonation and
modification/deletion of other devices' objects are refused. All browsers using
this token still belong to the same local operator; user accounts, roles and
TAK Server group isolation remain future work.

`npm run tak:lab` creates a transient random token and enables an explicit
local-session bootstrap at `POST /api/tak/session`. The panel requests it only
when Connect is pressed. Bootstrap uses strict same-origin loopback checks and
is off by default outside the lab. It is not a general authentication service.

Frame/body, connection, rate, replay, queue, history and backpressure limits
bound resource use. TLS trust/hostname validation stays enabled; private CA and
client certificate/key or PKCS#12 material stay in the server process. Plain TCP
is for an explicitly configured local/private lab endpoint. Mesh/server bridging
requires `TAK_BRIDGE=1`; enabling two uplinks does not silently bridge them.

## Protocol scope

Implemented transport uses traditional CoT XML. The official
[TAK protocol reference](https://github.com/TAK-Product-Center/atak-civ/blob/main/takproto/README.txt)
describes legacy XML mesh/streaming and later protobuf framing. Server XML
output uses an XML declaration and newline before each event and does not add
arbitrary newlines after its closing tag, following that reference. Protocol-v1
protobuf is currently recognized/refused rather than decoded and is not a
supported interoperability mode.

Builders cover self SA/PPLI, spot markers, broadcast GeoChat, own-marker delete,
ping and emergency/cancel. Parsing a type or preserving an unknown detail
extension does not implement its complete ATAK workflow. Directed/group chat,
mission packages/data sync, attachments, drawing/route editing, full 2525 symbols,
offline field resilience and native plugins remain outside this foundation.
The confirmed next download requirement is a retained copy on both the server
and phone, including actual disconnected phone launch/rendering. Source
permissions and acceptance criteria are recorded in
[the offline map plan](TAK_OFFLINE_MAP_PLAN.md). This proposal does not yet
provide offline storage. AltStore IPA delivery also needs a native build and
device acceptance; a browser package does not establish native TAK parity.

Browser connection, gateway submission, upstream queue/write and real peer
receipt are different states. Never describe `LIVE`, a successful send return
value or an echoing fixture as proof that an operational peer received data.

## Privacy boundary

Imported files and unshared markers are local by default. Once TAK data or a
private fix enters the page, a per-viewer sticky guard blocks AI/voice context
and imagery, public links, scene capture/export and recording until the
operator explicitly authorizes disclosure in the panel. Hiding/clearing data
does not remove the guard because camera/location context can remain sensitive.
Authorization is page-session-wide and can be revoked. Capture/async operations
recheck the current permission before returning or publishing results.

Public tool/catalog state excludes raw TAK contacts. Embedded/clean/recording
views hide TAK controls and fresh embedded pages do not auto-connect. Additional
egress routes introduced by future features need corresponding policy and race
tests; memory-only storage alone does not establish privacy.

## Verification and licensing

`npm test` includes portable protocol/store/client/transport, gateway and privacy
tests. Gateway tests use real local HTTP/WebSocket/TCP/TLS sockets and synthetic
test identities/certificates; they are not a TAK Server compatibility result.
`npm run qa:tak -- --url <local-url>` exercises the actual browser UI using
synthetic CoT and intercepted public HTTP data/imagery. Add `--gateway` for the
explicit local lab path. Record final revision, commands and limitations in the
implementation plan. Real-peer acceptance remains separate for each client and
server version.

GEV source remains MIT with its copyright/notices retained. No ATAK-CIV GPL
source is incorporated in this implementation; protocol/workflow references do
not make Android code a browser dependency. Review any future reused source,
symbol library or plugin together with its own third-party notices. Existing
imagery, datasets and models retain their separate terms: see
[LICENSE](../LICENSE), [DATA_SOURCES.md](../DATA_SOURCES.md) and
[model attribution](../public/models/README.md). Preserve noncommercial and
share-alike restrictions where applicable.
