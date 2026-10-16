// Browser link to the same-origin TAK gateway (server/providers/tak).
// The browser never opens raw TCP/UDP or holds TAK certificates: it speaks
// CoT XML text frames over one WebSocket and the gateway does the rest.

export const TAK_WS_PATH = '/api/tak/ws';
export const TAK_STATUS_PATH = '/api/tak/status';
export const TAK_WS_PROTOCOL = 'tak.v1';
export const TAK_TOKEN_PROTOCOL_PREFIX = 'tak.token.';
export const RECONNECT_MS = Object.freeze({ min: 1_000, max: 30_000 });
export const MAX_TRANSPORT_BUFFER_BYTES = 256 * 1024;
export const MAX_TRANSPORT_FRAME_BYTES = 64 * 1024;
export const CONNECT_TIMEOUT_MS = 15_000;
const encoder = new TextEncoder();

/**
 * @typedef {'idle'|'connecting'|'open'|'reconnecting'|'closed'|'refused'} TakLinkState
 */

/**
 * @param {object} options
 * @param {(xml:string)=>void} options.onXml CoT text frame from the gateway.
 * @param {(message:object)=>void} [options.onControl] JSON control frame.
 * @param {(state:TakLinkState, detail?:string)=>void} [options.onState]
 * @param {string} [options.url] Override (tests); default same-origin path.
 * @param {typeof WebSocket} [options.WebSocketImpl]
 * @param {(fn:Function, ms:number)=>any} [options.setTimer]
 * @param {(handle:any)=>void} [options.clearTimer]
 */
export function createGatewayTransport({
  onXml,
  onControl = () => {},
  onState = () => {},
  url,
  WebSocketImpl = globalThis.WebSocket,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
}) {
  let ws = null;
  let state = 'idle';
  let token = null;
  let backoff = RECONNECT_MS.min;
  let timer = null;
  let wanted = false;
  let everOpened = false;
  let identity = null;
  let connectTimer = null;
  let generation = 0;

  function clearConnectTimer() {
    if (connectTimer !== null) clearTimer(connectTimer);
    connectTimer = null;
  }

  function write(text) {
    if (!ws || ws.readyState !== 1 || typeof text !== 'string') return false;
    const size = encoder.encode(text).byteLength;
    if (
      size > MAX_TRANSPORT_FRAME_BYTES ||
      (ws.bufferedAmount || 0) + size > MAX_TRANSPORT_BUFFER_BYTES
    )
      return false;
    try {
      ws.send(text);
      return true;
    } catch {
      return false;
    }
  }

  function setState(next, detail) {
    state = next;
    onState(next, detail);
  }

  function endpoint() {
    if (url) return url;
    const { protocol, host } = globalThis.location;
    return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${TAK_WS_PATH}`;
  }

  function scheduleReconnect(detail) {
    if (!wanted || timer !== null) return;
    setState('reconnecting', detail);
    const delay = backoff;
    backoff = Math.min(RECONNECT_MS.max, backoff * 2);
    const epoch = generation;
    timer = setTimer(() => {
      if (epoch !== generation) return;
      timer = null;
      open();
    }, delay);
  }

  function open() {
    if (!wanted) return;
    if (!WebSocketImpl) {
      setState('refused', 'WebSocket unavailable');
      return;
    }
    setState('connecting');
    const protocols = [TAK_WS_PROTOCOL];
    if (token) protocols.push(TAK_TOKEN_PROTOCOL_PREFIX + token);
    let socket;
    try {
      socket = new WebSocketImpl(endpoint(), protocols);
    } catch (error) {
      scheduleReconnect(String(error?.message || error));
      return;
    }
    ws = socket;
    clearConnectTimer();
    connectTimer = setTimer(() => {
      if (ws !== socket) return;
      ws = null;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      scheduleReconnect('Gateway authentication timed out');
    }, CONNECT_TIMEOUT_MS);
    let opened = false;
    socket.onopen = () => {
      if (ws !== socket) return;
      write(
        JSON.stringify({
          op: 'identity',
          uid: identity?.uid,
          callsign: identity?.callsign,
        }),
      );
    };
    socket.onmessage = (message) => {
      if (ws !== socket || typeof message.data !== 'string') return;
      const text = message.data;
      if (
        text.length > MAX_TRANSPORT_FRAME_BYTES ||
        encoder.encode(text).byteLength > MAX_TRANSPORT_FRAME_BYTES
      ) {
        socket.close(1009, 'Gateway frame exceeds the size limit');
        return;
      }
      if (text.startsWith('{')) {
        try {
          const control = JSON.parse(text);
          if (
            !opened &&
            control?.op === 'identity' &&
            control.uid === identity?.uid
          ) {
            opened = true;
            everOpened = true;
            backoff = RECONNECT_MS.min;
            clearConnectTimer();
            setState('open');
          }
          onControl(control);
        } catch {
          // malformed control frame: ignore
        }
      } else if (opened) onXml(text);
    };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      clearConnectTimer();
      if (!wanted) {
        setState('closed');
        return;
      }
      // A handshake that never opened (403/401/404) will not fix itself by
      // hammering; after the first failure back off to the slow end.
      if (!opened && !everOpened) {
        backoff = RECONNECT_MS.max;
        setState('refused', 'Gateway refused or unavailable');
        const epoch = generation;
        timer = setTimer(() => {
          if (epoch !== generation) return;
          timer = null;
          open();
        }, RECONNECT_MS.max);
        return;
      }
      scheduleReconnect(event?.reason || 'connection lost');
    };
    socket.onerror = () => {
      // onclose follows with the details that matter.
    };
  }

  return Object.freeze({
    /** Connect (or reconnect with a new token). */
    connect(options = {}) {
      generation++;
      token = options.token ? String(options.token) : null;
      identity = options.identity || null;
      wanted = true;
      everOpened = false;
      backoff = RECONNECT_MS.min;
      if (timer !== null) clearTimer(timer);
      timer = null;
      clearConnectTimer();
      if (ws) {
        const old = ws;
        ws = null;
        old.close();
      }
      if (
        !token ||
        !/^[A-Za-z0-9._~-]{24,128}$/.test(token) ||
        !identity?.uid
      ) {
        wanted = false;
        setState('refused', 'Gateway token and device identity are required');
        return;
      }
      open();
    },
    disconnect() {
      generation++;
      wanted = false;
      clearConnectTimer();
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (ws) {
        const old = ws;
        ws = null;
        old.close();
      }
      setState('closed');
    },
    /** Send one CoT event (XML). Returns false when not connected. */
    send(xml) {
      if (state !== 'open') return false;
      return write(xml);
    },
    identify(next) {
      if (next?.uid !== identity?.uid) return false;
      identity = next;
      return (
        state === 'open' &&
        write(
          JSON.stringify({
            op: 'identity',
            uid: identity.uid,
            callsign: identity.callsign,
          }),
        )
      );
    },
    requestStatus() {
      if (state === 'open') write(JSON.stringify({ op: 'status' }));
    },
    state: () => state,
    isOpen: () => state === 'open',
  });
}

/** Obtain an ephemeral operator token only from an explicitly enabled local lab. */
export async function fetchGatewaySession(
  fetchImpl = globalThis.fetch,
  signal,
) {
  const response = await fetchImpl('/api/tak/session', {
    method: 'POST',
    headers: { 'X-TAK-Session': '1' },
    cache: 'no-store',
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok)
    throw new Error(
      'Local TAK session was refused. Use your configured gateway token.',
    );
  const result = await response.json();
  if (!/^[A-Za-z0-9._~-]{24,128}$/.test(result?.token || ''))
    throw new Error('Invalid local TAK session');
  return result;
}

/** Fetch gateway status (works even when the gateway is disabled). */
export async function fetchGatewayStatus(fetchImpl = globalThis.fetch, signal) {
  const response = await fetchImpl(TAK_STATUS_PATH, {
    signal,
    cache: 'no-store',
  });
  if (!response.ok)
    return { enabled: false, reason: `status ${response.status}` };
  return response.json();
}
