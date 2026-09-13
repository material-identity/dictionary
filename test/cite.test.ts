import test from 'node:test';
import assert from 'node:assert/strict';
import { citation } from '../scripts/lib/cite.ts';

const doc = {
  id: 'https://material-identity.eu/def/7e193aef-7ad1-4099-8492-ee160ae26717',
  shortName: 'tensileStrength',
  preferredName: { en: 'Tensile strength', de: 'Zugfestigkeit' },
};

test('an entry in a release is cited by that release: ISO 690 text, BibLaTeX version + date, CSL version + issued', () => {
  const c = citation(doc, '7e193aef-7ad1-4099-8492-ee160ae26717', { date: '2026-08-28', release: 'v2026.08.28' });
  assert.equal(c.iso690, 'material-identity dictionary. Tensile strength (tensileStrength) [dictionary element]. Release v2026.08.28, 2026-08-28. Available from: https://material-identity.eu/def/7e193aef-7ad1-4099-8492-ee160ae26717');
  assert.match(c.biblatex, /^@online\{material-identity-tensileStrength,\n/);
  assert.match(c.biblatex, /\n  version {6}= \{v2026\.08\.28\},\n  date {9}= \{2026-08-28\},\n/);
  assert.ok(!c.biblatex.includes('urldate'));
  assert.equal(c.csl.version, 'v2026.08.28');
  assert.deepEqual(c.csl.issued, { 'date-parts': [[2026, 8, 28]] });
  assert.equal(c.csl.type, 'entry-dictionary');
});

test('an entry merged since the last tag says so rather than implying a release', () => {
  const c = citation(doc, '7e193aef-7ad1-4099-8492-ee160ae26717', { date: '2026-09-13T08:00:00+02:00' });
  assert.match(c.iso690, /\[dictionary element\]\. Published 2026-09-13; not yet in a release\. Available from: /);
  assert.ok(!c.biblatex.includes('version'), 'no version until it ships in a release');
  assert.match(c.biblatex, /\n  date {9}= \{2026-09-13\},\n/);
  assert.equal(c.csl.version, undefined);
  assert.deepEqual(c.csl.issued, { 'date-parts': [[2026, 9, 13]] });
});

test('citation without a date omits it (n.d.) rather than inventing one; superseded entries name the successor', () => {
  const c = citation(doc, '7e193aef-7ad1-4099-8492-ee160ae26717', { supersededBy: 'https://material-identity.eu/def/12e6babe-cf5b-4c1a-ab07-7f535ad5d165' });
  assert.match(c.iso690, / n\.d\. Available from: /);
  assert.match(c.iso690, /\[dictionary element, superseded by https:\/\/material-identity\.eu\/def\/12e6babe-cf5b-4c1a-ab07-7f535ad5d165\]\. n\.d\. Available from: https:\/\/material-identity\.eu\/def\/7e193aef-7ad1-4099-8492-ee160ae26717$/);
  assert.ok(!c.biblatex.includes('date '));
  assert.match(String(c.csl.note), /Superseded by/);
  assert.equal(c.csl.issued, undefined);
});

test('BibLaTeX escapes the characters that break a .bib file; falls back to the uuid without a shortName', () => {
  const c = citation({ id: 'https://material-identity.eu/def/x', preferredName: { en: 'C & Si content (50% #1)' } }, 'x', {});
  assert.match(c.biblatex, /title {8}= \{C \\& Si content \(50\\% \\#1\)\}/);
  assert.match(c.biblatex, /^@online\{material-identity-x,/);
  assert.match(c.iso690, /^material-identity dictionary\. C & Si content \(50% #1\) \[dictionary element\]\. n\.d\./);
});
