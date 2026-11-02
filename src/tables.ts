// --- The tables and their rules ---------------------------------------------------
// This file describes every column the API lets callers write, and checks
// incoming values against the rules in docs/SPEC.md ("Data model").
// Columns not listed here (id, created_at, updated_at, completed_at, and any
// unknown field) are ignored when sent.
// To add a table: add it here (with its permission group), add a migration, and add tests.

export type TableName = 'ventures' | 'clients' | 'projects' | 'tasks' | 'milestones' | 'client_notes';
export const TABLE_NAMES: TableName[] = ['ventures', 'clients', 'projects', 'tasks', 'milestones', 'client_notes'];

// App-key permissions come in these four groups ("<group>:read" / "<group>:write").
// Every table belongs to one group, so new tables need no new scopes or keys.
export type ScopeGroup = 'ventures' | 'clients' | 'projects' | 'tasks';
export const SCOPE_GROUPS: ScopeGroup[] = ['ventures', 'clients', 'projects', 'tasks'];

// Client log entry kinds. Add a kind here (and to the migration's CHECK) to extend the log.
export const NOTE_KINDS = ['note', 'call', 'meeting', 'email', 'decision', 'link'] as const;

// One rule per column. "required" means it must be present (and not empty) on create
// and can never be set to empty later.
export type Field =
  | { type: 'text'; max: number; required?: boolean }
  | { type: 'email'; max: number }
  | { type: 'slug' } // always required
  | { type: 'enum'; values: readonly string[]; optional?: boolean } // not optional = has a DB default, never null
  | { type: 'priority' } // integer 1..3, default 3
  | { type: 'cents' } // optional whole number, 0 up to MAX_CENTS ($1 billion)
  | { type: 'date' } // optional YYYY-MM-DD
  | { type: 'int'; min: number; max: number } // optional whole number in a range (ordering, counts)
  | { type: 'url'; max: number } // optional https:// link
  | { type: 'ref'; table: TableName; required?: boolean }; // id of a row in another table

// Rows in other tables that point at a row in this one. Used to refuse a delete
// with a helpful message instead of a database error.
interface Child {
  table: string;
  column: string;
  one: string; // "client"
  many: string; // "clients"
}

export interface TableDef {
  one: string; // "venture", used in messages
  scope: ScopeGroup; // which app-key permission group guards this table
  fields: Record<string, Field>;
  hasUpdatedAt: boolean; // ventures has no updated_at column
  completesOnDone?: boolean; // has status todo/doing/done and a server-managed completed_at
  children: Child[];
}

const PRIORITY: Field = { type: 'priority' };
const NOTES: Field = { type: 'text', max: 5000 };

export const TABLES: Record<TableName, TableDef> = {
  ventures: {
    one: 'venture',
    scope: 'ventures',
    hasUpdatedAt: false,
    fields: {
      slug: { type: 'slug' },
      name: { type: 'text', max: 200, required: true },
      description: { type: 'text', max: 2000 },
      status: { type: 'enum', values: ['active', 'paused', 'archived'] },
    },
    children: [
      { table: 'clients', column: 'venture_id', one: 'client', many: 'clients' },
      { table: 'projects', column: 'venture_id', one: 'project', many: 'projects' },
      { table: 'tasks', column: 'venture_id', one: 'task', many: 'tasks' },
    ],
  },
  clients: {
    one: 'client',
    scope: 'clients',
    hasUpdatedAt: true,
    fields: {
      venture_id: { type: 'ref', table: 'ventures', required: true },
      name: { type: 'text', max: 200, required: true },
      contact_name: { type: 'text', max: 200 },
      email: { type: 'email', max: 200 },
      phone: { type: 'text', max: 200 },
      stage: { type: 'enum', values: ['lead', 'contacted', 'proposal', 'active', 'paused', 'closed'] },
      source: { type: 'text', max: 200 },
      notes: NOTES,
    },
    children: [
      { table: 'projects', column: 'client_id', one: 'project', many: 'projects' },
      { table: 'client_notes', column: 'client_id', one: 'client log entry', many: 'client log entries' },
      // Reserved table (client portal). The API does not expose it, but a row there still blocks a delete.
      { table: 'portal_links', column: 'client_id', one: 'client portal link', many: 'client portal links' },
    ],
  },
  projects: {
    one: 'project',
    scope: 'projects',
    hasUpdatedAt: true,
    fields: {
      venture_id: { type: 'ref', table: 'ventures', required: true },
      client_id: { type: 'ref', table: 'clients' },
      name: { type: 'text', max: 200, required: true },
      status: { type: 'enum', values: ['planning', 'active', 'paused', 'done', 'cancelled'] },
      phase: { type: 'enum', values: ['plan', 'evolve', 'succeed'], optional: true },
      priority: PRIORITY,
      value_cents: { type: 'cents' },
      start_date: { type: 'date' },
      due_date: { type: 'date' },
      notes: NOTES,
    },
    children: [
      { table: 'tasks', column: 'project_id', one: 'task', many: 'tasks' },
      { table: 'milestones', column: 'project_id', one: 'milestone', many: 'milestones' },
      // Reserved table (Square payments). Not exposed by the API.
      { table: 'payments', column: 'project_id', one: 'payment', many: 'payments' },
    ],
  },
  tasks: {
    one: 'task',
    scope: 'tasks',
    hasUpdatedAt: true,
    completesOnDone: true,
    fields: {
      venture_id: { type: 'ref', table: 'ventures', required: true },
      project_id: { type: 'ref', table: 'projects' },
      milestone_id: { type: 'ref', table: 'milestones' },
      title: { type: 'text', max: 300, required: true },
      status: { type: 'enum', values: ['todo', 'doing', 'done'] },
      priority: PRIORITY,
      filter_tag: { type: 'enum', values: ['revenue', 'systems', 'brand', 'workload'], optional: true },
      due_date: { type: 'date' },
      notes: NOTES,
    },
    children: [],
  },
  // The ordered steps of an engagement (e.g. M0 Signed ... M5 Retainer). Guarded by project permissions.
  milestones: {
    one: 'milestone',
    scope: 'projects',
    hasUpdatedAt: true,
    completesOnDone: true,
    fields: {
      project_id: { type: 'ref', table: 'projects', required: true },
      title: { type: 'text', max: 200, required: true },
      position: { type: 'int', min: 0, max: 9999 },
      status: { type: 'enum', values: ['todo', 'doing', 'done'] },
      due_date: { type: 'date' },
      met_when: { type: 'text', max: 1000 },
      notes: NOTES,
    },
    children: [{ table: 'tasks', column: 'milestone_id', one: 'task', many: 'tasks' }],
  },
  // A running history per client: calls, meetings, decisions, links. Guarded by client permissions.
  client_notes: {
    one: 'client log entry',
    scope: 'clients',
    hasUpdatedAt: true,
    fields: {
      client_id: { type: 'ref', table: 'clients', required: true },
      kind: { type: 'enum', values: NOTE_KINDS },
      title: { type: 'text', max: 200, required: true },
      body: NOTES,
      url: { type: 'url', max: 500 },
      happened_on: { type: 'date' },
    },
    children: [],
  },
};

export const isTableName = (s: string | undefined): s is TableName =>
  !!s && (TABLE_NAMES as string[]).includes(s);

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

// The biggest money amount we store: $1 billion, in cents. Keeps totals (like the
// dashboard's) far away from the database's number limits.
export const MAX_CENTS = 100_000_000_000;

// Result of checking one value: either the value to store, or a problem sentence.
type Check = { ok: true; value: string | number | null } | { ok: false; problem: string };
const ok = (value: string | number | null): Check => ({ ok: true, value });
const bad = (problem: string): Check => ({ ok: false, problem });

const isRequired = (f: Field) =>
  f.type === 'slug' || ((f.type === 'text' || f.type === 'ref') && !!f.required);

/** Character count that treats an emoji as one character. */
const charCount = (s: string) => [...s].length;

/** Accepts 3 or "3" (whole numbers only). Returns undefined for anything else. */
export function toInteger(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : undefined;
  if (typeof raw === 'string' && /^-?\d{1,15}$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/** True for a real calendar date written YYYY-MM-DD (so 2026-02-30 is refused). */
export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  return d <= days;
}

/**
 * Checks one incoming value against its column rule.
 * Strings are trimmed. An empty string (or null) on an optional column becomes null.
 */
export function checkValue(f: Field, raw: unknown): Check {
  // Normalise: trim strings, and treat "" like null.
  let v: unknown = typeof raw === 'string' ? raw.trim() : raw;
  if (v === '') v = null;

  if (v === null || v === undefined) {
    if (isRequired(f)) return bad('is required');
    switch (f.type) {
      case 'enum':
        return f.optional ? ok(null) : bad(`must be one of: ${f.values.join(', ')}`);
      case 'priority':
        return bad('must be 1 (high), 2 (medium) or 3 (low)');
      default:
        return ok(null);
    }
  }

  switch (f.type) {
    case 'text':
    case 'email': {
      if (typeof v !== 'string') return bad('must be text');
      if (charCount(v) > f.max) return bad(`must be at most ${f.max} characters`);
      if (f.type === 'email' && !v.includes('@')) return bad('must be an email address (it needs an @)');
      return ok(v);
    }
    case 'slug':
      if (typeof v !== 'string' || !SLUG.test(v)) {
        return bad('must be 2 to 63 characters: lowercase letters, digits and hyphens, not starting with a hyphen');
      }
      return ok(v);
    case 'enum':
      if (typeof v !== 'string' || !f.values.includes(v)) return bad(`must be one of: ${f.values.join(', ')}`);
      return ok(v);
    case 'priority': {
      const n = toInteger(v);
      if (n === undefined || n < 1 || n > 3) return bad('must be 1 (high), 2 (medium) or 3 (low)');
      return ok(n);
    }
    case 'cents': {
      const n = toInteger(v);
      if (n === undefined || n < 0) return bad('must be a whole number of cents, 0 or more');
      if (n > MAX_CENTS) return bad('must be at most 100000000000 cents ($1 billion)');
      return ok(n);
    }
    case 'date':
      if (typeof v !== 'string' || !isRealDate(v)) return bad('must be a real date written YYYY-MM-DD');
      return ok(v);
    case 'int': {
      const n = toInteger(v);
      if (n === undefined || n < f.min || n > f.max) return bad(`must be a whole number from ${f.min} to ${f.max}`);
      return ok(n);
    }
    case 'url': {
      if (typeof v !== 'string') return bad('must be text');
      if (charCount(v) > f.max) return bad(`must be at most ${f.max} characters`);
      let u: URL | undefined;
      try { u = new URL(v); } catch { /* not a URL */ }
      if (!u || u.protocol !== 'https:' || /\s/.test(v)) return bad('must be a link starting with https://');
      return ok(v);
    }
    case 'ref': {
      const n = toInteger(v);
      if (n === undefined || n < 1) return bad('must be the id of an existing record (a whole number)');
      return ok(n);
    }
  }
}

/**
 * Picks the writable columns out of a request body and checks each one.
 * On create, required columns that are missing are reported too.
 * Returns the cleaned values and a map of column -> problem.
 * Foreign key existence is checked separately (it needs the database).
 */
export function validateBody(
  table: TableName,
  body: Record<string, unknown>,
  mode: 'create' | 'update'
): { values: Record<string, string | number | null>; fields: Record<string, string>; sent: number } {
  const values: Record<string, string | number | null> = {};
  const fields: Record<string, string> = {};
  let sent = 0;
  for (const [col, rule] of Object.entries(TABLES[table].fields)) {
    if (!Object.hasOwn(body, col)) {
      if (mode === 'create' && isRequired(rule)) fields[col] = 'is required';
      continue;
    }
    sent++;
    const res = checkValue(rule, body[col]);
    if (res.ok) values[col] = res.value;
    else fields[col] = res.problem;
  }
  return { values, fields, sent };
}
