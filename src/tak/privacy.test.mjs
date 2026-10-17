import test from 'node:test';
import assert from 'node:assert/strict';
import {
  markTakDataPrivate,
  authorizeTakDisclosure,
  isTakPrivacyBlocked,
  takDisclosureTicket,
  canDiscloseTakData,
  takDisclosurePermissions,
  takPrivacyState,
} from './privacy.js';
import {
  RealtimeViewport,
  captureViewportImage,
  capturePointerCrop,
} from '../voice/realtimeViewport.js';
import { ShareLinkManager } from '../sharelink.js';
import { RecordingControls } from '../ui/recordingControls.js';
import { RealtimeConnection } from '../voice/realtimeConnection.js';

test('permissions are independent, unknown uses fail closed, and revoke clears every scope', () => {
  const viewer = {};
  markTakDataPrivate(viewer);
  assert.equal(authorizeTakDisclosure(viewer, true, 'ai'), true);
  assert.equal(isTakPrivacyBlocked(viewer, 'ai'), false);
  assert.equal(isTakPrivacyBlocked(viewer, 'sharing'), true);
  assert.equal(isTakPrivacyBlocked(viewer, 'recording'), true);
  assert.equal(isTakPrivacyBlocked(viewer), true);
  assert.equal(isTakPrivacyBlocked(viewer, 'unknown'), true);
  assert.equal(authorizeTakDisclosure(viewer, true, 'unknown'), false);
  assert.deepEqual(takPrivacyState(viewer), {
    private: true,
    authorized: false,
  });
  const copy = takDisclosurePermissions(viewer);
  copy.sharing = true;
  assert.equal(isTakPrivacyBlocked(viewer, 'sharing'), true);
  const ticket = takDisclosureTicket(viewer, 'ai');
  assert.equal(canDiscloseTakData(ticket), true);
  authorizeTakDisclosure(viewer, false, 'ai');
  authorizeTakDisclosure(viewer, true, 'ai');
  assert.equal(canDiscloseTakData(ticket), false);
  authorizeTakDisclosure(viewer, true, 'sharing');
  authorizeTakDisclosure(viewer, true, 'recording');
  assert.equal(takPrivacyState(viewer).authorized, true);
  authorizeTakDisclosure(viewer, false);
  assert.deepEqual(takDisclosurePermissions(viewer), {
    ai: false,
    sharing: false,
    recording: false,
  });
});

test('allowing AI sends explicitly authorized images but leaves links and recording blocked', async () => {
  const prior = globalThis.window;
  const viewer = {};
  globalThis.window = { __godsEyeView: { viewer } };
  markTakDataPrivate(viewer);
  authorizeTakDisclosure(viewer, true, 'ai');
  const channel = { readyState: 'open' };
  const sent = [];
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    operations: {
      sendRealtimeEvent: (event) => {
        sent.push(event);
        return true;
      },
    },
  });
  try {
    assert.equal(
      await viewport.sendRetainedImage(
        async () => 'data:image/jpeg;base64,aGVsbG8=',
        '',
        'test',
      ),
      true,
    );
    assert.equal(sent.length, 1);
    assert.equal(
      ShareLinkManager.prototype._buildHashParams.call({ viewer }),
      null,
    );
    assert.equal(
      await ShareLinkManager.prototype.copyLink.call({ viewer }),
      false,
    );
    assert.equal(
      RecordingControls.prototype.setRecordingMode.call(
        { hud: { viewer } },
        true,
      ),
      false,
    );
    authorizeTakDisclosure(viewer, false, 'ai');
    authorizeTakDisclosure(viewer, true, 'sharing');
    assert.equal(
      await viewport.sendRetainedImage(
        async () => {
          throw new Error('must not capture');
        },
        '',
        'test',
      ),
      false,
    );
    let status;
    await RealtimeConnection.prototype.start.call({
      setStatus: (...args) => {
        status = args;
      },
    });
    assert.equal(status[0], 'error');
    assert.match(status[1], /TAK privacy/);
  } finally {
    globalThis.window = prior;
  }
});

test('TAK disclosure is per viewer, sticky and requires session authorization', () => {
  const a = {},
    b = {};
  assert.equal(isTakPrivacyBlocked(a), false);
  const before = takDisclosureTicket(a);
  markTakDataPrivate(a);
  assert.equal(isTakPrivacyBlocked(a), true);
  assert.equal(isTakPrivacyBlocked(b), false);
  assert.equal(canDiscloseTakData(before), false);
  authorizeTakDisclosure(a, true);
  const allowed = takDisclosureTicket(a);
  assert.equal(canDiscloseTakData(allowed), true);
  authorizeTakDisclosure(a, false);
  authorizeTakDisclosure(a, true);
  assert.equal(
    canDiscloseTakData(allowed),
    false,
    'revocation invalidates work already in flight',
  );
  assert.equal(
    isTakPrivacyBlocked({}),
    false,
    'authorization never persists into another page viewer',
  );
});

test('private TAK blocks capture, URL generation, recording and voice before work', async () => {
  const prior = globalThis.window;
  const viewer = {};
  globalThis.window = { __godsEyeView: { viewer } };
  markTakDataPrivate(viewer);
  try {
    assert.equal(await captureViewportImage(), null);
    assert.equal(await capturePointerCrop({ x: 2, y: 2 }), null);
    assert.equal(
      ShareLinkManager.prototype._buildHashParams.call({ viewer }),
      null,
    );
    assert.equal(
      await ShareLinkManager.prototype.copyLink.call({ viewer }),
      false,
    );
    assert.equal(
      RecordingControls.prototype.setRecordingMode.call(
        { hud: { viewer } },
        true,
      ),
      false,
    );
    let captureCalls = 0;
    const viewport = new RealtimeViewport({
      readChannel: () => ({ readyState: 'open' }),
      operations: {},
    });
    assert.equal(
      await viewport.sendRetainedImage(
        () => {
          captureCalls++;
        },
        '',
        '',
      ),
      false,
    );
    assert.equal(captureCalls, 0);
    let status;
    await RealtimeConnection.prototype.start.call({
      setStatus: (...args) => {
        status = args;
      },
    });
    assert.equal(status[0], 'error');
    assert.match(status[1], /TAK privacy/);
  } finally {
    globalThis.window = prior;
  }
});

test('TAK arrival and revocation during async capture prevent image delivery', async () => {
  const prior = globalThis.window;
  const viewer = {};
  globalThis.window = { __godsEyeView: { viewer } };
  const channel = { readyState: 'open' };
  const messages = [];
  const viewport = new RealtimeViewport({
    readChannel: () => channel,
    operations: {
      sendRealtimeEvent: (event) => {
        messages.push(event);
        return true;
      },
    },
  });
  try {
    let complete;
    const pending = viewport.sendRetainedImage(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      '',
      'test',
    );
    markTakDataPrivate(viewer);
    complete('data:image/jpeg;base64,aGVsbG8=');
    assert.equal(await pending, false);
    assert.deepEqual(messages, []);
    authorizeTakDisclosure(viewer, true);
    assert.equal(
      await viewport.sendRetainedImage(
        async () => 'data:image/jpeg;base64,aGVsbG8=',
        '',
        'test',
      ),
      true,
    );
    const revokeRace = viewport.sendRetainedImage(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
      '',
      'test',
    );
    authorizeTakDisclosure(viewer, false);
    authorizeTakDisclosure(viewer, true);
    complete('data:image/jpeg;base64,aGVsbG8=');
    assert.equal(await revokeRace, false);
    assert.equal(messages.length, 1);
  } finally {
    globalThis.window = prior;
  }
});
