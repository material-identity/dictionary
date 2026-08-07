---
name: publish-entry
description: Mint a UUID, move a draft to published/, update its concept file, and open the publish PR
---

# publish-entry

Moves one (or a self-consistent batch of) `drafts/*.yaml` to `published/`, updates the
concept resource(s), and opens the PR that closes the source request. This is where the
two-yes gate (check 8), move purity (check 7), and pinning (check 5) all apply — the PR
is the reviewable unit, not the individual file. Preceded by
[new-entry](../new-entry/SKILL.md); paired with [supersede-entry](../supersede-entry/SKILL.md)
for later versions of an already-published concept.

## Preconditions

- Every draft being published passed `npm run validate` (check 2) on its own.
- Every dependency the draft references via `unit`/`quantityKind`/`itemType`/enumeration
  members/`elements[].dictionaryReference` is either already in `published/` on `main`, or is
  itself part of this same batch (check 5 evaluates the working tree, so a self-consistent
  batch in one PR is fine — plan §2.3).
- The source `dictionary-request` issue(s) still carry `state:accepted` (or `state:drafting`).

## Steps

1. **Create a branch.**

2. **Mint.** For each draft: `npx tsx scripts/mint.ts drafts/<shortName>.yaml` — this rewrites
   only the `id` line to `https://material-identity.eu/def/<new-uuid>` and writes
   `published/<uuid>.yaml`. Nothing else in the file changes; that is the property check 7 verifies.

3. **Remove the draft.** `git rm drafts/<shortName>.yaml`. The pair (deleted draft, added
   published file) is what check 7 pairs up and deep-equals apart from `id`.

4. **Update the concept file.**
   - **New concept:** create `concepts/<concept-uuid>.yaml` (the UUID already chosen in
     `isVersionOf` during drafting) with `objectType: Concept`, `preferredName`,
     `currentVersion` pointing at the new entry's `id`, and `versions: [{ entry, version: "1",
     status: active }]`.
   - **New version of an existing concept:** see [supersede-entry](../supersede-entry/SKILL.md)
     instead — publishing a new version always pairs with a forward status transition on the
     predecessor, which is out of this skill's scope.

5. **Stage everything as one PR-worthy change**: the deleted draft(s), the added published
   file(s), the new or updated concept file(s).

6. **Run `npm run validate` and `npm test` locally** before pushing — check 1/6/7 need a git
   base, so run `npm run validate -- --base main` from the branch to see what CI will see.

7. **Commit and push**, then open the PR with `Closes #<n>` for every accepted
   `dictionary-request` issue this batch satisfies. The two-yes gate (check 8) fails the PR
   if none of the closed issues carry `type:dictionary-request` + `state:accepted` — this is
   deliberate; it is Yes #1 made mechanical.

8. **Wait for CODEOWNERS review (Yes #2).** GitHub structurally forbids self-approval, so the
   reviewer is never the author — do not attempt to route around this.

9. **On merge**, `issue-state.yml` moves the linked issue(s) to `state:published` and closes
   them automatically. `deploy.yml` builds and ships the site.

## Publishing a batch instead of one entry

When several drafts form one dependency-ordered cluster (e.g., a quantity, its units, and an
element that references one of those units), publish them together in a single PR rather than
one PR per file. Pinning is checked against the PR's working tree, so an internally consistent
batch is exactly as valid as N sequential PRs — and avoids the ordering problem of a later PR
needing an earlier one merged first just to pass check 5.
