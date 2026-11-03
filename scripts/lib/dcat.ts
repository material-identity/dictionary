/**
 * The DCAT catalogue at /catalog and the version series at /spec/<act> (#135; schema design
 * content-spec-jsonld.md §2.1, §7.3). Both are derived at build time, like /feed.xml: a new
 * dictionary release or a newly hosted specification joins them, so they get a short cache.
 *
 * A hosted spec enters the catalogue through its own `<act>.dcat.jsonld` record, merged as
 * written: the record's dataset node is embedded with the record's own `@context` (JSON-LD 1.1
 * allows a context on any node object), so its terms and its checksums keep exactly the meaning
 * the schema repo generated. Nothing here recomputes or rewrites a digest.
 *
 * Deterministic: releases sorted by tag, specs by act then version, keys in a fixed order.
 * Everything is a proof of concept and says so in-band (`adms:status mi:ProofOfConcept`).
 */
import { entrySha256 } from './emit.ts';
import { type Release, releaseAsset, releaseLandingPage, shippedBy } from './git.ts';
import { CANONICAL_BASE, DEF_PREFIX, type RepoModel } from './repo.ts';
import { ADMS, CC0, VOCABULARY } from './rdf.ts';
import type { HostedSpec, SpecSummary } from './spec.ts';

export const CATALOG_IRI = `${CANONICAL_BASE}/catalog`;
export const RELEASES_IRI = `${CANONICAL_BASE}/release`;
export const releaseIri = (tag: string): string => `${RELEASES_IRI}/${tag}`;
export const seriesIri = (act: string): string => `${CANONICAL_BASE}/spec/${act}`;

export const CONTEXT = {
  '@version': 1.1,
  dcat: 'http://www.w3.org/ns/dcat#',
  dcterms: 'http://purl.org/dc/terms/',
  adms: ADMS,
  spdx: 'http://spdx.org/rdf/terms#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  mi: `${VOCABULARY}#`,
};

export const POC_DESCRIPTION = {
  en: 'PROOF OF CONCEPT. Nothing listed here is a content specification of the European Union, adopted under Regulation (EU) 2024/1781, or otherwise normative.',
  de: 'PROOF OF CONCEPT. Nichts hier Aufgeführte ist eine Inhaltsspezifikation der Europäischen Union, nach Verordnung (EU) 2024/1781 erlassen oder anderweitig normativ.',
};

const langLiterals = (map: Record<string, string>): Array<{ '@value': string; '@language': string }> =>
  Object.entries(map)
    .filter(([code]) => code !== '')
    .sort(([a], [b]) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b, 'en')))
    .map(([code, value]) => ({ '@value': value, '@language': code }));

const POC = { 'adms:status': { '@id': 'mi:ProofOfConcept' }, 'dcterms:license': { '@id': CC0 } };

export interface CatalogRelease {
  tag: string;
  /** YYYY-MM-DD */
  date: string;
}

/**
 * The record's node for `iri`, wherever it sits (the record root itself, or one `dcat:dataset` of
 * a catalogue-shaped record as in design §7.3). The first node with that `@id` and more than an id.
 */
export function findDatasetNode(record: unknown, iri: string): Record<string, unknown> | undefined {
  if (Array.isArray(record)) {
    for (const item of record) {
      const hit = findDatasetNode(item, iri);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!record || typeof record !== 'object') return undefined;
  const node = record as Record<string, unknown>;
  if (node['@id'] === iri && Object.keys(node).some((k) => k !== '@id' && k !== '@context')) return node;
  for (const [k, v] of Object.entries(node)) {
    if (k === '@context') continue;
    const hit = findDatasetNode(v, iri);
    if (hit) return hit;
  }
  return undefined;
}

/** A spec's dataset node from its DCAT record, carrying the record's context so it reads the same. */
export function embeddedDataset(spec: HostedSpec): Record<string, unknown> | undefined {
  const node = findDatasetNode(spec.dcatJson, spec.iri);
  if (!node) return undefined;
  const outer = spec.dcatJson['@context'];
  const inner = node === spec.dcatJson ? undefined : node['@context'];
  const context = inner === undefined ? outer : [outer, inner].flat();
  const { '@context': _ignored, ...rest } = node;
  return context === undefined ? rest : { '@context': context, ...rest };
}

/** Group specs by act, acts sorted, versions in the order loadSpecs gives them (numeric). */
export function byAct(specs: HostedSpec[]): Map<string, HostedSpec[]> {
  const acts = new Map<string, HostedSpec[]>();
  for (const spec of [...specs].sort((a, b) => a.act.localeCompare(b.act, 'en'))) {
    acts.set(spec.act, [...(acts.get(spec.act) ?? []), spec]);
  }
  return acts;
}

/** A hosted spec with its summary, read once per build (code review of #136: summarize runs SPARQL). */
export interface SummarizedSpec {
  spec: HostedSpec;
  summary: SpecSummary;
}

/** /spec/<act>: every hosted version of one act, as a DCAT dataset series. */
export function buildSeries(act: string, versions: SummarizedSpec[]): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@id': seriesIri(act),
    '@type': 'dcat:DatasetSeries',
    'dcterms:title': { '@value': `${act} — DPP content specifications (PoC)`, '@language': 'en' },
    'dcterms:description': langLiterals(POC_DESCRIPTION),
    ...POC,
    'mi:act': act,
    'dcat:seriesMember': versions.map(({ spec, summary: s }) => {
      const member: Record<string, unknown> = { '@id': spec.iri, 'dcat:version': spec.version };
      if (s.issued !== undefined) member['dcterms:issued'] = { '@value': s.issued, '@type': 'xsd:date' };
      const title = langLiterals(s.title);
      if (title.length > 0) member['dcterms:title'] = title;
      return member;
    }),
    // DCAT 3 versioning: the inverse of each spec's own dcat:isVersionOf.
    'dcat:hasVersion': versions.map(({ spec }) => ({ '@id': spec.iri })),
  };
}

const byTag = <T extends CatalogRelease>(releases: T[]): T[] => [...releases].sort((a, b) => a.tag.localeCompare(b.tag, 'en'));

/**
 * What /catalog and /release say about one release: the same node in both, so the dataset IRIs
 * agree with what /release/<tag> serves. The tarball is a link only — its digest is not known to an
 * offline build, so none is stated.
 */
function releaseDataset(r: CatalogRelease): Record<string, unknown> {
  return {
    '@id': releaseIri(r.tag),
    '@type': 'dcat:Dataset',
    'dcterms:title': { '@value': `material-identity dictionary, release ${r.tag}`, '@language': 'en' },
    'dcat:version': r.tag,
    'dcterms:issued': { '@value': r.date, '@type': 'xsd:date' },
    ...POC,
    'dcat:landingPage': { '@id': releaseLandingPage(r.tag) },
    'dcat:distribution': {
      '@id': `${releaseIri(r.tag)}#tarball`,
      '@type': 'dcat:Distribution',
      'dcat:downloadURL': { '@id': releaseAsset(r.tag) },
      'dcat:mediaType': 'application/gzip',
    },
  };
}

/** One entry of a release: its IRI, the SHA-256 of its served bytes, and the release that first shipped it. */
export interface ReleaseEntry {
  iri: string;
  sha256: string;
  firstShipped: string;
}

/** A release with every entry it contains (cumulative), sorted by IRI. */
export interface ReleaseContents extends CatalogRelease {
  entries: ReleaseEntry[];
}

/**
 * Every release's contents, from the tags and getReleases() (published path → first release). An
 * entry is in a release when shippedBy says so — the rule the pinned-release check applies — and
 * carries entrySha256, the digest a spec pins. Entries not yet released appear in no release.
 */
export function releaseContents(tags: Release[], firstRelease: Map<string, Release>, repo: RepoModel): ReleaseContents[] {
  const entries = repo.published.filter((f) => f.doc !== undefined && firstRelease.has(f.relPath))
    .map((f) => ({ iri: `${DEF_PREFIX}${f.stem}`, sha256: entrySha256(f.doc!), first: firstRelease.get(f.relPath)! }))
    .sort((a, b) => a.iri.localeCompare(b.iri, 'en'));
  return byTag(tags).map(({ tag, date }) => ({
    tag,
    date,
    entries: entries.filter((e) => shippedBy(e.first, tag)).map(({ iri, sha256, first }) => ({ iri, sha256, firstShipped: first.tag })),
  }));
}

/**
 * /release/<tag>: one dictionary release as a dcat:Dataset. `dcterms:hasPart` lists every entry
 * the release contains, each with its JSON distribution and the SHA-256 a spec pins (the same
 * shape as a spec's pin); `mi:firstShipped` names the ones this release is the first to contain.
 * A release is fixed once tagged, so the document is too.
 */
export function buildRelease(r: ReleaseContents): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    ...releaseDataset(r),
    'dcterms:description': langLiterals(POC_DESCRIPTION),
    'dcterms:publisher': { '@id': `${CANONICAL_BASE}/` },
    'dcat:inCatalog': { '@id': RELEASES_IRI },
    'mi:firstShipped': r.entries.filter((e) => e.firstShipped === r.tag).map((e) => ({ '@id': e.iri })),
    'dcterms:hasPart': r.entries.map((e) => ({
      '@id': e.iri,
      'dcat:distribution': {
        '@type': 'dcat:Distribution',
        'dcat:downloadURL': { '@id': e.iri },
        'dcat:mediaType': 'application/json',
        'spdx:checksum': { 'spdx:algorithm': { '@id': 'spdx:checksumAlgorithm_sha256' }, 'spdx:checksumValue': e.sha256 },
      },
    })),
  };
}

/** /release: every dictionary release, as a catalogue of release datasets. */
export function buildReleaseIndex(releases: CatalogRelease[]): Record<string, unknown> {
  return {
    '@context': CONTEXT,
    '@id': RELEASES_IRI,
    '@type': 'dcat:Catalog',
    'dcterms:title': { '@value': 'material-identity dictionary releases', '@language': 'en' },
    'dcterms:description': langLiterals(POC_DESCRIPTION),
    ...POC,
    'dcterms:publisher': { '@id': `${CANONICAL_BASE}/` },
    'dcat:dataset': byTag(releases).map(releaseDataset),
  };
}

/** /catalog: the dictionary releases, the spec series, and every hosted spec's own DCAT record. */
export function buildCatalog(releases: CatalogRelease[], specs: HostedSpec[]): Record<string, unknown> {
  const releaseDatasets = byTag(releases).map(releaseDataset);
  const acts = byAct(specs);
  const series = [...acts.keys()].map((act) => ({
    '@id': seriesIri(act),
    '@type': 'dcat:DatasetSeries',
    'dcterms:title': { '@value': `${act} — DPP content specifications (PoC)`, '@language': 'en' },
    ...POC,
  }));
  const specDatasets = [...acts.values()].flat().map((spec) => embeddedDataset(spec) ?? { '@id': spec.iri });
  return {
    '@context': CONTEXT,
    '@id': CATALOG_IRI,
    '@type': 'dcat:Catalog',
    'dcterms:title': [
      { '@value': 'material-identity — dictionary releases and DPP content specifications (PoC)', '@language': 'en' },
      { '@value': 'material-identity — Wörterbuch-Releases und DPP-Inhaltsspezifikationen (PoC)', '@language': 'de' },
    ],
    'dcterms:description': langLiterals(POC_DESCRIPTION),
    ...POC,
    'dcterms:publisher': { '@id': `${CANONICAL_BASE}/` },
    'dcat:dataset': [...releaseDatasets, ...series, ...specDatasets],
  };
}

export const jsonLd = (doc: Record<string, unknown>): string => `${JSON.stringify(doc, null, 2)}\n`;
