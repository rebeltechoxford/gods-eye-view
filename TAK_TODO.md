# God's Eye View × TAK remaining work

Updated: 2026-10-16. This is the remaining-work handoff for the additive TAK
foundation on `dev/tak-web-foundation`. Use [HOW_TO_RUN.md](HOW_TO_RUN.md) to run
the local app/lab. The detailed preservation inventory and parity ledger are in
[TAK_FEATURE_MATRIX.md](docs/TAK_FEATURE_MATRIX.md); ordered acceptance criteria
are in [TAK_IMPLEMENTATION_PLAN.md](docs/TAK_IMPLEMENTATION_PLAN.md).

## First: real peer acceptance

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
   authenticated local operator. Add proper users/roles, group-scoped reads,
   subscriptions, replay and revocation before shared/public hosting. Preserve
   server-side object ownership and denied impersonation/deletion.
2. **Delivery state and synchronization.** A successful WebSocket write is a
   gateway submission, not a peer receipt. Add compatible peer acknowledgements
   where available, visible queued/rejected/delivered states and recovery without
   rebroadcasting unshared imports or expired data.
3. **Chat.** Current scope is broadcast GeoChat. Add directed/group recipients,
   authorization, receipts and explicit durable-history policy. Validate with
   each supported peer. Unsupported directed/group chat must remain refused.
4. **Shared drawings and routes.** Implement supported TAK object types,
   editing/ownership/conflict/delete behavior and roundtrips. Existing GEV
   annotations and public directions remain independent capabilities to preserve.
5. **Mission/data packages and attachments.** Add safe archive/manifest handling,
   authorized file transfer, bounded decompression, path/type/hash validation,
   scoped storage, sync conflicts and real-client acceptance.
6. **Coordinate/navigation tools.** Define the supported DD/DMS/MGRS/UTM and
   altitude datum/uncertainty behavior; add range/bearing, waypoint/route tools,
   precision tests and camera arbitration. Existing coordinate readouts alone
   do not establish the whole ATAK navigation workflow.
7. **GPS/offline field behavior.** Add explicit retention/cache policy, restart
   and storage eviction handling, licensed offline map packs, unsent queue
   reconciliation and device/browser testing. Reliable background location or
   external GNSS may need a native companion. Map center is operator input,
   not GPS.
8. **Video/sensors/radios/plugins.** Support named authorized transports, codecs
   and georeferencing metadata with limits/cleanup. Add hardware bridges where
   required. Existing public CCTV/HLS and Local ADS-B do not constitute general
   TAK video, MANET, Meshtastic/LoRa or ATAK plugin support.
9. **Broader protocol and symbology coverage.** Add TAK protocol-v1 protobuf
   handling, a documented supported MIL-STD-2525 symbol subset and extensions
   only when tested/licensed. Current affiliation frames are a limited visual
   treatment. Android APKs/JNI/plugins are not browser modules.

## Preserve, measure and harden

- Retest upstream GEV workflows after changes: all 30 catalog registrations,
  source availability, public feeds, map switches, cockpit/tracking, HUD/Cyber,
  radio/CCTV/Street Level, annotations/director, voice, MCP Apps/embedding,
  attribution, hardware inputs, share formats and application cleanup.
- Extend performance evidence using actual target hardware and realistic
  contacts/trails/chat alongside public GEV layers. Bounded state is necessary
  but not a measured frame-rate or memory guarantee.
- Keep privacy race coverage across viewport/pointer imagery, structured AI/
  voice/tool requests, public links, scenes/exports, recording, logs/analytics
  and embed handoffs. Session disclosure authorization is broad; refine it per
  destination/action before supporting more sharing workflows.
- Review certificates, session lifecycle, reconnect queues, malformed CoT,
  resource limits and rejected access as protocol support expands. Do not
  introduce browser-held privileged keys or unauthorized arbitrary upstreams.
- Audit each reused library/plugin/data asset. Keep MIT notices and existing
  provider credits. Noncommercial datasets and model/OSM/GPL-related terms have
  separate obligations; a working map is not a license for every deployment.

## Evidence rules

Local unit/build/browser and synthetic lab results establish the tested local
behavior only. Keep current command results and revision in the implementation
plan; preserve failed/skipped scenarios and genuine external prerequisites.
Do not mark full ATAK parity or operational readiness until the relevant feature
matrix rows have explicit real-peer/device acceptance evidence.
