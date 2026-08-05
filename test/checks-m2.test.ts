import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo } from '../scripts/lib/repo.ts';
import { checkImmutability, checkConceptConsistency, checkMovePurity, checkSchema, checkIdentity, checkVersionChain, checkPinning } from '../scripts/lib/checks.ts';
import type { GitContext } from '../scripts/lib/git.ts';
import { runValidation } from '../scripts/validate.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string) => loadRepo(join(fixtures, name));

const DEF = 'https://material-identity.eu/def';
const ROUTE_CONCEPT = 'concepts/59222b28-a951-4a87-8104-76d3a7e61115.yaml';
const CM = 'concepts/ca087cb9-f189-41a1-b082-2288eaacd5e7.yaml';
const PUB_MP2 = 'published/450ecc7b-4cb6-4abf-bacb-35661132d321.yaml';

const fakeGit = (diff: GitContext['diff'], baseFiles: Record<string, string> = {}): GitContext => ({
  base: 'main',
  diff,
  readBaseFile: (p) => baseFiles[p],
});

// ---------------------------------------------------------------- check 1

test('check 1 — M, D, T under published/ fail; A passes; other dirs ignored', () => {
  const issues = checkImmutability([
    { status: 'A', path: 'published/aaaa.yaml' },
    { status: 'M', path: 'published/bbbb.yaml' },
    { status: 'D', path: 'published/cccc.yaml' },
    { status: 'T', path: 'published/dddd.yaml' },
    { status: 'M', path: 'concepts/eeee.yaml' },
    { status: 'D', path: 'drafts/ffff.yaml' },
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['published/bbbb.yaml', 'published/cccc.yaml', 'published/dddd.yaml']);
  assert.match(issues[0].message, /modified/);
  assert.match(issues[1].message, /deleted/);
});

// ---------------------------------------------------------------- check 6 (static)

test('check 6 — green tree passes; red-concept hits all seven static violations', () => {
  assert.deepEqual(checkConceptConsistency(load('green')), []);

  const issues = checkConceptConsistency(load('red-concept'));
  const text = issues.map((i) => `${i.file} ${i.message}`).join('\n');
  assert.match(text, /7363276d[^\n]*appears 0 times/);                      // published version missing from versions[]
  assert.match(text, /2104df7a[^\n]*appears 2 times/);                      // duplicate record
  assert.match(text, /bf06ba32[^\n]*expected exactly one active version, found 0/);
  assert.match(text, /bf06ba32[^\n]*currentVersion[^\n]*not an active record/);
  assert.match(text, /27f013bf[^\n]*expected exactly one active version, found 2/);
  assert.match(text, /93090eab[^\n]*has no replacedBy/);
  assert.match(text, /684c2c48[^\n]*does not resolve to a published file/);
  assert.match(text, /dfd0392a[^\n]*says version "9" but the entry says "1"/);
});

test('red-concept fails only check 6 — checks 2–5 stay green', () => {
  const repo = load('red-concept');
  assert.deepEqual(checkSchema(repo), []);
  assert.deepEqual(checkIdentity(repo), []);
  assert.deepEqual(checkVersionChain(repo), []);
  assert.deepEqual(checkPinning(repo), []);
});

test('M1 red trees stay green on check 6 (each red tree fails exactly its check)', () => {
  for (const tree of ['red-schema', 'red-identity', 'red-version-chain', 'red-pinning']) {
    assert.deepEqual(checkConceptConsistency(load(tree)), [], `${tree} should pass check 6`);
  }
});

// ---------------------------------------------------------------- check 6 (append-only, diff against base)

test('check 6 — forward transition passes; record removal and backward transition fail', () => {
  const repo = load('green');
  const current = readFileSync(join(fixtures, 'green', CM), 'utf8');

  // base had only v1 (active) — the current file tombstones v1 and adds v2: forward + append-only, OK
  const forwardBase = current
    .replace(/ {2}- entry: .*450ecc7b[\s\S]*?status: active\n/, '')
    .replace(/status: tombstoned\n {4}deprecatedOn: "2026-07-01"\n {4}replacedBy: .*\n/, 'status: active\n')
    .replace(/currentVersion: .*/, `currentVersion: ${DEF}/93946327-ccc4-4581-ac7c-229ea5c2f832`);
  assert.ok(!forwardBase.includes('450ecc7b'), 'base surgery removed all v2 references');
  assert.deepEqual(
    checkConceptConsistency(repo, fakeGit([{ status: 'M', path: CM }], { [CM]: forwardBase })),
    [],
  );

  // base carried a record the current file no longer has → append-only violation
  const withExtra = current.replace(
    /versions:\n/,
    `versions:\n  - entry: ${DEF}/00000000-0000-4000-8000-0000000000ff\n    version: "0"\n    status: tombstoned\n    replacedBy: ${DEF}/93946327-ccc4-4581-ac7c-229ea5c2f832\n`,
  );
  const removal = checkConceptConsistency(repo, fakeGit([{ status: 'M', path: CM }], { [CM]: withExtra }));
  assert.match(removal.map((i) => i.message).join('\n'), /was removed — versions\[\] is append-only/);

  // base has v1 tombstoned; the current model flips it back to active → backward transition
  const repoBackward = load('green');
  const cm = repoBackward.concepts.find((f) => f.relPath === CM)!;
  const versions = cm.doc!.versions as Array<Record<string, unknown>>;
  versions[0].status = 'active';
  versions[1].status = 'deprecated';
  const backward = checkConceptConsistency(repoBackward, fakeGit([{ status: 'M', path: CM }], { [CM]: current }));
  assert.match(backward.map((i) => i.message).join('\n'), /moved backward tombstoned → active/);
});

test('check 6 — deleting a concept file fails', () => {
  const issues = checkConceptConsistency(load('green'), fakeGit([{ status: 'D', path: 'concepts/gone.yaml' }]));
  assert.match(issues.map((i) => i.message).join('\n'), /concept file deleted/);
});

// ---------------------------------------------------------------- check 7

test('check 7 — pure move (only id differs) passes; edited move fails; withdrawal passes', () => {
  const repo = load('green');
  const publishedText = readFileSync(join(fixtures, 'green', PUB_MP2), 'utf8');
  const draftText = publishedText.replace(/^id: .*$/m, `id: ${DEF}/00000000-0000-4000-8000-000000000000`);
  const diff = [
    { status: 'D', path: 'drafts/maxPressure.yaml' },
    { status: 'A', path: PUB_MP2 },
  ];

  assert.deepEqual(checkMovePurity(repo, fakeGit(diff, { 'drafts/maxPressure.yaml': draftText })), []);

  const edited = draftText.replace('certified', 'certified and approved');
  const issues = checkMovePurity(repo, fakeGit(diff, { 'drafts/maxPressure.yaml': edited }));
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /matches no added published file/);

  // draft deleted, nothing published → legitimate withdrawal
  assert.deepEqual(
    checkMovePurity(repo, fakeGit([{ status: 'D', path: 'drafts/withdrawn.yaml' }], { 'drafts/withdrawn.yaml': draftText })),
    [],
  );
});

// ---------------------------------------------------------------- integration: real git repo

const gitc = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { stdio: 'pipe' });

test('integration — temp git repo: pure publish move green; edited move, tamper, delete red', () => {
  const root = mkdtempSync(join(tmpdir(), 'dict-validate-'));
  try {
    cpSync(join(fixtures, 'green'), root, { recursive: true });
    gitc(root, 'init', '-b', 'main');
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'base');

    const NEW_UUID = 'b3d0a988-30cf-4e5a-9c61-7f8e9d0a1b2c';
    const readyDraft = readFileSync(join(root, 'drafts/draftExample.yaml'), 'utf8')
      .replace(/^# Draft.*\n/m, '')
      .replace(/^id: .*$/m, `id: ${DEF}/00000000-0000-4000-8000-000000000000`)
      .replace(/^isVersionOf: .*$/m, 'isVersionOf: https://material-identity.eu/concept/59222b28-a951-4a87-8104-76d3a7e61115')
      .replace(/^version: .*$/m, 'version: "2"');
    const publishConcept = (conceptText: string, uuid: string): string =>
      conceptText
        .replace(/currentVersion: .*/, `currentVersion: ${DEF}/${uuid}`)
        .replace(/status: active/, 'status: deprecated')
        + `  - entry: ${DEF}/${uuid}\n    version: "2"\n    status: active\n`;

    // the draft in its final form lands on main first (real flow: draft merged, then publish PR)
    writeFileSync(join(root, 'drafts/draftExample.yaml'), readyDraft);
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'draft ready');
    gitc(root, 'tag', 'draft-base');

    // pure publish move: delete draft, add published (only id differs), concept moves forward
    gitc(root, 'checkout', '-b', 'publish-pure');
    rmSync(join(root, 'drafts/draftExample.yaml'));
    writeFileSync(join(root, `published/${NEW_UUID}.yaml`), readyDraft.replace(/^id: .*$/m, `id: ${DEF}/${NEW_UUID}`));
    const conceptPath = join(root, ROUTE_CONCEPT);
    writeFileSync(conceptPath, publishConcept(readFileSync(conceptPath, 'utf8'), NEW_UUID));
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'publish');
    const pure = runValidation(root, { base: 'draft-base' });
    assert.equal(pure.ok, true, pure.lines.join('\n'));

    // edited during the move → exactly check 7 fails
    gitc(root, 'checkout', '-b', 'publish-edited', 'draft-base');
    rmSync(join(root, 'drafts/draftExample.yaml'));
    writeFileSync(
      join(root, `published/${NEW_UUID}.yaml`),
      readyDraft
        .replace(/^id: .*$/m, `id: ${DEF}/${NEW_UUID}`)
        .replace('A draft entry', 'An edited entry'),
    );
    writeFileSync(conceptPath, publishConcept(readFileSync(conceptPath, 'utf8'), NEW_UUID));
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'publish with edit');
    const edited = runValidation(root, { base: 'draft-base' });
    assert.equal(edited.ok, false);
    assert.deepEqual(edited.lines.filter((l) => l.startsWith('FAIL')), ['FAIL    check 7 — move purity']);

    // tampering with a published file → check 1 red
    gitc(root, 'checkout', '-b', 'tamper', 'draft-base');
    const target = join(root, PUB_MP2);
    writeFileSync(target, readFileSync(target, 'utf8').replace('certified', 'certified (edited)'));
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'tamper');
    const tampered = runValidation(root, { base: 'draft-base' });
    assert.equal(tampered.ok, false);
    assert.match(tampered.lines.join('\n'), /FAIL\s+check 1 — immutability[\s\S]*published file modified/);

    // deleting a published file → check 1 red
    gitc(root, 'checkout', '-b', 'delete', 'draft-base');
    gitc(root, 'rm', PUB_MP2);
    gitc(root, 'commit', '-m', 'delete');
    const deleted = runValidation(root, { base: 'draft-base' });
    assert.equal(deleted.ok, false);
    assert.match(deleted.lines.join('\n'), /FAIL\s+check 1 — immutability[\s\S]*published file deleted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fixture trees get no git context (nested in this repo) — git checks skip, static checks run', () => {
  const { lines } = runValidation(join(fixtures, 'green'));
  const text = lines.join('\n');
  assert.match(text, /skip\s+check 1 — immutability/);
  assert.match(text, /skip\s+check 7 — move purity/);
  assert.match(text, /ok\s+check 6 — concept consistency/);
});
