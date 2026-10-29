import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureTakPicture,
  readTakPicture,
  PICTURE_MAX_BYTES,
  PICTURE_MAX_CONTACTS,
} from './picture.js';
import {
  createTakStore,
  DEFAULT_CONTACT_LIMIT,
  DEFAULT_CONTACT_BYTES_LIMIT,
} from './store.js';
import { parseCotEvent, isCotStale } from './protocol/cot.js';
import {
  ATAK_SA,
  ATAK_CHAT,
  WINTAK_HOSTILE,
  T0,
} from './protocol/fixtures.mjs';
import { createPictureWorkflow } from './pictureWorkflow.js';
import { createPictureStorage, pictureDatabaseName } from './pictureStorage.js';

const context = Object.freeze({
  storageAllowed: true,
  multiOperator: true,
  storageScope: 'a'.repeat(64),
});
function fixture() {
  const store = createTakStore({ now: () => T0 + 2000 });
  store.apply(parseCotEvent(ATAK_SA), 'network');
  store.apply(parseCotEvent(WINTAK_HOSTILE), 'import');
  store.apply(parseCotEvent(ATAK_CHAT), 'network');
  return store;
}
const encode = (store = fixture()) =>
  captureTakPicture(store.list(), { now: () => T0 + 4000 });

test('retained picture preserves observed/received/stale times and provenance, without live state, chat, own GPS or trails', () => {
  const live = fixture();
  const snapshot = readTakPicture(encode(live));
  assert.equal(snapshot.savedAtMs, T0 + 4000);
  assert.equal(snapshot.contacts.length, 2);
  for (const contact of snapshot.contacts) {
    const original = live.get(contact.uid);
    assert.equal(contact.event.timeMs, original.event.timeMs);
    assert.equal(contact.event.staleMs, original.event.staleMs);
    assert.equal(contact.receivedAtMs, original.receivedAtMs);
    assert.equal(contact.historical.source, original.origin);
    assert.equal(contact.origin, 'snapshot');
    assert.match(contact.callsign, /^HISTORY · /);
    assert.ok(isCotStale(contact.event, T0 + 86_400_000));
    assert.ok(contact.trail.length <= 1);
  }
  const ownUid = live.list()[0].uid;
  assert.equal(
    readTakPicture(captureTakPicture(live.list(), { selfUid: ownUid })).contacts
      .length,
    1,
  );
  assert.throws(
    () => captureTakPicture(live.list().map((c) => ({ ...c, origin: 'self' }))),
    /Own GPS/,
  );
  assert.equal(live.count(), 2);
  assert.equal(live.chats().length, 1);
  assert.equal(live.get(parseCotEvent(ATAK_SA).uid).origin, 'network');
});

test('full live store and maximum historical snapshot stay within the combined contact ceiling', () => {
  const live = createTakStore();
  const event = parseCotEvent(ATAK_SA);
  for (let i = 0; i < DEFAULT_CONTACT_LIMIT; i++)
    live.apply({ ...event, uid: `SYNTHETIC-${i}` }, 'network');
  const picture = readTakPicture(
    captureTakPicture(live.list().slice(0, PICTURE_MAX_CONTACTS)),
  );
  assert.equal(live.count(), DEFAULT_CONTACT_LIMIT);
  assert.equal(picture.contacts.length, PICTURE_MAX_CONTACTS);
  assert.equal(live.count() + picture.contacts.length, 2500);
  assert.ok(
    live.resourceStats().serializedBytes <= DEFAULT_CONTACT_BYTES_LIMIT,
  );
});

test('retained contacts and serialized payload impose additive finite budgets', () => {
  assert.equal(DEFAULT_CONTACT_LIMIT + PICTURE_MAX_CONTACTS, 2500);
  assert.equal(
    DEFAULT_CONTACT_BYTES_LIMIT + PICTURE_MAX_BYTES,
    9 * 1024 * 1024,
  );
  const contact = fixture().list()[0];
  assert.throws(
    () => captureTakPicture(Array(501).fill(contact)),
    /500 contacts/,
  );
  assert.throws(
    () => readTakPicture(' '.repeat(PICTURE_MAX_BYTES + 1)),
    /1 MiB/,
  );
  for (const mutate of [
    (v) => {
      v.contacts.push(v.contacts[0]);
    },
    (v) => {
      v.contacts[0].xml = ATAK_CHAT;
    },
    (v) => {
      v.contacts[0].origin = 'self';
    },
    (v) => {
      v.contacts[0].receivedAtMs = -1;
    },
    (v) => {
      v.savedAtMs = Number.MAX_SAFE_INTEGER;
    },
    (v) => {
      v.contacts = [];
    },
  ]) {
    const value = JSON.parse(encode());
    mutate(value);
    assert.throws(() => readTakPicture(JSON.stringify(value)));
  }
});

test('operator storage is separated and blocked/unapproved contexts cannot resolve a database', () => {
  const names = [
    pictureDatabaseName(context),
    pictureDatabaseName({ ...context, storageScope: 'b'.repeat(64) }),
    pictureDatabaseName({
      storageAllowed: true,
      multiOperator: false,
      storageScope: null,
    }),
  ];
  assert.equal(new Set(names).size, 3);
  assert.equal(
    pictureDatabaseName({ ...context, online: false }),
    names[0],
    'approved offline scope is the same device account',
  );
  for (const invalid of [
    null,
    { ...context, storageAllowed: false },
    { ...context, storageScope: '../bad' },
    { ...context, multiOperator: undefined },
  ])
    assert.throws(() => pictureDatabaseName(invalid));
});

function workflowFixture(options = {}) {
  let saved;
  let marked = 0;
  const updates = [];
  const live = fixture();
  const lifetime = new AbortController();
  const workflow = createPictureWorkflow({
    client: { store: live, identity: () => ({ uid: 'own-device' }) },
    storage: {
      save: async (payload) => {
        saved = payload;
      },
      restore: async () => (saved ? readTakPicture(saved) : null),
      remove: async () => {
        saved = undefined;
      },
      close() {},
      ...options.storage,
    },
    context,
    isCurrent: () => true,
    markPrivate: () => marked++,
    onChange: (state) => updates.push({ ...state, marked }),
    signal: lifetime.signal,
    ...options,
  });
  return {
    workflow,
    live,
    lifetime,
    updates,
    marked: () => marked,
    saved: () => saved,
  };
}

test('fresh consent is necessary; restore is explicit and private before display, hide retains disk and delete removes it', async () => {
  const f = workflowFixture();
  assert.equal(await f.workflow.save(false), false);
  assert.equal(f.saved(), undefined);
  assert.equal(await f.workflow.save(true), true);
  assert.equal(f.workflow.state().picture, null);
  const liveBefore = f.live.list();
  await f.workflow.restore();
  assert.equal(f.workflow.state().picture.contacts.length, 2);
  assert.equal(f.marked(), 1);
  assert.ok(f.updates.filter((s) => s.picture).every((s) => s.marked > 0));
  assert.deepEqual(f.live.list(), liveBefore);
  f.workflow.hide();
  assert.equal(f.workflow.state().picture, null);
  assert.ok(f.saved());
  await f.workflow.restore();
  await f.workflow.remove();
  assert.equal(f.workflow.state().picture, null);
  assert.equal(f.saved(), undefined);
  f.workflow.destroy();
});

test('aborted restore cannot paint after hide, logout or a changed account; concurrent operation is refused', async () => {
  for (const reason of ['hide', 'logout', 'account']) {
    let resolve;
    let current = true;
    const f = workflowFixture({
      storage: {
        restore: () =>
          new Promise((r) => {
            resolve = r;
          }),
        close() {},
      },
      isCurrent: () => current,
    });
    const operation = f.workflow.restore();
    assert.equal(await f.workflow.remove(), false);
    if (reason === 'hide') f.workflow.hide();
    if (reason === 'logout') f.lifetime.abort();
    if (reason === 'account') current = false;
    resolve(readTakPicture(encode()));
    assert.equal(await operation, false);
    assert.equal(f.workflow.state().picture, null);
    assert.equal(f.marked(), 0);
    f.workflow.destroy();
  }
});

test('quota failure is reported without claiming a saved picture or changing live data', async () => {
  const f = workflowFixture({
    storage: {
      save: async () => {
        throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
      },
      close() {},
    },
  });
  assert.equal(await f.workflow.save(true), false);
  assert.equal(f.workflow.state().error, true);
  assert.match(f.workflow.state().message, /quota/);
  assert.equal(f.workflow.state().picture, null);
  assert.equal(f.live.count(), 2);
  f.workflow.destroy();
});

test('IndexedDB late open is closed after logout or blocked open; no transaction is allowed', async () => {
  for (const reason of ['logout', 'blocked']) {
    const request = {};
    let closed = 0;
    const lifetime = new AbortController();
    const storage = createPictureStorage({
      context,
      isCurrent: () => true,
      signal: lifetime.signal,
      indexedDB: { open: () => request },
    });
    const restored = storage.restore();
    const rejected = assert.rejects(restored);
    if (reason === 'logout') lifetime.abort();
    else request.onblocked();
    request.result = {
      close: () => closed++,
      transaction: () => assert.fail('retired open must not start transaction'),
    };
    request.onsuccess();
    await rejected;
    assert.equal(closed, 1);
    storage.close();
  }
});
