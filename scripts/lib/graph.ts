/**
 * The dictionary as a graph (issue #99): a static SVG computed at build time — no client-side
 * JS, no external layout binary. `/tree` nests containment only, so the cross-links (unit,
 * quantityKind, accessCategory, replaces, …) are invisible there; this is where they show.
 *
 * Layout is layered and deterministic: four columns by kind, ordered within a column by the
 * barycenter of each node's neighbours in the previous column (the classic crossing-reduction
 * step), ties broken by label. Two builds produce byte-identical SVG.
 *
 * Colours come from the stylesheet's custom properties, so the figure follows the light/dark
 * theme without a second palette.
 */
import { DEF_PREFIX, type RepoModel } from './repo.ts';
import { esc, en, lang, type Doc, type RefIndex } from './render.ts';

type Column = 'collection' | 'element' | 'value' | 'unit';
const COLUMNS: Array<{ key: Column; title: string }> = [
  { key: 'collection', title: 'Collections' },
  { key: 'element', title: 'Elements' },
  { key: 'value', title: 'Values' },
  { key: 'unit', title: 'Units & quantities' },
];

/** Same four kinds the chips use, so colour means the same thing here as everywhere else. */
function columnOf(objectType: unknown): Column {
  switch (objectType) {
    case 'DataElementCollection': return 'collection';
    case 'MeasurementUnit': case 'Quantity': return 'unit';
    case 'Value': return 'value';
    default: return 'element';
  }
}

type EdgeKind = 'member' | 'item' | 'permittedValue' | 'unit' | 'quantityKind' | 'coherentSiUnit' | 'accessCategory' | 'conversion' | 'replaces';
interface Edge { from: string; to: string; kind: EdgeKind }

const EDGE_STYLE: Record<EdgeKind, { label: string; stroke: string; dash?: string }> = {
  member: { label: 'member of a collection', stroke: 'var(--chip-collection-fg)' },
  item: { label: 'item type of a list', stroke: 'var(--chip-collection-fg)', dash: '2 3' },
  permittedValue: { label: 'permitted value', stroke: 'var(--chip-value-fg)' },
  unit: { label: 'unit', stroke: 'var(--chip-unit-fg)', dash: '4 3' },
  quantityKind: { label: 'quantity kind', stroke: 'var(--chip-unit-fg)', dash: '4 3' },
  coherentSiUnit: { label: 'coherent SI unit', stroke: 'var(--chip-unit-fg)', dash: '1 3' },
  conversion: { label: 'conversion target', stroke: 'var(--chip-unit-fg)', dash: '1 3' },
  accessCategory: { label: 'access category (from a membership)', stroke: 'var(--chip-tier-fg)', dash: '4 3' },
  replaces: { label: 'replaces', stroke: 'var(--dead-edge)', dash: '6 3' },
};

function defUuid(v: unknown): string | undefined {
  return typeof v === 'string' && v.startsWith(DEF_PREFIX) ? v.slice(DEF_PREFIX.length) : undefined;
}

function edgesOf(uuid: string, doc: Doc): Edge[] {
  const edges: Edge[] = [];
  const add = (target: unknown, kind: EdgeKind): void => {
    const to = defUuid(target);
    if (to !== undefined) edges.push({ from: uuid, to, kind });
  };
  if (Array.isArray(doc.elements)) {
    for (const el of doc.elements as Doc[]) {
      add(el.dictionaryReference, 'member');
      add(el.accessCategory, 'accessCategory');
    }
  }
  add(doc.itemType, 'item');
  if (Array.isArray(doc.enumeration)) for (const v of doc.enumeration) add(v, 'permittedValue');
  add(doc.unit, 'unit');
  add(doc.quantityKind, 'quantityKind');
  add(doc.coherentSiUnit, 'coherentSiUnit');
  if (Array.isArray(doc.conversions)) for (const c of doc.conversions as Doc[]) add(c.toUnit, 'conversion');
  add(doc.replaces, 'replaces');
  return edges;
}

const NODE_W = 208;
const NODE_H = 22;
const ROW_H = 30;
const COL_GAP = 132;
const PAD = 20;
const HEADER_H = 30;

function truncate(label: string, max = 26): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

export interface GraphFigure { svg: string; edgeList: string; nodeCount: number; edgeCount: number }

export function graphFigure(repo: RepoModel, refs: RefIndex): GraphFigure {
  const docs = new Map<string, Doc>();
  for (const f of repo.published) if (f.doc) docs.set(f.stem, f.doc);

  const label = (uuid: string): string => en(docs.get(uuid)?.preferredName) ?? String(docs.get(uuid)?.shortName ?? uuid);
  const edges = [...docs]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .flatMap(([uuid, doc]) => edgesOf(uuid, doc))
    .filter((e) => docs.has(e.to));

  // columns, then barycentre ordering against the already-ordered previous column
  const byColumn = new Map<Column, string[]>(COLUMNS.map(({ key }) => [key, []]));
  for (const [uuid, doc] of [...docs].sort(([, a], [, b]) => label(String(a.id)).localeCompare(label(String(b.id)), 'en'))) {
    byColumn.get(columnOf(doc.objectType))!.push(uuid);
  }
  const position = new Map<string, { col: number; row: number }>();
  COLUMNS.forEach(({ key }, col) => {
    const nodes = byColumn.get(key)!.sort((a, b) => label(a).localeCompare(label(b), 'en'));
    const barycentre = (uuid: string): number => {
      const rows = edges
        .filter((e) => e.to === uuid && position.has(e.from))
        .map((e) => position.get(e.from)!.row);
      return rows.length === 0 ? Number.POSITIVE_INFINITY : rows.reduce((s, r) => s + r, 0) / rows.length;
    };
    const ordered = col === 0 ? nodes : [...nodes].sort((a, b) => (barycentre(a) - barycentre(b)) || label(a).localeCompare(label(b), 'en'));
    ordered.forEach((uuid, row) => position.set(uuid, { col, row }));
    byColumn.set(key, ordered);
  });

  const x = (col: number): number => PAD + col * (NODE_W + COL_GAP);
  const y = (row: number): number => PAD + HEADER_H + row * ROW_H;
  const rows = Math.max(...COLUMNS.map(({ key }) => byColumn.get(key)!.length));
  const width = PAD * 2 + COLUMNS.length * NODE_W + (COLUMNS.length - 1) * COL_GAP;
  const height = PAD * 2 + HEADER_H + Math.max(rows, 1) * ROW_H;

  const headers = COLUMNS.map(({ key, title }, col) =>
    `<text class="g-col" x="${x(col)}" y="${PAD + 14}">${esc(title)} (${byColumn.get(key)!.length})</text>`).join('\n');

  const nodes = [...position].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([uuid, { col, row }]) => {
    const doc = docs.get(uuid) as Doc;
    const kind = columnOf(doc.objectType);
    const superseded = refs.isSuperseded(doc);
    const title = `${label(uuid)} — ${String(doc.objectType)}${superseded ? ' (superseded)' : ''}`;
    return `<a href="/def/${esc(uuid)}"><title>${esc(title)}</title>` +
      `<rect class="g-node g-${kind}${superseded ? ' g-dead' : ''}" x="${x(col)}" y="${y(row)}" width="${NODE_W}" height="${NODE_H}" rx="4"/>` +
      `<text class="g-label" x="${x(col) + 8}" y="${y(row) + 15}">${esc(truncate(label(uuid)))}</text></a>`;
  }).join('\n');

  const curves = edges.map(({ from, to, kind }) => {
    const a = position.get(from)!;
    const b = position.get(to)!;
    const style = EDGE_STYLE[kind];
    const forward = b.col > a.col;
    // forward edges leave the right face and enter the left; anything else loops out to the left
    const x1 = forward ? x(a.col) + NODE_W : x(a.col);
    const x2 = forward ? x(b.col) : x(b.col);
    const y1 = y(a.row) + NODE_H / 2;
    const y2 = y(b.row) + NODE_H / 2;
    const bend = forward ? Math.max(40, (x2 - x1) / 2) : -Math.max(40, Math.abs(x2 - x1) / 2 + 30);
    const d = `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
    return `<path class="g-edge" d="${d}" stroke="${style.stroke}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''}/>`;
  }).join('\n');

  const svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="graph-title" xmlns="http://www.w3.org/2000/svg">
<title id="graph-title">${docs.size} dictionary entries and the ${edges.length} links between them, grouped by kind</title>
${headers}
<g fill="none" stroke-width="1.2" opacity="0.75">
${curves}
</g>
${nodes}
</svg>`;

  const legend = Object.entries(EDGE_STYLE).map(([kind, style]) =>
    `<li><svg class="g-key" viewBox="0 0 28 8" width="28" height="8" aria-hidden="true"><path d="M0 4 H28" fill="none" stroke-width="1.6" stroke="${style.stroke}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ''}/></svg> ${esc(style.label)} <code>${esc(kind)}</code></li>`).join('');

  // the same information without the picture: an SVG-only graph is unreadable to a screen
  // reader and to anyone the figure fails for
  const rowsHtml = edges.map(({ from, to, kind }) =>
    `<tr><td><a href="/def/${esc(from)}">${esc(label(from))}</a></td><td><code>${esc(kind)}</code></td><td><a href="/def/${esc(to)}">${esc(label(to))}</a></td></tr>`).join('\n');
  const edgeList = `<table class="versions"><thead><tr><th>From</th><th>Link</th><th>To</th></tr></thead><tbody>
${rowsHtml}
</tbody></table>`;

  return {
    svg: `<figure class="graph"><div class="graph-scroll">${svg}</div>
<figcaption>Every link between entries. Nodes are grouped by kind and ordered to keep the lines untangled; each node links to its entry page.</figcaption></figure>
<ul class="graph-key">${legend}</ul>`,
    edgeList,
    nodeCount: docs.size,
    edgeCount: edges.length,
  };
}

/** Language coverage is a graph-adjacent fact the page can state cheaply while it has the docs. */
export function languageSummary(repo: RepoModel): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of repo.published) {
    if (!f.doc) continue;
    for (const code of Object.keys(lang(f.doc.definition))) counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}
