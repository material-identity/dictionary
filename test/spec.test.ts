import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import oxigraph from 'oxigraph';
import { build, emitSpecs } from '../scripts/build.ts';
import { checkImmutability, checkSpecs, foreignSubjects, runChecks } from '../scripts/lib/checks.ts';
import { buildCatalog, buildSeries, embeddedDataset, findDatasetNode } from '../scripts/lib/dcat.ts';
import { createGitContext, getReleaseTags, isGitContext, parseRawDiff } from '../scripts/lib/git.ts';
import { renderVocabularyJsonLd, renderVocabularyTurtle, vocabularyTerms } from '../scripts/lib/rdf.ts';
import { loadRepo } from '../scripts/lib/repo.ts';
import { isWebIri, pocBanner, RefIndex, renderCatalogPage, renderSpecPage, renderVocabularyPage } from '../scripts/lib/render.ts';
import { compareVersions, loadSpecs, parseJsonLd, summarize } from '../scripts/lib/spec.ts';

// Hosted content specifications (#135). The fixture is a small spec authored for these tests
// under test/fixtures/green/spec/ — never under the repo's own spec/, which only ever holds
// hand-overs from material-identity/schema.
const here = dirname(fileURLToPath(import.meta.url));
const GREEN = join(here, 'fixtures', 'green');
const REL = join('spec', 'demo', 'v0.0.1');
const IRI = 'https://material-identity.eu/spec/demo/v0.0.1';
const SERVED = ['demo.jsonld', 'demo.context.jsonld', 'compressed.schema.json', 'full.schema.json'];

const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const ask = (store: oxigraph.Store, where: string): boolean => store.query(`ASK { ${where} }`) as unknown as boolean;

/**
 * A throwaway copy of the green tree whose spec files `mutate` may rewrite. With `refresh`, the DCAT
 * record's checksums are recomputed afterwards, so a test sees only the defect it planted.
 */
function withTree(mutate: (dir: string, root: string) => void, fn: (root: string) => void, refresh = true): void {
  const root = mkdtempSync(join(tmpdir(), 'spec-tree-'));
  try {
    cpSync(GREEN, root, { recursive: true });
    const dir = join(root, REL);
    const before = new Map(SERVED.map((n) => [sha(readFileSync(join(dir, n))), n]));
    mutate(dir, root);
    if (refresh) {
      const dcat = join(dir, 'demo.dcat.jsonld');
      let text = readFileSync(dcat, 'utf8');
      for (const [old, name] of before) {
        try { text = text.replace(old, sha(readFileSync(join(dir, name)))); } catch { /* file removed by the mutation */ }
      }
      writeFileSync(dcat, text);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const edit = (dir: string, name: string, change: (text: string) => string): void => {
  writeFileSync(join(dir, name), change(readFileSync(join(dir, name), 'utf8')));
};

const specIssues = (root: string): string[] => checkSpecs(loadSpecs(root), loadRepo(root)).map((i) => `${i.file}: ${i.message}`);

// ------------------------------------------------------------------ loading

test('loadSpecs reads the fixture: one spec, five files, each hashed over its exact bytes', () => {
  const { specs, issues } = loadSpecs(GREEN);
  assert.deepEqual(issues, []);
  assert.equal(specs.length, 1);
  const [spec] = specs;
  assert.equal(spec.iri, IRI);
  assert.equal(spec.relDir, 'spec/demo/v0.0.1');
  assert.deepEqual(spec.files.map((f) => f.source), ['demo.jsonld', 'demo.context.jsonld', 'demo.dcat.jsonld', 'compressed.schema.json', 'full.schema.json']);
  for (const f of spec.files) assert.equal(f.sha256, sha(readFileSync(join(GREEN, REL, f.source))));
  assert.deepEqual(spec.files.map((f) => f.served), ['index.jsonld', 'context.jsonld', undefined, 'compressed.schema.json', 'full.schema.json']);
});

test('a repo without spec/ hosts nothing and is fine', () => {
  assert.deepEqual(loadSpecs(join(here, 'fixtures', 'empty')), { specs: [], issues: [] });
});

test('versions sort numerically, not lexically', () => {
  assert.deepEqual(['v0.0.10', 'v0.0.9', 'v1.0.0', 'v0.1.0'].sort(compareVersions), ['v0.0.9', 'v0.0.10', 'v0.1.0', 'v1.0.0']);
  assert.equal(compareVersions('v1.2.3', 'v1.2.3'), 0);
  assert.ok(compareVersions('v1.0.0', 'junk') < 0 && compareVersions('junk', 'v1.0.0') > 0);
  assert.ok(compareVersions('a', 'b') < 0);
});

test('layout: misnamed directories, missing and extra files, and stray files are refused', () => {
  withTree((dir, root) => {
    rmSync(join(dir, 'full.schema.json'));
    writeFileSync(join(dir, 'notes.md'), 'x');
    mkdirSync(join(root, 'spec', 'Bad_Act'));
    mkdirSync(join(root, 'spec', 'demo', 'latest'));
    writeFileSync(join(root, 'spec', 'README.md'), 'x');
  }, (root) => {
    const issues = loadSpecs(root).issues.map((i) => `${i.file}: ${i.message}`);
    assert.ok(issues.includes('spec/demo/v0.0.1/full.schema.json: missing from the hand-over'));
    assert.ok(issues.includes('spec/demo/v0.0.1/notes.md: not part of a content-specification hand-over'));
    assert.ok(issues.some((i) => i.startsWith('spec/Bad_Act: not an act directory')));
    assert.ok(issues.some((i) => i.startsWith('spec/README.md: not an act directory')));
    assert.ok(issues.some((i) => i.startsWith('spec/demo/latest: not a version directory')));
    assert.equal(loadSpecs(root).specs.length, 0);
  }, false);
});

test('layout: unparseable JSON, unparseable JSON-LD, a remote @context and a non-object DCAT record are refused', () => {
  withTree((dir) => {
    writeFileSync(join(dir, 'full.schema.json'), '{ not json');
  }, (root) => assert.match(loadSpecs(root).issues[0].message, /does not parse as JSON:/), false);

  withTree((dir) => {
    edit(dir, 'demo.context.jsonld', (t) => t.replace('"@version": 1.1,', '"@version": 1.1, "@base": 42,'));
  }, (root) => assert.match(loadSpecs(root).issues[0].message, /does not parse as JSON-LD:/), false);

  // design §2.3: the spec's own context is inline — no loader is configured, so a remote one fails
  withTree((dir) => {
    edit(dir, 'demo.jsonld', (t) => t.replace(/"@context": \{[\s\S]*?\n  \},/, '"@context": "https://example.org/remote.jsonld",'));
  }, (root) => {
    const [issue] = loadSpecs(root).issues;
    assert.equal(issue.file, 'spec/demo/v0.0.1/demo.jsonld');
    assert.match(issue.message, /does not parse as JSON-LD/);
  }, false);

  withTree((dir) => writeFileSync(join(dir, 'demo.dcat.jsonld'), '[]'), (root) => {
    assert.match(loadSpecs(root).issues[0].message, /the DCAT record is not a JSON object/);
  }, false);
});

// ------------------------------------------------------------------ the spec check

test('the green fixture passes the spec check, and runChecks runs it', () => {
  assert.deepEqual(specIssues(GREEN), []);
  const result = runChecks(loadRepo(GREEN)).find((r) => r.name === 'spec — hosted content specifications');
  assert.deepEqual(result?.issues, []);
});

test('spec check: a spec not marked proof of concept, or not CC0, is refused', () => {
  withTree((dir) => edit(dir, 'demo.jsonld', (t) => t.replace('"adms:status": { "@id": "mi:ProofOfConcept" }', '"adms:status": { "@id": "http://purl.org/adms/status/Completed" }')), (root) => {
    assert.deepEqual(specIssues(root), ['spec/demo/v0.0.1/demo.jsonld: adms:status is not exactly mi:ProofOfConcept — every hosted specification is a proof of concept and must say so in-band']);
  });
  withTree((dir) => edit(dir, 'demo.jsonld', (t) => t.replace('"dcterms:license": { "@id": "http://creativecommons.org/publicdomain/zero/1.0/" }', '"dcterms:license": { "@id": "https://creativecommons.org/licenses/by/4.0/" }')), (root) => {
    assert.deepEqual(specIssues(root), ['spec/demo/v0.0.1/demo.jsonld: dcterms:license is not exactly CC0 (<http://creativecommons.org/publicdomain/zero/1.0/>)']);
  });
});

test('spec check: the @id, version and act must match where the spec is served', () => {
  withTree((dir) => edit(dir, 'demo.jsonld', (t) => t.replace('"@id": "https://material-identity.eu/spec/demo/v0.0.1",', '"@id": "https://material-identity.eu/spec/demo/v0.0.2",')), (root) => {
    const issues = specIssues(root);
    assert.ok(issues[0].includes('no node https://material-identity.eu/spec/demo/v0.0.1 typed mi:ContentSpecification'));
  });
  withTree((dir) => edit(dir, 'demo.jsonld', (t) => t.replace('"dcat:version": "v0.0.1"', '"dcat:version": "v9.9.9"').replace('"mi:act": "demo"', '"mi:act": "steel"')), (root) => {
    assert.deepEqual(specIssues(root), [
      'spec/demo/v0.0.1/demo.jsonld: dcat:version is not "v0.0.1", the version directory it is served from',
      'spec/demo/v0.0.1/demo.jsonld: mi:act is not "demo", the act directory it is served from',
    ]);
  });
});

test('spec check: every pin must be a published entry, carry a digest, and match the served bytes', () => {
  withTree((dir) => edit(dir, 'demo.jsonld', (t) => t
    .replace('def:4eae703a-fa15-4118-8bc4-7926a22a12fb",\n      "checksum"', 'def:00000000-0000-4000-8000-000000000000",\n      "checksum"')
    .replace('"sha256": "51a28c90bcf24fc116251ef96216a331f278556bf92935dda49f345971cfe075"', '"sha256": "00"')
    .replace(/,\n      "checksum": \{ "algorithm": "spdx:checksumAlgorithm_sha256", "sha256": "a9ba77a7[0-9a-f]+" \}/, '')), (root) => {
    assert.deepEqual(specIssues(root), [
      'spec/demo/v0.0.1/demo.jsonld: pinned https://material-identity.eu/def/00000000-0000-4000-8000-000000000000 is not an entry in published/',
      'spec/demo/v0.0.1/demo.jsonld: pinned https://material-identity.eu/def/7a1e2c3d-4b5f-4a6e-9c8d-1f2e3d4c5b6a carries no spdx:checksum — a pin without a digest is never publishable',
      'spec/demo/v0.0.1/demo.jsonld: pinned https://material-identity.eu/def/c38a85eb-1a37-416d-ab21-7ddcc599754d has checksum 00, but /def/c38a85eb-1a37-416d-ab21-7ddcc599754d serves 51a28c90bcf24fc116251ef96216a331f278556bf92935dda49f345971cfe075',
    ]);
  });
  withTree((dir) => edit(dir, 'demo.jsonld', (t) => t.replace(/"pin": \[[\s\S]*?\n  \],/, '"pin": [],')), (root) => {
    assert.deepEqual(specIssues(root), ['spec/demo/v0.0.1/demo.jsonld: pins no dictionary entry (dcterms:requires → dcat:Distribution with a dcat:downloadURL)']);
  });
});

test('spec check: the DCAT record must describe the spec as PoC + CC0, and its checksums must match the hosted bytes', () => {
  // a hosted file changed without its record: the digest no longer covers what is served
  withTree((dir) => edit(dir, 'full.schema.json', (t) => t.replace('"maxItems": 2', '"maxItems": 3')), (root) => {
    const [issue, ...rest] = specIssues(root);
    assert.deepEqual(rest, []);
    assert.match(issue, /^spec\/demo\/v0\.0\.1\/demo\.dcat\.jsonld: distribution https:\/\/material-identity\.eu\/spec\/demo\/v0\.0\.1\/full\.schema\.json has checksum bb27ef5e[0-9a-f]+, but the hosted full\.schema\.json hashes to [0-9a-f]{64}$/);
  }, false);

  withTree((dir) => edit(dir, 'demo.dcat.jsonld', (t) => t
    .replace('"adms:status": { "@id": "mi:ProofOfConcept" }', '"adms:status": { "@id": "mi:Final" }')
    .replace('"dcterms:license": { "@id": "http://creativecommons.org/publicdomain/zero/1.0/" }', '"dcterms:license": { "@id": "https://example.org/proprietary" }')
    .replace('"dcat:downloadURL": { "@id": "https://material-identity.eu/spec/demo/v0.0.1" }', '"dcat:downloadURL": { "@id": "https://material-identity.eu/spec/demo/v0.0.1/elsewhere.jsonld" }')), (root) => {
    assert.deepEqual(specIssues(root), [
      'spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record does not mark the spec exactly mi:ProofOfConcept',
      'spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record\'s dcterms:license is not exactly CC0 (<http://creativecommons.org/publicdomain/zero/1.0/>)',
      'spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record lists no distribution of the hosted demo.jsonld (dcat:downloadURL <https://material-identity.eu/spec/demo/v0.0.1>)',
      'spec/demo/v0.0.1/demo.dcat.jsonld: distribution https://material-identity.eu/spec/demo/v0.0.1/elsewhere.jsonld is not a file hosted for this spec',
    ]);
  }, false);

  withTree((dir) => writeFileSync(join(dir, 'demo.dcat.jsonld'), '{ "@context": { "dcat": "http://www.w3.org/ns/dcat#" }, "@id": "https://material-identity.eu/catalog", "@type": "dcat:Catalog" }'), (root) => {
    const issues = specIssues(root);
    assert.ok(issues.includes('spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record has no node for https://material-identity.eu/spec/demo/v0.0.1'));
    assert.ok(issues.includes('spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record does not describe https://material-identity.eu/spec/demo/v0.0.1 as a dcat:Dataset'));
  }, false);
});

test('spec check reports layout issues too, so validate fails on a broken hand-over', () => {
  withTree((dir) => rmSync(join(dir, 'demo.context.jsonld')), (root) => {
    assert.deepEqual(specIssues(root), ['spec/demo/v0.0.1/demo.context.jsonld: missing from the hand-over']);
  }, false);
});

test('check 1 — spec/ is add-only like published/', () => {
  const issues = checkImmutability([
    { status: 'A', path: 'spec/steel/v0.0.3/steel.jsonld' },
    { status: 'M', path: 'spec/steel/v0.0.3/full.schema.json' },
    { status: 'D', path: 'spec/steel/v0.0.3/steel.context.jsonld' },
    { status: 'M', path: 'specs-notes.md' },
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['spec/steel/v0.0.3/full.schema.json', 'spec/steel/v0.0.3/steel.context.jsonld']);
  assert.match(issues[0].message, /hosted specification file modified — spec\/ is add-only/);
  assert.match(issues[1].message, /deleted/);
});

// ------------------------------------------------------------------ security review of #136

const NOT_REGULAR = 'is a symlink or other special file — everything under spec/ must be a regular file or directory';

test('layout: a symlinked file, version directory, act directory or spec/ itself is refused, never followed', () => {
  // a single served file pointing elsewhere: its target could change without a diff under spec/
  withTree((dir, root) => {
    writeFileSync(join(root, 'elsewhere.json'), readFileSync(join(dir, 'full.schema.json')));
    rmSync(join(dir, 'full.schema.json'));
    symlinkSync('../../../elsewhere.json', join(dir, 'full.schema.json'));
  }, (root) => {
    const { specs, issues } = loadSpecs(root);
    assert.deepEqual(issues.map((i) => `${i.file}: ${i.message}`), [`spec/demo/v0.0.1/full.schema.json: ${NOT_REGULAR}`]);
    assert.equal(specs.length, 0);
  }, false);

  // a whole version directory pointing at a self-consistent copy elsewhere
  withTree((dir, root) => {
    cpSync(dir, join(root, 'copy'), { recursive: true });
    symlinkSync('../../copy', join(root, 'spec', 'demo', 'v0.0.2'));
  }, (root) => {
    const { specs, issues } = loadSpecs(root);
    assert.deepEqual(issues.map((i) => `${i.file}: ${i.message}`), [`spec/demo/v0.0.2: ${NOT_REGULAR}`]);
    assert.deepEqual(specs.map((s) => s.version), ['v0.0.1']);
  }, false);

  withTree((_dir, root) => symlinkSync('demo', join(root, 'spec', 'alias')), (root) => {
    assert.deepEqual(loadSpecs(root).issues.map((i) => `${i.file}: ${i.message}`), [`spec/alias: ${NOT_REGULAR}`]);
  }, false);

  withTree((_dir, root) => {
    renameSync(join(root, 'spec'), join(root, 'real-spec'));
    symlinkSync('real-spec', join(root, 'spec'));
  }, (root) => {
    assert.deepEqual(loadSpecs(root), { specs: [], issues: [{ check: 'spec layout', file: 'spec', message: NOT_REGULAR }] });
  }, false);

  // a directory where a file belongs is simply not part of the hand-over
  withTree((dir) => mkdirSync(join(dir, 'extra')), (root) => {
    assert.deepEqual(loadSpecs(root).issues.map((i) => i.message), ['not part of a content-specification hand-over']);
  }, false);
});

test('check 1 — a symlink or submodule added under spec/ or published/ is refused; regular files pass', () => {
  const issues = checkImmutability([
    { status: 'A', path: 'spec/steel/v0.0.3/steel.jsonld', mode: '100644' },
    { status: 'A', path: 'spec/steel/v0.0.3/run.sh', mode: '100755' },
    { status: 'A', path: 'spec/steel/v0.0.4', mode: '120000' },
    { status: 'A', path: 'published/x.yaml', mode: '120000' },
    { status: 'A', path: 'spec/vendor', mode: '160000' },
    { status: 'A', path: 'drafts/link.yaml', mode: '120000' },
  ]);
  assert.deepEqual(issues.map((i) => i.file), ['spec/steel/v0.0.4', 'published/x.yaml', 'spec/vendor']);
  assert.match(issues[0].message, /added with git mode 120000, not as a regular file — a symlink or submodule under spec\//);
  assert.match(issues[1].message, /under published\//);
});

test('git diff --raw is parsed with the new mode, and a real added symlink fails check 1', () => {
  assert.deepEqual(parseRawDiff(':000000 120000 0000000 1a2b3c4 A\tspec/demo/v0.0.2\n:100644 100644 1111111 2222222 M\tREADME.md\n'), [
    { status: 'A', path: 'spec/demo/v0.0.2', mode: '120000' },
    { status: 'M', path: 'README.md', mode: '100644' },
  ]);

  const root = mkdtempSync(join(tmpdir(), 'spec-git-'));
  const gitc = (...args: string[]): void => {
    execFileSync('git', ['-C', root, '-c', 'user.email=test@test', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  };
  try {
    gitc('init', '-b', 'main');
    writeFileSync(join(root, 'README.md'), 'x\n');
    gitc('add', '-A');
    gitc('commit', '-m', 'base');
    gitc('checkout', '-b', 'link');
    mkdirSync(join(root, 'spec', 'demo'), { recursive: true });
    symlinkSync('../../README.md', join(root, 'spec', 'demo', 'v0.0.2'));
    gitc('add', '-A');
    gitc('commit', '-m', 'link');
    const ctx = createGitContext(root, 'main');
    assert.ok(isGitContext(ctx));
    assert.deepEqual(ctx.diff, [{ status: 'A', path: 'spec/demo/v0.0.2', mode: '120000' }]);
    assert.equal(checkImmutability(ctx.diff).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spec check: a second licence or status next to CC0 / mi:ProofOfConcept is refused, in the spec and in its record', () => {
  const second = (t: string): string => t
    .replace('"dcterms:license": { "@id": "http://creativecommons.org/publicdomain/zero/1.0/" }', '"dcterms:license": [{ "@id": "http://creativecommons.org/publicdomain/zero/1.0/" }, { "@id": "JAVASCRIPT:alert(document.domain)" }]')
    .replace('"adms:status": { "@id": "mi:ProofOfConcept" }', '"adms:status": [{ "@id": "mi:ProofOfConcept" }, { "@id": "javascript:alert(1)" }]');
  withTree((dir) => { edit(dir, 'demo.jsonld', second); edit(dir, 'demo.dcat.jsonld', second); }, (root) => {
    assert.deepEqual(specIssues(root), [
      'spec/demo/v0.0.1/demo.jsonld: adms:status is not exactly mi:ProofOfConcept — every hosted specification is a proof of concept and must say so in-band',
      'spec/demo/v0.0.1/demo.jsonld: dcterms:license is not exactly CC0 (<http://creativecommons.org/publicdomain/zero/1.0/>)',
      'spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record does not mark the spec exactly mi:ProofOfConcept',
      'spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record\'s dcterms:license is not exactly CC0 (<http://creativecommons.org/publicdomain/zero/1.0/>)',
    ]);
  });
});

test('the spec page links only http(s) IRIs; javascript: in any case, urn: and the like render as text', () => {
  assert.ok(isWebIri('https://x') && isWebIri('HTTP://x') && !isWebIri('javascript:alert(1)') && !isWebIri('urn:cen:en:18223:2026') && !isWebIri(undefined));
  const [spec] = loadSpecs(GREEN).specs;
  const summary = summarize(spec);
  const evil = ['javascript:alert(1)', 'JAVASCRIPT:alert(document.domain)', 'JaVaScRiPt:alert(2)', 'data:text/html,x'];
  const html = renderSpecPage(spec, {
    ...summary,
    license: evil[1],
    status: evil[0],
    series: evil[2],
    memberships: [{ path: ['x'], entry: evil[3], mandatory: true, accessCategory: evil[0] }],
  }, new RefIndex(loadRepo(GREEN)));
  assert.ok(!/<a href="(?!https?:\/\/|\/|#)/i.test(html), 'every link is http(s), site-relative or a fragment');
  for (const iri of evil) assert.ok(html.includes(`<code>${iri}</code>`), `${iri} is shown as text`);
  // the verified licence is still a link
  assert.match(renderSpecPage(spec, summary, new RefIndex(loadRepo(GREEN))), /<a href="http:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/" rel="external license">CC0 1\.0<\/a>/);
});

test('spec check: every served file needs a checksummed distribution, and every stated checksum must match', () => {
  // the context's distribution left out: nothing would hold that file fixed
  withTree((dir) => edit(dir, 'demo.dcat.jsonld', (t) => t.replace(/,\n      \{\n        "@id": "https:\/\/material-identity\.eu\/spec\/demo\/v0\.0\.1#context"[\s\S]*?\n      \}(?=,\n      \{)/, '')), (root) => {
    assert.deepEqual(specIssues(root), ['spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record lists no distribution of the hosted demo.context.jsonld (dcat:downloadURL <https://material-identity.eu/spec/demo/v0.0.1/context.jsonld>)']);
  }, false);

  // a distribution with no checksum, and a second distribution of the same file with a wrong one
  withTree((dir) => edit(dir, 'demo.dcat.jsonld', (t) => t
    .replace(/"spdx:checksum": \{[^\n]*"spdx:checksumValue": "eb16cf43[0-9a-f]+" \}/, '"dcat:byteSize": 1')
    .replace('"dcat:distribution": [', `"dcat:distribution": [
      { "@id": "${IRI}#again", "dcat:downloadURL": { "@id": "${IRI}/full.schema.json" }, "spdx:checksum": { "spdx:checksumValue": "00" } },`)), (root) => {
    const issues = specIssues(root);
    assert.equal(issues.length, 2, issues.join('\n'));
    assert.match(issues[0], /distribution https:\/\/material-identity\.eu\/spec\/demo\/v0\.0\.1\/compressed\.schema\.json has checksum \(none\)/);
    assert.match(issues[1], /distribution https:\/\/material-identity\.eu\/spec\/demo\/v0\.0\.1\/full\.schema\.json has checksum 00,/);
  }, false);
});

test('spec check: the DCAT record may state things only about its spec and the spec\'s #fragments', () => {
  const [spec] = loadSpecs(GREEN).specs;
  assert.deepEqual(foreignSubjects(spec), [], 'references to the release and the series are fine; only statements count');

  const entry = 'https://material-identity.eu/def/4eae703a-fa15-4118-8bc4-7926a22a12fb';
  withTree((dir) => edit(dir, 'demo.dcat.jsonld', (t) => t
    .replace('"dcterms:requires": { "@id": "https://material-identity.eu/release/v2026.08.28" }', '"dcterms:requires": { "@id": "https://material-identity.eu/release/v2026.08.28", "dcterms:title": "hijacked" }')
    .replace('"dcat:version": "v0.0.1",', `"dcat:version": "v0.0.1", "@reverse": { "dcterms:replaces": { "@id": "${entry}" } }, "@included": [{ "@id": "https://material-identity.eu/spec/other/v1.0.0", "dcterms:title": "x" }],`)), (root) => {
    const issues = specIssues(root);
    const about = (s: string): string => `spec/demo/v0.0.1/demo.dcat.jsonld: the DCAT record states something about ${s}, which is not this spec or one of its #fragments — /catalog takes only statements about the spec`;
    assert.deepEqual(issues, [entry, 'https://material-identity.eu/release/v2026.08.28', 'https://material-identity.eu/spec/other/v1.0.0'].map(about));
  });

  // a named graph inside the node is reported by its name
  const graphed = { ...spec, dcatJson: { '@id': IRI, 'http://purl.org/dc/terms/title': 'x', '@graph': [{ '@id': 'https://x/y', 'http://purl.org/dc/terms/title': 'y' }] } };
  assert.deepEqual(foreignSubjects(graphed), [`graph ${IRI}`]);
  assert.deepEqual(foreignSubjects({ ...spec, dcatJson: {} }), []);
});

// ------------------------------------------------------------------ build

test('the build serves every spec file byte-identical at the origin path the Worker maps its IRI onto', () => {
  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  try {
    build(GREEN, out);
    const src = join(GREEN, REL);
    const dst = join(out, REL);
    assert.deepEqual(readFileSync(join(dst, 'index.jsonld')), readFileSync(join(src, 'demo.jsonld')));
    assert.deepEqual(readFileSync(join(dst, 'context.jsonld')), readFileSync(join(src, 'demo.context.jsonld')));
    assert.deepEqual(readFileSync(join(dst, 'compressed.schema.json')), readFileSync(join(src, 'compressed.schema.json')));
    assert.deepEqual(readFileSync(join(dst, 'full.schema.json')), readFileSync(join(src, 'full.schema.json')));

    const html = readFileSync(join(dst, 'index.html'), 'utf8');
    assert.ok(html.includes(pocBanner()), 'the spec page carries the PoC banner');
    assert.match(html, /<link rel="canonical" href="https:\/\/material-identity\.eu\/spec\/demo\/v0\.0\.1">/);
    assert.match(html, /<link rel="alternate" type="application\/ld\+json" href="\/spec\/demo\/v0\.0\.1\/index\.jsonld">/);
    assert.match(html, /<h1>Demo content specification — test fixture \(PoC\)<\/h1>/);
    assert.match(html, /<p class="lede" lang="de">Demo-Inhaltsspezifikation — Testdatensatz \(PoC\)<\/p>/);
    assert.match(html, /<a href="\/ns#ProofOfConcept">mi:ProofOfConcept<\/a>/);
    assert.match(html, /rel="external license">CC0 1\.0<\/a>/);
    assert.match(html, /<a href="\/spec\/demo">https:\/\/material-identity\.eu\/spec\/demo<\/a>/);
    for (const name of [...SERVED, 'demo.dcat.jsonld']) {
      assert.ok(html.includes(`<code>${sha(readFileSync(join(src, name)))}</code>`), `the page shows the SHA-256 of ${name}`);
    }
    for (const link of ['/spec/demo/v0.0.1/context.jsonld', '/spec/demo/v0.0.1/compressed.schema.json', '/spec/demo/v0.0.1/full.schema.json', '/catalog']) {
      assert.ok(html.includes(`<a href="${link}">`), `the page links ${link}`);
    }
    // pins and memberships in sh:order, nested paths dotted, conditions shown
    assert.match(html, /<a href="\/def\/c38a85eb-1a37-416d-ab21-7ddcc599754d">Maximum allowable pressure<\/a><\/td><td><code>https:\/\/material-identity\.eu\/def\/c38a85eb-1a37-416d-ab21-7ddcc599754d<\/code><\/td><td><code>51a28c90/);
    const order = ['<code>mechanicalProperties</code>', '<code>mechanicalProperties.maxPressure</code>', '<code>steelmakingRoute</code>'].map((s) => html.indexOf(s));
    assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'memberships follow sh:order, children under their parent');
    assert.match(html, /optional<br><span class="meta">Mandatory where the route is known\.<\/span>/);
    assert.ok(!/<script/i.test(html));

    // the series index: JSON-LD that parses, and an HTML page
    const series = parseJsonLd(readFileSync(join(out, 'spec', 'demo', 'index.jsonld'), 'utf8'), 'https://material-identity.eu/spec/demo');
    assert.ok(ask(series, `<https://material-identity.eu/spec/demo> a <http://www.w3.org/ns/dcat#DatasetSeries> ;
      <http://www.w3.org/ns/dcat#hasVersion> <${IRI}> ; <http://www.w3.org/ns/dcat#seriesMember> <${IRI}> ;
      <http://www.w3.org/ns/adms#status> <https://material-identity.eu/ns#ProofOfConcept> .`));
    const seriesHtml = readFileSync(join(out, 'spec', 'demo', 'index.html'), 'utf8');
    assert.ok(seriesHtml.includes(pocBanner()));
    assert.match(seriesHtml, /<a href="\/spec\/demo\/v0\.0\.1"><code>v0\.0\.1<\/code><\/a>/);
    assert.match(seriesHtml, /<link rel="canonical" href="https:\/\/material-identity\.eu\/spec\/demo">/);

    // the catalogue lists the spec with the checksums from its own record
    const catalog = parseJsonLd(readFileSync(join(out, 'catalog', 'index.jsonld'), 'utf8'), 'https://material-identity.eu/catalog');
    assert.ok(ask(catalog, `<https://material-identity.eu/catalog> a <http://www.w3.org/ns/dcat#Catalog> ; <http://www.w3.org/ns/dcat#dataset> <${IRI}> .`));
    assert.ok(ask(catalog, `<${IRI}> <http://www.w3.org/ns/dcat#distribution> ?d . ?d <http://www.w3.org/ns/dcat#downloadURL> <${IRI}> ;
      <http://spdx.org/rdf/terms#checksum> [ <http://spdx.org/rdf/terms#checksumValue> "${sha(readFileSync(join(src, 'demo.jsonld')))}" ] .`));
    assert.ok(readFileSync(join(out, 'catalog', 'index.html'), 'utf8').includes(pocBanner()));

    // the vocabulary is served in three representations
    for (const name of ['index.ttl', 'index.jsonld', 'index.html']) assert.ok(readFileSync(join(out, 'ns', name), 'utf8').length > 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('emitSpecs refuses a spec tree that does not load', () => {
  withTree((dir) => renameSync(join(dir, 'full.schema.json'), join(dir, 'full.json')), (root) => {
    const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
    try {
      assert.throws(() => emitSpecs(root, out, new RefIndex(loadRepo(root))), /unloadable spec\/ tree:\nspec\/demo\/v0\.0\.1\/full\.schema\.json: missing/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, false);
});

// ------------------------------------------------------------------ DCAT

test('findDatasetNode finds the record root or a nested dataset, never a bare reference', () => {
  const iri = 'https://x/spec/a/v1.0.0';
  assert.deepEqual(findDatasetNode({ '@id': iri, '@type': 'dcat:Dataset' }, iri), { '@id': iri, '@type': 'dcat:Dataset' });
  const nested = { '@id': 'https://x/catalog', 'dcat:dataset': [{ '@id': iri }, { '@id': iri, 'dcat:version': 'v1.0.0' }] };
  assert.deepEqual(findDatasetNode(nested, iri), { '@id': iri, 'dcat:version': 'v1.0.0' });
  assert.equal(findDatasetNode({ '@context': { '@id': iri, x: 1 } }, iri), undefined);
  assert.equal(findDatasetNode('nope', iri), undefined);
});

test('a spec dataset is embedded with its record\'s context, so its terms keep their meaning', () => {
  const [spec] = loadSpecs(GREEN).specs;
  const node = embeddedDataset(spec)!;
  assert.deepEqual(node['@context'], spec.dcatJson['@context']);
  assert.equal(node['@id'], IRI);
  // a node with a context of its own keeps both, record context first
  const inner = embeddedDataset({ ...spec, dcatJson: { '@context': { a: 'https://a/' }, '@id': IRI, 'a:p': 1 } as Record<string, unknown> });
  assert.deepEqual(inner?.['@context'], { a: 'https://a/' });
  const both = embeddedDataset({ ...spec, dcatJson: { '@context': { a: 'https://a/' }, x: { '@context': { b: 'https://b/' }, '@id': IRI, 'a:p': 1 } } });
  assert.deepEqual(both?.['@context'], [{ a: 'https://a/' }, { b: 'https://b/' }]);
  const none = embeddedDataset({ ...spec, dcatJson: { '@id': IRI, 'http://purl.org/dc/terms/title': 'x' } });
  assert.equal(none?.['@context'], undefined);
  assert.equal(embeddedDataset({ ...spec, dcatJson: {} }), undefined);
});

test('the catalogue lists releases, series and specs; it parses, is PoC-marked and deterministic', () => {
  const { specs } = loadSpecs(GREEN);
  const releases = [{ tag: 'v2026.09.30', date: '2026-09-30' }, { tag: 'v2026.08.28', date: '2026-08-28' }];
  const doc = buildCatalog(releases, specs);
  assert.equal(JSON.stringify(doc), JSON.stringify(buildCatalog([...releases].reverse(), [...specs].reverse())));
  const store = parseJsonLd(JSON.stringify(doc), 'https://material-identity.eu/catalog');
  const cat = '<https://material-identity.eu/catalog>';
  assert.ok(ask(store, `${cat} <http://www.w3.org/ns/adms#status> <https://material-identity.eu/ns#ProofOfConcept> ; <http://purl.org/dc/terms/license> <http://creativecommons.org/publicdomain/zero/1.0/> .`));
  assert.ok(ask(store, `${cat} <http://www.w3.org/ns/dcat#dataset> <https://material-identity.eu/release/v2026.08.28> .
    <https://material-identity.eu/release/v2026.08.28> <http://www.w3.org/ns/dcat#version> "v2026.08.28" ;
      <http://purl.org/dc/terms/issued> "2026-08-28"^^<http://www.w3.org/2001/XMLSchema#date> ;
      <http://www.w3.org/ns/dcat#landingPage> <https://github.com/material-identity/dictionary/releases/tag/v2026.08.28> .`));
  assert.ok(ask(store, `${cat} <http://www.w3.org/ns/dcat#dataset> <https://material-identity.eu/spec/demo> .`));
  const ids = (doc['dcat:dataset'] as Array<{ '@id': string }>).map((d) => d['@id']);
  assert.deepEqual(ids, ['https://material-identity.eu/release/v2026.08.28', 'https://material-identity.eu/release/v2026.09.30', 'https://material-identity.eu/spec/demo', IRI]);

  // a spec whose record lost its node still appears, by reference
  const bare = buildCatalog([], [{ ...specs[0], dcatJson: {} }]);
  assert.deepEqual((bare['dcat:dataset'] as unknown[]).at(-1), { '@id': IRI });
});

test('the series lists each version once, issued date and title from the spec itself', () => {
  const { specs } = loadSpecs(GREEN);
  const doc = buildSeries('demo', specs);
  const [member] = doc['dcat:seriesMember'] as Array<Record<string, unknown>>;
  assert.deepEqual(member['dcterms:issued'], { '@value': '2026-11-02', '@type': 'xsd:date' });
  assert.equal(member['dcat:version'], 'v0.0.1');
  assert.equal((member['dcterms:title'] as Array<{ '@language': string }>)[0]['@language'], 'en');
});

test('release tags come from git: vYYYY.MM.DD only, sorted; none outside a work-tree root', () => {
  const tags = getReleaseTags(join(here, '..'));
  assert.ok(tags.every((t) => /^v\d{4}\.\d{2}\.\d{2}$/.test(t.tag) && /^\d{4}-\d{2}-\d{2}$/.test(t.date)));
  assert.deepEqual(tags.map((t) => t.tag), [...tags.map((t) => t.tag)].sort());
  assert.deepEqual(getReleaseTags(GREEN), []);
});

// ------------------------------------------------------------------ PoC marking and the vocabulary

test('the PoC banner is bilingual and unmistakable', () => {
  const banner = pocBanner();
  assert.match(banner, /^<div class="banner poc" role="note">/);
  assert.match(banner, /<strong>Proof of concept\.<\/strong> Not a content specification of the European Union/);
  assert.match(banner, /<p lang="de"><strong>Proof of Concept\.<\/strong> Keine Inhaltsspezifikation der Europäischen Union/);
  assert.match(readFileSync(join(here, '..', 'scripts', 'lib', 'styles.css'), 'utf8'), /\.banner\.poc \{/);
});

test('the catalogue page says so when nothing is hosted yet', () => {
  const html = renderCatalogPage([], []);
  assert.ok(html.includes(pocBanner()));
  assert.match(html, /No content specification is hosted yet\./);
  assert.match(html, /No release in this build\./);
  assert.match(html, /<link rel="canonical" href="https:\/\/material-identity\.eu\/catalog">/);
  const listed = renderCatalogPage([{ tag: 'v2026.08.28', date: '2026-08-28' }], []);
  assert.match(listed, /<a href="https:\/\/github\.com\/material-identity\/dictionary\/releases\/tag\/v2026\.08\.28" rel="external"><code>v2026\.08\.28<\/code><\/a>/);
});

const NEW_TERMS = ['elementId', 'granularity', 'model', 'batch', 'item', 'operator', 'condition', 'ContentSpecification', 'ProofOfConcept',
  'act', 'dppSchemaVersion', 'passportContext', 'uniqueProductIdentifier', 'dppStatus', 'economicOperatorId', 'facilityId'];

test('the vocabulary carries every content-specification term with a label and a comment (design §3.3)', () => {
  const terms = new Map(vocabularyTerms().map(([term, kind, label, comment]) => [term, { kind, label, comment }]));
  for (const t of NEW_TERMS) {
    assert.ok(terms.has(t), `mi:${t} is missing`);
    assert.ok(terms.get(t)!.label.length > 0 && terms.get(t)!.comment.length > 0, `mi:${t} needs a label and a comment`);
  }
  assert.equal(terms.get('ContentSpecification')!.kind, 'Class');
  for (const t of ['model', 'batch', 'item', 'operator', 'ProofOfConcept']) assert.equal(terms.get(t)!.kind, 'Individual');
});

test('/ns as Turtle and as JSON-LD parse to the same graph, PoC-marked; the HTML anchors every term', () => {
  const ttl = new oxigraph.Store();
  ttl.load(renderVocabularyTurtle(), { format: 'text/turtle' });
  const jsonld = parseJsonLd(renderVocabularyJsonLd(), 'https://material-identity.eu/ns');
  assert.equal(ttl.size, jsonld.size);
  for (const store of [ttl, jsonld]) {
    assert.ok(ask(store, `<https://material-identity.eu/ns> a <http://www.w3.org/2002/07/owl#Ontology> ;
      <http://www.w3.org/ns/adms#status> <https://material-identity.eu/ns#ProofOfConcept> ;
      <http://purl.org/dc/terms/license> <http://creativecommons.org/publicdomain/zero/1.0/> .`));
    assert.ok(ask(store, `<https://material-identity.eu/ns#elementId> a <http://www.w3.org/1999/02/22-rdf-syntax-ns#Property> ;
      <http://www.w3.org/2000/01/rdf-schema#isDefinedBy> <https://material-identity.eu/ns> .`));
    assert.ok(ask(store, `<https://material-identity.eu/ns#batch> a <http://www.w3.org/2004/02/skos/core#Concept> .`));
    assert.ok(ask(store, `<https://material-identity.eu/ns#ContentSpecification> a <http://www.w3.org/2000/01/rdf-schema#Class> .`));
  }
  const html = renderVocabularyPage(vocabularyTerms());
  assert.ok(html.includes(pocBanner()));
  for (const t of NEW_TERMS) assert.ok(html.includes(`<tr id="${t}">`), `/ns#${t} has an anchor`);
  assert.match(html, /<link rel="canonical" href="https:\/\/material-identity\.eu\/ns">/);
});
