# Private phone EUD foundation

This milestone adds an installable, standalone phone interface to the existing
GEV globe and TAK workflows. It does not claim complete ATAK functionality,
field-grade offline operation, or verified Android/iPhone hardware acceptance.
The complete parity inventory is [TAK_FEATURE_MATRIX.md](TAK_FEATURE_MATRIX.md).

## Use on a phone

1. Use the approved **private HTTPS** application address through your private
   network/VPN and authenticate. The phone must trust the server certificate.
   A desktop's `localhost` address points to the phone itself when opened there.
2. Open the TAK panel. On supported Android browsers, **Install EUD** opens the
   browser's install prompt when available. Otherwise use the browser menu.
   On iPhone/iPad use **Share → Add to Home Screen**. Installation does not grant
   TAK access or transmit a location.
3. Connect explicitly to the authenticated gateway. **LIVE** means the gateway
   has acknowledged this browser identity; peer delivery remains unconfirmed.
   **OFFLINE** and **LOCAL** are distinct from an established gateway link.
4. Choose **Use device GPS**, grant the browser location permission, and keep
   the app visible. Review the displayed source, reported accuracy, measured
   age and FRESH/STALE state before enabling position broadcast.
5. Enable **Broadcast my position** only when intended. GPS reports older than
   30 seconds and GPS reports while the document is hidden are not republished
   as freshly dated CoT. A fresh visible fix resumes an armed broadcast.
6. Use **Sign out** under NETWORK before leaving a shared phone. It clears local
   tactical state and asks the server to revoke the HttpOnly session. A failed
   server sign-out is reported as unconfirmed. Explicit server session expiry
   clears tactical state and returns the app to the login screen.

**Set to map center** creates an operator-set position, labeled **OPERATOR SET**
and encoded as USER position source. It is not a device GPS measurement.
Browser accuracy is the device-reported value, not an independently verified
tactical accuracy estimate. Missing altitude remains unknown; available browser
altitude is treated as height above the WGS84 ellipsoid.

## What is available

| Capability                                             | Android browser / installed web app                                                               | iPhone/iPad browser / home-screen app                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Existing GEV globe, controls and public layers         | Existing web features retained; performance depends on device, GPU and providers                  | Same; verify on target Safari/device                                |
| Home-screen launch and standalone manifest             | Install prompt when supported; browser menu fallback                                              | Share-menu home-screen installation; no programmatic install prompt |
| Foreground device location                             | Permission and secure context required                                                            | Permission and secure context required                              |
| GPS source, reported accuracy and age                  | Visible; stale/hidden GPS broadcasts suppressed                                                   | Same                                                                |
| Contact/import/marker/roster/chat workflows            | Current web implementation, through authorized gateway when connected                             | Same                                                                |
| Background or screen-locked GPS                        | Not implemented or promised; owned watch pauses when hidden                                       | Not implemented or promised; owned watch pauses when hidden         |
| Background networking / guaranteed reconnect timing    | Browser and OS may suspend execution                                                              | Browser and OS may suspend execution                                |
| Offline launch                                         | Fixed reconnect screen if network navigation fails                                                | Same where service workers are supported                            |
| Offline maps, mission packages, durable contacts/chat  | Not implemented                                                                                   | Not implemented                                                     |
| Radios, MANET, USB/Bluetooth sensors or vendor plugins | Require separately designed supported bridge/native companion where browser APIs are insufficient | Same; device/browser restrictions differ                            |
| Native ATAK/iTAK plugin parity                         | Not implemented by installation                                                                   | Not implemented by installation                                     |

Installation is optional: the same app remains usable in a supported browser.
The manifest uses generated PNGs derived from the repository's existing MIT
`public/logo.svg`; it does not incorporate ATAK assets or Android source.

## Privacy and offline behavior

The service worker uses network-only navigation and returns a fixed, generic
reconnect document on network failure. It creates **no CacheStorage or
IndexedDB records** and does not intercept API calls, WebSockets, asset downloads,
queried URLs or files. It never stores CoT, positions, chat, attachments, tokens,
certificates, keys, authenticated HTML or mission data. Production registration
uses the same origin and does not add a network listener or public service.
The browser's own ordinary storage/cache is separate from this worker policy.

TAK contacts, messages and fixes remain page-memory data. Closing/reloading the
page does not restore a mission. The existing stable browser identity is the
only TAK convenience data intentionally retained by the client. Imported or
unshared data does not gain network sharing merely because the app is installed.
Each marker starts unshared. Select **Share with network** explicitly for that
marker; submitting the form resets that choice to unchecked for the next marker.
Existing TAK session disclosure protection still blocks app-owned AI captures,
public links, scene capture/export and recording until explicitly authorized.

The app cannot prevent operating-system screenshots, an external recorder, or
a person sharing the screen. Existing public map/imagery providers can receive
requests for the area being viewed; a strict disconnected deployment needs an
audited, licensed private/offline map source, which is a later capability.

## Private HTTPS prerequisites

Follow [HOW_TO_RUN.md](../HOW_TO_RUN.md) and the private HTTPS server instructions
added for this branch. Do not expose the development server or its local token
bootstrap as a phone deployment. Required deployment properties include:

- A private address reachable only on approved interfaces/networks or VPN;
  explicit allowed hosts/origins; no public deployment or port forwarding.
- A trusted server certificate with the phone's exact DNS name/IP in its SAN,
  protected private key outside Git/public assets, and valid dates/chain.
- Authentication protecting the application and APIs, secure same-site session
  cookies, authenticated WSS, and server-side authorization of CoT commands.
- TAK Server client certificates and privileged credentials retained only by
  the gateway, with upstream certificate/hostname validation enabled.
- Verification on the actual Android/iPhone models, including install,
  foreground GPS permission, stale fixes, keyboard/safe-area layout, reconnect,
  peer exchange and denial cases. Desktop phone emulation is not this evidence.

No phone connection, public deployment, certificate purchase, or unauthorized
TAK connection is performed by adding this foundation.

## Verification and platform references

Targeted tests exercise foreground watch pause/resume/teardown, measured GPS
timestamps, stale/hidden beacon suppression, explicit install prompt lifecycle,
clean manifest/icons and service-worker noninterception/nonpersistence. Browser
acceptance checks cover phone-sized controls, stable roster buttons, private
disclosure protection and bounded contact focus. Real hardware and operational
TAK peer acceptance remain separate required evidence.

After `npm run build`, `npm run qa:tak:private` exercises the production app on
an ephemeral loopback HTTPS server with generated test certificates. Chromium
trust is pinned only to that run's synthetic certificate public key; it does
not change the system trust store. The gate checks the login wall, credentialed
manifest, worker, cookie-only Connect, phone controls, synthetic GPS freshness,
generic offline navigation, logout and both connected/disconnected session
expiry. Provider requests are intercepted and no TAK uplink is configured.
Sanitized results and synthetic screenshots are written to
`qa-artifacts/tak-private/`. This does not establish trusted TLS or operation on
a physical phone.

Browser installation and HTTPS requirements are described in
[MDN's installability guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).
Device location permission and secure-context behavior are specified by the
[Geolocation API](https://www.w3.org/TR/geolocation/) and the
[watchPosition reference](https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition).
These platform capabilities do not provide a background location guarantee.
