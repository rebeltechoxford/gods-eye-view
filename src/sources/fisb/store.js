// FIS-B picture: decoded uplinks folded into the current set of weather text,
// NOTAM/AIRMET/SIGMET reports with their geometry, and NEXRAD radar blocks.
//
// FIS-B rebroadcasts every product on a cycle (METARs about every 5 min,
// regional NEXRAD every 2.5 min, NOTAMs about every 10 min). An item is kept
// until it has not been heard for its product's retention time, or until a
// cancellation arrives. Every collection is capped so a noisy or hostile
// uplink cannot grow memory without bound.

import {
  BLOCK_PRODUCTS,
  FRAME_APDU,
  FRAME_CRL,
  FRAME_SERVICE_STATUS,
  TEXT_PRODUCT,
  TWGO_PRODUCTS,
  blockBounds,
  decodeApduHeader,
  decodeCrl,
  decodeGlobalBlock,
  decodeTwgo,
  decodeUplinkHeader,
  dlacText,
  infoFrames,
  parseRawLine,
} from './decode.js';
import { classifyFisbText, flightCategory } from './text.js';

const MINUTE = 60_000;

/** How long an item is kept after it was last heard. */
export const FISB_RETENTION_MS = Object.freeze({
  METAR: 2 * 60 * MINUTE,
  TAF: 8 * 60 * MINUTE,
  WINDS: 12 * 60 * MINUTE,
  PIREP: 90 * MINUTE,
  OTHER: 60 * MINUTE,
  report: 45 * MINUTE,
  radar63: 20 * MINUTE,
  radar64: 45 * MINUTE,
  station: 10 * MINUTE,
  segment: 20 * MINUTE,
});

export const FISB_LIMITS = Object.freeze({
  texts: 6000,
  pireps: 600,
  reports: 3000,
  overlaysPerReport: 16,
  verticesPerOverlay: 64,
  segments: 64,
  segmentParts: 64,
  radarBlocks: 30000,
  stations: 32,
});

/** Product names for the operator. */
export const FISB_PRODUCT_NAMES = Object.freeze({
  8: 'NOTAM',
  11: 'AIRMET',
  12: 'SIGMET',
  13: 'SUA status',
  14: 'G-AIRMET',
  15: 'CWA',
  16: 'NOTAM TRA',
  17: 'NOTAM TMOA',
  63: 'NEXRAD regional',
  64: 'NEXRAD CONUS',
  70: 'Icing low',
  71: 'Icing high',
  84: 'Cloud tops',
  90: 'Turbulence low',
  91: 'Turbulence high',
  103: 'Lightning',
  413: 'Text weather',
});

const RADAR_PRODUCTS = [63, 64];
const CANCELLED_OBJECT = 13;

function setCapped(map, key, value, cap) {
  if (!map.has(key) && map.size >= cap) {
    // Drop the oldest entry (Maps keep insertion order).
    map.delete(map.keys().next().value);
  }
  map.delete(key);
  map.set(key, value);
}

/**
 * Resolve an overlay time (month/day/hour/minute, any subset) to epoch ms near
 * `now`, assuming UTC and the nearest year.
 */
export function resolveOverlayTime(time, now) {
  if (!time || !Number.isInteger(time.hour) || !Number.isInteger(time.minute))
    return null;
  const reference = new Date(now);
  const month = Number.isInteger(time.month)
    ? time.month - 1
    : reference.getUTCMonth();
  const day = Number.isInteger(time.day) ? time.day : reference.getUTCDate();
  if (
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31 ||
    time.hour > 23 ||
    time.minute > 59
  )
    return null;
  let best = null;
  for (const year of [
    reference.getUTCFullYear() - 1,
    reference.getUTCFullYear(),
    reference.getUTCFullYear() + 1,
  ]) {
    const at = Date.UTC(year, month, day, time.hour, time.minute);
    if (best === null || Math.abs(at - now) < Math.abs(best - now)) best = at;
  }
  return best;
}

const round5 = (value) => Math.round(value * 1e5) / 1e5;

/** Overlay for JSON: `[lon, lat, altFt]` vertices; circles keep their fields. */
function compactOverlay(overlay) {
  return {
    ...overlay,
    vertices: overlay.vertices.map((vertex) =>
      overlay.shape === 'circle'
        ? {
            lon: round5(vertex.lon),
            lat: round5(vertex.lat),
            radiusNm: vertex.radiusBottomNm,
            altBottomFt: vertex.altBottomFt,
            altTopFt: vertex.altTopFt,
          }
        : [round5(vertex.lon), round5(vertex.lat), vertex.altFt],
    ),
  };
}

/** 128 intensities as a string of digits 0–7. */
function binDigits(bins) {
  return Array.from(bins, (bin) => String(bin & 7)).join('');
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]
 */
export function createFisbStore({ now = Date.now } = {}) {
  const stations = new Map();
  const texts = new Map();
  const pireps = new Map();
  const reports = new Map();
  const segments = new Map();
  const radar = new Map(RADAR_PRODUCTS.map((id) => [id, new Map()]));
  const radarTime = new Map();
  const counts = {
    uplinks: 0,
    frames: 0,
    decodeErrors: 0,
    byProduct: {},
    crl: 0,
    serviceStatus: 0,
    lastUplinkAt: null,
  };
  let revision = 0;
  let radarRevision = 0;

  const countProduct = (productId) => {
    counts.byProduct[productId] = (counts.byProduct[productId] || 0) + 1;
  };

  function ingestText(text, at) {
    const info = classifyFisbText(text);
    const entry = { ...info, text, receivedAt: at };
    if (info.kind === 'METAR') entry.category = flightCategory(text);
    if (info.kind === 'PIREP') {
      setCapped(
        pireps,
        `${info.station}|${info.issued}|${text}`,
        entry,
        FISB_LIMITS.pireps,
      );
      return;
    }
    if (!info.station) return;
    setCapped(texts, `${info.kind}|${info.station}`, entry, FISB_LIMITS.texts);
  }

  function reportFor(productId, record, location, at) {
    const key = `${productId}|${record.reportYear}|${record.reportNumber}|${location}`;
    let report = reports.get(key);
    if (!report) {
      report = {
        key,
        productId,
        reportNumber: record.reportNumber,
        reportYear: record.reportYear,
        location,
        text: null,
        kind: FISB_PRODUCT_NAMES[productId] ?? `Product ${productId}`,
        subtype: null,
        station: location || null,
        overlays: new Map(),
        receivedAt: at,
      };
    }
    report.receivedAt = at;
    setCapped(reports, key, report, FISB_LIMITS.reports);
    return report;
  }

  function ingestTwgo(productId, payload, at) {
    const twgo = decodeTwgo(productId, payload);
    for (const record of twgo.records) {
      const key = `${productId}|${record.reportYear}|${record.reportNumber}|${twgo.location}`;
      if (twgo.recordFormat === 2) {
        if (!record.active) {
          reports.delete(key);
          continue;
        }
        const report = reportFor(productId, record, twgo.location, at);
        // An empty active text renews the report (NOTAM-TFR does this).
        if (record.text.trim()) {
          report.text = record.text;
          const info = classifyFisbText(record.text);
          if (info.kind !== 'OTHER') {
            report.subtype = info.subtype;
            report.station = info.station ?? report.station;
            report.issued = info.issued;
          }
        }
      } else if (twgo.recordFormat === 8) {
        if (record.objectStatus === CANCELLED_OBJECT) {
          reports.delete(key);
          continue;
        }
        const report = reportFor(productId, record, twgo.location, at);
        const overlay = {
          id: record.overlayRecordId,
          shape: record.shape,
          altitudeReference: record.altitudeReference,
          label: record.label,
          objectType: record.objectType,
          objectElement: record.objectElement,
          start: resolveOverlayTime(record.start, at),
          stop: resolveOverlayTime(record.stop, at),
          vertices: record.vertices.slice(0, FISB_LIMITS.verticesPerOverlay),
        };
        setCapped(
          report.overlays,
          overlay.id,
          overlay,
          FISB_LIMITS.overlaysPerReport,
        );
      }
    }
  }

  function ingestSegment(header, payload, at) {
    const { productId, productFileId, productFileLength, apduNumber } = header;
    if (
      productFileLength < 1 ||
      productFileLength > FISB_LIMITS.segmentParts ||
      apduNumber < 1 ||
      apduNumber > productFileLength
    )
      throw new RangeError('segment numbering out of range');
    const key = `${productId}|${productFileId}`;
    let file = segments.get(key);
    if (!file || file.length !== productFileLength) {
      file = {
        length: productFileLength,
        parts: Array.from({ length: productFileLength }, () => null),
        firstAt: at,
      };
      setCapped(segments, key, file, FISB_LIMITS.segments);
    }
    file.parts[apduNumber - 1] = payload.slice();
    if (file.parts.some((part) => !part)) return null;
    segments.delete(key);
    // Every segment after the first repeats the 6-byte TWGO product header.
    const pieces = file.parts.map((part, i) => (i ? part.subarray(6) : part));
    const total = pieces.reduce((sum, part) => sum + part.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of pieces) {
      joined.set(part, offset);
      offset += part.length;
    }
    return joined;
  }

  function ingestBlock(productId, header, payload, at) {
    const block = decodeGlobalBlock(productId, payload);
    const blocks = radar.get(productId);
    if (!blocks) return;
    radarTime.set(productId, {
      hour: header.hour,
      minute: header.minute,
      receivedAt: at,
    });
    if (block.elementId === 0) {
      for (const number of block.emptyBlocks)
        if (blocks.has(number)) blocks.delete(number);
    } else if (block.bins) {
      const peak = block.bins.reduce((max, bin) => (bin > max ? bin : max), 0);
      // Intensities 0 and 1 are background; only precipitation is kept.
      if (peak < 2) blocks.delete(block.blockNumber);
      else
        setCapped(
          blocks,
          block.blockNumber,
          { scale: block.scale, south: block.south, bins: block.bins, at },
          FISB_LIMITS.radarBlocks,
        );
    }
    radarRevision++;
  }

  function ingestApdu(data, at) {
    const header = decodeApduHeader(data);
    let payload = data.subarray(header.payloadOffset);
    countProduct(header.productId);
    if (header.s) {
      if (!TWGO_PRODUCTS.includes(header.productId)) return;
      payload = ingestSegment(header, payload, at);
      if (!payload) return;
    }
    if (header.productId === TEXT_PRODUCT) ingestText(dlacText(payload), at);
    else if (TWGO_PRODUCTS.includes(header.productId))
      ingestTwgo(header.productId, payload, at);
    else if (BLOCK_PRODUCTS.includes(header.productId))
      ingestBlock(header.productId, header, payload, at);
  }

  /**
   * Fold one 432-byte uplink into the picture.
   * @param {Uint8Array} uplink
   * @param {number} [at] Receive time, epoch ms.
   * @returns {{frames:number, errors:number}}
   */
  function ingestUplink(uplink, at = now()) {
    counts.uplinks++;
    counts.lastUplinkAt = at;
    let frames = 0;
    let errors = 0;
    let header;
    try {
      header = decodeUplinkHeader(uplink);
    } catch {
      counts.decodeErrors++;
      return { frames, errors: 1 };
    }
    if (header.positionValid) {
      const key = `${header.lat.toFixed(4)},${header.lon.toFixed(4)}`;
      const station = stations.get(key) || {
        lat: header.lat,
        lon: header.lon,
        uplinks: 0,
      };
      station.uplinks++;
      station.lastHeard = at;
      station.tisbSiteId = header.tisbSiteId;
      setCapped(stations, key, station, FISB_LIMITS.stations);
    }
    if (!header.appDataValid) return { frames, errors };
    for (const frame of infoFrames(uplink)) {
      if (frame.error) {
        errors++;
        continue;
      }
      frames++;
      try {
        if (frame.type === FRAME_APDU) ingestApdu(frame.data, at);
        else if (frame.type === FRAME_CRL) {
          decodeCrl(frame.data);
          counts.crl++;
        } else if (frame.type === FRAME_SERVICE_STATUS) counts.serviceStatus++;
      } catch {
        errors++;
      }
    }
    counts.frames += frames;
    counts.decodeErrors += errors;
    revision++;
    return { frames, errors };
  }

  /** Fold one dump978-fa raw line; non-uplink lines are ignored. */
  function ingestRawLine(line, at = now()) {
    const parsed = parseRawLine(line);
    if (!parsed) return null;
    return ingestUplink(parsed.bytes, at);
  }

  /** Drop everything not heard within its retention time. */
  function prune(at = now()) {
    const expired = (time, retention) => at - time > retention;
    for (const [key, station] of stations)
      if (expired(station.lastHeard, FISB_RETENTION_MS.station))
        stations.delete(key);
    for (const [key, entry] of texts)
      if (
        expired(
          entry.receivedAt,
          FISB_RETENTION_MS[entry.kind] ?? FISB_RETENTION_MS.OTHER,
        )
      )
        texts.delete(key);
    for (const [key, entry] of pireps)
      if (expired(entry.receivedAt, FISB_RETENTION_MS.PIREP))
        pireps.delete(key);
    for (const [key, report] of reports) {
      if (expired(report.receivedAt, FISB_RETENTION_MS.report)) {
        reports.delete(key);
        continue;
      }
      for (const [id, overlay] of report.overlays)
        if (overlay.stop !== null && overlay.stop < at)
          report.overlays.delete(id);
    }
    for (const [key, file] of segments)
      if (expired(file.firstAt, FISB_RETENTION_MS.segment))
        segments.delete(key);
    for (const productId of RADAR_PRODUCTS) {
      const retention = FISB_RETENTION_MS[`radar${productId}`];
      for (const [number, block] of radar.get(productId))
        if (expired(block.at, retention)) {
          radar.get(productId).delete(number);
          radarRevision++;
        }
    }
  }

  /** The current picture as plain JSON (radar blocks excluded). */
  function snapshot(at = now()) {
    prune(at);
    const list = [...stations.values()].sort(
      (a, b) => b.lastHeard - a.lastHeard,
    );
    return {
      revision,
      station: list[0] ? { ...list[0] } : null,
      stations: list.map((station) => ({ ...station })),
      counts: { ...counts, byProduct: { ...counts.byProduct } },
      texts: [...texts.values(), ...pireps.values()].map((entry) => ({
        ...entry,
      })),
      reports: [...reports.values()].map((report) => ({
        id: report.key,
        productId: report.productId,
        kind: report.kind,
        subtype: report.subtype,
        station: report.station,
        reportNumber: report.reportNumber,
        text: report.text,
        receivedAt: report.receivedAt,
        overlays: [...report.overlays.values()].map(compactOverlay),
      })),
      radar: Object.fromEntries(
        RADAR_PRODUCTS.map((productId) => [
          productId,
          {
            blocks: radar.get(productId).size,
            time: radarTime.get(productId) ?? null,
          },
        ]),
      ),
      radarRevision,
    };
  }

  /**
   * Radar blocks with precipitation: `[blockNumber, scale, south, bins]`,
   * where `bins` is 128 intensity digits (4 rows of 32, north row first,
   * west to east).
   * @param {63|64} productId
   */
  function radarBlocks(productId, at = now()) {
    prune(at);
    const blocks = radar.get(productId);
    if (!blocks) return null;
    return {
      productId,
      revision: radarRevision,
      time: radarTime.get(productId) ?? null,
      blocks: [...blocks.entries()].map(([number, block]) => [
        number,
        block.scale,
        block.south ? 1 : 0,
        binDigits(block.bins),
      ]),
    };
  }

  return { ingestUplink, ingestRawLine, prune, snapshot, radarBlocks };
}

export { blockBounds };
