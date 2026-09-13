import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2019Module from 'ajv/dist/2019.js';
import addFormatsModule from 'ajv-formats';
import { build } from '../scripts/build.ts';
import { canonicalJson } from '../scripts/lib/emit.ts';

const Ajv2019 = (Ajv2019Module as unknown as { default?: typeof Ajv2019Module }).default ?? Ajv2019Module;
const addFormats = (addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule;

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const GREEN = join(fixtures, 'green');

const MP1 = '73425bc9-3734-4f26-a647-89fd8d9e435d'; // maxPressure v1, superseded
const MP2 = 'c38a85eb-1a37-416d-ab21-7ddcc599754d'; // maxPressure v2, current
const UNIT = '50e8081d-3319-4cd5-8edb-a26cb6bd8078'; // megapascal

function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else {
        hash.update(p.slice(dir.length));
        hash.update(readFileSync(p));
      }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function buildGreen(): string {
  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  build(GREEN, out);
  return out;
}

test('build emits JSON + HTML for every entry, plus the stylesheet', () => {
  const out = buildGreen();
  try {
    const defs = readdirSync(join(out, 'def')).sort();
    assert.equal(defs.length, 21); // 7 entries × (json + html + csl.json)
    assert.ok(defs.includes(`${MP2}.json`) && defs.includes(`${MP2}.html`));
    assert.ok(readFileSync(join(out, 'styles.css'), 'utf8').length > 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('two consecutive builds are byte-identical', () => {
  const a = buildGreen();
  const b = buildGreen();
  try {
    assert.equal(hashTree(a), hashTree(b));
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('emitted JSON is canonical: identity block first, nested keys ordered, schema-valid', () => {
  const out = buildGreen();
  try {
    const entry = JSON.parse(readFileSync(join(out, 'def', `${MP2}.json`), 'utf8'));
    assert.deepEqual(Object.keys(entry).slice(0, 3), ['id', 'replaces', 'isDefinedBy']);
    assert.deepEqual(Object.keys(entry.definitionStandard), ['name', 'clause', 'uri']);
    assert.equal(entry.version, undefined);
    assert.equal(entry.isVersionOf, undefined);

    const ajv = new Ajv2019({ allErrors: true, strict: false });
    addFormats(ajv);
    const validateSchema = ajv.compile(JSON.parse(readFileSync(join(here, '..', 'schema', 'dictionary-entry.schema.json'), 'utf8')));
    for (const name of readdirSync(join(out, 'def')).filter((n) => n.endsWith('.json') && !n.endsWith('.csl.json'))) {
      const doc = JSON.parse(readFileSync(join(out, 'def', name), 'utf8'));
      assert.ok(validateSchema(doc), `def/${name} violates the schema: ${JSON.stringify(validateSchema.errors)}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('canonicalJson output ends with a newline and is stable for unknown keys', () => {
  const a = canonicalJson({ zebra: 1, id: 'x', alpha: { b: 1, a: 2 } });
  assert.ok(a.endsWith('}\n'));
  assert.deepEqual(Object.keys(JSON.parse(a)), ['id', 'alpha', 'zebra']);
});

test('superseded entry page shows the banner, derived from replaces, never stored', () => {
  const out = buildGreen();
  try {
    const v1 = readFileSync(join(out, 'def', `${MP1}.html`), 'utf8');
    assert.match(v1, /class="banner superseded"/);
    assert.match(v1, new RegExp(`Superseded by <a href="/def/${MP2}">Maximum allowable pressure</a>`));

    const v2 = readFileSync(join(out, 'def', `${MP2}.html`), 'utf8');
    assert.ok(!v2.includes('class="banner'), 'current version carries no banner');
    assert.match(v2, new RegExp(`<a href="/def/${MP1}">Maximum allowable pressure</a>`)); // its own replaces row
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('internal references render as links with resolved labels', () => {
  const out = buildGreen();
  try {
    const v2 = readFileSync(join(out, 'def', `${MP2}.html`), 'utf8');
    assert.match(v2, new RegExp(`<a href="/def/${UNIT}">megapascal</a>`)); // unit link shows the unit's preferredName
    assert.match(v2, new RegExp(`<a href="/def/${MP2}.json"[^>]*>Raw JSON</a>`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('every HTML page carries a canonical link, a stylesheet link, and no scripts', () => {
  const out = buildGreen();
  try {
    for (const name of readdirSync(join(out, 'def')).filter((n) => n.endsWith('.html'))) {
      const html = readFileSync(join(out, 'def', name), 'utf8');
      const stem = name.replace(/\.html$/, '');
      assert.ok(html.includes(`<link rel="alternate" type="application/json" href="/def/${stem}.json">`), `def/${name} alternate link`);
      assert.ok(html.includes(`<link rel="canonical" href="https://material-identity.eu/def/${stem}">`), `def/${name} canonical link`);
      assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">'), `def/${name} stylesheet`);
      assert.ok(!/<script/i.test(html), `def/${name} must not contain scripts`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('index lists only current entries — superseded maxPressure v1 is omitted', () => {
  const out = buildGreen();
  try {
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.equal((html.match(/<tr>\n<td>/g) ?? []).length, 6); // 7 published, 1 superseded
    assert.match(html, new RegExp(`<a href="/def/${MP2}">Maximum allowable pressure</a>`));
    assert.ok(!html.includes(`/def/${MP1}"`), 'superseded v1 must not appear in the index');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('tree view: containment-only nesting, superseded omitted, badges from the membership, no scripts', () => {
  const ROUTE = '4eae703a-fa15-4118-8bc4-7926a22a12fb'; // steelmakingRoute
  const EAF = '5ed29113-a426-4b6d-a790-e6c8268b9e52'; // its Value
  const COLLECTION = '2f3de2bb-0588-4513-bfc3-41d021815a81'; // mechanicalProperties
  const out = buildGreen();
  try {
    const html = readFileSync(join(out, 'tree', 'index.html'), 'utf8');
    assert.ok(html.includes('<link rel="canonical" href="https://material-identity.eu/tree">'));
    assert.ok(!/<script/i.test(html), 'tree page must not contain scripts');

    // roots = current entries nothing contains: pressure, mechanicalProperties, steelmakingRoute, megapascal
    assert.equal((html.match(/<details open>/g) ?? []).length, 4);
    assert.match(html, /2 element roots · 2 units and quantities/);

    // two sections: elements/collections first, reference-only kinds (units, quantities) after
    const units = html.indexOf('<h2>Units and quantities</h2>');
    assert.ok(html.indexOf('<h2>Elements and collections</h2>') < units, 'elements section precedes units');
    assert.ok(html.indexOf(`/def/${COLLECTION}"`) < units && html.indexOf(`/def/${ROUTE}"`) < units, 'elements listed in the first section');
    assert.ok(html.lastIndexOf(`<summary>megapascal`) > units && html.lastIndexOf(`<summary>pressure`) > units, 'units and quantities listed in the second section');

    // maxPressure v2 nests under mechanicalProperties with the membership badge; v1 (superseded) appears nowhere
    const collectionAt = html.indexOf('<summary>Mechanical properties');
    const memberAt = html.indexOf('<summary>Maximum allowable pressure');
    assert.ok(collectionAt !== -1 && collectionAt < memberAt, 'member summary renders inside its collection');
    assert.match(html, /<summary>Maximum allowable pressure <code>maxPressure<\/code> <span class="chip element">SingleValuedDataElement<\/span> <span class="badge">mandatory<\/span><\/summary>/);
    assert.match(html, new RegExp(`<a href="/def/${MP2}" aria-label="Entry page: Maximum allowable pressure">entry page</a>`));
    assert.ok(!html.includes(MP1), 'superseded entry must not appear in the tree');

    // the enumeration Value nests under its element (badge "value") and is not a root
    assert.match(html, /<summary>Electric arc furnace <span class="chip value">Value<\/span> <span class="badge">value<\/span><\/summary>/);
    assert.equal((html.match(new RegExp(`<a href="/def/${EAF}"`, 'g')) ?? []).length, 1);
    assert.ok(html.indexOf(`/def/${ROUTE}"`) < html.indexOf(`/def/${EAF}"`), 'value renders inside its element');

    // reference edges stay links, never children: the unit shows in maxPressure's facts, and megapascal is its own root
    assert.match(html, new RegExp(`unit <a href="/def/${UNIT}">megapascal</a>`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('design pass: masthead on every page, breadcrumb and grouped facts on entry pages, kind chips in the index', () => {
  const COLLECTION = '2f3de2bb-0588-4513-bfc3-41d021815a81'; // mechanicalProperties, contains maxPressure v2
  const out = buildGreen();
  try {
    const index = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(index, /<nav class="nav" aria-label="Site"><a href="\/" aria-current="page">Index<\/a><a href="\/tree">Tree<\/a>/);
    assert.match(index, /<td><span class="chip element">SingleValuedDataElement<\/span><\/td>/);
    assert.match(index, /<td><span class="chip unit">MeasurementUnit<\/span><\/td>/);

    const v2 = readFileSync(join(out, 'def', `${MP2}.html`), 'utf8');
    assert.match(v2, /<header class="mast">/);
    assert.match(v2, new RegExp(`<nav aria-label="Breadcrumb"><ol class="crumbs"><li><a href="/">Dictionary</a></li><li><a href="/def/${COLLECTION}">Mechanical properties</a></li><li>Maximum allowable pressure</li></ol></nav>`));
    assert.match(v2, /<div class="chips"><span class="chip element">SingleValuedDataElement<\/span> <span class="chip neutral"><code>maxPressure<\/code><\/span><\/div>/);
    assert.match(v2, /<p class="alt-name"><span class="lang">de<\/span><span lang="de">Maximal zulässiger Druck<\/span><\/p>/);
    assert.match(v2, /<div class="definition"><span class="lang">en<\/span><p lang="en">Highest internal gauge pressure/);
    assert.match(v2, /<p class="missing">No German definition yet/);
    assert.match(v2, new RegExp(`<dt>Unit</dt><dd><span class="ref"><a href="/def/${UNIT}">megapascal</a> <code>MPa</code> <span class="chip unit">MeasurementUnit</span></span></dd>`));
    assert.match(v2, new RegExp(`<h2>Contained by</h2><div class="member"><span class="ref"><a href="/def/${COLLECTION}">Mechanical properties</a> <span class="chip collection">DataElementCollection</span></span> <span class="badge">mandatory</span></div>`));
    assert.match(v2, /<meta name="description" content="Highest internal gauge pressure/);
    assert.match(v2, /<span class="eyebrow">Dictionary element id · immutable<\/span>/);
    assert.match(v2, new RegExp(`<dt>Replaces</dt><dd><span class="ref"><a href="/def/${MP1}">Maximum allowable pressure</a>`));

    // a unit page shows its symbol upright; a superseded page keeps the banner
    const unit = readFileSync(join(out, 'def', `${UNIT}.html`), 'utf8');
    assert.match(unit, /<p class="symbol-block"><span class="symbol-cap">symbol<\/span><span class="symbol upright">MPa<\/span><\/p>/);
    assert.match(readFileSync(join(out, 'def', `${MP1}.html`), 'utf8'), /class="banner superseded"/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('cite: ISO 690 + BibLaTeX block on the page, CSL-JSON artifact, superseded entries say what replaced them', () => {
  const out = buildGreen();
  try {
    const v2 = readFileSync(join(out, 'def', `${MP2}.html`), 'utf8');
    assert.match(v2, /<details class="cite"><summary>Cite this entry<\/summary>/);
    // fixture tree is not a git work-tree top: no invented date
    assert.match(v2, new RegExp(`<p class="iso690">material-identity dictionary\\. Maximum allowable pressure \\(maxPressure\\) \\[dictionary element\\]\\. n\\.d\\. Available from: https://material-identity\\.eu/def/${MP2}</p>`));
    assert.match(v2, /<pre><code>@online\{material-identity-maxPressure,\n  title {8}= \{Maximum allowable pressure\},\n  organization = \{material-identity dictionary\},\n  url {10}= \{https:\/\/material-identity\.eu\/def\//);
    assert.ok(!v2.includes('urldate'), 'no access date by design');
    assert.ok(v2.includes(`<link rel="alternate" type="application/vnd.citationstyles.csl+json" href="/def/${MP2}.csl.json">`));

    const csl = JSON.parse(readFileSync(join(out, 'def', `${MP2}.csl.json`), 'utf8'));
    assert.equal(csl.type, 'entry-dictionary');
    assert.equal(csl.title, 'Maximum allowable pressure');
    assert.equal(csl.URL, `https://material-identity.eu/def/${MP2}`);
    assert.equal(csl.issued, undefined);

    const v1 = readFileSync(join(out, 'def', `${MP1}.html`), 'utf8');
    assert.match(v1, new RegExp(`\\[dictionary element, superseded by https://material-identity\\.eu/def/${MP2}\\]\\. n\\.d\\. Available from: https://material-identity\\.eu/def/${MP1}</p>`));
    assert.match(v1, new RegExp(`note {9}= \\{Immutable dictionary element; superseded entries stay resolvable\\. Superseded by https://material-identity\\.eu/def/${MP2}\\.\\},`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('index footer links to the tree view', () => {
  const out = buildGreen();
  try {
    assert.match(readFileSync(join(out, 'index.html'), 'utf8'), /<a href="\/tree">Tree view<\/a>/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('build refuses an unloadable repo; empty tree builds an empty site', () => {
  assert.throws(() => build(join(fixtures, 'red-yaml'), mkdtempSync(join(tmpdir(), 'dict-site-'))), /unloadable repo/);

  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  try {
    const result = build(join(fixtures, 'empty'), out);
    assert.equal(result.entries, 0);
    assert.deepEqual(readdirSync(join(out, 'def')), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
