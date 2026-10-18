import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmconError,
  emconAllows,
  installEmconGuard,
  isEmconError,
} from './guard.js';
import {
  EMCON_STORAGE_KEY,
  createEmconState,
  parseEmconRecord,
} from './state.js';

const ORIGIN = 'https://tak.internal:8443';

// A stand-in window with just the transmit APIs the guard wraps.
function fakeWindow({ origin = ORIGIN, controlled = true } = {}) {
  const calls = [];
  const store = new Map();
  const events = new EventTarget();
  class FakeXhr extends EventTarget {
    open(method, url) {
      calls.push(['xhr-open', method, url]);
    }
    send() {
      calls.push(['xhr-send']);
    }
    abort() {
      calls.push(['xhr-abort']);
      this.dispatchEvent(new Event('loadend'));
    }
  }
  class FakeSocket extends EventTarget {
    constructor(url) {
      super();
      calls.push(['websocket', url]);
    }
    close() {
      calls.push(['stream-close']);
      this.dispatchEvent(new Event('close'));
    }
  }
  class FakeElement extends EventTarget {
    constructor(localName) {
      super();
      this.localName = localName;
    }
    setAttribute(name, value) {
      calls.push(['setAttribute', this.localName, name, value]);
    }
  }
  class FakeImage extends FakeElement {
    constructor() {
      super('img');
    }
  }
  Object.defineProperty(FakeImage.prototype, 'src', {
    configurable: true,
    get() {
      return this._src ?? '';
    },
    set(value) {
      calls.push(['img-src', value]);
      this._src = value;
    },
  });
  const target = {
    location: { origin },
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchStorage: (detail) =>
      events.dispatchEvent(Object.assign(new Event('storage'), detail)),
    fetch: async (input, init) => {
      calls.push(['fetch', String(input?.url ?? input), init?.method ?? 'GET']);
      return { ok: true };
    },
    XMLHttpRequest: FakeXhr,
    ProgressEvent: Event,
    WebSocket: FakeSocket,
    EventSource: FakeSocket,
    RTCPeerConnection: FakeSocket,
    open: (url) => {
      calls.push(['open', url]);
      return {};
    },
    navigator: {
      sendBeacon: (url) => {
        calls.push(['beacon', url]);
        return true;
      },
      serviceWorker: {
        controller: controlled ? {} : null,
        register: async (url) => calls.push(['register', url]),
      },
    },
    Element: FakeElement,
    HTMLImageElement: FakeImage,
  };
  return { target, calls, store, FakeImage, FakeElement };
}

test('the policy keeps only saved-app files and local resources', () => {
  const allows = (url, extra = {}) =>
    emconAllows({ url, origin: ORIGIN, workerControlled: true, ...extra });
  assert.equal(allows(`${ORIGIN}/assets/index-abc.js`), true);
  assert.equal(allows(`${ORIGIN}/cesium/Workers/x.js`), true);
  assert.equal(allows(`${ORIGIN}/`), true);
  for (const icon of ['mic', 'pin', 'location', 'visual-presets'])
    assert.equal(allows(`${ORIGIN}/${icon}.svg`), true);
  assert.equal(allows('data:image/png;base64,AAAA'), true);
  assert.equal(allows('blob:https://tak.internal:8443/1234'), true);
  // Server APIs, other hosts, writes and unknown paths transmit.
  assert.equal(allows(`${ORIGIN}/api/tak/status`), false);
  assert.equal(allows(`${ORIGIN}/login`), false);
  assert.equal(allows('https://tile.openstreetmap.org/1/1/1.png'), false);
  assert.equal(allows(`${ORIGIN}/assets/x.js`, { method: 'POST' }), false);
  assert.equal(allows(`${ORIGIN}/scene-assets/a.json`), false);
  // Without the saved app, static files would come from the server.
  assert.equal(
    allows(`${ORIGIN}/assets/index-abc.js`, { workerControlled: false }),
    false,
  );
  // A loopback host never reaches a radio, but its API still means a server.
  assert.equal(
    allows('http://127.0.0.1:4174/src/main.js', {
      origin: 'http://127.0.0.1:4174',
      workerControlled: false,
    }),
    true,
  );
  assert.equal(
    allows('http://127.0.0.1:4174/api/route', {
      origin: 'http://127.0.0.1:4174',
    }),
    false,
  );
  assert.equal(allows('not a url at all', { origin: 'null' }), false);
});

test('with EMCON on, every transmit API is refused like a network outage', async () => {
  const { target, calls, FakeImage, FakeElement } = fakeWindow();
  let active = false;
  const guard = installEmconGuard(target, {
    isActive: () => active,
    isWorkerReady: () => true,
  });
  // Off: everything passes through untouched.
  await target.fetch('https://example.org/x');
  assert.deepEqual(calls.at(-1), ['fetch', 'https://example.org/x', 'GET']);
  new target.WebSocket('wss://tak.internal:8443/ws');
  assert.equal(calls.at(-1)[0], 'websocket');

  active = true;
  calls.length = 0;
  await assert.rejects(target.fetch('https://example.org/x'), (error) => {
    assert.ok(error instanceof TypeError, 'offline fallbacks expect TypeError');
    assert.ok(error instanceof EmconError);
    assert.equal(isEmconError(error), true);
    assert.equal(error.retryable, false);
    return true;
  });
  await assert.rejects(
    target.fetch(new Request(`${ORIGIN}/api/tak/status`)),
    EmconError,
  );
  await assert.rejects(
    target.fetch(`${ORIGIN}/assets/a.js`, { method: 'POST' }),
    EmconError,
  );
  // Saved-app files are still readable.
  await target.fetch(`${ORIGIN}/assets/a.js`);
  assert.deepEqual(calls, [['fetch', `${ORIGIN}/assets/a.js`, 'GET']]);
  calls.length = 0;

  const xhr = new target.XMLHttpRequest();
  const failed = new Promise((resolve) =>
    xhr.addEventListener('error', resolve, { once: true }),
  );
  xhr.open('GET', 'https://tile.example.org/1/2/3.png');
  xhr.send();
  await failed;
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ['xhr-open'],
    'the request was opened locally but never sent',
  );

  assert.equal(
    target.navigator.sendBeacon(`${ORIGIN}/api/realtime/debug-log`),
    false,
  );
  assert.throws(() => new target.WebSocket('wss://x/ws'), EmconError);
  assert.throws(() => new target.EventSource('/api/stream'), EmconError);
  assert.throws(() => new target.RTCPeerConnection({}), EmconError);
  assert.equal(target.open('https://www.liveatc.net/'), null);
  await assert.rejects(
    target.navigator.serviceWorker.register('/gev-sw.js'),
    EmconError,
  );

  const image = new FakeImage();
  const imageFailed = new Promise((resolve) =>
    image.addEventListener('error', resolve, { once: true }),
  );
  image.src = 'https://tile.example.org/a.png';
  await imageFailed;
  image.src = 'data:image/png;base64,AAAA';
  const script = new FakeElement('script');
  script.setAttribute('src', 'https://platform.twitter.com/widgets.js');
  script.setAttribute('type', 'module');
  assert.deepEqual(calls.slice(1), [
    ['img-src', 'data:image/png;base64,AAAA'],
    ['setAttribute', 'script', 'type', 'module'],
  ]);
  assert.ok(guard.blocked().length >= 10);
  assert.ok(guard.blocked().every((event) => event.url.length <= 300));
});

test('the guard installs once and keeps its first flag', () => {
  const { target } = fakeWindow();
  const first = installEmconGuard(target, { isActive: () => true });
  const second = installEmconGuard(target, { isActive: () => false });
  assert.equal(second, first);
  assert.throws(() => new target.WebSocket('wss://x'), EmconError);
});

test('entry closes existing streams, stops RTC capture and aborts only active XHR', () => {
  const { target, calls } = fakeWindow();
  let active = false;
  const guard = installEmconGuard(target, { isActive: () => active });
  new target.WebSocket('wss://example.org/live');
  new target.EventSource('https://example.org/events');
  const rtc = new target.RTCPeerConnection({});
  let stoppedTracks = 0;
  rtc.getSenders = () => [{ track: { stop: () => stoppedTracks++ } }];
  const finishedSocket = new target.WebSocket('wss://example.org/finished');
  finishedSocket.close();
  const finishedXhr = new target.XMLHttpRequest();
  finishedXhr.open('GET', 'https://example.org/finished');
  finishedXhr.send();
  finishedXhr.dispatchEvent(new Event('loadend'));
  const pendingXhr = new target.XMLHttpRequest();
  pendingXhr.open('GET', 'https://example.org/stream');
  pendingXhr.send();
  calls.length = 0;

  active = true;
  guard.stopActive();
  assert.equal(calls.filter(([kind]) => kind === 'stream-close').length, 3);
  assert.equal(calls.filter(([kind]) => kind === 'xhr-abort').length, 1);
  assert.equal(stoppedTracks, 1);
  const after = calls.length;
  guard.stopActive();
  assert.equal(calls.length, after, 'retired resources are no longer retained');
  assert.throws(
    () => new target.WebSocket('wss://example.org/new'),
    EmconError,
  );
});

test('a worker controller alone does not authorize static fetches before its acknowledgement', async () => {
  const { target, calls } = fakeWindow();
  let confirmed = false;
  installEmconGuard(target, {
    isActive: () => true,
    isWorkerReady: () => confirmed,
  });
  await assert.rejects(target.fetch(`${ORIGIN}/assets/app.js`), EmconError);
  assert.equal(calls.length, 0);
  confirmed = true;
  await target.fetch(`${ORIGIN}/assets/app.js`);
  assert.equal(calls.length, 1);
  target.navigator.serviceWorker.controller = null;
  await assert.rejects(target.fetch(`${ORIGIN}/assets/app.js`), EmconError);
});

test('entry stops detached remote media and frames while keeping local blob media', () => {
  const { target } = fakeWindow();
  let active = false;
  class Media extends EventTarget {
    get src() {
      return this.source || '';
    }
    set src(value) {
      this.source = value;
    }
    pause() {
      this.paused = true;
    }
    removeAttribute() {
      this.source = '';
    }
    load() {
      this.dispatchEvent(new Event('emptied'));
    }
  }
  target.HTMLMediaElement = Media;
  const frame = {
    src: 'https://example.org/video',
    remove() {
      this.removed = true;
    },
  };
  target.document = {
    querySelectorAll: (selector) => (selector === 'iframe[src]' ? [frame] : []),
  };
  const guard = installEmconGuard(target, { isActive: () => active });
  const remote = new target.HTMLMediaElement();
  remote.src = 'https://example.org/live.mp3';
  const local = new target.HTMLMediaElement();
  local.src = 'blob:https://tak.internal/recording';
  active = true;
  guard.stopActive();
  assert.equal(remote.paused, true);
  assert.equal(remote.src, '');
  assert.equal(frame.removed, true);
  assert.equal(local.paused, undefined);
  assert.equal(local.src, 'blob:https://tak.internal/recording');
});

test('EMCON persists, survives reload and follows other tabs', () => {
  const { target, store } = fakeWindow();
  const tab = createEmconState({ target, now: () => Date.UTC(2026, 9, 18) });
  const seen = [];
  tab.subscribe((record) => seen.push(Boolean(record)));
  assert.equal(tab.isActive(), false);
  assert.deepEqual(tab.set(true), { active: true, persisted: true });
  assert.equal(tab.current().since, '2026-10-18T00:00:00.000Z');
  // A reload reads the stored flag synchronously.
  const reloaded = createEmconState({ target });
  assert.equal(reloaded.isActive(), true);
  // Another tab turning it off reaches this one.
  const newValue = null;
  store.delete(EMCON_STORAGE_KEY);
  target.dispatchStorage({ key: EMCON_STORAGE_KEY, newValue });
  assert.equal(reloaded.isActive(), false);
  target.dispatchStorage({
    key: EMCON_STORAGE_KEY,
    newValue: JSON.stringify({ version: 1, active: true, since: 'x' }),
  });
  assert.equal(reloaded.isActive(), true);
  assert.equal(reloaded.current().since, null);
  assert.deepEqual(seen, [true, false, true]);
  assert.deepEqual(tab.set(false), { active: false, persisted: true });
  assert.equal(createEmconState({ target }).isActive(), false);
});

test('unreadable or blocked storage never silently turns EMCON off in a tab', () => {
  for (const bad of ['', '{', '{"version":2,"active":true}', 'x'.repeat(600)])
    assert.equal(parseEmconRecord(bad), null);
  const target = {
    get localStorage() {
      throw new Error('SecurityError');
    },
  };
  const state = createEmconState({ target });
  assert.equal(state.isActive(), false);
  // Turning it on still silences this tab; the caller is told it will not
  // survive a reload.
  assert.deepEqual(state.set(true), { active: true, persisted: false });
  assert.equal(state.isActive(), true);
});

test('with EMCON on, following an external link or submitting a form is refused', () => {
  const document = new EventTarget();
  const target = {
    location: { origin: ORIGIN, href: `${ORIGIN}/?welcome=0#lat=1` },
    navigator: { serviceWorker: { controller: {} } },
    document,
  };
  let active = false;
  const guard = installEmconGuard(target, {
    isActive: () => active,
    isWorkerReady: () => true,
  });
  const click = (href, type = 'click') => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperty(event, 'target', {
      value: {
        closest: (selector) =>
          selector === 'a[href]' ? { href: new URL(href, ORIGIN).href } : null,
      },
    });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const submit = (action, method = 'post') => {
    const event = new Event('submit', { cancelable: true });
    Object.defineProperty(event, 'target', { value: { action, method } });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  };
  // Off: links and forms behave normally.
  assert.equal(click('https://www.liveatc.net/'), false);
  assert.equal(submit(`${ORIGIN}/logout`), false);

  active = true;
  assert.equal(click('https://www.liveatc.net/'), true);
  assert.equal(click('https://www.liveatc.net/', 'auxclick'), true);
  assert.equal(submit(`${ORIGIN}/logout`), true, 'sign-out contacts the host');
  // In-page anchors and the saved app shell stay usable.
  assert.equal(click('#section'), false);
  assert.equal(click('/?welcome=0#other'), false);
  assert.equal(click('/'), false);
  assert.deepEqual(
    guard.blocked().map((event) => event.kind),
    ['navigation', 'navigation', 'form'],
  );
});
