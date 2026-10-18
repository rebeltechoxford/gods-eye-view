// What the FIS-B layer draws and says, as plain data (no Cesium).

import { FISB_CATEGORY_COLORS, FISB_REPORT_COLORS } from './policy.js';

const LINE = 64;
const MAX_LINES = 12;

/** Wrap report text into card lines. */
export function cardLines(text, maxLines = MAX_LINES) {
  const lines = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    let rest = paragraph.replace(/\s+/g, ' ').trim();
    while (rest) {
      if (rest.length <= LINE) {
        lines.push(rest);
        break;
      }
      const cut = rest.lastIndexOf(' ', LINE);
      const at = cut > LINE / 2 ? cut : LINE;
      lines.push(rest.slice(0, at));
      rest = rest.slice(at).trim();
    }
  }
  if (lines.length > maxLines) return [...lines.slice(0, maxLines - 1), '…'];
  return lines;
}

const age = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
};

/**
 * Group positioned weather text by station: each station's METAR (with its
 * flight category), TAF, winds aloft and PIREPs.
 */
export function stationsFromTexts(texts) {
  const stations = new Map();
  for (const text of texts ?? []) {
    if (!Array.isArray(text?.position) || !text.station) continue;
    const [lon, lat] = text.position;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const key = text.kind === 'PIREP' ? `PIREP:${text.station}` : text.station;
    let station = stations.get(key);
    if (!station) {
      station = { id: key, station: text.station, lon, lat, texts: [] };
      stations.set(key, station);
    }
    station.texts.push(text);
  }
  for (const station of stations.values()) {
    const metar = station.texts.find((text) => text.kind === 'METAR');
    station.category = metar?.category ?? null;
    station.hasMetar = Boolean(metar);
  }
  return [...stations.values()];
}

export function stationColor(station) {
  return FISB_CATEGORY_COLORS[station.category] ?? FISB_CATEGORY_COLORS.unknown;
}

export function stationCard(station, now) {
  const order = ['METAR', 'TAF', 'WINDS', 'PIREP'];
  const texts = [...station.texts].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  const newest = Math.max(...texts.map((text) => text.receivedAt || 0));
  return {
    title: [station.station, station.category].filter(Boolean).join(' · '),
    details: [
      `FIS-B · heard ${age(now - newest)}`,
      ...texts.flatMap((text) => cardLines(text.text, 6)),
    ].slice(0, 16),
    accent: stationColor(station),
  };
}

/** NOTAM-TFR text marks a temporary flight restriction. */
export function reportCategory(report) {
  if (report.productId === 8 && /^NOTAM-TFR\b/.test(report.text ?? ''))
    return 'TFR';
  return report.kind;
}

export function reportColor(report) {
  return FISB_REPORT_COLORS[reportCategory(report)] ?? '#e5e7eb';
}

/** Overlays valid at `now`: forecast G-AIRMET slices outside it are hidden. */
export function currentOverlays(report, now) {
  return (report.overlays ?? []).filter(
    (overlay) =>
      (overlay.start == null || overlay.start <= now) &&
      (overlay.stop == null || now < overlay.stop),
  );
}

const zulu = (ms) =>
  Number.isFinite(ms)
    ? `${new Date(ms).toISOString().slice(5, 16).replace('T', ' ')}Z`
    : null;

export function altitudeText(overlay) {
  const vertex = overlay.vertices?.[0];
  if (!vertex) return null;
  const ref = overlay.altitudeReference ?? '';
  if (Array.isArray(vertex)) {
    const tops = overlay.vertices.map((v) => v[2]);
    const top = Math.max(...tops);
    return top > 0 ? `up to ${top.toLocaleString('en-US')} ft ${ref}` : null;
  }
  const bottom = vertex.altBottomFt ?? 0;
  const top = vertex.altTopFt ?? 0;
  return top > 0
    ? `${bottom.toLocaleString('en-US')}–${top.toLocaleString('en-US')} ft ${ref}`
    : null;
}

export function reportCard(report, overlay, now) {
  const category = reportCategory(report);
  const validity = overlay
    ? [zulu(overlay.start), zulu(overlay.stop)].some(Boolean)
      ? `valid ${zulu(overlay.start) ?? '…'} – ${zulu(overlay.stop) ?? '…'}`
      : null
    : null;
  return {
    title: [category, report.station || overlay?.label]
      .filter(Boolean)
      .join(' · '),
    details: [
      `FIS-B ${report.kind} · heard ${age(now - (report.receivedAt || now))}`,
      ...(overlay ? [altitudeText(overlay), validity].filter(Boolean) : []),
      ...(report.text ? cardLines(report.text, 10) : ['No text received yet']),
    ].slice(0, 16),
    accent: reportColor(report),
  };
}

/** One-line status for the layer row. */
export function fisbStatusText(picture, radar) {
  if (!picture) return 'Waiting for the host';
  const feeds = picture.feeds ?? [];
  const live = feeds.filter((feed) => feed.status === 'live').length;
  if (!live) {
    if (feeds.some((feed) => feed.status === 'quiet'))
      return 'Receiver connected · no FIS-B heard (no ground station in range?)';
    return 'Receiver not reachable';
  }
  const metars = (picture.texts ?? []).filter(
    (text) => text.kind === 'METAR',
  ).length;
  const reports = (picture.reports ?? []).length;
  const radarBlocks =
    (radar?.[63]?.blocks?.length ?? 0) + (radar?.[64]?.blocks?.length ?? 0);
  const stations = picture.stations?.length ?? 0;
  return [
    stations ? `${stations} ground station${stations === 1 ? '' : 's'}` : null,
    `${metars} METARs`,
    `${reports} NOTAM/AIRMET/SIGMET`,
    radarBlocks ? 'NEXRAD' : 'no precipitation',
  ]
    .filter(Boolean)
    .join(' · ');
}
