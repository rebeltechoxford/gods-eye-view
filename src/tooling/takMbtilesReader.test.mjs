import test from 'node:test';
import assert from 'node:assert/strict';
import * as sqlite from 'node:sqlite';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readMbtiles } from '../../server/maps/offline/mbtiles-reader.mjs';
import { validateImportedRaster } from '../../server/maps/offline/raster-validation.js';
import { importedTileBounds } from '../maps/offline/schema.js';

const Database = sqlite.Database || sqlite.DatabaseSync;
const image = await readFile(
  new URL(
    '../../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
function pngChunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
function png({
  ancillary = [],
  rows = Buffer.alloc(256 * (256 * 4 + 1)),
  trailing = [],
} = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(256);
  header.writeUInt32BE(256, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...ancillary,
    pngChunk('IDAT', deflateSync(rows)),
    ...trailing,
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-mbtiles-reader-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^gev-mbtiles-reader-/);
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function fixture(
  t,
  {
    view = false,
    rows = [
      [2, 1, 0, image],
      [2, 1, 3, image],
    ],
    format = 'jpg',
    extra = '',
  } = {},
) {
  const root = await directory(t),
    file = path.join(root, 'source.mbtiles');
  const db = new Database(file);
  try {
    db.exec('BEGIN');
    db.exec('CREATE TABLE metadata(name TEXT,value TEXT);');
    const meta = db.prepare('INSERT INTO metadata VALUES(?,?)');
    for (const values of [
      ['name', 'Synthetic own map'],
      ['format', format],
      ['attribution', '<script>untrusted original notice</script>'],
    ])
      meta.run(...values);
    if (view) {
      db.exec(
        'CREATE TABLE map(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_id INTEGER); CREATE TABLE images(tile_id INTEGER,tile_data BLOB); CREATE VIEW tiles AS SELECT map.zoom_level,map.tile_column,map.tile_row,images.tile_data FROM map JOIN images ON map.tile_id=images.tile_id;',
      );
      const map = db.prepare('INSERT INTO map VALUES(?,?,?,?)'),
        images = db.prepare('INSERT INTO images VALUES(?,?)');
      rows.forEach(([z, x, r, bytes], id) => {
        map.run(z, x, r, id);
        images.run(id, bytes);
      });
    } else {
      db.exec(
        'CREATE TABLE tiles(zoom_level INTEGER,tile_column INTEGER,tile_row INTEGER,tile_data BLOB);',
      );
      const insert = db.prepare('INSERT INTO tiles VALUES(?,?,?,?)');
      for (const row of rows) insert.run(...row);
    }
    if (extra) db.exec(extra);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return file;
}

for (const view of [false, true])
  test(`actual SQLite ${view ? 'normalized join view' : 'flat table'} imports sparse raster rows with correct TMS inversion`, async (t) => {
    const tiles = [],
      file = await fixture(t, { view });
    const header = await readMbtiles(file, {
      onTile: (tile) => tiles.push(tile),
    });
    assert.deepEqual(header.plannedKeys, ['2/1/0', '2/1/3']);
    assert.equal(header.minZoom, 2);
    assert.equal(header.maxZoom, 2);
    assert.deepEqual(
      tiles.map((tile) => tile.key),
      ['2/1/3', '2/1/0'],
    );
    for (const tile of tiles) assert.deepEqual(Buffer.from(tile.bytes), image);
    assert.equal(
      header.metadata.find((row) => row.name === 'attribution').value,
      '<script>untrusted original notice</script>',
    );
    assert.equal(header.bounds.west, -90);
    assert.equal(header.bounds.east, 0);
    assert.ok(Math.abs(header.bounds.south + 85.0511287798066) < 1e-10);
    assert.ok(Math.abs(header.bounds.north - 85.0511287798066) < 1e-10);
  });

for (const view of [false, true])
  test(`bounded area/zoom selection reads only matching ${view ? 'normalized' : 'flat'} raster rows and preserves original metadata`, async (t) => {
    const file = await fixture(t, {
      view,
      rows: [
        [0, 0, 0, image],
        [2, 0, 1, image],
        [2, 3, 2, image],
        [2, 1, 1, Buffer.from('unselected image is not decoded')],
        [3, 0, 3, image],
      ],
      extra: "INSERT INTO metadata VALUES('minzoom','0'),('maxzoom','3')",
    });
    const selection = {
      bounds: { west: 170, south: -10, east: -170, north: 10 },
      minZoom: 0,
      maxZoom: 2,
    };
    const tiles = [];
    const header = await readMbtiles(file, {
      selection,
      onTile: (tile) => tiles.push(tile.key),
    });
    assert.deepEqual(header.plannedKeys, ['0/0/0', '2/0/2', '2/3/1']);
    assert.deepEqual(tiles, header.plannedKeys);
    assert.equal(
      header.metadata.find((row) => row.name === 'maxzoom').value,
      '3',
    );
    assert.equal(header.tileBytes, image.length * 3);
    assert.deepEqual(header.bounds, importedTileBounds(header.plannedKeys));
    const narrow = await readMbtiles(file, {
      selection: { ...selection, minZoom: 2 },
    });
    assert.deepEqual(narrow.bounds, importedTileBounds(['2/0/2', '2/3/1']));
    assert.equal(narrow.bounds.west, 90);
    assert.equal(narrow.bounds.east, -90);
    await assert.rejects(
      () => readMbtiles(file),
      /zoom range|malformed|unsupported|MIME/,
    );
  });

test('selection never deduplicates database rows, inflates its limits or trusts malformed selected payloads', async (t) => {
  const selection = {
    bounds: { west: -179, south: -10, east: -100, north: 10 },
    minZoom: 2,
    maxZoom: 2,
  };
  for (const rows of [
    [
      [2, 0, 1, image],
      [2, 0, 1, image],
    ],
    [[2, 0, 1.5, image]],
    [[2, 0, 1, Buffer.from('malformed selected image')]],
    Array.from({ length: 5001 }, () => [2, 0, 1, image]),
  ])
    await assert.rejects(() =>
      fixture(t, { rows }).then((file) => readMbtiles(file, { selection })),
    );
  await assert.rejects(
    () =>
      fixture(t, { rows: [[2, 3, 1, image]] }).then((file) =>
        readMbtiles(file, { selection }),
      ),
    /selection contains no/,
  );
  let forks = 0;
  const file = await fixture(t);
  await assert.rejects(
    () =>
      readMbtiles(file, {
        selection: { ...selection, maxZoom: 23 },
        forkImpl() {
          forks++;
        },
      }),
    /exceeds 5000/,
  );
  assert.equal(forks, 0);
});

test('selection applies one deadline and cancellation across disjoint ranges', async (t) => {
  const selection = {
    bounds: { west: 170, south: -10, east: -170, north: 10 },
    minZoom: 2,
    maxZoom: 2,
  };
  const file = await fixture(t, {
    rows: [
      [2, 0, 1, image],
      [2, 3, 2, image],
    ],
  });
  const controller = new AbortController();
  let tiles = 0;
  await assert.rejects(
    () =>
      readMbtiles(file, {
        selection,
        signal: controller.signal,
        onTile() {
          tiles++;
          controller.abort(new Error('stop before next range'));
        },
      }),
    /stop before next range/,
  );
  assert.equal(tiles, 1);
  const costly = await fixture(t, {
    rows: [
      [2, 0, 1, image],
      [2, 3, 2, image],
    ],
    extra:
      'ALTER TABLE tiles RENAME TO base; CREATE VIEW tiles AS SELECT a.zoom_level,a.tile_column,a.tile_row,a.tile_data FROM base a CROSS JOIN base b CROSS JOIN base c CROSS JOIN base d CROSS JOIN base e CROSS JOIN base f CROSS JOIN base g CROSS JOIN base h CROSS JOIN base i CROSS JOIN base j CROSS JOIN base k CROSS JOIN base l CROSS JOIN base m CROSS JOIN base n CROSS JOIN base o CROSS JOIN base p CROSS JOIN base q CROSS JOIN base r CROSS JOIN base s CROSS JOIN base t ORDER BY b.tile_row+c.tile_row+d.tile_row+e.tile_row+f.tile_row+g.tile_row+h.tile_row+i.tile_row+j.tile_row+k.tile_row+l.tile_row+m.tile_row+n.tile_row+o.tile_row+p.tile_row+q.tile_row+r.tile_row+s.tile_row+t.tile_row;',
  });
  await assert.rejects(
    () => readMbtiles(costly, { selection, timeoutMs: 100 }),
    /limit|unsupported|time/,
  );
});

test('selected indexed reads reject a real index/table mismatch that quick_check misses', async (t) => {
  const file = await fixture(t, {
    rows: [[2, 1, 0, image]],
    extra: 'CREATE INDEX tile_index ON tiles(zoom_level,tile_column,tile_row)',
  });
  let db = new Database(file);
  const rootPage = db
    .prepare("SELECT rootpage FROM sqlite_schema WHERE name='tile_index'")
    .get().rootpage;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  db.close();
  const bytes = await readFile(file),
    page = (rootPage - 1) * pageSize;
  assert.equal(bytes[page], 0x0a); // One-cell index leaf: payload varint, record header, then data.
  assert.equal(bytes.readUInt16BE(page + 3), 1);
  const cell = page + bytes.readUInt16BE(page + 8);
  assert.ok(bytes[cell] < 128);
  const record = cell + 1;
  assert.equal(bytes[record], 5); // Four serial types: zoom, column, row, rowid.
  assert.deepEqual([...bytes.subarray(record + 1, record + 5)], [1, 9, 8, 9]);
  bytes[record + 2] = 8; // Constant 1 becomes 0, retaining the same valid record length.
  await writeFile(file, bytes);
  db = new Database(file, { readOnly: true });
  try {
    assert.equal(
      Object.values(db.prepare('PRAGMA quick_check(1)').get())[0],
      'ok',
    );
    assert.match(
      Object.values(db.prepare('PRAGMA integrity_check(1)').get())[0],
      /missing from index|wrong # of entries/,
    );
    assert.deepEqual(
      db
        .prepare(
          'SELECT tile_column FROM tiles INDEXED BY tile_index WHERE zoom_level=2 AND tile_column=1 AND tile_row=0',
        )
        .all(),
      [],
    );
  } finally {
    db.close();
  }
  await assert.rejects(
    () =>
      readMbtiles(file, {
        selection: {
          bounds: { west: -89, south: -80, east: -1, north: -10 },
          minZoom: 2,
          maxZoom: 2,
        },
      }),
    /integrity check failed/,
  );
});

test('selected zooms may narrow original metadata but cannot contradict its declared range', async (t) => {
  const selection = {
    bounds: { west: -134.05, south: 48.95, east: -133.95, north: 49.05 },
    minZoom: 10,
    maxZoom: 10,
  };
  const rows = [[10, 130, 672, image]];
  const positive = await fixture(t, {
    rows,
    extra: "INSERT INTO metadata VALUES('minzoom','0'),('maxzoom','13')",
  });
  const header = await readMbtiles(positive, { selection });
  assert.deepEqual(header.plannedKeys, ['10/130/351']);
  assert.equal(header.minZoom, 10);
  assert.equal(
    header.metadata.find((row) => row.name === 'maxzoom').value,
    '13',
  );
  for (const extra of [
    "INSERT INTO metadata VALUES('minzoom','11'),('maxzoom','13')",
    "INSERT INTO metadata VALUES('minzoom','0'),('maxzoom','9')",
    "INSERT INTO metadata VALUES('minzoom','11'),('maxzoom','9')",
  ])
    await assert.rejects(
      () =>
        fixture(t, { rows, extra }).then((file) =>
          readMbtiles(file, { selection }),
        ),
      /declared zoom range/,
    );
});

test('raster reader rejects unsupported formats, duplicate/out-of-range/noninteger coordinates and oversized blobs', async (t) => {
  for (const options of [
    { format: 'pbf' },
    { format: 'webp' },
    {
      rows: [
        [2, 1, 0, image],
        [2, 1, 0, image],
      ],
    },
    { rows: [[2, 4, 0, image]] },
    { rows: [[2, 1, -1, image]] },
    { rows: [[2, 1.5, 0, image]] },
    { rows: [[24, 0, 0, image]] },
    { rows: [[2, 1, 0, Buffer.alloc(2 * 1024 * 1024 + 1)]] },
    { rows: [[2, 1, 0, Buffer.from('<svg/>')]] },
    { extra: "INSERT INTO metadata VALUES('name','duplicate')" },
    { extra: "INSERT INTO metadata VALUES('long',printf('%.*c',17000,'x'))" },
    { extra: "INSERT INTO metadata VALUES('bounds','-180,NaN,180,85')" },
    { extra: "INSERT INTO metadata VALUES('minzoom','0')" },
    { extra: "INSERT INTO metadata VALUES('center','0,0,no')" },
    {
      rows: Array.from({ length: 5001 }, (_, x) => [
        13,
        x,
        0,
        Buffer.alloc(100),
      ]),
    },
  ])
    await assert.rejects(() =>
      fixture(t, options).then((file) => readMbtiles(file)),
    );
});

test('malicious recursive/virtual views and malformed SQLite files fail closed', async (t) => {
  const file = await fixture(t, {
    extra:
      "DROP TABLE tiles; CREATE VIEW tiles AS WITH RECURSIVE counter(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM counter WHERE n<1000000000) SELECT 2 AS zoom_level,0 AS tile_column,n AS tile_row,x'00' AS tile_data FROM counter;",
  });
  await assert.rejects(() => readMbtiles(file), /Invalid|unsupported|limit/);
  const virtual = await fixture(t, {
    extra: 'CREATE VIRTUAL TABLE bad USING fts5(body)',
  });
  await assert.rejects(() => readMbtiles(virtual), /schema|unsupported/);
  const root = await directory(t),
    malformed = path.join(root, 'bad.mbtiles');
  await writeFile(malformed, Buffer.alloc(1024));
  await assert.rejects(() => readMbtiles(malformed), /not a standalone/);
});

test('imported raster validation bounds PNG inflation and rejects malformed/animated/compressed ancillary payloads', async (t) => {
  const valid = png();
  assert.equal(validateImportedRaster(valid, 'image/png'), valid);
  const seen = [];
  await readMbtiles(
    await fixture(t, { format: 'png', rows: [[0, 0, 0, valid]] }),
    { onTile: (tile) => seen.push(tile) },
  );
  assert.deepEqual(Buffer.from(seen[0].bytes), valid);
  const badCrc = Buffer.from(valid);
  badCrc[badCrc.length - 1] ^= 1;
  const badFilter = Buffer.alloc(256 * (256 * 4 + 1));
  badFilter[0] = 5;
  for (const bytes of [
    badCrc,
    png({ rows: Buffer.alloc(1024 * 1024) }),
    png({ rows: badFilter }),
    png({ ancillary: [pngChunk('acTL', Buffer.alloc(8))] }),
    png({ ancillary: [pngChunk('iCCP', Buffer.from('compressed profile'))] }),
    png({ ancillary: [pngChunk('zTXt', Buffer.from('compressed text'))] }),
    png({
      trailing: [
        pngChunk('tEXt', Buffer.from('after data')),
        pngChunk('IDAT', Buffer.alloc(0)),
      ],
    }),
    Buffer.concat([valid, Buffer.from('junk')]),
  ])
    assert.throws(() => validateImportedRaster(bytes, 'image/png'));
  assert.equal(validateImportedRaster(image, 'image/jpeg'), image);
  assert.throws(() =>
    validateImportedRaster(
      Buffer.concat([image, Buffer.from('junk')]),
      'image/jpeg',
    ),
  );
  await assert.rejects(
    () =>
      fixture(t, { format: 'png', rows: [[0, 0, 0, badCrc]] }).then((file) =>
        readMbtiles(file),
      ),
    /malformed|unsupported/,
  );
});

test('reader wall deadline, cancellation and callback failure retire the child without extra output', async (t) => {
  const file = await fixture(t);
  await assert.rejects(() => readMbtiles(file, { timeoutMs: 1 }), /time limit/);
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(
    () =>
      readMbtiles(file, {
        signal: controller.signal,
        onTile() {
          count++;
          controller.abort(new Error('synthetic cancellation'));
        },
      }),
    /synthetic cancellation/,
  );
  assert.equal(count, 1);
  await assert.rejects(
    () =>
      readMbtiles(file, {
        onTile() {
          throw new Error('synthetic write failure');
        },
      }),
    /synthetic write failure/,
  );
  const header = await readMbtiles(file);
  assert.equal(header.plannedKeys.length, 2);
});

test('abort waits for the active parent callback before allowing staging cleanup', async (t) => {
  const file = await fixture(t),
    controller = new AbortController();
  let enter,
    release,
    settled = false,
    writes = 0;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const reading = readMbtiles(file, {
    signal: controller.signal,
    async onTile() {
      enter();
      await paused;
      writes++;
    },
  });
  const result = reading.then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      throw error;
    },
  );
  result.catch(() => {});
  try {
    await entered;
    controller.abort(new Error('synthetic cancellation during disk write'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false);
  } finally {
    release();
  }
  await assert.rejects(result, /synthetic cancellation during disk write/);
  assert.equal(writes, 1);
  assert.equal(settled, true);
});

test('unconfirmed process termination has an internal quarantine code; spawn error and exit settle once', async (t) => {
  const file = await fixture(t);
  let kills = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    send() {},
    kill() {
      kills++;
      return true;
    },
  });
  await assert.rejects(
    () =>
      readMbtiles(file, {
        timeoutMs: 5,
        stopTimeoutMs: 5,
        forkImpl: (_file, _args, options) => {
          assert.deepEqual(
            Object.keys(options.env).filter(
              (key) => !['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].includes(key),
            ),
            [],
          );
          return child;
        },
      }),
    (error) =>
      error.code === 'MBTILES_WORKER_UNCONFIRMED' && error.workerPid === 12345,
  );
  assert.equal(kills, 1);
  child.exitCode = 0;
  child.emit('exit', 0); // A late event cannot settle twice.
  const noProcess = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stderr: new PassThrough(),
    send() {},
    kill() {
      throw new Error('A process that never spawned must not be killed');
    },
  });
  await assert.rejects(
    () =>
      readMbtiles(file, {
        forkImpl() {
          queueMicrotask(() => {
            noProcess.emit('error', new Error('synthetic spawn failure'));
            noProcess.emit('exit', 1);
          });
          return noProcess;
        },
      }),
    /could not start/,
  );
});
