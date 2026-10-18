#!/usr/bin/env node
// Deterministic synthetic road graph for the offline-roads and EMCON gates.
// No download, OSM extract, real road claim, credential or provider is used.
// Usage: node scripts/qa-road-pack-fixture.mjs --out <new fixture directory>
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { syntheticPack } from '../src/testSupport/roadGraph.mjs';
import {
  decodeRoadPack,
  encodeRoadPack,
  roadPackString,
} from '../src/routing/roadPack.js';
import { validateRoadPackManifest } from '../src/routing/packManifest.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out' || !args[1])
  throw new Error('Usage: --out <new fixture directory>');
const root = path.resolve(args[1]);
// Deliberately fail if the output directory already exists; never replace packs.
await mkdir(root);
const name = 'SYNTHETIC QA ONLY — not actual roads';
const builtAt = '2026-10-18T00:00:00.000Z';
const attribution = 'Synthetic QA graph; not actual OpenStreetMap road data';
const graph = decodeRoadPack(
  syntheticPack({
    name,
    vertices: [
      [34.3664, -89.5193],
      [34.3664, -89.1],
      [34.2576, -89.1],
      [34.2576, -88.7034],
    ],
    edges: [
      { from: 0, to: 1, road: { name: 'Synthetic QA West' } },
      { from: 1, to: 2, road: { name: 'Synthetic QA South' } },
      { from: 2, to: 3, road: { name: 'Synthetic QA East' } },
    ],
  }),
);
const bytes = encodeRoadPack({
  ...graph,
  strings: Array.from({ length: graph.counts.strings }, (_, i) =>
    roadPackString(graph, i),
  ),
  metadata: {
    name,
    profile: 'car',
    source: { name: 'Synthetic test fixture', edition: null },
    license: 'CC0-1.0',
    attribution,
    builtAt,
  },
});
const manifest = validateRoadPackManifest({
  manifestVersion: 1,
  id: '758df534-8e7b-4a11-87fe-ea3b991db970',
  file: 'synthetic-qa.gevroads',
  name,
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  profile: 'car',
  bounds: graph.bounds,
  edition: null,
  builtAt,
  license: 'CC0-1.0',
  attribution,
});
await writeFile(path.join(root, manifest.file), bytes, { flag: 'wx' });
await writeFile(
  path.join(root, `${manifest.file}.json`),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { flag: 'wx' },
);
console.log(
  `Synthetic road fixture: ${bytes.length} bytes, SHA-256 ${manifest.sha256}`,
);
