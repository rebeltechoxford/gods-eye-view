# Device TAK picture

The TAK panel's **Device TAK Picture** section can retain one private historical
picture for the current operator on the current device. This supplements the live
session. It is not a server backup, mission package, shared picture or a position
reporting service.

1. Load authorized contacts or drawings through the gateway, local markers or an
   explicit CoT import. Check the device-retention consent box and choose **Save
   current picture**. Each save needs a fresh check and replaces the previous copy.
2. After reloading, choose **Restore saved picture**. Nothing restores
   automatically. The independent layer and list mark every item **HISTORY** and
   preserve the original observation, receipt and stale timestamps. Expired events
   stay visible as historical/expired; their timestamps are never refreshed.
3. **Hide historical picture** removes the displayed copy. **Delete saved picture**
   removes the account's saved copy from this device and hides it. The normal TAK
   Clear action hides historical items but does not delete the saved copy.

Saving captures only the latest contact/marker/drawing event, up to **500 items and
1 MiB** of encoded JSON. Own device position events, chat event records, position
trails, binary attachment contents, gateway credentials, local edit ownership and
outgoing messages are not retained by this feature. The retained CoT event includes its remarks and extensions, which
can themselves contain private information or attachment references; attachment
files are not fetched or copied. This is not a sanitizer for sensitive event detail.
The existing strict CoT/geometry parser and XML-node/vertex budgets apply
on both save and restore. Oversized or invalid pictures are rejected, never silently
truncated. Alongside the live store's 2,000 contacts / 8 MiB serialized-event budget,
this permits at most 2,500 live plus historical contacts and 9 MiB of those bounded
payloads; Cesium and parsed-object overhead is additional.

Restoration never inserts events into the live contact store, claims edit ownership,
connects the gateway or submits an outgoing message. Historical and live items with
the same CoT UID use distinct Cesium IDs, overlay sources and pick ownership. A new
live update does not silently change the retained picture.

## Account, privacy and offline behavior

The IndexedDB record is scoped by the gateway's operator storage scope. A different
operator cannot access it through the application. Single-operator local mode has
its own separate database. Logout/account invalidation aborts pending operations
and clears the visible copy; the disk record remains locked for that account.
Restoration marks the scene private before rendering it, so the existing AI, voice,
scene sharing/capture and recording disclosure gates apply. Hiding or deleting does
not automatically reauthorize sharing of a camera location already influenced by
private data.

**This is not application encryption or protection against someone with access to
the browser profile or same-origin code.** Retain data only on an authorized,
protected device. Browser settings, storage pressure or device cleanup may remove
IndexedDB data. Quota and storage failures are reported without claiming success.

For a server outage, first save the app shell using **Saved Maps** or **Offline
Roads** while signed into the approved account. That existing workflow explicitly
approves the offline operator context. Saving a picture does not save the app shell
or grant offline access. After an offline launch under the approved account,
Restore reads that account's local copy without a network request. Map imagery and
road downloads remain separately selected/licensed downloads.

## Validation scope

`src/tak/picture.test.mjs` covers timestamp preservation, excluded data, resource
bounds, account naming, explicit consent, private-before-render ordering, quota
errors and asynchronous cancellation. `src/tak/cotOverlay.test.mjs` covers default
layer compatibility and same-UID historical/live coexistence. The separate
`scripts/qa-tak-picture.mjs` gate exercises real Chromium IndexedDB, private HTTPS,
named-account separation and saved-shell offline restoration. Results must be
recorded for the tested commit; synthetic fixtures do not demonstrate interoperability
with an authorized ATAK/iTAK/WinTAK peer or prove physical phone storage reliability.
