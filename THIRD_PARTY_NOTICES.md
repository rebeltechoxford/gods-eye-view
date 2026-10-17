# Third-party software notices

The project depends on third-party npm packages whose own licenses apply. This
file records the packages added for the browser-local SDR feature and the
Street Level viewer; the complete resolved dependency inventory remains in
`package-lock.json`.

## TAK gateway WebSocket transport

- Package: `ws` 8.21.3 (already locked; used only by the Node gateway and tests)
- Authors: Einar Otto Stangvik, Arnout Kazemier, Luigi Pinca and contributors
- Source: <https://github.com/websockets/ws>
- License: MIT; license text is distributed in `node_modules/ws/LICENSE`.

The private HTTPS host also uses `connect` 3.7.0 (MIT, Sencha Labs and
contributors; [source and license](https://github.com/senchalabs/connect)) to
retain the established GEV provider middleware order behind its authenticated
session. Its resolved dependencies and notices remain in `package-lock.json`
and the installed packages. It does not start a Vite development server.

The TAK protocol modules are independently written project code. No ATAK-CIV
application source, SDK binaries, plugin binaries, imagery or operational data
was incorporated. The official TAK wire-format specification is a protocol
reference, not a license to reuse application or plugin code. Existing imagery,
datasets and models retain the restrictions in `LICENSE`, `DATA_SOURCES.md`
and `public/models/README.md`, including the TeleGeography noncommercial data
carve-out. No new third-party dataset is added by the synthetic local lab.

## Web RTL-SDR

- Package: `@jtarrio/webrtlsdr` 3.0.6
- Author: Jacobo Tarrio Barreiro; portions copyright Google Inc.
- Source: <https://github.com/jtarrio/webrtlsdr>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## Signals

- Package: `@jtarrio/signals` 0.10.1
- Author: Jacobo Tarrio Barreiro
- Source: <https://github.com/jtarrio/signals>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## MapillaryJS

- Package: `mapillary-js` 4.1.2 (loaded on demand by the Street Level viewer,
  with its stylesheet `dist/mapillary.css`)
- Author: Copyright (c) Facebook, Inc. and its affiliates
- Source: <https://github.com/mapillary/mapillary-js>
- License: MIT
- License text: <https://github.com/mapillary/mapillary-js/blob/main/LICENSE>

## RxJS (MapillaryJS dependency)

- Package: `rxjs` 7.8.2
- Author: Google, Inc., Netflix, Inc., Microsoft Corp. and contributors
- Source: <https://github.com/ReactiveX/rxjs>
- License: Apache License 2.0
- License text: <https://www.apache.org/licenses/LICENSE-2.0>

## three.js (MapillaryJS dependency)

- Package: `three` 0.134.0
- Author: Copyright © 2010-2021 three.js authors
- Source: <https://github.com/mrdoob/three.js>
- License: MIT
- License text: <https://github.com/mrdoob/three.js/blob/dev/LICENSE>

## Self-hosted application fonts

The existing Inter, JetBrains Mono and Material Symbols Outlined fonts are
distributed under `public/fonts/` so the same application typography and icons
work without external font services. Font binaries are unchanged WOFF2 files
from the official Google Fonts CSS/CDN responses acquired on 2026-10-16. CSS
font URLs were changed to relative local paths; the existing requested weights,
Unicode coverage, icon names and static Material Symbols axes are retained.
These font files keep their respective licenses and are not relicensed as MIT.

- **Inter**: Copyright 2020 The Inter Project Authors
  (<https://github.com/rsms/inter>), SIL Open Font License 1.1. Full notice and
  license: `public/fonts/licenses/inter-OFL.txt`.
- **JetBrains Mono**: Copyright 2020 The JetBrains Mono Project Authors
  (<https://github.com/JetBrains/JetBrainsMono>), SIL Open Font License 1.1.
  Full notice and license: `public/fonts/licenses/jetbrains-mono-OFL.txt`.
- **Material Symbols Outlined**: Google Material Symbols, Apache License 2.0.
  [Official self-hosting and licensing guide](https://developers.google.com/fonts/docs/material_symbols).
  Full license: `public/fonts/licenses/material-symbols-Apache-2.0.txt`.
  [Upstream source](https://github.com/google/material-design-icons) contains no
  root `NOTICE` file at recorded commit `49d4db35df873165d6bd6ba09b063c7dafbac2f4`.

`public/fonts/provenance.json` records all 14 font asset URLs, byte lengths,
SHA256 hashes, CSS source hashes, the exact icon subset/axes, and pinned
upstream license URLs and hashes. The two OFL notices were taken from Google
Fonts commit `47d54ca1ebb14fd864695f1d39dc734f39017c33`; Material Symbols' Apache
license was taken from the recorded icon repository commit. The combined font
binary payload is 309,408 bytes. No font CDN request is required at runtime.
