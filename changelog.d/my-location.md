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
