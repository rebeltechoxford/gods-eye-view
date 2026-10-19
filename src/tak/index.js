import './tak.css';
import * as Cesium from 'cesium';
import { createTakClient } from './client.js';
import { createCotOverlay } from './cotOverlay.js';
import { createGatewayTransport, fetchGatewaySession } from './transport.js';
import { createTakPanel } from './ui.js';
import { createMissionPackagePanel } from './packagesUi.js';
import { deviceLocation } from '../location/deviceLocation.js';
import { createMobileSession } from './mobile.js';
import { signOutOperator } from './session.js';
import { createSavedMaps, shellMessage } from '../maps/offline/ui.js';
import { createOfflineRoadsPanel } from '../routing/roadPacksUi.js';
import {
  offlineRouting,
  openCurrentRoadPackStore,
} from '../routing/deviceRouting.js';
import { createNavigationPanel } from './navigationUi.js';
import { createDrawingsPanel } from './drawingsUi.js';
import { createPicturePanel } from './pictureUi.js';
import { createNavigationFocus } from './navigationCamera.js';
import { isEmbedded } from '../app/embed.js';
import {
  getResolvedOperatorContext,
  isOperatorContextCurrent,
  identityStorageKey,
  subscribeOperatorContextInvalidation,
  clearOfflineOperatorContext,
  activateOfflineOperatorContext,
} from './operatorContext.js';
import {
  authorizeTakDisclosure,
  markTakDataPrivate,
  subscribeTakPrivacy,
  takPrivacyState,
  takDisclosurePermissions,
} from './privacy.js';
import { emconState, syncEmconWorker } from '../emcon/boot.js';
import { mountEmconControl } from '../emcon/ui.js';

const browserStorage = Object.freeze({
  get(key) {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      globalThis.localStorage?.setItem(key, value);
    } catch {
      // private mode / blocked storage: identity lasts for this page only
    }
  },
});

/** Globe point under the screen centre, or null when looking at space. */
function mapCenter(viewer) {
  const canvas = viewer.scene.canvas;
  const ray = viewer.camera.getPickRay(
    new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
  );
  const hit = ray && viewer.scene.globe.pick(ray, viewer.scene);
  const cartesian =
    hit ||
    viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
  if (!cartesian) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * TAK client entry point: CoT contacts, SA, markers and chat on the GEV globe.
 * All GEV layers keep running underneath ("God's eye view" + TAK overlay).
 * Network exchange happens only through the same-origin gateway, and only
 * after the operator presses Connect.
 * @param {{viewer: Cesium.Viewer, overlays: {setEntries:Function, clearSource:Function, setVisible:Function}}} options
 */
export function initTakWebClient({
  viewer,
  overlays,
  navigate,
  mapStackController,
}) {
  const controller = new AbortController();
  const embedded = isEmbedded();
  const accountContext = embedded ? null : getResolvedOperatorContext();
  const accountCurrent = () =>
    !embedded && isOperatorContextCurrent(accountContext);
  const mayShare = () =>
    !retired &&
    accountCurrent() &&
    (!accountContext.multiOperator || accountContext.role === 'operator');
  let retired = false;
  let logoutController = null;
  let gatewayInfo = accountContext?.gateway || {
    enabled: false,
    ...(accountContext?.multiOperator
      ? {
          multiOperator: true,
          principal: accountContext.principal,
          role: accountContext.role,
        }
      : {}),
    reason:
      accountContext?.reason ||
      (accountContext?.online === false
        ? 'Offline; using approved device context'
        : 'Account context unavailable'),
  };
  let gatewayReady;
  let expiredRedirected = false;
  let navigation = null;
  let packages = null;
  let drawings = null;
  let picture = null;
  const mobile = createMobileSession();
  // One device watch is shared with the map's own location dot.
  const geolocation = deviceLocation().consumer();

  const client = createTakClient({
    createTransport: (handlers) => createGatewayTransport(handlers),
    identityStorageKey: embedded ? null : identityStorageKey(),
    storage: {
      get: (key) => (accountCurrent() ? browserStorage.get(key) : null),
      set: (key, value) => {
        if (accountCurrent()) browserStorage.set(key, value);
      },
    },
    canShare: mayShare,
    canReportPosition: () => !document.hidden && geolocation.isActive(),
  });
  // EMCON closes the TAK link but keeps the received picture on screen.
  const stopEmconWatch = emconState.subscribe((record) => {
    if (record) client.disconnect();
  });
  const overlay = createCotOverlay(viewer, overlays, {
    onActivate: (uid) => overlay.focus(uid),
    navigate,
  });
  const panel = createTakPanel({
    client,
    overlay,
    getMapCenter: () => mapCenter(viewer),
    geolocation,
    mobile,
    clearRetainedPicture: () => picture?.hide(),
    async logout() {
      logoutController = new AbortController();
      await signOutOperator({
        context: accountContext,
        isCurrent: accountCurrent,
        retire,
        navigate: (path) => window.location.replace(path),
        signal: AbortSignal.any([
          logoutController.signal,
          AbortSignal.timeout(10_000),
        ]),
      });
    },
    gatewayInfo: () => gatewayInfo,
    async connect(token, signal) {
      if (emconState.isActive())
        throw new Error(
          'EMCON is on: TAK stays disconnected until you leave EMCON',
        );
      if (!gatewayInfo) await gatewayReady;
      if (signal.aborted || controller.signal.aborted || retired) return false;
      if (!accountCurrent() || !accountContext.online)
        throw new Error(
          'Reconnect and reopen the approved server before connecting',
        );
      if (!token && gatewayInfo?.bootstrapAllowed) {
        const session = await fetchGatewaySession(globalThis.fetch, signal);
        token = session.token;
      }
      if (signal.aborted || controller.signal.aborted || retired) return false;
      if (!accountCurrent() || !accountContext.online)
        throw new Error(
          'Reconnect and reopen the approved server before connecting',
        );
      client.connect(
        gatewayInfo?.sessionAuthenticated
          ? {
              session: true,
              ...(accountContext.multiOperator
                ? { storageScope: accountContext.storageScope }
                : {}),
            }
          : token,
      );
      return true;
    },
    privacy: {
      state: () => ({
        ...takPrivacyState(viewer),
        permissions: takDisclosurePermissions(viewer),
      }),
      authorize: (enabled, scope) =>
        authorizeTakDisclosure(viewer, enabled, scope),
    },
  });
  navigation = createNavigationPanel({
    container: document.getElementById('tak-web-panel'),
    client,
    getMapCenter: () => mapCenter(viewer),
    focusTarget: createNavigationFocus(viewer, navigate),
    markPrivate: () => markTakDataPrivate(viewer),
    gpsActive: () => geolocation.isActive(),
    subscribeMapCenter: (listener) =>
      viewer.camera.moveEnd.addEventListener(listener),
  });
  packages = createMissionPackagePanel({
    container: document.getElementById('tak-web-panel'),
    client,
    markPrivate: () => markTakDataPrivate(viewer),
  });
  drawings = createDrawingsPanel({
    container: document.getElementById('tak-web-panel'),
    client,
    overlay,
    getMapCenter: () => mapCenter(viewer),
    focusTarget: createNavigationFocus(viewer, navigate),
    markPrivate: () => markTakDataPrivate(viewer),
  });
  if (!embedded && accountContext?.storageAllowed) {
    const historicalOverlay = createCotOverlay(viewer, overlays, {
      namespace: 'tak-history',
      sourceName: 'TAK historical picture',
      onActivate: (uid) => {
        if (accountCurrent() && !retired && !controller.signal.aborted)
          historicalOverlay.focus(uid);
      },
      navigate,
    });
    picture = createPicturePanel({
      container: document.getElementById('tak-web-panel'),
      client,
      overlay: historicalOverlay,
      context: accountContext,
      isCurrent: accountCurrent,
      signal: controller.signal,
      markPrivate: () => markTakDataPrivate(viewer),
    });
  }
  let mapBootstrap = null;
  let mapBootstrapAt = 0;
  // Saved maps and road packs authenticate the same way.
  async function takAccessHeaders(signal) {
    if (!gatewayInfo) await gatewayReady;
    signal?.throwIfAborted();
    if (!accountCurrent() || retired)
      throw new Error('Operator account context changed');
    if (gatewayInfo?.sessionAuthenticated)
      return accountContext.multiOperator
        ? { 'X-TAK-Storage-Scope': accountContext.storageScope }
        : {};
    if (gatewayInfo?.bootstrapAllowed) {
      if (!mapBootstrap || Date.now() - mapBootstrapAt > 30_000) {
        mapBootstrapAt = Date.now();
        mapBootstrap = fetchGatewaySession(globalThis.fetch, signal).catch(
          (error) => {
            mapBootstrap = null;
            throw error;
          },
        );
      }
      return { Authorization: `Bearer ${(await mapBootstrap).token}` };
    }
    const token = document.querySelector('[data-tak-token]')?.value.trim();
    if (!token)
      throw new Error(
        'Sign in to the private server, or enter the configured local gateway token in Network',
      );
    return { Authorization: `Bearer ${token}` };
  }
  function markSessionExpired() {
    if (gatewayInfo?.sessionAuthenticated) {
      gatewayInfo = { ...gatewayInfo, sessionExpired: true };
      renderScene();
    }
  }
  const savedMaps = mapStackController
    ? createSavedMaps({
        container: document.getElementById('tak-web-panel'),
        controller: mapStackController,
        viewer,
        getMapCenter: () => mapCenter(viewer),
        markPrivate: () => markTakDataPrivate(viewer),
        onSessionExpired: markSessionExpired,
        navigate,
        getAccessHeaders: takAccessHeaders,
      })
    : null;
  const offlineRoads = createOfflineRoadsPanel({
    container: document.getElementById('tak-web-panel'),
    getAccessHeaders: takAccessHeaders,
    openStore: () => openCurrentRoadPackStore(),
    engine: offlineRouting,
    async saveOfflineApp(onProgress) {
      const saved = await shellMessage('GEV_SHELL_SAVE', onProgress);
      activateOfflineOperatorContext();
      return saved;
    },
    onSessionExpired: markSessionExpired,
  });

  function retire({ revokeOffline = false, redirect } = {}) {
    if (retired) return;
    retired = true;
    expiredRedirected = true;
    controller.abort();
    geolocation.stop();
    client.disconnect();
    client.clearPrivateState();
    authorizeTakDisclosure(viewer, false);
    // Installed packs are public OSM roads and stay; the decoded copy is freed.
    offlineRouting.unload();
    panel.clearPrivateInputs();
    navigation?.clearPrivateInputs();
    packages?.clearPrivateInputs();
    drawings?.clearPrivateInputs();
    overlay.render([], client.store.isStale);
    client.destroy({ forgetIdentity: true });
    gatewayInfo = {
      enabled: false,
      reopenRequired: true,
      reason: 'Operator page retired. Reopen or sign in to continue',
    };
    panel.render();
    if (revokeOffline) clearOfflineOperatorContext();
    if (redirect) window.location.replace(redirect);
  }
  const renderScene = () => {
    if (
      (client.link().sessionExpired || gatewayInfo?.sessionExpired) &&
      !expiredRedirected &&
      !controller.signal.aborted
    ) {
      retire({ revokeOffline: true, redirect: '/login' });
      return;
    }
    if (client.store.count() || client.store.chats().length || client.fix())
      markTakDataPrivate(viewer);
    overlay.render(client.store.list(), client.store.isStale);
  };
  const unsubscribe = client.subscribe(renderScene);
  renderScene();
  // Staleness changes with time, not events: repaint fades periodically.
  const staleTimer = setInterval(() => {
    if (!client.store.count()) return;
    renderScene();
    panel.render();
  }, 15_000);
  const unsubscribePrivacy = subscribeTakPrivacy(viewer, () => panel.render());
  const unsubscribeMobile = mobile.subscribe(() => {
    client.refreshPositionAvailability();
    panel.render();
  });
  const positionTimer = setInterval(() => {
    client.refreshPositionAvailability();
    if (client.fix() && !document.hidden) panel.render();
  }, 1000);

  const unsubscribeAccount = subscribeOperatorContextInvalidation(() =>
    retire({ redirect: '/' }),
  );
  gatewayReady = Promise.resolve(gatewayInfo).then(() => panel.render());

  const emconControl = embedded
    ? null
    : mountEmconControl({
        host: document.querySelector('.tak-web-root'),
        state: emconState,
        syncWorker: syncEmconWorker,
      });

  const api = Object.freeze({
    client,
    overlay,
    savedMaps,
    navigation,
    packages,
    drawings,
    picture,
    privacy: () => takPrivacyState(viewer),
    operatorContext: () => ({ ...accountContext, retired }),
    destroy() {
      stopEmconWatch();
      emconControl?.destroy();
      controller.abort();
      logoutController?.abort();
      unsubscribeAccount();
      clearInterval(staleTimer);
      clearInterval(positionTimer);
      unsubscribe();
      unsubscribePrivacy();
      unsubscribeMobile();
      mobile.destroy();
      geolocation.destroy();
      savedMaps?.destroy();
      offlineRoads.destroy();
      navigation.destroy();
      packages.destroy();
      drawings.destroy();
      picture?.destroy();
      mapBootstrap = null;
      panel.destroy();
      overlay.destroy();
      client.destroy();
    },
  });
  return api;
}
