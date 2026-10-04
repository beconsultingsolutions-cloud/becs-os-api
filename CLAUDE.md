# becs-os-api

Central backend API for the owner's business ecosystem (BECS OS). Cloudflare Worker (`src/index.ts`) + D1 + KV.
Docs: `README.md` (endpoints, auth, scopes, rate limit). Schema: `schema.sql`. Config: `wrangler.jsonc`.

## About the user
- New to servers. Before running any command, explain it in one plain sentence.
- Keep answers short and step-based.

## Working rules
- Every task must drive revenue, build systems, grow brand, or reduce workload.
- Plan first, then wait for the user's OK before touching anything live (deploy, secrets, remote DB writes, KV writes). Read-only checks are fine.
- Never print, generate, or store the API key or any token (master `API_KEY`, app keys, Cloudflare tokens). The user pastes secrets themselves, e.g. via `npx wrangler secret put API_KEY` typed by them (suggest `! <command>`).

## Cloudflare resources (already created)
- D1 database `becs-os-core` (binding `DB`). Tables: ventures, clients, projects, tasks, activity_log.
  Ventures seeded: becs, leaa, blnks, me-and-them, 4freq, be-university, tethr.
- KV namespace `becs-os-config` (binding `CONFIG`). Holds hashed app keys and rate-limit counters.
- Both are wired into `wrangler.jsonc`.

## Status
- Verified 2026-10-02: D1 tables all exist remotely; Worker `becs-os-api` is deployed (latest deployment 2026-10-02 13:35 UTC); `API_KEY` secret is set.
- Not yet verified: that `GET /health` responds on the live workers.dev URL, and that the latest deployed code matches `src/index.ts`.
- Next: test `/health`, then create per-app keys (see README) so apps never hold the master key.

## Frontend
- `public/index.html`: single-file read-only dashboard (Today, Ventures, Pipeline, Projects), served by this Worker via `assets` in `wrangler.jsonc`. Built and DEPLOYED 2026-10-03 (version c83f8d50). Home page returns 200; unauthenticated API calls return 401. Not yet tested with a real app key.
- User types a read-only app key into its login box (kept in sessionStorage only). Needs scopes: tasks, clients, ventures, projects `:read`. Never embed a key in the page.
- Live URL: https://becs-os-api.be-consulting-solutions.workers.dev
- Cloudflare Access was blocking everything; user removed it. `/health` verified 200 on 2026-10-03.
## Gotchas
- Run wrangler from this folder only. `C:\Users\belli\wrangler.jsonc` is a different Worker ("belli") that serves the whole Downloads folder as public assets. Never deploy from the home folder.
- Local dev needs a git-ignored `.dev.vars` with a throwaway key.
