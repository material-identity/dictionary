/**
 * Citations for an immutable dictionary element (issue #94). Deliberately no access date:
 * the representation at the id never changes, so "viewed on" carries no information. The
 * publication date is the entry's git add-date; when unknown (fixture trees outside a git
 * work-tree) it is omitted rather than invented.
 */
import type { Doc } from './render.ts';

export interface Citation {
  iso690: string;
  biblatex: string;
  csl: Record<string, unknown>;
}

const PUBLISHER = 'material-identity dictionary';

function bibEscape(s: string): string {
  return s.replace(/([\\{}%&#$_])/g, '\\$1');
}

export function citation(doc: Doc, uuid: string, options: { date?: string; supersededBy?: string } = {}): Citation {
  const id = String(doc.id);
  const title = (doc.preferredName as Record<string, string> | undefined)?.en ?? String(doc.shortName ?? uuid);
  const shortName = typeof doc.shortName === 'string' ? doc.shortName : undefined;
  const date = options.date?.slice(0, 10);
  const superseded = options.supersededBy === undefined ? '' : ` Superseded by ${options.supersededBy}.`;

  // The medium bracket carries the supersession so neither URL is followed by punctuation.
  const iso690 = `${PUBLISHER}. ${title}${shortName ? ` (${shortName})` : ''} [dictionary element${
    options.supersededBy === undefined ? '' : `, superseded by ${options.supersededBy}`
  }]. ${date ? `Published ${date}.` : 'n.d.'} Available from: ${id}`;

  const fields: Array<[string, string]> = [
    ['title', bibEscape(title)],
    ['organization', PUBLISHER],
    ...(date ? [['date', date] as [string, string]] : []),
    ['url', id],
    ['note', `Immutable dictionary element; superseded entries stay resolvable.${superseded}`],
    ['langid', 'english'],
  ];
  const width = Math.max(...fields.map(([k]) => k.length));
  const biblatex = `@online{material-identity-${shortName ?? uuid},\n${
    fields.map(([k, v]) => `  ${k.padEnd(width)} = {${v}},`).join('\n')
  }\n}`;

  const csl: Record<string, unknown> = {
    id: `material-identity-${shortName ?? uuid}`,
    type: 'entry-dictionary',
    title,
    'container-title': PUBLISHER,
    author: [{ literal: PUBLISHER }],
    publisher: PUBLISHER,
    URL: id,
    language: 'en',
    note: `Immutable dictionary element; superseded entries stay resolvable.${superseded}`,
  };
  if (date) csl.issued = { 'date-parts': [date.split('-').map(Number)] };
  return { iso690, biblatex, csl };
}
