import {
  createHash,
  createPrivateKey,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';
import { readTakGatewayConfig } from './config.js';

export const MAX_TAK_PRINCIPALS = 8;
export const MAX_PRINCIPALS_FILE_BYTES = 64 * 1024;
export const MAX_PRINCIPAL_SESSIONS = 4;
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9._~-]{24,128}$/;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (reason) => {
  throw new Error(`TAK principal configuration: ${reason}`);
};
function keys(value, allowed) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}
function boundedFile(file, maximum) {
  let handle;
  try {
    handle = openSync(file, 'r');
    const metadata = fstatSync(handle);
    if (!metadata.isFile() || metadata.size > maximum)
      fail('file is not a bounded regular file');
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0,
      count;
    while (
      length < bytes.length &&
      (count = readSync(handle, bytes, length, bytes.length - length, null))
    )
      length += count;
    if (!length || length > maximum) fail('file size is outside its limit');
    return bytes.subarray(0, length);
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** Strict, server-only snapshot. Browser CoT labels never participate in authorization. */
export function readTakPrincipals(file) {
  const absolute = path.resolve(file);
  let input;
  try {
    input = JSON.parse(
      boundedFile(absolute, MAX_PRINCIPALS_FILE_BYTES).toString('utf8'),
    );
  } catch {
    return fail('cannot read a valid bounded JSON file');
  }
  if (
    !keys(input, ['schemaVersion', 'principals']) ||
    input.schemaVersion !== 1 ||
    !Array.isArray(input.principals) ||
    !input.principals.length ||
    input.principals.length > MAX_TAK_PRINCIPALS
  )
    fail('expected schemaVersion 1 and 1–8 principals');
  const principals = new Map(),
    hashes = new Set(),
    certificates = new Set(),
    publicKeys = new Set(),
    commonNames = new Set();
  for (const entry of input.principals) {
    if (
      !keys(entry, ['id', 'role', 'enabled', 'tokenSha256', 'server']) ||
      typeof entry.id !== 'string' ||
      !ID.test(entry.id) ||
      principals.has(entry.id) ||
      !['operator', 'observer'].includes(entry.role) ||
      typeof entry.enabled !== 'boolean' ||
      typeof entry.tokenSha256 !== 'string' ||
      !HASH.test(entry.tokenSha256) ||
      hashes.has(entry.tokenSha256)
    )
      fail('invalid or duplicate principal, role, enabled flag or token hash');
    hashes.add(entry.tokenSha256);
    let server = null,
      material = null;
    if (entry.enabled) {
      const upstream = entry.server;
      if (
        !keys(upstream, ['host', 'port', 'cert', 'key', 'ca']) ||
        typeof upstream.host !== 'string' ||
        !upstream.host.length ||
        upstream.host.length > 253 ||
        !Number.isInteger(upstream.port) ||
        upstream.port < 1 ||
        upstream.port > 65535 ||
        !['cert', 'key', 'ca'].every(
          (key) =>
            typeof upstream[key] === 'string' &&
            upstream[key].length > 0 &&
            upstream[key].length <= 4096,
        )
      )
        fail(
          'each enabled principal requires one fixed PEM mutual-TLS upstream',
        );
      const configured = readTakGatewayConfig({
        TAK_GATEWAY: '1',
        TAK_GATEWAY_TOKEN: 'internal-validation-token-not-a-browser-credential',
        TAK_SERVER: `${upstream.host.includes(':') ? `[${upstream.host}]` : upstream.host}:${upstream.port}`,
        TAK_SERVER_PROTOCOL: 'tls',
        TAK_SERVER_CERT: upstream.cert,
        TAK_SERVER_KEY: upstream.key,
        TAK_SERVER_CA: upstream.ca,
      });
      if (configured.errors.length || !configured.server)
        fail('invalid TLS upstream address');
      try {
        material = Object.fromEntries(
          ['cert', 'key', 'ca'].map((key) => [
            key,
            boundedFile(
              path.resolve(path.dirname(absolute), upstream[key]),
              256 * 1024,
            ),
          ]),
        );
        const certificate = new X509Certificate(material.cert);
        const commonName = certificate.toLegacyObject().subject.CN;
        const publicKey = hash(
          certificate.publicKey.export({ format: 'der', type: 'spki' }),
        );
        if (
          typeof commonName !== 'string' ||
          !commonName.trim() ||
          commonName.length > 256 ||
          /[\x00-\x1f\x7f]/.test(commonName) ||
          commonNames.has(commonName.trim().toLowerCase()) ||
          Date.now() < Date.parse(certificate.validFrom) ||
          Date.now() >= Date.parse(certificate.validTo) ||
          !certificate.checkPrivateKey(createPrivateKey(material.key)) ||
          certificates.has(certificate.fingerprint256) ||
          publicKeys.has(publicKey)
        )
          fail('expired, mismatched or reused client credential');
        // Validate CA encoding at startup; actual trust and hostname checks remain TLS's job.
        new X509Certificate(material.ca);
        certificates.add(certificate.fingerprint256);
        publicKeys.add(publicKey);
        commonNames.add(commonName.trim().toLowerCase());
      } catch {
        return fail(
          'client PEM credential is invalid, expired, mismatched or reused',
        );
      }
      server = Object.freeze({
        ...configured.server,
        tls: Object.freeze({ material: Object.freeze(material) }),
      });
    }
    const generation = hash(
      JSON.stringify({
        id: entry.id,
        role: entry.role,
        enabled: entry.enabled,
        tokenSha256: entry.tokenSha256,
        host: server?.host,
        port: server?.port,
        material:
          material &&
          Object.fromEntries(
            Object.entries(material).map(([key, bytes]) => [key, hash(bytes)]),
          ),
      }),
    );
    principals.set(
      entry.id,
      Object.freeze({
        id: entry.id,
        role: entry.role,
        enabled: entry.enabled,
        tokenSha256: entry.tokenSha256,
        generation,
        storageScope: hash(`gev-tak-storage-v1:${generation}`),
        server,
      }),
    );
  }
  return principals;
}

export function authenticateTakPrincipal(principals, id, token) {
  const principal = typeof id === 'string' ? principals.get(id) : null;
  const validToken = typeof token === 'string' && TOKEN.test(token);
  const expected = Buffer.from(principal?.tokenSha256 || '0'.repeat(64), 'hex');
  const actual = Buffer.from(hash(validToken ? token : ''), 'hex');
  const matches = timingSafeEqual(expected, actual);
  return validToken && matches && principal?.enabled ? principal : null;
}

export function principalGatewayConfig(principal, accessPolicy) {
  return Object.freeze({
    enabled: true,
    token: randomBytes(32).toString('hex'),
    principal: principal.id,
    role: principal.role,
    multiOperator: true,
    storageScope: principal.storageScope,
    accessPolicy,
    localBootstrap: false,
    mesh: null,
    server: principal.server,
    bridge: false,
    browserLimit: MAX_PRINCIPAL_SESSIONS,
    callsign: `GEV-${principal.id}`.slice(0, 40),
    errors: Object.freeze([]),
  });
}
