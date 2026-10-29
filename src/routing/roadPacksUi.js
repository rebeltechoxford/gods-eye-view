import { t } from '../i18n/index.js';
const htmlText = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ],
  );
// "OFFLINE ROADS" section of the TAK panel: list the road packs the private
// host offers, download one to this device (resumable, SHA-256 verified) and
// remove installed packs. Driving directions then use an installed pack on
// their own whenever both ends of a trip are inside it.

import { validateRoadPackManifest } from './packManifest.js';

const API = '/api/routing/packs';

const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MiB`;
const day = (iso) => (iso ? iso.slice(0, 10) : 'unknown');
const box = (b) =>
  `${b.south.toFixed(2)}…${b.north.toFixed(2)}° N, ${b.west.toFixed(2)}…${b.east.toFixed(2)}° E`;

/**
 * @param {object} options
 * @param {HTMLElement} options.container
 * @param {(signal:AbortSignal)=>Promise<Record<string,string>>} options.getAccessHeaders
 * @param {()=>Promise<object|null>} options.openStore Account-scoped pack store.
 * @param {{unload:()=>void}} options.engine Offline routing engine.
 * @param {()=>void} [options.onSessionExpired]
 * @param {?(onProgress:(p:object)=>void)=>Promise<object>} [options.saveOfflineApp]
 *   Save the application for disconnected launch and approve this account's
 *   offline storage, as a saved map does. Null where offline launch is not
 *   available.
 */
export function createOfflineRoadsPanel({
  container,
  getAccessHeaders,
  openStore,
  engine,
  onSessionExpired = () => {},
  saveOfflineApp = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  if (!container) return { refresh() {}, destroy() {} };
  const root = document.createElement('details');
  root.className = 'tak-web-section';
  root.dataset.takSection = 'roads';
  root.innerHTML = `<summary>${htmlText(t('OFFLINE ROADS / ROUTING'))}</summary>
    <p class="tak-web-hint">${htmlText(t('Download a road pack once, then driving directions work with no signal: both ends of the trip must be inside the pack. Times are estimates from road types and speed limits; closures, live traffic and turn restrictions are not known offline. Road data © OpenStreetMap contributors (ODbL).'))}</p>
    <h4>${htmlText(t('ON THIS DEVICE'))}</h4>
    <ul class="tak-road-pack-list" data-roads-installed></ul>
    <h4>${htmlText(t('AVAILABLE FROM THE PRIVATE SERVER'))}</h4>
    <ul class="tak-road-pack-list" data-roads-available></ul>
    <button type="button" data-roads-refresh>${htmlText(t('Refresh list'))}</button>
    <p class="tak-web-hint" data-roads-status role="status" aria-live="polite"></p>`;
  container.append(root);
  const $ = (name) => root.querySelector(`[data-roads-${name}]`);
  const lifetime = new AbortController();
  let download = null;
  let destroyed = false;

  const status = (text) => {
    if (!destroyed) $('status').textContent = text;
  };

  async function serverFetch(url, { headers = {}, signal } = {}) {
    const access = await getAccessHeaders(signal);
    const response = await fetchImpl(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { ...access, ...headers },
    });
    if (response.status === 401) onSessionExpired();
    return response;
  }

  function item(text, buttons = []) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = text;
    li.append(label);
    for (const [caption, action, data] of buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = caption;
      button.dataset.roadsAction = data;
      button.addEventListener('click', action, { signal: lifetime.signal });
      li.append(' ', button);
    }
    return li;
  }

  async function renderInstalled(store) {
    const list = $('installed');
    list.replaceChildren();
    const records = store ? await store.list() : [];
    if (!store) {
      list.append(
        item(
          'Sign in (or connect the local gateway) to store road packs on this device.',
        ),
      );
      return records;
    }
    if (!records.length) list.append(item('No road packs installed.'));
    for (const record of records) {
      const state =
        record.state === 'ready'
          ? 'ready'
          : `paused at ${Math.floor((record.receivedBytes / record.bytes) * 100)}%`;
      list.append(
        item(
          `${record.name} · ${mib(record.bytes)} · OSM ${day(record.edition)} · ${state} · ${box(record.bounds)}`,
          [['Remove', () => remove(record), 'remove']],
        ),
      );
    }
    return records;
  }

  async function refresh() {
    let store = null;
    try {
      store = await openStore();
    } catch (error) {
      status(`Device storage unavailable: ${error?.message || error}`);
    }
    const installed = await renderInstalled(store).catch(() => []);
    const list = $('available');
    list.replaceChildren();
    try {
      const response = await serverFetch(API, { signal: lifetime.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const packs = (Array.isArray(body?.packs) ? body.packs : []).flatMap(
        (value) => {
          try {
            return [validateRoadPackManifest(value)];
          } catch {
            return [];
          }
        },
      );
      if (!packs.length)
        list.append(
          item(
            'The server has no road packs yet. Build one with scripts/build-road-pack.mjs.',
          ),
        );
      for (const pack of packs) {
        const have = installed.find((record) => record.id === pack.id);
        const action =
          have?.state === 'ready' && have.sha256 === pack.sha256
            ? []
            : [
                [
                  have ? 'Resume download' : 'Download to this device',
                  () => install(pack),
                  'download',
                ],
              ];
        list.append(
          item(
            `${pack.name} · ${mib(pack.bytes)} · OSM ${day(pack.edition)} · ${box(pack.bounds)} · ${pack.attribution}`,
            action,
          ),
        );
      }
    } catch (error) {
      if (lifetime.signal.aborted) return;
      list.append(
        item(
          `Server list unavailable (offline?): ${error?.message || error}. Installed packs still work.`,
        ),
      );
    }
  }

  async function install(pack) {
    if (download) return status('A road pack download is already running.');
    const operation = new AbortController();
    download = operation;
    const signal = AbortSignal.any([operation.signal, lifetime.signal]);
    status(`Downloading ${pack.name}…`);
    try {
      const store = await openStore();
      signal.throwIfAborted();
      if (!store)
        throw new Error('Sign in before storing road packs on this device');
      await store.install(pack, {
        signal,
        fetchFrom: (start, s) =>
          serverFetch(`${API}/${pack.id}`, {
            signal: s,
            headers: start ? { Range: `bytes=${start}-` } : {},
          }),
        onProgress: ({ receivedBytes, totalBytes }) =>
          status(
            `Downloading ${pack.name}: ${Math.floor((receivedBytes / totalBytes) * 100)}% (${mib(receivedBytes)} of ${mib(totalBytes)})`,
          ),
      });
      signal.throwIfAborted();
    } catch (error) {
      if (download === operation) download = null;
      if (!destroyed) void refresh();
      return status(
        signal.aborted
          ? `Download of ${pack.name} paused.`
          : `Download of ${pack.name} stopped: ${error?.message || error}. Press Resume to continue.`,
      );
    }
    const ready = `${pack.name} is installed and verified. Driving directions inside it now work offline.`;
    // A pack is only useful off the grid if the app itself can launch there.
    let launch = '';
    if (saveOfflineApp && !signal.aborted) {
      try {
        await saveOfflineApp((p) =>
          status(
            `${ready} Saving the app for offline launch: ${p.completed}/${p.total} files.`,
          ),
        );
        launch = ' The app is saved for offline launch on this device.';
      } catch (error) {
        if (error?.sessionExpired) onSessionExpired();
        launch = ` Offline launch was not saved (${error?.message || error}); use SAVED MAPS → Save app for offline launch on the private HTTPS app.`;
      }
    }
    if (download === operation) download = null;
    status(ready + launch);
    if (!destroyed) void refresh();
  }

  async function remove(record) {
    const store = await openStore();
    if (!store) return;
    download?.abort();
    await store.remove(record.id);
    engine.unload();
    status(`${record.name} removed from this device.`);
    void refresh();
  }

  $('refresh').addEventListener('click', () => void refresh(), {
    signal: lifetime.signal,
  });
  root.addEventListener(
    'toggle',
    () => {
      if (root.open) void refresh();
    },
    { signal: lifetime.signal },
  );

  return {
    refresh,
    destroy() {
      destroyed = true;
      download?.abort();
      lifetime.abort();
      root.remove();
    },
  };
}
