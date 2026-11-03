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
import { CANONICAL_BASE } from './repo.ts';
import { ADMS, CC0, VOCABULARY } from './rdf.ts';
import type { HostedSpec, SpecSummary } from './spec.ts';

export const CATALOG_IRI = `${CANONICAL_BASE}/catalog`;
export const releaseIri = (tag: string): string => `${CANONICAL_BASE}/release/${tag}`;
export const seriesIri = (act: string): string => `${CANONICAL_BASE}/spec/${act}`;
const releaseLandingPage = (tag: string): string => `https://github.com/material-identity/dictionary/releases/tag/${tag}`;

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

/** /catalog: the dictionary releases, the spec series, and every hosted spec's own DCAT record. */
export function buildCatalog(releases: CatalogRelease[], specs: HostedSpec[]): Record<string, unknown> {
  const releaseDatasets = [...releases].sort((a, b) => a.tag.localeCompare(b.tag, 'en')).map((r) => ({
    '@id': releaseIri(r.tag),
    '@type': 'dcat:Dataset',
    'dcterms:title': { '@value': `material-identity dictionary, release ${r.tag}`, '@language': 'en' },
    'dcat:version': r.tag,
    'dcterms:issued': { '@value': r.date, '@type': 'xsd:date' },
    ...POC,
    'dcat:landingPage': { '@id': releaseLandingPage(r.tag) },
  }));
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
