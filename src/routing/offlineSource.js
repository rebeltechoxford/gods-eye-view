// Offline-first Directions source. Driving trips inside an installed road
// pack route on the device: no network, and no third-party router sees the
// trip. Other trips use the existing online source. When the network is down
// the error says how to get offline routing instead of a bare fetch failure.

/** Profiles the offline road packs can route. */
export const OFFLINE_ROUTE_MODES = Object.freeze(['car']);

function unreachable(mode) {
  return OFFLINE_ROUTE_MODES.includes(mode)
    ? 'Routing is unreachable offline. Install an offline road pack covering this trip (TAK → OFFLINE ROADS).'
    : 'Routing is unreachable offline. Offline road packs cover driving only.';
}

/**
 * @param {object} options
 * @param {{getRoute:Function}} options.online The existing route source.
 * @param {{route:Function}} [options.offline] An offline route engine.
 */
export function createOfflineFirstDirectionsSource({ online, offline = null }) {
  if (typeof online?.getRoute !== 'function')
    throw new TypeError('An online route source is required');
  return {
    async getRoute(request, options = {}) {
      const { signal } = options;
      if (offline && OFFLINE_ROUTE_MODES.includes(request.mode)) {
        // Only an explicit "no covering pack" may use the online source.
        // A damaged pack, unavailable route or worker failure must not send
        // coordinates that the operator expected to remain on this device.
        const payload = await offline.route(request, { signal });
        if (payload) return payload;
      }
      try {
        return await online.getRoute(request, options);
      } catch (error) {
        if (signal?.aborted) throw error;
        // The browser's fetch reports an unreachable network as a TypeError.
        const network = error instanceof TypeError;
        throw network ? new Error(unreachable(request.mode)) : error;
      }
    },
  };
}
