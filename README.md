# material-identity dictionary

Public data dictionary for EN 18xxx digital product passports. Every entry is one immutable
fact at `https://material-identity.eu/def/<uuid>` — JSON for machines, HTML for humans, same
URI. Source of truth is this repository: YAML under `published/` (add-only, forever), built
into a static site and served through a thin Cloudflare Worker doing content negotiation.

There is no versioning and no status field anywhere. An entry is either current or it has
been superseded by a newer entry that names it via `replaces` — that link is the entire
lifecycle model. "Current" and "superseded" are never stored; they're derived at build time
by scanning for whichever entry (if any) replaces a given one, and shown only as presentation
(a banner, an index filter) — never written back into any file.

Content license: CC0 1.0. Agent contract: [CLAUDE.md](CLAUDE.md). Reviewer contract:
[REVIEW.md](REVIEW.md).

## Local commands

Node 24 (`.nvmrc`), then:

```sh
npm ci              # install (exact-pinned; wires the pre-push hook)
npm run validate    # checks 1–6: immutability, schema, identity, replaces integrity,
                    #             pinning, move purity
npm test            # node:test suite; the run fails below 85% line coverage
npm run build       # YAML → site/ (canonical JSON + HTML per entry, paginated index)
```

`validate` and `build` accept `-- --root <dir>` to run against a fixture tree;
`validate` accepts `-- --base <ref>` for the diff-based checks (default `main`).

## Local preview

```sh
npm run build
npx serve site/
```

Then open e.g. `http://localhost:3000/def/<uuid>.html`. In production the Worker serves
the same files on the extension-free canonical URI with content negotiation; the `.json` /
`.html` origin files stay directly reachable for debugging but are never published as
references.

## Requesting a new entry

Open a [dictionary request](../../issues/new?template=dictionary-request.yml) — the form
mirrors the entry envelope (`shortName`, `objectType`, `preferredName`, `definition`, and
whatever optional fields apply). A maintainer triages it (**Yes #1**); everything after that
is the author workflow below.

## Author workflow: draft → publish → release

Every step is a documented, executable procedure under [`.claude/skills/`](.claude/skills/) —
not tribal knowledge. A contributor (human or agent) with no other context can follow this
end to end.

1. **Draft** ([`new-entry`](.claude/skills/new-entry/SKILL.md)) — from an accepted request,
   author `drafts/<shortName>.yaml`: the full envelope per
   [`schema/dictionary-entry.schema.json`](schema/dictionary-entry.schema.json), `id` a
   placeholder, everything else — including `replaces`, if this supersedes something —
   already final. Nothing here is promised to anyone; `npm run validate` should be green.
2. **Publish** ([`publish-entry`](.claude/skills/publish-entry/SKILL.md)) — mint the UUID
   (`scripts/mint.ts`, which rewrites only the draft's `id:` line), move it to
   `published/<uuid>.yaml`, and open a PR with `Closes #<n>` for the request. There is no
   separate "supersede" step and no concept file to update — if the draft has `replaces` set,
   publishing it *is* the supersession. CI enforces the whole integrity chain: schema,
   identity, replaces integrity (resolves, no forks), pinning, immutability, move purity, and
   the two-yes gate (the PR must close an issue labeled `type:dictionary-request` +
   `state:accepted` — **Yes #1**, made mechanical). Merge requires a CODEOWNERS approval from
   someone who is never the author (**Yes #2** — GitHub structurally forbids self-approval).
   The superseded entry (if any) keeps resolving forever, byte-identical to its own
   publication — nothing about it needed touching.
3. **Release** (M6) — a GPG-signed tag (`git tag -s vYYYY.MM.DD`) on `main`, with a GitHub
   Release carrying the generated changelog, the full dictionary tarball
   (`published/` + `schema/`), and the CycloneDX SBOM.

## Definition of done

> A passport can carry `https://material-identity.eu/def/<uuid>` as `dictionaryReference`; a
> `curl` with `Accept: application/json` returns the schema-valid entry with
> `Cache-Control: immutable`; the same URI in a browser shows the human page — and no process
> exists by which the JSON response can ever change.

*(Project-Plan-and-Architecture.md §8, verbatim.)*
