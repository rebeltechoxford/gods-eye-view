# FIS-B Weather

The FIS-B Weather layer shows the weather and airspace picture that FAA ground
stations broadcast on 978 MHz (UAT) across the US, as heard by **your own
receiver**. It needs no internet connection and no account: once the receiver
hears a ground station, the map fills in.

FIS-B (Flight Information Service – Broadcast) is free, unencrypted and US
only. Coverage depends on altitude: on the ground you may hear one nearby
station or none; in the air you usually hear several.

## What it shows

| On the map           | From FIS-B                            | How it looks                                                                                                                                                                      |
| -------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weather stations     | METAR/SPECI, TAF, winds aloft, PIREPs | A dot per station, colored by flight category from the METAR: green VFR, blue MVFR, red IFR, magenta LIFR, gray no METAR. Click for the METAR, TAF, winds and PIREPs as received. |
| TFRs and NOTAMs      | NOTAM (TFR, D, FDC), NOTAM-TRA/TMOA   | Red outline for a TFR, with its altitudes and valid times on click. Airport NOTAMs (runway closures and the like) are small white dots at the airport.                            |
| Advisories           | AIRMET, G-AIRMET, SIGMET, CWA         | Yellow (AIRMET, G-AIRMET), orange (SIGMET, CWA) outlines. Only the slice valid now is drawn; G-AIRMET forecast slices appear when their time comes.                               |
| Special-use airspace | SUA status                            | Counted in the layer row; not drawn (FIS-B sends status text, not shapes).                                                                                                        |
| Precipitation        | NEXRAD regional and CONUS             | One translucent image, green through magenta by reflectivity (GDL 90 ICD table 20). Regional (finer) over CONUS.                                                                  |

The layer row in **Data Layers ▸ Weather** reads like `1 ground station ·
42 METARs · 18 NOTAM/AIRMET/SIGMET · NEXRAD`, or says the receiver is connected
but hears no ground station.

Not drawn yet (decoded and counted, see **Limits**): lightning, icing,
turbulence and cloud tops. Aircraft heard on 978 MHz (ADS-B, TIS-B, ADS-R) are
the Local ADS-B layer's job, through `skyaware978`
([Local receivers](LOCAL-RECEIVERS.md)).

## Set it up

You need a 978 MHz receiver the GEV host can reach:

- **A dongle on the host** (Raven, a laptop, a Raspberry Pi): an RTL-SDR with a
  978 MHz antenna (a 1090 antenna works at short range) and
  [dump978-fa](https://github.com/flightaware/dump978).

  ```sh
  dump978-fa --sdr driver=rtlsdr --raw-port 30978
  ```

  ```sh
  FISB_FEEDS=dump978=tcp://127.0.0.1:30978
  ```

  If the same dongle already feeds Local ADS-B through `skyaware978`, both can
  read the one `dump978-fa`: skyaware978 connects to the same raw port.

- **A Stratux** (or any receiver that speaks GDL 90): join its Wi-Fi with the
  host and listen for its broadcasts on UDP 4000.

  ```sh
  FISB_FEEDS=gdl90=udp://0.0.0.0:4000
  ```

  Datagrams from senders outside loopback and private (RFC 1918) networks are
  dropped.

Put the line in `.env` (see `.env.example`) and restart the server. Up to four
comma-separated inputs are read. Hosts must be loopback, RFC 1918, `localhost`
or a `*.local` name; anything else is logged at startup and never used.
Addresses never reach the browser.

Then turn on **Data Layers ▸ Weather ▸ FIS-B Weather**. The host connects to
the receiver on the first request and disconnects after ten minutes without
one, so an unused receiver costs nothing.

## How it works

- `src/sources/fisb/decode.js` decodes uplinks: the station header, information
  frames, APDU headers, DLAC text, TWGO text and graphics records (polygons,
  polylines, points, circles, validity times), current report lists and NEXRAD
  blocks. `gdl90.js` unframes GDL 90 (CRC-checked). Input is untrusted radio:
  every read is bounds-checked and a bad frame is counted, never fatal.
- `src/sources/fisb/store.js` folds uplinks into the current picture:
  segmented products are reassembled, text and graphics of one report are
  joined, cancellations remove reports, and anything not rebroadcast within its
  retention time ages out (METAR 2 h, TAF 8 h, winds 12 h, PIREP 90 min,
  NOTAM/AIRMET/SIGMET 45 min, NEXRAD regional 20 min and CONUS 45 min). Every
  collection is capped.
- `server/providers/fisb.js` reads the receiver(s) and serves
  `GET /api/fisb` (the picture, with station positions from the bundled US
  airport table) and `GET /api/fisb/radar?product=63|64`. On the private HTTPS
  host both sit behind sign-in like every other `/api` route.
- `src/layers/fisb/` draws it and refreshes every 30 s; radar is fetched only
  when it changed. Under [EMCON](TAK_EMCON.md) the layer keeps its last
  picture, marked stale, and makes no requests.

## Limits

- **Advisory only.** FIS-B products can be late, incomplete or decoded in
  error. This is situational awareness, not an approved weather or NOTAM
  source for flight planning; get an official briefing.
- **Not drawn:** lightning (product 103's bin encoding is not decoded),
  icing, turbulence and cloud tops (decoded and checked against the reference,
  but not drawn), SUA shapes (FIS-B sends none), PIREP positions beyond the
  reporting station.
- **Stations without a position:** a METAR from a station that is not in the
  OurAirports-derived table (about 1% in the test captures: non-airport
  weather sites and closed fields) is kept but not drawn.
- **Above 60° N** (northern Alaska) block geometry follows the documented
  even-block layout but is not verified against a capture.
- **Time:** FIS-B times carry no year; the host takes the nearest year to the
  time of receipt.
- **Host-side EMCON:** EMCON silences the browser. The host keeps listening to
  the receiver (listening is passive and transmits nothing), but a host-side
  switch is not implemented.

## Evidence

Recorded on 2026-10-18 UTC with Node `24.14.0` on Linux x64 and Chromium
`141.0.7390.37`:

- **Decoder against a reference.** Every frame of FIS-B test groups 28, 29
  and a 64-uplink cover of group 30 (all 14 product types present, including
  two segmented files) matches [fisb-decode](https://github.com/rand-projects/fisb-decode)'s
  level-0 output field by field: headers, text, TWGO records with vertices and
  times, CRLs and every NEXRAD bin. On the full 963-uplink group 30 capture
  the production store decoded all 6,232 frames with zero errors. The GDL 90
  ICD worked examples reproduce exactly (heartbeat CRC and framing; the
  NEXRAD sample's block bounds, run lengths and extent).
- **Tests bite.** Seven deliberate decoder mutations (time-field order,
  circle radius scale, DLAC separators, block height, run-length count,
  empty-block bitmap order, G-AIRMET qualifier skip) each fail the suite.
- **Unit tests** (32 new): decoder, store (reassembly in any order,
  cancellation, retention, caps, flood, garbage), text classification and
  flight category, the host provider over real TCP and UDP sockets (dropped
  connection retried, corrupt GDL 90 counted, idle shutdown, addresses kept
  off the wire), radar composition and the layer's source and cards.
- **Browser gate** `npm run qa:fisb` (production build, private HTTPS host,
  a synthetic receiver rebroadcasting a current picture over dump978-fa raw
  TCP every 5 s) passed 6 of 6: the route is closed before sign-in; the layer
  draws the three stations in their categories, the TFR and AIRMET outlines
  and the NEXRAD image; clicking KTUP shows `KTUP · IFR` with its METAR;
  turning the layer off removes all of it; no browser errors.

Reproduce:

```sh
node --test src/sources/fisb/*.test.mjs src/data/fisbProxy.test.mjs src/layers/fisb/*.test.mjs
npm run build && npm run qa:fisb
```

## Not yet verified

- A real receiver hearing a real ground station. The decoder is checked
  against reference captures and the pipeline against a synthetic receiver;
  run dump978-fa with an antenna at a window and compare a few METARs with
  aviationweather.gov.
- A Stratux over its own Wi-Fi (GDL 90 over UDP is tested with local
  datagrams only).
- Rendering on the photoreal 3D Tiles map (the radar image uses the tileset's
  imagery layers, as Recent Imagery does; the gate ran on the globe).
