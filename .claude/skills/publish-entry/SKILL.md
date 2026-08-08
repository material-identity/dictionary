---
name: publish-entry
description: Mint a UUID, move a draft to published/, and open the publish PR — including supersessions
---

# publish-entry

Moves one (or a self-consistent batch of) `drafts/*.yaml` to `published/` and opens the PR
that closes the source request. This is where the two-yes gate (check 7), move purity
(check 6), and pinning (check 5) all apply — the PR is the reviewable unit, not the individual
file. Preceded by [new-entry](../new-entry/SKILL.md). There is no separate "supersede" skill:
publishing an entry whose draft already has `replaces` set *is* superseding — nothing else
changes about the flow.

## Preconditions

- Every draft being published passed `npm run validate` (check 2) on its own.
- Every dependency the draft references via `unit`/`quantityKind`/`itemType`/enumeration
  members/`elements[].dictionaryReference`/`replaces` is either already in `published/` on
  `main`, or is itself part of this same batch (checks 4 and 5 evaluate the working tree, so a
  self-consistent batch in one PR is fine — plan §2.3).
- If the draft has `replaces` set: the target is an existing published entry, and nothing else
  already replaces it (check 4 — at most one entry may replace a given entry, or "current"
  becomes ambiguous).
- The source `dictionary-request` issue(s) still carry `state:accepted` (or `state:drafting`).

## Steps

1. **Create a branch.**

2. **Mint.** For each draft: `npx tsx scripts/mint.ts drafts/<shortName>.yaml` — this rewrites
   only the `id` line to `https://material-identity.eu/def/<new-uuid>` and writes
   `published/<uuid>.yaml`. Nothing else in the file changes; that is the property check 6
   verifies. If the draft carries `replaces`, it moves across unchanged — no update needed
   anywhere else. There is no concept file to create or edit.

3. **Remove the draft.** `git rm drafts/<shortName>.yaml`. The pair (deleted draft, added
   published file) is what check 6 pairs up and deep-equals apart from `id`.

4. **Run `npm run validate` and `npm test` locally** before pushing — checks 1 and 6 need a
   git base, so run `npm run validate -- --base main` from the branch to see what CI will see.

5. **Commit and push**, then open the PR with `Closes #<n>` for every accepted
   `dictionary-request` issue this batch satisfies. The two-yes gate (check 7) fails the PR
   if none of the closed issues carry `type:dictionary-request` + `state:accepted` — this is
   deliberate; it is Yes #1 made mechanical.

6. **Wait for CODEOWNERS review (Yes #2).** GitHub structurally forbids self-approval, so the
   reviewer is never the author — do not attempt to route around this.

7. **On merge**, `issue-state.yml` moves the linked issue(s) to `state:published` and closes
   them automatically. `deploy.yml` builds and ships the site. The superseded entry (if any)
   keeps resolving forever, byte-identical to its own publication; the build derives "who
   supersedes whom" from `replaces` at render time — nothing about the old entry needed
   touching.

## Publishing a batch instead of one entry

When several drafts form one dependency-ordered cluster (e.g., a quantity, its units, and an
element that references one of those units), publish them together in a single PR rather than
one PR per file. Pinning and the replaces-fork check are evaluated against the PR's working
tree, so an internally consistent batch is exactly as valid as N sequential PRs — and avoids
the ordering problem of a later PR needing an earlier one merged first just to pass check 5.
