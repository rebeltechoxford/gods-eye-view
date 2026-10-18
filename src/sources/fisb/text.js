// FIS-B text: classify a report (METAR, TAF, winds aloft, PIREP, NOTAM,
// AIRMET, SIGMET, CWA, SUA) and derive a METAR's flight category.

const PATTERNS = [
  {
    kind: 'METAR',
    re: /^(METAR|SPECI) ([0-9A-Z]{3,4}) (\d{6})Z/,
    fields: (m) => ({ subtype: m[1], station: m[2], issued: m[3] }),
  },
  {
    kind: 'TAF',
    re: /^(TAF(?:\.AMD|\.COR| AMD| COR)?) ([0-9A-Z]{3,4}) (?:(\d{6})Z )?/,
    fields: (m) => ({ subtype: m[1], station: m[2], issued: m[3] ?? null }),
  },
  {
    kind: 'WINDS',
    re: /^WINDS ([0-9A-Z]{3,4}) (\d{6})Z/,
    fields: (m) => ({ subtype: null, station: m[1], issued: m[2] }),
  },
  {
    // The first location after PIREP is made up by the uplink producer from
    // the /OV field; the reporting station follows the time.
    kind: 'PIREP',
    re: /^PIREP \S+ (\d{6})Z (\S+) (UUA|UA)\b/,
    fields: (m) => ({ subtype: m[3], station: m[2], issued: m[1] }),
  },
  {
    kind: 'NOTAM',
    re: /^NOTAM-(\S+) ([0-9A-Z]{3,4})[.\s]\S*\s?(\d{6})Z?/,
    fields: (m) => ({ subtype: m[1], station: m[2], issued: m[3] }),
  },
  {
    kind: 'AIRMET',
    re: /^AIRMET (\S+) (\d{6})/,
    fields: (m) => ({ subtype: null, station: m[1], issued: m[2] }),
  },
  {
    kind: 'SIGMET',
    re: /^(?:CONVECTIVE )?SIGMET (\S+) (\d{6})/,
    fields: (m) => ({ subtype: null, station: m[1], issued: m[2] }),
  },
  {
    kind: 'CWA',
    re: /^CWA (\S+) (\d{6})/,
    fields: (m) => ({ subtype: null, station: m[1], issued: m[2] }),
  },
  {
    kind: 'SUA',
    re: /^SUA (\d{6})/,
    fields: (m) => ({ subtype: null, station: null, issued: m[1] }),
  },
];

/**
 * @param {string} text Decoded report text.
 * @returns {{kind:string, subtype:string|null, station:string|null, issued:string|null}}
 */
export function classifyFisbText(text) {
  const value = String(text ?? '').trimStart();
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(value);
    if (match) return { kind: pattern.kind, ...pattern.fields(match) };
  }
  return { kind: 'OTHER', subtype: null, station: null, issued: null };
}

function visibilityMiles(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const match = /^([PM])?(\d+)?(?:\/(\d+))?SM$/.exec(token);
    if (!match || !match[2]) continue;
    let miles = match[3]
      ? Number(match[2]) / Number(match[3])
      : Number(match[2]);
    // "1 1/2SM": a whole number in the token before.
    if (match[3] && /^\d+$/.test(tokens[i - 1] || ''))
      miles += Number(tokens[i - 1]);
    if (match[1] === 'P') miles += 0.01;
    return miles;
  }
  return null;
}

function ceilingFeet(tokens) {
  let ceiling = null;
  for (const token of tokens) {
    const match = /^(BKN|OVC|VV)(\d{3})/.exec(token);
    if (!match) continue;
    const feet = Number(match[2]) * 100;
    if (ceiling === null || feet < ceiling) ceiling = feet;
  }
  return ceiling;
}

/**
 * FAA flight category from a METAR's prevailing visibility and ceiling (the
 * lowest broken, overcast or vertical-visibility layer).
 * @param {string} metar
 * @returns {'VFR'|'MVFR'|'IFR'|'LIFR'|null} null when neither is reported.
 */
export function flightCategory(metar) {
  // Remarks can repeat cloud groups; only the body counts.
  const body = String(metar ?? '').split(/\sRMK\s/)[0];
  const tokens = body.split(/\s+/);
  const visibility = visibilityMiles(tokens);
  const ceiling = ceilingFeet(tokens);
  const clear = tokens.some((t) => /^(CLR|SKC|NSC|NCD)$/.test(t));
  if (visibility === null && ceiling === null && !clear) return null;
  const vis = visibility ?? Infinity;
  const ceil = ceiling ?? Infinity;
  if (ceil < 500 || vis < 1) return 'LIFR';
  if (ceil < 1000 || vis < 3) return 'IFR';
  if (ceil <= 3000 || vis <= 5) return 'MVFR';
  return 'VFR';
}
