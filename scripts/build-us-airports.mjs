#!/usr/bin/env node
/**
 * Build src/data/local_data/us_airports/us-airports.json: airport positions
 * keyed by ICAO-style identifier, used by the host to place FIS-B METARs,
 * TAFs, winds aloft and PIREPs (FIS-B text carries only a station identifier).
 *
 * Source:  OurAirports `airports.csv`, https://ourairports.com/data/
 *          (https://davidmegginson.github.io/ourairports-data/airports.csv)
 * License: public domain (The Unlicense, stated on the data page).
 *
 * Transform (deterministic):
 *   1. Keep large, medium and small airports in the US and its territories
 *      (US, PR, GU, VI, AS, MP); heliports, seaplane bases and closed fields
 *      are dropped.
 *   2. Key each by its `icao_code`, `gps_code` and `ident` when they look like
 *      a K/P/T identifier, and by `K` + `local_code` for three-character US
 *      local codes (how many small fields report weather). First key wins.
 *   3. Store `[longitude, latitude]` rounded to 4 decimals (~11 m), keys sorted.
 *
 * Usage:
 *   node scripts/build-us-airports.mjs <airports.csv> [--date YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'src/data/local_data/us_airports/us-airports.json');
const COUNTRIES = new Set(['US', 'PR', 'GU', 'VI', 'AS', 'MP']);
const TYPES = new Set(['large_airport', 'medium_airport', 'small_airport']);
const IDENT = /^[KPT][A-Z0-9]{3}$/;

/** Minimal RFC 4180 parser (quoted fields, doubled quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

export function buildAirportTable(csvText) {
  const [header, ...rows] = parseCsv(csvText);
  const at = Object.fromEntries(header.map((name, i) => [name, i]));
  const table = {};
  for (const row of rows) {
    if (!COUNTRIES.has(row[at.iso_country]) || !TYPES.has(row[at.type]))
      continue;
    const lon = Number(row[at.longitude_deg]);
    const lat = Number(row[at.latitude_deg]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const local = row[at.local_code] || '';
    const keys = [row[at.icao_code], row[at.gps_code], row[at.ident]].filter(
      (k) => IDENT.test(k || ''),
    );
    if (row[at.iso_country] === 'US' && /^[A-Z0-9]{3}$/.test(local))
      keys.push(`K${local}`);
    for (const key of keys)
      if (!table[key])
        table[key] = [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4];
  }
  return Object.fromEntries(
    Object.keys(table)
      .sort()
      .map((key) => [key, table[key]]),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: node scripts/build-us-airports.mjs <airports.csv>');
    process.exit(2);
  }
  const table = buildAirportTable(fs.readFileSync(input, 'utf8'));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(table) + '\n');
  console.log(
    `${Object.keys(table).length} airports → ${path.relative(root, OUT)}`,
  );
}
