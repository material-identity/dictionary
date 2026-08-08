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
    assert.equal(defs.length, 14); // 7 entries × (json + html)
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
    for (const name of readdirSync(join(out, 'def')).filter((n) => n.endsWith('.json'))) {
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
    assert.match(v2, new RegExp(`<a href="/def/${MP2}.json">Raw JSON</a>`));
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
