import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runValidation } from '../scripts/validate.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('runValidation reports OK for the green tree', () => {
  const { ok, lines } = runValidation(join(fixtures, 'green'));
  assert.equal(ok, true);
  assert.equal(lines.filter((l) => l.startsWith('FAIL')).length, 0);
  // load + checks 2–5 pass; checks 1 and 6 are skipped (fixture trees have no git context)
  assert.equal(lines.filter((l) => l.startsWith('ok')).length, 5);
  assert.equal(lines.filter((l) => l.startsWith('skip')).length, 2);
});

test('runValidation reports failure with file and message for a red tree', () => {
  const { ok, lines } = runValidation(join(fixtures, 'red-pinning'));
  assert.equal(ok, false);
  const output = lines.join('\n');
  assert.match(output, /FAIL\s+check 5 — pinning/);
  assert.match(output, /published\/a10d88e9-6140-41b2-bc96-782abf0ce6db\.yaml/);
  assert.match(output, /ok\s+check 2 — schema/);
});

test('runValidation is green on a tree with no content directories (fresh repo)', () => {
  const { ok } = runValidation(join(fixtures, 'empty'));
  assert.equal(ok, true);
});
