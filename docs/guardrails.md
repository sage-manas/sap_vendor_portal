# Guardrails

What stops a class of defect from coming back, and where it lives. Each one is
derived from the real router, socket server or built app rather than from a
hand-kept list, so a route or room added tomorrow fails the build until someone
decides how it is handled.

| Class of defect | Guardrail | Runs in |
|---|---|---|
| A supplier reads another supplier's document by id | `backend/tests/supplier-scope-route-table.test.js`: every supplier-reachable `GET /:id` route needs a fixture, and a second supplier in the same tenant must get 404 | `npm test` (backend) |
| A write route that takes any body | `backend/tests/write-validation-route-table.test.js`: every POST/PUT/PATCH/DELETE has `validate()` with a schema that rejects unknown keys | backend |
| Unbounded list queries | `backend/tests/pagination-route-table.test.js`: every GET is paginated, hand-bounded or a named exception tracked in issue #186; each paginated route refuses an oversized `limit` | backend |
| A route with no permission check | `backend/tests/route-role-matrix.test.js`: every route has a permission or is on the reviewed public list | backend |
| A socket joining a room its plane may not see | `backend/tests/socket-room-planes.test.js`, `socket-auth.test.js`: real Socket.io server, asserts what a client receives | backend |
| Missing page security headers or CSP nonce | `scripts/check-security-headers.mjs` against the built app | `npm run check:headers` (frontend job) |
| Vulnerable dependency | `.github/workflows/audit.yml`, Dependabot | CI, weekly |
| Insecure code patterns | Semgrep (`p/javascript`, `p/typescript`, `p/nodejs`, `p/secrets`), CodeQL `security-extended` | `.github/workflows/security-scan.yml` |
| A committed secret | gitleaks over full history | `security-scan.yml` |

## Working with the scanners

- **Semgrep** fails on any finding. Silence a reviewed false positive on the
  line itself: `// nosemgrep: <rule-id> -- <reason>`. A suppression with no
  reason should not pass review.
- **gitleaks** reads `.gitleaksignore` (one fingerprint per line, with a comment
  saying why it is not a secret). A real secret is rotated first; ignoring it is
  never the fix.
- **CodeQL** results appear under the repository's Security tab. Enable code
  scanning there (Settings, Code security) if the alerts do not show up.
- Tests are excluded from Semgrep on purpose (they hold fixture passwords and
  tokens). They are not excluded from gitleaks.

## Adding a route

A new route will fail one or more of the tests above until it is accounted for:
give it a permission, a strict `validate()` schema if it writes, pagination if
it lists, and a scoping fixture if a supplier can reach it by id. Do not add it
to an exception set to make the test pass without a reason, and link an issue
when the exception is known-imperfect (see AGENTS.md).
