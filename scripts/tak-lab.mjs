#!/usr/bin/env node
/** Start an isolated local synthetic CoT peer and the real GEV gateway/UI. */
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCotStreamFramer } from '../src/tak/protocol/stream.js';
import {
  parseCotEvent,
  serializeCotEvent,
  cotKind,
} from '../src/tak/protocol/cot.js';
import {
  buildSelfSa,
  buildMarker,
  buildChat,
} from '../src/tak/protocol/builders.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const peerIdentity = Object.freeze({
  uid: 'SYNTHETIC-LOCAL-PEER',
  callsign: 'SYNTHETIC LAB PEER',
  team: 'Cyan',
  role: 'Team Member',
});
const frame = (event) =>
  '<?xml version="1.0" encoding="UTF-8"?>\n' + serializeCotEvent(event);

/** No LAN/public bind, real peer, operational position, credential or certificate is used. */
export async function startTakLab({ port = 4174, log = console } = {}) {
  const sockets = new Set();
  const counters = { received: 0, returned: 0 };
  const peer = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    function send(event) {
      if (socket.destroyed || socket.writableLength > 256 * 1024) return;
      socket.write(frame(event));
      counters.returned++;
    }
    const framer = createCotStreamFramer({
      onEvent(xml) {
        let event;
        try {
          event = parseCotEvent(xml);
        } catch {
          return;
        }
        counters.received++;
        const kind = cotKind(event.type);
        if (
          (kind === 'marker' || kind === 'sa') &&
          event.point &&
          event.uid !== peerIdentity.uid
        ) {
          // A visible, newer peer correction proves the return path in the lab.
          send(
            buildMarker(
              peerIdentity,
              {
                uid: event.uid,
                callsign:
                  `${event.detail.callsign || 'Marker'} (lab peer)`.slice(
                    0,
                    120,
                  ),
                ...event.point,
                type: event.type,
                remarks:
                  'Synthetic local peer received this event and returned this correction.',
              },
              { nowMs: Math.max(Date.now(), event.timeMs + 1) },
            ),
          );
        } else if (kind === 'chat') {
          send(
            buildChat(peerIdentity, {
              message: `SYNTHETIC peer received: ${(event.detail.remarks?.text || '').slice(0, 3000)}`,
            }),
          );
        }
      },
    });
    socket.on('data', (chunk) => framer.push(chunk));
    send(
      buildSelfSa(peerIdentity, {
        lat: 34.3665,
        lon: -89.5192,
        hae: null,
        source: 'USER',
      }),
    );
  });
  await new Promise((resolve, reject) => {
    peer.once('error', reject);
    peer.listen(0, '127.0.0.1', resolve);
  });
  const peerPort = peer.address().port;
  const keys = [
    'TAK_GATEWAY',
    'TAK_GATEWAY_TOKEN',
    'TAK_GATEWAY_LOCAL_BOOTSTRAP',
    'TAK_SERVER',
    'TAK_SERVER_PROTOCOL',
    'TAK_MESH',
    'TAK_BRIDGE',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    TAK_GATEWAY: '1',
    TAK_GATEWAY_TOKEN: randomBytes(32).toString('base64url'),
    TAK_GATEWAY_LOCAL_BOOTSTRAP: '1',
    TAK_SERVER: `127.0.0.1:${peerPort}`,
    TAK_SERVER_PROTOCOL: 'tcp',
    TAK_MESH: '0',
    TAK_BRIDGE: '0',
  });
  let app;
  try {
    const { createServer } = await import('vite');
    app = await createServer({
      root,
      configFile: path.join(root, 'vite.config.js'),
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        open: false,
        hmr: false,
        watch: null,
      },
    });
    await app.listen();
  } catch (error) {
    await app?.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => peer.close(resolve));
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    throw error;
  }
  let closing;
  const close = () =>
    (closing ||= (async () => {
      await app.close();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => peer.close(resolve));
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    })());
  log.info(
    `\nGEV × TAK synthetic local lab: http://127.0.0.1:${port}\nOpen TAK > Connect (token is automatic for this local lab).\nCreate a marker with Share enabled, or send chat, to see a synthetic peer reply.\nThis tests real local TCP/WebSocket transport, not ATAK/WinTAK/iTAK interoperability.\nCtrl+C stops both the app and synthetic peer.\n`,
  );
  return { app, peer, counters, close };
}

if (
  import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href
) {
  const at = process.argv.indexOf('--port');
  const port = at >= 0 ? Number(process.argv[at + 1]) : 4174;
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('--port must be 1024-65535');
  const lab = await startTakLab({ port });
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await lab.close();
      process.exitCode = 0;
    });
}
