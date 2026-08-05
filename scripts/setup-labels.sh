#!/usr/bin/env bash
# One-time M0 bootstrap: seed the label taxonomy (plan §4 M0 item 2, §5.1–§5.2).
# Idempotent: --force updates color/description if the label already exists.
# Usage: ./scripts/setup-labels.sh [owner/repo]   (defaults to the current repo)
set -euo pipefail

REPO_FLAG=()
if [[ $# -ge 1 ]]; then REPO_FLAG=(--repo "$1"); fi

label() { gh label create "$1" --color "$2" --description "$3" --force "${REPO_FLAG[@]}"; }

# type:* — one taxonomy across project work items and content requests (plan §5.1)
label "type:bug"                "d73a4a" "Wrong behavior of validator, build, Worker, or site"
label "type:feature"            "1d76db" "New capability"
label "type:enhancement"        "a2eeef" "Improvement of an existing capability"
label "type:chore"              "fef2c0" "Deps, CI, docs, housekeeping"
label "type:dictionary-request" "5319e7" "Request to create or version a dictionary entry"

# state:* — label-backed state machine for dictionary requests (plan §5.2)
label "state:proposed"   "ededed" "New request, untriaged (set by the issue form)"
label "state:needs-info" "fbca04" "Maintainer questions open; loops back to proposed"
label "state:accepted"   "0e8a16" "Yes #1 — maintainer accepted the concept for the dictionary"
label "state:drafting"   "c2e0c6" "Draft YAML being authored under drafts/"
label "state:in-review"  "1d76db" "Publish PR open and linked (Closes #N)"
label "state:published"  "006b75" "PR merged, entry live; issue closed as completed"
label "state:rejected"   "d93f0b" "Declined with reason; closed as not planned"
label "state:withdrawn"  "cfd3d7" "Requester retracted"

# size:* — work-item estimates (plan §4 M0 item 2)
label "size:S" "76d7c4" "Small — hours"
label "size:M" "f9e79f" "Medium — about a day"
label "size:L" "f1948a" "Large — multiple days"

echo "Labels seeded."
