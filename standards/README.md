# standards/ — local-only reference library

**Never commit anything in this directory except this README.**

The documents listed below are licensed CEN standards and committee-internal CEN/TC 261/WG 4
working documents. They must never appear in the public repository, its git history, or the
issue tracker — a leaked PDF would force a history rewrite, which is poison for the
auditability posture of this project (plan §6). The `.gitignore` rules
(`standards/*` + `!standards/README.md`) enforce this structurally; reviewer attention is
required on any PR touching `.gitignore`.

Licensed copies are placed here manually by the maintainer (manual checklist item 10).
This README is the manifest of what belongs here.

## Expected documents

### EN standards (licensed, via CEN/national body)

| File | Document |
|---|---|
| `EN-18216.pdf` | EN 18216 |
| `EN-18219.pdf` | EN 18219 |
| `EN-18220.pdf` | EN 18220 |
| `EN-18221.pdf` | EN 18221 |
| `EN-18222.pdf` | EN 18222 |
| `EN-18223.pdf` | EN 18223 |
| `FprEN-18239.pdf` | FprEN 18239 |
| `FprEN-18246.pdf` | FprEN 18246 |

### WG 4 N-documents (committee-internal)

| File | Document |
|---|---|
| `N1327.pdf` | N1327 |
| `N1328.pdf` | N1328 |
| `N1337.pdf` | N1337 |
| `N1339.pdf` | N1339 |
| `N1340.pdf` | N1340 |
| `N1342.pdf` | N1342 |
| `N1343.pdf` | N1343 |
| `N1355-V1.4.pdf` | N1355 V1.4 |

## Naming convention

`<designation>.pdf`, designation with hyphens instead of spaces; N-documents keep their
number, with the version suffix where one exists (e.g. `N1355-V1.4.pdf`). Revisions replace
the file locally — there is no history here, deliberately.
