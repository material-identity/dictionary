import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo, type RepoModel, type ValidationIssue } from '../scripts/lib/repo.ts';
import { checkSchema, checkIdentity, checkReplaces, checkPinning, runChecks } from '../scripts/lib/checks.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): RepoModel => loadRepo(join(fixtures, name));

const CHECKS = {
  '2 schema': checkSchema,
  '3 identity': checkIdentity,
  '4 replaces': checkReplaces,
  '5 pinning': checkPinning,
} as const;

/** Assert that exactly the targeted check fails and every other check stays green. */
function assertOnlyFails(repo: RepoModel, failing: keyof typeof CHECKS): ValidationIssue[] {
  let failingIssues: ValidationIssue[] = [];
  for (const [name, check] of Object.entries(CHECKS)) {
    const issues = check(repo);
    if (name === failing) {
      assert.ok(issues.length > 0, `expected check ${name} to fail`);
      failingIssues = issues;
    } else {
      assert.deepEqual(issues, [], `expected check ${name} to pass, got: ${JSON.stringify(issues)}`);
    }
  }
  return failingIssues;
}

test('green tree passes all checks', () => {
  const repo = load('green');
  for (const [name, check] of Object.entries(CHECKS)) {
    assert.deepEqual(check(repo), [], `check ${name} should pass on green`);
  }
});

test('check 2 — published entry violating the schema fails; draft with bad langMap fails', () => {
  const issues = assertOnlyFails(load('red-schema'), '2 schema');
  const files = issues.map((i) => i.file);
  assert.ok(files.includes('published/f447325a-411e-459f-a08d-83780bd293c9.yaml'), 'missing valueDataType flagged');
  assert.ok(files.includes('drafts/badDraft.yaml'), 'draft with invalid langMap key flagged');
});

test('check 3 — filename/id mismatch, wrong domain, invalid UUID, duplicate id', () => {
  const issues = assertOnlyFails(load('red-identity'), '3 identity');
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /7df8611d[^\n]*does not match id UUID/);
  assert.match(text, /f185d11e[^\n]*not canonical/);
  assert.match(text, /not-a-uuid\.yaml[^\n]*not an RFC 4122 v4 UUID/);
  assert.match(text, /ebe71070[^\n]*duplicate id/);
});

test('check 4 — replaces resolves, no self-replace, no forks', () => {
  const issues = assertOnlyFails(load('red-replaces'), '4 replaces');
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /b7344a8a[^\n]*does not resolve to a published entry/);
  assert.match(text, /429fd217[^\n]*replaces its own id/);
  // exactly one of the fork pair is flagged (whichever the loader visits second, alphabetically)
  assert.match(text, /f6043296[^\n]*already does/);
});

test('check 5 — unit, enumeration member, collection member, conversion target must be published', () => {
  const issues = assertOnlyFails(load('red-pinning'), '5 pinning');
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /a10d88e9[^\n]*unit "/);
  assert.match(text, /c8e6da66[^\n]*enumeration\[0\]/);
  assert.match(text, /6ad4a9ab[^\n]*elements\[0\]\.dictionaryReference/);
  assert.match(text, /153842cc[^\n]*conversions\[0\]\.toUnit/);
});

test('check 5 — isDefinedBy and replaces are exempt from pinning', () => {
  // Green's maxPressure v2 references its concept-free predecessor only via `replaces`,
  // and every entry carries isDefinedBy pointing at the dictionary root (not published/).
  // A pinning implementation that flagged either would go red here.
  assert.deepEqual(checkPinning(load('green')), []);
});

test('runChecks aggregates load errors and all checks 1–6', () => {
  const results = runChecks(load('red-yaml'));
  assert.equal(results.length, 7);
  const loadResult = results.find((r) => r.name === 'load');
  assert.ok(loadResult && loadResult.issues.length === 1);
  const failing = results.filter((r) => r.issues.length > 0);
  assert.deepEqual(failing.map((r) => r.name), ['load']);
  // without a git context the diff-dependent checks are reported as skipped, never silent
  assert.deepEqual(
    results.filter((r) => r.skipped).map((r) => r.name),
    ['check 1 — immutability', 'check 6 — move purity'],
  );
});
