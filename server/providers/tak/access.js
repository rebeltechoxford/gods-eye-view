import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

/** This milestone serves one operator, from the machine running the gateway. */
export function isLoopbackAddress(value) {
  const host = String(value || '')
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
}

/** Browser access supports RFC1918 IPv4 and loopback, never public/link-local/CGNAT. */
export function isPrivateBrowserAddress(value) {
  const host = String(value || '')
    .toLowerCase()
    .replace(/^::ffff:/, '');
  if (isLoopbackAddress(host)) return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split('.').map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}

/** Only the production HTTPS listener opts into LAN access; Vite stays loopback. */
export function createBrowserAccessPolicy({
  mode = 'loopback',
  origin,
  bindHost,
  port,
} = {}) {
  if (mode === 'loopback') return Object.freeze({ mode });
  if (mode !== 'private-https')
    throw new Error('Unknown TAK browser access mode');
  if (
    typeof bindHost !== 'string' ||
    (bindHost !== 'localhost' && !isPrivateBrowserAddress(bindHost)) ||
    bindHost.startsWith('::ffff:')
  )
    throw new Error(
      'TAK_HTTPS_HOST must be localhost, loopback or an explicit RFC1918 IPv4 address',
    );
  const listenerPort = Number(port);
  if (
    !Number.isInteger(listenerPort) ||
    listenerPort < 1 ||
    listenerPort > 65535
  )
    throw new Error('TAK_HTTPS_PORT must be 1-65535');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('TAK_BROWSER_ORIGIN must be an exact HTTPS origin');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== origin ||
    Number(parsed.port || 443) !== listenerPort ||
    (isIP(hostname) && !isPrivateBrowserAddress(hostname)) ||
    (!isIP(hostname) &&
      !/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/.test(hostname))
  )
    throw new Error(
      'TAK_BROWSER_ORIGIN must pin the HTTPS listener authority and port',
    );
  return Object.freeze({ mode, origin, bindHost, port: listenerPort });
}

/** Check the real connection as well as browser headers; Host alone is not authority. */
export function authorizeBrowserRequest(
  req,
  policy = createBrowserAccessPolicy(),
  { requireOrigin = true } = {},
) {
  const socket = req.socket;
  const internal = policy?.mode === 'private-https';
  if (policy?.mode !== 'loopback' && !internal)
    return { ok: false, status: 403, reason: 'invalid browser access policy' };
  if (
    !socket ||
    !(internal
      ? isPrivateBrowserAddress(socket.remoteAddress)
      : isLoopbackAddress(socket.remoteAddress)) ||
    !(internal
      ? isPrivateBrowserAddress(socket.localAddress)
      : isLoopbackAddress(socket.localAddress))
  )
    return {
      ok: false,
      status: 403,
      reason: internal ? 'private connection required' : 'loopback required',
    };
  if (
    internal &&
    (!socket.encrypted ||
      socket.localPort !== policy.port ||
      (policy.bindHost === 'localhost'
        ? !isLoopbackAddress(socket.localAddress)
        : socket.localAddress.toLowerCase().replace(/^::ffff:/, '') !==
          policy.bindHost))
  )
    return {
      ok: false,
      status: 403,
      reason: 'private HTTPS listener mismatch',
    };
  if (
    Object.keys(req.headers || {}).some((name) =>
      /^(forwarded|x-forwarded-.*)$/i.test(name),
    )
  )
    return { ok: false, status: 403, reason: 'proxies are not supported' };
  const scheme = socket.encrypted ? 'https:' : 'http:';
  const host = req.headers?.host;
  if (typeof host !== 'string' || /[\s/@?#\\]/.test(host))
    return { ok: false, status: 403, reason: 'invalid host' };
  let target;
  try {
    target = new URL(`${scheme}//${host}`);
  } catch {
    return { ok: false, status: 403, reason: 'invalid host' };
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const port = Number(target.port || (scheme === 'https:' ? 443 : 80));
  if (
    internal
      ? target.origin !== policy.origin
      : (hostname !== 'localhost' && !isLoopbackAddress(hostname)) ||
        port !== socket.localPort
  )
    return {
      ok: false,
      status: 403,
      reason: 'host does not match local listener',
    };
  const fetchSite = req.headers?.['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none')
    return { ok: false, status: 403, reason: 'cross-origin' };
  const origin = req.headers?.origin;
  if (!origin && !requireOrigin) return { ok: true };
  if (typeof origin !== 'string' || origin !== target.origin)
    return { ok: false, status: 403, reason: 'cross-origin or missing origin' };
  return { ok: true };
}

export function authorizeLocalRequest(req, options) {
  return authorizeBrowserRequest(req, createBrowserAccessPolicy(), options);
}

export function matchesToken(candidate, token) {
  if (
    typeof token !== 'string' ||
    token.length < 24 ||
    typeof candidate !== 'string'
  )
    return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
