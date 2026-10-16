/** Device fixes older than this must not become freshly dated CoT reports. */
export const GPS_FIX_MAX_AGE_MS = 30_000;

export function isGpsFixFresh(fix, nowMs = Date.now()) {
  if (!fix || fix.source !== 'GPS') return !!fix;
  return (
    Number.isFinite(fix.observedAtMs) &&
    fix.observedAtMs <= nowMs + 1_000 &&
    nowMs - fix.observedAtMs <= GPS_FIX_MAX_AGE_MS
  );
}

export function describePosition(
  fix,
  { nowMs = Date.now(), foreground = true, gpsActive = true } = {},
) {
  if (!fix) return 'No position set.';
  const coordinates = `${fix.lat.toFixed(5)}, ${fix.lon.toFixed(5)}`;
  if (fix.source !== 'GPS')
    return `${coordinates} · OPERATOR SET · not device GPS`;
  const age = Number.isFinite(fix.observedAtMs)
    ? Math.max(0, Math.floor((nowMs - fix.observedAtMs) / 1000))
    : null;
  const accuracy = Number.isFinite(fix.ce)
    ? `±${Math.ceil(fix.ce)} m reported accuracy`
    : 'accuracy unknown';
  const freshness = !foreground
    ? 'BACKGROUND · broadcast paused'
    : !gpsActive
      ? 'GPS STOPPED · broadcast paused'
      : isGpsFixFresh(fix, nowMs)
        ? 'FRESH'
        : 'STALE · broadcast paused';
  return `${coordinates} · DEVICE GPS · ${accuracy} · ${age === null ? 'age unknown' : `${age}s old`} · ${freshness}`;
}
