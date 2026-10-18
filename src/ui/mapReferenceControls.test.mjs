import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapReferenceControls } from './mapReferenceControls.js';
import { REFERENCE_MAPS } from '../maps/referenceCatalog.js';

function element(tagName, doc) {
  return {
    tagName,
    ownerDocument: doc,
    children: [],
    attributes: {},
    append(...children) {
      for (const child of children) this.appendChild(child);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    replaceChildren() {
      this.children.length = 0;
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    remove() {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
    },
  };
}
function fixture(stacks) {
  const doc = { createElement: (tag) => element(tag, doc) };
  const parent = element('div', doc),
    chips = element('div', doc),
    calls = [],
    bound = [];
  parent.appendChild(chips);
  const controls = createMapReferenceControls({
    container: chips,
    stacks,
    onSelect: (id) => calls.push(id),
    bind: (target, type, listener) => bound.push({ target, type, listener }),
  });
  return { parent, chips, calls, bound, controls };
}

test('no extra selector appears without curated reference sources', () => {
  const env = fixture([{ id: 'osm' }, { id: 'operator-unknown-url' }]);
  assert.equal(env.controls, null);
  assert.equal(env.parent.children.length, 1);
});

test('extra sources are grouped below retained quick controls and delegate selection without optimism', () => {
  const env = fixture([
    { id: 'osm' },
    ...REFERENCE_MAPS.map((entry) => ({
      ...entry,
      available: entry.id !== 'faa-ifr-high',
    })),
  ]);
  assert.equal(env.parent.children[0], env.chips);
  const root = env.parent.children[1],
    select = root.children[1],
    details = root.children[2];
  assert.equal(select.id, 'map-reference-select');
  assert.deepEqual(
    select.children.slice(1).map((group) => group.label),
    ['Reference maps', 'Nautical charts', 'Aviation charts'],
  );
  assert.equal(select.children[3].children.at(-1).disabled, true);
  env.controls.render('osm');
  assert.equal(select.value, '');
  assert.equal(details.hidden, true);
  select.value = 'noaa-enc';
  env.bound[0].listener();
  assert.deepEqual(env.calls, ['noaa-enc']);
  assert.equal(
    details.hidden,
    true,
    'controller must confirm actual selected source',
  );
  env.controls.render('noaa-enc');
  assert.equal(select.value, 'noaa-enc');
  assert.match(details.children[0].textContent, /NOAA-charted U.S. waters/);
  assert.match(details.children[0].textContent, /Reference display only/);
  assert.match(details.children[0].textContent, /Credit: NOAA Office/);
  assert.equal(details.children[1].rel, 'noopener noreferrer');
  env.controls.render('esri-topo');
  assert.match(details.children[0].textContent, /Legacy raster.*2029/);
  env.controls.render('osm');
  assert.equal(details.hidden, true);
  assert.equal(details.children.length, 0);
  env.controls.destroy();
  assert.deepEqual(env.parent.children, [env.chips]);
});
