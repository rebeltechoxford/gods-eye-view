import { createRequire } from 'node:module';
import { readTakGatewayConfig } from './tak/config.js';
import { TAK_STATUS_ROUTE, createTakGateway } from './tak/gateway.js';
import { authorizeLocalRequest, matchesToken } from './tak/access.js';
import {
  createOfflinePackStore,
  defaultOfflinePackRoot,
} from '../maps/offline/store.js';
import {
  createOfflineMapsHandler,
  isOfflineMapsRequest,
} from '../maps/offline/http.js';
import {
  createRoadPacksHandler,
  defaultRoadPackRoot,
  isRoadPackRequest,
} from '../routing/packs.js';
import { fileURLToPath } from 'node:url';

const LOG_PREFIX = '[tak-gateway]';

function loadWebSocketServer() {
  try {
    return createRequire(import.meta.url)('ws').WebSocketServer;
  } catch (error) {
    console.warn(
      `${LOG_PREFIX} \`ws\` is unavailable; the TAK gateway is off.`,
      error?.message || '',
    );
    return null;
  }
}

/**
 * Vite plugin mounting the TAK gateway:
 * - `GET /api/tak/status` always answers (disabled state included), so the
 *   panel can say *why* it is offline;
 * - `WS /api/tak/ws` exists only when TAK_GATEWAY=1.
 * Configuration is read when the server starts; construction does nothing.
 * @param {{env?:Record<string,string|undefined>}} [options]
 * @returns {import('vite').Plugin}
 */
export function takGatewayProxy({ env, offlineMaps } = {}) {
  let gateway = null;
  let disabledStatus = null;
  let installedHttpServer = null;
  let upgradeListener = null;
  let offlineStorePromise;
  let offlineHandler;
  let roadPacksHandler;
  let offlineClose = Promise.resolve();
  let installationGeneration = 0;

  const dispose = () => {
    installationGeneration++;
    if (installedHttpServer && upgradeListener)
      installedHttpServer.off('upgrade', upgradeListener);
    installedHttpServer = null;
    upgradeListener = null;
    gateway?.close();
    gateway = null;
    const previous = offlineStorePromise;
    offlineStorePromise = null;
    offlineHandler = null;
    offlineClose = offlineClose.then(() =>
      previous?.then((store) => store.close()).catch(() => {}),
    );
    return offlineClose;
  };

  const install = (server) => {
    dispose();
    const config = readTakGatewayConfig(env || process.env);
    const generation = installationGeneration;
    for (const error of config.errors) console.warn(`${LOG_PREFIX} ${error}`);
    const WebSocketServer = config.enabled ? loadWebSocketServer() : null;
    if (config.enabled && WebSocketServer && server.httpServer) {
      gateway = createTakGateway({ config, WebSocketServer });
      upgradeListener = (req, socket, head) => {
        gateway?.handleUpgrade(req, socket, head);
      };
      installedHttpServer = server.httpServer;
      installedHttpServer.on('upgrade', upgradeListener);
      server.httpServer.on('close', dispose);
      const uplinks = [
        config.mesh && 'mesh',
        config.server && `server ${config.server.host}:${config.server.port}`,
      ].filter(Boolean);
      console.info(
        `${LOG_PREFIX} enabled${uplinks.length ? ` (${uplinks.join(', ')})` : ' (browser relay only)'}`,
      );
    } else {
      disabledStatus = {
        enabled: false,
        reason: !config.enabled
          ? config.errors[0] || 'TAK_GATEWAY is not enabled'
          : !WebSocketServer
            ? 'ws unavailable'
            : 'no HTTP server (middleware mode)',
        errors: config.errors,
      };
    }
    // Saved maps and road packs share the local-token authorization.
    const authorizeLocal = (request, { mutation }) => {
      const local = authorizeLocalRequest(request, {
        requireOrigin: mutation,
      });
      if (!local.ok) return local;
      const authorization = request.headers.authorization;
      if (
        !config.enabled ||
        typeof authorization !== 'string' ||
        !authorization.startsWith('Bearer ') ||
        !matchesToken(authorization.slice(7), config.token)
      )
        return { ok: false, status: 401 };
      return { ok: true };
    };
    roadPacksHandler = createRoadPacksHandler({
      root: defaultRoadPackRoot(env || process.env),
      authorize: (request) => authorizeLocal(request, { mutation: false }),
    });
    server.middlewares.use((req, res, next) => {
      if (isRoadPackRequest(req)) {
        roadPacksHandler(req, res).catch(() => {
          if (res.headersSent) res.destroy();
          else {
            res.writeHead(503, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: 'Road packs unavailable',
                code: 'STORE',
              }),
            );
          }
        });
        return;
      }
      if (isOfflineMapsRequest(req)) {
        const authorize = authorizeLocal;
        const allowed = authorize(req, {
          mutation: !['GET', 'HEAD'].includes(req.method),
        });
        if (!allowed.ok) {
          res.writeHead(allowed.status || 401, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              error: 'Authorized offline map access required',
              code: 'ACCESS',
            }),
          );
          return;
        }
        offlineStorePromise ||= offlineClose.then(() =>
          createOfflinePackStore({
            ...offlineMaps,
            root:
              offlineMaps?.root || defaultOfflinePackRoot(env || process.env),
            forbiddenRoots: [fileURLToPath(new URL('../../', import.meta.url))],
          }),
        );
        void offlineStorePromise
          .then((store) => {
            offlineHandler ||= createOfflineMapsHandler({
              store,
              authorize,
              createContinuationAuthorization: (request) => {
                const authorization = request.headers.authorization;
                return () =>
                  installationGeneration === generation &&
                  config.enabled &&
                  typeof authorization === 'string' &&
                  authorization.startsWith('Bearer ') &&
                  matchesToken(authorization.slice(7), config.token);
              },
            });
            return offlineHandler(req, res);
          })
          .catch(() => {
            if (res.headersSent) res.destroy();
            else {
              res.writeHead(503, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              res.end(
                JSON.stringify({
                  error: 'Offline map store unavailable',
                  code: 'STORE',
                }),
              );
            }
          });
        return;
      }
      if (gateway?.handleHttpRequest(req, res)) return;
      const path = new URL(req.url || '/', 'http://localhost').pathname;
      if (path !== TAK_STATUS_ROUTE) return next?.();
      if (!authorizeLocalRequest(req, { requireOrigin: false }).ok) {
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        return res.end(JSON.stringify({ error: 'Local access required' }));
      }
      res.writeHead(req.method === 'GET' ? 200 : 405, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      if (req.method !== 'GET')
        return res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return res.end(
        JSON.stringify(gateway ? gateway.status() : disabledStatus),
      );
    });
  };

  return {
    name: 'tak-gateway',
    configureServer: install,
    configurePreviewServer: install,
    closeBundle: dispose,
  };
}
