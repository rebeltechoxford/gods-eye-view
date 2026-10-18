// Page-level EMCON guard. Installed once, before any application module
// runs, it wraps every page API that can transmit: fetch, XMLHttpRequest,
// sendBeacon, WebSocket, EventSource, RTCPeerConnection, window.open,
// service-worker registration and the src/href of elements that load
// network resources. The wrappers consult a live flag, so modules that keep
// a reference to fetch from boot are covered after EMCON is switched on.
//
// Blocked requests fail at once like a network outage (a TypeError), so the
// app's existing offline fallbacks run instead of waiting for timeouts.
// Same-origin static files stay readable only where they cannot reach a
// radio: from the service worker's saved app (cache-only under EMCON) or
// from a loopback host.

export class EmconError extends TypeError {
  constructor(what = 'Network request') {
    super(`${what} blocked: EMCON is on`);
    this.name = 'EmconError';
    this.code = 'EMCON';
    // Callers that back off on unavailable capabilities stop retrying.
    this.unavailable = true;
    this.retryable = false;
  }
}

export const isEmconError = (error) => error?.code === 'EMCON';

const GUARD = Symbol.for('gev.emcon.guard');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const STATIC_PATH =
  /^\/(?:index\.html|manifest\.webmanifest|favicon\.svg|logo\.svg|(?:assets|cesium|events|fonts|models|pwa)\/[^?#]*)?$/;
const SERVER_PATH = /^\/(?:api|mcp)(?:\/|$)|^\/(?:login|logout)(?:\/|$)/;

/**
 * Decide whether a request may leave the page while EMCON is on.
 * @param {object} request
 * @param {string} request.url Absolute URL.
 * @param {string} [request.method]
 * @param {string} request.origin The page origin.
 * @param {boolean} request.workerControlled Page is served by the saved app.
 */
export function emconAllows({ url, method = 'GET', origin, workerControlled }) {
  let parsed;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
  if (parsed.origin !== origin) return false;
  if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) return false;
  if (SERVER_PATH.test(parsed.pathname)) return false;
  if (LOOPBACK.has(parsed.hostname)) return true;
  return Boolean(workerControlled) && STATIC_PATH.test(parsed.pathname);
}

function defineSetterGuard(proto, property, kind, check) {
  const descriptor = proto && Object.getOwnPropertyDescriptor(proto, property);
  if (!descriptor?.set) return;
  Object.defineProperty(proto, property, {
    ...descriptor,
    set(value) {
      if (check(String(value), this)) return descriptor.set.call(this, value);
      queueBlockedElementError(this, kind);
    },
  });
}

function queueBlockedElementError(element, kind) {
  queueMicrotask(() => {
    try {
      element.dispatchEvent(new Event('error'));
    } catch {
      /* Detached or exotic element: nothing to notify. */
    }
  });
  element.__gevEmconBlocked = kind;
}

/**
 * Install the guard on a window. Idempotent: a second call returns the
 * first installation, so the flag function cannot be replaced later.
 * @param {object} target The window (tests pass a stand-in).
 * @param {object} options
 * @param {() => boolean} options.isActive Live EMCON flag.
 * @param {(event:object) => void} [options.onBlocked] Observability hook.
 */
export function installEmconGuard(target, { isActive, onBlocked = () => {} }) {
  if (target[GUARD]) return target[GUARD];
  const origin = () => target.location?.origin ?? 'null';
  const workerControlled = () =>
    Boolean(target.navigator?.serviceWorker?.controller);
  const allows = (url, method) =>
    !isActive() ||
    emconAllows({
      url,
      method,
      origin: origin(),
      workerControlled: workerControlled(),
    });
  const blocked = [];
  const record = (kind, url) => {
    const event = Object.freeze({ kind, url: String(url).slice(0, 300) });
    blocked.push(event);
    if (blocked.length > 200) blocked.shift();
    try {
      onBlocked(event);
    } catch {
      /* Observability must never break the guard. */
    }
  };

  const nativeFetch = target.fetch;
  if (typeof nativeFetch === 'function') {
    target.fetch = function emconFetch(input, init) {
      const url =
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input?.url;
      const method = init?.method ?? input?.method ?? 'GET';
      if (!allows(url, method)) {
        record('fetch', url);
        return Promise.reject(new EmconError('fetch'));
      }
      return nativeFetch.call(target, input, init);
    };
  }

  const Xhr = target.XMLHttpRequest;
  if (Xhr?.prototype) {
    const { open, send } = Xhr.prototype;
    Xhr.prototype.open = function emconOpen(method, url, ...rest) {
      this.__gevEmconRequest = { method, url: String(url) };
      return open.call(this, method, url, ...rest);
    };
    Xhr.prototype.send = function emconSend(body) {
      const request = this.__gevEmconRequest;
      if (
        request &&
        !allows(new URL(request.url, origin()).href, request.method)
      ) {
        record('xhr', request.url);
        queueMicrotask(() => {
          for (const type of ['error', 'loadend'])
            this.dispatchEvent(new target.ProgressEvent(type));
        });
        return undefined;
      }
      return send.call(this, body);
    };
  }

  const nav = target.navigator;
  if (typeof nav?.sendBeacon === 'function') {
    const nativeBeacon = nav.sendBeacon.bind(nav);
    nav.sendBeacon = (url, data) => {
      if (!allows(url, 'POST')) {
        record('beacon', url);
        return false;
      }
      return nativeBeacon(url, data);
    };
  }

  // Streaming and peer connections always transmit; refuse them outright.
  for (const [name, kind] of [
    ['WebSocket', 'websocket'],
    ['EventSource', 'eventsource'],
    ['RTCPeerConnection', 'webrtc'],
  ]) {
    const Native = target[name];
    if (typeof Native !== 'function') continue;
    const Guarded = new Proxy(Native, {
      construct(Ctor, args, newTarget) {
        if (isActive()) {
          record(kind, args[0] ?? name);
          throw new EmconError(name);
        }
        return Reflect.construct(Ctor, args, newTarget);
      },
    });
    target[name] = Guarded;
  }

  if (typeof target.open === 'function') {
    const nativeOpen = target.open.bind(target);
    target.open = (url, ...rest) => {
      if (url && !allows(new URL(String(url), origin()).href, 'GET')) {
        record('window-open', url);
        return null;
      }
      return nativeOpen(url, ...rest);
    };
  }

  const container = nav?.serviceWorker;
  if (typeof container?.register === 'function') {
    const nativeRegister = container.register.bind(container);
    container.register = (...args) => {
      if (isActive()) {
        record('service-worker', args[0]);
        return Promise.reject(new EmconError('Service worker registration'));
      }
      return nativeRegister(...args);
    };
  }

  // Elements that load by URL: images, media, scripts, frames, links.
  const elementAllows = (url) => !url || allows(url, 'GET');
  for (const [ctor, property, kind] of [
    ['HTMLImageElement', 'src', 'image'],
    ['HTMLMediaElement', 'src', 'media'],
    ['HTMLSourceElement', 'src', 'media'],
    ['HTMLScriptElement', 'src', 'script'],
    ['HTMLIFrameElement', 'src', 'iframe'],
    ['HTMLLinkElement', 'href', 'link'],
  ]) {
    defineSetterGuard(
      target[ctor]?.prototype,
      property,
      kind,
      (url, element) => {
        const resolved = (() => {
          try {
            return new URL(url, origin()).href;
          } catch {
            return url;
          }
        })();
        if (elementAllows(resolved)) return true;
        record(kind, resolved);
        return false;
      },
    );
  }
  const Element = target.Element;
  if (Element?.prototype?.setAttribute) {
    const nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function emconSetAttribute(name, value) {
      const attribute = String(name).toLowerCase();
      if (
        (attribute === 'src' ||
          attribute === 'href' ||
          attribute === 'srcset') &&
        isActive() &&
        /^(?:img|video|audio|source|script|iframe|link|embed|object)$/i.test(
          this.localName ?? '',
        )
      ) {
        const first = String(value)
          .trim()
          .split(/[\s,]+/)[0];
        let resolved = first;
        try {
          resolved = new URL(first, origin()).href;
        } catch {
          /* keep the raw value */
        }
        if (!elementAllows(resolved)) {
          record(this.localName, resolved);
          queueBlockedElementError(this, this.localName);
          return undefined;
        }
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }

  const installation = Object.freeze({
    isActive,
    blocked: () => blocked.slice(),
  });
  Object.defineProperty(target, GUARD, { value: installation });
  return installation;
}
