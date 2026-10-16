import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CotXmlError,
  XML_LIMITS,
  childElement,
  descendantElements,
  escapeXmlAttribute,
  parseXmlDocument,
  parseXmlFragment,
  serializeXmlElement,
} from './xml.js';

test('parses elements, attributes, text, CDATA, comments and a declaration', () => {
  const root = parseXmlDocument(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<!-- lead -->' +
      '<a x="1" y=\'two\'><b/><c>hi &amp; <![CDATA[<raw>]]> &#x41;&#66;</c></a>',
  );
  assert.equal(root.name, 'a');
  assert.equal(root.attrs.x, '1');
  assert.equal(root.attrs.y, 'two');
  assert.equal(Object.getPrototypeOf(root.attrs), null);
  assert.equal(childElement(root, 'c').text, 'hi & <raw> AB');
  assert.equal(root.children.length, 2);
});

test('attribute values may contain ">" and normalise literal whitespace', () => {
  const root = parseXmlDocument('<a note="x > y\tz\nw"/>');
  assert.equal(root.attrs.note, 'x > y z w');
});

test('namespaced names expose a local name', () => {
  const root = parseXmlDocument(
    '<ns:event xmlns:ns="urn:x"><ns:point/></ns:event>',
  );
  assert.equal(root.localName, 'event');
  assert.equal(root.children[0].localName, 'point');
});

test('fragments hold several roots; descendant search does not recurse into matches', () => {
  const roots = parseXmlFragment(
    '<event uid="1"/>\n<events><event uid="2"/><x><event uid="3"/></x></events>',
  );
  assert.equal(roots.length, 2);
  assert.deepEqual(
    descendantElements(roots, 'event').map((e) => e.attrs.uid),
    ['1', '2', '3'],
  );
});

test('refuses DTDs, entity declarations and undeclared entities (XXE / billion laughs)', () => {
  assert.throws(
    () => parseXmlFragment('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'),
    /DTD/,
  );
  assert.throws(() => parseXmlFragment('<x><!ENTITY a "b"></x>'), /DTD/);
  assert.throws(() => parseXmlFragment('<x>&lol;</x>'), /Undeclared entity/);
  assert.throws(() => parseXmlFragment('<x a="&ext;"/>'), /Undeclared entity/);
});

test('refuses malformed markup', () => {
  for (const bad of [
    '<a>',
    '<a></b>',
    '</a>',
    '<a b></a>',
    '<a b=c/>',
    '<a b="1" b="2"/>',
    '<a b="<"/>',
    '<1a/>',
    'text<a/>',
    '<a>&</a>',
    '<a>&#0;</a>',
    '<a>&#xD800;</a>',
    '<a><!-- open',
    '<a><![CDATA[open',
  ]) {
    assert.throws(() => parseXmlFragment(bad), CotXmlError, bad);
  }
});

test('enforces depth, element, attribute and text limits', () => {
  const deep =
    '<a>'.repeat(XML_LIMITS.maxDepth + 1) +
    '</a>'.repeat(XML_LIMITS.maxDepth + 1);
  assert.throws(() => parseXmlFragment(deep), /depth/);
  assert.throws(
    () =>
      parseXmlFragment('<a>' + '<b/>'.repeat(50) + '</a>', { maxNodes: 10 }),
    /too many elements/,
  );
  const attrs = Array.from({ length: 5 }, (_, i) => `a${i}="1"`).join(' ');
  assert.throws(
    () => parseXmlFragment(`<x ${attrs}/>`, { maxAttributes: 4 }),
    /Too many attributes/,
  );
  assert.throws(
    () =>
      parseXmlFragment(`<x a="${'v'.repeat(20)}"/>`, {
        maxAttributeLength: 10,
      }),
    /length limit/,
  );
  assert.throws(
    () => parseXmlFragment(`<x>${'t'.repeat(20)}</x>`, { maxTextLength: 10 }),
    /length limit/,
  );
});

test('serialisation escapes values and round-trips', () => {
  const xml = serializeXmlElement({
    name: 'a',
    attrs: { q: 'say "hi" & <bye>\n', skip: undefined },
    children: [{ name: 'b', attrs: {}, children: [], text: '1 < 2 & 3' }],
  });
  assert.equal(
    xml,
    '<a q="say &quot;hi&quot; &amp; &lt;bye&gt;&#10;"><b>1 &lt; 2 &amp; 3</b></a>',
  );
  const parsed = parseXmlDocument(xml);
  assert.equal(parsed.attrs.q, 'say "hi" & <bye>\n');
  assert.equal(parsed.children[0].text, '1 < 2 & 3');
});

test('serialisation refuses names that could inject markup and strips invalid chars', () => {
  assert.throws(
    () => serializeXmlElement({ name: 'a><script', attrs: {} }),
    CotXmlError,
  );
  assert.throws(
    () => serializeXmlElement({ name: 'a', attrs: { 'x="1" y': '2' } }),
    CotXmlError,
  );
  assert.equal(escapeXmlAttribute('a\u0000b\u0001c'), 'abc');
});
