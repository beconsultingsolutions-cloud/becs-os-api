# becs-os-api

BECS OS: one central store for clients, projects and tasks across all ventures.
A Cloudflare Worker with a D1 database (`becs-os-core`) and a KV namespace (`CONFIG`, for app keys).

- The **console** is `public/index.html`, served at `/`.
- The **API** is everything under `/api`.
- The full contract (every route, rule and error code) is **`docs/SPEC.md`**. This README is the short version.

Live: `https://becs-os-api.be-consulting-solutions.workers.dev`

## Files

| Path | What it is |
|---|---|
| `src/index.ts` | Routing, sign-in checks, the table endpoints |
| `src/tables.ts` | The four tables and their validation rules |
| `src/access.ts` | Cloudflare Access sign-in token check |
| `migrations/` | Database changes, applied in number order |
| `public/` | The console (static files) |
| `wrangler.jsonc` | Cloudflare config: database, KV, rate limit, vars |
| `make-key.ps1` / `make-key.bat` | Creates a read-only app key and copies it to your clipboard |

## Who can call it

| Caller | How | Can do |
|---|---|---|
| You, in the console | Cloudflare Access sign-in (once switched on, see below) | Everything |
| You, from a terminal | Master key: `Authorization: Bearer <API_KEY>` | Everything |
| An app or AI assistant | App key: `Authorization: Bearer <key>` | Only its scopes. 60 requests per minute. |

Scopes: `ventures:read`, `ventures:write`, `clients:read`, `clients:write`, `projects:read`, `projects:write`,
`tasks:read`, `tasks:write`, `activity:read`. `read` allows GET; `write` allows POST, PATCH and DELETE.
The dashboard needs `tasks:read`, `clients:read`, `projects:read` and `ventures:read`.
`activity:read` only shows the activity of tables the key can also read (a key with `activity:read` and
`tasks:read` sees task activity only; with no `:read` table scopes it sees an empty list).
App keys can never manage keys.
Money (`value_cents`) is capped at 100000000000 cents ($1 billion). Request bodies over 64 KB are refused (`413`).

## Examples

Set these once in your terminal (Git Bash). Use your own key; never paste it into files.

```bash
API=https://becs-os-api.be-consulting-solutions.workers.dev/api
KEY=...your master key...
```

```bash
curl $API/health                                        # no key needed
curl $API/me -H "Authorization: Bearer $KEY"            # who am I
curl $API/dashboard -H "Authorization: Bearer $KEY"
curl "$API/dashboard?venture_id=1" -H "Authorization: Bearer $KEY"

# List (filter by any column you can write; newest first; ?limit=1..500)
curl "$API/tasks?status=todo&venture_id=1" -H "Authorization: Bearer $KEY"

# Create
curl -X POST $API/tasks -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"venture_id":1,"title":"Send the service agreement","priority":1,"filter_tag":"revenue","due_date":"2026-10-10"}'

# Update part of a row (marking a task done stamps completed_at for you)
curl -X PATCH $API/tasks/12 -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d '{"status":"done"}'

# Delete (refused with 409 if other rows still point at it)
curl -X DELETE $API/tasks/12 -H "Authorization: Bearer $KEY"

# Who changed what
curl "$API/activity?entity_type=tasks&entity_id=12" -H "Authorization: Bearer $KEY"
```

Tables: `ventures`, `clients`, `projects`, `tasks`. Answers look like `{"data": ...}`.
Errors look like `{"error": "invalid", "message": "...", "fields": {"title": "is required"}}`.

### App keys

```bash
# Create one. The key is shown ONCE; only its hash is stored. Save it straight away.
curl -X POST $API/admin/keys -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"app":"leaa-portal","scopes":["tasks:read","clients:read"]}'

curl $API/admin/keys -H "Authorization: Bearer $KEY"                        # list (never shows keys)
curl -X DELETE $API/admin/keys/leaa-portal -H "Authorization: Bearer $KEY"  # revoke every key for that app
```

`app` is 2 to 63 characters: lowercase letters, digits and hyphens. KV is cached at the edge,
so a revoked key can keep working for up to about a minute.
On Windows you can also double-click `make-key.bat` (asks for the master key, puts the new key on your clipboard).

The rate limit (60 requests per 60 seconds per app key) uses Cloudflare's Rate Limiting binding `APP_LIMITER`.
It is counted per Cloudflare location, so it is a guard rail, not an exact count.
If the limiter is ever unavailable, requests are let through rather than blocked.

## Run it on your computer

1. `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and put any made-up key in it (never the real one).
3. Build the local database: `npx wrangler d1 migrations apply becs-os-core --local`
4. Start it: `npx wrangler dev --port 8791`
5. Open http://localhost:8791 or call `http://localhost:8791/api/...` with your made-up key.

Check the code compiles: `npx tsc --noEmit`.

## Tests

`npm test` runs every automated test once, on your computer, inside the same Workers runtime Cloudflare uses, with a throwaway local database, KV and rate limiter (it never touches the live site or data).
Before each test the database is wiped and rebuilt from `migrations/`, so tests cannot affect each other. The run ends with a pass/fail count and fails if any test fails.
The tests live in `test/` and their names read as plain sentences. `npm run test:watch` re-runs them as you edit, and `npm run typecheck:test` checks the test code compiles.

## Database migrations

Schema changes are numbered `.sql` files in `migrations/`. Wrangler records which ones have run
(in a `d1_migrations` table) and only runs new ones.

```bash
npx wrangler d1 migrations list  becs-os-core --remote   # what has not run yet on the live database
npx wrangler d1 migrations apply becs-os-core --local    # your computer
npx wrangler d1 migrations apply becs-os-core --remote   # the live database
```

To change the schema, add a new file (`0003_something.sql`); never edit one that has already run.
`0001_baseline.sql` only describes what was already live, so it changes nothing there except recording itself.

## Deploy

Run the migrations **before** deploying new code that needs them (the current code writes the
`activity_log.actor` column added by `0002`).

```bash
npx wrangler d1 migrations apply becs-os-core --remote
npx wrangler deploy
```

The master key is a Worker secret. To set or change it: `npx wrangler secret put API_KEY` (type it yourself).

## Turning on Cloudflare Access

Access puts a sign-in page (email code or Google) in front of the console, so you can use it without pasting a key.
It is off until ALL THREE of these vars in `wrangler.jsonc` are filled in:

| Var | What to put | Where to find it |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | Your team domain, e.g. `myteam.cloudflareaccess.com`. Must end in `.cloudflareaccess.com`, or sign-in stays refused. | Zero Trust dashboard, Settings, Custom Pages (team domain) |
| `ACCESS_AUD` | The main application's "Application Audience (AUD) Tag" | Zero Trust, Access, Applications, your main app, Overview |
| `ACCESS_ALLOWED_EMAILS` | The email(s) allowed in, comma-separated, e.g. `me@example.com` (letter case and spaces do not matter) | You choose. Use the same email(s) as the Access policy. |

None is a secret. Steps:

1. **Main application (the console).** In Zero Trust, Access, Applications, add a **self-hosted application**
   for the Worker's hostname (e.g. `becs-os-api.be-consulting-solutions.workers.dev`), with no path.
   - Policy: **Allow**, include only your email.
   - Session duration: **24 hours or less**.
   - Cookie settings: **SameSite = Lax** and **HttpOnly** on.
   - Copy its AUD tag (Overview) for `ACCESS_AUD`.
2. **A second, separate application for the API.** Add another self-hosted application for the same hostname
   with the path **`/api`**, and give it one policy with the action **Bypass** (include: Everyone).
   This lets apps using keys reach `/api` without a login page; the Worker still checks every `/api` request itself.
   Do NOT add a Bypass policy to the main application: a Bypass there opens the whole site to everyone.
3. In `wrangler.jsonc`, put the three values into `vars`: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_ALLOWED_EMAILS`.
4. Redeploy so the Worker picks them up: `npx wrangler deploy`.
5. Open the site, sign in, and the console should show you as signed in (`GET /api/me` returns your email).

When Access is on, the Worker tries the sign-in token from the `Cf-Access-Jwt-Assertion` header and then each
`CF_Authorization` cookie (at most 4), and checks its signature, issuer, audience, expiry and email. An email that is
not on `ACCESS_ALLOWED_EMAILS` is refused even if Access let it through.
Changes made by a signed-in user must come from the site's own pages (the `Origin` header is checked).
Leave any of the three vars empty to switch Access sign-in off again; keys keep working either way.

Revoking an app key is not instant: KV is cached at the edge, so a revoked key can keep working for up to about a minute.
