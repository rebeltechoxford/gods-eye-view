# God's Eye View × TAK remaining work

Updated: 2026-10-16. This is the remaining-work handoff for the additive TAK
foundation on `dev/tak-web-foundation`. Use [HOW_TO_RUN.md](HOW_TO_RUN.md) to run
the local app/lab. The detailed preservation inventory and parity ledger are in
[TAK_FEATURE_MATRIX.md](docs/TAK_FEATURE_MATRIX.md); ordered acceptance criteria
are in [TAK_IMPLEMENTATION_PLAN.md](docs/TAK_IMPLEMENTATION_PLAN.md).

## First: real peer acceptance

- **iPhone/AltStore acceptance.** A real unsigned arm64 IPA and simulator
  startup are verified at native revision `f3f65373`; the run guide links the
  package and hash. Personal signing/install and actual device TLS/login/WSS,
  touch, GPS/media, Files export and offline WebKit behavior still need testing.
  Native exports cap at 256 MiB and `data:` downloads are unsupported. The
  wrapper does not provide reliable background TAK/GPS or a native offline map
  engine. These are explicit device/implementation gaps, not completed parity.

- Accept the private HTTPS host on a real EUD: use an issued certificate/SAN
  trusted by that device, verify internal DNS/routing, login/Connect, Sign out,
  expiry/restart and denied access. Keep the listener internal; never replace
  certificate validation with a browser warning bypass. The Node host and local
  HTTPS/WSS fixtures are implemented; actual private-network/device acceptance
  remains open.

- Connect to an authorized TAK Server with issued certificates, then record
  actual server/client versions and transport settings.
- Create and share a web marker/contact; observe it on a real ATAK-CIV peer.
  Change a peer contact/object and observe the expected browser update. Check
  UID/type/time/stale/position/altitude, updates and deletes in both directions.
- Repeat separately with iTAK and WinTAK. Record differences by client/version;
  never infer compatibility for one from a result for another.
- Exercise real certificate rejection/renewal, disconnect/reconnect, stale
  state, gateway rejection and flood/backpressure behavior. Local TLS and socket
  fixtures remain useful regression tests but cannot close real-peer acceptance.

No authorized operational credentials or actual peer devices are supplied by
the repository. These are prerequisites for those live tests only. They do not
prevent the local app, lab, parser, gateway authorization or privacy tests from
running.

## Finish the collaboration product

1. **Multiuser authorization and TAK groups.** The current gateway serves one
   authenticated operator, using loopback token access or a private HTTPS
   cookie session. Add proper users/roles, group-scoped reads,
   subscriptions, replay and revocation before shared multiuser operation. Public
   hosting remains outside the authorized scope. Preserve
   server-side object ownership and denied impersonation/deletion.
2. **Delivery state and synchronization.** Correlated pending/queued/submitted/
   rejected/expired states are implemented. Submitted confirms a local transport
   write, not a peer receipt. Add compatible peer acknowledgements where available
   and explicit durable recovery without rebroadcasting unshared imports or
   expired data. Cancellation cannot retract bytes already written; a failed
   cancellation control closes the browser connection.
3. **Chat.** Current scope is broadcast GeoChat. Add directed/group recipients,
   authorization, receipts and explicit durable-history policy. Validate with
   each supported peer. Unsupported directed/group chat must remain refused.
4. **Shared drawings and routes.** Lines, simple regional polygons and ordered
   routes now have real globe geometry, phone editing, stable waypoint IDs,
   ownership/conflict/delete handling and explicit gateway sharing. Complete
   actual native-peer roundtrips, circles/rectangles/holes, route cues and richer
   object types. Existing GEV
   annotations and public directions remain independent capabilities to preserve.
5. **Mission/data packages and attachments.** Bounded local ZIP/manifest import,
   contact application, selected export and attachment downloads are implemented,
   with path/type/CRC/hash checks and explicit per-export consent. Add authorized
   server file transfer, scoped durable storage, mission sync/conflicts and
   real-client acceptance. Unsupported archive/attachment forms remain refused;
   supported `u-d-f` / `b-m-r` geometry renders its actual vertices; unsupported
   geometry is labeled instead of substituted with a marker.
6. **Coordinate/navigation tools.** DD/DMS/MGRS/UTM entry, validation, shared
   camera focus, local markers and WGS84 horizontal range/true bearing are
   implemented, alongside entered-route editing and leg measurements. Add turn
   guidance, UPS polar grids, altitude datum
   conversion, magnetic bearings and appropriate uncertainty/sensor support.
   Preserve the distinction between operator position, fresh GPS and map center.
7. **GPS/offline field behavior.** The first retained-map slice adds bounded
   USGS raster packs on server and device, verified copy/resume, backups and an
   explicit app-shell download. Eight synthetic production Chromium scenarios
   now include actual closed-server, fresh-page saved-map launch and pan; see
   [offline evidence](docs/TAK_OFFLINE_MAP_PLAN.md). Complete physical-phone
   storage/restart/eviction acceptance and richer approved chart
   imports before broad field claims. Add 3D elevation packs separately from
   rendered topographic maps; NOAA MBTiles and FAA GeoTIFF conversion/import
   remain planned. Add unsent tactical queue reconciliation with an explicit
   retention policy. Reliable background location or external GNSS may need a
   native companion. Map center is operator input, not GPS.
8. **Video/sensors/radios/plugins.** Support named authorized transports, codecs
   and georeferencing metadata with limits/cleanup. Add hardware bridges where
   required. Existing public CCTV/HLS and Local ADS-B do not constitute general
   TAK video, MANET, Meshtastic/LoRa or ATAK plugin support.
9. **Broader protocol and symbology coverage.** Add TAK protocol-v1 protobuf
   handling, a documented supported MIL-STD-2525 symbol subset and extensions
   only when tested/licensed. Current affiliation frames are a limited visual
   treatment. Android APKs/JNI/plugins are not browser modules.

## Preserve, measure and harden

- Extend the optional map/chart catalog on the full GEV globe rather than
  substituting a reduced TAK map. Curated reference choices are implemented;
  track live rendering, coverage/zoom and edition
  acceptance for Esri reference maps, USGS Topo, NOAA ENC and FAA VFR/IFR; add
  operator WMS/WMTS/XYZ only through trusted bounded configuration. Source
  verification and lifecycle/licensing limits are recorded in
  [TAK_MAP_SOURCES.md](docs/TAK_MAP_SOURCES.md). Maintain Google 3D and the original
  quick-map identities/default workspace.

- Retest upstream GEV workflows after changes: all 30 catalog registrations,
  source availability, public feeds, map switches, cockpit/tracking, HUD/Cyber,
  radio/CCTV/Street Level, annotations/director, voice, MCP Apps/embedding,
  attribution, hardware inputs, share formats and application cleanup.
- Extend performance evidence using actual target hardware and realistic
  contacts/trails/chat alongside public GEV layers. Bounded state is necessary
  but not a measured frame-rate or memory guarantee.
  The contact store now enforces aggregate serialized-byte and retained-XML-node
  limits as well as count; the panel reports eviction/refusal. A single-contact
  overlay update reuses unchanged entity/card snapshots. Keep the 2,000-contact
  Chromium regression and verify frame timing under matched conditions; the
  initial concurrent SwiftShader runs had inconsistent frame intervals.
- Keep privacy race coverage across viewport/pointer imagery, structured AI/
  voice/tool requests, public links, scenes/exports, recording, logs/analytics
  and embed handoffs. AI / voice, public sharing / scenes and recording now
  have separate page-session permissions; extend them with destination-specific
  decisions where additional providers or sharing workflows need narrower consent.
- Review certificates, session lifecycle, reconnect queues, malformed CoT,
  resource limits and rejected access as protocol support expands. Do not
  introduce browser-held privileged keys or unauthorized arbitrary upstreams.
- Retest the production Node host alongside dev/lab after provider changes:
  ordered preview middleware, login wall on every app/API path, fixed private
  HTTPS authority, session expiry/logout, bounded login/connections and static
  traversal/source-map/symlink exclusion. Provider settings and MCP are local
  administration functions and must not be exposed by the private host. Keep
  the passing disconnected-cookie-expiry and cached-app HTTP401 cleanup cases;
  physical-device acceptance still needs explicit results.
- Audit each reused library/plugin/data asset. Keep MIT notices and existing
  provider credits. Noncommercial datasets and model/OSM/GPL-related terms have
  separate obligations; a working map is not a license for every deployment.

## Evidence rules

Local unit/build/browser and synthetic lab results establish the tested local
behavior only. Keep current command results and revision in the implementation
plan; preserve failed/skipped scenarios and genuine external prerequisites.
Do not mark full ATAK parity or operational readiness until the relevant feature
matrix rows have explicit real-peer/device acceptance evidence.

## Local verification housekeeping

An abnormal exit of an earlier offline browser harness left the synthetic
fixture directory
`C:\Users\jesse\AppData\Local\Temp\gev-offline-browser-0jKuk9`.
Its browser/server are closed; it contains synthetic map files outside Git.
Automatic approval review rejected both verified-path cleanup attempts with
only `blocked by policy`, so deletion was stopped. The final successful run
cleaned up its own fixture normally. Remove the orphan through an approved
local housekeeping action when convenient; this does not block application
operation or affect private TAK data.
