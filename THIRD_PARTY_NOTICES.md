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

## FIS-B test data (fisb-decode)

- Files: `src/data/fixtures/fisb/tg28.978`, `tg29.978`, `tg30-subset.978` and
  the matching `*.level0.jsonl` decoder output (test-only, never shipped to
  the browser)
- Source: <https://github.com/rand-projects/fisb-decode>, commit `c3d3b04`
- License: BSD-2-Clause Plus Patent; the text follows.

The FIS-B decoder in `src/sources/fisb/` is independently written project code
(from the GDL 90 public ICD); it contains no fisb-decode code.

```text
[BSD-2-Clause Plus Patent License]

Copyright (C) 2020-2021 Michael Barnes

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

1. Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

Subject to the terms and conditions of this license, each copyright
holder and contributor hereby grants to those receiving rights under
this license a perpetual, worldwide, non-exclusive, no-charge,
royalty-free, irrevocable (except for failure to satisfy the
conditions of this license) patent license to make, have made, use,
offer to sell, sell, import, and otherwise transfer this software,
where such license applies only to those patent claims, already
acquired or hereafter acquired, licensable by such copyright holder or
contributor that are necessarily infringed by:

(a) their Contribution(s) (the licensed copyrights of copyright
holders and non-copyrightable additions of contributors, in source or
binary form) alone; or

(b) combination of their Contribution(s) with the work of authorship
to which such Contribution(s) was added by such copyright holder or
contributor, if, at the time the Contribution is added, such addition
causes such combination to be necessarily infringed. The patent
license shall not apply to any other combinations which include the
Contribution.

Except as expressly stated above, no rights or licenses from any
copyright holder or contributor is granted under this license, whether
expressly, by implication, estoppel or otherwise.

DISCLAIMER

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDERS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE
USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGE.
```
