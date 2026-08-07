import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo, DEF_PREFIX, CONCEPT_PREFIX, type RepoModel } from '../scripts/lib/repo.ts';
import { RefIndex, renderIndexPages, INDEX_PAGE_SIZE } from '../scripts/lib/render.ts';
import { build } from '../scripts/build.ts';
import worker, { decide } from '../worker/index.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const GREEN = join(fixtures, 'green');
const MP2 = '450ecc7b-4cb6-4abf-bacb-35661132d321';

// ------------------------------------------------------------------ index (#24)

test('green build emits a single index page with one row per entry, status from concept', () => {
  const out = mkdtempSync(join(tmpdir(), 'dict-site-'));
  try {
    build(GREEN, out);
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.equal((html.match(/<tr>\n<td>/g) ?? []).length, 7);
    assert.match(html, new RegExp(`<a href="/def/${MP2}">Maximum allowable pressure</a>`));
    assert.match(html, /<span class="status tombstoned">tombstoned<\/span>/); // maxPressure v1
    assert.match(html, /<span class="status active">active<\/span>/);
    assert.ok(!html.includes('page-2.html'), 'seven entries fit one page');
    assert.ok(!/<script/i.test(html));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

function syntheticRepo(count: number): RepoModel {
  const pad = (i: number): string => String(i).padStart(2, '0');
  const uuid = (i: number): string => `${pad(i)}345678-0000-4000-8000-0000000000${pad(i)}`;
  const cuuid = (i: number): string => `${pad(i)}345678-0000-4000-8000-1111111111${pad(i)}`;
  const published = Array.from({ length: count }, (_, i) => ({
    dir: 'published' as const,
    name: `${uuid(i)}.yaml`,
    stem: uuid(i),
    relPath: `published/${uuid(i)}.yaml`,
    doc: {
      id: `${DEF_PREFIX}${uuid(i)}`,
      isVersionOf: `${CONCEPT_PREFIX}${cuuid(i)}`,
      version: '1',
      isDefinedBy: 'https://material-identity.eu/',
      objectType: 'SingleValuedDataElement',
      shortName: `entry${pad(i)}`,
      preferredName: { en: `Entry ${pad(i)}` },
      valueDataType: 'xsd:string',
    },
  }));
  const concepts = published.map((p, i) => ({
    dir: 'concepts' as const,
    name: `${cuuid(i)}.yaml`,
    stem: cuuid(i),
    relPath: `concepts/${cuuid(i)}.yaml`,
    doc: {
      id: `${CONCEPT_PREFIX}${cuuid(i)}`,
      isDefinedBy: 'https://material-identity.eu/',
      objectType: 'Concept',
      shortName: `entry${pad(i)}`,
      preferredName: { en: `Entry ${pad(i)}` },
      currentVersion: String(p.doc.id),
      versions: [{ entry: String(p.doc.id), version: '1', status: 'active' }],
    },
  }));
  return { root: '/synthetic', drafts: [], published, concepts, errors: [] };
}

test('index paginates at the 25 boundary: 26 entries → two pages with prev/next nav', () => {
  const repo = syntheticRepo(INDEX_PAGE_SIZE + 1);
  const pages = renderIndexPages(repo, new RefIndex(repo));
  assert.deepEqual(pages.map((p) => p.name), ['index.html', 'page-2.html']);
  assert.equal((pages[0].html.match(/<tr>\n<td>/g) ?? []).length, 25);
  assert.equal((pages[1].html.match(/<tr>\n<td>/g) ?? []).length, 1);
  assert.match(pages[0].html, /page 1 of 2/);
  assert.match(pages[0].html, /<a href="\/page-2.html">next →<\/a>/);
  assert.match(pages[1].html, /<a href="\/index.html">← previous<\/a>/);
  // sorted by preferredName: Entry 00 first, Entry 25 alone on page 2
  assert.match(pages[0].html, /Entry 00/);
  assert.match(pages[1].html, /Entry 25/);
  assert.ok(!pages[1].html.includes('Entry 24'));
});

test('exactly 25 entries stay on one page; empty repo still renders an index', () => {
  const exact = renderIndexPages(syntheticRepo(INDEX_PAGE_SIZE), new RefIndex(syntheticRepo(INDEX_PAGE_SIZE)));
  assert.deepEqual(exact.map((p) => p.name), ['index.html']);
  const empty = renderIndexPages(syntheticRepo(0), new RefIndex(syntheticRepo(0)));
  assert.deepEqual(empty.map((p) => p.name), ['index.html']);
  assert.match(empty[0].html, /0 published entries/);
});

// ------------------------------------------------------------------ worker (#26)

test('decide: JSON is the default; HTML only when Accept names text/html', () => {
  const uuid = '450ecc7b-4cb6-4abf-bacb-35661132d321';

  const json = decide(`/def/${uuid}`, 'application/json');
  assert.equal(json.originPath, `/def/${uuid}.json`);
  assert.equal(json.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(json.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(json.headers.link, undefined);

  const star = decide(`/def/${uuid}`, '*/*'); // curl default → JSON
  assert.equal(star.originPath, `/def/${uuid}.json`);

  const none = decide(`/def/${uuid}`, null);
  assert.equal(none.originPath, `/def/${uuid}.json`);

  const browser = decide(`/def/${uuid}`, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
  assert.equal(browser.originPath, `/def/${uuid}.html`);
  assert.equal(browser.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(browser.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(browser.headers.link, `</def/${uuid}>; rel="canonical"`);
});

test('decide: concept resources get the short cache; everything else passes through', () => {
  const uuid = 'ca087cb9-f189-41a1-b082-2288eaacd5e7';
  const concept = decide(`/concept/${uuid}`, 'application/json');
  assert.equal(concept.originPath, `/concept/${uuid}.json`);
  assert.equal(concept.headers['cache-control'], 'public, max-age=300');

  assert.deepEqual(decide('/', 'text/html'), { originPath: '/index.html', headers: { 'cache-control': 'public, max-age=300' } });
  assert.equal(decide('/page-2.html', 'text/html').originPath, '/page-2.html');
  assert.equal(decide('/styles.css', 'text/css').originPath, '/styles.css');
  assert.equal(decide(`/def/${uuid}.json`, '*/*').originPath, `/def/${uuid}.json`); // raw origin file stays reachable
  assert.equal(decide('/def/not-a-uuid', '*/*').originPath, '/def/not-a-uuid'); // no negotiation for non-UUID paths
});

test('worker fetch handler maps to the origin and stamps headers (stubbed origin)', async () => {
  const uuid = '450ecc7b-4cb6-4abf-bacb-35661132d321';
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (url.endsWith('/missing.css')) return new Response('nope', { status: 404 });
    return new Response(url.endsWith('.json') ? '{"ok":true}' : '<html></html>', { status: 200 });
  }) as typeof fetch;
  try {
    const env = { ORIGIN: 'https://origin.example/dictionary' };
    const res = await worker.fetch(new Request(`https://material-identity.eu/def/${uuid}`, { headers: { accept: 'application/json' } }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(seen, [`https://origin.example/dictionary/def/${uuid}.json`]);

    const missing = await worker.fetch(new Request('https://material-identity.eu/missing.css'), env);
    assert.equal(missing.status, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});
