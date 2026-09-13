/**
 * HTML rendering (plan §4 M3 item 1, redesigned per issue #57): template literals only, no
 * framework, no client-side JS. Internal references render as links with resolved labels.
 * "Superseded" is never stored — derived here by reverse-scanning `replaces` across
 * published/ and shown purely as presentation (a banner), never written back to any file.
 */
import { CANONICAL_BASE, DEF_PREFIX, type RepoFile, type RepoModel } from './repo.ts';

export function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface Doc {
  [k: string]: unknown;
}

export const lang = (v: unknown): Record<string, string> => (v && typeof v === 'object' ? (v as Record<string, string>) : {});
export const en = (v: unknown): string | undefined => lang(v).en;

/** Resolves labels and hrefs for internal references, and who (if anyone) supersedes an entry. */
export class RefIndex {
  private published = new Map<string, Doc>();
  private supersededBy = new Map<string, Doc>(); // target entry id -> the entry that replaces it

  constructor(repo: RepoModel) {
    for (const f of repo.published) if (f.doc) this.published.set(f.stem, f.doc);
    for (const doc of this.published.values()) {
      if (typeof doc.replaces === 'string') this.supersededBy.set(doc.replaces, doc);
    }
  }

  /** An <a> for any URI: internal def URIs get a resolved label and a site-relative href. */
  link(uri: unknown): string {
    const s = String(uri);
    if (s.startsWith(DEF_PREFIX)) {
      const uuid = s.slice(DEF_PREFIX.length);
      const target = this.published.get(uuid);
      const label = en(target?.preferredName) ?? (target?.shortName as string | undefined) ?? uuid;
      return `<a href="/def/${esc(uuid)}">${esc(label)}</a>`;
    }
    return `<a href="${esc(s)}" rel="external">${esc(s)}</a>`;
  }

  /** The entry that replaces this one, if any — derived, never stored. */
  supersededByEntry(entry: Doc): Doc | undefined {
    return this.supersededBy.get(String(entry.id));
  }

  isSuperseded(entry: Doc): boolean {
    return this.supersededBy.has(String(entry.id));
  }

  /**
   * old id -> immediate successor id, for every entry that has one. One hop, same as
   * `replaces` itself (at most one entry may replace a given entry, so this is a chain, never
   * a DAG) — a consumer chasing an old id to the current one follows the chain by repeated
   * lookup. Sorted by key so the emitted JSON is deterministic across builds.
   */
  supersededMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const oldId of [...this.supersededBy.keys()].sort()) {
      out[oldId] = String(this.supersededBy.get(oldId)!.id);
    }
    return out;
  }
}

/**
 * GitHub Pages is build-artifact/origin only and must never be advertised as a reference
 * (plan §2.2) — but this org's Pages custom domain (a different repo,
 * material-identity.github.io -> materialidentity.org) makes every project site, this one
 * included, reachable as a subpath of it. That's a structural property of GitHub Pages, not
 * a setting this repo controls, and the Worker fetches from this exact same origin — so
 * there is no way to serve different content or headers per hostname from here (no `noindex`
 * meta tag either: the origin file is identical whichever host requests it, and that would
 * just as wrongly de-index the real material-identity.eu pages). A `<link rel="canonical">`
 * is the one mechanism designed for exactly this: it names the one true URL regardless of
 * which host served the bytes, so any crawler or tool consolidates there instead of treating
 * the Pages/materialidentity.org copy as authoritative.
 */
function pageShell(title: string, canonicalPath: string, body: string, options: { alternateJson?: string; rssFeed?: boolean } = {}): string {
  const canonicalUrl = `${CANONICAL_BASE}${canonicalPath}`;
  const alternate = options.alternateJson === undefined
    ? ''
    : `\n<link rel="alternate" type="application/json" href="${esc(options.alternateJson)}">`;
  const rss = options.rssFeed
    ? `\n<link rel="alternate" type="application/rss+xml" title="material-identity dictionary" href="/feed.xml">`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="canonical" href="${esc(canonicalUrl)}">
<link rel="stylesheet" href="/styles.css">${alternate}${rss}
</head>
<body>
<main>
${body}
</main>
<footer><a href="/">Dictionary index</a> · <a href="https://material-identity.eu/">material-identity.eu</a></footer>
</body>
</html>
`;
}

function langMapHtml(v: unknown): string {
  const entries = Object.entries(lang(v)).sort(([a], [b]) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b, 'en')));
  return `<dl class="langmap">${entries.map(([k, s]) => `<dt>${esc(k)}</dt><dd>${esc(s)}</dd>`).join('')}</dl>`;
}

function standardRefHtml(v: unknown): string {
  const ref = (v ?? {}) as Doc;
  const clause = ref.clause !== undefined ? `, clause ${esc(ref.clause)}` : '';
  return `${esc(ref.name)}${clause} — <a href="${esc(ref.uri)}" rel="external">${esc(ref.uri)}</a>`;
}

function row(label: string, valueHtml: string): string {
  return `<tr><th scope="row">${esc(label)}</th><td>${valueHtml}</td></tr>`;
}

/** Banner for a superseded entry — sourced from the reverse `replaces` lookup, never the entry itself. */
export function statusBanner(entry: Doc, refs: RefIndex): string {
  const successor = refs.supersededByEntry(entry);
  if (!successor) return '';
  return `<div class="banner superseded">Superseded by ${refs.link(successor.id)}. This entry remains resolvable forever, byte-identical to its publication; do not use it for new passports.</div>`;
}

export function renderEntryPage(file: RepoFile, repo: RepoModel, refs: RefIndex): string {
  const doc = file.doc as Doc;
  const title = en(doc.preferredName) ?? String(doc.shortName ?? file.stem);
  const rows: string[] = [];

  rows.push(row('id', `<a href="/def/${esc(file.stem)}">${esc(doc.id)}</a>`));
  if (doc.replaces !== undefined) rows.push(row('replaces', refs.link(doc.replaces)));
  rows.push(row('isDefinedBy', `<a href="${esc(doc.isDefinedBy)}" rel="external">${esc(doc.isDefinedBy)}</a>`));
  rows.push(row('objectType', `<code>${esc(doc.objectType)}</code>`));
  if (doc.shortName !== undefined) rows.push(row('shortName', `<code>${esc(doc.shortName)}</code>`));
  if (doc.symbol !== undefined) rows.push(row('symbol', langMapHtml(doc.symbol)));
  if (doc.preferredName !== undefined) rows.push(row('preferredName', langMapHtml(doc.preferredName)));
  if (doc.definition !== undefined) rows.push(row('definition', langMapHtml(doc.definition)));
  for (const field of ['inheritsFrom', 'identicalTo'] as const) {
    const v = doc[field];
    if (Array.isArray(v)) rows.push(row(field, v.map((u) => `<a href="${esc(u)}" rel="external">${esc(u)}</a>`).join('<br>')));
  }
  if (doc.valueDataType !== undefined) rows.push(row('valueDataType', `<code>${esc(doc.valueDataType)}</code>`));
  if (doc.unit !== undefined) rows.push(row('unit', refs.link(doc.unit)));
  if (doc.exampleValue !== undefined) rows.push(row('exampleValue', `<code>${esc(JSON.stringify(doc.exampleValue))}</code>`));
  if (Array.isArray(doc.enumeration)) {
    rows.push(row('enumeration', `<ul>${doc.enumeration.map((u) => `<li>${refs.link(u)}</li>`).join('')}</ul>`));
  }
  if (doc.definitionStandard !== undefined) rows.push(row('definitionStandard', standardRefHtml(doc.definitionStandard)));
  if (doc.testStandard !== undefined) rows.push(row('testStandard', standardRefHtml(doc.testStandard)));
  if (doc.legalBasis !== undefined) rows.push(row('legalBasis', standardRefHtml(doc.legalBasis)));
  if (doc.resourceMediaType !== undefined) rows.push(row('resourceMediaType', `<code>${esc(doc.resourceMediaType)}</code>`));
  if (doc.itemType !== undefined) rows.push(row('itemType', refs.link(doc.itemType)));
  if (Array.isArray(doc.elements)) {
    const body = (doc.elements as Doc[]).map((el) =>
      `<tr><td>${refs.link(el.dictionaryReference)}</td><td>${el.isMandatory ? 'mandatory' : 'optional'}</td><td>${el.accessCategory !== undefined ? refs.link(el.accessCategory) : '—'}</td></tr>`).join('');
    rows.push(row('elements', `<table class="inner"><thead><tr><th>member</th><th>membership</th><th>access</th></tr></thead><tbody>${body}</tbody></table>`));
  }
  if (doc.quantityKind !== undefined) rows.push(row('quantityKind', refs.link(doc.quantityKind)));
  if (doc.dimension !== undefined) rows.push(row('dimension', `<code>${esc(doc.dimension)}</code>`));
  if (doc.coherentSiUnit !== undefined) rows.push(row('coherentSiUnit', refs.link(doc.coherentSiUnit)));
  if (doc.crossReferences !== undefined) {
    const body = Object.entries(doc.crossReferences as Doc).map(([k, v]) =>
      `<tr><td><code>${esc(k)}</code></td><td>${String(v).startsWith('http') ? `<a href="${esc(v)}" rel="external">${esc(v)}</a>` : esc(v)}</td></tr>`).join('');
    rows.push(row('crossReferences', `<table class="inner"><tbody>${body}</tbody></table>`));
  }
  if (Array.isArray(doc.conversions)) {
    const body = (doc.conversions as Doc[]).map((c) =>
      `<tr><td>${refs.link(c.toUnit)}</td><td>${esc(c.factor)}</td><td>${esc(c.offset ?? 0)}</td></tr>`).join('');
    rows.push(row('conversions', `<table class="inner"><thead><tr><th>toUnit</th><th>factor</th><th>offset</th></tr></thead><tbody>${body}</tbody></table>`));
  }
  if (doc.value !== undefined) rows.push(row('value', `<code>${esc(JSON.stringify(doc.value))}</code>`));

  const body = `${statusBanner(doc, refs)}
<h1>${esc(title)}</h1>
<p class="meta"><code>${esc(doc.shortName ?? '')}</code> · ${esc(doc.objectType)}</p>
<p class="links"><a href="/def/${esc(file.stem)}.json">Raw JSON</a></p>
<table class="fields"><tbody>${rows.join('\n')}</tbody></table>`;

  return pageShell(title, `/def/${file.stem}`, body, { alternateJson: `/def/${file.stem}.json` });
}

/** A containment edge: the only kind of edge the tree nests. Reference edges (unit, quantityKind, …) stay links. */
interface ContainmentEdge {
  uuid: string;
  kind: 'member' | 'item' | 'value';
  isMandatory?: boolean;
  accessCategory?: string;
}

function defUuidOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith(DEF_PREFIX) ? v.slice(DEF_PREFIX.length) : undefined;
}

function containmentEdges(doc: Doc): ContainmentEdge[] {
  const edges: ContainmentEdge[] = [];
  if (Array.isArray(doc.elements)) {
    for (const el of doc.elements as Doc[]) {
      const uuid = defUuidOf(el?.dictionaryReference);
      if (uuid) edges.push({ uuid, kind: 'member', isMandatory: el.isMandatory === true, accessCategory: typeof el.accessCategory === 'string' ? el.accessCategory : undefined });
    }
  }
  const item = defUuidOf(doc.itemType);
  if (item) edges.push({ uuid: item, kind: 'item' });
  if (Array.isArray(doc.enumeration)) {
    for (const v of doc.enumeration) {
      const uuid = defUuidOf(v);
      if (uuid) edges.push({ uuid, kind: 'value' });
    }
  }
  return edges;
}

/**
 * Fold/unfold tree of the current dictionary (plan §7 out-of-scope test: derived artifact,
 * nothing stored). Nests containment edges only — elements, itemType, enumeration — so a shared
 * unit never becomes a "child" of every property that uses it. The dictionary is a DAG: a node
 * contained twice renders its body once and a link afterwards; a per-path guard stops a cycle.
 * Native <details>/<summary>, no JS.
 */
export function renderTreePage(repo: RepoModel, refs: RefIndex): string {
  const all = new Map<string, Doc>();
  for (const f of repo.published) if (f.doc) all.set(f.stem, f.doc);
  const current = new Map([...all].filter(([, doc]) => !refs.isSuperseded(doc)));
  const contained = new Set<string>();
  for (const doc of current.values()) for (const e of containmentEdges(doc)) contained.add(e.uuid);

  const labelOf = (uuid: string, doc: Doc): string => en(doc.preferredName) ?? String(doc.shortName ?? uuid);
  const roots = [...current]
    .filter(([uuid]) => !contained.has(uuid))
    .sort(([ua, a], [ub, b]) => labelOf(ua, a).localeCompare(labelOf(ub, b), 'en') || ua.localeCompare(ub, 'en'));

  const badges = (edge: ContainmentEdge | undefined, doc: Doc | undefined): string => {
    const out: string[] = [];
    if (edge?.kind === 'member') out.push(edge.isMandatory ? 'mandatory' : 'optional');
    if (edge?.kind === 'item') out.push('item type');
    if (edge?.kind === 'value') out.push('value');
    if (edge?.accessCategory !== undefined) out.push(`access: ${refs.link(edge.accessCategory)}`);
    if (doc && refs.isSuperseded(doc)) out.push('superseded');
    return out.map((b) => `<span class="badge">${b}</span>`).join(' ');
  };

  const rendered = new Set<string>();
  const node = (uuid: string, edge: ContainmentEdge | undefined, path: Set<string>, depth: number): string => {
    const doc = all.get(uuid);
    if (!doc) return `<p class="ref">${badges(edge, undefined)} <code>${esc(uuid)}</code> — not published</p>`;
    if (path.has(uuid)) return `<p class="ref">${badges(edge, doc)} ${refs.link(doc.id)} — contains itself (cycle)</p>`;
    if (rendered.has(uuid)) return `<p class="ref">${badges(edge, doc)} ${refs.link(doc.id)} — shown above</p>`;
    rendered.add(uuid);

    const facts: string[] = [];
    if (doc.value !== undefined) facts.push(`value <code>${esc(JSON.stringify(doc.value))}</code>`);
    if (doc.valueDataType !== undefined) facts.push(`<code>${esc(doc.valueDataType)}</code>`);
    if (doc.unit !== undefined) facts.push(`unit ${refs.link(doc.unit)}`);
    facts.push(`<a href="/def/${esc(uuid)}">entry page</a>`);

    const nextPath = new Set(path).add(uuid);
    const children = containmentEdges(doc).map((e) => node(e.uuid, e, nextPath, depth + 1)).join('\n');
    const shortName = doc.shortName !== undefined ? ` <code>${esc(doc.shortName)}</code>` : '';
    return `<details${depth === 0 ? ' open' : ''}>
<summary>${esc(labelOf(uuid, doc))}${shortName} · <span class="type">${esc(doc.objectType)}</span> ${badges(edge, doc)}</summary>
<div class="node-body">${doc.definition !== undefined ? langMapHtml(doc.definition) : ''}<p class="facts">${facts.join(' · ')}</p>
${children}</div>
</details>`;
  };

  // Units and quantities are only ever referenced (unit, quantityKind, coherentSiUnit), never
  // contained, so they are always roots — listed apart so they don't interleave with content.
  const isReferenceKind = (doc: Doc): boolean => doc.objectType === 'MeasurementUnit' || doc.objectType === 'Quantity';
  const elementRoots = roots.filter(([, doc]) => !isReferenceKind(doc));
  const referenceRoots = roots.filter(([, doc]) => isReferenceKind(doc));
  const section = (heading: string, note: string, items: typeof roots): string =>
    items.length === 0 ? '' : `<h2>${heading}</h2>
<p class="meta">${note}</p>
<div class="tree">
${items.map(([uuid]) => node(uuid, undefined, new Set(), 0)).join('\n')}
</div>`;

  const body = `<h1>Dictionary tree</h1>
<p class="meta">${elementRoots.length} element ${elementRoots.length === 1 ? 'root' : 'roots'} · ${referenceRoots.length} units and quantities · nests containment only (<code>elements</code>, <code>itemType</code>, <code>enumeration</code>); references such as <code>unit</code> or <code>quantityKind</code> are links inside a node. Badges come from the parent's membership, so the same entry may carry different badges under different parents. Superseded entries are omitted, as in the index.</p>
${section('Elements and collections', 'Current entries nothing contains, with everything they contain nested below.', elementRoots)}
${section('Units and quantities', 'Referenced by the entries above via <code>unit</code>, <code>quantityKind</code> or <code>coherentSiUnit</code> — never contained, so always top-level.', referenceRoots)}`;
  return pageShell('Dictionary tree', '/tree', body);
}

function schemaTypeLabel(prop: unknown): string {
  if (prop === true || prop === undefined || prop === null) return 'any';
  const p = prop as Doc;
  if (typeof p.$ref === 'string') {
    const name = p.$ref.replace('#/$defs/', '');
    return `<a href="#def-${esc(name)}"><code>${esc(name)}</code></a>`;
  }
  if (p.type === 'array') return `array of ${schemaTypeLabel(p.items)}`;
  if (Array.isArray(p.type)) return p.type.map((t) => esc(t)).join(' | ');
  if (p.type === 'string' && typeof p.format === 'string') return `string (${esc(p.format)})`;
  return esc(p.type ?? 'any');
}

function schemaPropertyRows(properties: Doc, required: string[]): string {
  return Object.entries(properties).map(([name, prop]) => {
    const label = required.includes(name) ? `<code>${esc(name)}</code> — required` : `<code>${esc(name)}</code>`;
    const desc = (prop as Doc)?.description !== undefined ? esc((prop as Doc).description) : '';
    return `<tr><td>${label}</td><td>${schemaTypeLabel(prop)}</td><td>${desc}</td></tr>`;
  }).join('\n');
}

function schemaFieldTable(properties: Doc, required: string[]): string {
  return `<table class="fields"><thead><tr><th>field</th><th>type</th><th>description</th></tr></thead>
<tbody>${schemaPropertyRows(properties, required)}</tbody></table>`;
}

/** Most $defs list fixed `properties`; langMap instead constrains keys/values directly. */
function schemaDefBody(def: Doc): string {
  const properties = (def.properties ?? {}) as Doc;
  if (Object.keys(properties).length > 0) {
    const table = schemaFieldTable(properties, (def.required as string[] | undefined) ?? []);
    return def.additionalProperties === true ? `${table}\n<p><em>Other keys are also allowed.</em></p>` : table;
  }
  const propertyNames = def.propertyNames as Doc | undefined;
  const keyDesc = typeof propertyNames?.pattern === 'string' ? `keys matching <code>${esc(propertyNames.pattern)}</code>` : 'arbitrary keys';
  return `<p>An object with ${keyDesc}, each valued as ${schemaTypeLabel(def.additionalProperties)}.</p>`;
}

function schemaConditionalRequirements(allOf: unknown[]): string {
  const items = allOf.map((clause) => {
    const c = clause as Doc;
    const ifBlock = c.if as Doc | undefined;
    const thenBlock = c.then as Doc | undefined;
    const objectType = (ifBlock?.properties as Doc | undefined)?.objectType as Doc | undefined;
    const required = thenBlock?.required;
    if (typeof objectType?.const !== 'string' || !Array.isArray(required)) return '';
    return `<li>when <code>objectType</code> is <code>${esc(objectType.const)}</code>, also required: ${required.map((r: string) => `<code>${esc(r)}</code>`).join(', ')}</li>`;
  }).filter(Boolean);
  return items.length ? `<ul>${items.join('\n')}</ul>` : '<p>None.</p>';
}

/**
 * Human-readable rendering of schema/dictionary-entry.schema.json, generated at build time
 * from whatever the schema currently says — unlike an entry page, this is NOT immutable and
 * changes whenever the schema does.
 */
export function renderSchemaPage(schema: Doc): string {
  const properties = (schema.properties ?? {}) as Doc;
  const required = (schema.required as string[] | undefined) ?? [];
  const defs = (schema.$defs ?? {}) as Doc;

  const defsHtml = Object.entries(defs).map(([name, def]) => {
    return `<h3 id="def-${esc(name)}"><code>${esc(name)}</code></h3>
${schemaDefBody(def as Doc)}`;
  }).join('\n');

  const body = `<h1>${esc(schema.title ?? 'Schema reference')}</h1>
<p class="meta">${esc(schema.description ?? '')}</p>
<p class="links"><a href="/schema/dictionary-entry.schema.json">Raw JSON Schema</a></p>
<p>Generated from the schema as of this build — unlike a dictionary entry, this page is <strong>not</strong> immutable and reflects whatever the schema currently says.</p>
<h2>Envelope fields</h2>
${schemaFieldTable(properties, required)}
<h2>Conditional requirements</h2>
${schemaConditionalRequirements((schema.allOf as unknown[] | undefined) ?? [])}
<h2>Referenced object shapes</h2>
${defsHtml}`;

  return pageShell(String(schema.title ?? 'Schema reference'), '/schema', body);
}

export const INDEX_PAGE_SIZE = 25;

/**
 * Paginated index (plan §4 M4 item 1, redesigned per issue #57): 25 entries per page,
 * static pagination — index.html, page-2.html, …. Lists only current entries — anything
 * superseded (derived, never stored) is omitted; it stays reachable from its successor's
 * page and by its own fixed URI, just not listed here.
 */
export function renderIndexPages(repo: RepoModel, refs: RefIndex): Array<{ name: string; html: string }> {
  const entries = repo.published
    .filter((f) => f.doc && !refs.isSuperseded(f.doc))
    .map((f) => {
      const doc = f.doc as Doc;
      return { stem: f.stem, doc, label: en(doc.preferredName) ?? String(doc.shortName ?? f.stem) };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'en') || a.stem.localeCompare(b.stem, 'en'));

  const pageCount = Math.max(1, Math.ceil(entries.length / INDEX_PAGE_SIZE));
  const pageName = (n: number): string => (n === 1 ? 'index.html' : `page-${n}.html`);

  return Array.from({ length: pageCount }, (_, i) => {
    const page = i + 1;
    const rows = entries.slice(i * INDEX_PAGE_SIZE, page * INDEX_PAGE_SIZE).map(({ stem, doc, label }) => `<tr>
<td><a href="/def/${esc(stem)}">${esc(label)}</a></td>
<td><code>${esc(doc.shortName ?? '')}</code></td>
<td>${esc(doc.objectType)}</td>
</tr>`).join('\n');

    const nav = pageCount === 1 ? '' : `\n<nav class="pages">${[
      page > 1 ? `<a href="/${pageName(page - 1)}">← previous</a>` : '',
      `page ${page} of ${pageCount}`,
      page < pageCount ? `<a href="/${pageName(page + 1)}">next →</a>` : '',
    ].filter(Boolean).join(' · ')}</nav>`;

    const body = `<h1>Dictionary index</h1>
<p class="meta">${entries.length} current ${entries.length === 1 ? 'entry' : 'entries'} · immutable, permanent versions at <code>https://material-identity.eu/def/&lt;uuid&gt;</code></p>
<table class="versions">
<thead><tr><th>preferredName (en)</th><th>shortName</th><th>objectType</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>${nav}
<p class="contribute"><a href="https://github.com/material-identity/dictionary/issues/new?template=dictionary-request.yml">Request a new entry</a> · <a href="https://github.com/material-identity/dictionary">View source / contribute on GitHub</a> · <a href="/feed.xml">RSS feed</a> · <a href="/tree">Tree view</a> · <a href="/schema">JSON Schema reference</a></p>`;

    const canonicalPath = page === 1 ? '/' : `/${pageName(page)}`;
    return { name: pageName(page), html: pageShell(page === 1 ? 'Dictionary index' : `Dictionary index — page ${page}`, canonicalPath, body, { rssFeed: true }) };
  });
}
