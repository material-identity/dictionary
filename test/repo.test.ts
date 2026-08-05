import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo, DEF_PREFIX, CONCEPT_PREFIX } from '../scripts/lib/repo.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('loadRepo loads the green tree into the full model', () => {
  const repo = loadRepo(join(fixtures, 'green'));
  assert.equal(repo.published.length, 7);
  assert.equal(repo.concepts.length, 6);
  assert.equal(repo.drafts.length, 1);
  assert.equal(repo.errors.length, 0);

  const entry = repo.published.find((f) => f.stem === '450ecc7b-4cb6-4abf-bacb-35661132d321');
  assert.ok(entry?.doc);
  assert.equal(entry.doc.shortName, 'maxPressure');
  assert.equal(entry.relPath, 'published/450ecc7b-4cb6-4abf-bacb-35661132d321.yaml');
  assert.equal(entry.dir, 'published');
});

test('missing directories yield empty collections (fresh repo passes)', () => {
  const repo = loadRepo(join(fixtures, 'empty'));
  assert.deepEqual(repo.drafts, []);
  assert.deepEqual(repo.published, []);
  assert.deepEqual(repo.concepts, []);
  assert.deepEqual(repo.errors, []);
});

test('malformed YAML surfaces as a readable error naming the file', () => {
  const repo = loadRepo(join(fixtures, 'red-yaml'));
  assert.equal(repo.errors.length, 1);
  assert.equal(repo.errors[0].file, 'published/broken.yaml');
  assert.match(repo.errors[0].message, /YAML|mapping/);
  const broken = repo.published.find((f) => f.name === 'broken.yaml');
  assert.ok(broken);
  assert.equal(broken.doc, undefined);
});

test('canonical URI constants', () => {
  assert.equal(DEF_PREFIX, 'https://material-identity.eu/def/');
  assert.equal(CONCEPT_PREFIX, 'https://material-identity.eu/concept/');
});
