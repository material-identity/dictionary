# REVIEW.md — what reviewers check beyond CI

The reviewer contract for CODEOWNERS and review agents (`/code-review` reads this file).
CI (`pr-checks`) already enforces structure: schema validity, identity, replaces integrity,
pinning, immutability, move purity, the two-yes gate, coverage.
**Do not re-review what CI proves.** Review what only judgment can catch:

## 1 Definition quality and precision

- [ ] The `definition` states what the concept **is**, not how it is used or why it matters.
- [ ] Measurable concepts name the determining condition (e.g. gauge vs absolute pressure,
      temperature of reference) — a definition a test lab could act on.
- [ ] No circularity: the definition does not restate the `shortName` in more words.
- [ ] `exampleValue` is realistic and consistent with `valueDataType` and `unit`.
- [ ] The concept is one concept — if the definition needs "and/or", it is probably two entries.

## 2 Language correctness (en, de)

- [ ] English `definition`/`preferredName` are idiomatic technical English, singular form,
      no trailing period in names, sentence case in definitions.
- [ ] German translations are technically correct, not literal calques
      (Fachbegriff over word-for-word; e.g. *Streckgrenze*, not *Fließgrenze*, for yield strength
      in steel contexts).
- [ ] Language keys are lowercase ISO 639 (`en`, `de`, optionally region-tagged `de-AT`).

## 3 Standard references

- [ ] `definitionStandard`/`testStandard` name the **correct document and clause** — open the
      cited standard (local `standards/` library) and verify the clause actually defines/tests
      this concept; a wrong clause is worse than none.
- [ ] The reference names the version-independent designation (EN 13445-3), not a dated copy,
      unless the concept is version-bound.
- [ ] `isDefinedBy` is the dictionary root, not a standard — provenance of the entry,
      not of the concept.

## 4 Envelope idioms

- [ ] `preferredName`/`definition`/`symbol` are language maps — never bare strings.
- [ ] `unit` is a **reference to a MeasurementUnit entry** — never an inline string like "MPa";
      same for `quantityKind`, `itemType`, enumeration members.
- [ ] Multilingual *values* (not metadata) use `rdf:langString` + `MultiLanguageDataElement`.
- [ ] `isMandatory` sits on collection **membership**; specification-independent collections
      omit the flags (mandatoriness belongs to the spec context, not the concept).
- [ ] Entries carry no status/lifecycle fields at all — supersession is only ever expressed
      via `replaces`; "current" and "superseded" are derived at build time, never stored.

## Process

Reviewing a publish PR is Yes #2 of the two-yes principle (plan §5.3): confirm the linked
dictionary-request issue really covers what the entry says — the request is what was accepted.

**Ratchet rule (plan §2.7):** the second time you make the same correction, stop reviewing it —
turn it into a `validate.ts` check (if mechanical), a line here (if judgment), or a skill step.
