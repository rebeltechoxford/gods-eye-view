# God's Eye View x TAK: Web Client Foundation

Status: **Phase 1 local proof of concept (not a TAK Server client yet)**.

## Architecture

- Keep God's Eye View's CesiumJS globe, imagery, HUD, public intelligence layers,
  camera controls, scene director, voice integration, and upstream sync intact.
- Add a web-native, modular TAK operator interface. The first slice lives in
  src/tak/ and is mounted through src/app/tools.js on the app lifecycle.
- Treat ATAK-CIV as a feature/protocol reference, **not** a browser dependency.
  Android Java/JNI code and APKs cannot be embedded directly in a browser.
- Retain official ATAK, iTAK and WinTAK clients as first-class peers. Use TAK
  Server for authenticated CoT transport, mission data and collaboration once
  a separately authenticated backend connector is implemented.
- Keep sensitive TAK data distinct from public/exploratory GEV sources.

## Implemented in this branch

- Visible collapsible TAK LOCAL operator panel on the existing globe.
- Import offline CoT XML (one event or event collection) via file or paste.
- Validate geographic CoT coordinates; bound XML size to 1 MiB and event count
  to 1000; reject DTDs/entities, malformed and invalid-only inputs.
- Deduplicate contacts by UID, reject older events with comparable timestamps,
  cap state at 1000 contacts and label stale records.
- Display color-coded CoT positions/callsigns as Cesium map entities; select a
  contact from the roster to fly to its position.
- Create temporary, locally labeled geographic markers.
- Preserve imported TAK data only in page memory: no remote submission,
  browser storage, share links or export to public viewers.
- Explicitly disclose OFFLINE/LOCAL status. Do not misrepresent import as a
  connected TAK Server session.

## Deliberately not implemented (required before operational use)

- TAK Server connection, X.509 mutual TLS, certificate lifecycle, roles,
  groups, authorized subscriptions and permission enforcement.
- Durable offline mission package storage, authenticated file attachments,
  group collaboration, peer-to-peer mesh/MANET transport or chat.
- CoT event emission and acknowledged synchronization; no marker edits are
  published to other ATAK/iTAK/WinTAK users.
- TAK drawing/model tools, navigation, mission planning, military symbology,
  plugin capabilities, video integration or field-grade offline resilience.
- Operational safety validation. Public-feed detections and simulated traffic
  must not be interpreted as verified tactical data.

## Next milestone: authenticated TAK gateway

Implement a dedicated server-side gateway on an operator-owned, authorized
TAK Server installation. The gateway (not the browser) owns client
certificates, mTLS, TAK protocol framing, certificate rotation, access
controls, media proxying and audit records. A separately authenticated,
same-origin HTTPS/WSS browser session subscribes only to authorized data and
sends normalized, validated commands. Preserve UID/time/stale semantics and
separate namespaces for public versus private contacts. Refuse arbitrary
upstream URLs, CORS wildcard authorization, browser-exposed certificates,
unauthenticated event injection and silent retry/broadcast.

Test a controlled exchange with ATAK-CIV and WinTAK, including both directions,
then validate each remaining capability against a feature parity checklist.
CoT alone is not equivalent to complete ATAK or WinTAK feature parity.

## Licensing

- Upstream God's Eye View source is MIT; retain its copyright and license.
- ATAK-CIV source repository contains GPLv3 licensing and other notices. No
  ATAK-CIV source code was copied into this proof of concept. Any later source
  incorporation/linking must undergo GPLv3 and third-party-license review.
- GEV's imagery, data and bundled models have separate provider licenses.
  Check allowed field and commercial use before deployment.

## Development

Run npm ci, npm test, npm run format:check, npm run check:boundaries and
npm run build using the Node versions declared by the upstream project.
Unit coverage is in src/tak/cot.test.mjs. Without a connected TAK Server, test
CoT import with docs/examples/synthetic-contact.cot and add a local marker using
the TAK panel. The synthetic contact is not an operational location.

This branch is intentionally additive. Merge only after the repository CI,
browser smoke tests, and an operator acceptance review pass.
