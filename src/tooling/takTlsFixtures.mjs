// Generate ephemeral local test keys; never check private certificates into Git.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function createTakTlsFixtures() {
  const candidates = [
    'openssl',
    path.join(
      process.env.ProgramFiles || 'C:/Program Files',
      'Git/usr/bin/openssl.exe',
    ),
  ];
  let openssl;
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      openssl = candidate;
      break;
    } catch {
      /* try next */
    }
  }
  if (!openssl)
    throw new Error(
      'TLS security tests require OpenSSL (the Git for Windows bundled version is supported)',
    );
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-tak-tls-'));
  const file = (name) => path.join(directory, name);
  const run = (args) =>
    execFileSync(openssl, args, {
      cwd: directory,
      stdio: 'ignore',
      windowsHide: true,
    });
  const cleanup = () => {
    const absolute = path.resolve(directory);
    if (
      path.dirname(absolute) !== path.resolve(tmpdir()) ||
      !path.basename(absolute).startsWith('gev-tak-tls-')
    )
      throw new Error('Unexpected test fixture directory');
    rmSync(absolute, { recursive: true, force: true });
  };
  try {
    for (const name of ['ca', 'other-ca'])
      run([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.pem`,
        '-days',
        '2',
        '-subj',
        `/CN=Synthetic ${name}`,
      ]);
    for (const name of ['server', 'client'])
      run([
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=Synthetic ${name}`,
      ]);
    writeFileSync(
      file('server.ext'),
      'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
    );
    writeFileSync(
      file('wrong-host.ext'),
      'subjectAltName=DNS:wrong.invalid\nextendedKeyUsage=serverAuth\n',
    );
    writeFileSync(file('client.ext'), 'extendedKeyUsage=clientAuth\n');
    const sign = (request, output, extension, days = '2', ca = 'ca') =>
      run([
        'x509',
        '-req',
        '-in',
        `${request}.csr`,
        '-CA',
        `${ca}.pem`,
        '-CAkey',
        `${ca}.key`,
        '-set_serial',
        String(Math.floor(Math.random() * 1000000000) + 1),
        '-out',
        `${output}.pem`,
        '-days',
        days,
        '-extfile',
        `${extension}.ext`,
      ]);
    sign('server', 'server', 'server');
    sign('server', 'wrong-host', 'wrong-host');
    sign('server', 'expired', 'server', '-1');
    sign('client', 'client', 'client');
    sign('client', 'untrusted-client', 'client', '2', 'other-ca');
    return {
      directory,
      file,
      read: (name) => readFileSync(file(name)),
      cleanup,
      clientConfig: {
        cert: file('client.pem'),
        key: file('client.key'),
        ca: file('ca.pem'),
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
