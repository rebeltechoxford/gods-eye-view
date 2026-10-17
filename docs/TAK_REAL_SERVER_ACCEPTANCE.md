# Real TAK Server transport acceptance

On **2026-10-17 UTC**, the actual GEV gateway exchanged synthetic markers and broadcast GeoChat through compiled official TAK Server code and an independent synthetic mutual-TLS peer. The eight checks below passed. This is **real-server / synthetic-wire-client acceptance**. It does not establish ATAK, iTAK, WinTAK, physical-phone, browser-UI or complete TAK protocol acceptance.

## Exact implementation tested

| Component                    | Version / provenance                                                                                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GEV gateway and CoT builders | `6c8a11a2d1fe72f7c169f8c70b23a6ca9a9595ce`; clean application checkout at test time                                                                                                                                                                    |
| Official TAK Server source   | [5.7-RELEASE-14](https://github.com/TAK-Product-Center/Server/tree/5187abd46d827d37cfc5708805eced197a837e49), commit `5187abd46d827d37cfc5708805eced197a837e49`                                                                                        |
| Server changes               | One Netty TCP bind changed from `bind(port)` to `bind("127.0.0.1", port)` in `NioNettyBuilder.java`; publisher checksum added for the unchanged Gradle ZIP. Combined patch SHA-256: `1620490b00c5ad14615dddb9aceac4595ad86530b15a63a1688d6a4805bf6ed3` |
| Java / Gradle                | User-scoped Adoptium JDK `17.0.20.1+1`; upstream wrapper Gradle `8.10.2`; Java source explicitly UTF-8; at most two workers                                                                                                                            |
| Database                     | User-scoped PostgreSQL `15.19`, PostGIS `3.6.2`, GEOS `3.14.1`, PROJ `8.2.1`; PROJ network disabled                                                                                                                                                    |
| Probe runtime                | Node `24.19.0` on Windows 11 x64; actual GEV `createTakGateway`, builders, serializer and WebSocket protocol                                                                                                                                           |
| Peer implementation          | Separate synthetic TLS sockets with fresh task-only client certificates and CoT XML framing; no native TAK client                                                                                                                                      |

The tested server is **official source modified for local confinement**, not a stock release distribution. No TAK implementation code, private key or privileged credential was copied into this repository.

## Results

The minimal run passed four checks at `03:34:11Z`. The subsequent complete transport run passed all eight at `03:35:28–03:35:34Z`:

1. Two authorized client certificates, assigned to separate server groups, completed verified mutual TLS and received the official server's XML `t-x-c-t-r` ping replies.
2. A client using the wrong server CA rejected the server without accepted CoT.
3. The server rejected a client certificate signed by an untrusted CA without accepted CoT.
4. The server rejected a connection lacking a client certificate without accepted CoT.
5. An authenticated synthetic WebSocket client registered its GEV identity. A marker built by the actual GEV builder passed through the actual gateway and official server to the authorized blue-group TLS peer with its latitude/longitude intact.
6. The simultaneously connected red-group peer did not receive that blue-group marker during the bounded observation interval.
7. The blue peer sent a correction with the same marker UID, changed callsign and coordinates. It returned through the official server and actual gateway to the originating WebSocket client correctly.
8. GEV broadcast GeoChat reached the blue peer; the peer's broadcast reply returned to GEV. The red-group peer did not receive the blue broadcast during the bounded observation interval.

Marker coordinates were explicit synthetic public points around the National Mall. No measured GPS, self-position report or operational contact was supplied. Chat's protocol placeholder point was not presented as an actual fix. These group tests cover the exercised marker/chat flows, not every server permission or mission authorization rule.

## Confinement, resource limits and cleanup

The lab used only newly generated synthetic certificates, users and groups. Federation, multicast, connectors, static destinations, announcements, persistent subscription reload and API web serving were disabled. The Spring application type remained `none`; no API/Tomcat fallback was enabled. Only the internal metrics bean required by official `MessagingConfiguration.actuatorMetricsService` was enabled. Ignite's update notifier and AWS instance metadata lookup were disabled; inherited JVM/proxy/AWS credential settings were cleared in child processes.

Before TLS clients connected, and repeatedly during each run, the launcher captured owned-process TCP/UDP endpoints and memory. In the complete run every observed listener used `127.0.0.1`: PostgreSQL `15432`; TAK TLS `18089`; Ignite `47580`, `47180/47181`, `10800/10801`, `11211`; and the synthetic gateway's ephemeral local HTTP/WebSocket port `54358`. No owned UDP endpoint or non-loopback connection was observed. Eight pure policy tests preserve rejection of unmatched wildcard bindings, PID/port mismatches, wildcard listeners/UDP and external peers. Windows non-listening `Bound` reservations are exempted only when the same snapshot independently shows the identical PID/local port established entirely on loopback.

Configured memory limits were config JVM heap/direct/metaspace `384/64/256 MiB`, messaging `768/128/256 MiB`, default Ignite cache region `32 MiB` initial / `128 MiB` maximum, and an additional Ignite internal system region `40/100 MiB`. Heap limits do not bound total process memory. The full run's ten measured snapshots peaked at **1,216.6 MiB aggregate working set** and **1,303.4 MiB private bytes**, including the launcher, database family and audit helper. The launcher abort budget was `2.75 GiB` working set with a `512 MiB` host-free-memory floor. These sampled figures are not a production capacity guarantee.

Both successful runs stopped the exact-owned JVMs and database. Their final snapshots had **zero child TCP/UDP endpoints**. No Windows service, firewall rule, OS certificate trust, global PATH, existing WinTAK profile or operational connection was changed.

## Build failures and local corrections retained

The upstream core passed **55 tests in 15 suites**, with no failures/errors/skips. Focused schema compilation and exact runtime-classpath export passed: core `343` entries, schema `112`, all present. Config and messaging were launched as separate official `tak.server.ServerConfiguration` profiles; the official `com.bbn.tak.schema.SchemaManager upgrade` prepared the database.

The complete WAR/distribution build **did not pass**: its separate React tool UI failed in ESLint's `jest/globals` environment because the resolved TypeScript ESLint helper threw `TypeFlags.Any` undefined. No lint or test was disabled. The upstream frontends have no tracked lockfile, and their locally resolved dependencies reported advisories. This isolated server lab is not a validated production installation. A nonfatal upstream protobuf patch-path warning was also retained; these exchanges used XML only and prove nothing about protobuf negotiation.

The first schema attempt exposed a portable dependency mismatch: the PostGIS bin overlay replaced PostgreSQL's OpenSSL DLLs with a version lacking `EVP_MD_CTX_get_size_ex`, which unchanged PostgreSQL `pgcrypto.dll` imports. The overlaid DLLs were preserved; only the matching original PostgreSQL SSL/crypto pair was restored from the retained archive. PostgreSQL, PostGIS projection and pgcrypto SHA-256 were then tested together successfully, with the digest checked independently using Node crypto. No OS DLL was replaced.

## Commands and retained evidence

All third-party tools, source, synthetic secrets and diagnostic launchers remain outside the repository in the task-local cache `C:\Users\jesse\.codex\cache\tak-real-acceptance-20261017`. That directory is an acceptance workspace, not a redistributable server package. The commands used there were:

```powershell
& $node24 "$labRoot\build-core-runtime.mjs"
& $node24 "$labRoot\prepare-runtime-args.mjs"
& $node24 "$labRoot\validate-database.mjs"
& $node24 "$labRoot\run-confined-runtime.mjs" --start --probe probe-real-server.mjs --tls-only
& $node24 "$labRoot\run-confined-runtime.mjs" --start --probe probe-real-server.mjs
```

`$node24` identifies the supported Node 24 executable; `$labRoot` identifies the cache above. The driver invokes the official schema main and separate `-Dspring.profiles.active=config` / `messaging` JVMs using hashed Java argument files and Gradle-exported runtime classpaths, with `--spring.main.web-application-type=none`. It refuses an existing external default `C:\opt\tak\CoreConfig.xml`, rechecks class/config/argument hashes, audits process families, and stops on confinement/resource failure. Do not reuse the fresh lab certificates as operational credentials.

Retained sanitized-result references under its `evidence` directory:

- `upstream-core-tests.json`, `runtime-classpaths.json`, `direct-runtime-command-plan.json`, `loopback-and-wrapper.patch`, `source-confinement.json`, `independent-confinement-review.json`.
- `postgres-openssl-import-audit.json`, `postgres-openssl-restoration.json`, `db-extensions-2026-10-17T03-19-28-579Z-*`.
- `runtime-socket-policy-tests.log` — eight passing policy regressions.
- `real-runtime-2026-10-17T03-33-34-681Z-*`, `real-server-minimal-tls.json`, `real-server-minimal-summary.json` — four passing minimal checks and teardown.
- `real-runtime-2026-10-17T03-34-51-876Z-*`, `real-server-probe.json`, `real-server-exchange-summary.json` — eight passing full transport checks, wire records, socket/memory samples and teardown.

Compiled Netty class SHA-256 is `846904e45bd0a1e06b6dbcf0cefe3b9840b9b32d83b4844256eb3f936ef01b21`; runtime-classpath snapshot SHA-256 is `3b3f76bdbcf06c20bc664063caf965e7e9fbb6c1ea81fd938f4fb575d77aae82`. Fresh CA/private keys, passwords, authentication configuration and full credential-bearing logs must remain outside Git.

## Remaining acceptance boundaries

### UID-routing experiment

A separate bounded experiment completed six observed scenarios at approximately `03:41Z`, using the same confined official-source server. It used two actual GEV WebSocket identities on one gateway uplink and observed actual TLS ingress before gateway policy filtering. Experimental endpoint controls were injected through the real server-link seam; they are **not** a shipped browser feature or a documented TAK registration API. No GPS/SA report was sent.

| Case                                                                    | Actual result                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two browser identities, explicit markers, SA off                        | Both markers reached the authorized peer; neither browser UID was registered for server-directed replies. Explicit directed messages to either UID did not reach the gateway TLS stream.           |
| First `t-x-c-t` control with that identity's UID and `contact@endpoint` | The official server registered the first UID. A peer's `<marti><dest uid="…"/></marti>` directed GeoChat reached the correct gateway TLS stream.                                                   |
| Second such control on the same stream                                  | It received a ping reply, but the second UID was not registered or reachable. The first UID remained reachable. Fresh identities on another shared stream repeated the first-only result.          |
| Separate real `createServerLink` TLS streams                            | Each stream registered its own UID and independently received its directed reply, with no cross delivery.                                                                                          |
| Fresh authorized late joiner, latest-SA enabled                         | The first registration **control** was replayed through the latest-SA path, still type `t-x-c-t`, with protocol placeholder point `0,0` and unknown altitude. The second control was not replayed. |
| Browser delivery                                                        | The existing gateway deliberately filtered directed chat. TLS routing observation does not imply working directed-chat UI or recipient authorization.                                              |

The runtime result matches the official [first-endpoint extractor](https://github.com/TAK-Product-Center/Server/blob/5187abd46d827d37cfc5708805eced197a837e49/src/takserver-core/src/main/java/com/bbn/marti/service/SubmissionService.java#L1666), its forced latest-SA tracking, and [explicit destination UID lookup](https://github.com/TAK-Product-Center/Server/blob/5187abd46d827d37cfc5708805eced197a837e49/src/takserver-core/src/main/java/com/bbn/marti/service/DistributedSubscriptionManager.java#L520). The control replay follows the server's [latest reachable SA sender](https://github.com/TAK-Product-Center/Server/blob/5187abd46d827d37cfc5708805eced197a837e49/src/takserver-core/src/main/java/com/bbn/marti/groups/MessagingUtilImpl.java#L129).

Evidence is `uid-routing-experiment.json` and `real-runtime-2026-10-17T03-40-14-016Z-*`. Eleven socket/memory snapshots peaked at `1,200.0 MiB` aggregate working set; no owned UDP endpoint was observed, and final child endpoints were zero. The experiment stopped all owned services.

This rules out assuming that multiple browser identities automatically gain directed return routes through one principal's TLS connection. Per-device streams solve the observed UID multiplexing problem, but the tested control also contaminates the latest-SA replay path. A production directed-chat design still needs an explicitly supported, privacy-reviewed identity registration mechanism or an explicitly authorized real/user-set position flow, plus recipient authorization, bounded connection ownership, native-client validation and delivery/read receipt tests. It must not silently publish a placeholder as a real position. Current UI/gateway intentionally supports broadcast chat only.

### Native clients and deployment

Installed signed WinTAK `5.8.0.147` was identified, but a supported isolated profile switch was not established; its normal profile was never opened. An isolated Android software-emulator route is plausible but unverified, resource constrained, and would require reviewing/accepting the applicable SDK/binary terms and verifying the actual APK contents/signature. Neither finding establishes native-device interoperability. Physical iPhone/iTAK/ATAK/WinTAK acceptance, production deployment, complete server distribution validation and full ATAK feature parity remain separate work.

A subsequent read-only check covered the installed 86-page `Assets/Support/WinTAK_SUM.pdf` (SHA-256 `88ecd8aac7b82b362f5f38da84057ef1697812e5ef27ba84248c6e75b236b775`). Its directory preferences concern imagery/overlay/terrain locations; its device-profile section describes provisioning ATAK devices. Neither establishes a separate WinTAK application profile or launch argument. Pages 11 and 82 were also rendered and inspected. The installed `WinTAK.exe.config` (SHA-256 `0c62af63b2a09cb746534a693ac420297fac03291538a8aa37794290ef1ad300`) declares default multicast/TCP inputs and multicast chat/SA outputs. This is configuration evidence, not an observation that those endpoints are currently active. No user-profile file was read, executable launched, environment redirect assumed sufficient or installed configuration changed. A documented isolated launch mechanism or a separate authorized OS/device test environment is still needed.

Official server source retains its [GPLv3 license and notices](https://github.com/TAK-Product-Center/Server/blob/5187abd46d827d37cfc5708805eced197a837e49/LICENSE.md). It ran as a separate local process; no Android/native implementation was relicensed or copied into the browser application.
