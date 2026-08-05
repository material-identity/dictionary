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
  assert.equal(lines.filter((l) => l.startsWith('ok')).length, 5);
});

test('runValidation reports failure with file and message for a red tree', () => {
  const { ok, lines } = runValidation(join(fixtures, 'red-pinning'));
  assert.equal(ok, false);
  const output = lines.join('\n');
  assert.match(output, /FAIL\s+check 5 — pinning/);
  assert.match(output, /published\/3bf4310f-181c-4bc7-9fb8-83f08b55a1bb\.yaml/);
  assert.match(output, /ok\s+check 2 — schema/);
});

test('runValidation is green on a tree with no content directories (fresh repo)', () => {
  const { ok } = runValidation(join(fixtures, 'empty'));
  assert.equal(ok, true);
});
