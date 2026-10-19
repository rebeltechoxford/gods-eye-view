# My location on the globe

- A crosshair button in the top bar shows where you are: a blue dot with an
  accuracy ring, a flight to your position, and FOLLOW, which keeps the
  camera over you until you drag the map or another view takes the camera
  (zooming keeps it). It works without TAK and offline. The dot and TAK's
  Use device GPS share one device watch. The first fix marks the page
  session private like TAK self position, so camera-derived AI lookups,
  share links and recording stay blocked until allowed in the TAK panel. See
  `docs/MY-LOCATION.md`.

- TAK device GPS no longer switches itself off when the signal drops. A lost
  or slow fix (geolocation errors 2 and 3, as in a tunnel or building) used
  to stop the watch and report "permission denied"; the watch now continues
  and the next fix arrives on its own. Only a refused permission stops it.

- Start view: the Location tray has **Start here**, which makes the current
  view the one the app opens on in this browser, and **Reset** back to the
  default. Share links and saved map areas still take priority. The default
  is set per deployment with `VITE_GEV_START_VIEW` (`oxford`, `austin` or
  `lat,lon`); `.env.example` ships `oxford`, and builds without it keep
  Austin.

# TAK gateway: disconnected devices release their identity slot

- The gateway admits at most 32 distinct device identities at once, but it
  used to count every identity it had ever accepted. After 32 devices had
  connected over the server's lifetime (app reinstalls, cleared browser
  storage, new phones), every new device was refused until restart. An
  identity now frees its slot 10 minutes after its last connection closes.
  Within those 10 minutes a reconnect keeps the slot, and the device's own
  position heard back on the mesh (`TAK_MESH_LOOPBACK`) is still not taken
  as another device claiming that uid. Tabs sharing one identity hold it
  until the last one closes.

Review adjustments preserve saved-view privacy across reloads and account changes, report refused storage honestly, keep location FOLLOW above terrain and subordinate to newer camera actions, and bound identity retention after disconnect. Contribution by Claude; integration review and fixes by Codex.
