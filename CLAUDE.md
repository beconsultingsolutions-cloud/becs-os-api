# becs-os-api

BECS OS: one central store for the owner's clients, projects and tasks across all ventures.
Cloudflare Worker (`src/`) + D1 (`becs-os-core`) + KV (`becs-os-config`), serving the console (`public/index.html`) at `/` and the API under `/api`.

**`docs/SPEC.md` is the contract.** Read it before changing the server or the console, and change it in the same sitting as the code. `README.md` has the commands.

## About the user
- New to servers. Before running any command, explain it in one plain sentence.
- Keep answers short and step-based.

## Working rules
- Every task must drive revenue, build systems, grow brand, or reduce workload.
- Plan first, then wait for the user's OK before touching anything live (deploy, secrets, remote DB writes, KV writes). Read-only checks are fine.
- Never print, generate, or store the API key or any token (master `API_KEY`, app keys, Cloudflare tokens). The user pastes secrets themselves, e.g. `! npx wrangler secret put API_KEY`, or creates app keys on the console's Keys screen.
  - One exception: `node scripts/live-check.mjs` makes a temporary app key in memory (never printed, expires in 10 minutes, revoked at the end) to test the live server.
- Run `npm test` before every deploy. If you change behavior, add or update a test and `docs/SPEC.md`.
- Database changes go in a new numbered file in `migrations/`, never by hand on the live database. Order: back up, `npm run db:migrate:remote`, then `npm run deploy`.
- The console must only ever insert API data as text (its `h()` helper). Never `innerHTML` with API data: notes are written by apps and AI agents.

## Layout
- `src/index.ts` routing, auth, table endpoints. `src/tables.ts` field rules. `src/access.ts` Cloudflare Access token check.
- `public/` the console, its fonts and `_headers`. One file, no build step.
- `migrations/` database shape. `test/` Vitest suite running in workerd. `scripts/live-check.mjs` live health check.

## Cloudflare resources
- Worker `becs-os-api`: https://becs-os-api.be-consulting-solutions.workers.dev
- D1 `becs-os-core` (binding `DB`): ventures, clients, projects, tasks, activity_log, plus `payments` and `portal_links` (reserved for Square status and the client portal; nothing uses them yet).
  Ventures: becs (1), leaa (2), blnks (3), me-and-them (4), 4freq (5), be-university (6), tethr (7).
- KV `becs-os-config` (binding `CONFIG`): hashed app keys only.
- Rate limiter binding `APP_LIMITER`: 60 requests per minute per app key.
- Secret `API_KEY`: the master key. The owner has it in a password manager.

## Status (2026-10-04 revamp)
- Server rewritten to the spec, console rebuilt with the BECS brand, 800+ tests, security review done and its findings fixed.
- Cloudflare Access sign-in is built but NOT switched on: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_ALLOWED_EMAILS` in `wrangler.jsonc` are empty. Steps are in README "Turning on Cloudflare Access". Until then the console uses its key box.
- The owner's Notion clients and tasks have not been imported yet.
- Pre-revamp database backup: `C:\Users\belli\Documents\becs-os-backups\` (not in git; contains client names).

## Gotchas
- Run wrangler from this folder only.
- Access must be TWO applications: the site (Allow, owner's email) and `<host>/api` (Bypass). One application over everything sends key callers to a login page; that is what broke it before.
- Local dev needs a git-ignored `.dev.vars` (copy `.dev.vars.example`).
- The test plugin version (`@cloudflare/vitest-plugin`) is pinned to match wrangler. Upgrade the two together.
