import { createRequire } from 'node:module';
import { readTakGatewayConfig } from './tak/config.js';
import { TAK_STATUS_ROUTE, createTakGateway } from './tak/gateway.js';
import { authorizeLocalRequest } from './tak/access.js';

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
export function takGatewayProxy({ env } = {}) {
  let gateway = null;
  let disabledStatus = null;
  let installedHttpServer = null;
  let upgradeListener = null;

  const dispose = () => {
    if (installedHttpServer && upgradeListener)
      installedHttpServer.off('upgrade', upgradeListener);
    installedHttpServer = null;
    upgradeListener = null;
    gateway?.close();
    gateway = null;
  };

  const install = (server) => {
    dispose();
    const config = readTakGatewayConfig(env || process.env);
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
    server.middlewares.use((req, res, next) => {
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
