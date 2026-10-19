import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  cotTrailPositions,
  isAirborne,
  createCotOverlay,
} from './cotOverlay.js';
import { createTakStore } from './store.js';
import { buildSelfSa } from './protocol/builders.js';
import { IDENTITY } from './protocol/fixtures.mjs';
import { findPickOwner } from '../data/pickRegistry.js';
import { captureTakPicture, readTakPicture } from './picture.js';

test('aircraft history uses each CoT ellipsoid height and omits unknown altitude fixes', () => {
  const aircraft = {
    type: 'a-f-A-M-F',
    point: { hae: 3000 },
    trail: [
      { lat: 35, lon: -89, hae: 2500 },
      { lat: 35.1, lon: -89, hae: null },
      { lat: 35.2, lon: -89, hae: 3000 },
    ],
  };
  assert.equal(isAirborne(aircraft), true);
  const positions = cotTrailPositions(aircraft);
  assert.equal(positions.length, 2);
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(positions[0]).height - 2500) <
      0.001,
  );
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(positions[1]).height - 3000) <
      0.001,
  );
  const ground = { ...aircraft, type: 'a-f-G-U-C' };
  assert.equal(isAirborne(ground), false);
  assert.ok(
    cotTrailPositions(ground).every(
      (point) =>
        Math.abs(Cesium.Cartographic.fromCartesian(point).height) < 0.001,
    ),
  );
});

test('historical namespace can display the same UID alongside live TAK without taking its picks or source', async (t) => {
  const previous = globalThis.document;
  const canvas = () => ({
    disableRootEvents: true,
    onwheel: null,
    addEventListener() {},
    removeEventListener() {},
    getContext: () => new Proxy({}, { get: () => () => {} }),
  });
  globalThis.document = {
    createElement: canvas,
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const viewer = {
    dataSources: new Cesium.DataSourceCollection(),
    scene: { canvas: canvas(), requestRender() {} },
    camera: { heading: 0 },
  };
  const sources = new Map();
  const overlays = {
    setEntries: (id, cards) => sources.set(id, cards),
    clearSource: (id) => sources.delete(id),
    setVisible() {},
  };
  const live = createCotOverlay(viewer, overlays);
  const history = createCotOverlay(viewer, overlays, {
    namespace: 'tak-history',
    sourceName: 'TAK historical picture',
  });
  t.after(() => {
    history.destroy();
    live.destroy();
  });
  await Promise.resolve();
  const store = createTakStore();
  store.apply(
    buildSelfSa(IDENTITY, { lat: 34, lon: -89 }, { nowMs: Date.now() }),
    'network',
  );
  const picture = readTakPicture(captureTakPicture(store.list()));
  live.render(store.list(), () => false);
  history.render(picture.contacts, () => true);
  assert.equal(findPickOwner(`tak:${IDENTITY.uid}`), 'tak');
  assert.equal(findPickOwner(`tak-history:${IDENTITY.uid}`), 'tak-history');
  assert.equal(
    findPickOwner(`tak-history-trail:${IDENTITY.uid}`),
    'tak-history',
  );
  assert.equal(sources.size, 2);
  const historicalCard = sources.get('tak-history-contacts')[0];
  assert.match(historicalCard.title, /^HISTORY · /);
  assert.ok(
    historicalCard.details.some((line) =>
      line.startsWith('HISTORICAL · saved'),
    ),
  );
  assert.ok(historicalCard.details.includes('STALE'));
  const source = viewer.dataSources.getByName('TAK historical picture')[0];
  viewer.selectedEntity = source.entities.getById(
    `tak-history:${IDENTITY.uid}`,
  );
  assert.ok(viewer.selectedEntity);
  history.render([], () => false);
  assert.equal(viewer.selectedEntity, undefined);
  history.destroy();
  assert.equal(findPickOwner(`tak:${IDENTITY.uid}`), 'tak');
  assert.equal(findPickOwner(`tak-history:${IDENTITY.uid}`), null);
  assert.equal(sources.get('tak-contacts').length, 1);
  assert.equal(
    viewer.dataSources.getByName('TAK contacts')[0].entities.values.length,
    1,
  );
});

test('unchanged immutable contacts reuse entities/cards while clock, type, altitude and trails still update', async (t) => {
  const previousDocument = globalThis.document;
  const canvas = () => ({
    disableRootEvents: true,
    onwheel: null,
    addEventListener() {},
    removeEventListener() {},
    getContext: () => new Proxy({}, { get: () => () => {} }),
  });
  globalThis.document = {
    createElement: canvas,
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const viewer = {
    dataSources: new Cesium.DataSourceCollection(),
    scene: { canvas: canvas(), requestRender() {} },
    camera: { heading: 0 },
  };
  let cards;
  const overlay = createCotOverlay(viewer, {
    setEntries(_source, next) {
      cards = next;
    },
    clearSource() {
      cards = [];
    },
    setVisible() {},
  });
  t.after(() => overlay.destroy());
  await Promise.resolve();
  const store = createTakStore();
  const now = Date.now();
  const other = {
    ...IDENTITY,
    uid: 'GEV-22222222-2222-4222-8222-222222222222',
    callsign: 'OTHER',
  };
  store.apply(buildSelfSa(IDENTITY, { lat: 34, lon: -89 }, { nowMs: now }));
  store.apply(buildSelfSa(other, { lat: 35, lon: -89 }, { nowMs: now }));
  overlay.render(store.list(), () => false);
  const source = viewer.dataSources.getByName('TAK contacts')[0];
  const own = source.entities.getById(`tak:${IDENTITY.uid}`);
  const foreign = source.entities.getById(`tak:${other.uid}`);
  const priorForeignPosition = foreign.position;
  const priorForeignCard = cards.find((card) => card.id === other.uid);
  let changed = 0;
  foreign.definitionChanged.addEventListener(() => changed++);
  overlay.render(store.list(), () => false);
  assert.equal(changed, 0);
  assert.equal(foreign.position, priorForeignPosition);
  assert.equal(
    cards.find((card) => card.id === other.uid),
    priorForeignCard,
  );
  store.apply(
    buildSelfSa(IDENTITY, { lat: 34.001, lon: -89 }, { nowMs: now + 1 }),
  );
  overlay.render(store.list(), () => false);
  assert.equal(changed, 0);
  assert.equal(foreign.position, priorForeignPosition);
  const freshImage = own.billboard.image.getValue();
  overlay.render(store.list(), () => true);
  assert.notEqual(own.billboard.image.getValue(), freshImage);
  assert.ok(
    cards.find((card) => card.id === IDENTITY.uid).details.includes('STALE'),
  );
  for (const [index, hae] of [3000, 3100].entries()) {
    store.apply(
      buildSelfSa(
        { ...IDENTITY, type: 'a-f-A-M-F' },
        { lat: 34.01 + index * 0.01, lon: -89, hae },
        { nowMs: now + 2 + index },
      ),
    );
    overlay.render(store.list(), () => false);
  }
  assert.equal(
    own.billboard.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  assert.ok(
    Math.abs(
      Cesium.Cartographic.fromCartesian(
        own.position.getValue(Cesium.JulianDate.now()),
      ).height - 3100,
    ) < 0.001,
  );
  const positions = source.entities
    .getById(`tak-trail:${IDENTITY.uid}`)
    .polyline.positions.getValue();
  assert.equal(positions.length, 2);
  assert.ok(
    Math.abs(Cesium.Cartographic.fromCartesian(positions[0]).height - 3000) <
      0.001,
  );
  const alert = buildSelfSa(
    IDENTITY,
    { lat: 34.03, lon: -89 },
    { nowMs: now + 5 },
  );
  store.apply({
    ...alert,
    detail: {
      ...alert.detail,
      emergency: { type: 'SYNTHETIC ALERT', cancel: false },
    },
  });
  overlay.render(store.list(), () => false);
  const emergencyCard = cards.find((card) => card.id === IDENTITY.uid);
  assert.equal(emergencyCard.protected, true);
  assert.equal(emergencyCard.priority, 3000);
  assert.ok(emergencyCard.details.includes('SYNTHETIC ALERT'));
  assert.equal(
    own.billboard.heightReference.getValue(),
    Cesium.HeightReference.CLAMP_TO_GROUND,
  );
  overlay.render([], () => false);
  assert.equal(source.entities.values.length, 0);
  assert.equal(cards.length, 0);
  overlay.destroy();
  overlay.destroy();
  assert.equal(viewer.dataSources.getByName('TAK contacts').length, 0);
});
