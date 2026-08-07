# material-identity dictionary

Public data dictionary for EN 18xxx digital product passports. Every entry is one immutable
concept version at `https://material-identity.eu/def/<uuid>` — JSON for machines, HTML for
humans, same URI. Source of truth is this repository: YAML under `published/` (add-only)
and `concepts/` (append-only lifecycle), built into a static site and served through a
thin Cloudflare Worker doing content negotiation.

Content license: CC0 1.0. Agent contract: [CLAUDE.md](CLAUDE.md). Reviewer contract:
[REVIEW.md](REVIEW.md).

## Local commands

Node 24 (`.nvmrc`), then:

```sh
npm ci              # install (exact-pinned; wires the pre-push hook)
npm run validate    # checks 1–7: immutability, schema, identity, version chain,
                    #             pinning, concept consistency, move purity
npm test            # node:test suite; the run fails below 85% line coverage
npm run build       # YAML → site/ (canonical JSON + HTML per entry and concept)
```

`validate` and `build` accept `-- --root <dir>` to run against a fixture tree;
`validate` accepts `-- --base <ref>` for the diff-based checks (default `main`).

## Local preview

```sh
npm run build
npx serve site/
```

Then open e.g. `http://localhost:3000/def/<uuid>.html`. In production the Worker serves
the same files on extension-free canonical URIs with content negotiation; the `.json` /
`.html` origin files stay directly reachable for debugging but are never published as
references.

## How content gets published

Requests enter as [dictionary-request issues](../../issues/new/choose), walk a label-backed
state machine (`proposed → accepted → drafting → in-review → published`), and land via
publish PRs gated by CI (schema, pinning, immutability, the two-yes principle) and
code-owner review. The full author workflow (draft → publish → supersede → release) is
documented as part of the first release (M6).
