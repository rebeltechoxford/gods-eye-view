import { createRateLimiter } from '../../../src/tak/protocol/router.js';
import { parseTileKey } from '../../../src/maps/offline/schema.js';
import { OfflinePackError } from './store.js';

export const OFFLINE_MAPS_ROUTE = '/api/maps/offline';
export function isOfflineMapsRequest(req) {
  return String(req.url || '')
    .split('?')[0]
    .startsWith(OFFLINE_MAPS_ROUTE + '/');
}

/** Authorization is supplied by the existing private-session or loopback-token host. */
export function createOfflineMapsHandler({
  store,
  authorize,
  createContinuationAuthorization,
  shellManifest,
  now = Date.now,
}) {
  const reads = createRateLimiter({ rate: 80, burst: 160, now });
  const writes = createRateLimiter({ rate: 10 / 60, burst: 10, now });
  const cancellations = createRateLimiter({ rate: 1, burst: 4, now });
  let requests = 0;
  const json = (res, status, value) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(value));
  };
  async function body(req, maximum = 2048) {
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        req.headers['content-type'] || '',
      )
    )
      throw new OfflinePackError(
        'CONTENT_TYPE',
        'Expected application/json',
        415,
      );
    if (Number(req.headers['content-length']) > maximum)
      throw new OfflinePackError(
        'BODY_LIMIT',
        'Offline map request is too large',
        413,
      );
    const chunks = [];
    let bytes = 0;
    req.setTimeout(5000, () => req.destroy());
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maximum) {
          req.pause();
          throw new OfflinePackError(
            'BODY_LIMIT',
            'Offline map request is too large',
            413,
          );
        }
        chunks.push(chunk);
      }
    } finally {
      req.setTimeout(0);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new OfflinePackError('JSON', 'Invalid JSON request');
    }
  }
  async function captureContinuation(req) {
    const continuation = createContinuationAuthorization
      ? await createContinuationAuthorization(req)
      : () => authorize(req, { mutation: true })?.ok === true;
    if (typeof continuation !== 'function')
      throw new OfflinePackError(
        'ACCESS',
        'Offline map authorization is unavailable',
        401,
      );
    return continuation;
  }
  async function authorizedBody(req, maximum) {
    const isAuthorized = await captureContinuation(req);
    const input = await body(req, maximum);
    const current = authorize(req, { mutation: true });
    if (!current?.ok || (await isAuthorized()) !== true)
      throw new OfflinePackError(
        'ACCESS',
        'Offline map authorization ended',
        current?.status || 401,
      );
    return { input, isAuthorized };
  }
  return async function handle(req, res) {
    if (!isOfflineMapsRequest(req)) return false;
    try {
      const mutation = !['GET', 'HEAD'].includes(req.method);
      const cancellation =
        req.method === 'POST' &&
        /^\/api\/maps\/offline\/(?:packs|imports)\/[0-9a-f-]{36}\/cancel$/.test(
          req.url || '',
        );
      const allowed = authorize(req, { mutation });
      if (!allowed?.ok) {
        json(res, allowed?.status || 401, {
          error: 'Authorized offline map access required',
          code: 'ACCESS',
        });
        return true;
      }
      if (
        requests >= 16 ||
        !(cancellation ? cancellations : mutation ? writes : reads).take()
      ) {
        json(res, 429, {
          error: 'Offline map request limit reached',
          code: 'REQUEST_LIMIT',
        });
        return true;
      }
      requests++;
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          requests--;
        }
      };
      res.once('finish', release);
      res.once('close', release);
      {
        const url = String(req.url || '').split('?');
        if (url.length !== 1 || /[%\\\u0000-\u001f]/.test(url[0]))
          throw new OfflinePackError('PATH', 'Invalid offline map path', 404);
        const target = url[0].slice(OFFLINE_MAPS_ROUTE.length);
        if (target === '/shell' && req.method === 'GET') {
          if (!shellManifest)
            throw new OfflinePackError(
              'BUILD_REQUIRED',
              'Offline startup requires the built private HTTPS application',
              409,
            );
          json(res, 200, await shellManifest());
          return true;
        }
        if (target === '/packs' && req.method === 'GET') {
          json(res, 200, { packs: store.list() });
          return true;
        }
        if (target === '/packs' && req.method === 'POST') {
          const { input, isAuthorized } = await authorizedBody(req, 2048);
          json(res, 202, await store.create(input, { isAuthorized }));
          return true;
        }
        if (target === '/imports' && req.method === 'POST') {
          const { input, isAuthorized } = await authorizedBody(req, 16 * 1024);
          json(res, 202, await store.createImport(input, { isAuthorized }));
          return true;
        }
        const imported =
          /^\/imports\/([0-9a-f-]{36})(?:\/(file|cancel))?$/.exec(target);
        if (imported) {
          const [, id, action] = imported;
          if (action === 'file' && req.method === 'PUT') {
            res.setHeader('Connection', 'close');
            const continuation = await captureContinuation(req);
            const result = await store.uploadImport(id, req, {
              isAuthorized: continuation,
            });
            const current = authorize(req, { mutation: true });
            if (!current?.ok)
              throw new OfflinePackError(
                'ACCESS',
                'MBTiles import authorization ended',
                current?.status || 401,
              );
            json(res, 202, result);
            return true;
          }
          if (
            (!action && req.method === 'DELETE') ||
            (action === 'cancel' && req.method === 'POST')
          ) {
            if (
              Number(req.headers['content-length']) > 0 ||
              req.headers['transfer-encoding']
            )
              throw new OfflinePackError(
                'BODY',
                'This offline map action has no request body',
              );
            if (action === 'cancel')
              json(res, 200, await store.cancelImport(id));
            else {
              await store.deleteImport(id);
              res.writeHead(204, { 'Cache-Control': 'no-store' });
              res.end();
            }
            return true;
          }
          if (!action && req.method === 'GET') {
            json(res, 200, store.getImport(id));
            return true;
          }
          throw new OfflinePackError('METHOD', 'Method Not Allowed', 405);
        }
        const match =
          /^\/packs\/([0-9a-f-]{36})(?:\/(resume|cancel)|\/tiles\/(\d+)\/(\d+)\/(\d+))?$/.exec(
            target,
          );
        if (!match)
          throw new OfflinePackError(
            'NOT_FOUND',
            'Unknown offline map route',
            404,
          );
        const [, id, action, z, x, y] = match;
        if (z !== undefined) {
          if (req.method !== 'GET')
            throw new OfflinePackError('METHOD', 'Method Not Allowed', 405);
          const key = `${z}/${x}/${y}`;
          parseTileKey(key);
          const tile = await store.tile(id, key);
          res.writeHead(200, {
            'Content-Type': tile.contentType,
            'Content-Length': tile.bytes.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Content-SHA256': tile.sha256,
          });
          res.end(tile.bytes);
          return true;
        }
        if (action) {
          if (req.method !== 'POST')
            throw new OfflinePackError('METHOD', 'Method Not Allowed', 405);
          if (
            Number(req.headers['content-length']) > 0 ||
            req.headers['transfer-encoding']
          )
            throw new OfflinePackError(
              'BODY',
              'This offline map action has no request body',
            );
          json(res, action === 'resume' ? 202 : 200, await store[action](id));
          return true;
        }
        if (req.method === 'GET') {
          json(res, 200, store.get(id));
          return true;
        }
        if (req.method === 'DELETE') {
          if (
            Number(req.headers['content-length']) > 0 ||
            req.headers['transfer-encoding']
          )
            throw new OfflinePackError(
              'BODY',
              'This offline map action has no request body',
            );
          await store.delete(id);
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return true;
        }
        throw new OfflinePackError('METHOD', 'Method Not Allowed', 405);
      }
    } catch (error) {
      if (error instanceof OfflinePackError && error.code === 'BODY_LIMIT')
        res.setHeader('Connection', 'close');
      if (res.headersSent) res.destroy();
      else
        json(
          res,
          error instanceof OfflinePackError
            ? error.status
            : error instanceof TypeError
              ? 400
              : 503,
          {
            error:
              error instanceof OfflinePackError
                ? error.message
                : error instanceof TypeError
                  ? 'Invalid offline map data'
                  : 'Offline map store unavailable',
            code:
              error instanceof OfflinePackError ? error.code : 'OFFLINE_MAPS',
          },
        );
    }
    return true;
  };
}
