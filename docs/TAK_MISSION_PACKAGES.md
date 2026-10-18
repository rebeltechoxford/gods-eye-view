# Local TAK mission packages

The TAK panel's **Mission packages · local** section inspects and imports a bounded subset of version-2 TAK mission/data packages. This is local archive interchange, not the TAK Server mission service. It does not upload, synchronize, execute, or automatically open package contents. Actual acceptance by ATAK, iTAK and WinTAK remains unverified.

Choose a `.zip` or `.dp`, press **Inspect package**, review the contents and SHA-256, then press **Import inspected contacts locally**. Inspection alone changes no contacts. Every entry must pass validation before import is available. An import that would evict existing contacts or exceed the store's byte/node limits is refused before mutation. Older or identical contact updates remain unchanged. `ignore="true"` contacts are inspected but not applied. Contact staleness still follows the normal TAK store policy.

PNG, JPEG, PDF and UTF-8 TXT attachments are retained in page memory for an explicit **Save this attachment** action. They are never rendered or executed by GEV. File signatures and text encoding are checked; this is not malware scanning or PDF sanitization. Opening a downloaded file in another application is outside GEV's security boundary. HTML, SVG, scripts, preferences, certificates, executable files, nested archives and all other attachment types are refused. Imported manifest parameters never configure connections or fetch URLs.

To export, enter a name, check individual contacts and optionally choose allowed files. No contacts are selected automatically. Check **Allow this selected package to leave the app as a download**, then press **Export selected package**. The permission is consumed on that attempt and applies only to that selection. It does not authorize AI, screenshots, public sharing, recording or other disclosures. The exporter receives only the chosen snapshots and files, creates a fresh package UID, and does not call the network client. Files and selections are cleared on explicit package clear or session teardown; pending asynchronous operations are aborted before they can import or download. A download already handed to the browser cannot be recalled.

The chooser shows at most 150 filtered contacts and retains at most 127 selected UIDs. Changing the filter preserves deliberate selections; clearing removes them. Active download URLs are limited to four and 32 MiB combined, released after 30 seconds or an explicit clear. If that budget is reached, the next download is refused with a retry message.

## Format and limits

| Item                       | Supported boundary                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ZIP                        | Single-disk ZIP32, stored (0) or raw DEFLATE (8), including data descriptors and ordinary directory entries                                                                                          |
| Archive / expanded payload | 32 MiB each                                                                                                                                                                                          |
| Directory entries          | 128, including manifest and directories; exports contain at most 127 contents                                                                                                                        |
| One attachment             | 8 MiB, nonempty                                                                                                                                                                                      |
| Manifest                   | Exact `MANIFEST/manifest.xml`, version 2, at most 128 KiB                                                                                                                                            |
| CoT                        | One valid positioned event per `.cot`, at most the existing 64 KiB CoT event limit; contacts, markers, alerts and positioned drawings; no delete, cancel, chat or ping controls                      |
| Compression ratio          | At most 100:1 per entry, checked before inflation; actual output also bounded during streaming                                                                                                       |
| Names                      | UTF-8 or ASCII, relative forward-slash paths, normalized Unicode; no traversal, absolute/drive paths, reserved Windows device names, encoded paths, duplicate/case-alias names or filename overrides |
| ZIP integrity              | Matching local/directory metadata, ranges, descriptors, CRC-32 and expanded lengths; no hidden/overlapping data, encrypted entries, ZIP64, links or special files                                    |
| Hashes                     | SHA-256 for the whole package and each content; any supplied content `sha256` parameter must match                                                                                                   |

Hashes identify bytes; they do not authenticate the sender. Archives are never extracted to filesystem paths. All files must be listed exactly once in the manifest, and every listed file must exist. Unsupported content causes the entire inspection to fail. Unknown configuration parameters are inert metadata. Existing CoT extension XML is preserved by the shared parser and serializer; a positioned drawing's complete map rendering depends on GEV's separate drawing support.

Export uses stored ZIP entries to avoid a compressor dependency. Deflated imports use the browser's native streaming `DecompressionStream('deflate-raw')`; a browser without that format receives a clear error and can use a stored ZIP. Current Chromium is covered by the synthetic browser gate. Physical iPhone file selection, native WKDownload/Files behavior, browser-specific memory limits and live TAK client acceptance need device testing. The native shell's existing 256 MiB download cap exceeds this feature's 32 MiB package limit.

## Verification

Run with the repository's supported Node runtime:

```sh
node --test src/tak/packages.test.mjs
```

The suite uses a committed Python `zipfile` DEFLATE fixture and an independent adversarial archive encoder. It checks descriptor compatibility, malformed streams, in-flight cancellation, path/link/duplicate/encryption/ZIP64/bomb/CRC/hash rejection, complete validation before contact mutation, memory preflight and zero network transmissions. The fixture is synthetic and was not captured from an ATAK device.

After mounting the panel in the running local app, the browser gate exercises real phone touch controls, file inputs, download events, selected-only exports and clearing during an asynchronous read:

```sh
node scripts/qa-tak-packages.mjs --url http://127.0.0.1:4174
```

Evidence is written to `qa-artifacts/tak-packages/`. It contains synthetic data only. Server mission creation, attachment-to-marker associations, signed packages, arbitrary file import handlers, persistent tactical storage and peer/server package transfer are outside this implementation.

The combined integration passed all eight browser scenarios on Windows,
Node 24.19.0 and Chrome 152 at 2026-10-17 01:29 UTC. The actual touch/file/download
controls verified the 150-row contact chooser and 127-selection limit, stable
rows, Python DEFLATE fixture inspection, rejected-input atomicity, local-only
application, explicitly selected exports, consumed per-export consent, pending
file-read cancellation and teardown. The saved phone screenshot was inspected.
Evidence: `qa-artifacts/field-packages-final/` and
`.gev-cache/field-packages-final.log`. No physical phone or real TAK client was
used for this acceptance run.

An independent Python 3.12 `zipfile` / `ElementTree` / `hashlib` check also
passed 36 assertions against a current-API export containing one synthetic
contact and one selected TXT attachment. It validated ZIP CRCs, the version-2
manifest and UUID, exact entry selection, UID/callsign/coordinates/HAE, text
bytes and manifest/export SHA-256 values without using this app's ZIP reader.
Evidence is in `.gev-cache/mission-format-independent-20261017/`. This checks
file-format consistency, not acceptance by an operational TAK client.

## Format and licensing references

This is an original implementation using format facts from the official [ATAK-CIV MissionPackageManifest](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/main/atak/ATAK/app/src/main/java/com/atakmap/android/missionpackage/file/MissionPackageManifest.java), [MissionPackageContent](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/main/atak/ATAK/app/src/main/java/com/atakmap/android/missionpackage/file/MissionPackageContent.java), and [MissionPackageManifestAdapter](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/main/atak/ATAK/app/src/main/java/com/atakmap/android/missionpackage/file/MissionPackageManifestAdapter.java) definitions, plus the published [PKWARE ZIP APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT). ATAK-CIV's [GPL licensing](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/main/LICENSE.md) was reviewed: no ATAK source, archive fixture, imagery, plugin or third-party ZIP implementation is copied or bundled. No dependency or license change is introduced. The fixture and all new code are original repository material under the repository license.
