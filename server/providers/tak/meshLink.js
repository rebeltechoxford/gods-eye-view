import dgram from 'node:dgram';
import { cotKind } from '../../../src/tak/protocol/cot.js';
import { isTakProtobuf } from '../../../src/tak/protocol/stream.js';

/** Largest datagram we will send; ATAK keeps SA well under a typical MTU. */
export const MAX_MESH_DATAGRAM_BYTES = 8 * 1024;

/**
 * ATAK "mesh" SA: UDP multicast on the local segment. ATAK, WinTAK and iTAK
 * all speak it with no server. Position/marker CoT travels on the SA group
 * (default 239.2.3.1:6969); GeoChat on the chat group (224.10.10.1:17012).
 *
 * Inbound XML goes to the router through `onXml`; TAK protocol v1 (protobuf)
 * datagrams are counted as unsupported rather than mis-parsed.
 *
 * @param {object} options
 * @param {object} options.config The `mesh` block of readTakGatewayConfig().
 * @param {(xml:string)=>void} options.onXml
 * @param {(status:object)=>void} [options.onStatus]
 * @param {(type:'udp4', reuse:boolean)=>import('node:dgram').Socket} [options.createSocket] Test seam.
 */
export function createMeshLink({
  config,
  onXml,
  onStatus = () => {},
  createSocket,
}) {
  const make =
    createSocket ||
    (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
  const counters = { rx: 0, tx: 0, protobuf: 0, oversized: 0, errors: 0 };
  const channels = [];
  let state = 'starting';
  let lastError = null;
  let closed = false;

  function report() {
    onStatus({ state, lastError, ...counters });
  }

  function open(group, groupPort) {
    const socket = make();
    const channel = { group, port: groupPort, socket, ready: false };
    socket.on('message', (buffer) => {
      if (closed) return;
      if (isTakProtobuf(buffer)) {
        counters.protobuf++;
        return;
      }
      if (buffer.length > 64 * 1024) {
        counters.oversized++;
        return;
      }
      counters.rx++;
      onXml(buffer.toString('utf8'));
    });
    socket.on('error', (error) => {
      counters.errors++;
      lastError = String(error?.message || error);
      state = 'error';
      report();
    });
    socket.bind(groupPort, () => {
      if (closed) return;
      try {
        if (config.iface) socket.addMembership(group, config.iface);
        else socket.addMembership(group);
        socket.setMulticastTTL(config.ttl);
        socket.setMulticastLoopback(config.loopback);
        if (config.iface) socket.setMulticastInterface(config.iface);
        channel.ready = true;
        if (channels.every((c) => c.ready)) {
          state = 'joined';
          report();
        }
      } catch (error) {
        counters.errors++;
        lastError = String(error?.message || error);
        state = 'error';
        report();
      }
    });
    channels.push(channel);
    return channel;
  }

  const sa = open(config.group, config.port);
  const chat = open(config.chatGroup, config.chatPort);

  return Object.freeze({
    id: 'mesh',
    kind: 'mesh',
    limits: { rate: 100, burst: 400 },
    /** Router send hook: chat to the chat group, everything else to SA. */
    send(xml, event, tracking) {
      if (closed) return false;
      const payload = Buffer.from(xml, 'utf8');
      if (payload.length > MAX_MESH_DATAGRAM_BYTES) {
        counters.oversized++;
        return false;
      }
      const channel = cotKind(event?.type) === 'chat' ? chat : sa;
      if (!channel.ready) return false;
      tracking?.onState?.({ state: 'queued' });
      channel.socket.send(payload, channel.port, channel.group, (error) => {
        if (error) {
          counters.errors++;
          lastError = String(error.message || error);
        } else counters.tx++;
        tracking?.onState?.({
          state: error ? 'rejected' : 'submitted',
          ...(error
            ? { reason: 'UDP write failed; peer receipt unknown' }
            : {}),
        });
      });
      return true;
    },
    status: () => ({
      state,
      lastError,
      group: `${config.group}:${config.port}`,
      chat: `${config.chatGroup}:${config.chatPort}`,
      ...counters,
    }),
    close() {
      if (closed) return;
      closed = true;
      state = 'closed';
      for (const channel of channels) {
        try {
          channel.socket.close();
        } catch {
          // already closed
        }
      }
    },
  });
}
