import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import {
  createXhrAbortProof,
  installXhrAbortObserver,
} from '../../scripts/qa-xhrAbortProof.mjs';

async function fixture() {
  const client = new EventEmitter(),
    commands = [],
    frames = new Map([['frame-1', { loaderId: 'loader-1' }]]),
    requests = new Map();
  client.send = async (command, args) => {
    commands.push({ command, args });
    return { identifier: 'script-1' };
  };
  const proof = await createXhrAbortProof(client, {
    origin: 'https://app.invalid',
    frames,
    requests,
  });
  const name = commands.find((c) => c.command === 'Runtime.addBinding').args
    .name;
  const at = Date.now();
  const context = (id = 1, frameId = 'frame-1', isDefault = true) =>
    client.emit('Runtime.executionContextCreated', {
      context: { id, auxData: { frameId, isDefault } },
    });
  context();
  const emit = (value, executionContextId = 1) =>
    client.emit('Runtime.bindingCalled', {
      name,
      executionContextId,
      payload: JSON.stringify(value),
    });
  const send = (id = 1, extra = {}, executionContextId = 1) =>
    emit(
      {
        kind: 'send',
        id,
        method: 'GET',
        url: 'https://tiles.invalid/1.png',
        at,
        ...extra,
      },
      executionContextId,
    );
  const abort = (id = 1, extra = {}, executionContextId = 1) =>
    emit(
      { kind: 'abort', id, readyState: 2, at: at + 1, ...extra },
      executionContextId,
    );
  const pause = {
    frameId: 'frame-1',
    resourceType: 'XHR',
    request: { method: 'GET', url: 'https://tiles.invalid/1.png' },
  };
  requests.set('network-1', {
    frameId: 'frame-1',
    loaderId: 'loader-1',
    startedAt: at,
  });
  return {
    client,
    commands,
    frames,
    requests,
    proof,
    context,
    emit,
    send,
    abort,
    pause,
    at,
  };
}

test('explicit native XHR cancellation proof binds only one exact frame, loader, context and request', async () => {
  const f = await fixture();
  f.send();
  f.emit({ kind: 'finish', id: 1, at: f.at + 1 });
  f.abort(); // native abort can synchronously emit loadend before its wrapper returns
  assert.deepEqual(f.proof.evidence('network-1', f.pause), {
    networkId: 'network-1',
    error: 'explicit-xhr-abort',
    executionContextId: 1,
    rendererRequestId: 1,
    frameId: 'frame-1',
    loaderId: 'loader-1',
    sentAt: f.at,
    abortedAt: f.at + 1,
  });
  f.requests.set('network-2', f.requests.get('network-1'));
  assert.equal(
    f.proof.evidence('network-2', f.pause),
    null,
    'one renderer abort cannot excuse two network requests',
  );
  await f.proof.dispose();
  assert.equal(f.client.listenerCount('Runtime.bindingCalled'), 0);
  assert.equal(f.client.listenerCount('Runtime.executionContextCreated'), 0);
  assert(
    f.commands.some(
      (c) => c.command === 'Page.removeScriptToEvaluateOnNewDocument',
    ),
  );
  assert(f.commands.some((c) => c.command === 'Runtime.removeBinding'));
  assert.equal(f.proof.evidence('network-1', f.pause), null);
});

test('unknown, ambiguous, stale, other-frame and completed XHR never constitute abort proof', async (t) => {
  for (const mode of [
    'no-abort',
    'duplicate',
    'other-frame',
    'other-loader',
    'isolated-context',
    'missing-clock',
    'stale-send',
    'done',
    'unsent',
    'other-url',
    'other-method',
    'non-xhr',
    'same-origin',
  ]) {
    await t.test(mode, async () => {
      const f = await fixture();
      if (mode === 'other-frame') {
        f.frames.set('other-frame', { loaderId: 'loader-1' });
        f.context(1, 'other-frame');
      }
      if (mode === 'other-loader') {
        f.frames.set('frame-1', { loaderId: 'other-loader' });
        f.context();
      }
      if (mode === 'isolated-context') f.context(2, 'frame-1', false);
      if (mode === 'missing-clock')
        f.requests.get('network-1').startedAt = null;
      const extra =
        mode === 'stale-send'
          ? { at: f.at - 2000 }
          : mode === 'same-origin'
            ? { url: 'https://app.invalid/api/private' }
            : {};
      const contextId = mode === 'isolated-context' ? 2 : 1;
      if (mode !== 'unsent') f.send(1, extra, contextId);
      if (mode === 'duplicate') f.send(2);
      if (mode !== 'no-abort')
        f.abort(1, mode === 'done' ? { readyState: 4 } : {}, contextId);
      const pause = structuredClone(f.pause);
      if (mode === 'other-url')
        pause.request.url = 'https://tiles.invalid/2.png';
      if (mode === 'other-method') pause.request.method = 'POST';
      if (mode === 'non-xhr') pause.resourceType = 'Document';
      assert.equal(f.proof.evidence('network-1', pause), null);
      await f.proof.dispose();
    });
  }
});

test('the renderer observer preserves native calls and reports only successful aborts of sent in-flight XHR', () => {
  class NativeXHR extends EventTarget {
    readyState = 0;
    open(...args) {
      this.openArgs = args;
      this.readyState = 1;
    }
    send(...args) {
      this.sendArgs = args;
    }
    abort(...args) {
      this.abortArgs = args;
      if (this.abortThrows) throw new Error('native abort failed');
      this.readyState = 0;
      this.dispatchEvent(new Event('loadend'));
      return 'native-result';
    }
  }
  const originals = {
    open: NativeXHR.prototype.open,
    send: NativeXHR.prototype.send,
    abort: NativeXHR.prototype.abort,
  };
  const events = [];
  const sandbox = vm.createContext({
    XMLHttpRequest: NativeXHR,
    URL,
    Date,
    performance,
    document: { baseURI: 'https://app.invalid/' },
    report: (value) => events.push(JSON.parse(value)),
  });
  vm.runInContext('globalThis.top = globalThis', sandbox);
  vm.runInContext(
    `(${installXhrAbortObserver.toString()})('report','https://app.invalid')`,
    sandbox,
  );
  const xhr = new NativeXHR();
  xhr.open('GET', 'https://tiles.invalid/1.png', true);
  xhr.send(null);
  assert.equal(xhr.abort('argument'), 'native-result');
  assert.deepEqual(xhr.openArgs, ['GET', 'https://tiles.invalid/1.png', true]);
  assert.deepEqual(xhr.sendArgs, [null]);
  assert.deepEqual(xhr.abortArgs, ['argument']);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['send', 'finish', 'abort'],
  );
  assert.equal(events.at(-1).readyState, 1);
  const baseline = events.filter((e) => e.kind === 'abort').length;
  for (const mode of ['unsent', 'done', 'throws', 'same-origin']) {
    const next = new NativeXHR();
    next.open(
      'GET',
      mode === 'same-origin' ? '/api/private' : 'https://tiles.invalid/2.png',
    );
    if (mode !== 'unsent') next.send();
    if (mode === 'done') {
      next.readyState = 4;
      next.dispatchEvent(new Event('loadend'));
    }
    if (mode === 'throws') {
      next.abortThrows = true;
      assert.throws(() => next.abort(), /native abort failed/);
    } else next.abort();
  }
  assert.equal(events.filter((e) => e.kind === 'abort').length, baseline);
  vm.runInContext('globalThis.report_restore()', sandbox);
  for (const key of ['open', 'send', 'abort'])
    assert.equal(NativeXHR.prototype[key], originals[key]);
});

test('an old completed abort cannot authorize a later same-URL network request with no renderer send', async () => {
  for (const delay of [10, 40]) {
    const f = await fixture();
    f.send();
    f.abort();
    f.emit({ kind: 'finish', id: 1, at: f.at + 2 });
    f.requests.set('later-network', {
      frameId: 'frame-1',
      loaderId: 'loader-1',
      startedAt: f.at + delay,
    });
    assert.equal(f.proof.evidence('later-network', f.pause), null);
    await f.proof.dispose();
  }
});

test('proof buffers are bounded; an evicted old send cannot qualify', async () => {
  const f = await fixture();
  for (let id = 1; id <= 513; id++)
    f.send(id, { url: `https://tiles.invalid/${id}.png` });
  f.abort(1);
  assert.equal(f.proof.evidence('network-1', f.pause), null);
  f.abort(513);
  assert(
    f.proof.evidence('network-1', {
      ...f.pause,
      request: { method: 'GET', url: 'https://tiles.invalid/513.png' },
    }),
  );
  await f.proof.dispose();
});
