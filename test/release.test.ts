import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import oxigraph from 'oxigraph';
import { build } from '../scripts/build.ts';
import { buildCatalog, buildRelease, buildReleaseIndex, releaseContents } from '../scripts/lib/dcat.ts';
import { entrySha256 } from '../scripts/lib/emit.ts';
import { getReleases, getReleaseTags, gitEnv, type Release, shippedBy } from '../scripts/lib/git.ts';
import { loadRepo } from '../scripts/lib/repo.ts';
import { pocBanner, RefIndex, renderReleaseIndexPage, renderReleasePage } from '../scripts/lib/render.ts';
import { distributionPins, loadSpecs, parseJsonLd } from '../scripts/lib/spec.ts';
import { runValidation } from '../scripts/validate.ts';

// Dictionary releases at /release/<tag> (#135): each release tag as a dcat:Dataset.
const here = dirname(fileURLToPath(import.meta.url));
const GREEN = join(here, 'fixtures', 'green');
const BASE = 'https://material-identity.eu';
const DCAT = 'http://www.w3.org/ns/dcat#';
const DCT = 'http://purl.org/dc/terms/';
const SPDX = 'http://spdx.org/rdf/terms#';
const LATE = 'published/c38a85eb-1a37-416d-ab21-7ddcc599754d.yaml';

const ask = (store: oxigraph.Store, where: string): boolean => store.query(`ASK { ${where} }`) as unknown as boolean;
const count = (store: oxigraph.Store, where: string): number =>
  Number((store.query(`SELECT (COUNT(*) AS ?n) WHERE { ${where} }`) as Array<Map<string, oxigraph.Term>>)[0].get('n')!.value);
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const tag = (t: string): Release => ({ tag: t, date: t.slice(1).replaceAll('.', '-') });

/** The green repo, with every entry first shipped in v2026.08.28 except LATE, which waits for v2026.09.30. */
function greenReleases(): { repo: ReturnType<typeof loadRepo>; tags: Release[]; first: Map<string, Release> } {
  const repo = loadRepo(GREEN);
  const first = new Map(repo.published.map((f) => [f.relPath, tag(f.relPath === LATE ? 'v2026.09.30' : 'v2026.08.28')]));
  return { repo, tags: [tag('v2026.09.30'), tag('v2026.08.28')], first };
}

test('shippedBy: a release contains what it or an earlier release first shipped, nothing unreleased', () => {
  assert.equal(shippedBy(tag('v2026.08.28'), 'v2026.08.28'), true);
  assert.equal(shippedBy(tag('v2026.08.28'), 'v2026.09.30'), true);
  assert.equal(shippedBy(tag('v2026.09.30'), 'v2026.08.28'), false);
  assert.equal(shippedBy(undefined, 'v2099.01.01'), false);
});

test('releaseContents: cumulative per tag, sorted, with the digest a spec pins; unreleased entries in none', () => {
  const { repo, tags, first } = greenReleases();
  first.delete('published/109980b4-51dc-4986-ba73-d5e407318400.yaml'); // merged since the last tag
  const [early, late] = releaseContents(tags, first, repo);
  assert.deepEqual([early.tag, early.date, late.tag], ['v2026.08.28', '2026-08-28', 'v2026.09.30']);
  const released = repo.published.length - 1;
  assert.equal(late.entries.length, released);
  assert.equal(early.entries.length, released - 1);
  assert.ok(!early.entries.some((e) => e.iri.endsWith('c38a85eb-1a37-416d-ab21-7ddcc599754d')));
  assert.ok(![...early.entries, ...late.entries].some((e) => e.iri.endsWith('109980b4-51dc-4986-ba73-d5e407318400')));
  assert.deepEqual(late.entries.map((e) => e.iri), [...late.entries.map((e) => e.iri)].sort());
  assert.deepEqual(late.entries.filter((e) => e.firstShipped === 'v2026.09.30').map((e) => e.iri), [`${BASE}/def/c38a85eb-1a37-416d-ab21-7ddcc599754d`]);
  for (const e of late.entries) {
    const doc = repo.published.find((f) => e.iri.endsWith(f.stem))!.doc!;
    assert.equal(e.sha256, entrySha256(doc));
  }
});

test('a release is a PoC-marked, CC0 dcat:Dataset: entries it contains, entries it first shipped, the tarball by link', () => {
  const { repo, tags, first } = greenReleases();
  const [, late] = releaseContents(tags, first, repo);
  const iri = `${BASE}/release/v2026.09.30`;
  const store = parseJsonLd(JSON.stringify(buildRelease(late)), iri);
  assert.ok(ask(store, `<${iri}> a <${DCAT}Dataset> ; <${DCAT}version> "v2026.09.30" ;
    <${DCT}issued> "2026-09-30"^^<http://www.w3.org/2001/XMLSchema#date> ;
    <${DCT}license> <http://creativecommons.org/publicdomain/zero/1.0/> ;
    <http://www.w3.org/ns/adms#status> <${BASE}/ns#ProofOfConcept> ;
    <${DCAT}inCatalog> <${BASE}/release> ;
    <${DCAT}landingPage> <https://github.com/material-identity/dictionary/releases/tag/v2026.09.30> .`));
  assert.ok(ask(store, `<${iri}> <${DCAT}distribution> ?d . ?d a <${DCAT}Distribution> ;
    <${DCAT}downloadURL> <https://github.com/material-identity/dictionary/releases/download/v2026.09.30/dictionary-v2026.09.30.tar.gz> ;
    <${DCAT}mediaType> "application/gzip" . FILTER NOT EXISTS { ?d <${SPDX}checksum> ?c }`), 'the tarball is linked, with no digest the offline build cannot know');
  assert.equal(count(store, `<${iri}> <${DCT}hasPart> ?e`), late.entries.length);
  assert.equal(count(store, `<${iri}> <${BASE}/ns#firstShipped> ?e`), 1);
  for (const e of late.entries) {
    assert.ok(ask(store, `<${iri}> <${DCT}hasPart> <${e.iri}> . <${e.iri}> <${DCAT}distribution> ?d .
      ?d <${DCAT}downloadURL> <${e.iri}> ; <${DCAT}mediaType> "application/json" ;
      <${SPDX}checksum> [ <${SPDX}algorithm> <${SPDX}checksumAlgorithm_sha256> ; <${SPDX}checksumValue> "${e.sha256}" ] .`), e.iri);
  }
  // deterministic, whatever order the inputs come in
  assert.equal(JSON.stringify(releaseContents([...tags].reverse(), first, repo)), JSON.stringify(releaseContents(tags, first, repo)));
});

test('/release and /catalog describe each release with the same node and IRI as /release/<tag>', () => {
  const { repo, tags, first } = greenReleases();
  const index = buildReleaseIndex(tags);
  assert.equal(index['@id'], `${BASE}/release`);
  assert.equal(index['@type'], 'dcat:Catalog');
  const listed = index['dcat:dataset'] as Array<Record<string, unknown>>;
  assert.deepEqual(listed.map((d) => d['@id']), [`${BASE}/release/v2026.08.28`, `${BASE}/release/v2026.09.30`]);
  const inCatalog = (buildCatalog(tags, [])['dcat:dataset'] as Array<Record<string, unknown>>);
  assert.deepEqual(inCatalog, listed);
  for (const [i, r] of releaseContents(tags, first, repo).entries()) {
    const own = buildRelease(r);
    for (const [k, v] of Object.entries(listed[i])) assert.deepEqual(own[k], v, `${r.tag} ${k}`);
  }
  const store = parseJsonLd(JSON.stringify(index), `${BASE}/release`);
  assert.ok(ask(store, `<${BASE}/release> <http://www.w3.org/ns/adms#status> <${BASE}/ns#ProofOfConcept> ; <${DCAT}dataset> <${BASE}/release/v2026.08.28> .`));
});

test('release pages carry the PoC banner, name themselves canonical, and link every entry with its digest', () => {
  const { repo, tags, first } = greenReleases();
  const refs = new RefIndex(repo);
  const contents = releaseContents(tags, first, repo);
  const html = renderReleasePage(contents[1], refs);
  assert.ok(html.includes(pocBanner()));
  assert.match(html, /<link rel="canonical" href="https:\/\/material-identity\.eu\/release\/v2026\.09\.30">/);
  assert.match(html, /<link rel="alternate" type="application\/ld\+json" href="\/release\/v2026\.09\.30">/);
  assert.match(html, /<h1>Release v2026\.09\.30<\/h1>/);
  assert.match(html, /href="https:\/\/github\.com\/material-identity\/dictionary\/releases\/download\/v2026\.09\.30\/dictionary-v2026\.09\.30\.tar\.gz"/);
  assert.match(html, new RegExp(`${contents[1].entries.length} in total, 1 first shipped in this release`));
  assert.match(html, /<td><a href="\/release\/v2026\.08\.28"><code>v2026\.08\.28<\/code><\/a><\/td>/, 'an older entry links the release that first shipped it');
  for (const e of contents[1].entries) assert.ok(html.includes(`<code>${e.sha256}</code>`));
  assert.ok(!/<script/i.test(html));

  const index = renderReleaseIndexPage(contents);
  assert.ok(index.includes(pocBanner()));
  assert.match(index, /<a href="\/release\/v2026\.08\.28"><code>v2026\.08\.28<\/code><\/a>/);
  assert.match(index, /<link rel="canonical" href="https:\/\/material-identity\.eu\/release">/);
  assert.match(renderReleaseIndexPage([]), /No release in this build\./);
  assert.match(renderReleasePage({ tag: 'v2026.01.01', date: '2026-01-01', entries: [] }, refs), /This release contains no entry\./);
});

test('a fixture build without git writes an empty /release index and no release page', () => {
  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  try {
    build(GREEN, out);
    assert.ok(existsSync(join(out, 'release', 'index.html')));
    const index = JSON.parse(readFileSync(join(out, 'release', 'index.jsonld'), 'utf8'));
    assert.deepEqual(index['dcat:dataset'], []);
    assert.match(readFileSync(join(out, 'release', 'index.html'), 'utf8'), /No release in this build\./);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the build serves every tag at /release/<tag>, and what it serves agrees with the pinned-release check', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-build-'));
  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  const gitc = (...args: string[]): void => {
    execFileSync('git', ['-C', root, '-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { stdio: 'pipe', env: gitEnv() });
  };
  const releaseDoc = (t: string): oxigraph.Store => parseJsonLd(readFileSync(join(out, 'release', t, 'index.jsonld'), 'utf8'), `${BASE}/release/${t}`);
  try {
    cpSync(GREEN, root, { recursive: true });
    renameSync(join(root, LATE), join(root, 'late.yaml'));
    gitc('init', '-b', 'main');
    gitc('add', '-A');
    gitc('commit', '-m', 'base');
    gitc('tag', 'v2026.08.28');
    renameSync(join(root, 'late.yaml'), join(root, LATE));
    gitc('add', '-A');
    gitc('commit', '-m', 'late entry');
    gitc('tag', 'v2026.09.30');

    build(root, out);
    assert.deepEqual(getReleaseTags(root).map((t) => t.tag), ['v2026.08.28', 'v2026.09.30']);
    for (const t of ['v2026.08.28', 'v2026.09.30']) {
      assert.ok(existsSync(join(out, 'release', t, 'index.html')), `${t} has a page`);
      assert.ok(readFileSync(join(out, 'release', t, 'index.html'), 'utf8').includes(pocBanner()));
    }
    // every listed digest is the digest of the bytes /def/<uuid> serves
    const late = releaseDoc('v2026.09.30');
    const repo = loadRepo(root);
    assert.equal(count(late, `<${BASE}/release/v2026.09.30> <${DCT}hasPart> ?e`), repo.published.length);
    for (const f of repo.published) {
      const iri = `${BASE}/def/${f.stem}`;
      const served = sha(readFileSync(join(out, 'def', `${f.stem}.json`)));
      assert.ok(ask(late, `<${iri}> <${DCAT}distribution> [ <${SPDX}checksum> [ <${SPDX}checksumValue> "${served}" ] ]`), iri);
    }

    // The spec pins v2026.08.28, which does not ship the late entry: the check fails, and the
    // served release agrees — the entry is not part of it, and every other pin is, with its digest.
    const [spec] = loadSpecs(root).specs;
    const pins = distributionPins(spec.graph, spec.iri);
    const early = releaseDoc('v2026.08.28');
    const lateIri = `${BASE}/def/c38a85eb-1a37-416d-ab21-7ddcc599754d`;
    for (const pin of pins) {
      const inRelease = ask(early, `<${BASE}/release/v2026.08.28> <${DCT}hasPart> <${pin.url}> . <${pin.url}> <${DCAT}distribution> [ <${SPDX}checksum> [ <${SPDX}checksumValue> "${pin.sha256}" ] ]`);
      assert.equal(inRelease, pin.url !== lateIri, pin.url);
    }
    assert.ok(ask(late, `<${BASE}/release/v2026.09.30> <${BASE}/ns#firstShipped> <${lateIri}>`));
    const run = runValidation(root, { base: 'main' });
    assert.match(run.lines.find((l) => l.includes('pinned dictionary release'))!, /^FAIL/);
    assert.equal(getReleases(root).get(LATE)?.tag, 'v2026.09.30');

    // deterministic: a second build is byte-identical
    const again = mkdtempSync(join(tmpdir(), 'dict-site-'));
    try {
      build(root, again);
      for (const t of ['v2026.08.28', 'v2026.09.30']) {
        for (const name of ['index.jsonld', 'index.html']) {
          assert.deepEqual(readFileSync(join(again, 'release', t, name)), readFileSync(join(out, 'release', t, name)));
        }
      }
    } finally {
      rmSync(again, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});
