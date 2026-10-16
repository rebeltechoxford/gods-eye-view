import './tak.css';
import * as Cesium from 'cesium';
import { createTakClient } from './client.js';
import { createCotOverlay } from './cotOverlay.js';
import {
  createGatewayTransport,
  fetchGatewayStatus,
  fetchGatewaySession,
} from './transport.js';
import { createTakPanel } from './ui.js';
import { createGeolocation } from './geolocation.js';
import { createMobileSession } from './mobile.js';
import { logoutOperatorSession } from './session.js';
import { createSavedMaps } from '../maps/offline/ui.js';
import {
  authorizeTakDisclosure,
  markTakDataPrivate,
  subscribeTakPrivacy,
  takPrivacyState,
} from './privacy.js';

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
  let gatewayInfo = null;
  let gatewayReady;
  let expiredRedirected = false;
  const mobile = createMobileSession();
  const geolocation = createGeolocation();

  const client = createTakClient({
    createTransport: (handlers) => createGatewayTransport(handlers),
    storage: browserStorage,
    canReportPosition: () => !document.hidden && geolocation.isActive(),
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
    async logout() {
      await logoutOperatorSession(globalThis.fetch, controller.signal);
      window.location.replace('/login');
    },
    gatewayInfo: () => gatewayInfo,
    async connect(token, signal) {
      if (!gatewayInfo) await gatewayReady;
      if (signal.aborted || controller.signal.aborted) return false;
      if (!token && gatewayInfo?.bootstrapAllowed) {
        const session = await fetchGatewaySession(globalThis.fetch, signal);
        token = session.token;
      }
      if (signal.aborted || controller.signal.aborted) return false;
      client.connect(
        gatewayInfo?.sessionAuthenticated ? { session: true } : token,
      );
      return true;
    },
    privacy: {
      state: () => takPrivacyState(viewer),
      authorize: (enabled) => authorizeTakDisclosure(viewer, enabled),
    },
  });
  let mapBootstrap = null;
  let mapBootstrapAt = 0;
  const savedMaps = mapStackController
    ? createSavedMaps({
        container: document.getElementById('tak-web-panel'),
        controller: mapStackController,
        viewer,
        getMapCenter: () => mapCenter(viewer),
        markPrivate: () => markTakDataPrivate(viewer),
        onSessionExpired: () => {
          if (gatewayInfo?.sessionAuthenticated) {
            gatewayInfo = { ...gatewayInfo, sessionExpired: true };
            renderScene();
          }
        },
        navigate,
        async getAccessHeaders(signal) {
          if (!gatewayInfo) await gatewayReady;
          signal?.throwIfAborted();
          if (gatewayInfo?.sessionAuthenticated) return {};
          if (gatewayInfo?.bootstrapAllowed) {
            if (!mapBootstrap || Date.now() - mapBootstrapAt > 30_000) {
              mapBootstrapAt = Date.now();
              mapBootstrap = fetchGatewaySession(
                globalThis.fetch,
                signal,
              ).catch((error) => {
                mapBootstrap = null;
                throw error;
              });
            }
            return { Authorization: `Bearer ${(await mapBootstrap).token}` };
          }
          const token = document
            .querySelector('[data-tak-token]')
            ?.value.trim();
          if (!token)
            throw new Error(
              'Sign in to the private server, or enter the configured local gateway token in Network',
            );
          return { Authorization: `Bearer ${token}` };
        },
      })
    : null;

  const renderScene = () => {
    if (
      (client.link().sessionExpired || gatewayInfo?.sessionExpired) &&
      !expiredRedirected &&
      !controller.signal.aborted
    ) {
      expiredRedirected = true;
      geolocation.stop();
      client.clearPrivateState();
      authorizeTakDisclosure(viewer, false);
      panel.clearPrivateInputs();
      window.location.replace('/login');
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
  const unsubscribeMobile = mobile.subscribe(() => panel.render());
  const positionTimer = setInterval(() => {
    if (client.fix() && !document.hidden) panel.render();
  }, 1000);

  gatewayReady = fetchGatewayStatus(globalThis.fetch, controller.signal)
    .then((status) => {
      gatewayInfo = status;
      if (status.sessionExpired) renderScene();
      panel.render();
    })
    .catch(() => {
      gatewayInfo = { enabled: false, reason: 'status endpoint unreachable' };
      panel.render();
    });

  const api = Object.freeze({
    client,
    overlay,
    savedMaps,
    privacy: () => takPrivacyState(viewer),
    destroy() {
      controller.abort();
      clearInterval(staleTimer);
      clearInterval(positionTimer);
      unsubscribe();
      unsubscribePrivacy();
      unsubscribeMobile();
      mobile.destroy();
      geolocation.destroy();
      savedMaps?.destroy();
      mapBootstrap = null;
      panel.destroy();
      overlay.destroy();
      client.destroy();
    },
  });
  return api;
}
