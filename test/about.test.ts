import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRepo } from '../scripts/lib/repo.ts';
import { RefIndex, renderAboutPage } from '../scripts/lib/render.ts';

const GREEN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'green');
const about = (release?: string): string => {
  const repo = loadRepo(GREEN);
  return renderAboutPage(repo, new RefIndex(repo), release);
};

test('counts are rendered from the repo, so the prose cannot drift from the data', () => {
  const html = about('v2026.08.28');
  // green: 8 published, one of them superseded by maxPressure v2
  assert.match(html, /<div><strong>8<\/strong><span>published entries<\/span><\/div>/);
  assert.match(html, /<div><strong>7<\/strong><span>current, the rest superseded<\/span><\/div>/);
  assert.match(html, /<div><strong>2<\/strong><span>languages \(en, de\)<\/span><\/div>/);
  assert.match(html, /<div><strong>v2026\.08\.28<\/strong><span>latest release<\/span><\/div>/);
});

test('without a release tag the page says so rather than inventing one', () => {
  const html = about();
  assert.match(html, /<div><strong>—<\/strong><span>no release yet<\/span><\/div>/);
  assert.ok(!html.includes('latest release'));
});

test('the page states what the dictionary is not, and credits the maintainers and the sponsor', () => {
  const html = about();
  assert.match(html, /<h2>What it is not<\/h2>/);
  assert.match(html, /Not the authority behind the meanings/);
  assert.match(html, /Not an access-control system/);
  assert.match(html, /graphs\/contributors" rel="external">GitHub<\/a>/);
  assert.match(html, /<a href="https:\/\/s1seven\.com" rel="external">S1Seven GmbH<\/a>/);
});

test('it is a normal page of this site: masthead, canonical link, description, no scripts', () => {
  const html = about();
  assert.match(html, /<link rel="canonical" href="https:\/\/material-identity\.eu\/about">/);
  assert.match(html, /<nav class="nav" aria-label="Site">.*<a href="\/about" aria-current="page">About<\/a>/s);
  assert.match(html, /<meta name="description" content="What the material-identity dictionary is/);
  assert.ok(!/<script/i.test(html));
});
