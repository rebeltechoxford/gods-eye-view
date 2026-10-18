// FIS-B Weather layer constants.

export const FISB_LAYER_ID = 'fisb';
export const FISB_LAYER_NAME = 'FIS-B Weather';
export const FISB_LAYER_SOURCE = '978 MHz UAT · your receiver';
export const FISB_URL = '/api/fisb';
export const FISB_RADAR_URL = '/api/fisb/radar';
/** The host's picture changes every few seconds; the map refreshes this often. */
export const FISB_REFRESH_MS = 30_000;
export const FISB_REQUEST_TIMEOUT_MS = 10_000;
export const FISB_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** FAA flight category colors (the convention of most EFBs). */
export const FISB_CATEGORY_COLORS = Object.freeze({
  VFR: '#22c55e',
  MVFR: '#3b82f6',
  IFR: '#ef4444',
  LIFR: '#d946ef',
  unknown: '#9ca3af',
});

export const FISB_REPORT_COLORS = Object.freeze({
  TFR: '#ff3b30',
  NOTAM: '#f5f5f5',
  'NOTAM TRA': '#ff7a45',
  'NOTAM TMOA': '#ff7a45',
  AIRMET: '#facc15',
  'G-AIRMET': '#fbbf24',
  SIGMET: '#fb923c',
  CWA: '#f97316',
  'SUA status': '#a78bfa',
});

/** NEXRAD intensity (GDL 90 ICD table 20) to RGBA; 0 and 1 are background. */
export const FISB_RADAR_COLORS = Object.freeze([
  null,
  null,
  [0, 200, 0, 170], // 20–30 dBZ
  [0, 140, 0, 190], // 30–40
  [255, 230, 0, 200], // 40–45
  [255, 140, 0, 210], // 45–50
  [230, 0, 0, 220], // 50–55
  [200, 0, 200, 230], // 55+
]);
