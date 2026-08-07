---
name: supersede-entry
description: Publish a new version of an existing concept with a forward-only concept status transition
---

# supersede-entry

Publishes version N+1 of an already-published concept. `published/` is never touched for the
old version — supersession is announced only in the new version's `replaces` link and in the
concept resource's `versions[]` (handover §5.3, plan §2.3). Builds on
[new-entry](../new-entry/SKILL.md) for drafting the new version and shares mechanics with
[publish-entry](../publish-entry/SKILL.md), but the concept update differs: this is a status
**transition**, not a first append.

## Preconditions

- The concept being superseded already has a published, `active` version on `main`.
- A `dictionary-request` issue for the new version exists and carries `state:accepted` — a
  content revision is still a request that needs Yes #1, same as a brand-new concept.
- The transition you are about to make is forward-only: `active → deprecated` or
  `active → tombstoned`. Never move a record backward — check 6 rejects it, and the reviewer
  should reject it before check 6 ever runs.

## Steps

1. **Draft the new version** via [new-entry](../new-entry/SKILL.md), with two differences from
   a fresh concept:
   - `isVersionOf` is the **existing** concept's URI (do not mint a new concept UUID).
   - `version` is the next integer after the concept's highest existing version.
   - `replaces` is set to the predecessor's `id` — the current `currentVersion` in the concept
     file. This is the only entry-level trace of supersession; it is set once, at publication,
     and never edited afterward.

2. **Mint and move** exactly as in [publish-entry](../publish-entry/SKILL.md) steps 2–3.

3. **Update the concept file as a transition, not a fresh append:**
   - Append a new record to `versions[]` for the new entry: `{ entry: <new id>, version:
     "<N+1>", status: active }`.
   - Edit the **predecessor's existing record** (never remove it — check 6 requires every
     record to survive): set its `status` forward to `deprecated` or `tombstoned`. If
     `tombstoned`, it **must** also carry `replacedBy: <new id>` and `deprecatedOn: <date>`
     (schema + check 6 both require this).
   - Move `currentVersion` to the new entry's `id`.
   - Every other record already in `versions[]` (older tombstoned/deprecated history) is left
     completely untouched.

4. **Validate the transition direction before committing:** re-read the concept file's base
   version (`git show main:concepts/<uuid>.yaml`) and confirm no existing record's status rank
   decreased (`active < deprecated < tombstoned`) and no record disappeared. This is exactly
   what check 6's append-only rules verify in CI — catching it locally saves a red PR.

5. **Commit, push, open the PR** with `Closes #<n>` for the new version's accepted request.
   The two-yes gate applies here too: this PR adds a file under `published/`.

6. **CODEOWNERS review, merge, deploy** — same as [publish-entry](../publish-entry/SKILL.md).
   After merge, the predecessor's page shows the "superseded by" banner (sourced from the
   concept resource, per `build.ts`) without a single byte of the predecessor's published file
   having changed.
