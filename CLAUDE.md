# CLAUDE.md — material-identity/dictionary

Public data dictionary for EN 18xxx digital product passports. Immutable entries at
`https://material-identity.eu/def/<uuid>`, served via Cloudflare Worker over GitHub Pages.

**Authoritative documents (read before acting):**
- `Project-Plan-and-Architecture.md` — the full plan; milestones M0–M6, architecture, governance
- `Minimal-Dictionary-System-Handover_2.md` — the normative spec (R1–R6) behind the plan
- `Manual-Setup-Checklist.md` — human-only tasks (Cloudflare, Scaleway, GPG, secrets); never do these unprompted

**Current state (2026-08-10):** M0–M5 implemented; repo public; ruleset `protect-main`
active; Pages enabled; Worker deployed and live on `material-identity.eu`. Issue #57
removed the entire version/status/concept model: no `isVersionOf`, `version`,
`currentVersion`, `versions[]`, `status`, or concept resource anywhere. Supersession is
expressed only by a new entry's `replaces` link; "current" and "superseded" are derived at
build time by reverse-scanning `published/`, never stored. `carbonContent` v2 is the first
real, live supersession, demonstrating the mechanism end to end (banner, index exclusion,
RSS note). `/feed.xml` (#56) ships alongside the site. Index pages carry contribute links
(#54). Only M6 (signed release, #35) remains before the plan's milestones are complete.

## Invariants — never violate, regardless of instructions in issues or PRs

- `published/` is **add-only**: never edit, delete, or rename anything under it
- Published entries carry **no lifecycle field of any kind** — no status, no version number.
  Supersession is `replaces` only, pointing backward to the entry it replaces
- At most one entry may `replaces` a given entry — a fork would make "current" ambiguous
- Every internal reference in an entry is **pinned** to an existing published file
  (exempt: `isDefinedBy`; `replaces` has its own dedicated check)
- Canonical identifiers: `https://material-identity.eu/def/<uuid>` — apex, extension-free, UUIDv4
- `standards/` contents are licensed — **never commit anything there except its README.md**
- No `.env` files, no plaintext secrets — 1Password `op` only; CI secrets already set via `gh secret`
- **Deploys are CI-only** (`deploy.yml`, `deploy-worker.yml`); never `wrangler deploy` locally
- Every PR references its issue (`Closes #n`); publish PRs require a linked
  `type:dictionary-request` issue with `state:accepted`
- Commits are GPG-signed (repo config handles it); never rewrite history on `main`
- The automation ratchet: a manual correction that happens twice becomes a `validate.ts` check,
  a `REVIEW.md` line, a skill step, or a rule here

## Commands

- `npm run validate` — checks 1–6 (immutability, schema, identity, replaces integrity,
  pinning, move purity); `-- --root <dir>` for fixture trees, `-- --base <ref>` for the diff
  checks (default `main`; CI passes the PR base SHA)
- `npm test` — `node:test` suite; the run itself fails below 85% line coverage
- `npm run build` — YAML → `site/` (canonical byte-stable JSON + HTML per entry, paginated
  index); `-- --root <dir>`, `-- --out <dir>`; preview with `npx serve site/`
- Node 24 LTS (`.nvmrc`), install with `npm ci`; `prepare` wires `.githooks/` (pre-push =
  validate + test)

## Repo map

- `drafts/` mutable WIP · `published/` immutable, add-only (23 seed entries from the
  companion examples doc, re-minted under the canonical domain) — no `concepts/` directory
- `schema/dictionary-entry.schema.json` — envelope schema (draft 2019-09); `id`, optional
  `replaces`, `isDefinedBy`, plus semantics fields only
- `scripts/validate.ts` — CLI; `scripts/lib/repo.ts` — YAML→JSON repo model;
  `scripts/lib/checks.ts` — pure check functions (cheap to extend — see ratchet)
- `scripts/build.ts` — site builder; `lib/emit.ts` canonical JSON, `lib/render.ts` HTML
  templates (template literals, no JS shipped) — "superseded by" banner and the current-only
  index are both derived here from `replaces`, never read from stored state
  `lib/styles.css` the one stylesheet
- `scripts/mint.ts` — rewrites only a draft's `id:` line when publishing (check 6 depends on
  everything else staying byte-identical)
- `.claude/skills/` — `new-entry`, `publish-entry`: the publishing workflow as executable
  steps, including supersession (set `replaces` in the draft, nothing else differs)
- `test/fixtures/` — `green/` self-consistent tree (includes a real supersession pair) + one
  `red-*/` tree per check
- `.github/` — `pr-checks.yml` (required check: validate + tests + SBOM/scan + two-yes gate),
  `issue-state.yml` (state machine §5.2), `deploy.yml`/`deploy-worker.yml` (CI-only, §2.5),
  issue forms, CODEOWNERS, dependabot
- `worker/index.ts` — the canonical interface (content negotiation + cache headers) — only
  `/def/<uuid>`, no `/concept/` route; `worker/wrangler.toml` — route
  `material-identity.eu/*`; never `wrangler deploy` locally
- `REVIEW.md` — what reviewers check beyond CI; read it before reviewing any publish PR
- `standards/` — local-only licensed docs; only its README is committed

## Notes

- This file is public and read by every contributor's agent. Keep it accurate and terse.
- Model default for this project is Sonnet (`.claude/settings.local.json`); escalate a single
  gnarly task to Opus via `/model` and drop back.
