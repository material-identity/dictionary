---
name: new-entry
description: Author a draft dictionary entry from an accepted dictionary-request issue
---

# new-entry

Turns one accepted `dictionary-request` issue into `drafts/<shortName>.yaml`. This is Yes #1's
downstream step — it never touches `published/` or `concepts/` and makes no promises (handover
§5.1). Companion skills: [publish-entry](../publish-entry/SKILL.md) moves the draft live;
[supersede-entry](../supersede-entry/SKILL.md) versions an already-published concept.

## Preconditions

- The source issue carries `type:dictionary-request` **and** `state:accepted`. If it does not,
  stop — drafting from a request that hasn't cleared Yes #1 skips the triage gate check 8 exists
  to enforce (plan §5.3).
- `drafts/<shortName>.yaml` does not already exist for this request. If it does, this is likely
  a duplicate submission — flag it to the maintainer instead of overwriting.

## Steps

1. **Read the issue.** Pull `shortName`, `objectType`, `preferredName` (en, optionally de),
   `definition` (en, optionally de), and every optional field the requester filled in
   (`valueDataType`, `unit`, `quantityKind`, `definitionStandard`, `testStandard`,
   `exampleValue`, enumeration values, collection members, `identicalTo`).

2. **Resolve references, don't invent them.** For `unit`, `quantityKind`, `itemType`, or any
   collection/enumeration member the requester named by shortName rather than URI:
   - If the referenced concept is already published, use its canonical `id`
     (`https://material-identity.eu/def/<uuid>`) — never an inline string.
   - If the requester wrote "new unit needed" (or similar) for a dependency, that dependency
     needs its **own** accepted dictionary-request and its own draft before this one can be
     published (check 5 pinning enforces this at publish time, not at draft time — drafts may
     reference not-yet-published concepts, but the publish PR must bring every dependency
     across the line together or in a prior merge).

3. **Fill the envelope** per `schema/dictionary-entry.schema.json`, satisfying the
   `objectType`-conditional requirements (§2.3 of the plan / the schema's `allOf` block):
   - `SingleValuedDataElement` / `MultiLanguageDataElement` / `RelatedResource` → `valueDataType` required.
   - `MultiValuedDataElement` → `itemType` required.
   - `DataElementCollection` → `elements` required (each `{ dictionaryReference, isMandatory }`).
   - `MeasurementUnit` → `symbol` required.
   - `Quantity` → `dimension` required.
   - `Value` → `value` required.
   - `preferredName` / `definition` / `symbol` are language maps (`{ en: "...", de: "..." }`),
     never bare strings — even when only English was supplied.

4. **Set identity fields to their final, non-placeholder values** except `id`:
   - `isVersionOf`: the concept's canonical URI. For a brand-new concept, mint its UUID now
     (`node -e "console.log(crypto.randomUUID())"`) even though `concepts/<uuid>.yaml` isn't
     created until publish — check 7 (move purity) requires the draft and the eventual
     published file to be identical apart from `id`, so `isVersionOf` must already be right.
   - `version`: `"1"` for a new concept; for a new version of an existing concept, the next
     integer after the concept's current version count (confirm in `concepts/<concept-uuid>.yaml`).
   - `isDefinedBy`: always `https://material-identity.eu/`.
   - `id`: the literal placeholder `https://material-identity.eu/def/00000000-0000-4000-8000-000000000000` — [publish-entry](../publish-entry/SKILL.md) mints the real one.

5. **Write `drafts/<shortName>.yaml`.** Comments are welcome here (YAML is the authoring
   convenience; the build reads only the parsed structure).

6. **Run `npm run validate` (check 2 will validate the new draft against the schema) and
   `npm test`.** Fix schema violations before handing off — a draft that already fails check 2
   just becomes rework at publish time.

7. **Set the issue's label to `state:drafting`** (or let `issue-state.yml` do it, if that
   transition is automated) and comment linking the draft file, so the requester and maintainer
   can see the entry taking shape before the publish PR opens.

## What this skill never does

Never write to `published/` or `concepts/`, never mint the final `id`, never open a PR. That is
[publish-entry](../publish-entry/SKILL.md)'s job — keeping the two steps separate is what makes
the publish PR's diff a pure, reviewable move (check 7).
