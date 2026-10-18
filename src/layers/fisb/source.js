// Read the host's FIS-B picture (/api/fisb) and its NEXRAD blocks.

import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { requestWithDeadline } from '../../sources/requestDeadline.js';
import {
  FISB_MAX_RESPONSE_BYTES,
  FISB_RADAR_URL,
  FISB_REQUEST_TIMEOUT_MS,
  FISB_URL,
} from './policy.js';

/**
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createFisbSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = FISB_REQUEST_TIMEOUT_MS,
  maxBytes = FISB_MAX_RESPONSE_BYTES,
} = {}) {
  let radarRevision = null;
  let radar = { 63: null, 64: null };

  async function getJson(url, signal) {
    return requestWithDeadline(
      async (deadline) => {
        const response = await fetchImpl(url, {
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: deadline,
        });
        if (response.status === 404) return { missing: true };
        if (!response.ok)
          throw new Error(`FIS-B route answered ${response.status}`);
        return readResponseJsonCapped(response, maxBytes, deadline);
      },
      { signal, timeoutMs },
    );
  }

  /**
   * One refresh. Radar blocks are fetched only when the host's radar changed.
   * @returns {Promise<{configured:boolean, missing?:boolean, picture?:object, radar?:object}>}
   */
  async function fetchPicture({ signal } = {}) {
    const picture = await getJson(FISB_URL, signal);
    if (picture?.missing) return { configured: false, missing: true };
    if (picture?.configured !== true) return { configured: false, picture };
    if (picture.radarRevision !== radarRevision) {
      const [conus, regional] = await Promise.all(
        [64, 63].map((product) =>
          getJson(`${FISB_RADAR_URL}?product=${product}`, signal),
        ),
      );
      radar = {
        64: conus?.missing ? null : conus,
        63: regional?.missing ? null : regional,
      };
      radarRevision = picture.radarRevision;
    }
    return { configured: true, picture, radar };
  }

  return {
    fetchPicture,
    reset() {
      radarRevision = null;
      radar = { 63: null, 64: null };
    },
  };
}
