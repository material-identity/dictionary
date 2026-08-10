import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEF_PREFIX, type RepoModel } from '../scripts/lib/repo.ts';
import { renderFeed } from '../scripts/lib/feed.ts';
import { getAddedDates } from '../scripts/lib/git.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function syntheticRepo(entries: Array<{ stem: string; doc: Record<string, unknown> }>): RepoModel {
  return {
    root: '/synthetic',
    drafts: [],
    published: entries.map((e) => ({
      dir: 'published' as const,
      name: `${e.stem}.yaml`,
      stem: e.stem,
      relPath: `published/${e.stem}.yaml`,
      doc: e.doc,
    })),
    errors: [],
  };
}

const entry = (stem: string, overrides: Record<string, unknown> = {}) => ({
  stem,
  doc: {
    id: `${DEF_PREFIX}${stem}`,
    isDefinedBy: 'https://material-identity.eu/',
    objectType: 'SingleValuedDataElement',
    shortName: stem.slice(0, 8),
    preferredName: { en: `Entry ${stem.slice(0, 4)}` },
    definition: { en: 'A definition.' },
    valueDataType: 'xsd:string',
    ...overrides,
  },
});

// ------------------------------------------------------------------ renderFeed (#56)

test('renderFeed: valid RSS 2.0 shell, one item per entry, title/link/guid/description', () => {
  const a = entry('11111111-1111-4111-8111-111111111111');
  const repo = syntheticRepo([a]);
  const xml = renderFeed(repo, new Map());

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<rss version="2\.0">/);
  assert.equal((xml.match(/<item>/g) ?? []).length, 1);
  assert.match(xml, /<title>Entry 1111 \(11111111\)<\/title>/);
  assert.match(xml, new RegExp(`<link>${DEF_PREFIX}11111111-1111-4111-8111-111111111111</link>`));
  assert.match(xml, /<guid isPermaLink="true">/);
  assert.match(xml, /<description>A definition\.<\/description>/);
});

test('renderFeed: newest first; entries with an unknown date sort last, by id', () => {
  const a = entry('aaaaaaaa-1111-4111-8111-000000000001');
  const b = entry('bbbbbbbb-2222-4222-8222-000000000002');
  const c = entry('cccccccc-3333-4333-8333-000000000003'); // no known date
  const repo = syntheticRepo([a, b, c]);
  const dates = new Map([
    [`published/${a.stem}.yaml`, '2026-01-01T00:00:00+00:00'],
    [`published/${b.stem}.yaml`, '2026-06-01T00:00:00+00:00'],
  ]);
  const xml = renderFeed(repo, dates);
  const order = [...xml.matchAll(/<title>Entry (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(order, ['bbbb', 'aaaa', 'cccc']); // b newest, then a, unknown-date c last
  assert.equal((xml.match(/<pubDate>/g) ?? []).length, 2);
});

test('renderFeed: a superseding entry says so in its description', () => {
  const old = entry('dddddddd-1111-4111-8111-000000000004');
  const successor = entry('eeeeeeee-2222-4222-8222-000000000005', { replaces: old.doc.id });
  const repo = syntheticRepo([old, successor]);
  const xml = renderFeed(repo, new Map());
  assert.match(xml, new RegExp(`Supersedes: ${old.doc.id}\\.`));
  // the superseded entry's own item carries no such note
  const oldItem = xml.split('<item>')[1];
  assert.ok(!oldItem.includes('Supersedes'));
});

test('renderFeed: title/description text is XML-escaped', () => {
  const a = entry('11111111-2222-4111-8111-000000000006', {
    preferredName: { en: 'A & B <bad>' },
    definition: { en: 'Contains "quotes" & <tags>' },
  });
  const xml = renderFeed(syntheticRepo([a]), new Map());
  assert.match(xml, /<title>A &amp; B &lt;bad&gt;/);
  assert.match(xml, /Contains &quot;quotes&quot; &amp; &lt;tags&gt;/);
  assert.ok(!xml.includes('<bad>') && !xml.includes('<tags>'));
});

// ------------------------------------------------------------------ getAddedDates (#56)

const gitc = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });

test('getAddedDates: finds the real add-date, and specifically the *original* one across a draft -> published rename', () => {
  const root = mkdtempSync(join(tmpdir(), 'dict-feed-'));
  try {
    gitc(root, 'init', '-b', 'main');
    mkdirSync(join(root, 'drafts'));
    writeFileSync(join(root, 'drafts/x.yaml'), 'id: placeholder\n');
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'draft', '--date=2026-01-01T00:00:00');

    mkdirSync(join(root, 'published'));
    execFileSync('git', ['-C', root, 'mv', 'drafts/x.yaml', 'published/x.yaml']);
    gitc(root, 'commit', '-m', 'publish (git sees this as a rename, not an add)', '--date=2026-06-01T00:00:00');

    // a later, unrelated modification must not shift the recorded add-date
    writeFileSync(join(root, 'published/x.yaml'), 'id: placeholder\nmore: data\n');
    gitc(root, 'add', '-A');
    gitc(root, 'commit', '-m', 'edit', '--date=2026-09-01T00:00:00');

    const dates = getAddedDates(root);
    assert.ok(dates.get('published/x.yaml')?.startsWith('2026-06-01'), `expected the publish-commit date, got ${dates.get('published/x.yaml')}`);
    // drafts/x.yaml genuinely was added too (first commit) — that's a separate, correct
    // historical fact; the feed simply never looks it up, since it only iterates published/.
    assert.ok(dates.get('drafts/x.yaml')?.startsWith('2026-01-01'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getAddedDates: outside a git work-tree top level, returns an empty map rather than throwing', () => {
  assert.deepEqual(getAddedDates(join(fixtures, 'green')).size, 0);
  assert.deepEqual(getAddedDates(join(fixtures, 'empty')).size, 0);
});

test('renderFeed reads canonicalJson-free plain docs (no side effects on the repo model)', () => {
  const a = entry('11111111-3333-4111-8111-000000000007');
  const before = JSON.stringify(a.doc);
  renderFeed(syntheticRepo([a]), new Map());
  assert.equal(JSON.stringify(a.doc), before);
});
