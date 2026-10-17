import { isIP } from 'node:net';
import { isLocalIpv4 } from '../../../src/data/tapAddress.js';

/**
 * TAK gateway configuration. Every upstream comes from operator-set
 * environment values; the browser never supplies an address, certificate or
 * multicast group. The gateway is OFF unless TAK_GATEWAY=1.
 *
 * | Variable                     | Meaning                                                   |
 * | ---------------------------- | --------------------------------------------------------- |
 * | TAK_GATEWAY=1                | Enable the gateway (WebSocket at /api/tak/ws)             |
 * | TAK_GATEWAY_TOKEN            | Required 24-128 character operator secret                |
 * | TAK_GATEWAY_LOCAL_BOOTSTRAP=1 | Let a local browser request the token on explicit Connect |
 * | TAK_MESH=1                   | Join the ATAK mesh (UDP multicast SA + GeoChat)           |
 * | TAK_MESH_GROUP / _PORT       | SA multicast, default 239.2.3.1:6969                      |
 * | TAK_CHAT_GROUP / _PORT       | GeoChat multicast, default 224.10.10.1:17012              |
 * | TAK_MESH_INTERFACE           | Local IPv4 of the NIC to join on (default: OS choice)     |
 * | TAK_MESH_TTL                 | Multicast TTL, default 1 (stay on the local segment)      |
 * | TAK_MESH_LOOPBACK=1          | Receive our own multicast (same-host ATAK/WinTAK testing) |
 * | TAK_SERVER=host:port         | TAK Server streaming input                                |
 * | TAK_SERVER_PROTOCOL          | tls (default) or tcp                                      |
 * | TAK_SERVER_CERT/_KEY/_CA     | PEM client cert, key and CA for mutual TLS                |
 * | TAK_SERVER_P12 / _PASSWORD   | PKCS#12 client bundle (alternative to PEM files)          |
 * | TAK_BRIDGE=1                 | Relay mesh <-> TAK Server (default: both feed browsers)   |
 * | TAK_GATEWAY_CALLSIGN         | Callsign of the gateway node itself                       |
 */

export const TAK_DEFAULTS = Object.freeze({
  meshGroup: '239.2.3.1',
  meshPort: 6969,
  chatGroup: '224.10.10.1',
  chatPort: 17012,
  meshTtl: 1,
  serverProtocol: 'tls',
});

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function port(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function multicastIpv4(value, fallback) {
  const v = String(value ?? '').trim() || fallback;
  if (isIP(v) !== 4) return null;
  const first = Number(v.split('.')[0]);
  return first >= 224 && first <= 239 ? v : null;
}

function hostPort(value) {
  const raw = String(value ?? '').trim();
  const match = /^\[?([A-Za-z0-9.\-:]+?)\]?:(\d{1,5})$/.exec(raw);
  if (!match) return null;
  const p = port(match[2], null);
  if (!p) return null;
  return { host: match[1], port: p };
}

/**
 * Parse configuration. Never throws: problems are returned in `errors` and the
 * affected uplink is disabled, so a typo cannot take the whole dev server down.
 * @param {Record<string,string|undefined>} env
 */
export function readTakGatewayConfig(env = process.env) {
  const errors = [];
  const enabled = flag(env.TAK_GATEWAY);
  const multiOperator = !!String(env.TAK_GATEWAY_USERS_FILE || '').trim();
  const token = String(env.TAK_GATEWAY_TOKEN ?? '').trim() || null;
  const tokenValid = !!token && /^[A-Za-z0-9._~-]{24,128}$/.test(token);
  if (enabled && multiOperator)
    errors.push(
      'Named principals require the private HTTPS host; the Vite/lab gateway stays disabled',
    );
  if (enabled && !tokenValid && !multiOperator)
    errors.push(
      'TAK_GATEWAY_TOKEN is required: use 24-128 characters of A-Z a-z 0-9 . _ ~ -; the gateway stays off until it is valid',
    );

  let mesh = null;
  if (flag(env.TAK_MESH)) {
    const group = multicastIpv4(env.TAK_MESH_GROUP, TAK_DEFAULTS.meshGroup);
    const chatGroup = multicastIpv4(env.TAK_CHAT_GROUP, TAK_DEFAULTS.chatGroup);
    const meshPort = port(env.TAK_MESH_PORT, TAK_DEFAULTS.meshPort);
    const chatPort = port(env.TAK_CHAT_PORT, TAK_DEFAULTS.chatPort);
    const iface = String(env.TAK_MESH_INTERFACE ?? '').trim() || null;
    const ttl =
      env.TAK_MESH_TTL === undefined || env.TAK_MESH_TTL === ''
        ? TAK_DEFAULTS.meshTtl
        : Number(env.TAK_MESH_TTL);
    if (!group) errors.push('TAK_MESH_GROUP must be an IPv4 multicast address');
    if (!chatGroup)
      errors.push('TAK_CHAT_GROUP must be an IPv4 multicast address');
    if (!meshPort) errors.push('TAK_MESH_PORT must be 1-65535');
    if (!chatPort) errors.push('TAK_CHAT_PORT must be 1-65535');
    if (iface && isIP(iface) !== 4)
      errors.push('TAK_MESH_INTERFACE must be a local IPv4 address');
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 32)
      errors.push('TAK_MESH_TTL must be 1-32');
    if (
      group &&
      chatGroup &&
      meshPort &&
      chatPort &&
      (!iface || isIP(iface) === 4) &&
      Number.isInteger(ttl) &&
      ttl >= 1 &&
      ttl <= 32
    ) {
      mesh = Object.freeze({
        group,
        port: meshPort,
        chatGroup,
        chatPort,
        iface,
        ttl,
        loopback: flag(env.TAK_MESH_LOOPBACK),
      });
    }
  }

  let server = null;
  if (String(env.TAK_SERVER ?? '').trim()) {
    const address = hostPort(env.TAK_SERVER);
    const protocol = String(
      env.TAK_SERVER_PROTOCOL || TAK_DEFAULTS.serverProtocol,
    ).toLowerCase();
    if (!address) errors.push('TAK_SERVER must be host:port');
    else if (protocol !== 'tls' && protocol !== 'tcp')
      errors.push('TAK_SERVER_PROTOCOL must be tls or tcp');
    else if (
      protocol === 'tcp' &&
      address.host !== 'localhost' &&
      address.host !== '::1' &&
      !(isIP(address.host) === 4 && isLocalIpv4(address.host))
    )
      errors.push(
        'Plain tcp requires a literal loopback/RFC1918 address or localhost; use verified TLS for other hosts',
      );
    else {
      const tls =
        protocol === 'tls'
          ? Object.freeze({
              cert: String(env.TAK_SERVER_CERT ?? '').trim() || null,
              key: String(env.TAK_SERVER_KEY ?? '').trim() || null,
              ca: String(env.TAK_SERVER_CA ?? '').trim() || null,
              p12: String(env.TAK_SERVER_P12 ?? '').trim() || null,
              p12Password: env.TAK_SERVER_P12_PASSWORD ?? null,
            })
          : null;
      if (tls && !tls.p12 && !(tls.cert && tls.key))
        errors.push(
          'TAK_SERVER tls requires TAK_SERVER_CERT+TAK_SERVER_KEY or TAK_SERVER_P12',
        );
      else server = Object.freeze({ ...address, protocol, tls });
    }
  }

  return Object.freeze({
    enabled: enabled && tokenValid && !multiOperator,
    token: tokenValid ? token : null,
    localBootstrap: flag(env.TAK_GATEWAY_LOCAL_BOOTSTRAP),
    deviceStreams: flag(env.TAK_DEVICE_STREAMS),
    principal: 'local-operator',
    mesh,
    server,
    bridge: flag(env.TAK_BRIDGE),
    callsign:
      String(env.TAK_GATEWAY_CALLSIGN ?? '')
        .trim()
        .slice(0, 40) || 'GEV-GATEWAY',
    errors: Object.freeze(errors),
  });
}
