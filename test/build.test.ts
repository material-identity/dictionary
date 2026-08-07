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

const MP1 = '93946327-ccc4-4581-ac7c-229ea5c2f832'; // maxPressure v1, tombstoned
const MP2 = '450ecc7b-4cb6-4abf-bacb-35661132d321'; // maxPressure v2, active
const UNIT = '5e50004e-7e03-40f6-933e-b63708c9ab47'; // megapascal
const CM = 'ca087cb9-f189-41a1-b082-2288eaacd5e7'; // maxPressure concept

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

test('build emits JSON + HTML for every entry and concept, plus the stylesheet', () => {
  const out = buildGreen();
  try {
    const defs = readdirSync(join(out, 'def')).sort();
    const concepts = readdirSync(join(out, 'concept')).sort();
    assert.equal(defs.length, 14); // 7 entries × (json + html)
    assert.equal(concepts.length, 12); // 6 concepts × (json + html)
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
    assert.deepEqual(Object.keys(entry).slice(0, 5), ['id', 'isVersionOf', 'version', 'replaces', 'isDefinedBy']);
    assert.deepEqual(Object.keys(entry.definitionStandard), ['name', 'clause', 'uri']);

    const concept = JSON.parse(readFileSync(join(out, 'concept', `${CM}.json`), 'utf8'));
    assert.deepEqual(Object.keys(concept.versions[0]), ['version', 'entry', 'status', 'deprecatedOn', 'replacedBy']);

    const ajv = new Ajv2019({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(here, '..', 'schema', 'dictionary-entry.schema.json'), 'utf8')));
    for (const dir of ['def', 'concept']) {
      for (const name of readdirSync(join(out, dir)).filter((n) => n.endsWith('.json'))) {
        const doc = JSON.parse(readFileSync(join(out, dir, name), 'utf8'));
        assert.ok(validate(doc), `${dir}/${name} violates the schema: ${JSON.stringify(validate.errors)}`);
      }
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

test('superseded entry page shows the banner sourced from the concept', () => {
  const out = buildGreen();
  try {
    const v1 = readFileSync(join(out, 'def', `${MP1}.html`), 'utf8');
    assert.match(v1, /class="banner tombstoned"/);
    assert.match(v1, /tombstoned on 2026-07-01/);
    assert.match(v1, new RegExp(`Superseded by <a href="/def/${MP2}">Maximum allowable pressure</a>`));

    const v2 = readFileSync(join(out, 'def', `${MP2}.html`), 'utf8');
    assert.ok(!v2.includes('class="banner'), 'active version carries no banner');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('internal references render as links with resolved labels', () => {
  const out = buildGreen();
  try {
    const v2 = readFileSync(join(out, 'def', `${MP2}.html`), 'utf8');
    assert.match(v2, new RegExp(`<a href="/def/${UNIT}">megapascal</a>`)); // unit link shows the unit's preferredName
    assert.match(v2, new RegExp(`<a href="/concept/${CM}">Maximum allowable pressure</a>`)); // concept link
    assert.match(v2, new RegExp(`<a href="/def/${MP2}.json">Raw JSON</a>`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('concept page renders the version table with status, dates, replacedBy', () => {
  const out = buildGreen();
  try {
    const html = readFileSync(join(out, 'concept', `${CM}.html`), 'utf8');
    assert.match(html, /<span class="status tombstoned">tombstoned<\/span>/);
    assert.match(html, /<span class="status active">active<\/span>/);
    assert.match(html, /2026-07-01/);
    assert.match(html, new RegExp(`<a href="/def/${MP2}">`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('every HTML page carries the alternate JSON link, a canonical link to the real domain, a stylesheet link, and no scripts', () => {
  const out = buildGreen();
  try {
    for (const dir of ['def', 'concept']) {
      for (const name of readdirSync(join(out, dir)).filter((n) => n.endsWith('.html'))) {
        const html = readFileSync(join(out, dir, name), 'utf8');
        const stem = name.replace(/\.html$/, '');
        assert.ok(html.includes(`<link rel="alternate" type="application/json" href="/${dir}/${stem}.json">`), `${dir}/${name} alternate link`);
        assert.ok(html.includes(`<link rel="canonical" href="https://material-identity.eu/${dir}/${stem}">`), `${dir}/${name} canonical link`);
        assert.ok(html.includes('<link rel="stylesheet" href="/styles.css">'), `${dir}/${name} stylesheet`);
        assert.ok(!/<script/i.test(html), `${dir}/${name} must not contain scripts`);
        assert.ok(!/noindex/i.test(html), `${dir}/${name} must not de-index the real canonical domain`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('build refuses an unloadable repo; empty tree builds an empty site', () => {
  assert.throws(() => build(join(fixtures, 'red-yaml'), mkdtempSync(join(tmpdir(), 'dict-site-'))), /unloadable repo/);

  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  try {
    const result = build(join(fixtures, 'empty'), out);
    assert.deepEqual({ entries: result.entries, concepts: result.concepts }, { entries: 0, concepts: 0 });
    assert.deepEqual(readdirSync(join(out, 'def')), []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
