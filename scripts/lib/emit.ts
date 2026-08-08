/**
 * Canonical JSON emitter (plan §4 M3 item 1): pretty-printed, key order fixed by this
 * module — entries are byte-stable across builds, which future hash manifests
 * (trust-ladder step 2) depend on. The build never invents or alters content.
 */

// Envelope keys in canonical order: identity/lifecycle block first, then semantics.
// Keys not listed (langMap languages, crossReferences extras) sort alphabetically after.
const KEY_ORDER = [
  'id', 'replaces', 'isDefinedBy',
  'objectType', 'shortName', 'symbol', 'preferredName', 'definition',
  'inheritsFrom', 'identicalTo',
  'valueDataType', 'unit', 'exampleValue', 'enumeration',
  'definitionStandard', 'testStandard', 'resourceMediaType', 'itemType', 'elements',
  'quantityKind', 'dimension', 'coherentSiUnit', 'crossReferences', 'conversions',
  'value',
  // nested record keys
  'name', 'clause', 'uri',
  'toUnit', 'factor', 'offset',
  'dictionaryReference', 'isMandatory',
];

const RANK = new Map(KEY_ORDER.map((k, i) => [k, i]));

function orderValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort((a, b) => {
      const ra = RANK.get(a) ?? Number.MAX_SAFE_INTEGER;
      const rb = RANK.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ra !== rb ? ra - rb : a.localeCompare(b, 'en');
    });
    const ordered: Record<string, unknown> = {};
    for (const k of keys) ordered[k] = orderValue(source[k]);
    return ordered;
  }
  return value;
}

/** Serialize a document canonically: fixed key order, 2-space indent, trailing newline. */
export function canonicalJson(doc: Record<string, unknown>): string {
  return `${JSON.stringify(orderValue(doc), null, 2)}\n`;
}
