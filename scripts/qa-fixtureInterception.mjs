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
  { origin, handle, includePaths = [] },
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
  const cancelled = new Map(),
    waiting = new Map(),
    recorded = new WeakSet();
  let disposed = false;
  const recordError = (error) => {
    if (error && typeof error === 'object') {
      if (recorded.has(error)) return;
      recorded.add(error);
    }
    errors.push(String(error?.stack || error));
  };
  const onLoadingFailed = (event) => {
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
  await client.send('Network.enable');
  const onPaused = async (event) => {
    if (disposed) return;
    const { requestId, networkId, request, resourceType } = event;
    const url = new URL(request.url);
    let handled = false;
    const resolve = async (command, values) => {
      if (handled) return;
      handled = true;
      try {
        return await client.send(command, { requestId, ...values });
      } catch (error) {
        if (disposed) return;
        // Navigation/offline transitions can cancel an already paused request.
        // Ignore only an invalid Fetch ID matched to Chrome's Network failure
        // for that same request; an unexplained protocol error remains fatal.
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
    async dispose() {
      disposed = true;
      for (const group of waiting.values())
        for (const settle of [...group]) settle(false);
      client.off('Fetch.requestPaused', onPaused);
      client.off('Network.loadingFailed', onLoadingFailed);
      await client.send('Fetch.disable').catch(() => {});
      await client.detach().catch(() => {});
    },
  };
}
