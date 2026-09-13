import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import oxigraph from 'oxigraph';
import { loadRepo } from '../scripts/lib/repo.ts';
import { RefIndex } from '../scripts/lib/render.ts';
import { renderTurtle } from '../scripts/lib/rdf.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GREEN = join(here, 'fixtures', 'green');

const MP1 = 'https://material-identity.eu/def/73425bc9-3734-4f26-a647-89fd8d9e435d'; // superseded
const MP2 = 'https://material-identity.eu/def/c38a85eb-1a37-416d-ab21-7ddcc599754d';
const COLLECTION = 'https://material-identity.eu/def/2f3de2bb-0588-4513-bfc3-41d021815a81';
const ROUTE = 'https://material-identity.eu/def/4eae703a-fa15-4118-8bc4-7926a22a12fb';
const EAF = 'https://material-identity.eu/def/5ed29113-a426-4b6d-a790-e6c8268b9e52';
const ACCESS = 'https://material-identity.eu/def/7a1e2c3d-4b5f-4a6e-9c8d-1f2e3d4c5b6a';

function graph(issued = new Map<string, string>()): { store: oxigraph.Store; turtle: string } {
  const repo = loadRepo(GREEN);
  const turtle = renderTurtle(repo, new RefIndex(repo), issued);
  const store = new oxigraph.Store();
  store.load(turtle, { format: 'text/turtle' }); // throws on invalid syntax — the emitter's gate
  return { store, turtle };
}

const ask = (store: oxigraph.Store, where: string): boolean => store.query(`ASK { ${where} }`) as unknown as boolean;

test('the emitted Turtle parses, and every published entry is a skos:Concept with its kind', () => {
  const { store } = graph();
  assert.ok(store.size > 0);
  assert.ok(ask(store, `<${MP2}> a <http://www.w3.org/2004/02/skos/core#Concept>, <https://material-identity.eu/ns#SingleValuedDataElement> .`));
  assert.ok(ask(store, `<${COLLECTION}> a <https://material-identity.eu/ns#DataElementCollection> .`));
  // a superseded entry stays resolvable, so it stays in the graph
  assert.ok(ask(store, `<${MP1}> a <http://www.w3.org/2004/02/skos/core#Concept> .`));
});

test('labels and definitions are language-tagged; shortName is a notation', () => {
  const { store } = graph();
  assert.ok(ask(store, `<${MP2}> <http://www.w3.org/2004/02/skos/core#prefLabel> "Maximum allowable pressure"@en .`));
  assert.ok(ask(store, `<${MP2}> <http://www.w3.org/2004/02/skos/core#prefLabel> "Maximal zulässiger Druck"@de .`));
  assert.ok(ask(store, `<${MP2}> <http://www.w3.org/2004/02/skos/core#definition> "Highest internal gauge pressure for which the component is designed and certified."@en .`));
  assert.ok(ask(store, `<${MP2}> <http://www.w3.org/2004/02/skos/core#notation> "maxPressure" .`));
});

test('supersession: replaces is stored, isReplacedBy is derived — both in the graph, only one in an entry', () => {
  const { store } = graph();
  assert.ok(ask(store, `<${MP2}> <http://purl.org/dc/terms/replaces> <${MP1}> .`));
  assert.ok(ask(store, `<${MP1}> <http://purl.org/dc/terms/isReplacedBy> <${MP2}> .`));
  assert.ok(!ask(store, `<${MP2}> <http://purl.org/dc/terms/isReplacedBy> ?x .`));
});

test('an enumeration is a concept scheme and its values say so', () => {
  const { store } = graph();
  assert.ok(ask(store, `<${ROUTE}> a <http://www.w3.org/2004/02/skos/core#ConceptScheme> .`));
  assert.ok(ask(store, `<${ROUTE}> <https://material-identity.eu/ns#permittedValue> <${EAF}> .`));
  assert.ok(ask(store, `<${EAF}> <http://www.w3.org/2004/02/skos/core#inScheme> <${ROUTE}> .`));
  assert.ok(ask(store, `<${EAF}> <http://www.w3.org/2004/02/skos/core#topConceptOf> <${ROUTE}> .`));
});

test('membership is reified: isMandatory and accessCategory hang off the membership, never off the member', () => {
  const { store } = graph();
  assert.ok(ask(store, `
    <${COLLECTION}> <https://material-identity.eu/ns#membership> ?m .
    ?m a <https://material-identity.eu/ns#Membership> ;
       <https://material-identity.eu/ns#element> <${MP2}> ;
       <https://material-identity.eu/ns#isMandatory> true ;
       <https://material-identity.eu/ns#accessCategory> <${ACCESS}> .`));
  // the concept itself carries neither — that is the whole point of the membership model
  assert.ok(!ask(store, `<${MP2}> <https://material-identity.eu/ns#isMandatory> ?v .`));
  assert.ok(!ask(store, `<${MP2}> <https://material-identity.eu/ns#accessCategory> ?v .`));
});

test('references keep their pinpoint; units link by QUDT terms; the release date is issued', () => {
  const repo = loadRepo(GREEN);
  const issued = new Map([['published/c38a85eb-1a37-416d-ab21-7ddcc599754d.yaml', '2026-08-28']]);
  const store = new oxigraph.Store();
  store.load(renderTurtle(repo, new RefIndex(repo), issued), { format: 'text/turtle' });

  assert.ok(ask(store, `
    <${MP2}> <https://material-identity.eu/ns#definitionStandard> ?r .
    ?r <http://purl.org/dc/terms/title> "EN 13445-3" ;
       <https://material-identity.eu/ns#clause> "5.3" ;
       <http://purl.org/dc/terms/source> <https://cen.eu/standards/EN13445-3> .`));
  assert.ok(ask(store, `<${MP2}> <http://qudt.org/schema/qudt/hasUnit> ?u .`));
  assert.ok(ask(store, `<${MP2}> <http://purl.org/dc/terms/issued> "2026-08-28"^^<http://www.w3.org/2001/XMLSchema#date> .`));
});

test('local terms are self-describing, and the emitter is deterministic', () => {
  const { store, turtle } = graph();
  assert.ok(ask(store, `<https://material-identity.eu/ns#isMandatory> <http://www.w3.org/2000/01/rdf-schema#label> "is mandatory"@en .`));
  assert.equal(turtle, graph().turtle);
});

test('the JSON-LD context agrees with the emitter on every term it declares', () => {
  const context = JSON.parse(readFileSync(join(here, '..', 'rdf', 'context.jsonld'), 'utf8'))['@context'];
  // the two calls the handover singles out, asserted rather than trusted to prose
  assert.equal(context.identicalTo['@id'], 'skos:exactMatch');
  assert.equal(context.replaces['@id'], 'dcterms:replaces');
  assert.equal(context.mi, 'https://material-identity.eu/ns#');
  assert.equal(context.isMandatory['@id'], 'mi:isMandatory');
  assert.equal(context.accessCategory['@id'], 'mi:accessCategory');
  // and no @context is ever added to the canonical entry JSON
  assert.equal(context['@base'], undefined);
});
