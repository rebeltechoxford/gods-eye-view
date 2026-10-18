#!/usr/bin/env node
/**
 * Build an offline car road pack from an OpenStreetMap PBF extract.
 *
 *   node scripts/build-road-pack.mjs --input mississippi-latest.osm.pbf \
 *     --name Mississippi --out mississippi.gevroads [--bbox W,S,E,N]
 *
 * Writes the pack and a sidecar manifest (<out>.json) with its SHA-256, size,
 * coverage, OSM edition and ODbL attribution. Put both in GEV_ROAD_PACK_DIR
 * on the private host; phones download them for fully offline routing.
 * Extracts must be sorted by type then ID (Geofabrik, OSM France and BBBike
 * extracts are). Output is a derived database under the ODbL.
 */
import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildRoadPackFromPbf } from '../server/routing/buildRoadPack.js';
import { ROAD_PACK_MANIFEST_VERSION } from '../server/routing/packs.js';

const argv = process.argv.slice(2);
const KNOWN = new Set(['--input', '--out', '--name', '--bbox']);
for (let i = 0; i < argv.length; i += 2)
  if (!KNOWN.has(argv[i]))
    throw new Error(
      `Unknown or malformed option ${argv[i]} (use "--option value", e.g. --bbox W,S,E,N)`,
    );
function option(name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith('--'))
    throw new Error(`${name} needs a value`);
  return value;
}

const input = option('--input');
const out = option('--out');
const name = option('--name', 'Road pack');
const bboxText = option('--bbox', null);
if (!input || !out) {
  console.error(
    'Usage: node scripts/build-road-pack.mjs --input <extract.osm.pbf> --out <name.gevroads> [--name <label>] [--bbox W,S,E,N]',
  );
  process.exit(2);
}
let bounds = null;
if (bboxText) {
  const [west, south, east, north] = bboxText.split(',').map(Number);
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west >= east ||
    south >= north
  )
    throw new Error('--bbox must be W,S,E,N in degrees');
  bounds = { west, south, east, north };
}

let lastPercent = -1;
const { bytes, metadata, stats } = await buildRoadPackFromPbf(input, {
  bounds,
  name,
  onProgress({ bytes: done, total }) {
    const percent = Math.floor((done / total) * 100);
    if (percent >= lastPercent + 10) {
      lastPercent = percent;
      console.log(`  read ${percent}%`);
    }
  },
});
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(out, bytes);
const manifest = {
  manifestVersion: ROAD_PACK_MANIFEST_VERSION,
  id: randomUUID(),
  name,
  file: path.basename(out),
  bytes: bytes.length,
  sha256,
  profile: metadata.profile,
  bounds: metadata.bounds,
  edition: metadata.source.edition,
  builtAt: metadata.builtAt,
  license: metadata.license,
  attribution: metadata.attribution,
  licenseUrl: metadata.licenseUrl,
  counts: {
    vertices: stats.vertices,
    edges: stats.edges,
    shapePoints: stats.shapePoints,
  },
};
await writeFile(`${out}.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `${name}: ${(bytes.length / 1048576).toFixed(1)} MiB, ${stats.vertices.toLocaleString()} junctions, ${stats.edges.toLocaleString()} road segments, OSM edition ${metadata.source.edition || 'unknown'}, built in ${stats.seconds.toFixed(1)} s`,
);
console.log(`SHA-256 ${sha256}`);
console.log(
  `Peak memory ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB`,
);
