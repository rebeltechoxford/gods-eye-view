// Optional QA evidence for Chrome dropping Fetch IDs after an app cancels XHR.
// Never changes URLs, headers, credentials, responses or application callbacks.
export function installXhrAbortObserver(bindingName, origin) {
  if (globalThis.top !== globalThis || !globalThis.XMLHttpRequest) return;
  const prototype = XMLHttpRequest.prototype;
  const original = {
    open: prototype.open,
    send: prototype.send,
    abort: prototype.abort,
  };
  const prepared = new WeakMap(),
    active = new Map();
  const now = () => performance.timeOrigin + performance.now();
  let serial = 0,
    enabled = true;
  const emit = (value) => {
    try {
      if (enabled) globalThis[bindingName]?.(JSON.stringify(value));
    } catch {}
  };
  const finish = (xhr, record) => {
    if (active.get(xhr) !== record) return;
    active.delete(xhr);
    xhr.removeEventListener('loadend', record.finish);
    emit({ kind: 'finish', id: record.id, at: now() });
  };
  function open(...args) {
    const result = Reflect.apply(original.open, this, args);
    if (!enabled) return result;
    prepared.delete(this);
    if (
      typeof args[0] === 'string' &&
      typeof args[1] === 'string' &&
      args[2] !== false
    ) {
      try {
        const url = new URL(args[1], document.baseURI);
        url.hash = '';
        if (
          args[0].toUpperCase() === 'GET' &&
          /^https?:$/.test(url.protocol) &&
          url.origin !== origin &&
          !url.username &&
          !url.password
        )
          prepared.set(this, { url: url.href, method: 'GET' });
      } catch {}
    }
    return result;
  }
  function send(...args) {
    const metadata = prepared.get(this);
    if (!enabled || !metadata || active.has(this) || active.size >= 512)
      return Reflect.apply(original.send, this, args);
    const record = { ...metadata, id: ++serial };
    record.finish = () => finish(this, record);
    active.set(this, record);
    this.addEventListener('loadend', record.finish);
    emit({
      kind: 'send',
      id: record.id,
      method: record.method,
      url: record.url,
      at: now(),
    });
    try {
      return Reflect.apply(original.send, this, args);
    } catch (error) {
      finish(this, record);
      throw error;
    }
  }
  function abort(...args) {
    const record = active.get(this),
      readyState = this.readyState;
    const result = Reflect.apply(original.abort, this, args);
    if (record && readyState >= 1 && readyState <= 3)
      emit({ kind: 'abort', id: record.id, readyState, at: now() });
    return result;
  }
  prototype.open = open;
  prototype.send = send;
  prototype.abort = abort;
  globalThis[bindingName + '_restore'] = () => {
    enabled = false;
    for (const [xhr, record] of active)
      xhr.removeEventListener('loadend', record.finish);
    active.clear();
    for (const [key, replacement] of Object.entries({ open, send, abort }))
      if (prototype[key] === replacement) prototype[key] = original[key];
    delete globalThis[bindingName + '_restore'];
  };
}

let ownerSerial = 0;
export async function createXhrAbortProof(
  client,
  { origin, frames, requests },
) {
  const bindingName = `__gevQaXhrAbort${++ownerSerial}`;
  const contexts = new Map(),
    records = new Map();
  let disposed = false;
  const boundedSet = (map, key, value) => {
    map.set(key, value);
    if (map.size > 512) map.delete(map.keys().next().value);
  };
  const matches = (record, owner) =>
    owner.frameId === record.frameId &&
    owner.loaderId === record.loaderId &&
    owner.url === record.url &&
    owner.method === record.method &&
    Number.isFinite(owner.startedAt) &&
    record.sentAt <= owner.startedAt &&
    owner.startedAt <= record.sentAt + 1000 &&
    (!record.finishedAt || owner.startedAt <= record.finishedAt);
  function bindNetwork(record) {
    const candidates = [...requests].filter(([, owner]) =>
      matches(record, owner),
    );
    if (candidates.length > 1) record.ambiguous = true;
    if (candidates.length === 1) {
      const [networkId] = candidates[0];
      if (record.networkId && record.networkId !== networkId)
        record.ambiguous = true;
      else record.networkId = networkId;
    }
  }
  const observeNetwork = () => {
    for (const record of records.values()) bindNetwork(record);
  };
  const onContext = ({ context }) => {
    const frameId = context.auxData?.frameId;
    if (!context.auxData?.isDefault || !frameId) return;
    boundedSet(contexts, context.id, {
      frameId,
      loaderId: frames.get(frameId)?.loaderId,
    });
  };
  const onBinding = (event) => {
    if (disposed || event.name !== bindingName || event.payload?.length > 4096)
      return;
    const context = contexts.get(event.executionContextId);
    if (!context?.loaderId) return;
    let value;
    try {
      value = JSON.parse(event.payload);
    } catch {
      return;
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      !Number.isFinite(value.at) ||
      Math.abs(Date.now() - value.at) > 5000
    )
      return;
    const key = `${event.executionContextId}:${value.id}`;
    if (value.kind === 'send') {
      if (
        records.has(key) ||
        value.method !== 'GET' ||
        typeof value.url !== 'string' ||
        value.url.length > 4000
      )
        return;
      let url;
      try {
        url = new URL(value.url);
      } catch {
        return;
      }
      if (
        !/^https?:$/.test(url.protocol) ||
        url.origin === origin ||
        url.username ||
        url.password ||
        url.hash
      )
        return;
      const record = {
        ...context,
        executionContextId: event.executionContextId,
        id: value.id,
        url: url.href,
        method: value.method,
        sentAt: value.at,
      };
      for (const prior of records.values()) {
        if (
          prior.executionContextId === record.executionContextId &&
          prior.url === record.url &&
          prior.method === record.method &&
          !prior.finishedAt
        ) {
          prior.ambiguous = true;
          record.ambiguous = true;
        }
      }
      boundedSet(records, key, record);
      bindNetwork(record);
    } else {
      const record = records.get(key);
      if (!record || value.at < record.sentAt) return;
      if (value.kind === 'finish') record.finishedAt = value.at;
      if (value.kind === 'abort' && [1, 2, 3].includes(value.readyState))
        record.abortedAt = value.at;
    }
  };
  client.on('Runtime.executionContextCreated', onContext);
  client.on('Runtime.bindingCalled', onBinding);
  await client.send('Runtime.enable');
  await client.send('Runtime.addBinding', { name: bindingName });
  const script = await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${installXhrAbortObserver.toString()})(${JSON.stringify(bindingName)},${JSON.stringify(origin)})`,
  });
  return {
    observeNetwork,
    diagnostic(networkId, { frameId, request }) {
      const owner = requests.get(networkId);
      return [...records.values()]
        .filter(
          (record) =>
            record.frameId === frameId &&
            record.loaderId === owner?.loaderId &&
            record.url === request.url &&
            record.method === request.method,
        )
        .slice(-4)
        .map((record) => ({
          executionContextId: record.executionContextId,
          rendererRequestId: record.id,
          networkId: record.networkId,
          sentAt: record.sentAt,
          finishedAt: record.finishedAt,
          abortedAt: record.abortedAt,
          ambiguous: record.ambiguous === true,
        }));
    },
    evidence(networkId, { frameId, resourceType, request }) {
      if (disposed || resourceType !== 'XHR' || request.method !== 'GET')
        return null;
      const owner = requests.get(networkId);
      if (
        !owner?.loaderId ||
        owner.frameId !== frameId ||
        owner.url !== request.url ||
        owner.method !== request.method ||
        !Number.isFinite(owner.startedAt)
      )
        return null;
      const candidates = [...records.values()].filter((record) =>
        // Both clocks use renderer epoch time. The strict active interval
        // rejects an old completed abort for a later same-URL request.
        matches(record, owner),
      );
      if (candidates.length !== 1) return null;
      const record = candidates[0];
      bindNetwork(record);
      if (
        record.ambiguous ||
        !record.abortedAt ||
        record.abortedAt < owner.startedAt ||
        (record.networkId && record.networkId !== networkId)
      )
        return null;
      record.networkId = networkId;
      return {
        networkId,
        error: 'explicit-xhr-abort',
        executionContextId: record.executionContextId,
        rendererRequestId: record.id,
        frameId,
        loaderId: record.loaderId,
        sentAt: record.sentAt,
        abortedAt: record.abortedAt,
      };
    },
    async dispose() {
      disposed = true;
      await client
        .send('Page.removeScriptToEvaluateOnNewDocument', {
          identifier: script.identifier,
        })
        .catch(() => {});
      await client
        .send('Runtime.evaluate', {
          expression: `globalThis[${JSON.stringify(bindingName + '_restore')}]?.()`,
        })
        .catch(() => {});
      await client
        .send('Runtime.removeBinding', { name: bindingName })
        .catch(() => {});
      client.off('Runtime.executionContextCreated', onContext);
      client.off('Runtime.bindingCalled', onBinding);
      contexts.clear();
      records.clear();
    },
  };
}
