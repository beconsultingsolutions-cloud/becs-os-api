// The activity log: one row per create, update and delete, naming who did it.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { count, create, del, expectErrorShape, get, makeAppKey, minimal, patch, post } from './helpers';

interface LogRow {
  id: number;
  entity_type: string;
  entity_id: number;
  action: string;
  detail: string | null;
  actor: string | null;
  created_at: string;
}

const allLog = async () =>
  (await env.DB.prepare('SELECT * FROM activity_log ORDER BY id').all<LogRow>()).results;

describe('what gets logged', () => {
  it('logs a create with the saved fields and the master actor', async () => {
    const t = await create('tasks', { venture_id: 1, title: '  Call Jo  ', priority: '1', bogus: 'x' });
    const log = await allLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entity_type: 'tasks', entity_id: t.id, action: 'created', actor: 'master' });
    expect(typeof log[0].detail).toBe('string');
    expect(JSON.parse(log[0].detail!)).toEqual({ venture_id: 1, title: 'Call Jo', priority: 1 });
    expect(log[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('logs an update with only the fields that changed', async () => {
    const t = await create('tasks', { venture_id: 1, title: 'A', notes: 'same' });
    await patch(`/api/tasks/${t.id}`, { title: 'B', notes: 'same', priority: 3 });
    const log = await allLog();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ entity_id: t.id, action: 'updated', actor: 'master' });
    expect(JSON.parse(log[1].detail!)).toEqual({ title: 'B' });
  });

  it('includes the completion time in the log when a task is marked done', async () => {
    const t = await create('tasks', minimal('tasks'));
    const r = await patch(`/api/tasks/${t.id}`, { status: 'done' });
    const detail = JSON.parse((await allLog())[1].detail!);
    expect(detail).toEqual({ status: 'done', completed_at: r.body.data.completed_at });
  });

  it('logs a delete with a copy of the deleted row', async () => {
    const c = await create('clients', { venture_id: 1, name: 'Gone Ltd', email: 'a@b.c' });
    await del(`/api/clients/${c.id}`);
    const log = await allLog();
    expect(log[1]).toMatchObject({ entity_type: 'clients', entity_id: c.id, action: 'deleted', actor: 'master' });
    expect(JSON.parse(log[1].detail!)).toEqual(c);
  });

  it('writes nothing and logs nothing for a PATCH that changes nothing', async () => {
    const t = await create('tasks', { venture_id: 1, title: 'Same', priority: 2 });
    await env.DB.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").bind(t.id).run();
    const r = await patch(`/api/tasks/${t.id}`, { title: ' Same ', priority: '2', status: 'todo' });
    expect(r.status).toBe(200);
    expect(r.body.data.updated_at).toBe('2020-01-01 00:00:00');
    expect(await allLog()).toHaveLength(1);
  });

  it('stamps updated_at on a real change', async () => {
    const t = await create('tasks', minimal('tasks'));
    await env.DB.prepare("UPDATE tasks SET updated_at = '2020-01-01 00:00:00' WHERE id = ?").bind(t.id).run();
    const r = await patch(`/api/tasks/${t.id}`, { title: 'New' });
    expect(r.body.data.updated_at).not.toBe('2020-01-01 00:00:00');
  });

  it('names an app key caller as app:<name>', async () => {
    const key = await makeAppKey(['clients:write'], 'leaa-portal');
    const r = await post('/api/clients', minimal('clients'), { key });
    expect(r.status).toBe(201);
    expect((await allLog())[0].actor).toBe('app:leaa-portal');
  });

  it('logs every table', async () => {
    const v = await create('ventures', minimal('ventures'));
    const c = await create('clients', minimal('clients'));
    const p = await create('projects', minimal('projects'));
    const t = await create('tasks', minimal('tasks'));
    const log = await allLog();
    expect(log.map((l) => [l.entity_type, l.entity_id])).toEqual([
      ['ventures', v.id],
      ['clients', c.id],
      ['projects', p.id],
      ['tasks', t.id],
    ]);
  });

  it('logs nothing for refused requests', async () => {
    await post('/api/tasks', { venture_id: 999, title: 'x' });
    await patch('/api/tasks/999', { title: 'x' });
    await del('/api/tasks/999');
    await post('/api/tasks', { title: 'x' }, { key: 'wrong' });
    expect(await count('SELECT COUNT(*) AS n FROM activity_log')).toBe(0);
  });
});

describe('GET /api/activity', () => {
  it('lists entries newest first with the documented columns', async () => {
    const t = await create('tasks', minimal('tasks'));
    await patch(`/api/tasks/${t.id}`, { title: 'B' });
    const r = await get('/api/activity');
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: LogRow) => x.action)).toEqual(['updated', 'created']);
    expect(Object.keys(r.body.data[0]).sort()).toEqual(
      ['action', 'actor', 'created_at', 'detail', 'entity_id', 'entity_type', 'id'].sort()
    );
  });

  it('filters by entity_type and entity_id', async () => {
    const t1 = await create('tasks', minimal('tasks', 1));
    const t2 = await create('tasks', minimal('tasks', 2));
    const c = await create('clients', minimal('clients'));
    expect((await get('/api/activity?entity_type=tasks')).body.data).toHaveLength(2);
    expect((await get('/api/activity?entity_type=clients')).body.data[0].entity_id).toBe(c.id);
    const one = await get(`/api/activity?entity_type=tasks&entity_id=${t2.id}`);
    expect(one.body.data.map((x: LogRow) => x.entity_id)).toEqual([t2.id]);
    expect((await get(`/api/activity?entity_id=${t1.id}`)).body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores empty filters', async () => {
    await create('tasks', minimal('tasks'));
    expect((await get('/api/activity?entity_type=&entity_id=')).body.data).toHaveLength(1);
  });

  for (const [q, field] of [
    ['entity_type=payments', 'entity_type'],
    ['entity_type=activity_log', 'entity_type'],
    ['entity_id=abc', 'entity_id'],
    ['entity_id=0', 'entity_id'],
    ['entity_id=-3', 'entity_id'],
    ['entity_id=1.5', 'entity_id'],
  ]) {
    it(`refuses the filter ?${q}`, async () => {
      const r = await get(`/api/activity?${q}`);
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields).toHaveProperty(field);
    });
  }

  async function seedLog(n: number) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      stmts.push(
        env.DB.prepare("INSERT INTO activity_log (entity_type, entity_id, action, actor) VALUES ('tasks', ?, 'created', 'master')").bind(i + 1)
      );
    }
    await env.DB.batch(stmts);
  }

  it('returns 50 entries by default', async () => {
    await seedLog(60);
    expect((await get('/api/activity')).body.data).toHaveLength(50);
  });

  it('returns at most 200 entries', async () => {
    await seedLog(210);
    expect((await get('/api/activity?limit=200')).body.data).toHaveLength(200);
    expect((await get('/api/activity?limit=999')).body.data).toHaveLength(200);
  });

  it('treats a junk or too-small limit sensibly', async () => {
    await seedLog(60);
    expect((await get('/api/activity?limit=0')).body.data).toHaveLength(1);
    expect((await get('/api/activity?limit=7')).body.data).toHaveLength(7);
    expect((await get('/api/activity?limit=lots')).body.data).toHaveLength(50);
  });

  it('shows old entries with no actor as null', async () => {
    await env.DB.prepare("INSERT INTO activity_log (entity_type, entity_id, action) VALUES ('tasks', 1, 'created')").run();
    expect((await get('/api/activity')).body.data[0].actor).toBeNull();
  });

  it('refuses methods other than GET', async () => {
    expectErrorShape(await post('/api/activity', {}), 405, 'method_not_allowed');
  });
});

describe('app keys only see the activity of tables they can read', () => {
  /** One logged change on each table, including a deleted client with private details. */
  async function seed() {
    const v = await create('ventures', minimal('ventures'));
    const c = await create('clients', { venture_id: 1, name: 'Secret Client', email: 'secret@client.example', notes: 'private' });
    const p = await create('projects', minimal('projects'));
    const t = await create('tasks', minimal('tasks'));
    await del(`/api/clients/${c.id}`);
    return { v, c, p, t };
  }
  const types = (r: { body: { data: LogRow[] } }) => [...new Set(r.body.data.map((x) => x.entity_type))].sort();

  it('shows nothing to a key with "activity:read" and no table read scopes', async () => {
    await seed();
    const key = await makeAppKey(['activity:read']);
    const r = await get('/api/activity', { key });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(r.text).not.toContain('secret@client.example');
  });

  it('does not count write scopes as read scopes', async () => {
    await seed();
    const key = await makeAppKey(['activity:read', 'clients:write', 'tasks:write']);
    expect((await get('/api/activity', { key })).body.data).toEqual([]);
  });

  it('shows only the tasks activity to a key with "tasks:read"', async () => {
    await seed();
    const key = await makeAppKey(['activity:read', 'tasks:read']);
    const r = await get('/api/activity', { key });
    expect(r.status).toBe(200);
    expect(types(r)).toEqual(['tasks']);
    expect(r.text).not.toContain('Secret Client');
  });

  it('shows the activity of every table the key can read, and no others', async () => {
    await seed();
    const key = await makeAppKey(['activity:read', 'tasks:read', 'clients:read']);
    const r = await get('/api/activity', { key });
    expect(types(r)).toEqual(['clients', 'tasks']);
    // Both the create and the delete of the client.
    expect(r.body.data.filter((x: LogRow) => x.entity_type === 'clients').map((x: LogRow) => x.action)).toEqual([
      'deleted',
      'created',
    ]);
  });

  it('shows everything to a key that can read all four tables', async () => {
    await seed();
    const key = await makeAppKey(['activity:read', 'ventures:read', 'clients:read', 'projects:read', 'tasks:read']);
    const r = await get('/api/activity', { key });
    expect(types(r)).toEqual(['clients', 'projects', 'tasks', 'ventures']);
    expect(r.body.data).toHaveLength((await get('/api/activity')).body.data.length);
  });

  it('refuses ?entity_type= for a table the key cannot read', async () => {
    await seed();
    const key = await makeAppKey(['activity:read', 'tasks:read']);
    const r = await get('/api/activity?entity_type=clients', { key });
    expectErrorShape(r, 403, 'forbidden');
    expect(r.body.message).toContain('clients:read');
    expect(r.text).not.toContain('Secret Client');
  });

  it('refuses ?entity_type= to a key with no table read scopes at all', async () => {
    await seed();
    const key = await makeAppKey(['activity:read']);
    expectErrorShape(await get('/api/activity?entity_type=tasks', { key }), 403, 'forbidden');
  });

  it('allows ?entity_type= for a table the key can read', async () => {
    const { t } = await seed();
    const key = await makeAppKey(['activity:read', 'tasks:read']);
    const r = await get('/api/activity?entity_type=tasks', { key });
    expect(r.status).toBe(200);
    expect(r.body.data.map((x: LogRow) => x.entity_id)).toEqual([t.id]);
  });

  it('keeps ?entity_id= limited to the tables the key can read', async () => {
    // Client 1 and task 1 share the same id.
    const c = await create('clients', minimal('clients'));
    const t = await create('tasks', minimal('tasks'));
    expect(c.id).toBe(t.id);
    const key = await makeAppKey(['activity:read', 'tasks:read']);
    const r = await get(`/api/activity?entity_id=${t.id}`, { key });
    expect(r.body.data.map((x: LogRow) => x.entity_type)).toEqual(['tasks']);
  });

  it('still answers 400 for a bad filter from an app key', async () => {
    const key = await makeAppKey(['activity:read']);
    expectErrorShape(await get('/api/activity?entity_type=payments', { key }), 400, 'invalid');
  });

  it('still lets the master key see every table', async () => {
    await seed();
    expect(types(await get('/api/activity'))).toEqual(['clients', 'projects', 'tasks', 'ventures']);
  });
});
