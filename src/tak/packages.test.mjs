import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import {
  inspectMissionPackage,
  createMissionPackage,
  applyMissionPackage,
  missionPackageAttachment,
  packageSha256,
  validatePackageAttachment,
  PACKAGE_LIMITS,
} from './packages.js';
import {
  readPackageZip,
  writePackageZip,
  crc32,
  validatePackagePath,
} from './packagesZip.js';
import { createTakStore } from './store.js';
import { parseCotEvent, serializeCotEvent } from './protocol/cot.js';
import { createTakClient } from './client.js';

const enc = new TextEncoder(),
  dec = new TextDecoder();
const cot = (uid = 'PACKAGE-TEST', lat = '34.3665') =>
  `<event version="2.0" uid="${uid}" type="a-f-G-U-C" how="h-e" time="2026-10-16T00:00:00Z" start="2026-10-16T00:00:00Z" stale="2030-01-01T00:00:00Z"><point lat="${lat}" lon="-89.5192" hae="9999999" ce="15" le="9999999"/><detail><contact callsign="SYNTHETIC PACKAGE"/></detail></event>`;
const manifest = (contents, extra = '') =>
  `<MissionPackageManifest version="2"><Configuration><Parameter name="uid" value="fixture-uid"/><Parameter name="name" value="Synthetic test"/>${extra}</Configuration><Contents>${contents}</Contents></MissionPackageManifest>`;
const content = (path = 'contact.cot', parameters = '') =>
  `<Content ignore="false" zipEntry="${path}">${parameters}</Content>`;
const archive = (xml = cot(), manifestXml = manifest(content()), extras = []) =>
  writePackageZip([
    { name: 'MANIFEST/manifest.xml', data: enc.encode(manifestXml) },
    { name: 'contact.cot', data: enc.encode(xml) },
    ...extras,
  ]);

// An independent test encoder permits malformed/unsupported metadata that the
// production exporter intentionally cannot construct, including descriptors.
function rawZip(files) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name),
      data = file.data ?? enc.encode('hello');
    const method = file.method ?? 0,
      compressed = method === 8 ? deflateRawSync(data) : data;
    const flags = file.flags ?? 0x800,
      crc = crc32(data),
      size = file.size ?? data.length;
    const extra = file.extra ?? new Uint8Array();
    const local = Buffer.alloc(30 + name.length + extra.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.localFlags ?? flags, 6);
    local.writeUInt16LE(method, 8);
    if (!(flags & 8)) {
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    local.set(name, 30);
    local.set(extra, 30 + name.length);
    const directory = Buffer.alloc(46 + name.length + extra.length);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(0x314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt32LE(file.external ?? 0, 38);
    directory.writeUInt32LE(offset, 42);
    directory.set(name, 46);
    directory.set(extra, 46 + name.length);
    parts.push(local, compressed);
    offset += local.length + compressed.length;
    if (flags & 8) {
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(size, 12);
      parts.push(descriptor);
      offset += descriptor.length;
    }
    central.push(directory);
  }
  const end = Buffer.alloc(22),
    directory = Buffer.concat(central);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

test('Python zipfile deflated v2 fixture validates and imports in one local notification', async () => {
  const bytes = new Uint8Array(
    await fs.readFile(
      new URL('./fixtures/mission-package-v2.zip', import.meta.url),
    ),
  );
  const store = createTakStore();
  let notifications = 0;
  store.subscribe(() => notifications++);
  const info = await inspectMissionPackage(bytes);
  assert.equal(store.count(), 0);
  assert.equal(info.contacts, 1);
  assert.equal(info.attachments, 1);
  assert.equal(info.sha256, await packageSha256(bytes));
  assert.equal(applyMissionPackage(info, store).contact, 1);
  assert.equal(store.get('PACKAGE-SYNTHETIC-1').point.hae, null);
  assert.equal(notifications, 1);
  const attachment = missionPackageAttachment(info, 'fixture/brief.txt');
  assert.match(dec.decode(attachment.bytes), /Synthetic local-only/);
  attachment.bytes.fill(0);
  assert.match(
    dec.decode(missionPackageAttachment(info, 'fixture/brief.txt').bytes),
    /Synthetic local-only/,
  );
  assert.throws(
    () => missionPackageAttachment(info, 'contact.cot'),
    /not part/,
  );
  store.destroy();
});

test('stored exporter writes the selected contacts/files, manifest-v2 paths and integrity identifiers', async () => {
  const one = parseCotEvent(cot('SELECTED'));
  const result = await createMissionPackage({
    name: 'Alpha & Bravo',
    contacts: [one],
    attachments: [{ name: 'brief.txt', bytes: enc.encode('selected only') }],
  });
  assert.equal(result.name, 'Alpha___Bravo.zip');
  const files = await readPackageZip(result.bytes);
  assert.equal(files.size, 3);
  const xml = dec.decode(files.get('MANIFEST/manifest.xml'));
  assert.match(xml, /MissionPackageManifest version="2"/);
  assert.match(xml, /name="name" value="Alpha &amp; Bravo"/);
  assert.match(xml, /name="isCoT" value="true"/);
  assert.match(xml, /name="uid" value="SELECTED"/);
  assert.equal((xml.match(/name="sha256"/g) ?? []).length, 2);
  const info = await inspectMissionPackage(result.bytes);
  assert.equal(info.contacts, 1);
  assert.equal(info.attachments, 1);
  const store = createTakStore();
  applyMissionPackage(info, store);
  assert.deepEqual(
    store.list().map((contact) => contact.uid),
    ['SELECTED'],
  );
  store.destroy();
});

test('importing into a connected client store never publishes a network message', async () => {
  let sent = 0;
  const client = createTakClient({
    createTransport: () => ({
      send() {
        sent++;
        return true;
      },
      connect() {},
      disconnect() {},
    }),
  });
  try {
    const staged = await inspectMissionPackage(archive());
    applyMissionPackage(staged, client.store);
    assert.equal(client.store.count(), 1);
    assert.equal(sent, 0);
    assert.equal(client.counters().tx, 0);
  } finally {
    client.destroy();
  }
});

test('all contents are validated before any contact mutation, including a bad final CoT', async () => {
  const store = createTakStore();
  store.apply(parseCotEvent(cot('EXISTING')), 'local');
  let notifications = 0;
  store.subscribe(() => notifications++);
  const bytes = archive(
    cot('GOOD-FIRST'),
    manifest(content() + content('bad.cot')),
    [{ name: 'bad.cot', data: enc.encode(cot('BAD-LAST', 'not-a-number')) }],
  );
  await assert.rejects(inspectMissionPackage(bytes), /has no valid point/);
  assert.deepEqual(
    store.list().map((c) => c.uid),
    ['EXISTING'],
  );
  assert.equal(notifications, 0);
  store.destroy();
});

test('resource preflight refuses eviction without changing prior contacts or counters', async () => {
  const store = createTakStore({ limit: 1 });
  store.apply(parseCotEvent(cot('EXISTING')), 'local');
  const before = store.resourceStats(),
    info = await inspectMissionPackage(archive());
  assert.throws(() => applyMissionPackage(info, store), /memory limits/);
  assert.deepEqual(store.resourceStats(), before);
  assert.deepEqual(
    store.list().map((c) => c.uid),
    ['EXISTING'],
  );
  const existing = await inspectMissionPackage(archive(cot('EXISTING')));
  assert.equal(applyMissionPackage(existing, store).ignored, 1);
  store.destroy();
});

test('oversized preserved CoT details cannot partially import or bypass the XML-node budget', async () => {
  const store = createTakStore({ xmlNodeLimit: 8 });
  store.apply(parseCotEvent(cot('EXISTING')), 'local');
  const before = store.resourceStats();
  const xml = cot('HEAVY').replace(
    '</detail>',
    '<extension>' + '<x/>'.repeat(10) + '</extension></detail>',
  );
  const info = await inspectMissionPackage(archive(xml));
  assert.throws(() => applyMissionPackage(info, store), /memory limits/);
  assert.deepEqual(store.resourceStats(), before);
  store.destroy();
});

test('descriptor ZIPs inflate correctly, with real decompressed length enforcement', async () => {
  const data = enc.encode('small synthetic payload');
  const bytes = rawZip([{ name: 'data.txt', data, method: 8, flags: 0x808 }]);
  const inconsistent = bytes.slice();
  new DataView(inconsistent.buffer).setUint32(18, 1, true);
  await assert.rejects(readPackageZip(inconsistent), /descriptor metadata/);
  assert.equal(
    dec.decode((await readPackageZip(bytes)).get('data.txt')),
    dec.decode(data),
  );
  await assert.rejects(
    readPackageZip(rawZip([{ name: 'data.txt', data, method: 8, size: 1 }])),
    /declared|length/,
  );
});

test('native method-8 rejects malformed compressed data and aborts an in-flight read', async () => {
  const bytes = rawZip([
    { name: 'data.txt', data: enc.encode('synthetic payload'), method: 8 },
  ]);
  bytes[30 + enc.encode('data.txt').length] = 7; // Reserved DEFLATE block type.
  await assert.rejects(
    readPackageZip(bytes),
    /invalid|compression|data|decompress|block/i,
  );
  const data = globalThis.crypto.getRandomValues(new Uint8Array(65536));
  const controller = new AbortController();
  const pending = readPackageZip(
    rawZip([{ name: 'random.txt', data, method: 8 }]),
    { signal: controller.signal },
  );
  queueMicrotask(() =>
    controller.abort(new Error('operator cancelled active inflate')),
  );
  await assert.rejects(pending, /operator cancelled active inflate/);
});

test('aggregate expansion, truncated directories, ZIP64 and oversized manifests are bounded', async () => {
  const random = globalThis.crypto.getRandomValues(new Uint8Array(65536));
  const aggregate = rawZip(
    Array.from({ length: 6 }, (_, i) => ({
      name: `${i}.txt`,
      data: random,
      size: 6 * 1024 * 1024,
      method: 8,
    })),
  );
  await assert.rejects(readPackageZip(aggregate), /expanded archive/);
  const ordinary = rawZip([{ name: 'data.txt' }]);
  await assert.rejects(
    readPackageZip(ordinary.subarray(0, ordinary.length - 1)),
    /directory/,
  );
  const zip64 = ordinary.slice();
  const view = new DataView(zip64.buffer),
    end = zip64.length - 22;
  view.setUint32(view.getUint32(end + 16, true) + 24, 0xffffffff, true);
  await assert.rejects(readPackageZip(zip64), /ZIP64/);
  const bytes = writePackageZip([
    {
      name: 'MANIFEST/manifest.xml',
      data: enc.encode(' '.repeat(PACKAGE_LIMITS.manifestBytes + 1)),
    },
  ]);
  await assert.rejects(inspectMissionPackage(bytes), /manifest exceeds/);
});

test('ZIP archive attacks are refused before file extraction or application', async (t) => {
  const cases = [
    ['traversal', [{ name: '../data.txt' }], /unsafe/],
    ['absolute', [{ name: '/data.txt' }], /unsafe/],
    ['backslash', [{ name: 'dir\\data.txt' }], /unsafe/],
    ['drive path', [{ name: 'C:/data.txt' }], /unsafe/],
    ['URL path', [{ name: 'https://example.com/a.txt' }], /unsafe/],
    ['encoded traversal', [{ name: '%2e%2e/data.txt' }], /unsafe/],
    ['duplicate', [{ name: 'data.txt' }, { name: 'data.txt' }], /duplicate/],
    ['case alias', [{ name: 'data.txt' }, { name: 'DATA.txt' }], /duplicate/],
    ['Windows device', [{ name: 'CON.txt' }], /unsafe/],
    [
      'Unix link extra',
      [{ name: 'data.txt', extra: new Uint8Array([0x6e, 0x75, 0, 0]) }],
      /Unix link/,
    ],
    [
      'symlink',
      [{ name: 'data.txt', external: (0xa1ff << 16) >>> 0 }],
      /links/,
    ],
    [
      'device node',
      [{ name: 'data.txt', external: (0x21ff << 16) >>> 0 }],
      /links/,
    ],
    ['encryption', [{ name: 'data.txt', flags: 0x801 }], /encryption/],
    ['local discrepancy', [{ name: 'data.txt', localFlags: 0 }], /disagree/],
    [
      'unsupported compression',
      [{ name: 'data.txt', method: 12 }],
      /compression/,
    ],
    [
      'expansion bomb',
      [{ name: 'data.txt', data: new Uint8Array(100000), method: 8 }],
      /ratio/,
    ],
    [
      'entry budget',
      [{ name: 'data.txt', size: PACKAGE_LIMITS.entryBytes + 1 }],
      /size/,
    ],
    [
      'entry count',
      Array.from({ length: 129 }, (_, i) => ({ name: `${i}.txt` })),
      /count/,
    ],
  ];
  for (const [name, files, expected] of cases)
    await t.test(name, async () => {
      await assert.rejects(readPackageZip(rawZip(files)), expected);
    });
  const corrupt = rawZip([{ name: 'data.txt' }]);
  corrupt[38] ^= 1;
  await assert.rejects(readPackageZip(corrupt), /CRC/);
  const hidden = rawZip([{ name: 'data.txt' }]);
  const view = new DataView(hidden.buffer);
  const end = hidden.length - 22;
  view.setUint32(view.getUint32(end + 16, true) + 42, 1, true);
  await assert.rejects(readPackageZip(hidden), /header|overlapping/);
  await assert.rejects(
    readPackageZip(new Uint8Array(PACKAGE_LIMITS.archiveBytes + 1)),
    /32 MiB/,
  );
});

test('manifest and content allowlists refuse unlisted, mismatched, active and privileged files', async (t) => {
  const cases = [
    [
      'unlisted',
      archive(cot(), manifest(content()), [
        { name: 'extra.txt', data: enc.encode('hello') },
      ]),
      /unlisted/,
    ],
    ['missing', archive(cot(), manifest(content('missing.cot'))), /missing/],
    [
      'bad hash',
      archive(
        cot(),
        manifest(
          content(
            'contact.cot',
            '<Parameter name="sha256" value="' + '0'.repeat(64) + '"/>',
          ),
        ),
      ),
      /SHA-256/,
    ],
    [
      'UID mismatch',
      archive(
        cot(),
        manifest(
          content('contact.cot', '<Parameter name="uid" value="wrong"/>'),
        ),
      ),
      /UID/,
    ],
    [
      'duplicate parameter',
      archive(
        cot(),
        manifest(content(), '<Parameter name="name" value="Other"/>'),
      ),
      /duplicate/,
    ],
    [
      'external entity',
      archive(cot(), '<!DOCTYPE x SYSTEM "https://forbidden.invalid"><x/>'),
      /DTD/,
    ],
    [
      'wrong version',
      archive(cot(), manifest(content()).replace('version="2"', 'version="3"')),
      /version-2/,
    ],
    [
      'namespace alias',
      archive(
        cot(),
        manifest(content()).replace(
          '<MissionPackageManifest ',
          '<MissionPackageManifest xmlns="urn:other" ',
        ),
      ),
      /version-2/,
    ],
    [
      'remote URL',
      archive(
        cot(),
        manifest(content('https://forbidden.invalid/contact.cot')),
      ),
      /unsafe/,
    ],
    [
      'HTML',
      archive(cot(), manifest(content() + content('payload.html')), [
        { name: 'payload.html', data: enc.encode('<script>alert(1)</script>') },
      ]),
      /attachments/,
    ],
    [
      'certificate',
      archive(cot(), manifest(content() + content('client.p12')), [
        { name: 'client.p12', data: enc.encode('secret') },
      ]),
      /attachments/,
    ],
    [
      'nested ZIP',
      archive(cot(), manifest(content() + content('nested.zip')), [
        { name: 'nested.zip', data: archive() },
      ]),
      /attachments/,
    ],
    [
      'mismatched image',
      archive(cot(), manifest(content() + content('fake.png')), [
        { name: 'fake.png', data: enc.encode('<svg/>') },
      ]),
      /signature/,
    ],
    [
      'binary TXT',
      archive(cot(), manifest(content() + content('binary.txt')), [
        { name: 'binary.txt', data: new Uint8Array([0, 1, 2]) },
      ]),
      /binary/,
    ],
    [
      'delete event',
      archive(cot().replace('type="a-f-G-U-C"', 'type="t-x-d-d"')),
      /control/,
    ],
    [
      'chat event',
      archive(cot().replace('type="a-f-G-U-C"', 'type="b-t-f"')),
      /control/,
    ],
    ['two events', archive(cot() + cot('SECOND')), /root|document|event/i],
    [
      'duplicate UID',
      archive(cot(), manifest(content() + content('second.cot')), [
        { name: 'second.cot', data: enc.encode(cot()) },
      ]),
      /UID/,
    ],
  ];
  for (const [name, bytes, expected] of cases)
    await t.test(name, async () => {
      await assert.rejects(inspectMissionPackage(bytes), expected);
    });
});

test('manifest ignore=true does not apply that contact, while all ignored files are still validated', async () => {
  const info = await inspectMissionPackage(
    archive(
      cot(),
      manifest(content().replace('ignore="false"', 'ignore="true"')),
    ),
  );
  assert.equal(info.contacts, 0);
  const store = createTakStore();
  assert.equal(applyMissionPackage(info, store).contact, 0);
  assert.equal(store.count(), 0);
  store.destroy();
});

test('abort stops asynchronous validation/export; no incomplete stage can be applied', async () => {
  const controller = new AbortController();
  controller.abort(new Error('operator cleared session'));
  await assert.rejects(
    inspectMissionPackage(archive(), { signal: controller.signal }),
    /cleared session/,
  );
  await assert.rejects(
    createMissionPackage({
      name: 'Test',
      contacts: [parseCotEvent(cot())],
      signal: controller.signal,
    }),
    /cleared session/,
  );
  assert.throws(
    () => applyMissionPackage({ contacts: 1 }, createTakStore()),
    /inspect/,
  );
});

test('attachment signatures and path rules apply identically to exports', async () => {
  assert.equal(
    validatePackageAttachment(
      'map.png',
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    ),
    'image/png',
  );
  assert.throws(() => validatePackagePath('folder/../file.txt'), /unsafe/);
  await assert.rejects(
    createMissionPackage({
      name: 'Test',
      attachments: [{ name: 'script.js', bytes: enc.encode('alert(1)') }],
    }),
    /attachments/,
  );
  await assert.rejects(
    createMissionPackage({
      name: 'Test',
      contacts: [parseCotEvent(cot()), parseCotEvent(cot())],
    }),
    /duplicate/,
  );
  await assert.rejects(
    createMissionPackage({ name: 'Test', contacts: [] }),
    /select/,
  );
  assert.equal(
    serializeCotEvent(parseCotEvent(cot())).includes('PACKAGE-TEST'),
    true,
  );
});
