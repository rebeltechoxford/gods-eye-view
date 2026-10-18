import test from 'node:test';
import assert from 'node:assert/strict';
import { describeUplinks } from './ui.js';

const gateway = (mesh, server) => ({
  gateway: { mesh, server, bridge: false, browsers: 1 },
});

test('uplink summary is unchanged for XML-only links', () => {
  assert.equal(
    describeUplinks(
      gateway(
        { group: '239.2.3.1:6969', state: 'joined', rx: 4, tx: 1, protobuf: 0 },
        {
          endpoint: 'tls://10.0.0.5:8089',
          state: 'connected',
          encoding: 'xml',
        },
      ),
    ),
    'Mesh 239.2.3.1:6969: joined (rx 4 / tx 1)\nServer tls://10.0.0.5:8089: connected\nBridge: off · Browsers: 1',
  );
  assert.equal(describeUplinks({ gateway: { enabled: false } }), '');
});

test('uplink summary reports TAK protocol v1 traffic and server encoding', () => {
  const text = describeUplinks(
    gateway(
      {
        group: '239.2.3.1:6969',
        state: 'joined',
        rx: 12,
        tx: 3,
        protobuf: 9,
        protobufIncomplete: 2,
        protobufRejected: 1,
        protobufUnsupported: 2,
      },
      { endpoint: 'tls://10.0.0.5:8089', state: 'connected', encoding: 'v1' },
    ),
  );
  assert.match(
    text,
    /\(rx 12 \/ tx 3 · TAK v1 9 · partly decoded 2 · refused 3\)/,
  );
  assert.match(text, /connected · TAK protocol v1$/m);
  assert.match(
    describeUplinks(
      gateway(null, {
        endpoint: 'e',
        state: 'connected',
        encoding: 'requested',
      }),
    ),
    /requesting TAK protocol v1/,
  );
});
