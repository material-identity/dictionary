import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, EXAMPLES_PATH, loadExampleSpecs } from '../scripts/build.ts';
import { DEF_PREFIX, type RepoModel } from '../scripts/lib/repo.ts';
import { RefIndex, renderExamplesPage } from '../scripts/lib/render.ts';

// Reference examples (#130): content specifications that use the dictionary, served at /examples/.
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SPEC_DIR = join(EXAMPLES_PATH, 'content-specifications');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every `dictionaryReference` value anywhere in a document, nested memberships and items included. */
function dictionaryReferences(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(dictionaryReferences);
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => (k === 'dictionaryReference' ? [String(v)] : dictionaryReferences(v)));
}

test('every dictionaryReference in an example content specification resolves to a published entry', () => {
  const files = readdirSync(SPEC_DIR).filter((n) => n.endsWith('.json'));
  assert.ok(files.length > 0, 'examples/content-specifications/ holds no specification');
  for (const name of files) {
    const refs = dictionaryReferences(JSON.parse(readFileSync(join(SPEC_DIR, name), 'utf8')));
    assert.ok(refs.length > 0, `${name} references no dictionary entry`);
    for (const ref of refs) {
      assert.ok(ref.startsWith(DEF_PREFIX), `${name}: ${ref} is not a ${DEF_PREFIX}<uuid> reference`);
      const uuid = ref.slice(DEF_PREFIX.length);
      assert.match(uuid, UUID, `${name}: ${ref} does not end in a UUIDv4`);
      assert.ok(existsSync(join(ROOT, 'published', `${uuid}.yaml`)), `${name}: ${ref} has no published/${uuid}.yaml`);
    }
  }
});

test('the reference walk finds nested memberships and collection items', () => {
  const doc = { elements: [{ dictionaryReference: 'a', elements: [{ dictionaryReference: 'b' }], item: { dictionaryReference: 'c' } }] };
  assert.deepEqual(dictionaryReferences(doc), ['a', 'b', 'c']);
});

test('the build copies examples/ byte-for-byte and renders the /examples/ page', () => {
  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  try {
    build(join(here, 'fixtures', 'green'), out);
    for (const name of readdirSync(SPEC_DIR)) {
      assert.deepEqual(readFileSync(join(out, 'examples', 'content-specifications', name)), readFileSync(join(SPEC_DIR, name)));
    }
    const html = readFileSync(join(out, 'examples', 'index.html'), 'utf8');
    assert.match(html, /<link rel="canonical" href="https:\/\/material-identity\.eu\/examples\/">/);
    assert.match(html, /Nothing on this page is part of the dictionary/);
    assert.match(html, /<a href="https:\/\/github\.com\/material-identity\/schema" rel="external">/);
    assert.ok(!/<script/i.test(html));

    const steel = 'dpp-steel-v0.0.2.lock.json';
    const sha = createHash('sha256').update(readFileSync(join(SPEC_DIR, steel))).digest('hex');
    assert.ok(html.includes(`<code>${sha}</code>`), 'the page shows the hash of the served bytes');
    assert.match(html, /CC-BY-4\.0 — its own licence, not this dictionary's CC0/);
    assert.match(html, /<code>v2026\.10\.01<\/code>/);
    assert.ok(html.includes(`<a href="/examples/content-specifications/${steel}">`));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the examples page renders memberships, nested paths, items and conditions', () => {
  const repo: RepoModel = { root: '/synthetic', drafts: [], published: [], errors: [] };
  const html = renderExamplesPage([{
    path: 'content-specifications/x.json',
    sha256: 'ab',
    doc: {
      title: { en: 'Demo spec' },
      dictionary: { release: 'v1' },
      elements: [{
        elementId: 'list', dictionaryReference: `${DEF_PREFIX}00000000-0000-4000-8000-000000000001`, objectType: 'MultiValuedDataElement',
        isMandatory: false, accessCategory: 'public', granularity: 'batch', condition: { en: 'When <present>' },
        item: { elementId: 'entry', dictionaryReference: `${DEF_PREFIX}00000000-0000-4000-8000-000000000002`, objectType: 'DataElementCollection',
          elements: [{ elementId: 'leaf', dictionaryReference: `${DEF_PREFIX}00000000-0000-4000-8000-000000000003`, isMandatory: true }] },
      }],
    },
  }], new RefIndex(repo));
  assert.match(html, /<h2>Demo spec<\/h2>/);
  assert.match(html, /<code>list<\/code>/);
  assert.match(html, /<code>list\[\] \/ entry<\/code>/);
  assert.match(html, /<code>list\[\] \/ entry \/ leaf<\/code>/);
  assert.match(html, /optional<br><span class="meta">When &lt;present&gt;<\/span>/);
  assert.match(html, /Licence<\/th><td>see the source repository/);

  const empty = renderExamplesPage([], new RefIndex(repo));
  assert.match(empty, /No examples in this build/);
  assert.deepEqual(loadExampleSpecs(join(here, 'fixtures', 'empty')), []);
});
