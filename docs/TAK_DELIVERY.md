# Network submission status

The TAK panel's **NETWORK SUBMISSIONS** section tracks explicitly shared markers, All Chat Rooms messages, self-position broadcasts, emergency changes and shared-marker deletes. A browser WebSocket write alone does not establish gateway authorization or TAK peer receipt.

| State     | Evidence                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending   | The browser accepted the bounded frame; gateway authorization is awaiting a response.                                                                                                                               |
| Queued    | The gateway authorized the event and at least one configured uplink is awaiting write completion. Each route's last result appears separately.                                                                      |
| Submitted | At least one local TCP/TLS socket write callback or UDP send callback succeeded, and no route remains queued. Other routes can have failed. This is **not a peer delivery or application receipt acknowledgement**. |
| Rejected  | Authorization, validation, routing, buffer/history capacity, cancellation or transport failure prevented confirmed submission. A connection loss can leave the outcome unconfirmed.                                 |
| Expired   | No local write success was confirmed within the fresh submission window. Peer receipt remains unconfirmed if a write had already started.                                                                           |

Only explicitly shared actions create a network submission. Imported CoT and unshared local markers never become outbound sends when connecting or reconnecting. An operator-armed position broadcast can create a **new**, fresh beacon after authenticated reconnect, subject to the existing foreground/GPS freshness rules. Chat and marker payloads are never automatically replayed by the browser.

## Gateway contract

After the existing authenticated identity acknowledgement, the browser may send:

```json
{ "op": "cot", "id": "request-1", "xml": "<event ...>...</event>" }
```

The ID is 1–64 ASCII letters, digits, underscores or hyphens. The existing 64 KiB WebSocket frame cap includes the JSON envelope and escaping overhead. The gateway replies with `op: "submission"`, the same ID, a state, up to two route results (`server` / `mesh`), and bounded optional reasons. It never echoes payloads, credentials or peer-delivery claims in these controls. The existing token/cookie authentication, identity ownership, browser allowlist, input limits and same-origin access policy apply unchanged. Canonical browser XML is rebuilt and parsed again before routing so preserved peer detail extensions and unknown attributes cannot be smuggled through browser submission tracking. Router ingress limits and receive/drop counters still apply.

An exact request-ID/payload repeat returns the cached result without republishing. Reusing an ID with different bytes closes that WebSocket with policy code 1008. This cache belongs to one browser connection, lasts at most 60 seconds, and is not a durable or global exactly-once protocol. Router deduplication remains a separate protection. Legacy raw XML clients remain supported with the same authorization, stripping and connection-owned queue cancellation; they do not receive correlated submission controls.

`{"op":"cancel-submissions"}` cancels the originating connection's unwritten submissions. It cannot cancel another connection's work or retract a write that already began. Closing the browser, clearing private client state, signing out or session revocation prevents its unwritten submissions from subsequently being flushed. The server link rechecks the originating connection and operator session immediately before each queued write, including legacy XML.

## Resource and lifecycle bounds

- Browser history holds at most 200 immutable metadata records in memory; the panel shows the newest 30. No CoT XML, chat bodies, coordinates, tokens or certificates are stored in that history. Contact labels are resolved from the existing contact store for display. Private-state clearing and destruction remove the history and its displayed rows.
- Each of at most 16 gateway WebSockets retains at most 256 correlated request records plus at most 256 outstanding legacy records. Correlated records contain a digest rather than an XML copy. A full request cache rejects new requests until records expire; it does not silently republish or discard tracked work.
- The upstream queue remains capped at 256 events / 1 MiB, with a 256 KiB socket write-buffer ceiling and at most 256 outstanding write callbacks. Queue retention expires after **30 seconds or CoT stale time, whichever comes first**, independently of reconnect backoff. Newer reports coalesce unwritten updates for the same contact; the superseded submission is rejected. Overflow, write failures and close callbacks produce bounded outcomes.
- Browser send buffering remains capped at 256 KiB; gateway browser output remains capped at 512 KiB. Existing frame, rate and connection limits include the new controls. No outbound browser payload queue or durable tactical outbox is introduced.
- Disconnected or expired attempts are never automatically retried by the page. A write that failed or lost its connection before completion is reported as unconfirmed and is not inserted back into the reconnect queue. Clearing or closing cannot retract bytes already handed to the operating system.

## Verification and limits

On Node 24, the focused delivery, client, transport, router, gateway and TLS suite passed **85 tests** before the focused checkpoint. It exercises real loopback WebSocket authorization/rejection and a real TCP outage → queue → reconnect → write callback, request idempotency, unknown browser attribute stripping, rejection of received foreign CoT re-submission, cancellation/disconnect/expiry, queue coalescing and capacity, immediately revoked writer checks, failed/late write callbacks, metadata limits and cleanup, transport framing/backpressure, and existing genuine local mutual-TLS trust/hostname/expired/client-certificate rejection tests. TLS fixtures are generated locally; no operational credentials or peer system is used.

These tests do not establish real ATAK/iTAK/WinTAK receipt or TAK Server application acceptance. The milestone does not implement peer ACK correlation, recipient-specific delivery, chat receipts, a durable offline send queue or end-user device background delivery. Those require a documented peer protocol and an authorized real-peer acceptance test. The integrated browser gate should additionally verify the visible submission rows, local-only action behavior, and clearing on session expiry; the focused checkpoint does not claim a new browser run.
