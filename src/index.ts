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

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

const authorized = (req: Request, env: Env) => {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !env.API_KEY || token.length !== env.API_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ env.API_KEY.charCodeAt(i);
  return diff === 0;
};

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
    if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);

    try {
      if (parts[0] === 'dashboard') return json(await dashboard(env));

      const name = parts[0] as TableName;
      const table = TABLES[name];
      if (!table) return json({ error: 'not_found' }, 404);
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
