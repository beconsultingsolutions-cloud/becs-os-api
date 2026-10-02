export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  API_KEY: string;
}

// Whitelisted columns per table. Anything not listed here is ignored.
const TABLES = {
  ventures: { cols: ['slug', 'name', 'description', 'status'], touch: false },
  clients: {
    cols: ['venture_id', 'name', 'contact_name', 'email', 'phone', 'stage', 'source', 'notes'],
    touch: true,
  },
  projects: {
    cols: ['venture_id', 'client_id', 'name', 'status', 'priority', 'value_cents', 'start_date', 'due_date', 'notes'],
    touch: true,
  },
  tasks: {
    cols: ['project_id', 'venture_id', 'title', 'status', 'priority', 'filter_tag', 'due_date', 'completed_at', 'notes'],
    touch: true,
  },
} as const;

type TableName = keyof typeof TABLES;

// --- Auth -------------------------------------------------------------------
// The master API_KEY (a Worker secret) has full access and is the only
// credential that can reach /admin/*. Per-app keys live in the CONFIG KV
// namespace as "key:<sha256 hex of the raw key>" -> KeyRecord. Only the hash is
// stored, so a leaked KV namespace does not leak usable keys.
//
// Scopes are "<table>:read" (GET) and "<table>:write" (POST/PATCH/DELETE).

const KEY_PREFIX = 'key:';
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ACTIONS = ['read', 'write'] as const;
const ALL_SCOPES = new Set<string>(
  (Object.keys(TABLES) as TableName[]).flatMap((t) => ACTIONS.map((a) => `${t}:${a}`))
);
const ACTION_FOR_METHOD: Record<string, (typeof ACTIONS)[number]> = {
  GET: 'read',
  POST: 'write',
  PATCH: 'write',
  DELETE: 'write',
};
// /dashboard aggregates these tables, so a key needs read on all of them.
const DASHBOARD_TABLES: TableName[] = ['tasks', 'clients', 'ventures'];

const RATE_LIMIT = 60; // requests per key per window
const RATE_WINDOW_S = 60;

interface KeyRecord {
  app: string;
  scopes: string[];
  created_at?: string;
}

type Principal = { master: true } | { master: false; app: string; scopes: string[]; hash: string };

const hasScope = (p: Principal, scope: string) => p.master || p.scopes.includes(scope);

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(input: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))));
}

// Constant-time compare. Callers pass equal-length hex digests, so no length is leaked.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length > 256) return null;

  const hash = await sha256Hex(token);
  if (env.API_KEY && safeEqual(hash, await sha256Hex(env.API_KEY))) return { master: true };

  const rec = await env.CONFIG.get<KeyRecord>(KEY_PREFIX + hash, 'json').catch(() => null);
  if (!rec || typeof rec.app !== 'string' || !Array.isArray(rec.scopes)) return null;
  return { master: false, app: rec.app, scopes: rec.scopes, hash };
}

// Per-key fixed-window rate limit. Returns seconds to wait when over the limit, else null.
// NOTE: KV has no atomic increment and is eventually consistent, so this counter is
// approximate: concurrent requests can slip past the limit. Good enough to stop a
// runaway app; use Cloudflare's Rate Limiting binding or a Durable Object for a hard cap.
// If KV is unavailable (including hitting the free-plan write quota) we fail open
// rather than take the whole API down.
async function rateLimited(env: Env, hash: string): Promise<number | null> {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / RATE_WINDOW_S);
  const key = `rl:${hash}:${window}`;
  try {
    const count = Number(await env.CONFIG.get(key)) || 0;
    if (count >= RATE_LIMIT) return Math.max(1, (window + 1) * RATE_WINDOW_S - now);
    await env.CONFIG.put(key, String(count + 1), { expirationTtl: 2 * RATE_WINDOW_S });
  } catch {
    /* fail open */
  }
  return null;
}

// --- HTTP helpers -----------------------------------------------------------

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });

// --- Key management (master only) --------------------------------------------

async function listKeys(env: Env): Promise<{ name: string; rec: KeyRecord }[]> {
  const out: { name: string; rec: KeyRecord }[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CONFIG.list({ prefix: KEY_PREFIX, cursor });
    for (const k of page.keys) {
      const rec = await env.CONFIG.get<KeyRecord>(k.name, 'json').catch(() => null);
      if (rec && typeof rec.app === 'string') out.push({ name: k.name, rec });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

async function admin(req: Request, env: Env, parts: string[]): Promise<Response> {
  if (parts[1] !== 'keys' || parts.length > 3) return json({ error: 'not_found' }, 404);
  const app = parts[2];

  // LIST (apps and scopes only; never hashes or raw keys)
  if (req.method === 'GET' && !app) {
    const keys = await listKeys(env);
    const data = keys
      .map(({ rec }) => ({ app: rec.app, scopes: rec.scopes, created_at: rec.created_at ?? null }))
      .sort((a, b) => a.app.localeCompare(b.app));
    return json({ data });
  }

  // CREATE: returns the raw key exactly once
  if (req.method === 'POST' && !app) {
    let body: { app?: unknown; scopes?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: 'bad_json' }, 400);
    }
    if (typeof body.app !== 'string' || !APP_NAME.test(body.app)) {
      return json({ error: 'bad_app', message: 'app must be 2-63 chars: lowercase letters, digits, hyphens' }, 400);
    }
    const scopes = body.scopes;
    if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => typeof s === 'string' && ALL_SCOPES.has(s))) {
      return json({ error: 'bad_scopes', allowed: [...ALL_SCOPES].sort() }, 400);
    }
    const raw = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const record: KeyRecord = {
      app: body.app,
      scopes: [...new Set(scopes as string[])].sort(),
      created_at: new Date().toISOString(),
    };
    await env.CONFIG.put(KEY_PREFIX + (await sha256Hex(raw)), JSON.stringify(record));
    return json(
      { data: { ...record, key: raw }, note: 'Store this key now. It cannot be shown again.' },
      201,
      { 'Cache-Control': 'no-store' }
    );
  }

  // REVOKE: deletes every key issued to that app
  if (req.method === 'DELETE' && app) {
    const matches = (await listKeys(env)).filter(({ rec }) => rec.app === app);
    if (!matches.length) return json({ error: 'not_found' }, 404);
    await Promise.all(matches.map(({ name }) => env.CONFIG.delete(name)));
    return json({ ok: true, revoked: matches.length });
  }

  return json({ error: 'method_not_allowed' }, 405);
}

async function log(env: Env, type: string, id: number, action: string, detail?: unknown) {
  await env.DB.prepare('INSERT INTO activity_log (entity_type, entity_id, action, detail) VALUES (?,?,?,?)')
    .bind(type, id, action, detail ? JSON.stringify(detail) : null)
    .run();
}

function pick(body: Record<string, unknown>, cols: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const c of cols) if (c in body) out[c] = body[c] ?? null;
  return out;
}

async function dashboard(env: Env) {
  const [open, overdue, byVenture, pipeline] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'"),
    env.DB.prepare("SELECT id, title, due_date, priority FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date < date('now') ORDER BY due_date LIMIT 25"),
    env.DB.prepare("SELECT v.slug, COUNT(t.id) AS open_tasks FROM ventures v LEFT JOIN tasks t ON t.venture_id = v.id AND t.status != 'done' GROUP BY v.id ORDER BY open_tasks DESC"),
    env.DB.prepare('SELECT stage, COUNT(*) AS n FROM clients GROUP BY stage'),
  ]);
  return {
    open_tasks: (open.results[0] as { n: number }).n,
    overdue: overdue.results,
    open_tasks_by_venture: byVenture.results,
    client_pipeline: pipeline.results,
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'health') return json({ ok: true, service: 'becs-os-api' });

    // 401: missing or invalid key (no detail on why). 403: valid key, not allowed.
    const principal = await authenticate(req, env);
    if (!principal) return json({ error: 'unauthorized' }, 401);

    if (parts[0] === 'admin') {
      if (!principal.master) return json({ error: 'forbidden' }, 403);
      try {
        return await admin(req, env, parts);
      } catch (err) {
        return json({ error: 'server_error', message: (err as Error).message }, 500);
      }
    }

    if (!principal.master) {
      const retryAfter = await rateLimited(env, principal.hash);
      if (retryAfter !== null) return json({ error: 'rate_limited' }, 429, { 'Retry-After': String(retryAfter) });
    }

    try {
      if (parts[0] === 'dashboard') {
        if (req.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
        if (!DASHBOARD_TABLES.every((t) => hasScope(principal, `${t}:read`))) return json({ error: 'forbidden' }, 403);
        return json(await dashboard(env));
      }

      if (!Object.hasOwn(TABLES, parts[0] ?? '')) return json({ error: 'not_found' }, 404);
      const name = parts[0] as TableName;
      const table = TABLES[name];
      const action = ACTION_FOR_METHOD[req.method];
      if (!action) return json({ error: 'method_not_allowed' }, 405);
      if (!hasScope(principal, `${name}:${action}`)) return json({ error: 'forbidden' }, 403);
      const id = parts[1] ? Number(parts[1]) : null;
      if (parts[1] && !Number.isInteger(id)) return json({ error: 'bad_id' }, 400);

      // LIST
      if (req.method === 'GET' && id === null) {
        const where: string[] = [];
        const params: unknown[] = [];
        for (const c of table.cols) {
          const v = url.searchParams.get(c);
          if (v !== null) {
            where.push(`${c} = ?`);
            params.push(v);
          }
        }
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 500);
        const sql = `SELECT * FROM ${name}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
        const { results } = await env.DB.prepare(sql).bind(...params, limit).all();
        return json({ data: results });
      }

      // GET ONE
      if (req.method === 'GET' && id !== null) {
        const row = await env.DB.prepare(`SELECT * FROM ${name} WHERE id = ?`).bind(id).first();
        return row ? json({ data: row }) : json({ error: 'not_found' }, 404);
      }

      // CREATE
      if (req.method === 'POST' && id === null) {
        const data = pick((await req.json()) as Record<string, unknown>, table.cols);
        const keys = Object.keys(data);
        if (!keys.length) return json({ error: 'empty_body' }, 400);
        const res = await env.DB.prepare(
          `INSERT INTO ${name} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
        )
          .bind(...Object.values(data))
          .run();
        const newId = res.meta.last_row_id as number;
        await log(env, name, newId, 'created');
        const row = await env.DB.prepare(`SELECT * FROM ${name} WHERE id = ?`).bind(newId).first();
        return json({ data: row }, 201);
      }

      // UPDATE
      if (req.method === 'PATCH' && id !== null) {
        const data = pick((await req.json()) as Record<string, unknown>, table.cols);
        // Auto-stamp completion on tasks
        if (name === 'tasks' && data.status === 'done' && !('completed_at' in data)) {
          data.completed_at = new Date().toISOString();
        }
        const keys = Object.keys(data);
        if (!keys.length) return json({ error: 'empty_body' }, 400);
        const sets = keys.map((k) => `${k} = ?`);
        if (table.touch) sets.push("updated_at = datetime('now')");
        await env.DB.prepare(`UPDATE ${name} SET ${sets.join(', ')} WHERE id = ?`)
          .bind(...Object.values(data), id)
          .run();
        await log(env, name, id, 'updated', data);
        const row = await env.DB.prepare(`SELECT * FROM ${name} WHERE id = ?`).bind(id).first();
        return row ? json({ data: row }) : json({ error: 'not_found' }, 404);
      }

      // DELETE
      if (req.method === 'DELETE' && id !== null) {
        await env.DB.prepare(`DELETE FROM ${name} WHERE id = ?`).bind(id).run();
        await log(env, name, id, 'deleted');
        return json({ ok: true });
      }

      return json({ error: 'method_not_allowed' }, 405);
    } catch (err) {
      return json({ error: 'server_error', message: (err as Error).message }, 500);
    }
  },
};
