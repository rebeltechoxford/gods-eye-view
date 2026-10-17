import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { interceptFixtures } from '../../scripts/qa-fixtureInterception.mjs';

const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(send = async () => ({})) {
  const client = new EventEmitter(),
    commands = [];
  client.send = async (command, args) => {
    commands.push({ command, args });
    return send(command, args, client);
  };
  client.detach = async () => {};
  return { client, commands, page: { createCDPSession: async () => client } };
}
const pause = (
  requestId = 'fetch-1',
  networkId = 'network-1',
  url = 'https://fixture.invalid/tile',
) => ({
  requestId,
  networkId,
  resourceType: 'Image',
  request: { url, method: 'GET', headers: {} },
});

test('fixtures leave actual app assets on the network but route exact login and every external request', async () => {
  const f = fixture(),
    seen = [];
  const hook = await interceptFixtures(f.page, {
    origin: 'https://127.0.0.1:4000',
    includePaths: ['/login'],
    handle: async (request) => {
      seen.push(request.url());
      await request.respond({ contentType: 'text/plain', body: 'synthetic' });
    },
  });
  f.client.emit(
    'Fetch.requestPaused',
    pause('static', 'a', 'https://127.0.0.1:4000/cesium/Workers/chunk.js'),
  );
  f.client.emit(
    'Fetch.requestPaused',
    pause('login', 'b', 'https://127.0.0.1:4000/login'),
  );
  f.client.emit('Fetch.requestPaused', pause());
  await turn();
  assert.deepEqual(seen, [
    'https://127.0.0.1:4000/login',
    'https://fixture.invalid/tile',
  ]);
  assert.equal(
    f.commands.filter(({ command }) => command === 'Fetch.continueRequest')
      .length,
    1,
  );
  assert.equal(
    f.commands.filter(({ command }) => command === 'Fetch.fulfillRequest')
      .length,
    2,
  );
  assert.deepEqual(hook.errors, []);
  await hook.dispose();
});
test('unresolved fixtures fail closed and unknown fulfillment failures remain errors even if caller catches', async () => {
  const empty = fixture(),
    unresolved = await interceptFixtures(empty.page, {
      origin: 'https://127.0.0.1',
      handle: () => {},
    });
  empty.client.emit('Fetch.requestPaused', pause());
  await turn();
  assert.match(unresolved.errors[0], /Unresolved/);
  assert(empty.commands.some(({ command }) => command === 'Fetch.failRequest'));
  await unresolved.dispose();
  const broken = fixture(async (command) => {
    if (command === 'Fetch.fulfillRequest')
      throw new Error('Synthetic unexpected protocol failure');
    return {};
  });
  const hook = await interceptFixtures(broken.page, {
    origin: 'https://127.0.0.1',
    handle: (request) => request.respond({ body: 'x' }).catch(() => {}),
  });
  broken.client.emit('Fetch.requestPaused', pause());
  await turn();
  assert.equal(hook.errors.length, 1);
  assert.match(hook.errors[0], /unexpected protocol failure/);
  await hook.dispose();
});
test('invalid interception IDs are ignored only with matching Chrome cancellation evidence, including reordered events', async () => {
  const f = fixture(async (command, args, client) => {
    if (command === 'Fetch.fulfillRequest') {
      setImmediate(() =>
        client.emit('Network.loadingFailed', {
          requestId: 'network-1',
          errorText: 'net::ERR_INTERNET_DISCONNECTED',
          canceled: false,
        }),
      );
      throw new Error(
        'Protocol error (Fetch.fulfillRequest): Invalid InterceptionId.',
      );
    }
    return {};
  });
  const hook = await interceptFixtures(f.page, {
    origin: 'https://127.0.0.1',
    handle: (request) => request.respond({ body: 'x' }),
  });
  f.client.emit('Fetch.requestPaused', pause());
  await turn();
  await turn();
  await turn();
  assert.deepEqual(hook.errors, []);
  assert.deepEqual(hook.cancellations, [
    { networkId: 'network-1', error: 'net::ERR_INTERNET_DISCONNECTED' },
  ]);
  await hook.dispose();
});
test('unmatched IDs and unrelated network failures do not excuse an invalid interception ID', async () => {
  const f = fixture(async (command) => {
    if (command === 'Fetch.fulfillRequest')
      throw new Error(
        'Protocol error (Fetch.fulfillRequest): Invalid InterceptionId.',
      );
    return {};
  });
  const hook = await interceptFixtures(f.page, {
    origin: 'https://127.0.0.1',
    handle: (request) => request.respond({ body: 'x' }),
  });
  f.client.emit('Network.loadingFailed', {
    requestId: 'different-request',
    canceled: true,
    errorText: 'net::ERR_ABORTED',
  });
  f.client.emit('Network.loadingFailed', {
    requestId: 'network-1',
    canceled: false,
    errorText: 'net::ERR_BLOCKED_BY_CLIENT',
  });
  f.client.emit('Fetch.requestPaused', pause());
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(hook.errors.length, 1);
  assert.deepEqual(hook.cancellations, []);
  await hook.dispose();
});

test('an explicitly disposed fixture owner tolerates pending target closure; live owners retain that failure', async () => {
  let rejectPending, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = fixture(async (command) => {
    if (command === 'Fetch.fulfillRequest') {
      entered();
      return new Promise((resolve, reject) => {
        rejectPending = reject;
      });
    }
    return {};
  });
  const released = await interceptFixtures(pending.page, {
    origin: 'https://127.0.0.1',
    handle: (request) => request.respond({ body: 'x' }),
  });
  pending.client.emit('Fetch.requestPaused', pause());
  await started;
  await released.dispose();
  rejectPending(
    new Error('Protocol error (Fetch.fulfillRequest): Target closed'),
  );
  await turn();
  assert.deepEqual(released.errors, []);
  const live = fixture(async (command) => {
    if (command === 'Fetch.fulfillRequest')
      throw new Error('Protocol error (Fetch.fulfillRequest): Target closed');
    return {};
  });
  const active = await interceptFixtures(live.page, {
    origin: 'https://127.0.0.1',
    handle: (request) => request.respond({ body: 'x' }),
  });
  live.client.emit('Fetch.requestPaused', pause());
  await turn();
  assert.equal(active.errors.length, 1);
  assert.match(active.errors[0], /Target closed/);
  await active.dispose();
});

test('an old subresource invalid ID requires the exact owning document to be replaced after its pause', async () => {
  for (const mode of [
    'matching',
    'different-frame',
    'missing-loader',
    'document',
  ]) {
    const f = fixture(async (command, _args, client) => {
      if (command === 'Fetch.fulfillRequest') {
        client.emit('Page.frameNavigated', {
          frame: {
            id: mode === 'different-frame' ? 'other-frame' : 'frame-1',
            loaderId: 'new-loader',
          },
        });
        throw new Error(
          'Protocol error (Fetch.fulfillRequest): Invalid InterceptionId.',
        );
      }
      return {};
    });
    const hook = await interceptFixtures(f.page, {
      origin: 'https://127.0.0.1',
      handle: (request) => request.respond({ body: 'x' }),
    });
    f.client.emit('Network.requestWillBeSent', {
      requestId: 'network-1',
      frameId: 'frame-1',
      loaderId: mode === 'missing-loader' ? '' : 'old-loader',
    });
    f.client.emit('Fetch.requestPaused', {
      ...pause(),
      frameId: 'frame-1',
      resourceType: mode === 'document' ? 'Document' : 'Other',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (mode === 'matching') {
      assert.deepEqual(hook.errors, []);
      assert.deepEqual(hook.cancellations, [
        {
          networkId: 'network-1',
          error: 'document-replaced',
          loaderId: 'old-loader',
          replacementLoaderId: 'new-loader',
        },
      ]);
    } else {
      assert.equal(hook.errors.length, 1, mode);
      assert.deepEqual(hook.cancellations, [], mode);
    }
    await hook.dispose();
    assert.equal(f.client.listenerCount('Network.requestWillBeSent'), 0);
    assert.equal(f.client.listenerCount('Page.frameNavigated'), 0);
  }
});

test('optional renderer abort proof excuses only the exact invalid ID, never other protocol failures', async () => {
  for (const mode of ['matching', 'other-protocol', 'no-abort', 'disabled']) {
    let bindingName;
    const at = Date.now();
    const f = fixture(async (command, args, client) => {
      if (command === 'Runtime.addBinding') bindingName = args.name;
      if (command === 'Fetch.fulfillRequest') {
        if (mode !== 'no-abort')
          client.emit('Runtime.bindingCalled', {
            name: bindingName,
            executionContextId: 1,
            payload: JSON.stringify({
              kind: 'abort',
              id: 1,
              readyState: 2,
              at: at + 1,
            }),
          });
        throw new Error(
          mode === 'other-protocol'
            ? 'Protocol error: disconnected'
            : 'Protocol error (Fetch.fulfillRequest): Invalid InterceptionId.',
        );
      }
      return { identifier: 'fixture-script' };
    });
    const hook = await interceptFixtures(f.page, {
      origin: 'https://127.0.0.1',
      observeXhrAborts: mode !== 'disabled',
      handle: (request) => request.respond({ body: 'x' }),
    });
    f.client.emit('Page.frameNavigated', {
      frame: { id: 'frame-1', loaderId: 'loader-1' },
    });
    f.client.emit('Runtime.executionContextCreated', {
      context: { id: 1, auxData: { isDefault: true, frameId: 'frame-1' } },
    });
    f.client.emit('Runtime.bindingCalled', {
      name: bindingName,
      executionContextId: 1,
      payload: JSON.stringify({
        kind: 'send',
        id: 1,
        method: 'GET',
        url: 'https://fixture.invalid/tile',
        at,
      }),
    });
    f.client.emit('Network.requestWillBeSent', {
      requestId: 'network-1',
      frameId: 'frame-1',
      loaderId: 'loader-1',
      wallTime: at / 1000,
    });
    f.client.emit('Fetch.requestPaused', {
      ...pause(),
      frameId: 'frame-1',
      resourceType: 'XHR',
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (mode === 'matching') {
      assert.deepEqual(hook.errors, []);
      assert.equal(hook.cancellations[0].error, 'explicit-xhr-abort');
    } else {
      assert.equal(hook.errors.length, 1, mode);
      assert.deepEqual(hook.cancellations, []);
    }
    await hook.dispose();
  }
});
