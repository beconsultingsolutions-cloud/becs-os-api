# becs-os-api

Central API for the BECS OS ecosystem. Cloudflare Worker + D1 (`becs-os-core`) + KV (`becs-os-config`).

## Deploy (first time)
```bash
npm install
npx wrangler login
npx wrangler secret put API_KEY      # paste a long random string
npx wrangler deploy
```

## Endpoints (Bearer auth, except /health)
- GET /health
- GET /dashboard
- GET|POST /ventures, /clients, /projects, /tasks
- GET|PATCH|DELETE /{table}/{id}
- List filters: any column, e.g. /tasks?status=todo&venture_id=1

## Example
```bash
curl -X POST https://becs-os-api.<your-subdomain>.workers.dev/tasks \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Send Gift the service agreement","venture_id":1,"priority":1,"filter_tag":"revenue"}'
```
