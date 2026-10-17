import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { readTakGatewayConfig } from '../../server/providers/tak/config.js';
import {
  TAK_STREAM_DECLARATION,
  createServerLink,
} from '../../server/providers/tak/serverLink.js';
import { parseCotEvent, serializeCotEvent } from '../tak/protocol/cot.js';
import { buildMarker } from '../tak/protocol/builders.js';
import { IDENTITY } from '../tak/protocol/fixtures.mjs';
import {
  TAK_NEGOTIATION_TIMEOUT_MS,
  createTakStreamFramer,
  decodeTakMessage,
  readTakProtocolControl,
} from '../tak/protocol/takProto.js';
import { TAK_PROTO_ORACLE } from '../tak/protocol/takProtoOracle.mjs';

// A synthetic streaming TAK Server that follows the published negotiation:
// offer (t-x-takp-v), await the request (t-x-takp-q), answer (t-x-takp-r),
// then exchange stream frames. It is a protocol fixture, not TAK Server.

const PROTO_UID = 'protouid-synthetic-negotiation';

function controlEvent(type, control) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() + 60_000).toISOString();
  return `${TAK_STREAM_DECLARATION}<event version="2.0" uid="${PROTO_UID}" type="${type}" time="${now}" start="${now}" stale="${stale}" how="m-g"><point lat="0.0" lon="0.0" hae="0.0" ce="999999" le="999999"/><detail><TakControl>${control}</TakControl></detail></event>`;
}

// The on-wire style of official TAK Server 5.7 (StreamingProtoBufOrCoTProtocol):
// single quotes, a standalone declaration, a random-UUID transaction and a
// server version sibling. Values here are synthetic; the shape is what matters.
function takServerStyleEvent(type, uid, control) {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() + 60_000).toISOString();
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes'?><event version='2.0' uid='${uid}' type='${type}' time='${now}' start='${now}' stale='${stale}' how='m-g'><point lat='0.0' lon='0.0' hae='0.0' ce='999999' le='999999'/><detail><TakControl>${control}</TakControl></detail></event>`;
}

async function startSyntheticServer({
  offer = true,
  respond = 'true',
  respondAfterMs = 0,
  style = 'spec',
} = {}) {
  const uuid = '7d8f3a52-0000-4000-8000-synthetic0001';
  const control = (type, body) =>
    style === 'takserver'
      ? takServerStyleEvent(type, uuid, body)
      : controlEvent(type, body);
  const connections = [];
  const server = net.createServer((socket) => {
    const connection = {
      socket,
      xml: '',
      requests: [],
      frames: [],
      mode: 'xml',
      xmlAfterRequest: '',
    };
    connections.push(connection);
    socket.on('error', () => {});
    const framer = createTakStreamFramer({
      onPayload: (payload) => connection.frames.push(decodeTakMessage(payload)),
      onError: (error) => connection.frames.push({ error: error.message }),
    });
    socket.on('data', (chunk) => {
      if (connection.mode === 'protobuf') return framer.push(chunk);
      const text = chunk.toString('utf8');
      if (connection.requests.length) connection.xmlAfterRequest += text;
      connection.xml += text;
      const match = /<event[^>]*t-x-takp-q[\s\S]*?<\/event>/.exec(
        connection.xml,
      );
      if (!match || connection.requests.length) return;
      connection.requests.push(readTakProtocolControl(match[0]));
      const tail = connection.xml.slice(match.index + match[0].length);
      connection.xmlAfterRequest += tail;
      if (respond === null) return;
      setTimeout(() => {
        const answer = control(
          't-x-takp-r',
          style === 'takserver'
            ? `<TakResponse status='${respond}'/>`
            : `<TakResponse status="${respond}"/>`,
        );
        if (respond !== 'true') return socket.write(answer);
        connection.mode = 'protobuf';
        // The accepting response and the first frames share one write.
        socket.write(
          Buffer.concat([
            Buffer.from(answer),
            Buffer.from(
              TAK_PROTO_ORACLE.saFull.stream +
                TAK_PROTO_ORACLE.controlOnly.stream +
                TAK_PROTO_ORACLE.chatWithControl.stream,
              'hex',
            ),
          ]),
        );
      }, respondAfterMs);
    });
    if (offer)
      socket.write(
        style === 'takserver'
          ? control(
              't-x-takp-v',
              "<TakProtocolSupport version='1'/><TakServerVersionInfo serverVersion='5.7-RELEASE-14' apiVersion='3'/>",
            )
          : control(
              't-x-takp-v',
              '<TakProtocolSupport version="1"><DetailExt supportsAll="true"/></TakProtocolSupport>',
            ),
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    connections,
    close: async () => {
      for (const { socket } of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function link(port, { protobuf, timers } = {}) {
  const inbound = [];
  const options = {
    config: {
      host: '127.0.0.1',
      port,
      protocol: 'tcp',
      tls: null,
      protobuf,
    },
    onXml: (xml) => inbound.push(xml),
  };
  if (timers) {
    options.setTimer = (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    };
    options.clearTimer = () => {};
  }
  return { uplink: createServerLink(options), inbound };
}

const marker = (uid) =>
  serializeCotEvent(
    buildMarker(IDENTITY, {
      uid,
      callsign: uid.toUpperCase(),
      lat: 34.36,
      lon: -89.52,
    }),
  );
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await settle(10);
  }
}

test('TAK_SERVER_PROTOBUF is an explicit opt-in on the single-operator uplink', () => {
  const base = {
    TAK_GATEWAY: '1',
    TAK_GATEWAY_TOKEN: 'synthetic-local-operator-token-0123456789',
    TAK_SERVER: '127.0.0.1:8087',
    TAK_SERVER_PROTOCOL: 'tcp',
  };
  assert.equal(readTakGatewayConfig(base).server.protobuf, false);
  assert.equal(
    readTakGatewayConfig({ ...base, TAK_SERVER_PROTOBUF: '1' }).server.protobuf,
    true,
  );
});

test('an accepted negotiation switches both directions to TAK protocol v1 frames', async (t) => {
  const tak = await startSyntheticServer({ respondAfterMs: 120 });
  const { uplink, inbound } = link(tak.port, { protobuf: true });
  t.after(async () => {
    uplink.close();
    await tak.close();
  });
  uplink.send(marker('before-offer'));
  await until(() => tak.connections[0]?.requests.length === 1, 'request');
  const [request] = tak.connections[0].requests;
  assert.deepEqual(
    { kind: request.kind, uid: request.uid, versions: request.versions },
    { kind: 'request', uid: PROTO_UID, versions: [1] },
  );
  assert.equal(uplink.status().encoding, 'requested');
  // Sent while the request is outstanding: must not go out as XML.
  uplink.send(marker('during-request'));
  await until(() => uplink.status().encoding === 'v1', 'acceptance');
  await until(() => tak.connections[0].frames.length === 1, 'held marker');
  uplink.send(marker('after-accept'));
  await until(() => tak.connections[0].frames.length === 2, 'live marker');

  const connection = tak.connections[0];
  assert.match(connection.xml, /uid="before-offer"/);
  assert.equal(connection.xmlAfterRequest, '', 'no XML after the request');
  assert.deepEqual(
    connection.frames.map((frame) => frame.cotEvent?.uid),
    ['during-request', 'after-accept'],
  );
  const live = connection.frames[1].cotEvent;
  assert.equal(live.detail.contact.callsign, 'AFTER-ACCEPT');
  assert.equal(live.lat, 34.36);

  // Inbound frames reach the router as validated XML; control never does.
  await until(() => inbound.length === 2, 'inbound frames');
  const events = inbound.map((xml) => parseCotEvent(xml));
  assert.deepEqual(
    events.map((event) => event.uid),
    [
      'ANDROID-0000synthetic01',
      TAK_PROTO_ORACLE.chatWithControl.values.cotEvent.uid,
    ],
  );
  assert.equal(events[0].detail.callsign, 'VIPER');
  assert.ok(inbound.every((xml) => !xml.includes('t-x-takp')));
  const status = uplink.status();
  assert.equal(status.protocolControl, 2);
  assert.deepEqual(status.protocolOffered, [1]);
  assert.equal(status.rx, 2);
});

test('the TAK Server 5.7 offer/response style negotiates and reuses its transaction UID', async (t) => {
  const tak = await startSyntheticServer({ style: 'takserver' });
  const { uplink, inbound } = link(tak.port, { protobuf: true });
  t.after(async () => {
    uplink.close();
    await tak.close();
  });
  await until(() => uplink.status().encoding === 'v1', 'acceptance');
  const [request] = tak.connections[0].requests;
  assert.equal(request.uid, '7d8f3a52-0000-4000-8000-synthetic0001');
  // The server reads /event/detail/TakControl/TakRequest/@version as "1".
  assert.match(
    tak.connections[0].xml,
    /<TakControl><TakRequest version="1"\/><\/TakControl>/,
  );
  await until(() => inbound.length === 2, 'inbound frames');
  uplink.send(marker('server-style'));
  await until(() => tak.connections[0].frames.length === 1, 'v1 marker');
  assert.equal(tak.connections[0].frames[0].cotEvent.uid, 'server-style');
});

test('without the opt-in the offer is consumed and the link stays on XML', async (t) => {
  const tak = await startSyntheticServer();
  const { uplink, inbound } = link(tak.port, { protobuf: false });
  t.after(async () => {
    uplink.close();
    await tak.close();
  });
  await until(() => uplink.status().protocolControl === 1, 'offer');
  uplink.send(marker('plain-xml'));
  await until(() => /uid="plain-xml"/.test(tak.connections[0].xml), 'xml');
  await settle();
  assert.equal(tak.connections[0].requests.length, 0);
  assert.equal(uplink.status().encoding, 'xml');
  assert.deepEqual(uplink.status().protocolOffered, [1]);
  assert.equal(inbound.length, 0, 'the offer is not a tactical event');
});

test('a denied request resumes XML and releases what was held', async (t) => {
  const tak = await startSyntheticServer({
    respond: 'false',
    respondAfterMs: 80,
  });
  const { uplink } = link(tak.port, { protobuf: true });
  t.after(async () => {
    uplink.close();
    await tak.close();
  });
  await until(() => tak.connections[0]?.requests.length === 1, 'request');
  uplink.send(marker('held-then-xml'));
  await until(
    () => /uid="held-then-xml"/.test(tak.connections[0].xmlAfterRequest),
    'released xml',
  );
  assert.equal(uplink.status().encoding, 'xml');
  assert.equal(uplink.status().protocolDenied, 1);
});

test('an unanswered request times out, reconnects and stays on XML', async (t) => {
  const tak = await startSyntheticServer({ respond: null });
  const timers = [];
  const { uplink } = link(tak.port, { protobuf: true, timers });
  t.after(async () => {
    uplink.close();
    await tak.close();
  });
  await until(() => tak.connections[0]?.requests.length === 1, 'request');
  const timeout = timers.find(
    (timer) => timer.ms === TAK_NEGOTIATION_TIMEOUT_MS,
  );
  assert.ok(timeout, 'negotiation timer armed');
  timeout.fn();
  await until(() => uplink.status().state === 'reconnecting', 'disconnect');
  assert.equal(uplink.status().lastError, 'TAK_PROTOCOL_TIMEOUT');
  assert.equal(uplink.status().protobufRequested, false);
  timers.findLast((timer) => timer.ms === 1000).fn();
  await until(() => tak.connections.length === 2, 'reconnect');
  await until(() => uplink.status().state === 'connected', 'connected');
  await until(() => uplink.status().protocolControl >= 2, 'second offer');
  uplink.send(marker('after-timeout'));
  await until(() => /uid="after-timeout"/.test(tak.connections[1].xml), 'xml');
  assert.equal(tak.connections[1].requests.length, 0);
});

test('a broken stream after acceptance drops the connection instead of guessing', async (t) => {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on('error', () => {});
    socket.write(
      controlEvent('t-x-takp-v', '<TakProtocolSupport version="1"/>'),
    );
    socket.once('data', () =>
      socket.write(
        controlEvent('t-x-takp-r', '<TakResponse status="true"/>') +
          '<event uid="xml-after-accept"/>',
      ),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const timers = [];
  const { uplink, inbound } = link(server.address().port, {
    protobuf: true,
    timers,
  });
  t.after(async () => {
    uplink.close();
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  await until(() => uplink.status().protocolErrors === 1, 'protocol error');
  await until(() => uplink.status().state === 'reconnecting', 'disconnect');
  assert.equal(uplink.status().lastError, 'TAK_PROTOCOL_ERROR');
  assert.equal(inbound.length, 0);
});
