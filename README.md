# becs-os-api

Central API for the BECS OS ecosystem. Cloudflare Worker + D1 (`becs-os-core`) + KV (`becs-os-config`).

## Deploy (first time)
```bash
npm install
npx wrangler login
npx wrangler secret put API_KEY      # paste a long random string (the master key)
npx wrangler deploy
```

## Endpoints
All endpoints need `Authorization: Bearer <key>` except `GET /health`.

- `GET /health`
- `GET /dashboard`
- `GET|POST /ventures`, `/clients`, `/projects`, `/tasks`
- `GET|PATCH|DELETE /{table}/{id}`
- List filters: any column, e.g. `/tasks?status=todo&venture_id=1`
- `GET|POST /admin/keys`, `DELETE /admin/keys/{app}` (master key only)

## Auth

There are two kinds of key:

| Key | Where it lives | Access |
|---|---|---|
| **Master** `API_KEY` | Worker secret (`wrangler secret put API_KEY`) | Everything, including `/admin/*`. Not rate-limited. Keep it out of apps. |
| **App key** | KV namespace `CONFIG` as `key:<sha256 of key>` | Only the scopes it was issued. Rate-limited. |

Give each app its own key with only the scopes it needs, so an app never holds the master key and one leaked key can be revoked on its own.

### Scopes
`<table>:read` allows `GET`. `<table>:write` allows `POST`, `PATCH` and `DELETE`.
Tables: `ventures`, `clients`, `projects`, `tasks`.

`GET /dashboard` needs `tasks:read`, `clients:read` and `ventures:read`.

### Response codes
| Code | Meaning |
|---|---|
| 401 | Missing or invalid key (no detail is given on why) |
| 403 | Valid key, but it lacks the scope (or it is not the master key on `/admin`) |
| 429 | Over the rate limit. Wait for `Retry-After` seconds |

### Create an app key (master key only)
The raw key is returned **once**. Only its SHA-256 hash is stored, so it cannot be recovered. Save it straight away.

```bash
curl -X POST https://becs-os-api.<your-subdomain>.workers.dev/admin/keys \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"app":"leaa-portal","scopes":["tasks:read","clients:read"]}'
```
Response (`201`):
```json
{"data":{"app":"leaa-portal","scopes":["clients:read","tasks:read"],"created_at":"...","key":"<64 hex chars>"},
 "note":"Store this key now. It cannot be shown again."}
```

`app` is 2-63 characters: lowercase letters, digits and hyphens. An app can have more than one key (for example to rotate), and revoking the app removes all of them.

**Windows Command Prompt** (quoting JSON is painful there, so put the body in a file):
```bat
echo {"app":"leaa-portal","scopes":["tasks:read","clients:read"]} > newkey.json
curl.exe -X POST https://becs-os-api.<your-subdomain>.workers.dev/admin/keys -H "Authorization: Bearer %API_KEY%" -H "Content-Type: application/json" -d @newkey.json
del newkey.json
```

### Use an app key
```bash
curl "https://becs-os-api.<your-subdomain>.workers.dev/tasks?status=todo" \
  -H "Authorization: Bearer $APP_KEY"
```
Apps should read the key from an environment variable or secret store, never from source code.

### List and revoke keys (master key only)
```bash
curl https://becs-os-api.<your-subdomain>.workers.dev/admin/keys -H "Authorization: Bearer $API_KEY"
curl -X DELETE https://becs-os-api.<your-subdomain>.workers.dev/admin/keys/leaa-portal -H "Authorization: Bearer $API_KEY"
```
The list shows apps, scopes and creation time, never keys or hashes. KV is cached at the edge, so a revoked key can keep working for up to about a minute.

### Rate limit
App keys are limited to 60 requests per minute each (`RATE_LIMIT` in `src/index.ts`). The counter lives in KV, which has no atomic increment and is eventually consistent, so the limit is approximate. Each limited request does one KV read and one KV write, so on the Workers **Free** plan (1,000 KV writes per day) a busy app key can exhaust the write quota. If KV is unavailable the limiter fails open, and the API stays up.

## Example (master key)
```bash
curl -X POST https://becs-os-api.<your-subdomain>.workers.dev/tasks \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Send Gift the service agreement","venture_id":1,"priority":1,"filter_tag":"revenue"}'
```

## Local development
Create a `.dev.vars` file (git-ignored) with a throwaway key, then run the Worker locally:
```
API_KEY=some-local-test-key
```
```bash
npx wrangler d1 execute becs-os-core --local --file=schema.sql
npx wrangler dev
```
