import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The dictionary-request form is the only way a requester states what they want, and triage
// generates the draft YAML from it. When the schema grows a kind-specific requirement and the
// form does not, the form silently stops being able to express a valid request for that kind —
// which is exactly what happened to itemType, symbol, ucumCode, dimension and value (#114).
// So this asserts the two stay in step rather than trusting anyone to remember.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORM_PATH = '.github/ISSUE_TEMPLATE/dictionary-request.yml';

interface FormField {
  type: string;
  id?: string;
  attributes?: { label?: string; options?: string[] };
}

const schema = JSON.parse(readFileSync(join(root, 'schema', 'dictionary-entry.schema.json'), 'utf8')) as {
  properties: Record<string, SchemaNode>;
  $defs?: Record<string, SchemaNode>;
  allOf?: { if?: { properties?: { objectType?: { const?: string } } }; then?: ThenClause }[];
};

interface SchemaNode {
  $ref?: string;
  properties?: Record<string, SchemaNode>;
}

/** Follow a local `#/$defs/<name>` reference one level — enough for this schema's shape. */
function resolve(node: SchemaNode | undefined): SchemaNode | undefined {
  const name = node?.$ref?.replace('#/$defs/', '');
  return name ? schema.$defs?.[name] : node;
}
const form = parse(readFileSync(join(root, FORM_PATH), 'utf8')) as { body: FormField[] };

interface ThenClause {
  required?: string[];
  properties?: Record<string, { required?: string[] }>;
}

/** Every property a `then` clause demands, nested ones as "parent.child" (crossReferences.ucumCode). */
function requiredBy(then: ThenClause): string[] {
  const direct = then.required ?? [];
  const nested = Object.entries(then.properties ?? {}).flatMap(([parent, sub]) =>
    (sub.required ?? []).map((child) => `${parent}.${child}`),
  );
  // a `required: [crossReferences]` alongside the nested rule adds nothing a requester can act on
  return [...direct.filter((p) => !nested.some((n) => n.startsWith(`${p}.`))), ...nested];
}

/** Schema property name → the form input id that captures it. */
function formId(property: string): string {
  const leaf = property.includes('.') ? property.slice(property.indexOf('.') + 1) : property;
  return leaf.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Where the form's own wording diverges from the envelope's field name. */
const RENAMED: Record<string, string> = { elements: 'collection-members' };

test('every objectType the form offers is one the form can complete (#114)', () => {
  const ids = new Set(form.body.filter((f) => f.id).map((f) => f.id as string));
  const offered = new Set(
    form.body.find((f) => f.id === 'object-type')?.attributes?.options ?? [],
  );
  assert.ok(offered.size > 0, 'the objectType dropdown should list its kinds');

  const missing: string[] = [];
  for (const rule of schema.allOf ?? []) {
    const kind = rule.if?.properties?.objectType?.const;
    if (!kind || !rule.then) continue;
    assert.ok(offered.has(kind), `schema constrains ${kind}, which the form does not offer`);
    for (const property of requiredBy(rule.then)) {
      const id = RENAMED[property] ?? formId(property);
      if (!ids.has(id)) missing.push(`${kind} requires ${property} — no form input "${id}"`);
    }
  }
  assert.deepEqual(missing, [], `${FORM_PATH} cannot capture:\n  ${missing.join('\n  ')}`);
});

test('the form only asks for fields the envelope actually has (#114)', () => {
  // The reverse drift: an input whose id matches no schema property produces a value with
  // nowhere to go, and triage has to guess whether it was renamed or dropped.
  const properties = new Set(Object.keys(schema.properties).map(formId));
  for (const nested of Object.keys(resolve(schema.properties.crossReferences)?.properties ?? {})) {
    properties.add(formId(nested));
  }
  assert.ok(properties.has('ucum-code'), 'the $ref into $defs should have resolved');
  // Inputs that are deliberately about the request, not the entry.
  const NOT_ENVELOPE = new Set([
    'short-name', 'object-type', 'justification', 'preferred-name-en', 'preferred-name-de',
    'definition-en', 'definition-de', 'value-data-type', 'collection-members', 'identical-to',
  ]);

  const orphans = form.body
    .filter((f) => f.id && !NOT_ENVELOPE.has(f.id) && !properties.has(f.id))
    .map((f) => `${f.id} (${f.attributes?.label ?? 'no label'})`);
  assert.deepEqual(orphans, [], `form inputs with no matching envelope field: ${orphans.join(', ')}`);
});
