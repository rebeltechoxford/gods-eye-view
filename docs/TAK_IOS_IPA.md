# iPhone build and iLoader sideloading

This candidate targets a normal device `.ipa` for **iLoader**. AltStore is not
required by the app. Installation signing belongs to iLoader and its configured
signing method; it is separate from connecting to a TAK server. The app contains
no Apple account login and no embedded operator credentials.

**Current status:** bundled local startup is implemented in source but has not
been compiled or accepted on an iPhone. Do not use the older portal-only IPA as
proof of this candidate. Direct native TAK/Mesh/MANET transport is not implemented.

## What opens on the phone

The first screen loads the complete production God’s Eye View build from the
application bundle, served on a read-only loopback origin. No remote gateway login
is required to open it. The build includes the upstream globe, layers, panels,
scenes, sharing, provider settings and voice UI, plus the fork's TAK controls.
Local assets, fonts and icons are included and inventoried with SHA-256 hashes.

A bundled application does not contain the world's map tiles or live feeds.
Network maps need their providers; live feeds, search proxies, voice sessions,
server map downloads and other `/api/` services still need a running backend.
The local server reports unavailable services explicitly. Provider keys and
service subscriptions retain their existing requirements.

The native server button offers **Configure server**. Enter the HTTPS origin of
a GEV TAK gateway, such as `https://gev.internal:8443`, then authenticate to that
gateway. This opens the gateway-hosted console; it is not a direct TAK TCP/TLS
connection from the bundled page. **Return to local app** leaves setup without
requiring a login. Local and gateway website storage have separate origins.

| Capability | Candidate status |
| --- | --- |
| Full current GEV frontend bundled | Implemented; web build checked |
| Open local UI without gateway authentication | Native source implemented; device acceptance pending |
| Existing TAK CoT, roster, markers, chat, drawings and packages | Web implementation retained; gateway required for transport |
| Foreground location | Web implementation; iPhone permissions/accuracy acceptance pending |
| Direct iPhone TAK TLS or LAN UDP multicast | Not implemented |
| Native radio/Mesh/MANET adapters | Not implemented |
| Background GPS or persistent background TAK connection | Not implemented |
| Reliable native offline map storage | Not implemented; existing web map storage is separate |
| Full ATAK/iTAK feature or plugin parity | Not established |

## Build the IPA on a Mac

Use Node 24.14+ in the 24.x line (or supported 26.x) and stable Xcode 26 with its
iOS SDK. From this checkout:

```sh
npm ci
bash scripts/build-ios-ipa.sh --smoke
```

If several Xcode versions are installed, set `DEVELOPER_DIR` to the selected
installation's `Contents/Developer` directory. The script builds the complete
web app, stages every `dist` asset, runs native origin-policy tests, archives an
unsigned ARM64 **device** app, validates the IPA and checks every bundled asset
against its manifest. `--smoke` also builds and launches the simulator target.
A simulator launch alone does not establish that the globe rendered or that
physical-device GPS, audio, offline recovery and TAK peers work.

Outputs:

- `output/ios/GEVTAK-unsigned.ipa`
- `output/ios/SHA256SUMS`
- `output/ios/provenance.json`
- `output/ios/simulator-setup.png` when using `--smoke`

No Apple signing account is needed to compile this unsigned artifact. The app
must be signed for the device during installation. Linux cannot run this build.

## GitHub Actions

The **iOS unsigned IPA** workflow in `.github/workflows/ios-ipa.yml` performs the
same build on macOS. It runs for the integration branch when application or
packaging files change, and can be dispatched manually. A successful run uploads
`GEVTAK-unsigned-<commit>` containing the files above. A workflow definition or a
push is not evidence that the build passed: inspect the run and its provenance.

## Install with iLoader

1. Obtain `GEVTAK-unsigned.ipa` from a successful build of this candidate. Check
   its checksum against `SHA256SUMS`.
2. Use iLoader's supported custom-IPA installation/signing flow with your paired
   iPhone. Any signing credentials or renewal steps belong to that installer.
3. Open GEV TAK. It should open its local interface without a server login.
4. Configure a reachable GEV TAK HTTPS gateway only when you want its online
   services. Trust the gateway's legitimate certificate on the device; normal
   remote TLS verification remains enabled.

Before treating this as a field release, test first launch without a network,
permission denial/retry, GPS stop/background behavior, gateway login/logout,
map availability, chat/CoT against a real peer, and exports on a physical iPhone.
Until those checks pass, this is a development candidate.
