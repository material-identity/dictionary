/**
 * RSS feed of newly published entries (#56). One item per published entry, newest first;
 * items that supersede an earlier one say so in the description. pubDate comes from git
 * history (scripts/lib/git.ts's getAddedDates) — never stored in the entry itself, derived
 * at build time the same way "current"/"superseded" are (#57).
 */
import { CANONICAL_BASE, DEF_PREFIX, type RepoModel } from './repo.ts';
import { en, esc, type Doc } from './render.ts';

function rfc822(date: Date | undefined): string | undefined {
  return date ? date.toUTCString() : undefined;
}

function itemXml(doc: Doc, pubDate: Date | undefined): string {
  const uuid = String(doc.id).slice(DEF_PREFIX.length);
  const url = `${CANONICAL_BASE}/def/${uuid}`;
  const title = `${en(doc.preferredName) ?? String(doc.shortName ?? uuid)}${doc.shortName ? ` (${doc.shortName})` : ''}`;
  const supersedes = typeof doc.replaces === 'string' ? ` Supersedes: ${doc.replaces}.` : '';
  const description = `${en(doc.definition) ?? ''}${supersedes}`.trim();
  const pubDateXml = rfc822(pubDate);

  return `<item>
<title>${esc(title)}</title>
<link>${esc(url)}</link>
<guid isPermaLink="true">${esc(url)}</guid>
<description>${esc(description)}</description>${pubDateXml ? `\n<pubDate>${esc(pubDateXml)}</pubDate>` : ''}
</item>`;
}

/** Renders /feed.xml (RSS 2.0). `addedDates` keys are paths relative to the repo root. */
export function renderFeed(repo: RepoModel, addedDates: Map<string, string>): string {
  const items = repo.published
    .filter((f) => f.doc)
    .map((f) => {
      const iso = addedDates.get(f.relPath);
      return { doc: f.doc as Doc, pubDate: iso ? new Date(iso) : undefined };
    })
    .sort((a, b) => {
      if (!a.pubDate && !b.pubDate) return String(a.doc.id).localeCompare(String(b.doc.id), 'en');
      if (!a.pubDate) return 1; // unknown date sorts last, never first
      if (!b.pubDate) return -1;
      return b.pubDate.getTime() - a.pubDate.getTime(); // newest first
    });

  const itemsXml = items.map(({ doc, pubDate }) => itemXml(doc, pubDate)).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
<title>material-identity dictionary</title>
<link>${CANONICAL_BASE}/</link>
<description>Newly published dictionary entries, including which ones supersede an earlier one.</description>
${itemsXml}
</channel>
</rss>
`;
}
