/**
 * Turtle serialization of the whole dictionary (issue #98; handover §12 step 2, refreshed
 * post-#57). A second serialization of facts that already exist — the canonical
 * /def/<uuid>.json is never touched and carries no @context. Semantics are declared once in
 * rdf/context.jsonld; this emitter must agree with it.
 *
 * Superseded entries stay in the graph: they stay resolvable forever, so a consumer resolving
 * an old id must find it here too. The forward `dcterms:isReplacedBy` is emitted although no
 * entry stores it — the graph is derived, exactly like /superseded.json and the index.
 *
 * Deterministic by construction: entries in uuid order, predicates in a fixed order, language
 * tags with `en` first — two builds are byte-identical.
 */
import { DEF_PREFIX, type RepoModel } from './repo.ts';
import { lang, type Doc, type RefIndex } from './render.ts';

const NS = 'https://material-identity.eu/ns#';
/** The vocabulary document, served at /ns (#135); its terms are `<VOCABULARY>#<term>`. */
export const VOCABULARY = 'https://material-identity.eu/ns';
export const CC0 = 'http://creativecommons.org/publicdomain/zero/1.0/';
export const ADMS = 'http://www.w3.org/ns/adms#';

const PREFIXES: Array<[string, string]> = [
  ['mi', NS],
  ['skos', 'http://www.w3.org/2004/02/skos/core#'],
  ['dcterms', 'http://purl.org/dc/terms/'],
  ['qudt', 'http://qudt.org/schema/qudt/'],
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
  ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
];

/** The local terms, described in the graph itself so the file needs no companion document. */
export type TermKind = 'Class' | 'Property' | 'Individual';
const LOCAL_TERMS: Array<[term: string, kind: TermKind, label: string, comment: string]> = [
  ['SingleValuedDataElement', 'Class', 'Single-valued data element', 'Entry kind: one value of the given data type.'],
  ['MultiLanguageDataElement', 'Class', 'Multi-language data element', 'Entry kind: one value per language.'],
  ['MultiValuedDataElement', 'Class', 'Multi-valued data element', 'Entry kind: a list whose items all have the item type.'],
  ['RelatedResource', 'Class', 'Related resource', 'Entry kind: a reference to a document or resource.'],
  ['DataElementCollection', 'Class', 'Data element collection', 'Entry kind: a collection of member elements.'],
  ['MeasurementUnit', 'Class', 'Measurement unit', 'Entry kind: a unit of measurement.'],
  ['Quantity', 'Class', 'Quantity kind', 'Entry kind: a kind of quantity, e.g. pressure.'],
  ['Value', 'Class', 'Value', 'Entry kind: one permitted value of a code list.'],
  ['Membership', 'Class', 'Collection membership', 'Membership of an element in a collection; carries what is true of the membership, not of the concept.'],
  ['symbol', 'Property', 'symbol', 'Symbol for the concept, per language.'],
  ['valueDataType', 'Property', 'value data type', 'Data type of the element value.'],
  ['value', 'Property', 'value', 'The value this entry denotes.'],
  ['exampleValue', 'Property', 'example value', 'A realistic example value, informative only.'],
  ['dimension', 'Property', 'dimension', 'Dimension vector of a quantity kind.'],
  ['coherentSiUnit', 'Property', 'coherent SI unit', 'The coherent SI unit for this quantity kind.'],
  ['itemType', 'Property', 'item type', 'The entry every item of a multi-valued element conforms to.'],
  ['permittedValue', 'Property', 'permitted value', 'A value this element may take.'],
  ['membership', 'Property', 'membership', 'Links a collection to one membership node.'],
  ['element', 'Property', 'element', 'The entry that is a member.'],
  ['isMandatory', 'Property', 'is mandatory', 'Whether a conforming passport must carry this member. A property of the membership, never of the concept.'],
  ['accessCategory', 'Property', 'access category', 'Disclosure tier a content specification assigns to this membership. Informative: the applicable legal act is normative and the passport interface enforces it.'],
  ['definitionStandard', 'Property', 'definition standard', 'The technical standard that defines the concept.'],
  ['testStandard', 'Property', 'test standard', 'The standard defining how the value is determined.'],
  ['legalBasis', 'Property', 'legal basis', 'The law or regulation that defines or mandates the concept.'],
  ['clause', 'Property', 'clause', 'Pinpoint within the cited document.'],
  ['conversion', 'Property', 'conversion', 'Links a unit to one conversion node.'],
  ['toUnit', 'Property', 'to unit', 'Target unit of a conversion.'],
  ['factor', 'Property', 'factor', 'Multiplicative factor of a conversion.'],
  ['offset', 'Property', 'offset', 'Additive offset of a conversion.'],
  // Content-specification terms (#135; schema design content-spec-jsonld.md §3.3). A spec is a
  // SHACL shapes graph; these say what SHACL, DCAT and DCTerms cannot.
  ['ContentSpecification', 'Class', 'DPP content specification', 'The set of data elements a passport for one product group carries, published as one SHACL shapes graph. EN 18223 defines no such class.'],
  ['elementId', 'Property', 'element id', 'The EN 18223 element key of a membership: the JSON key in a passport and the Annex A elementId. A key, not a display label.'],
  ['granularity', 'Property', 'granularity', 'The level a value is given at: mi:model, mi:batch or mi:item (EN 18219), or mi:operator for economic-operator data. Used on memberships and on the passport header.'],
  ['model', 'Individual', 'model', 'Granularity: one value for every item of a product model.'],
  ['batch', 'Individual', 'batch', 'Granularity: one value per batch or heat.'],
  ['item', 'Individual', 'item', 'Granularity: one value per individual item.'],
  ['operator', 'Individual', 'operator', 'Granularity: data about the economic operator, not the product. Never taken by a passport header.'],
  ['condition', 'Property', 'condition', 'The condition under which an optional membership becomes mandatory, per language. Stated, not evaluated: SHACL has no way to express it.'],
  ['ProofOfConcept', 'Individual', 'proof of concept', 'Value of adms:status: a demonstration resource, never normative. A content specification with this status is not one of the European Union.'],
  ['act', 'Property', 'act', 'The delegated-act key of a content specification, as used in its IRI and file names.'],
  ['dppSchemaVersion', 'Property', 'DPP schema version', 'The EN 18223 Table 1 field naming the metamodel envelope a passport or content specification is derived against.'],
  ['passportContext', 'Property', 'passport context', 'Links a content specification to the JSON-LD context its passports are read with.'],
  ['uniqueProductIdentifier', 'Property', 'unique product identifier', 'Passport header: the unique product identifier (EN 18223 Table 1).'],
  ['dppStatus', 'Property', 'DPP status', 'Passport header: the status of the passport (EN 18223 Table 1).'],
  ['economicOperatorId', 'Property', 'economic operator id', 'Passport header: the identifier of the responsible economic operator (EN 18223 Table 1).'],
  ['facilityId', 'Property', 'facility id', 'Passport header: the identifier of the facility (EN 18223 Table 1).'],
];

function literal(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

/** Language tags sort `en` first, then alphabetically — the same order the HTML uses. */
function langLiterals(v: unknown): string[] {
  return Object.entries(lang(v))
    .sort(([a], [b]) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b, 'en')))
    .map(([code, text]) => `${literal(text)}@${code}`);
}

function iri(uri: unknown): string {
  return `<${String(uri)}>`;
}

/** "xsd:float" and "rdf:langString" are already prefixed names; anything else becomes a literal. */
function datatypeTerm(value: string): string {
  return /^(xsd|rdf):[A-Za-z]+$/.test(value) ? value : literal(value);
}

function scalar(value: unknown): string {
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : `"${value}"^^xsd:decimal`;
  return literal(String(value));
}

/** `predicate object` pairs for one subject, emitted as an indented, semicolon-separated block. */
function block(pairs: Array<[string, string]>, indent = '  '): string {
  return pairs.map(([p, o]) => `${indent}${p} ${o}`).join(' ;\n');
}

function referenceNode(ref: unknown): string {
  const r = (ref ?? {}) as Doc;
  const pairs: Array<[string, string]> = [];
  if (r.name !== undefined) pairs.push(['dcterms:title', literal(String(r.name))]);
  if (r.clause !== undefined) pairs.push(['mi:clause', literal(String(r.clause))]);
  if (r.uri !== undefined) pairs.push(['dcterms:source', iri(r.uri)]);
  return `[\n${block(pairs, '      ')}\n    ]`;
}

function entryTriples(uuid: string, doc: Doc, refs: RefIndex, issued: string | undefined): string {
  const pairs: Array<[string, string]> = [];
  const push = (p: string, o: string): void => { pairs.push([p, o]); };

  const types = ['skos:Concept', `mi:${String(doc.objectType)}`];
  // An entry with an enumeration IS the code list its values belong to.
  if (Array.isArray(doc.enumeration)) types.push('skos:ConceptScheme');
  push('a', types.join(', '));

  for (const l of langLiterals(doc.preferredName)) push('skos:prefLabel', l);
  for (const l of langLiterals(doc.definition)) push('skos:definition', l);
  for (const l of langLiterals(doc.symbol)) push('mi:symbol', l);
  if (doc.shortName !== undefined) push('skos:notation', literal(String(doc.shortName)));
  push('rdfs:isDefinedBy', iri(doc.isDefinedBy));
  if (issued !== undefined) push('dcterms:issued', `"${issued}"^^xsd:date`);

  if (doc.replaces !== undefined) push('dcterms:replaces', iri(doc.replaces));
  const successor = refs.supersededByEntry(doc);
  if (successor !== undefined) push('dcterms:isReplacedBy', iri(successor.id));

  for (const field of ['identicalTo', 'inheritsFrom'] as const) {
    const v = doc[field];
    if (!Array.isArray(v)) continue;
    for (const target of v) push(field === 'identicalTo' ? 'skos:exactMatch' : 'skos:broader', iri(target));
  }

  if (doc.valueDataType !== undefined) push('mi:valueDataType', datatypeTerm(String(doc.valueDataType)));
  if (doc.value !== undefined) push('mi:value', scalar(doc.value));
  if (doc.exampleValue !== undefined) push('mi:exampleValue', scalar(doc.exampleValue));
  if (doc.unit !== undefined) push('qudt:hasUnit', iri(doc.unit));
  if (doc.quantityKind !== undefined) push('qudt:hasQuantityKind', iri(doc.quantityKind));
  if (doc.dimension !== undefined) push('mi:dimension', literal(String(doc.dimension)));
  if (doc.coherentSiUnit !== undefined) push('mi:coherentSiUnit', iri(doc.coherentSiUnit));
  if (doc.itemType !== undefined) push('mi:itemType', iri(doc.itemType));
  if (doc.resourceMediaType !== undefined) push('dcterms:format', literal(String(doc.resourceMediaType)));
  if (Array.isArray(doc.enumeration)) for (const v of doc.enumeration) push('mi:permittedValue', iri(v));

  // Membership is reified: isMandatory and accessCategory are true of the membership, not of
  // the member concept — the whole point of keeping them off the entry.
  if (Array.isArray(doc.elements)) {
    for (const el of doc.elements as Doc[]) {
      const inner: Array<[string, string]> = [['a', 'mi:Membership'], ['mi:element', iri(el.dictionaryReference)]];
      if (el.isMandatory !== undefined) inner.push(['mi:isMandatory', String(el.isMandatory === true)]);
      if (el.accessCategory !== undefined) inner.push(['mi:accessCategory', iri(el.accessCategory)]);
      push('mi:membership', `[\n${block(inner, '      ')}\n    ]`);
    }
  }

  for (const [field, predicate] of [['definitionStandard', 'mi:definitionStandard'], ['testStandard', 'mi:testStandard'], ['legalBasis', 'mi:legalBasis']] as const) {
    if (doc[field] !== undefined) push(predicate, referenceNode(doc[field]));
  }

  if (Array.isArray(doc.conversions)) {
    for (const c of doc.conversions as Doc[]) {
      const inner: Array<[string, string]> = [['mi:toUnit', iri(c.toUnit)], ['mi:factor', scalar(c.factor)]];
      if (c.offset !== undefined) inner.push(['mi:offset', scalar(c.offset)]);
      push('mi:conversion', `[\n${block(inner, '      ')}\n    ]`);
    }
  }

  const cross = (doc.crossReferences ?? {}) as Doc;
  if (cross.ucumCode !== undefined) push('qudt:ucumCode', literal(String(cross.ucumCode)));
  if (cross.uneceCommonCode !== undefined) push('qudt:uneceCommonCode', literal(String(cross.uneceCommonCode)));
  if (cross.qudtUnit !== undefined) push('skos:exactMatch', iri(cross.qudtUnit));

  // A value belongs to the code list that permits it — derived from the parent's enumeration.
  for (const { uuid: parent, edge } of refs.parents(uuid)) {
    if (edge.kind !== 'value') continue;
    push('skos:inScheme', iri(`${DEF_PREFIX}${parent}`));
    push('skos:topConceptOf', iri(`${DEF_PREFIX}${parent}`));
  }

  return `${iri(doc.id)}\n${block(pairs)} .`;
}

/** What `a` a local term is: individuals (granularity levels, a status value) are SKOS concepts. */
function termType(kind: TermKind): string {
  return kind === 'Class' ? 'rdfs:Class' : kind === 'Property' ? 'rdf:Property' : 'skos:Concept';
}

function termsTurtle(): string {
  return LOCAL_TERMS.map(([term, kind, label, comment]) =>
    `mi:${term}\n  a ${termType(kind)} ;\n  rdfs:label ${literal(label)}@en ;\n  rdfs:comment ${literal(comment)}@en ;\n  rdfs:isDefinedBy <${VOCABULARY}> .`).join('\n\n');
}

/** The whole dictionary as Turtle. `issued` maps a published path to its release date. */
export function renderTurtle(repo: RepoModel, refs: RefIndex, issued: Map<string, string> = new Map()): string {
  const header = PREFIXES.map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join('\n');

  const entries = repo.published
    .filter((f) => f.doc)
    .sort((a, b) => a.stem.localeCompare(b.stem, 'en'))
    .map((f) => entryTriples(f.stem, f.doc as Doc, refs, issued.get(f.relPath)))
    .join('\n\n');

  return `# The material-identity dictionary as RDF (issue #98).
#
# A derived serialization of published/ — the canonical representation of an entry stays
# <https://material-identity.eu/def/<uuid>> as JSON, which this file never alters. Superseded
# entries are included: they remain resolvable, so they remain in the graph, carrying both
# dcterms:replaces and the derived dcterms:isReplacedBy.
#
# Semantics are declared in <https://material-identity.eu/context.jsonld>.

${header}

# ---------------------------------------------------------------- local terms (self-describing)

${termsTurtle()}

# ---------------------------------------------------------------- entries

${entries}
`;
}

// ------------------------------------------------------------------ the mi: vocabulary at /ns (#135)

const VOCABULARY_TITLE = 'material-identity vocabulary (mi:) — proof of concept';
const VOCABULARY_DESCRIPTION = 'PROOF OF CONCEPT. The local terms of the material-identity dictionary and of its DPP content specifications. Not a vocabulary of the European Union or of CEN; nothing here is normative.';

/** The mi: terms as their own Turtle document, served at /ns for `Accept: text/turtle`. */
export function renderVocabularyTurtle(): string {
  const prefixes: Array<[string, string]> = [...PREFIXES, ['owl', 'http://www.w3.org/2002/07/owl#'], ['adms', ADMS]];
  return `# The mi: vocabulary (#135). Derived from the term list in scripts/lib/rdf.ts, like /dictionary.ttl.

${prefixes.map(([p, ns]) => `@prefix ${p}: <${ns}> .`).join('\n')}

<${VOCABULARY}>
  a owl:Ontology ;
  dcterms:title ${literal(VOCABULARY_TITLE)}@en ;
  dcterms:description ${literal(VOCABULARY_DESCRIPTION)}@en ;
  adms:status mi:ProofOfConcept ;
  dcterms:license <${CC0}> ;
  dcterms:publisher <https://material-identity.eu/> .

${termsTurtle()}
`;
}

/** The same vocabulary as JSON-LD (the default representation of /ns), inline context only. */
export function renderVocabularyJsonLd(): string {
  const graph: Array<Record<string, unknown>> = [
    {
      '@id': VOCABULARY,
      '@type': 'owl:Ontology',
      'dcterms:title': { '@value': VOCABULARY_TITLE, '@language': 'en' },
      'dcterms:description': { '@value': VOCABULARY_DESCRIPTION, '@language': 'en' },
      'adms:status': { '@id': 'mi:ProofOfConcept' },
      'dcterms:license': { '@id': CC0 },
      'dcterms:publisher': { '@id': 'https://material-identity.eu/' },
    },
    ...LOCAL_TERMS.map(([term, kind, label, comment]) => ({
      '@id': `mi:${term}`,
      '@type': termType(kind),
      'rdfs:label': { '@value': label, '@language': 'en' },
      'rdfs:comment': { '@value': comment, '@language': 'en' },
      'rdfs:isDefinedBy': { '@id': VOCABULARY },
    })),
  ];
  const context: Record<string, string> = Object.fromEntries([
    ...PREFIXES, ['owl', 'http://www.w3.org/2002/07/owl#'], ['adms', ADMS],
  ]);
  return `${JSON.stringify({ '@context': context, '@graph': graph }, null, 2)}\n`;
}

/** The term list for the HTML page — read-only view of the one source. */
export function vocabularyTerms(): ReadonlyArray<readonly [term: string, kind: TermKind, label: string, comment: string]> {
  return LOCAL_TERMS;
}
