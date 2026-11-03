#!/usr/bin/env tsx
// Build (plan §4 M3, redesigned per issue #57): repo model → site/ — canonical JSON +
// human HTML per entry, one stylesheet. Deterministic transform, no network, content
// never altered. Usage: npm run build [-- --root <dir>] [-- --out <dir>]
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRepo } from './lib/repo.ts';
import { canonicalJson } from './lib/emit.ts';
import { type ExampleSpec, RefIndex, renderAboutPage, renderCatalogPage, renderEntryPage, renderExamplesPage, renderGraphPage, renderIndexPages, renderReleaseIndexPage, renderReleasePage, renderSchemaPage, renderSeriesPage, renderSpecPage, renderTreePage, renderVocabularyPage } from './lib/render.ts';
import { renderFeed } from './lib/feed.ts';
import { citation } from './lib/cite.ts';
import { renderTurtle, renderVocabularyJsonLd, renderVocabularyTurtle, vocabularyTerms } from './lib/rdf.ts';
import { getAddedDates, getReleases, getReleaseTags } from './lib/git.ts';
import { buildCatalog, buildRelease, buildReleaseIndex, buildSeries, byAct, jsonLd, releaseContents, type SummarizedSpec } from './lib/dcat.ts';
import { loadSpecs, summarize } from './lib/spec.ts';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
// The schema is one canonical file for the whole site, independent of which content tree
// --root points at (a fixture tree has no schema/ of its own) — same fixed-path approach
// checks.ts uses for validation.
const SCHEMA_PATH = join(LIB_DIR, '..', 'schema', 'dictionary-entry.schema.json');
const CONTEXT_PATH = join(LIB_DIR, '..', 'rdf', 'context.jsonld');
// RFC 8615 well-known URIs, copied wholesale so adding e.g. a security.txt needs no code (#107).
const WELL_KNOWN_PATH = join(LIB_DIR, '..', '.well-known');
// ...but emitted WITHOUT the dot (#110): actions/upload-pages-artifact tars with
// `--exclude=.[^/]*`, so a site/.well-known/ is silently dropped and the URL 404s in production.
// The Worker maps the canonical /.well-known/<x> onto this path; the origin is never advertised.
const WELL_KNOWN_OUT = 'well-known';
// Reference examples (#130) — content specifications that USE the dictionary. Not entries: never
// under published/, copied wholesale like .well-known, with a derived /examples/ index page.
export const EXAMPLES_PATH = join(LIB_DIR, '..', 'examples');

export interface BuildResult {
  entries: number;
  out: string;
}

export function build(root: string, out: string): BuildResult {
  const repo = loadRepo(root);
  if (repo.errors.length > 0) {
    const detail = repo.errors.map((e) => `${e.file}: ${e.message}`).join('\n');
    throw new Error(`refusing to build from an unloadable repo:\n${detail}`);
  }
  const refs = new RefIndex(repo);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'def'), { recursive: true });
  mkdirSync(join(out, 'schema'), { recursive: true });
  cpSync(join(LIB_DIR, 'lib', 'styles.css'), join(out, 'styles.css'));
  cpSync(SCHEMA_PATH, join(out, 'schema', 'dictionary-entry.schema.json'));
  writeFileSync(join(out, 'schema', 'index.html'), renderSchemaPage(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))));

  const addedDates = getAddedDates(root);
  // Entries are cited by the release they shipped in; one merged since the last tag has no
  // release yet and falls back to its add-date (see cite.ts).
  const releases = getReleases(root);
  let entries = 0;
  for (const file of repo.published) {
    if (!file.doc) continue;
    const release = releases.get(file.relPath);
    const addedDate = release?.date ?? addedDates.get(file.relPath);
    writeFileSync(join(out, 'def', `${file.stem}.json`), canonicalJson(file.doc));
    writeFileSync(join(out, 'def', `${file.stem}.html`), renderEntryPage(file, repo, refs, addedDate, release?.tag));
    writeFileSync(join(out, 'def', `${file.stem}.csl.json`), `${JSON.stringify(
      citation(file.doc, file.stem, { date: addedDate, release: release?.tag, supersededBy: refs.supersededByEntry(file.doc)?.id as string | undefined }).csl, null, 2)}\n`);
    entries += 1;
  }
  for (const page of renderIndexPages(repo, refs)) {
    writeFileSync(join(out, page.name), page.html);
  }
  writeFileSync(join(out, 'feed.xml'), renderFeed(repo, addedDates));
  writeFileSync(join(out, 'superseded.json'), `${JSON.stringify(refs.supersededMap(), null, 2)}\n`);
  mkdirSync(join(out, 'tree'), { recursive: true });
  writeFileSync(join(out, 'tree', 'index.html'), renderTreePage(repo, refs));
  mkdirSync(join(out, 'graph'), { recursive: true });
  writeFileSync(join(out, 'graph', 'index.html'), renderGraphPage(repo, refs));
  // newest release tag, for the About page's live counts
  const latestRelease = [...releases.values()].sort((a, b) => a.date.localeCompare(b.date)).at(-1)?.tag;
  mkdirSync(join(out, 'about'), { recursive: true });
  writeFileSync(join(out, 'about', 'index.html'), renderAboutPage(repo, refs, latestRelease));

  // RDF track steps 1–2 (issue #98): the context is the semantic commitment, the Turtle is a
  // derived second serialization. The canonical /def/<uuid>.json is untouched by both.
  cpSync(CONTEXT_PATH, join(out, 'context.jsonld'));
  if (existsSync(WELL_KNOWN_PATH)) cpSync(WELL_KNOWN_PATH, join(out, WELL_KNOWN_OUT), { recursive: true });
  if (existsSync(EXAMPLES_PATH)) {
    cpSync(EXAMPLES_PATH, join(out, 'examples'), { recursive: true });
    writeFileSync(join(out, 'examples', 'index.html'), renderExamplesPage(loadExampleSpecs(EXAMPLES_PATH), refs));
  }
  const issued = new Map([...releases].map(([path, release]) => [path, release.date]));
  writeFileSync(join(out, 'dictionary.ttl'), renderTurtle(repo, refs, issued));

  // The mi: vocabulary, resolvable at /ns (#135): the same term list /dictionary.ttl describes.
  mkdirSync(join(out, 'ns'), { recursive: true });
  writeFileSync(join(out, 'ns', 'index.ttl'), renderVocabularyTurtle());
  writeFileSync(join(out, 'ns', 'index.jsonld'), renderVocabularyJsonLd());
  writeFileSync(join(out, 'ns', 'index.html'), renderVocabularyPage(vocabularyTerms()));

  const specs = emitSpecs(root, out, refs);
  const tags = getReleaseTags(root);
  mkdirSync(join(out, 'catalog'), { recursive: true });
  writeFileSync(join(out, 'catalog', 'index.jsonld'), jsonLd(buildCatalog(tags, specs.map(({ spec }) => spec))));
  writeFileSync(join(out, 'catalog', 'index.html'), renderCatalogPage(tags, specs));

  // Dictionary releases at /release/<tag> (#135): what each tag contains, derived from git like the
  // citations above. The index is always written, so it exists (empty) in a build without tags.
  const contents = releaseContents(tags, releases, repo);
  mkdirSync(join(out, 'release'), { recursive: true });
  writeFileSync(join(out, 'release', 'index.jsonld'), jsonLd(buildReleaseIndex(tags)));
  writeFileSync(join(out, 'release', 'index.html'), renderReleaseIndexPage(contents));
  for (const release of contents) {
    const dir = join(out, 'release', release.tag);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.jsonld'), jsonLd(buildRelease(release)));
    writeFileSync(join(dir, 'index.html'), renderReleasePage(release, refs));
  }
  return { entries, out };
}

/**
 * Hosted content specifications (#135): `spec/<act>/<version>/` → `site/spec/<act>/<version>/`,
 * every served file byte-identical under the name the Worker maps its IRI onto, plus an HTML page
 * per spec and a JSON-LD + HTML series index per act. Refuses a spec tree that does not load.
 * Each spec is summarized once here and the summary passed on to every page that shows it.
 */
export function emitSpecs(root: string, out: string, refs: RefIndex): SummarizedSpec[] {
  const { specs, issues } = loadSpecs(root);
  if (issues.length > 0) {
    throw new Error(`refusing to build from an unloadable spec/ tree:\n${issues.map((i) => `${i.file}: ${i.message}`).join('\n')}`);
  }
  const summaries = new Map(specs.map((spec) => [spec, summarize(spec)]));
  const summarized = (spec: (typeof specs)[number]): SummarizedSpec => ({ spec, summary: summaries.get(spec)! });
  for (const spec of specs) {
    const dir = join(out, spec.relDir);
    mkdirSync(dir, { recursive: true });
    for (const file of spec.files) if (file.served !== undefined) writeFileSync(join(dir, file.served), file.bytes);
    writeFileSync(join(dir, 'index.html'), renderSpecPage(spec, summaries.get(spec)!, refs));
  }
  for (const [act, versions] of byAct(specs)) {
    const dir = join(out, 'spec', act);
    const members = versions.map(summarized);
    writeFileSync(join(dir, 'index.jsonld'), jsonLd(buildSeries(act, members)));
    writeFileSync(join(dir, 'index.html'), renderSeriesPage(act, members));
  }
  return specs.map(summarized);
}

/** Every examples/content-specifications/*.json, sorted, with the SHA-256 of its exact bytes. */
export function loadExampleSpecs(dir: string): ExampleSpec[] {
  const specDir = join(dir, 'content-specifications');
  if (!existsSync(specDir)) return [];
  return readdirSync(specDir).filter((n) => n.endsWith('.json')).sort().map((name) => {
    const bytes = readFileSync(join(specDir, name));
    return { path: `content-specifications/${name}`, doc: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = flagValue(args, '--root') ?? process.cwd();
  const out = flagValue(args, '--out') ?? join(root, 'site');
  const result = build(root, out);
  console.log(`built ${result.entries} entries into ${result.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
