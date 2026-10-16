import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCotRouter,
  createDedupCache,
  createRateLimiter,
} from './router.js';
import { parseCotEvent } from './cot.js';
import { buildMarker } from './builders.js';
import { ATAK_SA, IDENTITY, T0, WINTAK_HOSTILE } from './fixtures.mjs';

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => (t += ms);
  return now;
}

function link(id, kind, limits) {
  const sent = [];
  return {
    id,
    kind,
    limits,
    sent,
    send: (xml, event) => sent.push({ xml, uid: event.uid }),
  };
}

test('dedup cache remembers keys inside the window and stays bounded', () => {
  const now = clock();
  const cache = createDedupCache({ windowMs: 1000, capacity: 3, now });
  assert.equal(cache.check('a'), false);
  assert.equal(cache.check('a'), true);
  now.advance(1000);
  assert.equal(cache.check('a'), false, 'expired keys are new again');
  for (const k of ['b', 'c', 'd', 'e']) cache.check(k);
  assert.ok(cache.size() <= 3);
});

test('rate limiter refills over time', () => {
  const now = clock();
  const limiter = createRateLimiter({ rate: 2, burst: 2, now });
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
  now.advance(500);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
});

test('fans out to every other link, never back to the origin', () => {
  const router = createCotRouter({ now: clock() });
  const a = link('a', 'browser');
  const b = link('b', 'mesh');
  const c = link('c', 'server');
  [a, b, c].forEach((l) => router.addLink(l));
  const seen = [];
  router.subscribe((event, meta) => seen.push([event.uid, meta.from?.id]));
  assert.equal(router.receiveXml(ATAK_SA, 'b').ok, true);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent.length, 0);
  assert.equal(c.sent.length, 1);
  assert.deepEqual(seen, [['ANDROID-0000synthetic01', 'b']]);
  // Peers receive normalised XML, never the raw input (no declaration).
  assert.equal(a.sent[0].xml.startsWith('<event '), true);
  assert.deepEqual(parseCotEvent(a.sent[0].xml).detail.group, {
    name: 'Cyan',
    role: 'Team Lead',
  });
});

test('mesh floods: the same report from several links is delivered once', () => {
  const router = createCotRouter({ now: clock() });
  const a = link('a', 'mesh');
  const b = link('b', 'mesh');
  const sink = link('sink', 'browser');
  [a, b, sink].forEach((l) => router.addLink(l));
  assert.equal(router.receiveXml(WINTAK_HOSTILE, 'a').ok, true);
  assert.deepEqual(router.receiveXml(WINTAK_HOSTILE, 'b'), {
    ok: false,
    reason: 'duplicate',
    event: parseCotEvent(WINTAK_HOSTILE),
  });
  assert.equal(router.receiveXml(WINTAK_HOSTILE, 'a').reason, 'duplicate');
  assert.equal(sink.sent.length, 1);
  assert.equal(router.stats().duplicate, 2);
});

test('a newer report of the same uid is not a duplicate', () => {
  const router = createCotRouter({ now: clock() });
  const sink = link('sink', 'browser');
  router.addLink(sink);
  const m1 = buildMarker(
    IDENTITY,
    { uid: 'm', callsign: 'M', lat: 1, lon: 1 },
    { nowMs: T0 },
  );
  const m2 = buildMarker(
    IDENTITY,
    { uid: 'm', callsign: 'M', lat: 2, lon: 2 },
    { nowMs: T0 + 1 },
  );
  assert.equal(router.publish(m1).ok, true);
  assert.equal(router.publish(m2).ok, true);
  assert.equal(router.publish(m2).reason, 'duplicate');
  assert.equal(sink.sent.length, 2);
});

test('policy decides which links feed which', () => {
  const router = createCotRouter({
    now: clock(),
    policy: ({ from, to }) => !(from.kind === 'mesh' && to.kind === 'server'),
  });
  const mesh = link('mesh', 'mesh');
  const server = link('server', 'server');
  const browser = link('browser', 'browser');
  [mesh, server, browser].forEach((l) => router.addLink(l));
  router.receiveXml(ATAK_SA, 'mesh');
  assert.equal(server.sent.length, 0);
  assert.equal(browser.sent.length, 1);
  router.receiveXml(WINTAK_HOSTILE, 'server');
  assert.equal(mesh.sent.length, 1);
});

test('a throwing policy, link or subscriber cannot break delivery', () => {
  const audits = [];
  const router = createCotRouter({
    now: clock(),
    policy: ({ to }) => {
      if (to.id === 'bad-policy') throw new Error('boom');
      return true;
    },
    onAudit: (entry) => audits.push(entry.action),
  });
  router.addLink({
    id: 'broken',
    kind: 'mesh',
    send: () => {
      throw new Error('socket gone');
    },
  });
  router.addLink({
    id: 'bad-policy',
    kind: 'mesh',
    send: () => assert.fail('policy threw; must not send'),
  });
  const ok = link('ok', 'browser');
  router.addLink(ok);
  router.subscribe(() => {
    throw new Error('listener');
  });
  let delivered = 0;
  router.subscribe(() => delivered++);
  assert.equal(router.receiveXml(ATAK_SA, null).ok, true);
  assert.equal(ok.sent.length, 1);
  assert.equal(delivered, 1);
  assert.ok(audits.includes('send-failed'));
});

test('invalid, oversized and rate-limited input is refused and counted', () => {
  const now = clock();
  const router = createCotRouter({ now });
  const noisy = link('noisy', 'browser', { rate: 1, burst: 2 });
  router.addLink(noisy);
  assert.match(router.receiveXml('<event/>', 'noisy').reason, /uid/);
  assert.equal(
    router.receiveXml('<x>' + 'a'.repeat(70 * 1024) + '</x>', 'noisy').reason,
    'oversized',
  );
  assert.equal(router.receiveXml(ATAK_SA, 'noisy').reason, 'rate-limited');
  now.advance(5000);
  assert.equal(router.receiveXml(ATAK_SA, 'noisy').ok, true);
  assert.equal(router.receiveXml(ATAK_SA, 'nobody').reason, 'unknown-link');
  const stats = router.stats();
  assert.equal(stats.invalid, 2);
  assert.equal(stats.limited, 1);
  assert.equal(stats.links[0].dropped, 1);
});

test('links must be unique and well-formed; removal stops delivery', () => {
  const router = createCotRouter({ now: clock() });
  const a = link('a', 'browser');
  const remove = router.addLink(a);
  assert.throws(() => router.addLink(link('a', 'browser')), /already/);
  assert.throws(() => router.addLink({ id: '', send() {} }), /id/);
  assert.throws(() => router.addLink({ id: 'x' }), /send/);
  remove();
  router.receiveXml(ATAK_SA, null);
  assert.equal(a.sent.length, 0);
});
