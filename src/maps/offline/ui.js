import * as Cesium from 'cesium';
import { planOfflineTiles, OFFLINE_LIMITS } from './schema.js';
import { openOfflinePackStore, openExistingOfflinePackStore } from './store.js';
import { offlineSource } from './imagery.js';
import {
  getResolvedOperatorContext,
  isOperatorContextCurrent,
  subscribeOperatorContextInvalidation,
  activateOfflineOperatorContext,
  clearOfflineOperatorContext,
} from '../../tak/operatorContext.js';

const API = '/api/maps/offline/packs';
const size = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
const sleep = (signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(done, 1000);
    function done() {
      signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
async function responseBytes(response, limit) {
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Map response exceeds its budget');
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}
export function shellMessage(type, onProgress = () => {}) {
  return new Promise(async (resolve, reject) => {
    let port;
    let timer;
    try {
      if (!navigator.serviceWorker)
        throw new Error(
          'Offline launch needs the built private HTTPS app and service-worker support',
        );
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, fail) =>
          setTimeout(
            () =>
              fail(
                new Error(
                  'Open the built private HTTPS app to save offline launch',
                ),
              ),
            5000,
          ),
        ),
      ]);
      const worker = registration.active;
      if (!worker) throw new Error('Reopen the application after installation');
      const accountContext = getResolvedOperatorContext();
      if (!isOperatorContextCurrent(accountContext))
        throw new Error('Offline application account context changed');
      const channel = new MessageChannel();
      port = channel.port1;
      timer = setTimeout(() => {
        port.close();
        reject(
          new Error(
            'Offline application operation timed out; reconnect and retry',
          ),
        );
      }, 600_000);
      port.onmessage = ({ data }) => {
        if (data.progress) {
          onProgress(data);
          return;
        }
        clearTimeout(timer);
        port.close();
        if (data.ok) resolve(data.result);
        else {
          const error = new Error(
            data.error || 'Offline application operation failed',
          );
          error.sessionExpired = data.sessionExpired === true;
          reject(error);
        }
      };
      worker.postMessage(
        {
          type,
          ...(accountContext.multiOperator
            ? { storageScope: accountContext.storageScope }
            : {}),
        },
        [channel.port2],
      );
    } catch (error) {
      clearTimeout(timer);
      port?.close();
      reject(error);
    }
  });
}

/** The TAK composition supplies privacy, navigation and ephemeral auth ownership. */
export function createSavedMaps({
  container,
  controller,
  viewer,
  getMapCenter,
  getAccessHeaders,
  markPrivate,
  onSessionExpired = () => {},
  navigate = (action) => action(),
}) {
  const root = document.createElement('details');
  root.className = 'tak-web-section';
  root.dataset.takSection = 'maps';
  root.innerHTML = `<summary>SAVED MAPS / OFFLINE</summary>
    <p class="tak-web-hint">Download USGS Topo to the server and this device. These are raster maps; 3D elevation is separate. Other sources need their own approved packages.</p>
    <form data-offline-form>
      <input data-offline-name maxlength="80" placeholder="Saved area name" aria-label="Saved area name" value="My topographic area" required>
      <div class="tak-web-row"><label>West<input data-offline-west type="number" step="any" min="-180" max="180" required></label><label>East<input data-offline-east type="number" step="any" min="-180" max="180" required></label></div>
      <div class="tak-web-row"><label>South<input data-offline-south type="number" step="any" min="-85" max="85" required></label><label>North<input data-offline-north type="number" step="any" min="-85" max="85" required></label></div>
      <button type="button" data-offline-center>Use 10 km around map center</button>
      <div class="tak-web-row"><label>Min zoom<input data-offline-min type="number" min="0" max="23" value="8" required></label><label>Max zoom<input data-offline-max type="number" min="0" max="23" value="13" required></label></div>
      <p class="tak-web-hint" data-offline-estimate></p>
      <label class="tak-web-check"><input type="checkbox" data-offline-phone checked> Also retain on this device</label>
      <p class="tak-web-hint">Saved areas and the offline app remain until deleted. Anyone using this browser profile can open them. Device storage may be removed by the OS; keep a server copy or export a backup.</p>
      <button type="submit" data-offline-action>Download area</button>
    </form>
    <button type="button" data-offline-cancel hidden>Cancel download</button>
    <p role="status" aria-live="polite" data-offline-status></p>
    <div class="tak-web-row"><button type="button" data-offline-refresh data-offline-action>Refresh saved maps</button><button type="button" data-offline-shell data-offline-action>Save app for offline launch</button></div>
    <p class="tak-web-hint" data-offline-shell-state>Offline launch has not been checked on this device.</p>
    <button type="button" data-offline-shell-delete data-offline-action>Remove offline app</button>
    <label class="tak-web-hint">Restore a .gevmap backup<input type="file" accept=".gevmap" data-offline-import></label>
    <ul data-offline-list class="tak-saved-map-list"></ul>`;
  container.append(root);
  const $ = (selector) => root.querySelector(selector);
  const lifetime = new AbortController();
  let task = null;
  let packId = null;
  let storePromise = null;
  let destroyed = false;
  const accountContext = getResolvedOperatorContext();
  const accountCurrent = () => isOperatorContextCurrent(accountContext);
  const getStore = () => {
    if (!accountCurrent())
      return Promise.reject(new Error('Sign in before opening saved maps'));
    return (storePromise ||= openOfflinePackStore({
      storageScope: accountContext.storageScope,
      isCurrent: accountCurrent,
    }));
  };
  const unsubscribeAccount = subscribeOperatorContextInvalidation(() => {
    task?.abort(new DOMException('Operator account changed', 'AbortError'));
    lifetime.abort();
    for (const stack of controller.getStacks())
      if (stack.id.startsWith('offline-'))
        controller.removeLocalSource(stack.id);
    void storePromise?.then((store) => store.close()).catch(() => {});
    $('[data-offline-list]').replaceChildren();
    for (const input of root.querySelectorAll('input')) {
      if (input.type === 'checkbox') input.checked = false;
      else input.value = '';
    }
    for (const button of root.querySelectorAll('button'))
      button.disabled = true;
    status('Account changed. Reopen the application to use saved maps.');
  });
  const status = (text) => {
    if (!destroyed) $('[data-offline-status]').textContent = text;
  };
  const numeric = (selector) => {
    const value = $(selector).value.trim();
    return value ? Number(value) : NaN;
  };
  const parameters = () => ({
    name: $('[data-offline-name]').value.trim(),
    bounds: Object.fromEntries(
      ['west', 'east', 'south', 'north'].map((key) => [
        key,
        numeric(`[data-offline-${key}]`),
      ]),
    ),
    minZoom: numeric('[data-offline-min]'),
    maxZoom: numeric('[data-offline-max]'),
  });
  function estimate() {
    try {
      const tiles = planOfflineTiles(parameters());
      $('[data-offline-estimate]').textContent =
        `${tiles.length.toLocaleString()} tiles. Approx. ${size(tiles.length * 25_000)}; actual size varies. Limit ${OFFLINE_LIMITS.maxTiles.toLocaleString()} tiles / ${size(OFFLINE_LIMITS.maxPackBytes)}.`;
    } catch (error) {
      $('[data-offline-estimate]').textContent = error.message;
    }
  }
  function center() {
    const point = getMapCenter();
    if (!point) return status('Point the map at the ground, then try again.');
    const lat = Math.max(-84, Math.min(84, point.lat));
    const dy = 5 / 111.32;
    const dx = dy / Math.cos((lat * Math.PI) / 180);
    const wrap = (lon) => ((lon + 540) % 360) - 180;
    for (const [key, value] of Object.entries({
      west: wrap(point.lon - dx),
      east: wrap(point.lon + dx),
      south: lat - dy,
      north: lat + dy,
    }))
      $(`[data-offline-${key}]`).value = value.toFixed(5);
    estimate();
  }
  async function api(
    url,
    { method = 'GET', body, signal = lifetime.signal, timeoutMs = 15_000 } = {},
  ) {
    if (!accountCurrent()) throw new Error('Saved-map account context changed');
    signal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const headers = await getAccessHeaders(signal);
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: {
        ...headers,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (
      response.status === 401 ||
      (response.status === 409 &&
        response.headers.get('X-TAK-Account-Context') === 'mismatch')
    )
      onSessionExpired();
    if (!accountCurrent()) throw new Error('Saved-map account context changed');
    if (response.status === 204) return null;
    const bytes = await responseBytes(
      response,
      OFFLINE_LIMITS.maxManifestBytes,
    );
    let value;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error('Saved maps are unavailable on this server');
    }
    if (!response.ok)
      throw new Error(
        value.error || `Map request refused (${response.status})`,
      );
    return value;
  }
  async function show(manifest, signal) {
    signal?.throwIfAborted();
    const store = await getStore();
    signal?.throwIfAborted();
    markPrivate();
    const source = offlineSource(manifest, store);
    if (!controller.getStack(source.descriptor.id))
      controller.registerLocalSource(source);
    await store.setSelectedPackId(manifest.id);
    signal?.throwIfAborted();
    await controller.setStack(source.descriptor.id);
    if (destroyed || signal?.aborted) return;
    navigate(() =>
      viewer.camera.flyTo({
        destination: Cesium.Rectangle.fromDegrees(
          manifest.bounds.west,
          manifest.bounds.south,
          manifest.bounds.east,
          manifest.bounds.north,
        ),
        duration: 1,
      }),
    );
    status(
      `Showing saved ${manifest.name}. Outside its area/detail, tiles remain blank. Acquired ${manifest.acquiredAt || manifest.updatedAt}.`,
    );
  }
  async function copyToDevice(manifest, signal) {
    const store = await getStore();
    const persistence = await store.requestPersistence();
    await store.copyFromServer(manifest, {
      signal,
      onProgress: (progress) =>
        status(
          `Saving device copy: ${progress.completedTiles ?? progress.completed ?? 0}/${manifest.plannedTiles} tiles.`,
        ),
      fetchTile: async (key, options) => {
        const signal = AbortSignal.any([
          options.signal,
          AbortSignal.timeout(30_000),
        ]);
        const response = await fetch(`${API}/${manifest.id}/tiles/${key}`, {
          headers: await getAccessHeaders(signal),
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal,
        });
        if (
          response.status === 401 ||
          (response.status === 409 &&
            response.headers.get('X-TAK-Account-Context') === 'mismatch')
        )
          onSessionExpired();
        if (!response.ok)
          throw new Error(
            'Tile unavailable or sign-in expired; reconnect and retry device copy',
          );
        return {
          bytes: await responseBytes(response, OFFLINE_LIMITS.maxTileBytes),
          contentType: response.headers.get('content-type')?.split(';')[0],
        };
      },
    });
    const saved = await store.getManifest(manifest.id);
    await show(saved, signal);
    status(
      `Server and device copies ready. ${persistence ? 'Persistent storage granted.' : 'Persistent storage was not granted; export a backup.'}`,
    );
  }
  async function run(action) {
    if (task || destroyed) return;
    if (!accountCurrent()) {
      status('Sign in before opening saved maps');
      return;
    }
    task = new AbortController();
    const current = task;
    for (const button of root.querySelectorAll('[data-offline-action]'))
      button.disabled = true;
    $('[data-offline-import]').disabled = true;
    $('[data-offline-cancel]').hidden = false;
    try {
      markPrivate();
      await action(current.signal);
    } catch (error) {
      if (error.sessionExpired) onSessionExpired();
      status(
        current.signal.aborted
          ? 'Download interrupted. Retained partial copies can be resumed.'
          : error.message,
      );
    } finally {
      if (task === current) task = null;
      packId = null;
      if (!destroyed && accountCurrent()) {
        for (const button of root.querySelectorAll('[data-offline-action]'))
          button.disabled = false;
        $('[data-offline-import]').disabled = false;
        $('[data-offline-cancel]').hidden = true;
      }
    }
  }
  function button(parent, text, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.dataset.offlineAction = '';
    element.addEventListener('click', () => void run(action), {
      signal: lifetime.signal,
    });
    parent.append(element);
  }
  async function refresh(signal) {
    const store = await getStore();
    const local = await store.listPacks();
    let server = [];
    let serverError = '';
    if (navigator.onLine !== false) {
      try {
        server = (await api(API, { signal, timeoutMs: 2000 })).packs;
      } catch (error) {
        serverError =
          error.name === 'TimeoutError'
            ? 'Private server unreachable; device copies are still available'
            : error.message;
      }
    } else serverError = 'Offline; using device copies';
    const entries = new Map(server.map((pack) => [pack.id, { server: pack }]));
    for (const pack of local) {
      const entry = entries.get(pack.id) || {};
      entry.local = pack;
      entries.set(pack.id, entry);
    }
    const list = $('[data-offline-list]');
    signal?.throwIfAborted();
    if (!accountCurrent()) throw new Error('Saved-map account context changed');
    list.replaceChildren();
    for (const [id, entry] of entries) {
      const pack = entry.local || entry.server;
      const row = document.createElement('li');
      const label = document.createElement('p');
      label.textContent = `${pack.name} · server ${entry.server?.state || 'unavailable'} · device ${entry.local?.state || 'absent'} · ${size(pack.downloadedBytes || 0)}`;
      row.append(label);
      if (entry.local?.state === 'ready') {
        button(row, 'Show saved map', (nextSignal) =>
          show(entry.local, nextSignal),
        );
        button(row, 'Export backup', async (nextSignal) => {
          const blob = await store.exportPack(id, { signal: nextSignal });
          nextSignal.throwIfAborted();
          if (!accountCurrent())
            throw new Error('Saved-map account context changed');
          const link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = `${id}.gevmap`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
          status('Backup export prepared. Keep it in a private location.');
        });
      }
      if (entry.server?.state === 'ready')
        button(
          row,
          entry.local?.state === 'ready'
            ? 'Verify / refresh device copy'
            : 'Save to this device',
          async (nextSignal) => {
            await copyToDevice(
              await api(`${API}/${id}`, { signal: nextSignal }),
              nextSignal,
            );
            await refresh(nextSignal);
          },
        );
      else if (entry.server && entry.server.state !== 'downloading')
        button(row, 'Resume server download', async (nextSignal) => {
          await api(`${API}/${id}/resume`, {
            method: 'POST',
            signal: nextSignal,
          });
          status('Server download resumed. Refresh to check progress.');
          await refresh(nextSignal);
        });
      if (entry.server?.state === 'downloading')
        button(row, 'Cancel server download', async (nextSignal) => {
          await api(`${API}/${id}/cancel`, {
            method: 'POST',
            signal: nextSignal,
          });
          status(
            'Server download cancelled; verified partial tiles are retained.',
          );
          await refresh(nextSignal);
        });
      if (entry.local)
        button(row, 'Delete device copy', async (nextSignal) => {
          await store.deletePack(id);
          controller.removeLocalSource(`offline-${id}`);
          status(
            'Device copy deleted. A selected deleted map remains blank until you choose another map.',
          );
          await refresh(nextSignal);
        });
      if (entry.server)
        button(row, 'Delete server copy', async (nextSignal) => {
          await api(`${API}/${id}`, { method: 'DELETE', signal: nextSignal });
          status('Server copy deleted.');
          await refresh(nextSignal);
        });
      list.append(row);
    }
    if (serverError)
      status(`Device copies are available below. Server: ${serverError}`);
    else if (!entries.size) status('No saved maps yet.');
    const quota = await store.estimate();
    $('[data-offline-shell-state]').textContent =
      `Browser storage: ${size(quota?.usage || 0)} used / ${size(quota?.quota || 0)} quota. Save the application as well as maps for disconnected launch.`;
  }
  $('[data-offline-form]').addEventListener(
    'submit',
    (event) => {
      event.preventDefault();
      void run(async (signal) => {
        const request = parameters();
        planOfflineTiles(request);
        status('Preparing server download…');
        let manifest = await api(API, {
          method: 'POST',
          body: request,
          signal,
        });
        packId = manifest.id;
        while (
          manifest.state === 'downloading' ||
          manifest.state === 'partial'
        ) {
          status(
            `Server copy: ${manifest.completedTiles}/${manifest.plannedTiles} tiles · ${size(manifest.downloadedBytes)}.`,
          );
          await sleep(signal);
          manifest = await api(`${API}/${packId}`, { signal });
        }
        if (manifest.state !== 'ready')
          throw new Error(
            manifest.error ||
              `Server download ${manifest.state}; retained tiles can be resumed.`,
          );
        if ($('[data-offline-phone]').checked) {
          await copyToDevice(manifest, signal);
          try {
            await shellMessage('GEV_SHELL_SAVE', (p) =>
              status(
                `Saving offline app: ${p.completed}/${p.total} files · ${size(p.bytes)}.`,
              ),
            );
            signal.throwIfAborted();
            activateOfflineOperatorContext();
            status(
              'Server map, device map and offline app ready. Export a backup and test this device disconnected.',
            );
          } catch (error) {
            if (error.sessionExpired) throw error;
            status(
              `Map copies ready; offline launch still needs attention: ${error.message}`,
            );
          }
        } else
          status(
            'Server map ready. Save a device copy for disconnected phone use.',
          );
        await refresh(signal);
      });
    },
    { signal: lifetime.signal },
  );
  $('[data-offline-center]').addEventListener('click', center, {
    signal: lifetime.signal,
  });
  root
    .querySelector('form')
    .addEventListener('input', estimate, { signal: lifetime.signal });
  $('[data-offline-refresh]').addEventListener(
    'click',
    () => void run(refresh),
    { signal: lifetime.signal },
  );
  $('[data-offline-cancel]').addEventListener(
    'click',
    () => {
      task?.abort(new Error('Cancelled'));
      if (navigator.serviceWorker?.controller)
        void shellMessage('GEV_SHELL_CANCEL').catch((error) =>
          status(error.message),
        );
      if (packId)
        void api(`${API}/${packId}/cancel`, { method: 'POST' }).catch(() => {});
    },
    { signal: lifetime.signal },
  );
  $('[data-offline-shell]').addEventListener(
    'click',
    () =>
      void run(async (signal) => {
        const saved = await shellMessage('GEV_SHELL_SAVE', (p) =>
          status(
            `Saving offline app: ${p.completed}/${p.total} files · ${size(p.bytes)}.`,
          ),
        );
        signal.throwIfAborted();
        activateOfflineOperatorContext();
        status(
          `Offline application saved (${size(saved.totalBytes)}). Save a map and test disconnected launch on this device.`,
        );
      }),
    { signal: lifetime.signal },
  );
  $('[data-offline-shell-delete]').addEventListener(
    'click',
    () =>
      void run(async () => {
        await shellMessage('GEV_SHELL_DELETE');
        clearOfflineOperatorContext({ invalidateContext: false });
        status(
          'Offline application removed. Saved maps remain separately stored.',
        );
      }),
    { signal: lifetime.signal },
  );
  $('[data-offline-import]').addEventListener(
    'change',
    (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file)
        void run(async (signal) => {
          const store = await getStore();
          const manifest = await store.importPack(file, {
            signal,
            onProgress: (p) =>
              status(
                `Restoring ${p.completedTiles ?? p.completed ?? 0} tiles…`,
              ),
          });
          await show(manifest, signal);
          await refresh(signal);
        });
    },
    { signal: lifetime.signal },
  );
  root.addEventListener(
    'toggle',
    () => {
      if (root.open && !storePromise) {
        center();
        void run(refresh);
      }
    },
    { signal: lifetime.signal },
  );
  const unsubscribe = controller.subscribe((state) => {
    if (state.activeId?.startsWith('offline-')) return;
    const expectedGeneration = controller.getSwitchGeneration();
    if (!accountCurrent()) return;
    void (
      storePromise ||
      openExistingOfflinePackStore({
        storageScope: accountContext.storageScope,
        isCurrent: accountCurrent,
      })
    )
      .then((store) => {
        if (
          !destroyed &&
          accountCurrent() &&
          store &&
          controller.getSwitchGeneration() === expectedGeneration &&
          !controller.getActiveId()?.startsWith('offline-')
        )
          return store.setSelectedPackId(null);
      })
      .catch(() => {});
  });
  return {
    root,
    destroy() {
      destroyed = true;
      task?.abort();
      lifetime.abort();
      unsubscribe();
      unsubscribeAccount();
      void storePromise?.then((store) => store.close()).catch(() => {});
      root.remove();
    },
  };
}
