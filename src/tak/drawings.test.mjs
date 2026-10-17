import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createTakClient } from './client.js';
import { createTakStore } from './store.js';
import { createDrawingsWorkflow } from './drawingsWorkflow.js';
import { buildGeometry } from './geometryCot.js';
import { geometryGraphics } from './geometryGraphics.js';
import { parseCotEvent, serializeCotEvent } from './protocol/cot.js';
import { IDENTITY, T0 } from './protocol/fixtures.mjs';

const line = (overrides = {}) => ({
  kind: 'polyline',
  callsign: 'SYNTHETIC LINE',
  vertices: [
    { lat: 34, lon: 179 },
    { lat: 34.1, lon: -179 },
  ],
  ...overrides,
});
function setup() {
  let handlers,
    open = false,
    tick = T0;
  const sent = [],
    timers = new Set();
  const client = createTakClient({
    now: () => tick,
    storage: { get: () => JSON.stringify(IDENTITY), set() {} },
    setInterval(fn) {
      timers.add(fn);
      return fn;
    },
    clearInterval(fn) {
      timers.delete(fn);
    },
    createTransport(next) {
      handlers = next;
      return {
        connect() {
          open = true;
          handlers.onState('open');
        },
        disconnect() {
          open = false;
          handlers.onState('closed');
        },
        submit(id, xml) {
          if (!open) return false;
          sent.push({ id, event: parseCotEvent(xml) });
          return true;
        },
        cancelSubmissions() {},
      };
    },
  });
  return {
    client,
    sent,
    timers,
    receive: (event) => handlers.onXml(serializeCotEvent(event)),
    advance: (ms) => (tick += ms),
  };
}

test('drawing create/edit/share/delete retains identity and never auto-broadcasts local saves or imports', (t) => {
  const { client, sent } = setup();
  t.after(() => client.destroy());
  const local = client.saveGeometry(line());
  assert.equal(local.sent, false);
  assert.equal(client.isOwnGeometry(local.uid), true);
  client.connect();
  assert.equal(sent.length, 0);
  const first = client.store.get(local.uid);
  const updated = client.saveGeometry(
    line({ uid: local.uid, callsign: 'EDITED' }),
    { expectedEvent: first.event, broadcast: true },
  );
  assert.equal(updated.uid, local.uid);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.uid, local.uid);
  assert.equal(client.store.get(local.uid).callsign, 'EDITED');
  assert.ok(client.store.get(local.uid).event.timeMs > first.event.timeMs);
  assert.throws(
    () =>
      client.saveGeometry(line({ uid: local.uid }), {
        expectedEvent: first.event,
        broadcast: true,
      }),
    /changed/,
  );
  assert.equal(sent.length, 1);
  client.importXml(
    serializeCotEvent(
      buildGeometry(
        { ...IDENTITY, uid: 'GEV-22222222-2222-4222-8222-222222222222' },
        line(),
      ),
    ),
  );
  assert.equal(sent.length, 1);
  client.removeContact(local.uid);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].event.type, 't-x-d-d');
  assert.equal(client.isOwnGeometry(local.uid), false);
});

test('foreign geometry and stale edit snapshots cannot acquire session ownership or overwrite a peer update', (t) => {
  const { client, receive, sent } = setup();
  t.after(() => client.destroy());
  const local = client.saveGeometry(line()),
    original = client.store.get(local.uid).event;
  receive(
    buildGeometry(IDENTITY, line({ uid: local.uid, callsign: 'PEER UPDATE' }), {
      nowMs: T0 + 5000,
    }),
  );
  assert.equal(client.store.get(local.uid).callsign, 'PEER UPDATE');
  assert.throws(
    () =>
      client.saveGeometry(line({ uid: local.uid }), {
        expectedEvent: original,
        broadcast: true,
      }),
    /changed/,
  );
  const foreign = buildGeometry(
    { ...IDENTITY, uid: 'GEV-22222222-2222-4222-8222-222222222222' },
    line(),
    { nowMs: T0 },
  );
  receive(foreign);
  assert.throws(
    () =>
      client.saveGeometry(line({ uid: foreign.uid }), {
        expectedEvent: client.store.get(foreign.uid).event,
        broadcast: true,
      }),
    /another session/,
  );
  assert.equal(sent.length, 0);
  client.clearPrivateState();
  assert.equal(client.store.count(), 0);
  assert.equal(client.isOwnGeometry(local.uid), false);
  assert.throws(
    () =>
      client.saveGeometry(line({ uid: local.uid }), {
        expectedEvent: original,
      }),
    /removed/,
  );
});

test('route editor preserves waypoint identifiers while moving/editing, remints copies, and resolves update conflicts explicitly', (t) => {
  const { client, receive } = setup();
  t.after(() => client.destroy());
  let privacy = 0;
  const editor = createDrawingsWorkflow({
    client,
    markPrivate: () => privacy++,
  });
  editor.start('route');
  editor.settings({ callsign: 'SYNTHETIC ROUTE' });
  editor.add({
    lat: 34,
    lon: 179,
    type: 'b-m-p-w',
    callsign: 'START',
    remarks: 'Keep waypoint notes',
  });
  editor.add({ lat: 34.1, lon: -179, type: 'b-m-p-c', callsign: 'BEND' });
  editor.add({ lat: 34.2, lon: -178, type: 'b-m-p-w', callsign: 'FINISH' });
  assert.equal(editor.preview().kind, 'route');
  const result = editor.save();
  const ids = editor.state().draft.vertices.map((point) => point.uid);
  assert.equal(new Set(ids).size, 3);
  editor.move(2, -1);
  editor.replace(0, {
    lat: 34.001,
    lon: 179,
    type: 'b-m-p-w',
    callsign: 'NEW START',
  });
  editor.save();
  assert.equal(editor.state().draft.vertices[0].remarks, 'Keep waypoint notes');
  assert.deepEqual(
    editor.state().draft.vertices.map((point) => point.uid),
    [ids[0], ids[2], ids[1]],
  );
  assert.equal(editor.legs().length, 2);
  receive(
    buildGeometry(
      IDENTITY,
      { ...editor.state().draft, callsign: 'REMOTE CHANGE' },
      { nowMs: T0 + 1000 },
    ),
  );
  assert.equal(editor.state().conflict, true);
  assert.throws(() => editor.save(), /Reload/);
  editor.copyDraft();
  const copy = editor.save();
  assert.notEqual(copy.uid, result.uid);
  assert.equal(
    editor.state().draft.vertices.some((point) => ids.includes(point.uid)),
    false,
  );
  assert.ok(privacy > 0);
  editor.clear();
  assert.equal(editor.state(), null);
  editor.destroy();
  assert.throws(() => editor.start(), /closed/);
});

test('geometry vertex budget includes every contact, atomically evicts older geometry and rejects over-budget updates', () => {
  const store = createTakStore({ geometryVertexLimit: 4 });
  const a = buildGeometry(IDENTITY, line(), { nowMs: T0 });
  const b = buildGeometry(IDENTITY, line(), { nowMs: T0 });
  const c = buildGeometry(IDENTITY, line(), { nowMs: T0 });
  store.apply(a);
  store.apply(b);
  assert.equal(store.resourceStats().geometryVertices, 4);
  store.apply(c);
  assert.equal(store.get(a.uid), null);
  assert.equal(store.resourceStats().geometryVertices, 4);
  assert.equal(store.resourceStats().evictedContacts, 1);
  const tooLarge = buildGeometry(
    IDENTITY,
    line({
      uid: b.uid,
      vertices: Array.from({ length: 5 }, (_, i) => ({
        lat: 35 + i * 0.01,
        lon: -89,
      })),
    }),
    { nowMs: T0 + 1 },
  );
  assert.equal(store.apply(tooLarge), 'ignored');
  assert.equal(store.get(b.uid).event, b);
  assert.equal(store.resourceStats().geometryVertices, 4);
  store.clear();
  assert.equal(store.resourceStats().geometryVertices, 0);
});

test('ellipsoidal geometry graphics retain per-vertex HAE, closed polygon outline and dateline coordinates', () => {
  const store = createTakStore();
  const event = buildGeometry(
    IDENTITY,
    line({
      kind: 'polygon',
      vertices: [
        { lat: 34, lon: 179, hae: 120 },
        { lat: 34.1, lon: -179, hae: 140 },
        { lat: 35, lon: -179, hae: 180 },
      ],
    }),
  );
  store.apply(event);
  const geometry = store.get(event.uid).geometryResult.geometry;
  const graphics = geometryGraphics(geometry);
  assert.equal(graphics.polyline.clampToGround, false);
  assert.equal(graphics.polygon.perPositionHeight, true);
  assert.equal(graphics.polyline.positions.length, 4);
  assert.deepEqual(
    graphics.polyline.positions[0],
    graphics.polyline.positions.at(-1),
  );
  for (const [
    index,
    position,
  ] of graphics.polygon.hierarchy.positions.entries()) {
    const carto = Cesium.Cartographic.fromCartesian(position);
    assert.ok(Math.abs(carto.height - geometry.vertices[index].hae) < 0.001);
    assert.ok(
      Math.abs(
        Cesium.Math.toDegrees(carto.longitude) - geometry.vertices[index].lon,
      ) < 1e-9,
    );
  }
});
