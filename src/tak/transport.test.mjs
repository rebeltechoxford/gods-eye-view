import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGatewayTransport,
  fetchGatewaySession,
  fetchGatewayStatus,
  CONNECT_TIMEOUT_MS,
  MAX_TRANSPORT_BUFFER_BYTES,
  MAX_TRANSPORT_FRAME_BYTES,
  SESSION_PROBE_TIMEOUT_MS,
} from './transport.js';

function setup({ fetchImpl } = {}) {
  const sockets = [];
  const timers = new Map();
  let sequence = 0;
  const states = [];
  const received = [];
  const controls = [];
  class Socket {
    constructor(url, protocols) {
      Object.assign(this, {
        url,
        protocols,
        readyState: 0,
        bufferedAmount: 0,
        sent: [],
      });
      sockets.push(this);
    }
    send(text) {
      if (this.fail) throw new Error('closed');
      this.sent.push(text);
    }
    close() {
      this.readyState = 3;
      this.onclose?.({ reason: 'closed' });
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    control(value) {
      this.onmessage?.({ data: JSON.stringify(value) });
    }
  }
  const transport = createGatewayTransport({
    onXml: (xml) => received.push(xml),
    onControl: (control) => controls.push(control),
    onState: (state) => states.push(state),
    url: 'ws://127.0.0.1:4174/api/tak/ws',
    WebSocketImpl: Socket,
    fetchImpl,
    setTimer(fn, ms) {
      timers.set(++sequence, { fn, ms });
      return sequence;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const identity = {
    uid: 'GEV-00000000-0000-4000-8000-000000000001',
    callsign: 'SYNTHETIC',
  };
  const connect = () =>
    transport.connect({ token: 'synthetic-token-for-tests-only', identity });
  return {
    transport,
    identity,
    connect,
    sockets,
    timers,
    states,
    received,
    controls,
  };
}

test('identity is authenticated before CoT is allowed and tokens remain in subprotocol only', () => {
  const s = setup();
  s.connect();
  const socket = s.sockets[0];
  socket.open();
  assert.equal(s.transport.send('<event/>'), false);
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    op: 'identity',
    ...s.identity,
  });
  assert.equal(socket.url.includes('token'), false);
  socket.control({ op: 'identity', uid: 'wrong' });
  assert.equal(s.transport.isOpen(), false);
  socket.control({ op: 'identity', uid: s.identity.uid });
  assert.equal(s.transport.isOpen(), true);
  assert.equal(s.transport.send('<event/>'), true);
  assert.equal(s.timers.size, 0);
  s.transport.disconnect();
});

test('send failures and slow browser sockets return unsent without unbounded queues', () => {
  const s = setup();
  s.connect();
  const socket = s.sockets[0];
  socket.open();
  socket.control({ op: 'identity', uid: s.identity.uid });
  socket.bufferedAmount = MAX_TRANSPORT_BUFFER_BYTES;
  assert.equal(s.transport.send('x'), false);
  socket.bufferedAmount = 0;
  socket.fail = true;
  assert.equal(s.transport.send('x'), false);
  socket.fail = false;
  assert.equal(s.transport.send('x'.repeat(65 * 1024)), false);
  s.transport.disconnect();
});

test('disconnect cancels authentication/reconnect timers and retired callbacks cannot reopen', () => {
  const s = setup();
  s.connect();
  const socket = s.sockets[0];
  const pending = [...s.timers.values()].find(
    (t) => t.ms === CONNECT_TIMEOUT_MS,
  );
  pending.fn();
  assert.equal(s.transport.state(), 'reconnecting');
  const retry = [...s.timers.values()].find((t) => t.ms !== CONNECT_TIMEOUT_MS);
  s.transport.disconnect();
  assert.equal(s.timers.size, 0);
  socket.open();
  retry.fn();
  assert.equal(s.sockets.length, 1);
  assert.equal(s.transport.state(), 'closed');
});

test('invalid replacement credentials close an existing connection', () => {
  const s = setup();
  s.connect();
  const socket = s.sockets[0];
  s.transport.connect({ token: '', identity: s.identity });
  assert.equal(socket.readyState, 3);
  assert.equal(s.transport.state(), 'refused');
  assert.equal(s.timers.size, 0);
});

test('private HTTPS sessions use cookie authentication without exposing the operator token', () => {
  const s = setup();
  s.transport.connect({ session: true, identity: s.identity });
  const socket = s.sockets[0];
  assert.deepEqual(socket.protocols, ['tak.v1']);
  socket.open();
  assert.equal(s.transport.send('<event/>'), false);
  socket.control({ op: 'identity', uid: s.identity.uid });
  assert.equal(s.transport.isOpen(), true);
  s.transport.disconnect();
});

test('explicit cookie-session expiration locks the transport without retrying an expired session', () => {
  const s = setup();
  s.transport.connect({ session: true, identity: s.identity });
  const socket = s.sockets[0];
  socket.open();
  socket.control({ op: 'identity', uid: s.identity.uid });
  socket.readyState = 3;
  socket.onclose({ code: 1008, reason: 'session expired' });
  assert.equal(s.transport.state(), 'refused');
  assert.equal(s.timers.size, 0);
  assert.deepEqual(s.controls.at(-1), { op: 'session-expired' });
  assert.equal(s.transport.send('<event/>'), false);
});

test('failed cookie upgrade probes same-origin status and clears revoked sessions', async () => {
  let request;
  const s = setup({
    fetchImpl: async (...args) => {
      request = args;
      return { status: 401 };
    },
  });
  s.transport.connect({ session: true, identity: s.identity });
  s.sockets[0].onclose({ code: 1006, reason: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request[0], '/api/tak/status');
  assert.equal(request[1].cache, 'no-store');
  assert.equal(request[1].credentials, 'same-origin');
  assert.equal(s.transport.state(), 'refused');
  assert.deepEqual(s.controls, [{ op: 'session-expired' }]);
  assert.equal(s.timers.size, 0);
});

test('unavailable cookie status probes retain bounded reconnect behavior without claiming expiry', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('offline');
    },
    async () => ({ status: 503 }),
  ]) {
    const s = setup({ fetchImpl });
    s.transport.connect({ session: true, identity: s.identity });
    s.sockets[0].onclose({ code: 1006 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.transport.state(), 'refused');
    assert.deepEqual(s.controls, []);
    assert.equal(s.timers.size, 1);
    assert.equal([...s.timers.values()][0].ms, 30000);
    s.transport.disconnect();
  }
});

test('cookie probe timeout and retired resolutions cannot affect new attempts or disconnected clients', async () => {
  let resolve;
  let signal;
  const s = setup({
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  s.transport.connect({ session: true, identity: s.identity });
  s.sockets[0].onclose({ code: 1006 });
  await Promise.resolve();
  const timeout = [...s.timers.values()].find(
    (entry) => entry.ms === SESSION_PROBE_TIMEOUT_MS,
  );
  timeout.fn();
  assert.equal(signal.aborted, true);
  assert.deepEqual(s.controls, []);
  assert.equal(s.transport.state(), 'refused');
  s.transport.connect({ session: true, identity: s.identity });
  resolve({ status: 401 });
  await new Promise((done) => setImmediate(done));
  assert.equal(s.transport.state(), 'connecting');
  assert.deepEqual(s.controls, []);
  s.sockets[1].onclose({ code: 1006 });
  await Promise.resolve();
  s.transport.disconnect();
  assert.equal(signal.aborted, true);
  resolve({ status: 401 });
  await new Promise((done) => setImmediate(done));
  assert.equal(s.transport.state(), 'closed');
  assert.deepEqual(s.controls, []);
  assert.equal(s.timers.size, 0);
});

test('bootstrap is explicit same-origin POST and refused sessions never provide fallback credentials', async () => {
  let args;
  const session = await fetchGatewaySession(async (...values) => {
    args = values;
    return {
      ok: true,
      json: async () => ({ token: 'synthetic-token-for-tests-only' }),
    };
  });
  assert.equal(args[0], '/api/tak/session');
  assert.equal(args[1].method, 'POST');
  assert.equal(args[1].cache, 'no-store');
  assert.equal(session.token, 'synthetic-token-for-tests-only');
  await assert.rejects(
    fetchGatewaySession(async () => ({ ok: false })),
    /refused/,
  );
});

test('initial HTTP401 is an expired operator session; network/server failures are ordinary unavailable status', async () => {
  const expired = await fetchGatewayStatus(async () => ({
    ok: false,
    status: 401,
  }));
  assert.equal(expired.sessionExpired, true);
  assert.equal(expired.enabled, false);
  const unavailable = await fetchGatewayStatus(async () => ({
    ok: false,
    status: 503,
  }));
  assert.equal(unavailable.sessionExpired, undefined);
  assert.equal(unavailable.enabled, false);
});

test('inbound CoT waits for identity acknowledgement and duplicate ACKs do not reopen', () => {
  const s = setup();
  s.connect();
  const socket = s.sockets[0];
  socket.open();
  socket.onmessage({ data: '<event/>' });
  assert.deepEqual(s.received, []);
  socket.control({ op: 'identity', uid: s.identity.uid });
  socket.control({ op: 'identity', uid: s.identity.uid });
  assert.equal(s.states.filter((state) => state === 'open').length, 1);
  socket.onmessage({ data: '<event/>' });
  assert.deepEqual(s.received, ['<event/>']);
  s.transport.disconnect();
});

test('inbound text frame byte limits apply to controls and CoT before parsing', () => {
  for (const text of [
    '{'.repeat(MAX_TRANSPORT_FRAME_BYTES + 1),
    'é'.repeat(MAX_TRANSPORT_FRAME_BYTES / 2 + 1),
  ]) {
    const s = setup();
    s.connect();
    const socket = s.sockets[0];
    socket.open();
    socket.control({ op: 'identity', uid: s.identity.uid });
    socket.onmessage({ data: text });
    assert.equal(socket.readyState, 3);
    assert.deepEqual(s.received, []);
    s.transport.disconnect();
  }
});

test('retired reconnect callbacks cannot replace a newly authorized attempt', () => {
  const s = setup();
  s.connect();
  [...s.timers.values()].find((timer) => timer.ms === CONNECT_TIMEOUT_MS).fn();
  const retry = [...s.timers.values()].find(
    (timer) => timer.ms !== CONNECT_TIMEOUT_MS,
  );
  s.connect();
  assert.equal(s.sockets.length, 2);
  retry.fn();
  assert.equal(s.sockets.length, 2);
  s.transport.disconnect();
});
