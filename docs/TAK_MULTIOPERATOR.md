# Private HTTPS named operators

The private HTTPS host supports up to eight named operators. Every enabled
operator has a separate TAK gateway, replay cache, device/marker ownership
table, router, submission queue and authenticated TLS upstream. This mode is
opt-in with `TAK_GATEWAY_USERS_FILE`; the existing single-operator HTTPS host
and loopback lab keep their original configuration.

This is a server authorization boundary. A browser cannot select a principal
with a query parameter, header, identity UID, callsign, team or CoT group tag.
The server selects it from the authenticated HttpOnly cookie. Different
operators can use the same device UID without sharing local ownership tables.
Devices signed in as the **same** operator intentionally share that operator's
authorized stream and replay.

## Configure the private host

Keep the users JSON, client keys and certificates outside the checkout and
outside `dist`. Protect them with the server account's filesystem permissions.
Set the existing trusted HTTPS listener configuration and the users file:

```dotenv
TAK_HTTPS_HOST=127.0.0.1
TAK_HTTPS_PORT=8443
TAK_BROWSER_ORIGIN=https://localhost:8443
TAK_HTTPS_CERT=/operator-managed/https-server.pem
TAK_HTTPS_KEY=/operator-managed/https-server.key
TAK_GATEWAY_USERS_FILE=/operator-managed/tak-users.json
```

An explicitly pinned RFC1918 listener remains possible under the private-host
rules. A certificate trusted by the EUD and matching the configured HTTPS
origin is required. Public/wildcard listeners and reverse proxies remain
unsupported. Start the built application with `npm run tak:serve` using the
supported Node runtime; see [HOW_TO_RUN.md](../HOW_TO_RUN.md) for the existing
build and certificate setup.

The JSON schema is deliberately closed. Replace the hash placeholders and
paths before starting; paths are relative to the JSON file unless absolute:

```json
{
  "schemaVersion": 1,
  "principals": [
    {
      "id": "alpha",
      "role": "operator",
      "enabled": true,
      "tokenSha256": "REPLACE_WITH_64_LOWERCASE_HEX_SHA256",
      "server": {
        "host": "tak.authorized.internal",
        "port": 8089,
        "cert": "alpha-client.pem",
        "key": "alpha-client.key",
        "ca": "tak-server-ca.pem"
      }
    },
    {
      "id": "bravo",
      "role": "observer",
      "enabled": true,
      "tokenSha256": "REPLACE_WITH_A_DIFFERENT_64_LOWERCASE_HEX_SHA256",
      "server": {
        "host": "tak.authorized.internal",
        "port": 8089,
        "cert": "bravo-client.pem",
        "key": "bravo-client.key",
        "ca": "tak-server-ca.pem"
      }
    }
  ]
}
```

IDs contain 1–32 lowercase letters, digits or hyphens, starting with a letter.
They are permanent account ownership identifiers: **do not assign a retired
ID to another person**. Disabled entries retain their ID, role and token hash
but can omit `server`.

Generate a different unpredictable login token for each person. This local
Node command prints a token and its matching configuration hash; handle its
output as a secret, provide only the token to that person, and save only the
hash in the users JSON:

```sh
node --input-type=module -e "import {randomBytes,createHash} from 'node:crypto'; const token=randomBytes(32).toString('base64url'); console.log(JSON.stringify({token,tokenSha256:createHash('sha256').update(token).digest('hex')}));"
```

The login token is sent only over the trusted HTTPS connection and is compared
using a constant-time SHA-256 comparison. It is never returned by the server,
stored in a cookie, written to a URL or included in the frontend bundle. Login
requires both the account name and its token. The shared legacy gateway token
does not authorize a named account. The native login form exposes no account
list; failed logins have the same generic response.

Named mode requires fixed PEM mutual TLS per enabled principal. It rejects
reused client certificate fingerprints, public keys or normalized common
names, expired certificates and key/certificate mismatches. Credential files
are loaded into a bounded server-only snapshot, so changing a PEM on disk
does not silently alter a future reconnect; explicitly reload or restart.
TLS still validates the remote certificate chain and hostname. Plain TCP,
PKCS#12, global `TAK_SERVER`, multicast and bridging are unavailable in this
mode. Vite/lab refuses to enable a shared gateway when a users file is set.

## Roles, sessions and revocation

`operator` can publish the gateway's existing allowlisted, owned CoT actions.
`observer` receives its authorized stream but every browser-originated CoT
publication is rejected at the gateway, including raw XML, position, marker,
chat, emergency and delete submissions. Observer status does not prohibit local
map use, local-only work or downloading public offline maps. No administrator
role or remote configuration endpoint is added.

Cookies remain random, HttpOnly, Secure and SameSite=Strict, with the existing
eight-hour absolute/session expiry. There are at most 32 HTTPS sessions total,
four per named principal, and four gateway WebSockets per principal. Login
attempts share the existing bounded server rate limit. Signing out revokes
only that cookie and its sockets; other devices and operators stay signed in.

The server API exposes `app.reloadPrincipals()` for its local owner. The CLI
handles `SIGHUP` where supported; restart the process on Windows. There is no
HTTP reload endpoint. An unchanged snapshot preserves its sessions/gateway.
Disabling/removing an account or changing its role, login hash, upstream or
loaded PEM material invalidates that account's sessions and destroys its old
gateway, replay, ownership and unwritten submissions. Its open WSS receives
1008 `session expired`; bytes already submitted cannot be retracted.

A malformed reload revokes **all** named sessions and gateways. Access remains
closed until a complete valid reload or restart succeeds. It never falls back
to the legacy token or continues with stale authorized sockets.

Authenticated `GET /api/tak/status` supplies the frontend context before TAK
boot:

```json
{
  "enabled": true,
  "sessionAuthenticated": true,
  "multiOperator": true,
  "principal": "alpha",
  "role": "operator",
  "storageScope": "<opaque 64-character lowercase hexadecimal value>"
}
```

The opaque scope is stable for the same account/configuration snapshot across
restart and changes when its credential/authorization generation changes.
Neither credentials nor credential paths are exposed. An unauthenticated
private status request returns generic 401 without a principal or scope.
Legacy/lab status remains compatible and omits the new named-mode fields.
The browser must establish the current authenticated scope before restoring
account-specific local identity or offline metadata; saved offline authority
must never override an online 401/403 or changed scope.

Named requests also bind their expected context to the server's current cookie:
`POST /logout` and every `/api/maps/offline/*` request, including the static
shell manifest, require one `X-TAK-Storage-Scope: <storageScope>` header. Missing,
malformed, repeated or mismatched scopes return HTTP 409 with JSON code
`operator-context-changed` and `X-TAK-Account-Context: mismatch` before reading
account maps, mutating them or revoking a session. The status bootstrap stays
unbound so a new page can discover its current authenticated account.

Named WSS upgrades require `tak.v1` and exactly one additional subprotocol,
`tak.scope.<storageScope>`. A missing, invalid, multiple or mismatched scope
is rejected with HTTP 401 before any identity acknowledgement, replay or
publication. The scope is nonsecret and grants no authority by itself; the
authenticated cookie and all origin/socket checks remain mandatory. This
prevents an old tab from acting as a new account when another tab changes the
shared HttpOnly cookie before its storage event arrives. Legacy requests and
WSS clients retain their existing contract.

## Resource and offline-map ownership limits

Each principal inherits the existing bounded CoT input, rate, replay and
submission limits: 2,000 replay contacts / 8 MiB XML, 64 KiB browser frames,
512 KiB browser output buffering and a 256-event / 1 MiB upstream queue with
30-second freshness. It cannot inspect another principal's router statistics,
queue, replay or device/marker ownership. No event is broadcast between these
gateway instances. The HTTPS listener remains capped at 64 TCP connections.

Server offline packs are stored below `<TAK_MAP_PACKS_DIR>/operators/<id>`.
The cookie selects the directory; request URLs and manifests cannot do so.
Each retained account is capped at 256 MiB total, 128 MiB per pack, eight packs
and one active tile worker. Lower server-injected limits remain effective.
The fixed USGS source, tile validation, hash verification and path protections
remain unchanged.

Eight durable account reservations also count retired accounts. Exhaustion or
malformed reservations fails closed without deleting existing work. This
bounds named cache allocations to eight 256 MiB stores plus small reservation
metadata. It does not claim to bound a pre-existing legacy cache, arbitrary
administrator-created files or the whole filesystem. Stopping/restarting or
changing credentials preserves an account's public map cache. Freeing retired
space is an explicit administrator maintenance task while the host is stopped;
there is no automatic account-data migration or deletion.

## TAK Server groups and verification

TAK Server uses X.509 client/server authentication; its official
[server documentation](https://github.com/TAK-Product-Center/Server) describes
the mutual TLS boundary. Its
[X509 authenticator](https://github.com/TAK-Product-Center/Server/blob/main/src/takserver-core/src/main/java/com/bbn/marti/groups/X509Authenticator.java)
resolves certificate identities and configured users, then assigns file/LDAP
groups. Its
[authentication schema](https://github.com/TAK-Product-Center/Server/blob/main/src/takserver-common/src/main/xsd/UserAuthenticationFile.xsd)
defines directional group membership separately from CoT labels. No TAK code
was copied into this implementation.

Distinct certificates alone do **not** prove disjoint TAK Server groups. The
TAK administrator must provision each certificate as the intended server user
with correct IN/OUT memberships, read-only policy where desired, revocation
and anonymous/fallback settings. Authorized overlapping groups may correctly
deliver the same event to several principals. The web gateway cannot infer or
grant server group membership from team colors, callsigns or untrusted XML.

The focused Node 24 suite passed **59 tests** across the HTTPS host, gateway,
real local TLS rejection tests and the seven named-principal scenarios. These
use generated local CAs/client certificates and real loopback HTTPS, WSS and
mutual-TLS sockets. They verify separate certificate connections, stream/replay
and identity isolation, observer rejection, own-principal reconnect/queue
state, logout/expiry, credential rotation, invalid-reload queue cancellation,
session caps, cache ownership and eight retained storage reservations.

No operational TAK Server or physical EUD was connected. Genuine server group
membership, operator provisioning and real peer interoperability require an
authorized server and its issued per-user credentials. Browser account-switch
and offline-restoration acceptance belong to the integrated browser gate and
must be recorded separately from this server test evidence.
