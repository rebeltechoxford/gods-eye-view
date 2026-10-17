import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizeBrowserRequest,
  createBrowserAccessPolicy,
  isPrivateBrowserAddress,
} from '../../server/providers/tak/access.js';
import { authorizeUpgrade } from '../../server/providers/tak/gateway.js';

const token = 'synthetic-private-operator-token-0123456789';
const policy = createBrowserAccessPolicy({
  mode: 'private-https',
  origin: 'https://tak.internal:8443',
  bindHost: '10.8.0.1',
  port: 8443,
});
const req = (headers = {}, socket = {}) => ({
  headers: {
    host: 'tak.internal:8443',
    origin: policy.origin,
    'sec-websocket-protocol': 'tak.v1',
    ...headers,
  },
  socket: {
    encrypted: true,
    remoteAddress: '192.168.1.2',
    localAddress: '10.8.0.1',
    localPort: 8443,
    ...socket,
  },
});

test('private access policy permits only explicit HTTPS loopback or RFC1918 listeners', () => {
  assert.ok(Object.isFrozen(policy));
  for (const address of [
    '127.0.0.1',
    '::1',
    '::ffff:10.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
  ])
    assert.equal(isPrivateBrowserAddress(address), true);
  for (const address of [
    '0.0.0.0',
    '8.8.8.8',
    '169.254.169.254',
    '100.64.1.2',
    '172.32.1.1',
    '192.169.0.1',
    '::',
    'fe80::1',
    'fc00::1',
    'example.com',
    '999.1.1.1',
  ])
    assert.equal(isPrivateBrowserAddress(address), false);
  for (const options of [
    { bindHost: '0.0.0.0' },
    { bindHost: '8.8.8.8' },
    { origin: 'http://tak.internal:8443' },
    { origin: 'https://tak.internal:8443/' },
    { origin: 'https://tak.internal:9443' },
    { origin: 'https://8.8.8.8:8443' },
    { origin: 'https://name:password@tak.internal:8443' },
    { port: 0 },
  ])
    assert.throws(() => createBrowserAccessPolicy({ ...policy, ...options }));
});

test('private request authority uses encrypted real socket, exact origin/Host and no forwarded metadata', () => {
  assert.deepEqual(authorizeBrowserRequest(req(), policy), { ok: true });
  for (const socket of [
    { encrypted: false },
    { remoteAddress: '8.8.8.8' },
    { localAddress: '8.8.8.8' },
    { localAddress: '10.8.0.2' },
    { localPort: 9443 },
  ])
    assert.equal(authorizeBrowserRequest(req({}, socket), policy).status, 403);
  for (const headers of [
    { host: 'evil.example:8443', origin: 'https://evil.example:8443' },
    { origin: undefined },
    { origin: 'https://tak.internal:8443/' },
    { origin: 'http://tak.internal:8443' },
    { 'x-forwarded-for': '10.0.0.1' },
    { forwarded: '' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal(authorizeBrowserRequest(req(headers), policy).status, 403);
  assert.deepEqual(
    authorizeBrowserRequest(req({ origin: undefined }), policy, {
      requireOrigin: false,
    }),
    { ok: true },
  );
  assert.equal(
    authorizeBrowserRequest(req(), createBrowserAccessPolicy()).status,
    403,
  );
});

test('session authority comes only from an injected server callback after the access gate', () => {
  const config = { token, accessPolicy: policy };
  assert.equal(
    authorizeUpgrade(
      req({ 'sec-websocket-protocol': `tak.v1,tak.token.${token}` }),
      config,
    ).status,
    401,
  );
  assert.equal(
    authorizeUpgrade(req({ 'x-tak-principal': 'local-operator' }), config)
      .status,
    401,
  );
  assert.deepEqual(
    authorizeUpgrade(req(), config, {
      authenticateSession: () => ({ principal: 'local-operator' }),
    }),
    { ok: true },
  );
  for (const authenticateSession of [
    () => null,
    () => true,
    () => ({ principal: 'someone-else' }),
    () => {
      throw new Error('session unavailable');
    },
  ])
    assert.equal(
      authorizeUpgrade(req(), config, { authenticateSession }).status,
      401,
    );
  assert.equal(
    authorizeUpgrade(
      req(),
      { accessPolicy: policy },
      { authenticateSession: () => ({ principal: 'local-operator' }) },
    ).status,
    401,
  );
  let called = false;
  assert.equal(
    authorizeUpgrade(req({}, { remoteAddress: '8.8.8.8' }), config, {
      authenticateSession: () => {
        called = true;
        return { principal: 'local-operator' };
      },
    }).status,
    403,
  );
  assert.equal(called, false);
});
