// Migrations: start from the schema that was live before the revamp (projects.phase
// NOT NULL DEFAULT 'plan', no activity_log.actor, no d1_migrations table), fill it
// with linked rows, run migrations/ exactly as the tests' setup does, and check
// that every row, id, phase and link survived.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { create, get, patch } from './helpers';

// The live schema before the revamp (same statements as 0001_baseline.sql, which
// was written down from the live database).
const LIVE_SCHEMA = [
  `CREATE TABLE ventures (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE clients (id INTEGER PRIMARY KEY AUTOINCREMENT, venture_id INTEGER REFERENCES ventures(id), name TEXT NOT NULL, contact_name TEXT, email TEXT, phone TEXT, stage TEXT NOT NULL DEFAULT 'lead', source TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, venture_id INTEGER REFERENCES ventures(id), client_id INTEGER REFERENCES clients(id), name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning', priority INTEGER NOT NULL DEFAULT 3, value_cents INTEGER, start_date TEXT, due_date TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), phase TEXT NOT NULL DEFAULT 'plan')`,
  `CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER REFERENCES projects(id), venture_id INTEGER REFERENCES ventures(id), title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'todo', priority INTEGER NOT NULL DEFAULT 3, filter_tag TEXT, due_date TEXT, completed_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX idx_clients_stage ON clients(stage)`,
  `CREATE INDEX idx_projects_status ON projects(status)`,
  `CREATE INDEX idx_tasks_status_due ON tasks(status, due_date)`,
  `CREATE INDEX idx_tasks_project ON tasks(project_id)`,
  `CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), label TEXT NOT NULL, amount_cents INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'unpaid', due_date TEXT, paid_at TEXT, square_url TEXT, square_invoice_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE portal_links (token TEXT PRIMARY KEY, client_id INTEGER NOT NULL UNIQUE REFERENCES clients(id), created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX idx_payments_project ON payments(project_id)`,
  `CREATE INDEX idx_payments_square ON payments(square_invoice_id)`,
];

// Live-like data: ids with gaps (deleted rows), every phase, links between tables.
const LIVE_DATA = [
  `INSERT INTO ventures (id, slug, name) VALUES (1,'becs','BE Consulting Solutions'),(2,'leaa','Lane Ellis Apparel Agency Co.'),(3,'blnks','BLNKS'),(4,'me-and-them','ME & THEM / M3 & TH3M'),(5,'4freq','4FREQ'),(6,'be-university','BE University'),(7,'tethr','TETHR')`,
  `INSERT INTO clients (id, venture_id, name, email, stage) VALUES (3, 1, 'Acme', 'jo@acme.test', 'proposal'), (8, 2, 'Bolt', NULL, 'lead')`,
  `INSERT INTO projects (id, venture_id, client_id, name, status, value_cents, phase) VALUES
     (5, 1, 3, 'Plan project', 'active', 100000, 'plan'),
     (6, 1, 3, 'Evolve project', 'planning', 2500, 'evolve'),
     (9, 1, NULL, 'Succeed project', 'done', NULL, 'succeed'),
     (12, 2, 8, 'Odd phase project', 'paused', 0, 'launch')`,
  `INSERT INTO projects (id, venture_id, name) VALUES (14, 2, 'Default phase project')`,
  `INSERT INTO tasks (id, project_id, venture_id, title, status, completed_at) VALUES
     (20, 5, 1, 'Task on plan', 'todo', NULL),
     (21, 6, 1, 'Task on evolve', 'done', '2026-09-30 10:00:00'),
     (22, 12, 2, 'Task on odd', 'doing', NULL),
     (23, NULL, 3, 'Loose task', 'todo', NULL)`,
  `INSERT INTO payments (id, project_id, label, amount_cents) VALUES (2, 5, 'Deposit', 50000), (3, 9, 'Final', 10000)`,
  `INSERT INTO portal_links (token, client_id) VALUES ('tok-acme', 3)`,
  `INSERT INTO activity_log (id, entity_type, entity_id, action, detail) VALUES (40, 'tasks', 20, 'created', '{"title":"Task on plan"}')`,
  // Deleted rows leave the AUTOINCREMENT counter higher than the highest id.
  `UPDATE sqlite_sequence SET seq = 30 WHERE name = 'projects'`,
];

async function buildLiveDatabase() {
  await reset(); // wipe what the shared setup built
  await env.DB.batch(LIVE_SCHEMA.map((s) => env.DB.prepare(s)));
  await env.DB.batch(LIVE_DATA.map((s) => env.DB.prepare(s)));
}

const all = async <T = Record<string, unknown>>(sql: string) => (await env.DB.prepare(sql).all<T>()).results;

describe('migrating the live database', () => {
  beforeEach(async () => {
    await buildLiveDatabase();
  });

  it('starts from the live shape: phase required with default plan, no actor column', async () => {
    const cols = await all<{ name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(projects)');
    expect(cols.find((c) => c.name === 'phase')).toMatchObject({ notnull: 1, dflt_value: "'plan'" });
    const logCols = await all<{ name: string }>('PRAGMA table_info(activity_log)');
    expect(logCols.map((c) => c.name)).not.toContain('actor');
  });

  it('applies both migrations and records them', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const done = await all<{ name: string }>('SELECT name FROM d1_migrations ORDER BY id');
    expect(done.map((m) => m.name)).toEqual(['0001_baseline.sql', '0002_revamp.sql']);
  });

  it('keeps every row and id in every table', async () => {
    const before: Record<string, unknown[]> = {};
    for (const t of ['ventures', 'clients', 'tasks', 'payments', 'portal_links']) before[t] = await all(`SELECT * FROM ${t} ORDER BY 1`);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    for (const t of Object.keys(before)) expect(await all(`SELECT * FROM ${t} ORDER BY 1`), t).toEqual(before[t]);
    expect((await all<{ id: number }>('SELECT id FROM projects ORDER BY id')).map((p) => p.id)).toEqual([5, 6, 9, 12, 14]);
    expect(await all('SELECT id, entity_type, entity_id, action, detail, actor FROM activity_log')).toEqual([
      { id: 40, entity_type: 'tasks', entity_id: 20, action: 'created', detail: '{"title":"Task on plan"}', actor: null },
    ]);
  });

  it('keeps every project column value apart from phase', async () => {
    const cols = 'id, venture_id, client_id, name, status, priority, value_cents, start_date, due_date, notes, created_at, updated_at';
    const before = await all(`SELECT ${cols} FROM projects ORDER BY id`);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await all(`SELECT ${cols} FROM projects ORDER BY id`)).toEqual(before);
  });

  it('keeps plan, evolve and succeed, and clears a phase that is not one of them', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await all('SELECT id, phase FROM projects ORDER BY id')).toEqual([
      { id: 5, phase: 'plan' },
      { id: 6, phase: 'evolve' },
      { id: 9, phase: 'succeed' },
      { id: 12, phase: null },
      { id: 14, phase: 'plan' },
    ]);
  });

  it('leaves every link between tables valid', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await all('PRAGMA foreign_key_check')).toEqual([]);
    expect(await all('SELECT t.id, p.name FROM tasks t JOIN projects p ON p.id = t.project_id ORDER BY t.id')).toEqual([
      { id: 20, name: 'Plan project' },
      { id: 21, name: 'Evolve project' },
      { id: 22, name: 'Odd phase project' },
    ]);
    expect(await all('SELECT pay.id, p.name FROM payments pay JOIN projects p ON p.id = pay.project_id ORDER BY pay.id')).toEqual([
      { id: 2, name: 'Plan project' },
      { id: 3, name: 'Succeed project' },
    ]);
  });

  it('makes phase optional, with no default, limited to plan / evolve / succeed', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const cols = await all<{ name: string; notnull: number; dflt_value: string | null }>('PRAGMA table_info(projects)');
    expect(cols.find((c) => c.name === 'phase')).toMatchObject({ notnull: 0, dflt_value: null });
    expect(cols.map((c) => c.name)).not.toContain('phase_old');
    expect(cols[cols.length - 1].name).toBe('phase');

    await env.DB.prepare("INSERT INTO projects (venture_id, name) VALUES (1, 'No phase')").run();
    expect((await env.DB.prepare("SELECT phase FROM projects WHERE name = 'No phase'").first())?.phase).toBeNull();
    await expect(
      env.DB.prepare("INSERT INTO projects (venture_id, name, phase) VALUES (1, 'Bad', 'launch')").run()
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('keeps the project id counter, so new projects never reuse an old id', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const p = await create('projects', { venture_id: 1, name: 'After migration' });
    expect(p.id).toBe(31);
  });

  it('adds the actor column and the new indexes', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const logCols = await all<{ name: string }>('PRAGMA table_info(activity_log)');
    expect(logCols.map((c) => c.name)).toContain('actor');
    const idx = (await all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")).map((i) => i.name);
    for (const name of [
      'idx_clients_stage',
      'idx_projects_status',
      'idx_tasks_status_due',
      'idx_tasks_project',
      'idx_payments_project',
      'idx_payments_square',
      'idx_tasks_venture_status',
      'idx_clients_venture',
      'idx_projects_venture',
      'idx_projects_client',
      'idx_activity_entity',
    ]) {
      expect(idx, name).toContain(name);
    }
  });

  it('is safe to run again: nothing changes the second time', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const before = await all('SELECT * FROM projects ORDER BY id');
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await all('SELECT * FROM projects ORDER BY id')).toEqual(before);
    expect(await all('SELECT name FROM d1_migrations')).toHaveLength(2);
  });

  it('serves the migrated data through the API, and blocked deletes still count payments', async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect((await get('/api/projects/6')).body.data).toMatchObject({ name: 'Evolve project', phase: 'evolve' });
    expect((await patch('/api/projects/12', { phase: 'succeed' })).body.data.phase).toBe('succeed');
    const r = await (await import('./helpers')).del('/api/projects/9');
    expect(r.status).toBe(409);
    expect(r.body.message).toBe('This project still has 1 payment. Delete or move them first.');
  });
});

describe('a fresh database built from migrations', () => {
  it('has the seven ventures and the new phase rule', async () => {
    expect((await all<{ slug: string }>('SELECT slug FROM ventures ORDER BY id')).map((v) => v.slug)).toEqual([
      'becs',
      'leaa',
      'blnks',
      'me-and-them',
      '4freq',
      'be-university',
      'tethr',
    ]);
    const cols = await all<{ name: string; notnull: number }>('PRAGMA table_info(projects)');
    expect(cols.find((c) => c.name === 'phase')?.notnull).toBe(0);
  });
});
