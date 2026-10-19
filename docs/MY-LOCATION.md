# My location

The crosshair button in the top bar (next to north-up) shows where you are on
the globe: a blue dot with a translucent ring for the reported accuracy. It
needs no TAK setup, no account and no internet once the app is loaded.

## Use it

| Button state          | Tap does                     | Looks like                     |
| --------------------- | ---------------------------- | ------------------------------ |
| Off                   | Asks the device for location | Gray crosshair                 |
| Finding you           | Stops                        | Blue crosshair, pulsing        |
| Following             | Turns it off                 | Blue crosshair with a blue rim |
| Shown (not following) | Centers on you and follows   | Blue crosshair                 |

- **First tap:** the browser asks for location permission the first time.
  On the first fix the map flies to you, about 2.5 km above the ground (or
  closer if you were already closer), and keeps the map's bearing.
- **Following:** the camera stays over the dot as you move. Pinch or wheel
  zoom keeps following; a one-finger drag, tracking an aircraft, a search or
  any other camera move stops following but keeps the dot updating. Tap to
  follow again.
- **Stale:** if the device stops reporting for 30 s (lost signal), the dot
  and button turn gray until the next fix. Losing the signal does not turn
  location off; a refused permission does, with the reason in a toast.
- Hidden in cockpit view and during scene playback, like the other camera
  buttons. Location pauses while the app is in the background (browsers do
  not give web apps background location).

The page needs HTTPS (or `localhost`) for the browser to offer location; on
plain HTTP the button explains this instead.

## Start view

The app opens on downtown Austin by default (inherited from the original
project). To open somewhere else, go there (search, a city pill, or follow
yourself with the location button), open **Location** in the bottom bar and
tap **Start here**. The tray then reads `Start view: 34.37°N 89.52°W`, and
the app opens there on this device from then on, with the same short fly-in
from above. **Reset** goes back to Austin.

- Saved in this browser only (`localStorage`, key `gev.startView.v1`): the
  latitude, longitude, height, heading and pitch, labelled by coordinates.
  It is not sent anywhere and is not part of share links, and each browser
  or phone keeps its own.
- A share link or a saved map area you open still takes priority.
- If browser storage is blocked (some private windows), **Start here** says
  so instead of pretending to save.

## One GPS for the map and TAK

The dot and TAK's **Use device GPS** share one device watch: turning both on
runs one GPS session, and each can be turned off on its own. TAK still
decides separately whether your position is shared with the team; the dot
alone shares nothing.

## Privacy

- The position is drawn on this device only. It is not stored (not in
  browser storage, the saved app or share links) and not sent anywhere by
  this feature.
- Following puts the camera over you, and some features read the camera
  (the AI HUD summary and its nearby-places lookup, share links,
  recording). So the first fix marks the page session private, the same
  protection TAK applies when your TAK position is on screen: those uses
  stay blocked until you allow them in the TAK panel. Nothing about this
  persists across a reload.
- The browser gets the position from the device. On a phone that is the
  GPS receiver, often helped by Wi-Fi and cell data the operating system
  manages; a desktop browser may ask a network location service. This app
  does not control that.

## EMCON

EMCON does not turn location off: receiving GPS transmits nothing. With
Airplane Mode on, phone GPS keeps working (Wi-Fi and cell assistance stop,
so the first fix can take longer, especially indoors). A desktop browser
without GPS hardware usually cannot locate you under EMCON with the network
off.

## Evidence

Recorded 2026-10-19 UTC, Chromium 141.0.7390.37 (Puppeteer geolocation
emulation), Node 22 in a cloud container:

- `node --test src/location/deviceLocation.test.mjs src/ui/myLocation.test.mjs src/tak/geolocation.test.mjs src/ui/startView.test.mjs`:
  24 pass. The start-view tests check the stored view is validated (bad
  values fall back to the default) and that the default flies in exactly as
  the original Austin start did. Covers the shared watch (one device watch for two consumers,
  released with the last), FOLLOW (claimed once, moves with each fix at the
  current zoom, ends on a drag or another camera owner, survives a pinch),
  refusal in cockpit view, stale fixes, HTTPS, denied permission, teardown,
  and the private marking.
- `npm run build && npm run qa:my-location`: 11 of 11 against the production
  build on the private HTTPS host. Dot and ring at the emulated fix, the
  camera follows a moved fix, a mouse drag ends FOLLOW while the dot keeps
  moving, tap follows again and tap turns it off, **no request after the
  first fix carried the device coordinates**, a denied permission is
  explained, **Start here** saves the view and a reload opens there (not
  Austin) and **Reset** returns a reload to Austin, the six top-bar buttons
  fit a 390 px phone without overlap,
  and no uncaught browser errors. With the private marking removed, the
  coordinate check fails (nearby-places carried the position), so the check
  is real.

## Not verified

- A real phone: permission prompts on iOS Safari and Android Chrome,
  indoor and moving fixes, battery use.
- The installed (home-screen) app.
