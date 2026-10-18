import dgram from 'node:dgram';
import { cotKind } from '../../../src/tak/protocol/cot.js';
import { createRateLimiter } from '../../../src/tak/protocol/router.js';
import { isTakProtobuf } from '../../../src/tak/protocol/stream.js';
import {
  readTakMeshDatagram,
  takPayloadToCot,
} from '../../../src/tak/protocol/takProto.js';

/** Largest datagram we will send; ATAK keeps SA well under a typical MTU. */
export const MAX_MESH_DATAGRAM_BYTES = 8 * 1024;
/** Router ingress budget for the mesh link. */
export const MESH_LIMITS = Object.freeze({ rate: 100, burst: 400 });

/**
 * ATAK "mesh" SA: UDP multicast on the local segment. ATAK, WinTAK and iTAK
 * all speak it with no server. Position/marker CoT travels on the SA group
 * (default 239.2.3.1:6969); GeoChat on the chat group (224.10.10.1:17012).
 *
 * Inbound XML goes to the router through `onXml`. TAK protocol v1 (protobuf)
 * datagrams are decoded and converted to the same XML, so they pass the
 * identical router validation. Other protocol versions are counted, never
 * mis-parsed. Outbound stays XML: the gateway advertises no TakControl, so
 * spec-compliant peers that hear it keep the mesh at version 0, and every
 * peer must accept version 0 regardless.
 *
 * @param {object} options
 * @param {object} options.config The `mesh` block of readTakGatewayConfig().
 * @param {(xml:string)=>void} options.onXml
 * @param {(status:object)=>void} [options.onStatus]
 * @param {(type:'udp4', reuse:boolean)=>import('node:dgram').Socket} [options.createSocket] Test seam.
 * @param {()=>number} [options.now] Clock for the decode budget (test seam).
 */
export function createMeshLink({
  config,
  onXml,
  onStatus = () => {},
  createSocket,
  now = Date.now,
}) {
  const make =
    createSocket ||
    (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
  const counters = {
    rx: 0,
    tx: 0,
    protobuf: 0,
    protobufControl: 0,
    protobufIncomplete: 0,
    protobufLimited: 0,
    protobufRejected: 0,
    protobufUnsupported: 0,
    oversized: 0,
    errors: 0,
  };
  const channels = [];
  let state = 'starting';
  let lastError = null;
  let closed = false;

  function report() {
    onStatus({ state, lastError, ...counters });
  }

  // The router rate-limits before it parses XML; decoding happens earlier,
  // so the same budget is applied first. A flood of v1 datagrams then costs
  // no more conversion work than the router would accept.
  const protobufLimiter = createRateLimiter({ ...MESH_LIMITS, now });

  function receiveTakProtocol(buffer) {
    if (!protobufLimiter.take()) {
      counters.protobufLimited++;
      return;
    }
    let result;
    try {
      result = takPayloadToCot(readTakMeshDatagram(buffer).payload);
    } catch (error) {
      if (error?.code === 'unsupported-version') counters.protobufUnsupported++;
      else counters.protobufRejected++;
      return;
    }
    counters.protobuf++;
    // A version advertisement may arrive alone; it carries no CoT to route.
    if (result.control) counters.protobufControl++;
    if (result.incomplete) counters.protobufIncomplete++;
    if (result.xml === null) return;
    counters.rx++;
    onXml(result.xml);
  }

  function open(group, groupPort) {
    const socket = make();
    const channel = { group, port: groupPort, socket, ready: false };
    socket.on('message', (buffer) => {
      if (closed) return;
      if (buffer.length > 64 * 1024) {
        counters.oversized++;
        return;
      }
      if (isTakProtobuf(buffer)) {
        receiveTakProtocol(buffer);
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
    limits: MESH_LIMITS,
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
