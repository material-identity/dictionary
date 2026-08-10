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
  if (doc.resourceMediaType !== undefined) rows.push(row('resourceMediaType', `<code>${esc(doc.resourceMediaType)}</code>`));
  if (doc.itemType !== undefined) rows.push(row('itemType', refs.link(doc.itemType)));
  if (Array.isArray(doc.elements)) {
    const body = (doc.elements as Doc[]).map((el) =>
      `<tr><td>${refs.link(el.dictionaryReference)}</td><td>${el.isMandatory ? 'mandatory' : 'optional'}</td></tr>`).join('');
    rows.push(row('elements', `<table class="inner"><thead><tr><th>member</th><th>membership</th></tr></thead><tbody>${body}</tbody></table>`));
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
</table>${nav}`;

    const canonicalPath = page === 1 ? '/' : `/${pageName(page)}`;
    return { name: pageName(page), html: pageShell(page === 1 ? 'Dictionary index' : `Dictionary index — page ${page}`, canonicalPath, body, { rssFeed: true }) };
  });
}
