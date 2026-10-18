// Compose FIS-B NEXRAD blocks into one RGBA image over their bounding box.
// CONUS (product 64) draws first and regional (63) over it, where the
// regional product has finer bins.

import { blockBounds } from '../../sources/fisb/decode.js';
import { FISB_RADAR_COLORS } from './policy.js';

const MAX_SIDE = 4096;
const ROWS = 4;
const COLUMNS = 32;

/**
 * @param {Array<{blocks:Array<[number, number, number, string]>}|null>} products
 *   Radar responses in drawing order (CONUS, then regional).
 * @returns {{west:number, south:number, east:number, north:number,
 *   width:number, height:number, rgba:Uint8ClampedArray}|null} null when no
 *   block has precipitation.
 */
export function composeRadar(products) {
  const blocks = [];
  for (const product of products)
    for (const entry of product?.blocks ?? []) {
      const [number, scale, south, bins] = entry;
      if (typeof bins !== 'string' || bins.length !== ROWS * COLUMNS) continue;
      blocks.push({ bounds: blockBounds(number, scale, south === 1), bins });
    }
  if (!blocks.length) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  let binLon = Infinity;
  let binLat = Infinity;
  for (const { bounds } of blocks) {
    west = Math.min(west, bounds.west);
    south = Math.min(south, bounds.south);
    east = Math.max(east, bounds.east);
    north = Math.max(north, bounds.north);
    binLon = Math.min(binLon, (bounds.east - bounds.west) / COLUMNS);
    binLat = Math.min(binLat, (bounds.north - bounds.south) / ROWS);
  }
  // The finest bin sets the resolution, unless that exceeds the texture limit.
  const width = Math.max(
    1,
    Math.min(MAX_SIDE, Math.round((east - west) / binLon)),
  );
  const height = Math.max(
    1,
    Math.min(MAX_SIDE, Math.round((north - south) / binLat)),
  );
  const rgba = new Uint8ClampedArray(width * height * 4);
  const xOf = (lon) => Math.round(((lon - west) / (east - west)) * width);
  const yOf = (lat) => Math.round(((north - lat) / (north - south)) * height);
  for (const { bounds, bins } of blocks) {
    const cellLon = (bounds.east - bounds.west) / COLUMNS;
    const cellLat = (bounds.north - bounds.south) / ROWS;
    for (let row = 0; row < ROWS; row++) {
      const y0 = yOf(bounds.north - row * cellLat);
      const y1 = Math.max(y0 + 1, yOf(bounds.north - (row + 1) * cellLat));
      for (let column = 0; column < COLUMNS; column++) {
        const color =
          FISB_RADAR_COLORS[bins.charCodeAt(row * COLUMNS + column) - 48];
        const x0 = xOf(bounds.west + column * cellLon);
        const x1 = Math.max(x0 + 1, xOf(bounds.west + (column + 1) * cellLon));
        for (let y = Math.max(0, y0); y < Math.min(height, y1); y++)
          for (let x = Math.max(0, x0); x < Math.min(width, x1); x++) {
            const at = (y * width + x) * 4;
            if (color) rgba.set(color, at);
            // Background bins of a finer product clear what is under them.
            else rgba.fill(0, at, at + 4);
          }
      }
    }
  }
  return { west, south, east, north, width, height, rgba };
}
