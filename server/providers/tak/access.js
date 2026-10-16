import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

/** This milestone serves one operator, from the machine running the gateway. */
export function isLoopbackAddress(value) {
  const host = String(value || '')
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return host === '::1' || (isIP(host) === 4 && host.split('.')[0] === '127');
}

/** Check the real connection as well as browser headers; Host alone is not authority. */
export function authorizeLocalRequest(req, { requireOrigin = true } = {}) {
  const socket = req.socket;
  if (
    !socket ||
    !isLoopbackAddress(socket.remoteAddress) ||
    !isLoopbackAddress(socket.localAddress)
  )
    return { ok: false, status: 403, reason: 'loopback required' };
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
    (hostname !== 'localhost' && !isLoopbackAddress(hostname)) ||
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
