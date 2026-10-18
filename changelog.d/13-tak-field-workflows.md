# TAK field workflows (PR #13 and integration fixes)

- EMCON now also refuses following an external link or submitting a form (a
  new browser tab would otherwise transmit); in-page anchors and the saved app
  shell stay usable. The airband help links to LiveATC.net for listening
  online without a receiver; LiveATC's terms do not allow embedding, so it
  opens in its own tab.

- The Local RTL-SDR card has an AIR mode for aircraft and ATC voice (AM,
  118.000–136.975 MHz), entirely in the browser and usable off-grid: offset
  tuning keeps the RTL-SDR DC spike off the channel, a 10 kHz AM demodulator
  with an adjustable squelch (default 6 dB, 300 ms hang) mutes the hiss
  between transmissions, and the seek buttons step 25 kHz channels. Airband
  gain and squelch are remembered; existing FM and ADS-B gain settings are
  kept. See `docs/LOCAL-RECEIVERS.md`.

- Aircraft feeds: the military (adsb.lol) request now times out after 15 s
  instead of hanging; neither it nor OpenSky serves a cached snapshot as
  STALE once it is older than 10 and 15 minutes respectively (the regional
  fallback or an honest error answers instead); and an OpenSky success
  without an `X-Rate-Limit-Remaining` header keeps the normal 9 s refresh
  instead of being read as zero credits and cached for 5 minutes.

- FIS-B Weather: a new layer shows what your own 978 MHz receiver hears from
  FAA ground stations, with no internet: METAR stations colored by flight
  category, TFR/NOTAM, AIRMET, G-AIRMET and SIGMET areas, and NEXRAD
  precipitation; click for the text. The host reads dump978-fa's raw port or
  Stratux-style GDL 90 over UDP (`FISB_FEEDS`). The decoder matches
  fisb-decode's reference output frame for frame on FIS-B test groups 28–30
  and the GDL 90 ICD examples; a Chromium gate drives a synthetic receiver
  through the production HTTPS host. A real ground station is still to be
  heard; see `docs/FISB.md`.

- EMCON (emissions control): an **EMCON** button above the TAK launcher and in
  the TAK panel header pauses app requests and closes owned connections after a
  confirmation. The TAK link closes, data feeds freeze with their last data,
  network layers cannot start and the saved-app worker answers from the device
  cache only; contacts, markers, field notes, saved maps and offline driving
  stay usable. The mode survives reloads and follows other tabs; leaving
  reloads the app. The revised Chromium gate checks requests and independently observed stream
  closure; complete device network isolation is not established. Device
  radios, the browser's own update checks and a field-laptop host are outside
  its reach; see `docs/TAK_EMCON.md`.

- Offline driving directions: build an OpenStreetMap car road pack at home
  (`scripts/build-road-pack.mjs`), serve it read-only from the private host
  (`GEV_ROAD_PACK_DIR`) and install it on the phone from **TAK → OFFLINE
  ROADS**. Driving trips inside an installed pack are routed on the device in a
  worker and never sent to a router; other trips stay online. Packs are
  SHA-256 verified at install and every load, and installing one saves the app
  for offline launch. A synthetic Chromium gate stops the server and routes
  from the saved app. Physical iPhone acceptance is still required; see
  `docs/TAK_OFFLINE_ROADS.md`.

- Logging out or timing out during an MBTiles upload or a saved-map request no
  longer throws while resetting the request timeout on a socket that is
  already detached.

- Decode TAK protocol v1 (protobuf) mesh datagrams instead of dropping them,
  and let a TAK Server uplink negotiate v1 with `TAK_SERVER_PROTOBUF=1`
  (default XML). Every v1 event passes the existing CoT validation; negotiation
  control never reaches browsers. The codec has no new dependency and matches
  an independent Google protobuf oracle byte for byte. `npm run tak:lab --
--protobuf` and `npm run qa:tak -- --lab --protobuf` exercise the negotiated
  link in the browser. Real ATAK/WinTAK/iTAK and TAK Server v1 acceptance is
  still required; see `docs/TAK_PROTOCOL_V1.md`.

- Preserve authorized MBTiles area/zoom subsets and bounded opt-in device
  presence streams. Reject covered offline-routing failures locally, bound
  derived indexes, fence canceled downloads and expire failed weather snapshots.

Original feature commits by Claude are preserved in the merge history.
Validation and release status: see `docs/TAK_RELEASE_REVIEW.md`.
