import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');
const FONT_MANIFEST = path.join(REPO_ROOT, 'public/fonts/provenance.json');
const FONT_CSS = path.join(REPO_ROOT, 'public/fonts/gev-fonts.css');

/** The glyph written as element text: `<span class="material-symbols-outlined">radar</span>`. */
const SPAN_TEXT =
  /class="[^"]*material-symbols-outlined[^"]*"[^>]*>\s*([a-z0-9_]+)\s*</g;
/** A whole `textContent =` statement, across lines, so a multi-line ternary is read once. */
const TEXT_ASSIGNMENT = /(?:textContent|innerText)\s*=\s*([^;]{0,400})/gs;
const STRING_LITERAL = /['"`]([a-z0-9_]{2,})['"`]/g;

/**
 * Files that SHIP markup. Tests assert on markup, they do not render it.
 *
 * The panel markup lives in `src/ui/templates/*.html`, so HTML under `src` is
 * read as well: a glyph named only in a template is still a glyph the font has
 * to carry.
 */
function sourceFiles(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (
      entry.isFile() &&
      /\.(js|mjs|html)$/.test(entry.name) &&
      !entry.name.endsWith('.test.mjs')
    ) {
      files.push(absolute);
    }
  }
  return [...files.sort(), INDEX_HTML];
}

/**
 * Glyph names the sources ask the icon font for.
 *
 * Errs WIDE on purpose. A name the font does not carry costs nothing — Google
 * ignores an unknown `icon_names` entry and still returns 200 — while a glyph
 * the subset is missing breaks the interface SILENTLY: the ligature never
 * forms, so the element renders the literal word `right_panel_open` instead of
 * falling back to a visible box.
 *
 * A literal to the LEFT of a `?` is the condition being tested, not the text
 * being shown, so it is dropped: `status === 'loading' ? …` must not enrol
 * `loading`. Optional chaining is neutralised first — `payload?.newsStatus`
 * is not a ternary, and splitting on its `?` would keep the condition.
 * @returns {Map<string, string>} glyph -> the first file that names it.
 */
function referencedGlyphs() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const add = (glyph) => {
      if (!found.has(glyph)) found.set(glyph, relative);
    };
    for (const match of source.matchAll(SPAN_TEXT)) add(match[1]);
    for (const match of source.matchAll(TEXT_ASSIGNMENT)) {
      const statement = match[1].replaceAll('?.', '.');
      const assigned = statement.includes('?')
        ? statement.slice(statement.indexOf('?') + 1)
        : statement;
      for (const literal of assigned.matchAll(STRING_LITERAL)) add(literal[1]);
    }
  }
  return found;
}

/**
 * The exact icon_names request used to obtain the self-hosted font subset.
 * The unchanged source scanner intentionally overapproximates icon names:
 * fallback text such as "absent" is included in the request, while Google
 * ignores unsupported names. This inventory is not a count of actual glyphs.
 */
function subsettedGlyphs() {
  const manifest = JSON.parse(readFileSync(FONT_MANIFEST, 'utf8'));
  const names = manifest.materialSymbols?.requestedIconNames;
  assert(
    Array.isArray(names) && names.length > 0,
    'Local font provenance must retain the requested icon inventory',
  );
  assert(
    names.every(
      (name) => typeof name === 'string' && /^[a-z0-9_]+$/.test(name),
    ),
  );
  assert.equal(
    new Set(names).size,
    names.length,
    'Icon inventory must not contain duplicates',
  );
  assert.deepEqual(
    names,
    [...names].sort(),
    'Official icon subset names must stay alphabetically sorted',
  );
  const request = manifest.cssSources
    .map((source) => new URL(source.url))
    .find((url) =>
      url.searchParams
        .getAll('family')
        .some((family) => family.startsWith('Material Symbols Outlined:')),
    );
  assert(
    request,
    'Retain the original official Material Symbols subset request for provenance',
  );
  assert.equal(request.origin, 'https://fonts.googleapis.com');
  assert.deepEqual(
    request.searchParams.get('icon_names')?.split(','),
    names,
    'Declared icons must match the original font-source request',
  );
  return new Set(names);
}

test('every glyph the sources render is retained in the self-hosted icon subset', () => {
  const subset = subsettedGlyphs();
  const missing = [...referencedGlyphs()]
    .filter(([glyph]) => !subset.has(glyph))
    .map(([glyph, file]) => `${glyph} (${file})`);

  assert.deepEqual(
    missing,
    [],
    'Glyphs named by the sources but absent from the local font inventory. ' +
      'Refresh the official subset and provenance together — an unlisted glyph renders as its own name on screen: ' +
      missing.join(', '),
  );
});

test('the unused Material Icons Round family is not loaded', () => {
  // A second icon font, 173 kB, for a family no source ever uses — and
  // src/cockpitMarkup.test.mjs already asserts the markup must not use it.
  const html =
    readFileSync(INDEX_HTML, 'utf8') + readFileSync(FONT_CSS, 'utf8');
  assert.doesNotMatch(
    html,
    /Material(?:\+| )Icons(?:\+| )Round/,
    'index.html loads an icon font nothing renders',
  );
});

test('self-hosted typography preserves weights, Unicode subsets and licensed binary integrity without foreign CSS requests', () => {
  const manifest = JSON.parse(readFileSync(FONT_MANIFEST, 'utf8')),
    css = readFileSync(FONT_CSS, 'utf8'),
    html = readFileSync(INDEX_HTML, 'utf8');
  assert.equal(manifest.schemaVersion, 1);
  assert.match(html, /href="\/fonts\/gev-fonts\.css"/);
  assert.doesNotMatch(html, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  const expected = {
    Inter: {
      weights: [300, 400, 500, 600],
      subsets: [
        'cyrillic',
        'cyrillic-ext',
        'greek',
        'greek-ext',
        'latin',
        'latin-ext',
        'vietnamese',
      ],
    },
    'JetBrains Mono': {
      weights: [300, 400, 500, 600, 700],
      subsets: [
        'cyrillic',
        'cyrillic-ext',
        'greek',
        'latin',
        'latin-ext',
        'vietnamese',
      ],
    },
    'Material Symbols Outlined': { weights: [400], subsets: ['subset'] },
  };
  const cssAssets = new Set(),
    weights = new Map();
  for (const match of css.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const block = match[1],
      family = /font-family:\s*['"]([^'"]+)['"]/.exec(block)?.[1],
      weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1]);
    assert(expected[family], `Unexpected application font family ${family}`);
    if (!weights.has(family)) weights.set(family, new Set());
    weights.get(family).add(weight);
    const source = /url\(([^)]+)\)/
      .exec(block)?.[1]
      .replace(/^['"]|['"]$/g, '');
    const url = new URL(source, 'https://gev.invalid/fonts/gev-fonts.css');
    assert.equal(url.origin, 'https://gev.invalid');
    assert(url.pathname.startsWith('/fonts/'));
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    cssAssets.add(url.pathname);
  }
  for (const [family, entry] of Object.entries(expected)) {
    assert.deepEqual(
      [...(weights.get(family) || [])].sort((a, b) => a - b),
      entry.weights,
      `${family} keeps existing requested weights`,
    );
    assert.deepEqual(
      manifest.assets
        .filter((asset) => asset.family === family)
        .map((asset) => asset.subset)
        .sort(),
      entry.subsets,
      `${family} keeps existing Unicode coverage`,
    );
  }
  assert.deepEqual(
    [...cssAssets].sort(),
    manifest.assets.map((asset) => asset.path).sort(),
    'Every shipped font is referenced locally and every CSS font is inventoried',
  );
  let total = 0;
  for (const entry of [
    ...manifest.assets,
    ...manifest.licenses,
    manifest.stylesheet,
  ]) {
    assert(
      /^\/fonts\/[A-Za-z0-9_./-]+$/.test(entry.path) &&
        !entry.path.includes('..'),
      'Local font file path must stay within its bundle',
    );
    const bytes = readFileSync(path.join(REPO_ROOT, 'public', entry.path));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
      `${entry.path} matches audited bytes`,
    );
    if (entry.bytes !== undefined) assert.equal(bytes.length, entry.bytes);
    if (entry.path.endsWith('.woff2')) {
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2');
      total += bytes.length;
      assert.equal(
        new URL(entry.sourceUrl).origin,
        'https://fonts.gstatic.com',
      );
    }
  }
  assert.equal(total, manifest.fontBytes);
  assert(
    total <= 512 * 1024,
    'Existing typography stays within its bounded offline font budget',
  );
  assert.deepEqual(manifest.materialSymbols.axes, {
    opsz: 20,
    wght: 400,
    FILL: 0,
    GRAD: 0,
  });
  assert.equal(manifest.licenses.length, 3);
  for (const license of manifest.licenses) {
    const text = readFileSync(
      path.join(REPO_ROOT, 'public', license.path),
      'utf8',
    );
    assert.match(
      text,
      license.family === 'Material Symbols Outlined'
        ? /Apache License[\s\S]*Version 2\.0/
        : /SIL OPEN FONT LICENSE Version 1\.1/,
    );
  }
});
