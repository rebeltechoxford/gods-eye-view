import * as sqlite from 'node:sqlite';
import { open } from 'node:fs/promises';
import {
  OFFLINE_LIMITS,
  OFFLINE_IMPORT_LIMITS,
  MERCATOR_LATITUDE,
  tileKey,
  validateMbtilesSelection,
  mbtilesSelectionRanges,
  importedTileBounds,
} from '../../../src/maps/offline/schema.js';
import { validateImportedRaster } from './raster-validation.js';

const Database = sqlite.Database || sqlite.DatabaseSync;
const { constants } = sqlite;
const error = (message) => {
  throw new Error(message);
};
const textBytes = (value) => new TextEncoder().encode(value).byteLength;
let next;
const send = (message) =>
  new Promise((resolve, reject) => {
    next = resolve;
    process.send(message, (problem) => {
      if (problem) reject(problem);
    });
  });
process.on('message', async (message) => {
  if (message?.op === 'next') {
    next?.();
    next = null;
    return;
  }
  if (message?.op !== 'start') return;
  let db;
  try {
    const selection =
      message.selection === undefined
        ? null
        : validateMbtilesSelection(message.selection);
    const handle = await open(message.file, 'r');
    try {
      const header = Buffer.alloc(100);
      if (
        (await handle.read(header, 0, 100, 0)).bytesRead !== 100 ||
        header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0'
      )
        error('The selected file is not a standalone SQLite MBTiles database');
      if (header[18] !== 1 || header[19] !== 1)
        error(
          'Checkpoint MBTiles to a standalone non-WAL file before importing',
        );
    } finally {
      await handle.close();
    }
    db = new Database(message.file, {
      readOnly: true,
      defensive: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    });
    // Statements are fixed; stored views remain untrusted and are restricted
    // by the authorizer, native heap bound and parent process deadline.
    db.exec(
      'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA mmap_size=0; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA hard_heap_limit=33554432;',
    );
    if (db.limits)
      Object.assign(db.limits, {
        length: OFFLINE_LIMITS.maxTileBytes + 4096,
        sqlLength: 100000,
        column: 32,
        exprDepth: 32,
        compoundSelect: 3,
        vdbeOp: 25000,
        functionArg: 8,
        attach: 0,
        likePatternLength: 50,
        variableNumber: 10,
        triggerDepth: 1,
      });
    let schemaEntries = 0;
    for (const row of db.prepare('PRAGMA main.table_list').iterate()) {
      if (++schemaEntries > 64 || ['virtual', 'shadow'].includes(row.type))
        error('Unsupported or excessive MBTiles database schema');
    }
    for (const [table, columns] of [
      ['metadata', ['name', 'value']],
      ['tiles', ['zoom_level', 'tile_column', 'tile_row', 'tile_data']],
    ]) {
      const rows = db.prepare(`PRAGMA main.table_xinfo('${table}')`).all();
      if (
        rows.length !== columns.length ||
        rows.some((row) => !columns.includes(row.name) || row.hidden)
      )
        error(`MBTiles ${table} table or view has an unsupported schema`);
    }
    // Indexed AOI reads must not trust a corrupt index that silently omits rows.
    // The stronger check remains inside the same heap/whole-process deadline.
    const checked = db
      .prepare(
        selection ? 'PRAGMA integrity_check(1)' : 'PRAGMA quick_check(1)',
      )
      .get();
    if (!checked || Object.values(checked)[0] !== 'ok')
      error('MBTiles SQLite integrity check failed');
    const functions = new Set([
      'typeof',
      'length',
      'count',
      'min',
      'max',
      'ifnull',
      'coalesce',
      'hex',
      'lower',
      'upper',
      'substr',
    ]);
    db.setAuthorizer((action, first, second, database) => {
      if (action === constants.SQLITE_SELECT) return constants.SQLITE_OK;
      if (action === constants.SQLITE_READ && database === 'main')
        return constants.SQLITE_OK;
      if (action === constants.SQLITE_FUNCTION && functions.has(second))
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    });
    const metadata = [],
      names = new Set(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    for (const row of db
      .prepare(
        'SELECT CAST(name AS BLOB) AS n, CAST(value AS BLOB) AS v, typeof(name) AS nt, typeof(value) AS vt FROM metadata LIMIT 65',
      )
      .iterate()) {
      if (
        metadata.length >= OFFLINE_IMPORT_LIMITS.maxMetadataEntries ||
        row.nt !== 'text' ||
        row.vt !== 'text' ||
        row.n.byteLength > 128 ||
        row.v.byteLength > OFFLINE_IMPORT_LIMITS.maxMetadataValueBytes
      )
        error('MBTiles metadata is invalid or exceeds its limit');
      const name = decoder.decode(row.n),
        value = decoder.decode(row.v);
      if (!name || names.has(name))
        error('MBTiles metadata names must be unique');
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name + value))
        error('MBTiles metadata contains unsupported control characters');
      names.add(name);
      metadata.push({ name, value });
      if (
        textBytes(JSON.stringify(metadata)) >
        OFFLINE_IMPORT_LIMITS.maxMetadataBytes
      )
        error('MBTiles metadata exceeds its byte limit');
    }
    const meta = new Map(metadata.map((row) => [row.name, row.value]));
    if (!meta.get('name')?.trim())
      error('MBTiles metadata must include its name');
    const numbers = (name, count) => {
      if (!meta.has(name)) return null;
      const parts = meta
        .get(name)
        .split(',')
        .map((part) => part.trim());
      if (
        parts.length !== count ||
        parts.some(
          (part) =>
            !part || !/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(part),
        )
      )
        error(`MBTiles ${name} metadata is invalid`);
      const values = parts.map(Number);
      if (!values.every(Number.isFinite))
        error(`MBTiles ${name} metadata is invalid`);
      return values;
    };
    const declaredBounds = numbers('bounds', 4),
      center = numbers('center', 3);
    if (declaredBounds) {
      const [w, s, e, n] = declaredBounds;
      if (
        w < -180 ||
        e > 180 ||
        w >= e ||
        s < -MERCATOR_LATITUDE ||
        n > MERCATOR_LATITUDE ||
        s >= n
      )
        error(
          'MBTiles bounds metadata is outside supported Web Mercator limits',
        );
    }
    if (
      center &&
      (center[0] < -180 ||
        center[0] > 180 ||
        Math.abs(center[1]) > MERCATOR_LATITUDE ||
        !Number.isInteger(center[2]) ||
        center[2] < 0 ||
        center[2] > 23)
    )
      error('MBTiles center metadata is invalid');
    for (const name of ['minzoom', 'maxzoom'])
      if (
        meta.has(name) &&
        (!/^(?:0|[1-9]\d?)$/.test(meta.get(name)) ||
          Number(meta.get(name)) > 23)
      )
        error(`MBTiles ${name} metadata is invalid`);
    if (
      meta.has('minzoom') &&
      meta.has('maxzoom') &&
      Number(meta.get('minzoom')) > Number(meta.get('maxzoom'))
    )
      error('MBTiles declared zoom range is reversed');
    if (
      meta.has('type') &&
      !['overlay', 'baselayer'].includes(meta.get('type'))
    )
      error(
        'MBTiles type metadata must identify a raster overlay or baselayer',
      );
    const contentType = new Map([
      ['png', 'image/png'],
      ['image/png', 'image/png'],
      ['jpg', 'image/jpeg'],
      ['jpeg', 'image/jpeg'],
      ['image/jpeg', 'image/jpeg'],
    ]).get(meta.get('format'));
    if (!contentType)
      error(
        'Only 256-pixel PNG/JPEG raster MBTiles are supported; vector PBF and WebP are unsupported',
      );
    const inventory = new Map();
    let total = 0,
      minZoom = 23,
      maxZoom = 0;
    let west = 180,
      east = -180,
      south = MERCATOR_LATITUDE,
      north = -MERCATOR_LATITUDE;
    const location = (row) => {
      if (
        row.zt !== 'integer' ||
        row.xt !== 'integer' ||
        row.yt !== 'integer' ||
        row.dt !== 'blob'
      )
        error(
          'MBTiles coordinates must be integers and tile data must be a BLOB',
        );
      const { z, x, r } = row;
      if (
        ![z, x, r].every(Number.isSafeInteger) ||
        z < 0 ||
        z > 23 ||
        x < 0 ||
        r < 0 ||
        x >= 2 ** z ||
        r >= 2 ** z
      )
        error(
          'MBTiles tile coordinate is outside supported Web Mercator bounds',
        );
      return { z, x, y: 2 ** z - 1 - r };
    };
    const coordinates =
      'zoom_level AS z, tile_column AS x, tile_row AS r, typeof(zoom_level) AS zt, typeof(tile_column) AS xt, typeof(tile_row) AS yt, typeof(tile_data) AS dt';
    const ranges = selection && mbtilesSelectionRanges(selection);
    function* rows(payload) {
      const columns = payload
        ? 'tile_data AS bytes'
        : 'length(tile_data) AS size';
      const statement = db.prepare(
        `SELECT ${coordinates}, ${columns} FROM tiles${ranges ? ' WHERE zoom_level=? AND tile_column BETWEEN ? AND ? AND tile_row BETWEEN ? AND ? LIMIT ?' : ' LIMIT 5001'}`,
      );
      if (!ranges) {
        yield* statement.iterate();
        return;
      }
      let remaining = OFFLINE_LIMITS.maxTiles + 1;
      for (const { z, x0, x1, r0, r1 } of ranges) {
        for (const row of statement.iterate(z, x0, x1, r0, r1, remaining)) {
          yield row;
          if (--remaining === 0) return;
        }
      }
    }
    for (const row of rows(false)) {
      const { z, x, y } = location(row),
        key = tileKey(z, x, y);
      if (inventory.size >= OFFLINE_LIMITS.maxTiles || inventory.has(key))
        error('MBTiles has duplicate coordinates or exceeds 5000 tiles');
      if (
        !Number.isSafeInteger(row.size) ||
        row.size < 1 ||
        row.size > OFFLINE_LIMITS.maxTileBytes
      )
        error('An MBTiles tile exceeds the 2MiB size limit');
      total += row.size;
      if (total > message.maxBytes)
        error('MBTiles output exceeds its pack byte limit');
      inventory.set(key, row.size);
      minZoom = Math.min(minZoom, z);
      maxZoom = Math.max(maxZoom, z);
      const n = 2 ** z,
        latitude = (v) =>
          (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
      west = Math.min(west, (x / n) * 360 - 180);
      east = Math.max(east, ((x + 1) / n) * 360 - 180);
      south = Math.min(south, latitude(y + 1));
      north = Math.max(north, latitude(y));
    }
    if (!inventory.size)
      error(
        selection
          ? 'MBTiles selection contains no supported raster tiles'
          : 'MBTiles contains no supported raster tiles',
      );
    if (
      !selection &&
      ((meta.has('minzoom') && Number(meta.get('minzoom')) !== minZoom) ||
        (meta.has('maxzoom') && Number(meta.get('maxzoom')) !== maxZoom))
    )
      error('MBTiles declared zoom range differs from its tile inventory');
    await send({
      op: 'header',
      value: {
        plannedKeys: [...inventory.keys()].sort(),
        minZoom,
        maxZoom,
        bounds: selection
          ? importedTileBounds([...inventory.keys()])
          : {
              west,
              south: Math.max(-MERCATOR_LATITUDE, south),
              east,
              north: Math.min(MERCATOR_LATITUDE, north),
            },
        metadata,
        contentType,
        tileBytes: total,
      },
    });
    const seen = new Set();
    for (const row of rows(true)) {
      const { z, x, y } = location(row),
        key = tileKey(z, x, y);
      if (
        !inventory.has(key) ||
        seen.has(key) ||
        row.bytes.byteLength !== inventory.get(key)
      )
        error('MBTiles tile inventory changed during validation');
      validateImportedRaster(row.bytes, contentType);
      seen.add(key);
      await send({ op: 'tile', key, bytes: row.bytes, contentType });
    }
    if (seen.size !== inventory.size)
      error('MBTiles tile inventory is incomplete');
    db.close();
    db = null;
    process.send({ op: 'done' }, () => process.exit(0));
  } catch (problem) {
    try {
      db?.close();
    } catch {
      /* Child exits regardless. */
    }
    const safe = problem?.message;
    process.send(
      {
        op: 'error',
        message:
          typeof safe === 'string' &&
          /^(MBTiles|Only 256|The selected|Checkpoint|An MBTiles|Offline map:)/.test(
            safe,
          )
            ? safe.slice(0, 256)
            : 'Invalid, unsupported or over-budget MBTiles database',
      },
      () => process.exit(1),
    );
  }
});
