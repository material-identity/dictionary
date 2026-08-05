import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo, type RepoModel, type ValidationIssue } from '../scripts/lib/repo.ts';
import { checkSchema, checkIdentity, checkVersionChain, checkPinning, runChecks } from '../scripts/lib/checks.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string): RepoModel => loadRepo(join(fixtures, name));

const CHECKS = {
  '2 schema': checkSchema,
  '3 identity': checkIdentity,
  '4 version-chain': checkVersionChain,
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
  assert.ok(files.includes('published/d626443f-60bf-40c3-b4a4-0370148acda5.yaml'), 'missing valueDataType flagged');
  assert.ok(files.includes('drafts/badDraft.yaml'), 'draft with invalid langMap key flagged');
});

test('check 3 — filename/id mismatch, wrong domain, invalid UUID, duplicate id', () => {
  const issues = assertOnlyFails(load('red-identity'), '3 identity');
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /e4b19150[^\n]*does not match id UUID/);
  assert.match(text, /1fa6187e[^\n]*not canonical/);
  assert.match(text, /not-a-uuid\.yaml[^\n]*not an RFC 4122 v4 UUID/);
  assert.match(text, /82ddbcda[^\n]*duplicate id/);
});

test('check 4 — missing concept, duplicate version, unresolvable and foreign replaces', () => {
  const issues = assertOnlyFails(load('red-version-chain'), '4 version-chain');
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /943a9e88[^\n]*missing concept file/);
  assert.match(text, /version "1" already used/);
  assert.match(text, /18fefa9d[^\n]*does not resolve to a published entry/);
  assert.match(text, /377dcc0e[^\n]*belongs to a different concept/);
});

test('check 5 — unit, enumeration member, collection member, conversion target must be published', () => {
  const issues = assertOnlyFails(load('red-pinning'), '5 pinning');
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /3bf4310f[^\n]*unit "/);
  assert.match(text, /2ea0d6d1[^\n]*enumeration\[0\]/);
  assert.match(text, /055eee5d[^\n]*elements\[0\]\.dictionaryReference/);
  assert.match(text, /ed5a4f6e[^\n]*conversions\[0\]\.toUnit/);
});

test('check 5 — isVersionOf and isDefinedBy are exempt from pinning', () => {
  // Green entries reference their concepts (not in published/) via isVersionOf and the
  // dictionary root via isDefinedBy; a pinning implementation that flagged them would go red here.
  assert.deepEqual(checkPinning(load('green')), []);
});

test('runChecks aggregates load errors and all four checks', () => {
  const results = runChecks(load('red-yaml'));
  assert.equal(results.length, 5);
  const loadResult = results.find((r) => r.name === 'load');
  assert.ok(loadResult && loadResult.issues.length === 1);
  const failing = results.filter((r) => r.issues.length > 0);
  assert.deepEqual(failing.map((r) => r.name), ['load']);
});
