#!/usr/bin/env node
/** Private HTTPS host for built GEV assets and the existing provider middleware. */
import https from 'node:https';
import { randomBytes, X509Certificate } from 'node:crypto';
import { createReadStream, constants, existsSync, readFileSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { isIP } from 'node:net';
import connect from 'connect';
import { WebSocketServer } from 'ws';
import { localProviderPlugins } from '../providers/local.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { readTakGatewayConfig } from '../providers/tak/config.js';
import { createTakGateway } from '../providers/tak/gateway.js';
import {
  readTakPrincipals,
  authenticateTakPrincipal,
  principalGatewayConfig,
  MAX_PRINCIPAL_SESSIONS,
} from '../providers/tak/principals.js';
import {
  createPrincipalMapRoots,
  PRINCIPAL_MAP_LIMITS,
} from '../providers/tak/principalMaps.js';
import {
  authorizeBrowserRequest,
  createBrowserAccessPolicy,
  isLoopbackAddress,
  isPrivateBrowserAddress,
  matchesToken,
} from '../providers/tak/access.js';
import { createRateLimiter } from '../../src/tak/protocol/router.js';
import {
  createOfflinePackStore,
  defaultOfflinePackRoot,
} from '../maps/offline/store.js';
import {
  createOfflineMapsHandler,
  isOfflineMapsRequest,
} from '../maps/offline/http.js';
import { createOfflineShellManifest } from '../maps/offline/shell.js';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const SESSION_COOKIE = '__Host-gev-tak-session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_HTTPS_SESSIONS = 32;
// Mirrors the established GEV browser policy, without loading Vite in production.
export const HTTPS_BROWSER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' blob: https://www.youtube.com https://connect.facebook.net https://platform.twitter.com https://maps.googleapis.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' blob: data: https: wss: ws:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com https://www.facebook.com https://platform.twitter.com",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.geojsonl': 'application/x-ndjson; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.kml': 'application/vnd.google-earth.kml+xml',
  '.czml': 'application/json',
  '.csv': 'text/csv',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.ktx2': 'image/ktx2',
  '.crn': 'application/octet-stream',
  '.basis': 'application/octet-stream',
  '.terrain': 'application/octet-stream',
  '.b3dm': 'application/octet-stream',
  '.i3dm': 'application/octet-stream',
  '.pnts': 'application/octet-stream',
  '.cmpt': 'application/octet-stream',
  '.pbf': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};
const ROOT_FILES = new Set(['index.html', 'manifest.webmanifest', 'gev-sw.js']);
const ASSET_DIRECTORIES = new Set([
  'assets',
  'cesium',
  'events',
  'fonts',
  'models',
  'panel',
  'pwa',
]);
const LOGIN_PAGE =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>God’s Eye View · Internal access</title><main><h1>God’s Eye View</h1><p>Unlock this private console with your operator token.</p><form method="post" action="/login"><label>Operator token <input type="password" name="token" autocomplete="current-password" required minlength="24" maxlength="128"></label><button type="submit">Unlock console</button></form></main></html>';

function safePath(url) {
  const raw = String(url || '/').split('?')[0];
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (
    !decoded.startsWith('/') ||
    /[\\\u0000-\u001f\u007f:#?%]/.test(decoded) ||
    decoded
      .split('/')
      .some((part) => part === '..' || part === '.' || part.startsWith('.'))
  )
    return null;
  return decoded;
}

async function assetInventory(directory) {
  const root = await realpath(directory);
  const entries = new Map();
  async function visit(relative = '') {
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const name = path.posix.join(relative, entry.name);
      const top = name.split('/')[0];
      if (entry.isDirectory()) {
        if (ASSET_DIRECTORIES.has(top)) await visit(name);
        continue;
      }
      const extension = path.extname(name).toLowerCase();
      if (
        !entry.isFile() ||
        !TYPES[extension] ||
        (!ASSET_DIRECTORIES.has(top) &&
          !ROOT_FILES.has(name) &&
          !/^[a-z0-9-]+\.svg$/.test(name))
      )
        continue;
      entries.set(`/${name}`, {
        file: path.join(root, name),
        type: TYPES[extension],
      });
    }
  }
  await visit();
  if (!entries.has('/index.html'))
    throw new Error('Built app not found: run npm run build first');
  return { root, entries };
}

function sessionId(req) {
  const values = String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function readLoginBody(req) {
  if (
    !/^application\/x-www-form-urlencoded(?:;|$)/i.test(
      req.headers['content-type'] || '',
    )
  )
    throw new Error('LOGIN_CONTENT_TYPE');
  let bytes = 0;
  const chunks = [];
  if (Number(req.headers['content-length']) > 2048)
    throw new Error('LOGIN_TOO_LARGE');
  await new Promise((resolve, reject) => {
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2048) {
        req.pause();
        reject(new Error('LOGIN_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.once('end', resolve);
    req.once('error', reject);
  });
  const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return form.getAll('token').length === 1 &&
    form.getAll('principal').length <= 1
    ? { token: form.get('token'), principal: form.get('principal') }
    : null;
}

/** No public listener, reverse proxy, remote bootstrap, or Vite runtime is supported. */
export async function startTakHttpsServer({
  env = process.env,
  distRoot = path.join(workspaceRoot, 'dist'),
  providerPlugins,
  offlineMaps,
  now = Date.now,
  port,
} = {}) {
  const bindHost = String(env.TAK_HTTPS_HOST || '127.0.0.1');
  const configuredPort = Number(env.TAK_HTTPS_PORT || 8443);
  if (
    (bindHost !== 'localhost' && !isPrivateBrowserAddress(bindHost)) ||
    bindHost.startsWith('::ffff:')
  )
    throw new Error(
      'TAK_HTTPS_HOST must explicitly name loopback or an RFC1918 IPv4 address',
    );
  if (
    !Number.isInteger(configuredPort) ||
    configuredPort < 1 ||
    configuredPort > 65535
  )
    throw new Error('TAK_HTTPS_PORT must be 1-65535');
  if (
    port !== undefined &&
    (!Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      (port === 0 && bindHost !== 'localhost' && !isLoopbackAddress(bindHost)))
  )
    throw new Error('Ephemeral test listeners must remain loopback');
  if (
    bindHost !== 'localhost' &&
    !isLoopbackAddress(bindHost) &&
    !env.TAK_BROWSER_ORIGIN
  )
    throw new Error('Private LAN binding requires a pinned TAK_BROWSER_ORIGIN');
  if (!env.TAK_HTTPS_CERT || !env.TAK_HTTPS_KEY)
    throw new Error(
      'TAK_HTTPS_CERT and TAK_HTTPS_KEY are required; use a certificate trusted by your EUD',
    );
  const multiOperator = !!String(env.TAK_GATEWAY_USERS_FILE || '').trim();
  if (
    multiOperator &&
    (String(env.TAK_SERVER || '').trim() ||
      /^(1|true|yes|on)$/i.test(String(env.TAK_MESH || '').trim()) ||
      /^(1|true|yes|on)$/i.test(String(env.TAK_BRIDGE || '').trim()))
  )
    throw new Error(
      'Named principals cannot share global TAK_SERVER, multicast or bridge configuration',
    );
  let principals = multiOperator
    ? readTakPrincipals(env.TAK_GATEWAY_USERS_FILE)
    : null;
  const config = multiOperator
    ? null
    : readTakGatewayConfig({ ...env, TAK_GATEWAY: '1' });
  if (!multiOperator && (!config.enabled || config.errors.length))
    throw new Error(
      config.errors[0] || 'Valid TAK gateway configuration is required',
    );
  const cert = readFileSync(env.TAK_HTTPS_CERT);
  const key = readFileSync(env.TAK_HTTPS_KEY);
  const certificate = new X509Certificate(cert);
  if (
    Date.now() < Date.parse(certificate.validFrom) ||
    Date.now() >= Date.parse(certificate.validTo)
  )
    throw new Error('HTTPS certificate is not currently valid');
  const assets = await assetInventory(distRoot);
  const sessions = new Map();
  const principalGateways = new Map();
  const principalGatewayGenerations = new Map();
  const principalMapStores = new Map();
  const principalMapHandlers = new Map();
  const principalMapRoot = multiOperator
    ? createPrincipalMapRoots(
        offlineMaps?.root || defaultOfflinePackRoot(env),
        [workspaceRoot, distRoot],
      )
    : null;
  const sockets = new Set();
  const loginLimiter = createRateLimiter({ rate: 5 / 60, burst: 5, now });
  let gateway;
  let offlineStorePromise;
  let offlineHandler;
  let shellManifestPromise;
  let policy;
  let closed = false;
  function recheckGateways() {
    gateway?.recheckSessions();
    for (const instance of principalGateways.values())
      instance.recheckSessions();
  }
  function closeGateways(options) {
    gateway?.close(options);
    for (const instance of principalGateways.values()) instance.close(options);
    principalGateways.clear();
    principalGatewayGenerations.clear();
  }
  function sessionGateway(authenticated) {
    if (!multiOperator) return gateway;
    let instance = principalGateways.get(authenticated.principal);
    if (!instance) {
      const principal = principals.get(authenticated.principal);
      if (!principal?.enabled) throw new Error('Principal unavailable');
      instance = createTakGateway({
        config: principalGatewayConfig(principal, policy),
        WebSocketServer,
        now,
        authenticateSession,
      });
      principalGateways.set(principal.id, instance);
      principalGatewayGenerations.set(principal.id, principal.generation);
    }
    return instance;
  }
  function reloadPrincipals() {
    if (!multiOperator || closed)
      throw new Error('Named principal reload unavailable');
    let next;
    try {
      next = readTakPrincipals(env.TAK_GATEWAY_USERS_FILE);
    } catch (error) {
      principals = new Map();
      sessions.clear();
      closeGateways({ sessionExpired: true });
      throw error;
    }
    principals = next;
    for (const [id, instance] of principalGateways) {
      if (
        !principals.get(id)?.enabled ||
        principalGatewayGenerations.get(id) !== principals.get(id)?.generation
      ) {
        instance.close({ sessionExpired: true });
        principalGateways.delete(id);
        principalGatewayGenerations.delete(id);
      }
    }
    pruneSessions();
    recheckGateways();
    return {
      enabledPrincipals: [...principals.values()].filter(
        (principal) => principal.enabled,
      ).length,
    };
  }
  function pruneSessions() {
    const t = now();
    for (const [id, session] of sessions)
      if (
        t - session.created >= SESSION_TTL_MS ||
        t - session.lastSeen >= SESSION_TTL_MS ||
        (multiOperator &&
          (!principals.get(session.principal)?.enabled ||
            principals.get(session.principal).generation !==
              session.generation))
      )
        sessions.delete(id);
  }
  function authenticateSession(req, touch = false) {
    pruneSessions();
    const session = sessions.get(sessionId(req));
    if (!session) return null;
    if (touch) session.lastSeen = now();
    if (!multiOperator) return { principal: 'local-operator' };
    const principal = principals.get(session.principal);
    return {
      principal: principal.id,
      role: principal.role,
      storageScope: principal.storageScope,
      multiOperator: true,
    };
  }
  function scopeMatches(req, authenticated) {
    const scope = req.headers['x-tak-storage-scope'];
    return (
      !multiOperator ||
      (typeof scope === 'string' &&
        /^[a-f0-9]{64}$/.test(scope) &&
        scope === authenticated?.storageScope)
    );
  }
  const middlewares = connect();
  const server = https.createServer(
    {
      cert,
      key,
      minVersion: 'TLSv1.2',
      maxHeaderSize: 16 * 1024,
      handshakeTimeout: 10_000,
    },
    (req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) reply(res, 500, { error: 'Request failed' });
        else res.destroy();
      });
    },
  );
  server.maxConnections = 64;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', HTTPS_BROWSER_CSP);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Cache-Control', 'no-store');
  }
  function reply(res, code, value, html = false) {
    res.writeHead(code, {
      'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json',
    });
    res.end(html ? value : JSON.stringify(value));
  }
  function refuseScope(res) {
    res.setHeader('X-TAK-Account-Context', 'mismatch');
    return reply(res, 409, {
      code: 'operator-context-changed',
      error: 'Operator context changed; reload before continuing',
    });
  }
  async function handle(req, res) {
    securityHeaders(res);
    if (!policy || closed)
      return reply(res, 503, { error: 'Server unavailable' });
    const target = safePath(req.url);
    if (!target) return reply(res, 404, { error: 'Unknown path' });
    if (!authorizeBrowserRequest(req, policy, { requireOrigin: false }).ok)
      return reply(res, 403, {
        error: 'Private same-origin HTTPS access required',
      });
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !authorizeBrowserRequest(req, policy).ok
    )
      return reply(res, 403, { error: 'Same-origin request required' });
    if (req.method === 'OPTIONS')
      return reply(res, 403, { error: 'Cross-origin access is unavailable' });
    if (/^\/(?:mcp(?:\/|$)|api\/setup(?:\/|$))/.test(target))
      return reply(res, 404, { error: 'Unavailable in internal hosting' });
    if (target === '/login') {
      if (req.method === 'GET') {
        // Native form submissions need their same-origin Origin value. Keep
        // the authenticated application on no-referrer and reject null Origin.
        res.setHeader('Referrer-Policy', 'same-origin');
        const loginPage = multiOperator
          ? LOGIN_PAGE.replace(
              '<form method="post" action="/login">',
              '<form method="post" action="/login" data-multi-operator="true"><label>Operator name <input name="principal" autocomplete="username" required maxlength="32" pattern="[a-z][a-z0-9-]{0,31}"></label>',
            )
          : LOGIN_PAGE;
        return reply(res, 200, loginPage, true);
      }
      if (req.method !== 'POST')
        return reply(res, 405, { error: 'Method Not Allowed' });
      if (!authorizeBrowserRequest(req, policy).ok)
        return reply(res, 403, { error: 'Same-origin login required' });
      if (!loginLimiter.take()) {
        res.setHeader('Retry-After', '60');
        return reply(res, 429, { error: 'Too many login attempts' });
      }
      let credentials;
      try {
        credentials = await readLoginBody(req);
      } catch (error) {
        res.setHeader('Connection', 'close');
        return reply(res, error.message === 'LOGIN_TOO_LARGE' ? 413 : 400, {
          error: 'Invalid login request',
        });
      }
      const principal = multiOperator
        ? authenticateTakPrincipal(
            principals,
            credentials?.principal,
            credentials?.token,
          )
        : null;
      if (
        multiOperator
          ? !principal
          : !matchesToken(credentials?.token, config.token)
      )
        return reply(res, 401, { error: 'Access denied' });
      pruneSessions();
      sessions.delete(sessionId(req));
      recheckGateways();
      if (sessions.size >= MAX_HTTPS_SESSIONS)
        return reply(res, 503, { error: 'Session limit reached' });
      if (
        multiOperator &&
        [...sessions.values()].filter(
          (session) => session.principal === principal.id,
        ).length >= MAX_PRINCIPAL_SESSIONS
      )
        return reply(res, 503, { error: 'Principal session limit reached' });
      const id = randomBytes(32).toString('hex');
      sessions.set(id, {
        created: now(),
        lastSeen: now(),
        ...(principal
          ? { principal: principal.id, generation: principal.generation }
          : {}),
      });
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
      );
      res.writeHead(303, { Location: '/' });
      return res.end();
    }
    const authenticated = authenticateSession(req, true);
    if (!authenticated) {
      if (target.startsWith('/api/'))
        return reply(res, 401, { error: 'Operator login required' });
      if (req.method !== 'GET' && req.method !== 'HEAD')
        return reply(res, 405, { error: 'Method Not Allowed' });
      res.writeHead(303, { Location: '/login' });
      return res.end();
    }
    if (target === '/logout') {
      if (req.method !== 'POST')
        return reply(res, 405, { error: 'Method Not Allowed' });
      if (!authorizeBrowserRequest(req, policy).ok)
        return reply(res, 403, { error: 'Same-origin logout required' });
      if (!scopeMatches(req, authenticated)) return refuseScope(res);
      sessions.delete(sessionId(req));
      recheckGateways();
      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
      );
      res.writeHead(303, { Location: '/login' });
      return res.end();
    }
    if (sessionGateway(authenticated).handleHttpRequest(req, res)) return;
    if (isOfflineMapsRequest(req)) {
      if (!scopeMatches(req, authenticated)) return refuseScope(res);
      if (multiOperator) {
        const id = authenticated.principal;
        let storePromise = principalMapStores.get(id);
        if (!storePromise) {
          const limits = { ...offlineMaps?.limits };
          for (const [key, maximum] of Object.entries(PRINCIPAL_MAP_LIMITS))
            limits[key] = Math.min(limits[key] ?? maximum, maximum);
          storePromise = principalMapRoot(id).then((root) =>
            createOfflinePackStore({
              ...offlineMaps,
              root,
              forbiddenRoots: [workspaceRoot, distRoot],
              limits,
            }),
          );
          principalMapStores.set(id, storePromise);
          storePromise.catch(() => {
            if (principalMapStores.get(id) === storePromise)
              principalMapStores.delete(id);
          });
        }
        const store = await storePromise;
        let handler = principalMapHandlers.get(id);
        if (!handler) {
          handler = createOfflineMapsHandler({
            store,
            now,
            authorize: (request, { mutation }) =>
              authenticateSession(request)?.principal === id
                ? authorizeBrowserRequest(request, policy, {
                    requireOrigin: mutation,
                  })
                : { ok: false, status: 401 },
            shellManifest: () =>
              (shellManifestPromise ||= createOfflineShellManifest(
                distRoot,
              ).catch((error) => {
                shellManifestPromise = null;
                throw error;
              })),
          });
          principalMapHandlers.set(id, handler);
        }
        await handler(req, res);
        return;
      }
      offlineStorePromise ||= createOfflinePackStore({
        ...offlineMaps,
        root: offlineMaps?.root || defaultOfflinePackRoot(env),
        forbiddenRoots: [workspaceRoot, distRoot],
      });
      const store = await offlineStorePromise;
      offlineHandler ||= createOfflineMapsHandler({
        store,
        now,
        authorize: (request, { mutation }) =>
          authenticateSession(request)
            ? authorizeBrowserRequest(request, policy, {
                requireOrigin: mutation,
              })
            : { ok: false, status: 401 },
        shellManifest: () =>
          (shellManifestPromise ||= createOfflineShellManifest(distRoot).catch(
            (error) => {
              shellManifestPromise = null;
              throw error;
            },
          )),
      });
      await offlineHandler(req, res);
      return;
    }
    if (target.startsWith('/api/')) {
      middlewares(req, res, () =>
        reply(res, 404, { error: 'Unknown API route' }),
      );
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return reply(res, 405, { error: 'Method Not Allowed' });
    const asset = assets.entries.get(target === '/' ? '/index.html' : target);
    if (!asset) return reply(res, 404, { error: 'Unknown asset' });
    const canonical = await realpath(asset.file);
    if (
      canonical !== asset.file ||
      !canonical.startsWith(assets.root + path.sep) ||
      (await lstat(asset.file)).isSymbolicLink()
    )
      return reply(res, 404, { error: 'Unknown asset' });
    const metadata = await stat(asset.file);
    let start = 0;
    let end = metadata.size - 1;
    if (req.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range && (range[1] || range[2])) {
        if (!range[1]) start = Math.max(0, metadata.size - Number(range[2]));
        else {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        }
      }
      if (
        !range ||
        !(range[1] || range[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= metadata.size
      ) {
        res.setHeader('Content-Range', `bytes */${metadata.size}`);
        return reply(res, 416, { error: 'Invalid byte range' });
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${metadata.size}`);
    }
    res.setHeader('Content-Type', asset.type);
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    res.setHeader('Accept-Ranges', 'bytes');
    if (target === '/gev-sw.js') res.setHeader('Service-Worker-Allowed', '/');
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(asset.file, {
      start,
      ...(end >= 0 ? { end } : {}),
      flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }
  const cleanups = [];
  async function cleanupProviders() {
    for (const cleanup of cleanups.splice(0)) {
      try {
        await cleanup();
      } catch {
        console.warn('[tak-https] A provider cleanup failed');
      }
    }
  }
  try {
    server.listen(port ?? configuredPort, bindHost);
    await once(server, 'listening');
    const actualPort = server.address().port;
    const authority = bindHost.includes(':') ? `[${bindHost}]` : bindHost;
    const origin =
      env.TAK_BROWSER_ORIGIN ||
      `https://${authority}${actualPort === 443 ? '' : `:${actualPort}`}`;
    policy = createBrowserAccessPolicy({
      mode: 'private-https',
      origin,
      bindHost,
      port: actualPort,
    });
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    if (
      !(isIP(hostname)
        ? certificate.checkIP(hostname)
        : certificate.checkHost(hostname))
    )
      throw new Error('HTTPS certificate does not match TAK_BROWSER_ORIGIN');
    if (!multiOperator)
      gateway = createTakGateway({
        config: { ...config, accessPolicy: policy, localBootstrap: false },
        WebSocketServer,
        now,
        authenticateSession,
      });
    const plugins =
      providerPlugins ??
      localProviderPlugins({ realtime: { tools: standaloneVoiceTools() } });
    const postHooks = [];
    for (const plugin of plugins) {
      if (
        !plugin ||
        ['tak-gateway', 'gev-key-setup'].includes(plugin.name) ||
        typeof plugin.configurePreviewServer !== 'function'
      )
        continue;
      if (typeof plugin.closeBundle === 'function')
        cleanups.push(() => plugin.closeBundle());
      const afterInstall = await plugin.configurePreviewServer({
        middlewares,
        httpServer: server,
      });
      if (typeof afterInstall === 'function') postHooks.push(afterInstall);
    }
    for (const hook of postHooks) await hook();
    server.on('upgrade', (req, socket, head) => {
      const authenticated = authenticateSession(req);
      if (!authorizeBrowserRequest(req, policy).ok || !authenticated) {
        socket.end(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
        return;
      }
      if (!sessionGateway(authenticated).handleUpgrade(req, socket, head))
        socket.destroy();
    });
    const expiryTimer = setInterval(() => {
      pruneSessions();
      recheckGateways();
    }, 30_000);
    expiryTimer.unref();
    async function close() {
      if (closed) return;
      closed = true;
      clearInterval(expiryTimer);
      sessions.clear();
      closeGateways();
      await offlineStorePromise?.then((store) => store.close()).catch(() => {});
      await Promise.all(
        [...principalMapStores.values()].map((promise) =>
          promise.then((store) => store.close()).catch(() => {}),
        ),
      );
      principalMapStores.clear();
      principalMapHandlers.clear();
      await cleanupProviders();
      const finished = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections?.();
      for (const socket of sockets) socket.destroy();
      await finished;
    }
    return {
      server,
      gateway: multiOperator
        ? Object.freeze({ recheckSessions: recheckGateways })
        : gateway,
      origin,
      close,
      policy,
      ...(multiOperator ? { reloadPrincipals } : {}),
    };
  } catch (error) {
    closeGateways();
    await offlineStorePromise?.then((store) => store.close()).catch(() => {});
    await Promise.all(
      [...principalMapStores.values()].map((promise) =>
        promise.then((store) => store.close()).catch(() => {}),
      ),
    );
    await cleanupProviders();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    throw error;
  }
}

async function main() {
  for (const name of [
    '.env.production.local',
    '.env.production',
    '.env.local',
    '.env',
  ]) {
    const file = path.join(workspaceRoot, name);
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const app = await startTakHttpsServer();
  console.info(
    `[tak-https] Private HTTPS console ready at ${app.origin}; operator login required.`,
  );
  let stopping = false;
  if (app.reloadPrincipals)
    process.on('SIGHUP', () => {
      try {
        app.reloadPrincipals();
        console.info(
          '[tak-https] Principal configuration reloaded; changed sessions revoked.',
        );
      } catch {
        console.warn(
          '[tak-https] Principal reload failed; named access revoked until a valid reload or restart.',
        );
      }
    });
  const stop = () => {
    if (!stopping) {
      stopping = true;
      void app.close().then(() => {
        process.exitCode = 0;
      });
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`[tak-https] Startup failed: ${error.code || error.message}`);
    process.exitCode = 1;
  });
}
