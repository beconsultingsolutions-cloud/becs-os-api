// BECS OS API: one central store for clients, projects and tasks across all ventures.
// The contract for every route, status code and rule below is docs/SPEC.md.
// Everything this Worker answers lives under /api. The console (public/) is
// served by Workers static assets and never reaches this code.
//
// Files:
//   src/index.ts   routing, sign-in checks, the table endpoints (this file)
//   src/tables.ts  the four tables and their validation rules
//   src/access.ts  the Cloudflare Access sign-in token check

import { accessEnabled, readAccessTokens, verifyAccessJwt } from './access';
import { TABLES, TABLE_NAMES, type TableName, isTableName, toInteger, validateBody, checkValue } from './tables';

export interface Env {
  DB: D1Database;
  CONFIG: KVNamespace;
  API_KEY: string; // master key (Worker secret)
  APP_LIMITER?: RateLimit; // Workers Rate Limiting binding (see wrangler.jsonc)
  ACCESS_TEAM_DOMAIN?: string; // e.g. "myteam.cloudflareaccess.com". Empty = Access sign-in off.
  ACCESS_AUD?: string; // the Access application's AUD tag. Empty = Access sign-in off.
  ACCESS_ALLOWED_EMAILS?: string; // comma-separated emails allowed to sign in. Empty = Access sign-in off.
}

// --- Who is calling ------------------------------------------------------------
// Three kinds of caller (a "principal"):
//   master  the API_KEY secret, sent as "Authorization: Bearer <key>". Can do everything.
//   app     a per-app key, sent the same way. Can do only what its scopes allow.
//           Stored in the CONFIG KV namespace as "key:<sha256 hex of the raw key>"
//           -> KeyRecord. Only the hash is stored, so a leaked KV namespace does not
//           leak usable keys.
//   user    the owner, signed in through Cloudflare Access (console). Can do everything.
//
// Scopes are "<table>:read" (GET) and "<table>:write" (POST/PATCH/DELETE), plus "activity:read".

type Principal =
  | { kind: 'master' }
  | { kind: 'user'; email: string }
  | { kind: 'app'; app: string; scopes: string[]; hash: string };

interface KeyRecord {
  app: string;
  scopes: string[];
  created_at?: string;
}

const KEY_PREFIX = 'key:';
// Every app key this Worker issues is 64 lowercase hex characters (see adminKeys).
const APP_KEY_SHAPE = /^[0-9a-f]{64}$/;
const APP_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ALL_SCOPES = new Set<string>([
  ...TABLE_NAMES.flatMap((t) => [`${t}:read`, `${t}:write`]),
  'activity:read',
]);
// /api/dashboard summarises these tables, so an app key needs read on all of them.
const DASHBOARD_SCOPES = ['tasks:read', 'clients:read', 'projects:read', 'ventures:read'];

const hasScope = (p: Principal, scope: string) => p.kind !== 'app' || p.scopes.includes(scope);

/** How the activity log names the caller: "master", "user:<email>" or "app:<name>". */
const actorOf = (p: Principal) =>
  p.kind === 'master' ? 'master' : p.kind === 'user' ? `user:${p.email}` : `app:${p.app}`;

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

/**
 * Works out who is calling, or returns null (which becomes 401).
 * 1. A Bearer key, if an Authorization header is sent. A key that is wrong is a
 *    401 straight away: we do NOT go on to try the Access sign-in.
 * 2. Otherwise, if Access is switched on, the Access sign-in token(s): the first
 *    one that checks out wins.
 */
async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const header = (req.headers.get('Authorization') ?? '').trim();
  if (header) {
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    const token = m ? m[1] : '';
    if (!token || token.length > 256) return null;

    const hash = await sha256Hex(token);
    if (env.API_KEY && safeEqual(hash, await sha256Hex(env.API_KEY))) return { kind: 'master' };

    // Not the master key. If it does not even look like an app key, refuse it
    // here, so made-up keys never cost a KV lookup.
    if (!APP_KEY_SHAPE.test(token)) return null;

    const rec = await env.CONFIG.get<KeyRecord>(KEY_PREFIX + hash, 'json').catch(() => null);
    if (!rec || typeof rec.app !== 'string' || !Array.isArray(rec.scopes)) return null;
    return { kind: 'app', app: rec.app, scopes: rec.scopes, hash };
  }

  if (accessEnabled(env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, env.ACCESS_ALLOWED_EMAILS)) {
    const cfg = {
      teamDomain: env.ACCESS_TEAM_DOMAIN!,
      aud: env.ACCESS_AUD!,
      allowedEmails: env.ACCESS_ALLOWED_EMAILS!,
    };
    // A bad header or an old cookie must not block a good cookie, so try each in turn.
    for (const token of readAccessTokens(req)) {
      const who = await verifyAccessJwt(token, cfg);
      if (who) return { kind: 'user', email: who.email };
    }
  }
  return null;
}

// App keys get 60 requests per 60 seconds each (set in wrangler.jsonc, binding
// APP_LIMITER). Returns true when this request is over the limit.
// If the binding is missing or errors we let the request through ("fail open")
// rather than take the whole API down.
async function overRateLimit(env: Env, keyHash: string): Promise<boolean> {
  if (!env.APP_LIMITER) return false;
  try {
    const { success } = await env.APP_LIMITER.limit({ key: keyHash });
    return !success;
  } catch (err) {
    console.error('Rate limiter unavailable, letting request through', err);
    return false;
  }
}

// --- HTTP helpers ----------------------------------------------------------------

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', // API answers hold private data: never cache them
      'X-Content-Type-Options': 'nosniff',
      ...CORS,
      ...extra,
    },
  });

const ok = (data: unknown, status = 200) => json({ data }, status);

// Every failure has the same shape: {"error": "<code>", "message": "<plain sentence>"}.
const DEFAULT_MESSAGES: Record<string, string> = {
  bad_json: 'The request body is not valid JSON.',
  invalid: 'Some fields are not valid.',
  bad_id: 'The id in the address must be a whole number.',
  empty_body: 'The request body has nothing to save.',
  too_large: 'The request body is too big. The limit is 64 KB.',
  unauthorized: 'Sign in, or send a valid key as "Authorization: Bearer <key>".',
  forbidden: 'You are not allowed to do that.',
  bad_origin: 'This request did not come from this site, so it was refused.',
  not_found: 'Nothing was found at this address.',
  method_not_allowed: 'That method is not allowed here.',
  conflict: 'That clashes with existing data.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  server_error: 'Something went wrong on the server. Please try again.',
};

function fail(status: number, error: string, message?: string, extra: Record<string, unknown> = {}, headers = {}) {
  return json({ error, message: message ?? DEFAULT_MESSAGES[error] ?? error, ...extra }, status, headers);
}

const invalid = (fields: Record<string, string>, message?: string) =>
  fail(400, 'invalid', message ?? DEFAULT_MESSAGES.invalid, { fields });

const methodNotAllowed = (allowed: string) =>
  fail(405, 'method_not_allowed', `Use ${allowed.split(',').join(' or ')} here.`, {}, { Allow: allowed });

// The biggest request body we accept. Real bodies are a few KB at most.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads the body as text, but stops (and returns null) as soon as it passes
 * maxBytes, so a huge body is never held in memory.
 */
async function readTextCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/**
 * Reads the body as a JSON object. Returns a ready-made error Response when it
 * is too big (over 64 KB), empty, not JSON, or JSON that is not an object
 * (an array, a number...).
 */
async function readJsonObject(req: Request): Promise<Record<string, unknown> | Response> {
  // Quick check first: the size the caller says it is sending...
  const declared = Number(req.headers.get('Content-Length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'too_large');
  // ...then the size it really sends (the header can be missing or wrong).
  const text = await readTextCapped(req, MAX_BODY_BYTES);
  if (text === null) return fail(413, 'too_large');
  if (!text.trim()) return fail(400, 'empty_body', 'Send a JSON object in the request body.');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(400, 'bad_json');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'bad_json', 'The request body must be a JSON object, like {"name": "..."}.');
  }
  return body as Record<string, unknown>;
}

/** Turns "?limit=" into a whole number between 1 and max. Junk gives the default. */
function readLimit(url: URL, def: number, max: number): number {
  const raw = url.searchParams.get('limit');
  if (raw === null || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** Parses the <id> part of the address. Returns null if it is not a positive whole number. */
function parseId(s: string): number | null {
  return /^[1-9]\d{0,14}$/.test(s) ? Number(s) : null;
}

/** The database error text, for matching only. It is never sent to callers. */
function dbErrorText(err: unknown): string {
  const e = err as { message?: unknown; cause?: { message?: unknown } } | null;
  return `${e?.message ?? ''} ${e?.cause?.message ?? ''}`;
}

/** "UTC text" timestamp in the same format SQLite's datetime('now') uses. */
const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** "2 clients and 1 task" */
function describeCounts(items: { n: number; one: string; many: string }[]): string {
  const words = items.map(({ n, one, many }) => `${n} ${n === 1 ? one : many}`);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
}

// --- Activity log ----------------------------------------------------------------
// Every create, update and delete writes one row, in the same database batch
// (a transaction) as the change itself, so the log can never miss a change.

function logStatement(
  env: Env,
  table: TableName,
  id: number | 'last',
  action: 'created' | 'updated' | 'deleted',
  detail: unknown,
  actor: string
): D1PreparedStatement {
  // On create the new row's id is not known yet, so we use SQLite's
  // last_insert_rowid() (the id of the row the previous statement inserted).
  const idSql = id === 'last' ? 'last_insert_rowid()' : '?';
  const stmt = env.DB.prepare(
    `INSERT INTO activity_log (entity_type, entity_id, action, detail, actor) VALUES (?, ${idSql}, ?, ?, ?)`
  );
  const detailText = detail === undefined ? null : JSON.stringify(detail);
  return id === 'last'
    ? stmt.bind(table, action, detailText, actor)
    : stmt.bind(table, id, action, detailText, actor);
}

// --- Table endpoints -------------------------------------------------------------

/**
 * Checks that every id the caller pointed at (venture_id, client_id, project_id)
 * really exists. Returns a map of column -> problem (empty when all is well).
 */
async function checkReferences(
  env: Env,
  table: TableName,
  values: Record<string, string | number | null>
): Promise<Record<string, string>> {
  const checks: { col: string; target: TableName; id: number }[] = [];
  for (const [col, rule] of Object.entries(TABLES[table].fields)) {
    if (rule.type === 'ref' && typeof values[col] === 'number') {
      checks.push({ col, target: rule.table, id: values[col] as number });
    }
  }
  if (!checks.length) return {};
  const results = await env.DB.batch(
    checks.map((c) => env.DB.prepare(`SELECT id FROM ${c.target} WHERE id = ?`).bind(c.id))
  );
  const problems: Record<string, string> = {};
  checks.forEach((c, i) => {
    if (!results[i].results.length) problems[c.col] = `there is no ${TABLES[c.target].one} with id ${c.id}`;
  });
  return problems;
}

async function listRows(env: Env, table: TableName, url: URL): Promise<Response> {
  // Filters: any writable column, e.g. ?status=todo&venture_id=1.
  // Values are checked with the same rules as writes; an empty value matches "no value" (NULL).
  const where: string[] = [];
  const params: (string | number)[] = [];
  const problems: Record<string, string> = {};
  for (const [col, rule] of Object.entries(TABLES[table].fields)) {
    const raw = url.searchParams.get(col);
    if (raw === null) continue;
    const res = checkValue(rule, raw);
    if (!res.ok) {
      // Filtering on "empty" is fine even for a required column; it just matches nothing.
      if (raw.trim() === '') {
        where.push(`${col} IS NULL`);
        continue;
      }
      problems[col] = res.problem;
    } else if (res.value === null) {
      where.push(`${col} IS NULL`);
    } else {
      where.push(`${col} = ?`);
      params.push(res.value);
    }
  }
  if (Object.keys(problems).length) return invalid(problems, 'Some filters are not valid.');

  const limit = readLimit(url, 100, 500);
  const sql = `SELECT * FROM ${table}${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...params, limit).all();
  return ok(results);
}

async function getRow(env: Env, table: TableName, id: number) {
  return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
}

const notFoundRow = (table: TableName, id: number) =>
  fail(404, 'not_found', `There is no ${TABLES[table].one} with id ${id}.`);

/** Turns a database constraint error into a friendly 409, or returns null if it is something else. */
function conflictFromDbError(err: unknown, table: TableName, values: Record<string, unknown>): Response | null {
  const text = dbErrorText(err);
  if (text.includes('UNIQUE constraint failed')) {
    const slug = typeof values.slug === 'string' ? ` "${values.slug}"` : '';
    return fail(409, 'conflict', `A ${TABLES[table].one} with the slug${slug} already exists. Pick another slug.`);
  }
  if (text.includes('FOREIGN KEY constraint failed')) {
    return fail(409, 'conflict', 'Another record this one depends on was changed at the same moment. Please try again.');
  }
  return null;
}

async function createRow(env: Env, table: TableName, req: Request, actor: string): Promise<Response> {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;

  const { values, fields, sent } = validateBody(table, body, 'create');
  if (sent === 0) return fail(400, 'empty_body', 'None of the fields sent can be saved.');
  if (Object.keys(fields).length) return invalid(fields);
  const refProblems = await checkReferences(env, table, values);
  if (Object.keys(refProblems).length) return invalid(refProblems);

  // Tasks created already "done" get their completion time stamped now.
  if (table === 'tasks' && values.status === 'done') values.completed_at = nowText();

  const cols = Object.keys(values);
  const insert = env.DB.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`
  ).bind(...cols.map((c) => values[c]));

  try {
    const [inserted] = await env.DB.batch([insert, logStatement(env, table, 'last', 'created', values, actor)]);
    return ok(inserted.results[0], 201);
  } catch (err) {
    const conflict = conflictFromDbError(err, table, values);
    if (conflict) return conflict;
    throw err;
  }
}

async function updateRow(env: Env, table: TableName, id: number, req: Request, actor: string): Promise<Response> {
  const body = await readJsonObject(req);
  if (body instanceof Response) return body;

  const { values, fields, sent } = validateBody(table, body, 'update');
  if (sent === 0) return fail(400, 'empty_body', 'Nothing to update: none of the fields sent can be changed.');

  const existing = await getRow(env, table, id);
  if (!existing) return notFoundRow(table, id);
  if (Object.keys(fields).length) return invalid(fields);

  // Keep only the fields that actually change.
  const changes: Record<string, string | number | null> = {};
  for (const [col, v] of Object.entries(values)) if (existing[col] !== v) changes[col] = v;

  // completed_at is managed here: stamped when a task becomes done, cleared when it stops being done.
  if (table === 'tasks' && 'status' in changes) {
    if (changes.status === 'done' && existing.status !== 'done') changes.completed_at = nowText();
    if (changes.status !== 'done' && existing.status === 'done') changes.completed_at = null;
  }

  if (!Object.keys(changes).length) return ok(existing); // nothing changed: no write, no log

  const refProblems = await checkReferences(env, table, changes);
  if (Object.keys(refProblems).length) return invalid(refProblems);

  const sets = Object.keys(changes).map((c) => `${c} = ?`);
  if (TABLES[table].hasUpdatedAt) sets.push("updated_at = datetime('now')");
  const update = env.DB.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? RETURNING *`).bind(
    ...Object.values(changes),
    id
  );

  try {
    const [updated] = await env.DB.batch([update, logStatement(env, table, id, 'updated', changes, actor)]);
    // The row could vanish between our read and the update (deleted by someone else).
    return updated.results.length ? ok(updated.results[0]) : notFoundRow(table, id);
  } catch (err) {
    const conflict = conflictFromDbError(err, table, changes);
    if (conflict) return conflict;
    throw err;
  }
}

async function deleteRow(env: Env, table: TableName, id: number, actor: string): Promise<Response> {
  const existing = await getRow(env, table, id);
  if (!existing) return notFoundRow(table, id);

  // Refuse to delete a row that other rows still point at, and say which ones.
  const children = TABLES[table].children;
  if (children.length) {
    const counts = await env.DB.batch(
      children.map((c) => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${c.table} WHERE ${c.column} = ?`).bind(id))
    );
    const blocking = children
      .map((c, i) => ({ n: (counts[i].results[0] as { n: number }).n, one: c.one, many: c.many }))
      .filter((c) => c.n > 0);
    if (blocking.length) {
      return fail(
        409,
        'conflict',
        `This ${TABLES[table].one} still has ${describeCounts(blocking)}. Delete or move them first.`
      );
    }
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id),
      // Keep a copy of what was deleted in the log, so it can be recovered by hand.
      logStatement(env, table, id, 'deleted', existing, actor),
    ]);
  } catch (err) {
    if (dbErrorText(err).includes('FOREIGN KEY constraint failed')) {
      return fail(409, 'conflict', `Other records still point at this ${TABLES[table].one}. Delete or move them first.`);
    }
    throw err;
  }
  return ok({ id, deleted: true });
}

async function tableRoute(
  req: Request,
  env: Env,
  url: URL,
  p: Principal,
  table: TableName,
  idPart: string | undefined
): Promise<Response> {
  const allowed = idPart === undefined ? 'GET,POST' : 'GET,PATCH,DELETE';
  if (!allowed.split(',').includes(req.method)) return methodNotAllowed(allowed);

  const scope = `${table}:${req.method === 'GET' ? 'read' : 'write'}`;
  if (!hasScope(p, scope)) return fail(403, 'forbidden', `This key needs the "${scope}" scope for that.`);

  if (idPart === undefined) {
    return req.method === 'GET' ? listRows(env, table, url) : createRow(env, table, req, actorOf(p));
  }

  const id = parseId(idPart);
  if (id === null) return fail(400, 'bad_id');
  if (req.method === 'GET') {
    const row = await getRow(env, table, id);
    return row ? ok(row) : notFoundRow(table, id);
  }
  if (req.method === 'PATCH') return updateRow(env, table, id, req, actorOf(p));
  return deleteRow(env, table, id, actorOf(p));
}

// --- Dashboard -------------------------------------------------------------------

async function dashboard(env: Env, url: URL): Promise<Response> {
  // Optional ?venture_id= limits every figure to that venture.
  let ventureId: number | null = null;
  const raw = url.searchParams.get('venture_id');
  if (raw !== null && raw.trim() !== '') {
    const n = toInteger(raw);
    if (n === undefined || n < 1) return invalid({ venture_id: 'must be the id of an existing venture (a whole number)' });
    const venture = await env.DB.prepare('SELECT id FROM ventures WHERE id = ?').bind(n).first();
    if (!venture) return invalid({ venture_id: `there is no venture with id ${n}` });
    ventureId = n;
  }

  // Optional ?today=YYYY-MM-DD lets the caller say what the date is where they are, so
  // "overdue" and "due soon" follow their day, not the UTC day. It must be within one day
  // of the UTC date (no time zone is further away than that). Without it, today is UTC.
  const utcToday = new Date().toISOString().slice(0, 10);
  let today = utcToday;
  const rawToday = url.searchParams.get('today');
  if (rawToday !== null && rawToday.trim() !== '') {
    const t = rawToday.trim();
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(t) ? Date.parse(t + 'T00:00:00Z') : NaN;
    const offBy = Math.abs(ms - Date.parse(utcToday + 'T00:00:00Z'));
    if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== t || offBy > 86_400_000) {
      return invalid({ today: "must be today's date as YYYY-MM-DD (within one day of the UTC date)" });
    }
    today = t;
  }
  const soonEnd = new Date(Date.parse(today + 'T00:00:00Z') + 7 * 86_400_000).toISOString().slice(0, 10);

  const and = ventureId ? ' AND venture_id = ?' : '';
  const bind = ventureId ? [ventureId] : [];
  const prep = (sql: string, ...first: unknown[]) => env.DB.prepare(sql).bind(...first, ...bind);

  const [open, overdue, dueSoon, byVenture, pipeline, projects] = await env.DB.batch([
    prep(`SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'${and}`),
    prep(
      `SELECT id, title, due_date, priority, venture_id FROM tasks
       WHERE status != 'done' AND due_date IS NOT NULL AND due_date < ?${and}
       ORDER BY due_date, priority, id LIMIT 25`,
      today
    ),
    prep(
      `SELECT id, title, due_date, priority, venture_id FROM tasks
       WHERE status != 'done' AND due_date BETWEEN ? AND ?${and}
       ORDER BY due_date, priority, id LIMIT 25`,
      today,
      soonEnd
    ),
    prep(
      `SELECT v.id AS venture_id, v.slug, v.name, COUNT(t.id) AS open_tasks
       FROM ventures v LEFT JOIN tasks t ON t.venture_id = v.id AND t.status != 'done'
       ${ventureId ? 'WHERE v.id = ?' : ''}
       GROUP BY v.id ORDER BY open_tasks DESC, v.id`
    ),
    prep(
      `SELECT stage, COUNT(*) AS n FROM clients ${ventureId ? 'WHERE venture_id = ?' : ''}
       GROUP BY stage
       ORDER BY CASE stage WHEN 'lead' THEN 1 WHEN 'contacted' THEN 2 WHEN 'proposal' THEN 3
                WHEN 'active' THEN 4 WHEN 'paused' THEN 5 WHEN 'closed' THEN 6 ELSE 7 END, stage`
    ),
    prep(
      // TOTAL() adds up as a decimal number, so it can never overflow and crash
      // the dashboard (SUM() can, on huge values). CAST turns it back into whole cents.
      `SELECT COUNT(*) AS n, CAST(TOTAL(value_cents) AS INTEGER) AS cents FROM projects
       WHERE status IN ('planning', 'active')${and}`
    ),
  ]);

  const proj = projects.results[0] as { n: number; cents: number };
  return ok({
    open_tasks: (open.results[0] as { n: number }).n,
    overdue: overdue.results,
    due_soon: dueSoon.results,
    open_tasks_by_venture: byVenture.results,
    client_pipeline: pipeline.results,
    active_projects: proj.n,
    active_project_value_cents: proj.cents,
  });
}

// --- Activity --------------------------------------------------------------------

// Log rows hold copies of row data (names, emails, notes, deleted rows), so an
// app key only sees the log for the tables it may read ("<table>:read"), on top
// of needing "activity:read". The master key and the signed-in owner see all of it.
async function activity(env: Env, url: URL, p: Principal): Promise<Response> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const problems: Record<string, string> = {};

  let type: TableName | null = null;
  const typeRaw = url.searchParams.get('entity_type');
  if (typeRaw !== null && typeRaw.trim() !== '') {
    if (isTableName(typeRaw.trim())) type = typeRaw.trim() as TableName;
    else problems.entity_type = `must be one of: ${TABLE_NAMES.join(', ')}`;
  }
  const idRaw = url.searchParams.get('entity_id');
  if (idRaw !== null && idRaw.trim() !== '') {
    const n = toInteger(idRaw);
    if (n !== undefined && n > 0) {
      where.push('entity_id = ?');
      params.push(n);
    } else problems.entity_id = 'must be a whole number';
  }
  if (Object.keys(problems).length) return invalid(problems, 'Some filters are not valid.');

  // Which tables' activity this caller may see.
  const visible = TABLE_NAMES.filter((t) => hasScope(p, `${t}:read`));
  if (type) {
    if (!visible.includes(type)) {
      return fail(403, 'forbidden', `This key needs the "${type}:read" scope to see that table's activity.`);
    }
    where.push('entity_type = ?');
    params.push(type);
  } else if (visible.length < TABLE_NAMES.length) {
    if (!visible.length) return ok([]); // an app key that can read no tables sees no activity
    where.push(`entity_type IN (${visible.map(() => '?').join(', ')})`);
    params.push(...visible);
  }

  const limit = readLimit(url, 50, 200);
  const sql =
    'SELECT id, entity_type, entity_id, action, detail, actor, created_at FROM activity_log' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY id DESC LIMIT ?';
  const { results } = await env.DB.prepare(sql).bind(...params, limit).all();
  return ok(results);
}

// --- Key management (master and signed-in owner only) ---------------------------

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

async function adminKeys(req: Request, env: Env, app: string | undefined): Promise<Response> {
  // LIST (apps and scopes only; never hashes or raw keys)
  if (app === undefined) {
    if (req.method === 'GET') {
      const keys = await listKeys(env);
      const data = keys
        .map(({ rec }) => ({ app: rec.app, scopes: rec.scopes, created_at: rec.created_at ?? null }))
        .sort((a, b) => a.app.localeCompare(b.app) || String(a.created_at).localeCompare(String(b.created_at)));
      return ok(data);
    }

    // CREATE: returns the raw key exactly once
    if (req.method === 'POST') {
      const body = await readJsonObject(req);
      if (body instanceof Response) return body;
      const fields: Record<string, string> = {};
      const name = typeof body.app === 'string' ? body.app.trim() : '';
      if (!APP_NAME.test(name)) {
        fields.app = 'must be 2 to 63 characters: lowercase letters, digits and hyphens, not starting with a hyphen';
      }
      const scopes = body.scopes;
      if (
        !Array.isArray(scopes) ||
        !scopes.length ||
        !scopes.every((s) => typeof s === 'string' && ALL_SCOPES.has(s))
      ) {
        fields.scopes = `must be a non-empty list from: ${[...ALL_SCOPES].sort().join(', ')}`;
      }
      if (Object.keys(fields).length) return invalid(fields);

      const raw = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const record: KeyRecord = {
        app: name,
        scopes: [...new Set(scopes as string[])].sort(),
        created_at: new Date().toISOString(),
      };
      await env.CONFIG.put(KEY_PREFIX + (await sha256Hex(raw)), JSON.stringify(record));
      // The raw key is in this response and nowhere else. Store it now.
      return json({ data: { ...record, key: raw } }, 201);
    }
    return methodNotAllowed('GET,POST');
  }

  // REVOKE: deletes every key issued to that app
  if (req.method !== 'DELETE') return methodNotAllowed('DELETE');
  if (!APP_NAME.test(app)) return fail(404, 'not_found', `There are no keys for an app called "${app}".`);
  const matches = (await listKeys(env)).filter(({ rec }) => rec.app === app);
  if (!matches.length) return fail(404, 'not_found', `There are no keys for an app called "${app}".`);
  await Promise.all(matches.map(({ name }) => env.CONFIG.delete(name)));
  return ok({ app, revoked: matches.length });
}

// --- Router ----------------------------------------------------------------------

async function handleApi(req: Request, env: Env, url: URL, parts: string[]): Promise<Response> {
  // parts[0] is "api"
  const [, section, a, b] = parts;

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // Public: no sign-in needed.
  if (section === 'health' && parts.length === 2) {
    return req.method === 'GET' ? json({ ok: true, service: 'becs-os-api' }) : methodNotAllowed('GET');
  }

  // 401: no valid key or sign-in (no detail on why). 403: signed in, but not allowed.
  const p = await authenticate(req, env);
  if (!p) return fail(401, 'unauthorized');

  // The console is signed in by a cookie, which the browser sends automatically,
  // even on requests started by other websites. So any change made by a signed-in
  // user must come from a page on this same site (checked via the Origin header).
  if (p.kind === 'user' && req.method !== 'GET' && req.headers.get('Origin') !== url.origin) {
    return fail(403, 'bad_origin');
  }

  if (p.kind === 'app' && (await overRateLimit(env, p.hash))) {
    return fail(429, 'rate_limited', undefined, {}, { 'Retry-After': '60' });
  }

  if (section === 'me' && parts.length === 2) {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    if (p.kind === 'master') return ok({ kind: 'master' });
    if (p.kind === 'user') return ok({ kind: 'user', email: p.email });
    return ok({ kind: 'app', app: p.app, scopes: p.scopes });
  }

  if (section === 'dashboard' && parts.length === 2) {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    const missing = DASHBOARD_SCOPES.filter((s) => !hasScope(p, s));
    if (missing.length) return fail(403, 'forbidden', `This key needs the ${missing.join(', ')} scopes for the dashboard.`);
    return dashboard(env, url);
  }

  if (section === 'activity' && parts.length === 2) {
    if (req.method !== 'GET') return methodNotAllowed('GET');
    if (!hasScope(p, 'activity:read')) return fail(403, 'forbidden', 'This key needs the "activity:read" scope for that.');
    return activity(env, url, p);
  }

  if (section === 'admin' && a === 'keys' && parts.length <= 4) {
    if (p.kind === 'app') return fail(403, 'forbidden', 'App keys cannot manage keys.');
    return adminKeys(req, env, b);
  }

  if (isTableName(section) && parts.length <= 3) return tableRoute(req, env, url, p, section, a);

  return fail(404, 'not_found');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // Static files (the console) are served before this Worker runs. Anything
    // that reaches us outside /api is a path with no file behind it.
    if (parts[0] !== 'api') return fail(404, 'not_found');

    try {
      return await handleApi(req, env, url, parts);
    } catch (err) {
      // Log the real problem for the owner (Workers logs), tell the caller nothing about it.
      console.error('Unexpected error', req.method, url.pathname, err);
      return fail(500, 'server_error');
    }
  },
} satisfies ExportedHandler<Env>;
