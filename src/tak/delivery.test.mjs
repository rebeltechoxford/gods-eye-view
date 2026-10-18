import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSubmissionStore,
  SUBMISSION_LIMIT,
  SUBMISSION_WINDOW_MS,
} from './delivery.js';

test('submission history is metadata-only, bounded, immutable, and rejects unknown or malformed acknowledgements', () => {
  let time = 1000;
  const history = createSubmissionStore({ now: () => time });
  for (let i = 0; i < SUBMISSION_LIMIT + 2; i++)
    history.add({
      id: `r${i}`,
      uid: `uid${i}`,
      kind: 'marker',
      staleMs: 999999,
      sent: true,
    });
  assert.equal(history.list().length, SUBMISSION_LIMIT);
  assert.equal(history.list()[0].id, 'r2');
  assert.equal(
    history.update({ id: 'r0', state: 'submitted', routes: [] }),
    false,
  );
  assert.equal(
    history.update({ id: 'r2', state: 'delivered', routes: [] }),
    false,
  );
  assert.equal(
    history.update({
      id: 'r2',
      state: 'submitted',
      routes: [{ id: 'evil', state: 'submitted' }],
    }),
    false,
  );
  assert.equal(
    history.update({
      id: 'r2',
      state: 'submitted',
      reason: 'x'.repeat(241),
      routes: [],
    }),
    false,
  );
  assert.equal(
    history.update({
      id: 'r2',
      state: 'queued',
      routes: [{ id: 'server', state: 'queued' }],
    }),
    true,
  );
  const item = history.list()[0];
  assert.throws(() => {
    item.routes[0].state = 'delivered';
  }, TypeError);
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'id',
      'uid',
      'kind',
      'state',
      'reason',
      'routes',
      'createdAtMs',
      'updatedAtMs',
      'expiresAtMs',
    ].sort(),
  );
  time++;
  assert.equal(
    history.update({
      id: 'r2',
      state: 'submitted',
      routes: [{ id: 'server', state: 'submitted' }],
    }),
    true,
  );
  assert.equal(
    history.update({
      id: 'r2',
      state: 'queued',
      routes: [{ id: 'server', state: 'queued' }],
    }),
    false,
    'terminal outcome cannot regress',
  );
  history.clear();
  assert.equal(history.list().length, 0);
});

test('submission freshness and interrupted connections never turn into peer-delivery claims or browser retries', () => {
  let time = 1000;
  const history = createSubmissionStore({ now: () => time });
  history.add({
    id: 'short',
    uid: 'x',
    kind: 'sa',
    staleMs: time + 100,
    sent: true,
  });
  history.add({
    id: 'normal',
    uid: 'x',
    kind: 'chat',
    staleMs: 999999,
    sent: true,
  });
  time += 101;
  assert.equal(history.sweep(), true);
  assert.equal(history.list()[0].state, 'expired');
  time += SUBMISSION_WINDOW_MS;
  history.sweep();
  assert.equal(history.list()[1].state, 'expired');
  history.add({
    id: 'down',
    uid: 'x',
    kind: 'marker',
    staleMs: 999999,
    sent: true,
  });
  history.interrupt();
  assert.equal(history.list().at(-1).state, 'rejected');
  assert.match(history.list().at(-1).reason, /unconfirmed.*not be retried/);
});
