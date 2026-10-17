import { parseXmlDocument, escapeXmlAttribute } from './protocol/xml.js';
import {
  parseCotEvent,
  serializeCotEvent,
  cotKind,
  MAX_COT_EVENT_BYTES,
} from './protocol/cot.js';
import { createTakStore } from './store.js';
import {
  PACKAGE_LIMITS,
  readPackageZip,
  writePackageZip,
  validatePackagePath,
} from './packagesZip.js';

export { PACKAGE_LIMITS } from './packagesZip.js';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const staged = new WeakMap();
const MANIFEST = 'MANIFEST/manifest.xml';
const ALLOWED = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  txt: 'text/plain',
});
function fail(message) {
  throw new Error(`Mission package: ${message}`);
}
function text(value, name, maximum = 128) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail(`invalid ${name}`);
  return value.trim();
}
function xmlText(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    return fail('XML or text is not valid UTF-8');
  }
}
export async function packageSha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function parameters(element) {
  const values = Object.create(null);
  if (element.text.trim()) fail('unexpected manifest text');
  for (const child of element.children) {
    if (
      child.name !== 'Parameter' ||
      child.children.length ||
      child.text.trim() ||
      Object.keys(child.attrs).some((key) => !['name', 'value'].includes(key))
    )
      fail('invalid manifest parameter');
    const name = text(child.attrs.name, 'parameter name', 64);
    if (Object.hasOwn(values, name)) fail('duplicate manifest parameter');
    if (
      typeof child.attrs.value !== 'string' ||
      child.attrs.value.length > 1024
    )
      fail('invalid manifest parameter value');
    values[name] = child.attrs.value;
  }
  return values;
}
function readManifest(bytes) {
  if (bytes.length > PACKAGE_LIMITS.manifestBytes)
    fail('manifest exceeds 128 KiB');
  const root = parseXmlDocument(xmlText(bytes), {
    maxDepth: 6,
    maxNodes: 2000,
    maxAttributes: 4,
    maxTextLength: 1024,
  });
  if (
    root.name !== 'MissionPackageManifest' ||
    root.attrs.version !== '2' ||
    Object.keys(root.attrs).some((key) => key !== 'version') ||
    root.text.trim()
  )
    fail('expected an unnamespaced version-2 MissionPackageManifest');
  const configuration = root.children.filter(
    (child) => child.name === 'Configuration',
  );
  const contents = root.children.filter((child) => child.name === 'Contents');
  if (
    root.children.length !== 2 ||
    configuration.length !== 1 ||
    contents.length !== 1 ||
    Object.keys(configuration[0].attrs).length ||
    Object.keys(contents[0].attrs).length ||
    contents[0].text.trim()
  )
    fail('manifest requires exactly one Configuration and Contents');
  const config = parameters(configuration[0]);
  const uid = text(config.uid, 'package UID', 256),
    name = text(config.name, 'package name');
  if (
    !contents[0].children.length ||
    contents[0].children.length >= PACKAGE_LIMITS.entries
  )
    fail('manifest contents count exceeds its limit');
  const paths = new Set();
  const entries = contents[0].children.map((child) => {
    if (
      child.name !== 'Content' ||
      Object.keys(child.attrs).some(
        (key) => !['zipEntry', 'ignore'].includes(key),
      ) ||
      (child.attrs.ignore !== undefined &&
        !['true', 'false'].includes(child.attrs.ignore))
    )
      fail('invalid manifest Content');
    const path = validatePackagePath(child.attrs.zipEntry);
    if (
      paths.has(path.toLowerCase()) ||
      path.toLowerCase() === MANIFEST.toLowerCase()
    )
      fail('duplicate or recursive manifest content');
    paths.add(path.toLowerCase());
    return {
      path,
      ignored: child.attrs.ignore === 'true',
      parameters: parameters(child),
    };
  });
  return { uid, name, entries };
}
function cotBytes(bytes) {
  if (bytes.length > MAX_COT_EVENT_BYTES) fail('a CoT entry exceeds 64 KiB');
  const xml = xmlText(bytes);
  if (parseXmlDocument(xml).name !== 'event')
    fail('each .cot entry must contain one event');
  const event = parseCotEvent(xml);
  if (
    !event.point ||
    !['sa', 'marker', 'drawing', 'other', 'alert'].includes(
      cotKind(event.type),
    ) ||
    event.type === 'b-a-o-can'
  )
    fail(
      'only positioned contacts, markers and drawings are supported; control/chat events are refused',
    );
  return event;
}
/** Download-only files. MIME is verified here and never used to render a preview. */
export function validatePackageAttachment(name, data) {
  validatePackagePath(name);
  const extension = name.split('.').at(-1).toLowerCase(),
    mime = ALLOWED[extension];
  if (
    !mime ||
    !(data instanceof Uint8Array) ||
    !data.length ||
    data.length > PACKAGE_LIMITS.entryBytes
  )
    fail(
      'attachments must be nonempty PNG, JPEG, PDF or UTF-8 TXT, at most 8 MiB each',
    );
  const starts = (signature) =>
    signature.every((byte, index) => data[index] === byte);
  if (
    (extension === 'png' && !starts([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (['jpg', 'jpeg'].includes(extension) && !starts([255, 216, 255])) ||
    (extension === 'pdf' && !starts([37, 80, 68, 70, 45]))
  )
    fail('attachment extension does not match its file signature');
  if (
    extension === 'txt' &&
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(xmlText(data))
  )
    fail('TXT attachment contains binary control characters');
  return mime;
}

/** Fully validate and hash an archive without touching contact state. */
export async function inspectMissionPackage(input, { signal } = {}) {
  signal?.throwIfAborted();
  if (
    !(input instanceof Uint8Array || input instanceof ArrayBuffer) ||
    input.byteLength > PACKAGE_LIMITS.archiveBytes
  )
    fail('archive exceeds 32 MiB or is not binary ZIP data');
  const source =
    input instanceof Uint8Array ? input.slice() : new Uint8Array(input).slice();
  const files = await readPackageZip(source, { signal });
  const manifestBytes = files.get(MANIFEST);
  if (!manifestBytes) fail(`missing ${MANIFEST}`);
  const manifest = readManifest(manifestBytes);
  if (files.size !== manifest.entries.length + 1)
    fail('unlisted or missing archive files');
  const events = [],
    attachments = [],
    summaries = [],
    uids = new Set();
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    const bytes = files.get(entry.path);
    if (!bytes) fail('manifest references a missing file');
    const sha256 = await packageSha256(bytes);
    if (
      entry.parameters.sha256 !== undefined &&
      (!/^[a-fA-F0-9]{64}$/.test(entry.parameters.sha256) ||
        entry.parameters.sha256.toLowerCase() !== sha256)
    )
      fail('content SHA-256 does not match its manifest');
    const isCot = entry.path.toLowerCase().endsWith('.cot');
    if (
      entry.parameters.isCoT !== undefined &&
      entry.parameters.isCoT !== String(isCot)
    )
      fail('isCoT metadata disagrees with its entry');
    let event;
    if (isCot) {
      event = cotBytes(bytes);
      if (
        (entry.parameters.uid !== undefined &&
          entry.parameters.uid !== event.uid) ||
        uids.has(event.uid)
      )
        fail('duplicate or mismatched CoT UID');
      uids.add(event.uid);
      if (!entry.ignored) events.push(event);
    } else {
      validatePackageAttachment(entry.path, bytes);
      attachments.push({ path: entry.path, bytes });
    }
    summaries.push(
      Object.freeze({
        path: entry.path,
        bytes: bytes.length,
        sha256,
        kind: isCot ? 'cot' : 'attachment',
        uid: event?.uid ?? null,
        ignored: entry.ignored,
      }),
    );
  }
  const sha256 = await packageSha256(source);
  signal?.throwIfAborted();
  const result = Object.freeze({
    uid: manifest.uid,
    name: manifest.name,
    sha256,
    bytes: source.length,
    contacts: events.length,
    attachments: attachments.length,
    contents: Object.freeze(summaries),
  });
  staged.set(result, { events, attachments });
  return result;
}

/** Synchronous preflight + one batched local mutation; never evict existing data. */
export function applyMissionPackage(packageInfo, store) {
  const data = staged.get(packageInfo);
  if (!data) fail('inspect this package before importing it');
  const stats = store.resourceStats();
  const shadow = createTakStore({
    limit: stats.contactLimit,
    byteLimit: stats.byteLimit,
    xmlNodeLimit: stats.xmlNodeLimit,
  });
  let preview;
  try {
    shadow.setSelfUid(store.selfUid());
    shadow.applyAll(
      store.list().map((contact) => contact.event),
      'import',
    );
    preview = shadow.applyAll(data.events, 'import');
    const after = shadow.resourceStats();
    if (after.evictedContacts || after.rejectedContacts)
      fail(
        'package would exceed contact memory limits; clear space before importing',
      );
  } finally {
    shadow.destroy();
  }
  // No await between the preflight and commit: network/clock callbacks cannot
  // interleave. All archive content was validated before either step begins.
  const applied = store.applyAll(data.events, 'import');
  return {
    ...applied,
    attachments: data.attachments.length,
    unchanged: preview.ignored,
  };
}
export function missionPackageAttachment(packageInfo, entryPath) {
  const attachment = staged
    .get(packageInfo)
    ?.attachments.find((entry) => entry.path === entryPath);
  if (!attachment) fail('attachment is not part of this inspected package');
  return {
    name: attachment.path.split('/').at(-1),
    bytes: attachment.bytes.slice(),
  };
}

/** Only the supplied contact snapshots/files enter this archive. No global export permission. */
export async function createMissionPackage({
  name,
  contacts = [],
  attachments = [],
  signal,
}) {
  name = text(name, 'package name');
  if (
    !Array.isArray(contacts) ||
    !Array.isArray(attachments) ||
    (!contacts.length && !attachments.length) ||
    contacts.length + attachments.length >= PACKAGE_LIMITS.entries
  )
    fail('select 1–127 contents');
  const uid = globalThis.crypto.randomUUID(),
    entries = [],
    contents = [],
    seen = new Set();
  let expandedBytes = 0;
  for (const contact of contacts) {
    signal?.throwIfAborted();
    const bytes = encoder.encode(serializeCotEvent(contact.event ?? contact));
    expandedBytes += bytes.length;
    if (expandedBytes > PACKAGE_LIMITS.expandedBytes)
      fail('export exceeds 32 MiB');
    const event = cotBytes(bytes);
    if (seen.has(event.uid)) fail('duplicate export CoT UID');
    seen.add(event.uid);
    const path = `${globalThis.crypto.randomUUID()}/contact.cot`;
    entries.push({ name: path, data: bytes });
    contents.push({
      path,
      parameters: {
        uid: event.uid,
        isCoT: 'true',
        sha256: await packageSha256(bytes),
      },
    });
  }
  for (const attachment of attachments) {
    signal?.throwIfAborted();
    validatePackageAttachment(attachment.name, attachment.bytes);
    expandedBytes += attachment.bytes.length;
    if (expandedBytes > PACKAGE_LIMITS.expandedBytes)
      fail('export exceeds 32 MiB');
    if (attachment.name.includes('/'))
      fail('export attachments require a filename only');
    const path = `${globalThis.crypto.randomUUID()}/${attachment.name}`;
    const bytes = attachment.bytes.slice();
    entries.push({ name: path, data: bytes });
    contents.push({
      path,
      parameters: { name: attachment.name, sha256: await packageSha256(bytes) },
    });
  }
  const parameter = (key, value) =>
    `<Parameter name="${escapeXmlAttribute(key)}" value="${escapeXmlAttribute(value)}"/>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><MissionPackageManifest version="2"><Configuration>${parameter('uid', uid)}${parameter('name', name)}${parameter('onReceiveImport', 'true')}${parameter('onReceiveDelete', 'false')}</Configuration><Contents>${contents
    .map(
      (entry) =>
        `<Content ignore="false" zipEntry="${escapeXmlAttribute(entry.path)}">${Object.entries(
          entry.parameters,
        )
          .map(([key, value]) => parameter(key, value))
          .join('')}</Content>`,
    )
    .join('')}</Contents></MissionPackageManifest>`;
  const manifestData = encoder.encode(manifest);
  if (manifestData.length > PACKAGE_LIMITS.manifestBytes)
    fail('export manifest too large');
  signal?.throwIfAborted();
  const bytes = writePackageZip([
    { name: MANIFEST, data: manifestData },
    ...entries,
  ]);
  const sha256 = await packageSha256(bytes);
  signal?.throwIfAborted();
  return {
    name: `${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'mission'}.zip`,
    bytes,
    sha256,
  };
}
