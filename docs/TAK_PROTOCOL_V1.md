# TAK Protocol Version 1 (protobuf)

Updated: 2026-10-17 UTC. Branch: `claude/code-analysis-completion-7i2fwk`, built on
`dev/tak-web-foundation` at `28eb0c9e`.

The gateway now **receives** TAK Protocol Version 1 on the ATAK mesh and can
**negotiate** it on a TAK Server streaming connection. Before this change, every
v1 datagram was counted and dropped. That matters on a modern mesh: under the
published mesh rules, devices send v1 when every contact they know advertises
it. A receive-only GEV gateway is not a known contact, so ATAK/WinTAK peers that
negotiated v1 among themselves were invisible to it.

This is local, synthetic-peer, independent-oracle and reference-source
evidence. It is **not** an observed exchange with ATAK-CIV, iTAK, WinTAK or a
running TAK Server; see [Remaining acceptance](#remaining-acceptance).

## What is implemented

| Path                   | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codec                  | [`src/tak/protocol/takProto.js`](../src/tak/protocol/takProto.js): bounded hand-written proto3 reader/writer for `TakMessage`, `TakControl`, `CotEvent`, `Detail` and its six structured sub-messages; mesh header `0xbf <version> 0xbf`; stream header `0xbf <length>`. TAK Server's four schema additions are recognized. No new dependency.                                                                           |
| Conversion to CoT      | Every decoded event is converted to CoT XML and validated by the existing parser and router, so a protobuf peer gets no path around XML validation, deduplication, rate limits or forwarding policy. `xmlDetail` is parsed by the strict XML reader and re-serialized, never spliced, so it cannot close `<detail>`. If an element appears both there and in its message form, `xmlDetail` wins, as the schema requires. |
| Conversion from CoT    | A detail element uses its structured form only when that form represents it completely: every attribute the schema names (only `contact`'s `endpoint` is optional), no others, no children/text, and numbers that survive. These are the official server's conversion rules. Everything else, including drawing vertices, travels whole in `xmlDetail` with its namespace declarations.                                  |
| Mesh receive           | [`meshLink.js`](../server/providers/tak/meshLink.js) decodes v1 datagrams and routes them like XML. Standalone `TakControl` advertisements are counted, not routed. Unsupported versions and malformed packets are counted separately.                                                                                                                                                                                   |
| Mesh send              | Unchanged: XML. The gateway advertises no `TakControl`, so spec-compliant peers that hear its SA keep the mesh at version 0, and every client must accept version 0.                                                                                                                                                                                                                                                     |
| TAK Server negotiation | [`serverLink.js`](../server/providers/tak/serverLink.js) reads bytes, not text. `t-x-takp-v/-q/-r` events are link control: they are consumed and never reach the router, browsers or a bridged mesh, with or without the opt-in.                                                                                                                                                                                        |
| Opt-in upgrade         | With `TAK_SERVER_PROTOBUF=1`, the link answers a v1 offer with the published request, holds outbound XML until answered, switches both directions to stream frames on acceptance, resumes XML on denial, and after 60 s without a response disconnects and stays on XML for that link's lifetime.                                                                                                                        |
| Flood bound            | The router rate-limits before it parses XML, but v1 decoding happens earlier. Each link therefore applies the router's own budget (mesh 100/s, burst 400; server 200/s, burst 1,000) before conversion, so a v1 flood costs no more work than the XML the router would accept.                                                                                                                                           |
| Partial decodes        | Unknown fields, which is how an unadvertised detail extension would arrive, are skipped and counted as `protobufIncomplete`. The operator sees `partly decoded <count>`, as the specification asks receivers to surface.                                                                                                                                                                                                 |
| Operator status        | The TAK panel uplink line shows `TAK v1`, `partly decoded` and `refused` counts for mesh, and `requesting TAK protocol v1` / `TAK protocol v1` for the server link. Gateway status adds `encoding`, `protocolOffered`, `protocolControl`, `protocolDenied`, `protocolErrors`, `protobufIncomplete` and `protobufLimited`.                                                                                                |

The default remains XML on TAK Server links. The [real-server transport
acceptance](TAK_REAL_SERVER_ACCEPTANCE.md) was recorded with XML, and the opt-in
keeps that verified path unchanged until v1 is observed against a running
server. Named multi-operator principals (`TAK_PRINCIPALS_FILE`) also stay on
XML: their strict file schema has no v1 option.

GEV's CoT model keeps no `caveat` or `releasableTo` event attributes, whether
they arrive as XML or v1. The v1 decoder writes them into the converted XML,
and the existing parser then drops them as before.

### Byte-accurate switching

After a request, the server may still send XML. It then sends its accepting
response, and "all future data" is binary, possibly in the same TCP chunk. While
a request is outstanding, the reader releases bytes only up to complete
`</event>` end tags and decides the mode before reading further. ASCII markup
never occurs inside UTF-8 multi-byte sequences, so this split is exact. A stray
newline after the response is tolerated. Any other non-frame byte poisons the
stream and the link reconnects, rather than guessing at a resynchronization
point that the framing does not have.

## Reference implementation alignment

The official TAK Server source at
[`5.7-RELEASE-14`](https://github.com/TAK-Product-Center/Server/tree/5187abd46d827d37cfc5708805eced197a837e49)
(GPLv3) is the same commit as the earlier [real-server
acceptance](TAK_REAL_SERVER_ACCEPTANCE.md). Its negotiation and conversion code
was **read, not run, and not copied**:
`NioNettyTlsServerHandler`, `NioNettyHandlerBase`,
`StreamingProtoBufOrCoTProtocol`, `StreamingProtoBufHelper` and
`takserver-protobuf/*.proto`. Findings and how GEV matches them:

| TAK Server 5.7 behavior                                                                                                                                                    | GEV                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Offers v1 only on `protocol="tls"` streaming inputs (`COTPROTOTLS`), which include the default `stdssl` input on 8089. `stcp`/`tcp` inputs stay XML.                       | Requests only when offered; XML otherwise.                                                                              |
| `protocol="prototls"` inputs are protobuf from the first byte, with no negotiation.                                                                                        | **Not supported**: use a `tls` input.                                                                                   |
| The offer uses single quotes, a `standalone='yes'` declaration, a random-UUID transaction and a `<TakServerVersionInfo>` sibling.                                          | Covered by a real-TCP test in that exact style.                                                                         |
| Reads `/event/detail/TakControl/TakRequest/@version` and compares it to `"1"`.                                                                                             | GEV sends `<TakControl><TakRequest version="1"/></TakControl>`, asserted in that test.                                  |
| Flushes the response, then switches its reader and writer; a client must not send between request and response.                                                            | Outbound is held while requested; the response and first frames may share one chunk.                                    |
| `proto2cot`: xmlDetail elements override the same structured element.                                                                                                      | Same rule.                                                                                                              |
| `cot2proto`: `status` needs only `battery`; `track` both; `__group` both; `precisionlocation` both; `takv` all four; `contact` needs `callsign`, with `endpoint` optional. | Same requirements; GEV additionally keeps elements with children/text whole.                                            |
| `TakMessage.submissionTime` (3) / `creationTime` (4) and `CotEvent.caveat` (16) / `releaseableTo` (17) extend the client schema.                                           | Recognized: not counted as unknown; caveat/releasableTo become event attributes; server times are not converted to CoT. |

Reading the source is not the same as running it. The earlier official-source
lab used XML only, and it noted an upstream protobuf patch-path warning that
this review did not investigate.

## Evidence

All results below were produced on 2026-10-17 with Node `24.14.0` on Linux.

### Independent wire oracle

[`scripts/tak-proto-oracle.py`](../scripts/tak-proto-oracle.py) builds four
messages field by field with Google protobuf `7.36.1` and the published TAK
client descriptors packaged by [`takproto`](https://github.com/snstac/takproto)
`3.0.1` (MIT). It deliberately does not use takproto's XML conversion. Its output
is committed as [`takProtoOracle.mjs`](../src/tak/protocol/takProtoOracle.mjs), so
CI needs no Python. The schema field numbers were dumped from those descriptors
and match this codec's table.

| Check                                                                | Result                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Decode each oracle payload field for field                           | Equal (4/4), including `-0.0` and a 2100-01-01 timestamp   |
| Encode the same values                                               | Byte-identical to the oracle (4/4)                         |
| Mesh datagram and stream frame bytes                                 | Byte-identical to takproto's `msg2proto` MESH/STREAM (4/4) |
| GEV's existing `ATAK_SA` XML fixture → payload                       | Byte-identical to the oracle's independently built message |
| Reverse: Python parses GEV-encoded peer fixtures and builder outputs | All 8 parsed with the expected field values                |

The reverse check was a one-off scratch run, not a committed test. The
byte-identity tests above cover the same direction in CI.

### Unit and socket tests

- [`takProto.test.mjs`](../src/tak/protocol/takProto.test.mjs), 40 tests:
  oracle identity; XML↔v1 round trips for every synthetic peer fixture and GEV
  builder; drawings; incomplete structured forms; namespaces; `xmlDetail`
  breakout, DTD/entity and loose-text refusal; `xmlDetail` precedence; TAK
  Server schema additions; missing times and non-finite positions; malformed
  varints, wire types, lengths, UTF-8 and integer ranges; unknown-field
  skipping, counting and message merging; size bounds; every truncation plus
  3,000 seeded mutations failing closed; mesh header versions; frame reassembly
  at chunk sizes 1, 2, 3, 5, 64 and whole; the specification's own negotiation
  examples; and the XML→binary switch at **every** two-chunk split position and
  byte by byte, with multi-byte UTF-8 before the response.
- [`takProtocolNegotiation.test.mjs`](../src/tooling/takProtocolNegotiation.test.mjs),
  7 tests over real loopback TCP against a synthetic server that follows the
  published steps, including a response and first frames in one write: accepted,
  TAK Server 5.7 wire style, not opted in, denied, timed out and
  broken-after-accept. A deliberate mutation that removed the boundary hold made
  the accepted case fail.
- [`takGateway.test.mjs`](../src/tooling/takGateway.test.mjs): oracle v1 mesh
  datagrams through the real mesh link, including partial-decode counting; a
  deterministic flood bound; and a v1 mesh SA through the real mesh link,
  router and WebSocket to a browser connection.

The browser lab result is recorded in
[the implementation plan](TAK_IMPLEMENTATION_PLAN.md#tak-protocol-v1-lab-run).

## Try it locally

```sh
npm run tak:lab -- --protobuf
```

The synthetic lab peer offers v1, accepts the gateway's request and then
exchanges binary frames. Open the printed URL, **TAK → Connect**, and share a
marker or send chat. The uplink line reads `TAK protocol v1` once negotiated.
Without `--protobuf`, the lab is unchanged. The browser gate for it is
`npm run qa:tak -- --url http://127.0.0.1:4174 --lab --protobuf`.

For an authorized TAK Server, add `TAK_SERVER_PROTOBUF=1` next to the existing
`TAK_SERVER*` settings and connect to a `tls` streaming input. If the server
never offers v1, nothing changes.

## Remaining acceptance

- Observe a real ATAK-CIV, WinTAK and iTAK mesh switching to v1, and confirm
  each client's SA, markers, chat and drawings arrive. Record client versions;
  one client's result does not establish another's.
- Negotiate with a running TAK Server `tls` input, for example in the
  official-source lab, and exchange markers and chat both ways over v1.
- Registered CoT detail extensions are not supported. The gateway advertises
  none and requests none, so a compliant server should not send them. An
  unexpected extension is skipped and counted as partly decoded; its content is
  lost.
- `prototls` inputs (protobuf from the first byte) are not supported.
- The gateway does not send v1 on the mesh, so it does not reduce mesh airtime.
  Doing so needs the full contact-tracking rules in the specification, and a
  measured reason to prefer it over the always-accepted XML.
