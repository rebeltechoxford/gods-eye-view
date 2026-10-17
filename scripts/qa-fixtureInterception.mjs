import { createXhrAbortProof } from './qa-xhrAbortProof.mjs';

/**
 * Route hermetic browser fixtures without Puppeteer's cross-target request-ID
 * correlation. Puppeteer 25 + Chromium 152 can otherwise leave Cesium ESM
 * worker imports pending when page.setRequestInterception(true) is enabled.
 * Real same-origin application assets pass directly; only API/external
 * requests reach the fixture callback. Unknown external requests must be
 * rejected or stubbed by that callback, never implicitly allowed here.
 */
export async function interceptFixtures(
  page,
  { origin, handle, includePaths = [], observeXhrAborts = false },
) {
  origin = new URL(origin).origin;
  if (typeof handle !== 'function')
    throw new TypeError('Fixture handler required');
  if (
    !Array.isArray(includePaths) ||
    includePaths.some(
      (path) =>
        typeof path !== 'string' ||
        !path.startsWith('/') ||
        new URL(path, origin).origin !== origin ||
        new URL(path, origin).pathname !== path,
    )
  )
    throw new TypeError('Fixture includePaths must be exact same-origin paths');
  const included = new Set(includePaths);
  const client = await page.createCDPSession();
  const errors = [];
  const cancellations = [];
  const diagnostics = [];
  const requests = new Map(),
    failures = new Map(),
    frames = new Map(),
    navigations = new Map(),
    frameWaiters = new Map();
  let eventSequence = 0;
  function boundedSet(map, key, value) {
    map.set(key, value);
    if (map.size > 512) map.delete(map.keys().next().value);
  }
  let xhrProof = null;
  const onRequest = (event) => {
    const owner = {
      loaderId: event.loaderId,
      frameId: event.frameId,
      startedAt: Number.isFinite(event.wallTime) ? event.wallTime * 1000 : null,
      at: Date.now(),
      sequence: ++eventSequence,
    };
    // Match in memory only. Never serialize query strings or authentication URLs.
    Object.defineProperties(owner, {
      url: { value: event.request?.url },
      method: { value: event.request?.method },
    });
    boundedSet(requests, event.requestId, owner);
    if (event.type === 'Document')
      onNavigating({ frameId: event.frameId, loaderId: event.loaderId });
    xhrProof?.observeNetwork();
  };
  const onNavigating = ({ frameId, loaderId }) => {
    if (!frameId || !loaderId) return;
    boundedSet(navigations, frameId, { loaderId, sequence: ++eventSequence });
  };
  const onFrame = ({ frame }) => {
    if (frames.get(frame.id)?.loaderId === frame.loaderId) return;
    boundedSet(frames, frame.id, {
      loaderId: frame.loaderId,
      at: Date.now(),
      sequence: ++eventSequence,
      failed:
        Boolean(frame.unreachableUrl) || /^chrome-error:/.test(frame.url || ''),
    });
    for (const observe of [...(frameWaiters.get(frame.id) || [])]) observe();
  };
  const cancelled = new Map(),
    waiting = new Map(),
    recorded = new WeakSet();
  let disposed = false;
  const recordError = (error, suffix = '') => {
    if (error && typeof error === 'object') {
      if (recorded.has(error)) return;
      recorded.add(error);
    }
    const message = String(error?.stack || error) + suffix;
    errors.push(message);
    return message;
  };
  const replacement = (
    owner,
    navigation,
    frameId,
    pausedSequence,
    failedSequence,
  ) => {
    const current = frames.get(frameId);
    if (
      owner?.frameId === frameId &&
      owner.loaderId &&
      navigation?.loaderId &&
      navigation.loaderId !== owner.loaderId &&
      navigation.sequence < failedSequence &&
      current?.loaderId === navigation.loaderId &&
      !current.failed &&
      current.sequence > pausedSequence &&
      current.sequence > owner.sequence
    )
      return {
        loaderId: owner.loaderId,
        replacementLoaderId: current.loaderId,
      };
    return null;
  };
  const waitForReplacement = (
    owner,
    navigation,
    frameId,
    pausedSequence,
    failedSequence,
  ) => {
    if (
      !owner?.loaderId ||
      owner.frameId !== frameId ||
      !navigation?.loaderId ||
      navigation.loaderId === owner.loaderId ||
      navigation.sequence >= failedSequence
    )
      return Promise.resolve(null);
    const observed = replacement(
      owner,
      navigation,
      frameId,
      pausedSequence,
      failedSequence,
    );
    if (observed) return Promise.resolve(observed);
    return new Promise((resolve) => {
      let timer;
      const finish = (value) => {
        clearTimeout(timer);
        frameWaiters.get(frameId)?.delete(observe);
        if (!frameWaiters.get(frameId)?.size) frameWaiters.delete(frameId);
        resolve(value);
      };
      const observe = () => {
        const value = replacement(
          owner,
          navigation,
          frameId,
          pausedSequence,
          failedSequence,
        );
        if (disposed || value) finish(value);
      };
      if (!frameWaiters.has(frameId)) frameWaiters.set(frameId, new Set());
      frameWaiters.get(frameId).add(observe);
      timer = setTimeout(() => finish(null), 2000);
      observe();
    });
  };
  const onLoadingFailed = (event) => {
    boundedSet(failures, event.requestId, {
      error: event.errorText,
      canceled: event.canceled,
      at: Date.now(),
    });
    if (
      !event.canceled &&
      !/^net::ERR_(?:ABORTED|INTERNET_DISCONNECTED)$/.test(
        event.errorText || '',
      )
    )
      return;
    cancelled.set(event.requestId, {
      at: Date.now(),
      error: event.errorText || 'cancelled',
    });
    if (cancelled.size > 512) cancelled.delete(cancelled.keys().next().value);
    for (const settle of waiting.get(event.requestId) || []) settle(true);
  };
  const hasCancellation = async (networkId) => {
    if (!networkId) return false;
    if (Date.now() - (cancelled.get(networkId)?.at || 0) < 5000) return true;
    return new Promise((resolve) => {
      let timer;
      const settle = (value) => {
        clearTimeout(timer);
        const group = waiting.get(networkId);
        group?.delete(settle);
        if (!group?.size) waiting.delete(networkId);
        resolve(value);
      };
      if (!waiting.has(networkId)) waiting.set(networkId, new Set());
      waiting.get(networkId).add(settle);
      timer = setTimeout(() => settle(false), 200);
    });
  };
  client.on('Network.loadingFailed', onLoadingFailed);
  client.on('Network.requestWillBeSent', onRequest);
  client.on('Page.frameNavigated', onFrame);
  client.on('Page.frameStartedNavigating', onNavigating);
  await client.send('Page.enable');
  await client.send('Network.enable');
  xhrProof = observeXhrAborts
    ? await createXhrAbortProof(client, { origin, frames, requests })
    : null;
  const onPaused = async (event) => {
    if (disposed) return;
    const { requestId, networkId, request, resourceType, frameId } = event;
    const pausedAt = Date.now();
    const pausedSequence = ++eventSequence;
    const url = new URL(request.url);
    let handled = false;
    const resolve = async (command, values) => {
      if (handled) return;
      handled = true;
      try {
        return await client.send(command, { requestId, ...values });
      } catch (error) {
        if (disposed) return;
        const failedSequence = ++eventSequence;
        const owner = requests.get(networkId);
        const navigation = navigations.get(frameId);
        // Navigation/offline transitions can cancel an already paused request.
        // Ignore only an invalid Fetch ID matched to Chrome's Network failure
        // or an already initiated navigation that commits replacement of that
        // exact request's owning document. A future unrelated navigation cannot
        // qualify; unknown loaders, abandoned navigation and Documents fail.
        if (
          /Invalid InterceptionId\.?$/i.test(error?.message || '') &&
          (await hasCancellation(networkId))
        ) {
          cancellations.push({
            networkId,
            error: cancelled.get(networkId)?.error || 'cancelled',
          });
          if (cancellations.length > 512) cancellations.shift();
          return;
        }
        if (disposed) return;
        const explicitAbort = /Invalid InterceptionId\.?$/i.test(
          error?.message || '',
        )
          ? xhrProof?.evidence(networkId, event)
          : null;
        if (explicitAbort) {
          cancellations.push(explicitAbort);
          if (cancellations.length > 512) cancellations.shift();
          return;
        }
        if (
          /Invalid InterceptionId\.?$/i.test(error?.message || '') &&
          resourceType !== 'Document' &&
          networkId &&
          owner?.frameId === frameId &&
          owner.loaderId &&
          navigation?.loaderId &&
          navigation.loaderId !== owner.loaderId &&
          navigation.sequence < failedSequence
        ) {
          // Keep unresolved errors visible to a caller's final guard while we
          // await proof. Only this request's matching commit can remove it.
          const pendingError = recordError(
            error,
            `\nUnconfirmed document retirement: ${requestId}`,
          );
          const retired = await waitForReplacement(
            owner,
            navigation,
            frameId,
            pausedSequence,
            failedSequence,
          );
          if (disposed || retired) {
            const index = errors.indexOf(pendingError);
            if (index >= 0) errors.splice(index, 1);
          }
          if (disposed) return;
          if (retired) {
            cancellations.push({
              networkId,
              error: 'document-replaced',
              ...retired,
            });
            if (cancellations.length > 512) cancellations.shift();
            return;
          }
        }
        diagnostics.push({
          requestId,
          networkId,
          frameId,
          command,
          resourceType,
          url: url.origin + url.pathname,
          pausedAt,
          pausedSequence,
          failedSequence,
          at: Date.now(),
          request: requests.get(networkId),
          xhrAbortCandidates: xhrProof?.diagnostic(networkId, event),
          failure: failures.get(networkId),
          frame: frames.get(frameId),
          navigation,
        });
        if (diagnostics.length > 512) diagnostics.shift();
        recordError(error);
        throw error;
      }
    };
    if (
      url.origin === origin &&
      !url.pathname.startsWith('/api/') &&
      !included.has(url.pathname)
    ) {
      await resolve('Fetch.continueRequest', {}).catch(() => {});
      return;
    }
    const route = {
      url: () => request.url,
      method: () => request.method,
      headers: () => request.headers,
      postData: () => request.postData,
      resourceType: () => resourceType?.toLowerCase(),
      isInterceptResolutionHandled: () => handled,
      continue: () => resolve('Fetch.continueRequest', {}),
      abort: () => resolve('Fetch.failRequest', { errorReason: 'Failed' }),
      respond: ({ status = 200, contentType, headers = {}, body = '' }) =>
        resolve('Fetch.fulfillRequest', {
          responseCode: status,
          responseHeaders: Object.entries({
            ...(contentType ? { 'Content-Type': contentType } : {}),
            ...headers,
          }).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(body).toString('base64'),
        }),
    };
    try {
      await handle(route);
      if (disposed) return;
      if (!handled) {
        errors.push(
          `Unresolved fixture request: ${request.method} ${request.url}`,
        );
        await route.abort();
      }
    } catch (error) {
      if (disposed) return;
      recordError(error);
      await route.abort().catch(() => {});
    }
  };
  client.on('Fetch.requestPaused', onPaused);
  await client.send('Fetch.enable', {
    patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }],
  });
  return {
    errors,
    cancellations,
    diagnostics,
    async dispose() {
      disposed = true;
      for (const group of waiting.values())
        for (const settle of [...group]) settle(false);
      for (const group of frameWaiters.values())
        for (const observe of [...group]) observe();
      await xhrProof?.dispose();
      client.off('Fetch.requestPaused', onPaused);
      client.off('Network.loadingFailed', onLoadingFailed);
      client.off('Network.requestWillBeSent', onRequest);
      client.off('Page.frameNavigated', onFrame);
      client.off('Page.frameStartedNavigating', onNavigating);
      await client.send('Fetch.disable').catch(() => {});
      await client.detach().catch(() => {});
    },
  };
}
