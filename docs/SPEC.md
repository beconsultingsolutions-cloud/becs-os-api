# BECS OS: the one spec

This file is the single source of truth for how the server and the console talk to each other.
If the code and this file disagree, one of them is a bug. Change both together.

## Purpose

One central store for all of the owner's ventures: clients, projects, tasks.
Three kinds of caller use it:

| Caller | How it proves who it is | What it can do |
|---|---|---|
| The owner, in the console | Cloudflare Access sign-in (email code or Google) | Everything |
| An app or AI assistant | An app key (`Authorization: Bearer <key>`) | Only the scopes the key was issued |
| The owner, from a terminal | The master key (`Authorization: Bearer <API_KEY>`) | Everything |

## URL layout

| Path | Served by | Protected by |
|---|---|---|
| `/` and other static files | `public/` (Workers static assets) | Cloudflare Access (once enabled) |
| `/api/*` | The Worker, `src/index.ts` | The Worker's own auth (below). A separate Access application for `<host>/api` with a *Bypass* policy keeps key callers from being sent to a login page. |

Everything the Worker answers lives under `/api`. Any other path that is not a static file returns `404 {"error":"not_found"}`.

## Authentication

The Worker tries, in order:

1. **Bearer token.** `Authorization: Bearer <token>`.
   - Matches the `API_KEY` secret: principal is `master`.
   - Otherwise it must look like an issued app key (exactly 64 lowercase hex characters, `^[0-9a-f]{64}$`), else `401` with no KV lookup.
   - Its SHA-256 matches a `key:<hash>` record in the `CONFIG` KV namespace: principal is `app`, with that record's scopes.
   - A Bearer header that matches neither is `401`. The Worker does not fall through to step 2.
2. **Cloudflare Access session.** Only when ALL THREE vars are set: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, and
   `ACCESS_ALLOWED_EMAILS` (comma-separated emails; letter case and spaces ignored; must list at least one email).
   - `ACCESS_TEAM_DOMAIN` (after removing an optional `https://` and trailing `/`, lowercased) must match
     `^[a-z0-9-]+\.cloudflareaccess\.com$`, else no token is accepted and no keys are downloaded.
   - Candidate tokens, tried in this order until one passes: the `Cf-Access-Jwt-Assertion` header, then every
     `CF_Authorization` cookie in the order sent. At most 4 candidates per request.
   - A token must be RS256, signed by a key from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`,
     with `iss` = `https://<ACCESS_TEAM_DOMAIN>`, `aud` containing `ACCESS_AUD`, not expired, and carrying an `email`
     that is on `ACCESS_ALLOWED_EMAILS` (compared ignoring letter case). Anyone else Access lets through is `401`.
   - Principal is `user`.
3. Otherwise `401 {"error":"unauthorized"}`.

**Access signing keys.** The key list is cached per Worker instance for 1 hour. It is downloaded at most once per
30 seconds (also for unknown key ids); requests that arrive during a download wait for it. A failed download, or one
with no usable keys, never replaces the cached list; cached keys keep working for up to 24 hours while downloads fail.

**CSRF guard.** Because a `user` principal is authenticated by a cookie, any `user` request whose method is not `GET`
must carry an `Origin` header equal to the request's own origin, else `403 {"error":"bad_origin"}`. Bearer callers are exempt.

**CORS.** `Access-Control-Allow-Origin: *`, no credentials. Safe because cross-origin callers can only use Bearer keys.

### Principals and rights

| Principal | Tables | `/api/admin/keys...` | `/api/activity` | Rate limited |
|---|---|---|---|---|
| `master` | all | yes | all entries | no |
| `user` | all | yes | all entries | no |
| `app` | per scope | no (`403`) | needs `activity:read`; sees only entries for tables it holds `<table>:read` on | yes, 60 requests / 60 s per key |

`/api/admin/keys`, `/api/admin/keys/<app>` are the only admin addresses. Any other `/api/admin/...` path is `404` for every principal.

Scopes: `<table>:read` (GET) and `<table>:write` (POST, PATCH, DELETE) for `ventures`, `clients`, `projects`, `tasks`; plus `activity:read`.
`GET /api/dashboard` needs `tasks:read`, `clients:read`, `projects:read` and `ventures:read`.

Activity for app keys: log entries copy row data (names, emails, notes, whole deleted rows, actor emails), so
`activity:read` alone shows nothing. The list is limited to `entity_type IN (<tables the key holds :read on>)`;
with no such tables the answer is `{"data":[]}`. `?entity_type=` naming a table outside that set is `403 forbidden`.
Write scopes do not count. `master` and `user` see every entry.

Rate limiting uses the Workers Rate Limiting binding `APP_LIMITER` keyed by the key hash. Over the limit: `429 {"error":"rate_limited"}` with `Retry-After: 60`.

## Response envelope

- Success: `{"data": ...}`. Lists are `{"data": [...]}`. Create returns `201`.
- Failure: `{"error": "<code>", "message": "<plain sentence>"}`, plus `"fields": {"<column>": "<problem>"}` on `400 invalid`.
- Database error text is never sent to the caller. Unexpected failures are `500 {"error":"server_error"}` and logged with `console.error`.

| Status | `error` codes |
|---|---|
| 400 | `bad_json`, `invalid`, `bad_id`, `empty_body` |
| 401 | `unauthorized` |
| 403 | `forbidden`, `bad_origin` |
| 404 | `not_found` |
| 405 | `method_not_allowed` |
| 409 | `conflict` (unique slug taken, or delete blocked because other rows point at this one) |
| 413 | `too_large` (request body over 64 KB) |
| 429 | `rate_limited` |
| 500 | `server_error` |

### Fine print

- Every error carries a `message`.
- A request body over 64 KB (65,536 bytes) is `413 too_large`. Checked from `Content-Length` when sent, and always on the bytes actually received.
- A body that is empty, or has no writable fields, is `400 empty_body`. JSON that is not an object (a list, a number, `null`) is `400 bad_json`.
- Leaving out `status`, `stage` or `priority` gives the default. Sending `null` or `""` for them is `400 invalid`.
- Whole numbers may arrive as text (`"2"`). Fractions and true/false are refused.
- `PATCH` writes and logs only the fields that actually change. A `PATCH` that changes nothing returns the row and logs nothing.
- List filter values follow the same rules as writes (`?status=bogus` is `400 invalid`). An empty value (`?project_id=`) matches rows where that column is empty. A junk `limit` falls back to the default; an out-of-range one is clamped.
- Any non-empty `Authorization` header counts as a key attempt, even if it is not `Bearer`. Tokens longer than 256 characters are refused.
- API responses carry `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- A delete is also blocked (`409`) by rows in the reserved `payments` and `portal_links` tables.
- Access tokens: `exp` is checked strictly; `nbf` gets 60 seconds of grace.
- Admin: creating a key returns `{"data":{"app","scopes","created_at","key"}}`; revoking returns `{"data":{"app","revoked":<count>}}` or `404`. Bad app names or scopes are `400 invalid` with `fields`.
- Activity `detail` is a JSON string: the fields set (create), the changed fields (update), or a copy of the deleted row (delete).

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | Public. `{"ok":true,"service":"becs-os-api"}` |
| GET | `/api/me` | Who am I. `{"data":{"kind":"master"}}`, `{"data":{"kind":"user","email":"..."}}` or `{"data":{"kind":"app","app":"...","scopes":[...]}}` |
| GET | `/api/dashboard` | Optional `?venture_id=` and `?today=`. Shape below. |
| GET | `/api/<table>` | List. Filter by any writable column (`?status=todo&venture_id=1`). `?limit=` 1..500, default 100. Newest first. |
| POST | `/api/<table>` | Create. Body is a JSON object. Returns the row. |
| GET | `/api/<table>/<id>` | One row or `404`. |
| PATCH | `/api/<table>/<id>` | Partial update. Returns the row, or `404` if it does not exist. |
| DELETE | `/api/<table>/<id>` | `{"data":{"id":<id>,"deleted":true}}`, `404` if missing, `409` if still referenced. |
| GET | `/api/activity` | Audit trail, newest first. `?limit=` 1..200 default 50, `?entity_type=`, `?entity_id=`. App keys see only tables they can read (see "Principals and rights"). |
| GET | `/api/admin/keys` | List app keys: app, scopes, created_at. Never keys or hashes. |
| POST | `/api/admin/keys` | Body `{"app":"leaa-portal","scopes":["tasks:read"]}`. Returns the raw key once. |
| DELETE | `/api/admin/keys/<app>` | Revokes every key issued to that app. |

`<table>` is one of `ventures`, `clients`, `projects`, `tasks`.

### Dashboard shape

```json
{"data": {
  "open_tasks": 9,
  "overdue": [{"id":1,"title":"...","due_date":"2026-10-01","priority":1,"venture_id":1}],
  "due_soon": [{"id":2,"title":"...","due_date":"2026-10-06","priority":1,"venture_id":1}],
  "open_tasks_by_venture": [{"venture_id":1,"slug":"becs","name":"BE Consulting Solutions","open_tasks":7}],
  "client_pipeline": [{"stage":"lead","n":8}],
  "active_projects": 0,
  "active_project_value_cents": 0
}}
```

- "Today" is the UTC date unless the caller sends `?today=YYYY-MM-DD` with the date where they are. It must be a real date within one day of the UTC date, else `400 invalid`. The console always sends it, so its figures follow the owner's local day.
- `overdue`: not done, `due_date` before today, oldest first, max 25.
- `due_soon`: not done, `due_date` from today through today + 7 days, soonest first, max 25.
- `active_projects` / `active_project_value_cents`: projects whose status is `planning` or `active`.
  The value is added up with SQLite `TOTAL()` and cast back to whole cents, so no stored data can make it fail.
- With `?venture_id=`, every figure is limited to that venture (`open_tasks_by_venture` then has one row).

## Data model

Dates are `YYYY-MM-DD`. Timestamps are UTC text. Money is integer cents. Unknown body fields are ignored. Strings are trimmed; an empty string on an optional field is stored as `null`.

### ventures
| Column | Rule |
|---|---|
| `slug` | required, unique, `^[a-z0-9][a-z0-9-]{1,62}$` |
| `name` | required, 1..200 chars |
| `description` | optional, up to 2000 chars |
| `status` | `active` (default), `paused`, `archived` |

### clients
| Column | Rule |
|---|---|
| `venture_id` | required, must exist |
| `name` | required, 1..200 chars |
| `contact_name`, `phone`, `source` | optional, up to 200 chars |
| `email` | optional, must contain `@`, up to 200 chars |
| `stage` | `lead` (default), `contacted`, `proposal`, `active`, `paused`, `closed` |
| `notes` | optional, up to 5000 chars |

### projects
| Column | Rule |
|---|---|
| `venture_id` | required, must exist |
| `client_id` | optional, must exist |
| `name` | required, 1..200 chars |
| `status` | `planning` (default), `active`, `paused`, `done`, `cancelled` |
| `phase` | optional: `plan`, `evolve`, `succeed`, or `null`. The P.E.S. phase. The console only offers it for the `becs` venture. |
| `priority` | integer 1 (high), 2 (medium), 3 (low, default) |
| `value_cents` | optional integer, 0 to 100000000000 ($1 billion) |
| `start_date`, `due_date` | optional dates |
| `notes` | optional, up to 5000 chars |

### tasks
| Column | Rule |
|---|---|
| `venture_id` | required, must exist |
| `project_id` | optional, must exist |
| `title` | required, 1..300 chars |
| `status` | `todo` (default), `doing`, `done` |
| `priority` | integer 1 (high), 2 (medium), 3 (low, default) |
| `filter_tag` | optional: `revenue`, `systems`, `brand`, `workload`. Why the task matters. |
| `due_date` | optional date |
| `completed_at` | set by the server: stamped when status becomes `done`, cleared when it leaves `done`. Not writable. |
| `notes` | optional, up to 5000 chars |

`id`, `created_at`, `updated_at` are set by the server on every table and are not writable.

### activity_log
Every create, update and delete writes one row: `entity_type`, `entity_id`, `action` (`created` / `updated` / `deleted`), `detail` (JSON of the changed fields), `actor` (`master`, `user:<email>` or `app:<name>`), `created_at`.

### Reserved tables
`payments` and `portal_links` exist in the live database (added for the planned Square payment status and client portal). Nothing reads or writes them yet. Migrations keep them; the API does not expose them.

## Console (`public/index.html`)

- One static HTML file, no build step, BECS brand system. Fonts are self-hosted under `public/fonts/`.
- On load it calls `GET /api/me` with the browser's cookies. `200` means signed in through Access.
  `401` shows a key box as a fallback; the key is kept in `sessionStorage` for that tab only and sent as a Bearer header.
- No demo data. If the API cannot be reached the console says so.
- Screens: Overview, Clients, Projects, Tasks, Keys (Keys only for `master` and `user`).
- A venture switcher (All ventures, or one) filters every screen.
- Create, edit and delete on clients, projects and tasks.
- The Plan / Evolve / Succeed strip shows only on projects that have a `phase`; the phase field is offered only when the project's venture slug is `becs`.
