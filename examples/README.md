# Examples

Material that shows the dictionary in use. **Nothing here is part of the dictionary.** These
files are not entries, they carry no `/def/<uuid>` identifier, and they sit outside
`published/`, so the add-only rule and the two-yes gate do not apply to them. The build copies
this directory into the site unchanged, and it is served at
[`https://material-identity.eu/examples/`](https://material-identity.eu/examples/) (#130).

## Content specifications

A **content specification** is layer 1 of the [addressing model](../README.md#terminology):
the set of data elements a passport for one product group carries. Its id is reissued only
when its shape changes or when a meaning it references changes. Layer 2 is the dictionary
release it pins, and layer 3 is the dictionary element id each membership points at.

| File | Source | Status |
|---|---|---|
| [`content-specifications/dpp-steel-v0.0.2.lock.json`](content-specifications/dpp-steel-v0.0.2.lock.json) | [material-identity/schema](https://github.com/material-identity/schema) `dpp/v0.0.2/specifications/steel.lock.json` at commit [`eb99ea2`](https://github.com/material-identity/schema/commit/eb99ea20cd0670d5b070aa7830653c4955b1c8b9) (merge of [material-identity/schema#380](https://github.com/material-identity/schema/pull/380)) | **published** in material-identity/schema `main`, DPP v0.0.2 |

The copy is byte-identical to its source:
SHA-256 `b94be652ae86178d1d371a9df5d1bfc3cba3b86afcd1b8f8aa257ef4ac021a3f`. The specification
is maintained in material-identity/schema, not here. When the source changes, replace the file
with a fresh copy and update the commit and hash above. Never edit it in place.

### How it uses this dictionary

The specification pins one dictionary release (`"dictionary": { "release": "v2026.10.01" }`).
Each membership in `elements` (and the nested `elements` and `item` of a collection) refers to
one dictionary entry and adds the facts that belong to the specification, not to the concept:

| Field | Meaning |
|---|---|
| `dictionaryReference` | the entry, as `https://material-identity.eu/def/<uuid>` |
| `objectType` | the entry's object type, repeated so a consumer can shape the data without fetching the entry first |
| `isMandatory` | whether this specification requires the element |
| `accessCategory` | who may see the value (`public`, `legitimateInterest`, `authorityOnly`). This is informative: the legal act is normative and the passport interface enforces it |
| `granularity` | the level the value is stated at: `model`, `batch`, `item` or `operator` |
| `condition` | for an optional element, when it becomes mandatory, in `en` and `de` |

Mandatoriness and access belong to the membership, never to the entry: the same entry can be
mandatory and public in one specification and optional or restricted in another. A test
(`test/examples.test.ts`, part of `npm test` and so of `pr-checks`) fails when any `dictionaryReference` in
`content-specifications/*.json` does not resolve to a file under `published/`.

## Licence

The example keeps **its own licence**: CC-BY-4.0, the data licence of material-identity/schema
(stated in the file's own `$comment`). The dictionary's CC0 1.0 dedication does **not** cover
it. If you reuse it, attribute material-identity/schema.
