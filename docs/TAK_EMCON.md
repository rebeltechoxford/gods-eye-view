# EMCON: emissions control

EMCON is a deliberate "go silent" mode for when the device or the network may
be compromised. It goes further than Airplane Mode in one direction and less
far in another:

- **Further:** the app itself stops transmitting, even on a network that still
  works. No request leaves the page, its workers or its saved-app service
  worker, including requests to the private host.
- **Less far:** a web app cannot switch off the device's radios. Turn on
  Airplane Mode and check Wi-Fi and Bluetooth are off. The confirmation dialog
  and the banner say so.

What stays usable is everything already on the device: received TAK contacts,
markers, drawings and routes, field notes, saved maps, and offline driving
directions from an installed road pack.

## Use it

- **Enter:** tap **EMCON** above the TAK launcher (or in the TAK panel header
  while the panel is open) and confirm **Go silent**. The change is live: the
  picture on screen stays as it is.
- **While on:** a red banner reads `EMCON · NO TRANSMISSIONS · since HH:MMZ ·
feeds frozen · Airplane Mode: turn it on`. It does not block taps.
- **Leave:** tap **EMCON ON** and confirm **Leave EMCON**. The app reloads,
  reconnects to the server and resumes data feeds.

EMCON is remembered on the device (`localStorage` key `gev.emcon.v1`), so a
reload or relaunch comes back silent, and it follows across tabs of the same
app. If the browser refuses storage, the banner says EMCON will not survive a
reload; it never turns itself off because storage failed.

## What EMCON does

| Area                        | Under EMCON                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Page network APIs           | `fetch`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`, `EventSource`, `RTCPeerConnection`, `window.open`, service-worker registration and element `src`/`href` loads are refused with an `EmconError` (a `TypeError`, so existing offline error paths handle it).   |
| What is still allowed       | `data:` and `blob:` URLs, loopback non-API URLs, and same-origin `GET`/`HEAD` of the app shell (`/`, `/index.html`, `/assets/…`, `/cesium/…`, fonts, models, icons) only when the saved-app worker controls the page, so those are answered from the device cache. |
| Saved-app service worker    | Switches to cache-only and remembers it in Cache Storage. Cached shell files are served; navigations get the cached app; anything else fails locally without touching the network.                                                                                 |
| TAK link                    | Disconnected on entry; **Connect** is refused until EMCON is left.                                                                                                                                                                                                 |
| Data layers                 | Periodic refreshes stop. Layers already on keep their last data, marked stale. Turning on a layer that needs the network is refused with "EMCON is on: this layer needs the network". Turning layers off is never refused.                                         |
| Layers that can still start | Directions (on-device routing) and data bundled with the app: dams, data centers, submarine cables. Local ADS-B cannot: it reads the private host.                                                                                                                 |
| Voice / AI                  | Starting a voice session fails at the `RTCPeerConnection` guard.                                                                                                                                                                                                   |

The guard is the first module the page loads (`src/emcon/boot.js` is the first
import of `src/main.js`; the CSP forbids inline scripts, so nothing can run
earlier). Code: `src/emcon/` (state, guard, boot, UI), the layer freeze in
`src/data/lifecycle.js`, the TAK hooks in `src/tak/index.js` and the EMCON
branch of `public/gev-sw.js`.

## Limits

These are stated in the app or follow from how browsers work. Do not assume
EMCON covers them.

- **Device radios and the operating system.** Phones keep talking to cell
  towers, Wi-Fi, Bluetooth, push services and OS update checks. Only Airplane
  Mode (and hardware switches) stop that.
- **The browser itself.** Chromium checks the service-worker script for
  updates after a navigation (`GET /gev-sw.js`) and runs its own background
  services (Google accounts, component updates, safe browsing, preconnects).
  The page cannot block these. The gate below counts them separately.
- **The private host.** EMCON silences the browser app. A host on a field
  laptop keeps its own uplinks (TAK Server, AIS, ADS-B receivers, map
  downloads) running. A host-side EMCON switch is not implemented.
- **Received TAK picture across a reload.** Contacts and session chat received
  over TAK live in memory. A reload under EMCON keeps the app silent but
  starts with an empty TAK picture; field notes stored on the device stay.
- **Uncached files.** Anything not saved on the device simply fails to load
  under EMCON. Save the offline app (and maps / road packs) before going
  silent.
- **Leaving EMCON transmits.** The reload reconnects and resumes every feed;
  that is the point of leaving.

## Evidence

Recorded on 2026-10-18 UTC with Node `24.14.0` on Linux x64 and Chromium
`141.0.7390.37`:

- **Unit tests:** `src/emcon/guard.test.mjs` (policy table, every guarded API,
  install-once, persistence and cross-tab sync, storage failure),
  `src/data/emconLifecycle.test.mjs` (refused network layers including Local
  ADS-B, frozen and stale layers, switch-off never refused) and two
  service-worker tests in `src/tooling/takPwa.test.mjs` (the saved app answers
  and nothing reaches the network, leaving restores normal routing, and the
  mode survives a worker restart).
- **Browser gate** `scripts/qa-emcon.mjs` passed **7 of 7** scenarios against
  the production build served over HTTPS on a non-loopback origin
  (`https://gev.test`), with three independent witnesses: the app server's
  request and upgrade log, a recording proxy for every outbound connection
  (open tunnels are cut when EMCON engages) and Chrome DevTools network events
  from the page, its workers and the service worker.
  - Before EMCON: native login, the offline app saved, a synthetic CoT contact
    imported, earthquakes and flights on, a road pack installed — 982 server
    requests.
  - Under EMCON for 30 s: flights stayed on with their last data, enabling
    CCTV was refused, a forced refresh did not run, page-level `fetch`
    (same-origin and third-party) and `WebSocket` threw `EmconError`,
    `sendBeacon` returned false, an image load was blocked, the contact stayed
    on the globe and an Oxford → Tupelo drive routed on the device
    (`80 km · 59 min · Drive · offline`). **Zero** app requests reached the
    server, the proxy or DevTools. The browser made one service-worker update
    check.
  - Reload under EMCON: the app booted from the saved worker with zero app
    requests; one worker update check and Chromium's own services
    (`android.clients.google.com`, `www.google.com`) were recorded separately.
  - Leaving from the TAK panel header reloaded the app and it resumed (45
    server requests).
- Regression gates after the change: `qa-tak.mjs --lab --protobuf` (12/12),
  `qa:maps:offline` (8/8) and `qa-offline-roads.mjs --https` (6/6).

Reproduce:

```sh
npm run build
npm run qa:emcon -- --pack-dir <road packs>
```

Screenshots and `results.json` go to `qa-artifacts/emcon/`.

## Not yet verified

- A physical iPhone in Airplane Mode: iOS WebKit service-worker behavior,
  relaunch from the home screen and battery cost.
- A host-side EMCON switch for field-laptop deployments.
