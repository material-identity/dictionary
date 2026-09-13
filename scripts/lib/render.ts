/**
 * HTML rendering (plan §4 M3 item 1, redesigned per issue #57): template literals only, no
 * framework, no client-side JS. Internal references render as links with resolved labels.
 * "Superseded" is never stored — derived here by reverse-scanning `replaces` across
 * published/ and shown purely as presentation (a banner), never written back to any file.
 */
import { CANONICAL_BASE, DEF_PREFIX, type RepoFile, type RepoModel } from './repo.ts';
import { citation } from './cite.ts';
import { graphFigure } from './graph.ts';

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

  doc(uuid: string): Doc | undefined {
    return this.published.get(uuid);
  }

  label(uuid: string): string {
    const doc = this.published.get(uuid);
    return en(doc?.preferredName) ?? (doc?.shortName as string | undefined) ?? uuid;
  }

  /** Current entries that contain `uuid` (elements / itemType / enumeration), with the edge that does. */
  parents(uuid: string): Array<{ uuid: string; edge: ContainmentEdge }> {
    if (!this.parentIndex) {
      this.parentIndex = new Map();
      for (const [parent, doc] of this.published) {
        if (this.isSuperseded(doc)) continue;
        for (const edge of containmentEdges(doc)) {
          const list = this.parentIndex.get(edge.uuid) ?? [];
          list.push({ uuid: parent, edge });
          this.parentIndex.set(edge.uuid, list);
        }
      }
    }
    return this.parentIndex.get(uuid) ?? [];
  }
  private parentIndex: Map<string, Array<{ uuid: string; edge: ContainmentEdge }>> | undefined;

  /** Root → … → first parent, following the first parent at each level; the tree shows the rest. */
  breadcrumb(uuid: string): string[] {
    const chain: string[] = [];
    const seen = new Set<string>([uuid]);
    let cursor = this.parents(uuid)[0]?.uuid;
    while (cursor !== undefined && !seen.has(cursor)) {
      chain.unshift(cursor);
      seen.add(cursor);
      cursor = this.parents(cursor)[0]?.uuid;
    }
    return chain;
  }
}

type Kind = 'element' | 'collection' | 'unit' | 'value';
function kindOf(objectType: unknown): Kind {
  switch (objectType) {
    case 'DataElementCollection': return 'collection';
    case 'MeasurementUnit': case 'Quantity': return 'unit';
    case 'Value': return 'value';
    default: return 'element';
  }
}
function kindChip(objectType: unknown): string {
  return `<span class="chip ${kindOf(objectType)}">${esc(objectType)}</span>`;
}
/** Membership badges for a containment edge — they describe the edge, never the entry. */
function edgeBadges(edge: ContainmentEdge | undefined, refs: RefIndex): string {
  const out: string[] = [];
  if (edge?.kind === 'member') out.push(`<span class="badge">${edge.isMandatory ? 'mandatory' : 'optional'}</span>`);
  if (edge?.kind === 'item') out.push('<span class="badge">item type</span>');
  if (edge?.kind === 'value') out.push('<span class="badge">value</span>');
  if (edge?.accessCategory !== undefined) out.push(`<span class="badge tier">access: ${refs.link(edge.accessCategory)}</span>`);
  return out.join(' ');
}

const NAV: Array<[key: string, href: string, label: string]> = [
  ['index', '/', 'Index'], ['tree', '/tree', 'Tree'], ['graph', '/graph', 'Graph'], ['schema', '/schema', 'Schema'], ['feed', '/feed.xml', 'Feed'],
];
const FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%231f7a4d'/%3E%3C/svg%3E";

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
function pageShell(
  title: string,
  canonicalPath: string,
  body: string,
  options: { alternateJson?: string; alternateCsl?: string; rssFeed?: boolean; nav?: string; description?: string } = {},
): string {
  const canonicalUrl = `${CANONICAL_BASE}${canonicalPath}`;
  const alternate = (options.alternateJson === undefined
    ? ''
    : `\n<link rel="alternate" type="application/json" href="${esc(options.alternateJson)}">`) + (options.alternateCsl === undefined
    ? ''
    : `\n<link rel="alternate" type="application/vnd.citationstyles.csl+json" href="${esc(options.alternateCsl)}">`);
  const rss = options.rssFeed
    ? `\n<link rel="alternate" type="application/rss+xml" title="material-identity dictionary" href="/feed.xml">`
    : '';
  const description = options.description === undefined ? '' : `\n<meta name="description" content="${esc(options.description)}">`;
  const nav = NAV.map(([key, href, label]) => `<a href="${href}"${options.nav === key ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${description}
<meta name="theme-color" content="#1f7a4d" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b1a13" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${FAVICON}">
<link rel="canonical" href="${esc(canonicalUrl)}">
<link rel="stylesheet" href="/styles.css">${alternate}${rss}
</head>
<body>
<header class="mast"><div class="wrap">
<a class="wordmark" href="/">material-identity <span>dictionary</span></a>
<nav class="nav" aria-label="Site">${nav}</nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer><div class="wrap">
<span>Content CC0 1.0 · <a href="https://material-identity.eu/">material-identity.eu</a></span>
<span><a href="https://github.com/material-identity/dictionary/issues/new?template=dictionary-request.yml">Request a new entry</a> · <a href="https://github.com/material-identity/dictionary">View source / contribute on GitHub</a> · <a href="/feed.xml">RSS feed</a> · <a href="/tree">Tree view</a> · <a href="/schema">JSON Schema reference</a> · <a href="/dictionary.ttl">RDF (Turtle)</a></span>
</div></footer>
</body>
</html>
`;
}

function langMapHtml(v: unknown): string {
  const entries = Object.entries(lang(v)).sort(([a], [b]) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b, 'en')));
  return `<dl class="langmap">${entries.map(([k, s]) => `<dt>${esc(k)}</dt><dd lang="${esc(k)}">${esc(s)}</dd>`).join('')}</dl>`;
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

/** A reference to another entry, shown as its label plus its kind chip (and a unit's symbol). */
function refHtml(uri: unknown, refs: RefIndex): string {
  const uuid = defUuidOf(uri);
  const target = uuid ? refs.doc(uuid) : undefined;
  if (!target) return refs.link(uri);
  const symbol = target.objectType === 'MeasurementUnit' && en(target.symbol) ? ` <code>${esc(en(target.symbol))}</code>` : '';
  return `<span class="ref">${refs.link(uri)}${symbol} ${kindChip(target.objectType)}</span>`;
}

function externalLink(uri: unknown): string {
  return `<a href="${esc(uri)}" rel="external">${esc(uri)}</a>`;
}

/**
 * Entry page as a document (issue #92): breadcrumb from containment, hero, definition as
 * prose, then facts grouped by meaning. The JSON representation is untouched — this is
 * presentation only; nothing here is read back from stored state.
 */
export function renderEntryPage(file: RepoFile, repo: RepoModel, refs: RefIndex, publishedDate?: string, release?: string): string {
  const doc = file.doc as Doc;
  const title = en(doc.preferredName) ?? String(doc.shortName ?? file.stem);
  const fact = (label: string, html: string): string => `<dt>${esc(label)}</dt><dd>${html}</dd>`;
  const section = (heading: string, facts: string[]): string =>
    facts.length === 0 ? '' : `<section><h2>${esc(heading)}</h2><dl class="facts">${facts.join('\n')}</dl></section>`;

  // hero
  const crumbs = ['<li><a href="/">Dictionary</a></li>',
    ...refs.breadcrumb(file.stem).map((u) => `<li><a href="/def/${esc(u)}">${esc(refs.label(u))}</a></li>`),
    `<li>${esc(title)}</li>`];
  const names = Object.entries(lang(doc.preferredName)).filter(([k]) => k !== 'en')
    .map(([k, v]) => `<p class="alt-name"><span class="lang">${esc(k)}</span><span lang="${esc(k)}">${esc(v)}</span></p>`).join('');
  const symbolText = en(doc.symbol);
  // caption first in the DOM (reads "symbol Rm"), reversed visually by the stylesheet
  const symbol = symbolText === undefined ? '' : `<p class="symbol-block"><span class="symbol-cap">symbol</span><span class="symbol${doc.objectType === 'MeasurementUnit' ? ' upright' : ''}">${esc(symbolText)}</span></p>`;
  const shortName = doc.shortName !== undefined ? `<span class="chip neutral"><code>${esc(doc.shortName)}</code></span>` : '';

  // definition as prose; a missing German definition is shown, not hidden (#76)
  const defs = lang(doc.definition);
  const definition = doc.definition === undefined ? '' : `<div class="definition">${
    Object.entries(defs).sort(([a], [b]) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b, 'en')))
      .map(([k, v]) => `<span class="lang">${esc(k)}</span><p lang="${esc(k)}">${esc(v)}</p>`).join('')
  }${defs.de === undefined ? '<span class="lang">de</span><p class="missing">No German definition yet — request one via a dictionary request.</p>' : ''}</div>`;

  // value
  const value: string[] = [];
  if (doc.value !== undefined) value.push(fact('Value', `<code>${esc(JSON.stringify(doc.value))}</code>`));
  if (doc.valueDataType !== undefined) value.push(fact('Data type', `<code>${esc(doc.valueDataType)}</code>`));
  if (doc.unit !== undefined) value.push(fact('Unit', refHtml(doc.unit, refs)));
  if (doc.quantityKind !== undefined) value.push(fact('Quantity kind', refHtml(doc.quantityKind, refs)));
  if (doc.dimension !== undefined) value.push(fact('Dimension', `<code>${esc(doc.dimension)}</code>`));
  if (doc.coherentSiUnit !== undefined) value.push(fact('Coherent SI unit', refHtml(doc.coherentSiUnit, refs)));
  if (doc.exampleValue !== undefined) value.push(fact('Example', `<code>${esc(JSON.stringify(doc.exampleValue))}</code>`));
  if (doc.resourceMediaType !== undefined) value.push(fact('Media type', `<code>${esc(doc.resourceMediaType)}</code>`));
  if (doc.itemType !== undefined) value.push(fact('Item type', refHtml(doc.itemType, refs)));
  if (Array.isArray(doc.enumeration)) {
    value.push(fact('Permitted values', `<ul class="plain">${doc.enumeration.map((u) => `<li>${refHtml(u, refs)}</li>`).join('')}</ul>`));
  }
  if (Array.isArray(doc.elements)) {
    const members = (doc.elements as Doc[]).map((el) => {
      const edge: ContainmentEdge = { uuid: defUuidOf(el.dictionaryReference) ?? '', kind: 'member', isMandatory: el.isMandatory === true, accessCategory: typeof el.accessCategory === 'string' ? el.accessCategory : undefined };
      return `<div class="member">${refHtml(el.dictionaryReference, refs)} ${edgeBadges(edge, refs)}</div>`;
    }).join('');
    value.push(fact('Members', members));
  }
  if (Array.isArray(doc.conversions)) {
    const rows = (doc.conversions as Doc[]).map((c) =>
      `<tr><td>${refHtml(c.toUnit, refs)}</td><td>${esc(c.factor)}</td><td>${esc(c.offset ?? 0)}</td></tr>`).join('');
    value.push(fact('Conversions', `<div class="table-scroll"><table class="inner"><thead><tr><th>to unit</th><th>factor</th><th>offset</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  }
  if (doc.crossReferences !== undefined) {
    const rows = Object.entries(doc.crossReferences as Doc).map(([k, v]) =>
      `<tr><td><code>${esc(k)}</code></td><td>${String(v).startsWith('http') ? externalLink(v) : esc(v)}</td></tr>`).join('');
    value.push(fact('Cross-references', `<table class="inner"><tbody>${rows}</tbody></table>`));
  }

  // contained by — badges describe the membership, not this entry
  const parents = refs.parents(file.stem);
  const containedBy = parents.length === 0 ? '' : `<section><h2>Contained by</h2>${
    parents.map(({ uuid, edge }) => `<div class="member">${refHtml(`${DEF_PREFIX}${uuid}`, refs)} ${edgeBadges(edge, refs)}</div>`).join('')
  }<p class="meta">Membership badges come from the containing collection, not from this entry.</p></section>`;

  // sources
  const sources: string[] = [];
  if (doc.definitionStandard !== undefined) sources.push(fact('Definition standard', standardRefHtml(doc.definitionStandard)));
  if (doc.testStandard !== undefined) sources.push(fact('Test standard', standardRefHtml(doc.testStandard)));
  if (doc.legalBasis !== undefined) sources.push(fact('Legal basis', standardRefHtml(doc.legalBasis)));
  for (const [field, label] of [['inheritsFrom', 'Inherits from'], ['identicalTo', 'Identical to']] as const) {
    const v = doc[field];
    if (Array.isArray(v)) sources.push(fact(label, v.map((u) => externalLink(u)).join('<br>')));
  }
  sources.push(fact('Defined by', `${externalLink(doc.isDefinedBy)} <span class="aside">— the dictionary that syndicates this entry, not the authority behind its meaning</span>`));

  // identity + citation (no access date by design — the representation never changes)
  const cite = citation(doc, file.stem, { date: publishedDate, release, supersededBy: refs.supersededByEntry(doc)?.id as string | undefined });
  const identity = `<section><h2>Identity</h2>
<div class="identity"><div><span class="eyebrow">Dictionary element id · immutable${
    release !== undefined ? ` · release ${esc(release)}` : publishedDate !== undefined ? ` · published ${esc(publishedDate.slice(0, 10))}` : ''
  }</span><span class="mono">${esc(doc.id)}</span></div>
<div class="actions"><a href="/def/${esc(file.stem)}.json" class="btn">Raw JSON</a></div></div>${
    doc.replaces !== undefined ? `<dl class="facts">${fact('Replaces', refHtml(doc.replaces, refs))}</dl>` : ''
  }
<details class="cite"><summary>Cite this entry</summary>
<p class="meta">The identifier is immutable, so no access date is needed; a superseded entry stays resolvable and says what replaced it.</p>
<p class="iso690">${esc(cite.iso690)}</p>
<pre><code>${esc(cite.biblatex)}</code></pre>
<p class="meta"><a href="/def/${esc(file.stem)}.csl.json">CSL-JSON</a> for Zotero, Mendeley or pandoc.</p>
</details></section>`;

  const body = `${statusBanner(doc, refs)}
<nav aria-label="Breadcrumb"><ol class="crumbs">${crumbs.join('')}</ol></nav>
<div class="hero"><div>
<div class="chips">${kindChip(doc.objectType)} ${shortName}</div>
<h1>${esc(title)}</h1>${names}
</div>${symbol}</div>
${definition}
${section('Value', value)}
${containedBy}
${section('Sources', sources)}
${identity}`;

  return pageShell(title, `/def/${file.stem}`, body, { alternateJson: `/def/${file.stem}.json`, alternateCsl: `/def/${file.stem}.csl.json`, description: en(doc.definition) });
}

/** A containment edge: the only kind of edge the tree nests. Reference edges (unit, quantityKind, …) stay links. */
export interface ContainmentEdge {
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
/**
 * The graph page (issue #99): the cross-links the tree deliberately omits, as a build-time SVG.
 * The figure is repeated as an edge table below it — an SVG-only graph is unreadable to a
 * screen reader and to anyone the picture fails for.
 */
export function renderGraphPage(repo: RepoModel, refs: RefIndex): string {
  const { svg, edgeList, nodeCount, edgeCount } = graphFigure(repo, refs);
  const body = `<h1>Dictionary graph</h1>
<p class="meta">${nodeCount} ${nodeCount === 1 ? 'entry' : 'entries'} · ${edgeCount} links · every reference between entries, including the ones <a href="/tree">the tree</a> omits: a shared unit is one node here, not a child of every property that uses it. Superseded entries are included — <code>replaces</code> is a link worth seeing. Static image, no scripts.</p>
${svg}
<section><h2>Every link, as text</h2>
${edgeList}</section>`;
  return pageShell('Dictionary graph', '/graph', body, { nav: 'graph' });
}

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

  const badges = (edge: ContainmentEdge | undefined, doc: Doc | undefined): string =>
    [edgeBadges(edge, refs), doc && refs.isSuperseded(doc) ? '<span class="badge dead">superseded</span>' : ''].filter(Boolean).join(' ');

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
    facts.push(`<a href="/def/${esc(uuid)}" aria-label="Entry page: ${esc(labelOf(uuid, doc))}">entry page</a>`);

    const nextPath = new Set(path).add(uuid);
    const children = containmentEdges(doc).map((e) => node(e.uuid, e, nextPath, depth + 1)).join('\n');
    const shortName = doc.shortName !== undefined ? ` <code>${esc(doc.shortName)}</code>` : '';
    return `<details${depth === 0 ? ' open' : ''}>
<summary>${esc(labelOf(uuid, doc))}${shortName} ${kindChip(doc.objectType)} ${badges(edge, doc)}</summary>
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
  return pageShell('Dictionary tree', '/tree', body, { nav: 'tree' });
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
<td>${kindChip(doc.objectType)}</td>
</tr>`).join('\n');

    const nav = pageCount === 1 ? '' : `\n<nav class="pages">${[
      page > 1 ? `<a href="/${pageName(page - 1)}">← previous</a>` : '',
      `page ${page} of ${pageCount}`,
      page < pageCount ? `<a href="/${pageName(page + 1)}">next →</a>` : '',
    ].filter(Boolean).join(' · ')}</nav>`;

    const body = `<h1>Dictionary index</h1>
<p class="meta">${entries.length} current ${entries.length === 1 ? 'entry' : 'entries'} · immutable, permanent versions at <code>https://material-identity.eu/def/&lt;uuid&gt;</code></p>
<table class="versions">
<thead><tr><th>Name</th><th>shortName</th><th>Kind</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>${nav}`;

    const canonicalPath = page === 1 ? '/' : `/${pageName(page)}`;
    return { name: pageName(page), html: pageShell(page === 1 ? 'Dictionary index' : `Dictionary index — page ${page}`, canonicalPath, body, { rssFeed: true, nav: 'index' }) };
  });
}
