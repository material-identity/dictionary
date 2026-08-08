import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo } from '../scripts/lib/repo.ts';
import { checkImmutability, checkMovePurity } from '../scripts/lib/checks.ts';
import type { GitContext } from '../scripts/lib/git.ts';
import { runValidation } from '../scripts/validate.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (name: string) => loadRepo(join(fixtures, name));

const DEF = 'https://material-identity.eu/def';
const PUB_MP2 = 'published/c38a85eb-1a37-416d-ab21-7ddcc599754d.yaml';

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
    { status: 'D', path: 'drafts/ffff.yaml' },
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['published/bbbb.yaml', 'published/cccc.yaml', 'published/dddd.yaml']);
  assert.match(issues[0].message, /modified/);
  assert.match(issues[1].message, /deleted/);
});

// ---------------------------------------------------------------- check 6 (move purity)

test('check 6 — pure move (only id differs) passes; edited move fails; withdrawal passes', () => {
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
      .replace(/^id: .*$/m, `id: ${DEF}/00000000-0000-4000-8000-000000000000`);

    // the draft in its final form lands on main first (real flow: draft merged, then publish PR)
    writeFileSync(join(root, 'drafts/draftExample.yaml'), readyDraft);
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'draft ready');
    gitc(root, 'tag', 'draft-base');

    // pure publish move: delete draft, add published (only id differs) — no concept file to touch
    gitc(root, 'checkout', '-b', 'publish-pure');
    rmSync(join(root, 'drafts/draftExample.yaml'));
    writeFileSync(join(root, `published/${NEW_UUID}.yaml`), readyDraft.replace(/^id: .*$/m, `id: ${DEF}/${NEW_UUID}`));
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'publish');
    const pure = runValidation(root, { base: 'draft-base' });
    assert.equal(pure.ok, true, pure.lines.join('\n'));

    // edited during the move → exactly check 6 fails
    gitc(root, 'checkout', '-b', 'publish-edited', 'draft-base');
    rmSync(join(root, 'drafts/draftExample.yaml'));
    writeFileSync(
      join(root, `published/${NEW_UUID}.yaml`),
      readyDraft
        .replace(/^id: .*$/m, `id: ${DEF}/${NEW_UUID}`)
        .replace('A draft entry', 'An edited entry'),
    );
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'publish with edit');
    const edited = runValidation(root, { base: 'draft-base' });
    assert.equal(edited.ok, false);
    assert.deepEqual(edited.lines.filter((l) => l.startsWith('FAIL')), ['FAIL    check 6 — move purity']);

    // supersession: publish a new entry with `replaces` set — no other file needs to change
    gitc(root, 'checkout', '-b', 'supersede', 'draft-base');
    const SUCCESSOR_UUID = 'c7b1a2d3-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    writeFileSync(
      join(root, `published/${SUCCESSOR_UUID}.yaml`),
      `id: ${DEF}/${SUCCESSOR_UUID}\nreplaces: ${DEF}/c38a85eb-1a37-416d-ab21-7ddcc599754d\nisDefinedBy: https://material-identity.eu/\nobjectType: SingleValuedDataElement\nshortName: maxPressure\npreferredName:\n  en: Maximum allowable pressure (revised)\ndefinition:\n  en: Highest internal gauge pressure, revised definition.\nvalueDataType: xsd:float\n`,
    );
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'supersede maxPressure');
    const superseded = runValidation(root, { base: 'draft-base' });
    assert.equal(superseded.ok, true, superseded.lines.join('\n'));

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
  assert.match(text, /skip\s+check 6 — move purity/);
  assert.match(text, /ok\s+check 4 — replaces/);
});
