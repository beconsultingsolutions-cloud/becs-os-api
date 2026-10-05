// Behaviour shared by all four tables: create, read, update, delete, lists,
// filters, limits, ordering, bad ids, wrong methods and bad bodies.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  TABLE_NAMES,
  call,
  count,
  create,
  del,
  expectErrorShape,
  get,
  minimal,
  patch,
  post,
  type TableName,
} from './helpers';

const one: Record<TableName, string> = { ventures: 'venture', clients: 'client', projects: 'project', tasks: 'task' };
const textField: Record<TableName, string> = { ventures: 'name', clients: 'name', projects: 'name', tasks: 'title' };

for (const table of TABLE_NAMES) {
  describe(`${table}: basic create, read, update, delete`, () => {
    it(`creates a ${one[table]} and answers 201 with the saved row`, async () => {
      const r = await post(`/api/${table}`, minimal(table));
      expect(r.status, r.text).toBe(201);
      expect(r.body.data).toMatchObject(minimal(table));
      expect(r.body.data.id).toBeTypeOf('number');
      expect(r.body.data.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      if (table === 'ventures') expect(r.body.data).not.toHaveProperty('updated_at');
      else expect(r.body.data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it(`reads one ${one[table]} back by id`, async () => {
      const row = await create(table, minimal(table));
      const r = await get(`/api/${table}/${row.id}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ data: row });
    });

    it(`answers 404 for a ${one[table]} that does not exist`, async () => {
      const r = await get(`/api/${table}/999999`);
      expectErrorShape(r, 404, 'not_found');
      expect(r.body.message).toBe(`There is no ${one[table]} with id 999999.`);
    });

    it(`changes only the fields sent in a PATCH`, async () => {
      const row = await create(table, { ...minimal(table), [table === 'ventures' ? 'description' : 'notes']: 'keep me' });
      const r = await patch(`/api/${table}/${row.id}`, { [textField[table]]: 'Renamed' });
      expect(r.status, r.text).toBe(200);
      expect(r.body.data[textField[table]]).toBe('Renamed');
      expect(r.body.data[table === 'ventures' ? 'description' : 'notes']).toBe('keep me');
      expect(r.body.data.id).toBe(row.id);
      expect(r.body.data.created_at).toBe(row.created_at);
      expect((await get(`/api/${table}/${row.id}`)).body.data[textField[table]]).toBe('Renamed');
    });

    it(`answers 404 when patching a ${one[table]} that does not exist, even with invalid fields`, async () => {
      expectErrorShape(await patch(`/api/${table}/999999`, { [textField[table]]: 'x' }), 404, 'not_found');
      expectErrorShape(await patch(`/api/${table}/999999`, { [textField[table]]: '' }), 404, 'not_found');
    });

    it(`deletes a ${one[table]} and then it is gone`, async () => {
      const row = await create(table, minimal(table));
      const r = await del(`/api/${table}/${row.id}`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ data: { id: row.id, deleted: true } });
      expectErrorShape(await get(`/api/${table}/${row.id}`), 404, 'not_found');
      expectErrorShape(await del(`/api/${table}/${row.id}`), 404, 'not_found');
    });

    it('ignores unknown fields in the body', async () => {
      const r = await post(`/api/${table}`, { ...minimal(table), favourite_colour: 'blue', __proto__x: 1 });
      expect(r.status).toBe(201);
      expect(r.body.data).not.toHaveProperty('favourite_colour');
    });

    it('does not let callers set id, created_at, updated_at or completed_at', async () => {
      const r = await post(`/api/${table}`, {
        ...minimal(table),
        id: 4242,
        created_at: '2000-01-01 00:00:00',
        updated_at: '2000-01-01 00:00:00',
        completed_at: '2000-01-01 00:00:00',
      });
      expect(r.status).toBe(201);
      expect(r.body.data.id).not.toBe(4242);
      expect(r.body.data.created_at).not.toBe('2000-01-01 00:00:00');
      if (table !== 'ventures') expect(r.body.data.updated_at).not.toBe('2000-01-01 00:00:00');
      if (table === 'tasks') expect(r.body.data.completed_at).toBeNull();

      const p = await patch(`/api/${table}/${r.body.data.id}`, { id: 1, created_at: '2000-01-01 00:00:00' });
      expectErrorShape(p, 400, 'empty_body');
    });

    it('refuses a body that is not JSON', async () => {
      expectErrorShape(await call(`/api/${table}`, { method: 'POST', rawBody: '{"name": ' }), 400, 'bad_json');
    });

    for (const [what, raw] of [
      ['a JSON array', '[1,2]'],
      ['a JSON number', '5'],
      ['a JSON string', '"hello"'],
      ['JSON null', 'null'],
      ['JSON true', 'true'],
    ] as const) {
      it(`refuses ${what} as the body`, async () => {
        expectErrorShape(await call(`/api/${table}`, { method: 'POST', rawBody: raw }), 400, 'bad_json');
      });
    }

    it('refuses an empty body on create and update', async () => {
      expectErrorShape(await call(`/api/${table}`, { method: 'POST', rawBody: '' }), 400, 'empty_body');
      expectErrorShape(await call(`/api/${table}`, { method: 'POST', rawBody: '   ' }), 400, 'empty_body');
      const row = await create(table, minimal(table));
      expectErrorShape(await call(`/api/${table}/${row.id}`, { method: 'PATCH', rawBody: '' }), 400, 'empty_body');
    });

    it('refuses a body with no fields it can save', async () => {
      expectErrorShape(await post(`/api/${table}`, {}), 400, 'empty_body');
      expectErrorShape(await post(`/api/${table}`, { nonsense: 1 }), 400, 'empty_body');
      const row = await create(table, minimal(table));
      expectErrorShape(await patch(`/api/${table}/${row.id}`, {}), 400, 'empty_body');
    });

    for (const bad of ['abc', '0', '-1', '1.5', '01', '1e3', '9999999999999999', '%20']) {
      it(`refuses the id "${bad}" in the address`, async () => {
        expectErrorShape(await get(`/api/${table}/${bad}`), 400, 'bad_id');
        expectErrorShape(await patch(`/api/${table}/${bad}`, { name: 'x' }), 400, 'bad_id');
        expectErrorShape(await del(`/api/${table}/${bad}`), 400, 'bad_id');
      });
    }

    it('refuses methods that are not allowed, and says which ones are', async () => {
      for (const m of ['PUT', 'PATCH', 'DELETE']) {
        const r = await call(`/api/${table}`, { method: m, body: {} });
        expectErrorShape(r, 405, 'method_not_allowed');
        expect(r.headers.get('Allow')).toBe('GET,POST');
      }
      for (const m of ['PUT', 'POST']) {
        const r = await call(`/api/${table}/1`, { method: m, body: {} });
        expectErrorShape(r, 405, 'method_not_allowed');
        expect(r.headers.get('Allow')).toBe('GET,PATCH,DELETE');
      }
    });

    it('answers 404 for a deeper path under the table', async () => {
      expectErrorShape(await get(`/api/${table}/1/extra`), 404, 'not_found');
    });

    it('lists rows newest first', async () => {
      const a = await create(table, minimal(table, 1));
      const b = await create(table, minimal(table, 2));
      const c = await create(table, minimal(table, 3));
      const r = await get(`/api/${table}`);
      expect(r.status).toBe(200);
      const ids = (r.body.data as { id: number }[]).map((x) => x.id);
      expect(ids.indexOf(c.id)).toBeLessThan(ids.indexOf(b.id));
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
      expect([...ids].sort((x, y) => y - x)).toEqual(ids);
    });

    it('honours ?limit=', async () => {
      for (let i = 1; i <= 4; i++) await create(table, minimal(table, i));
      expect((await get(`/api/${table}?limit=2`)).body.data).toHaveLength(2);
    });

    it('refuses a filter value that breaks the column rule', async () => {
      const col = table === 'ventures' ? 'status' : table === 'clients' ? 'stage' : 'status';
      const r = await get(`/api/${table}?${col}=nonsense`);
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.message).toBe('Some filters are not valid.');
      expect(r.body.fields).toHaveProperty(col);
    });
  });
}

describe('list limits (tasks)', () => {
  async function seedTasks(n: number) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      stmts.push(env.DB.prepare('INSERT INTO tasks (venture_id, title) VALUES (1, ?)').bind(`Seeded ${i}`));
    }
    await env.DB.batch(stmts);
  }

  it('returns 100 rows by default', async () => {
    await seedTasks(120);
    expect((await get('/api/tasks')).body.data).toHaveLength(100);
  });

  it('returns up to 500 rows and no more', async () => {
    await seedTasks(510);
    expect((await get('/api/tasks?limit=500')).body.data).toHaveLength(500);
    expect((await get('/api/tasks?limit=100000')).body.data).toHaveLength(500);
  });

  const cases: [string, number][] = [
    ['0', 1],
    ['-5', 1],
    ['2.9', 2],
    ['abc', 100],
    ['', 100],
    ['Infinity', 100],
  ];
  for (const [raw, expected] of cases) {
    it(`treats ?limit=${raw} as ${expected}`, async () => {
      await seedTasks(110);
      expect((await get(`/api/tasks?limit=${raw}`)).body.data).toHaveLength(expected);
    });
  }
});

describe('list filters', () => {
  it('filters tasks by status and venture', async () => {
    await create('tasks', { venture_id: 1, title: 'A', status: 'todo' });
    await create('tasks', { venture_id: 1, title: 'B', status: 'done' });
    await create('tasks', { venture_id: 2, title: 'C', status: 'todo' });
    const r = await get('/api/tasks?status=todo&venture_id=1');
    expect(r.body.data.map((t: { title: string }) => t.title)).toEqual(['A']);
    expect((await get('/api/tasks?venture_id=2')).body.data.map((t: { title: string }) => t.title)).toEqual(['C']);
  });

  it('accepts filter values with spaces around them', async () => {
    await create('tasks', { venture_id: 1, title: 'A', status: 'doing' });
    expect((await get('/api/tasks?status=%20doing%20')).body.data).toHaveLength(1);
  });

  it('filters by an exact text value', async () => {
    await create('clients', { venture_id: 1, name: 'Acme' });
    await create('clients', { venture_id: 1, name: 'Acme Two' });
    expect((await get('/api/clients?name=Acme')).body.data).toHaveLength(1);
  });

  it('matches rows with no value when the filter is empty', async () => {
    const p = await create('projects', { venture_id: 1, name: 'P' });
    await create('tasks', { venture_id: 1, title: 'loose' });
    await create('tasks', { venture_id: 1, title: 'in project', project_id: p.id });
    const r = await get('/api/tasks?project_id=');
    expect(r.body.data.map((t: { title: string }) => t.title)).toEqual(['loose']);
    expect((await get('/api/projects?phase=')).body.data).toHaveLength(1);
  });

  it('matches nothing when a required column is filtered on empty', async () => {
    await create('tasks', minimal('tasks'));
    const r = await get('/api/tasks?status=');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect((await get('/api/tasks?venture_id=')).body.data).toEqual([]);
  });

  it('refuses a non-number id filter and reports every bad filter', async () => {
    const r = await get('/api/tasks?venture_id=abc&priority=9&due_date=2026-02-30');
    expectErrorShape(r, 400, 'invalid');
    expect(Object.keys(r.body.fields).sort()).toEqual(['due_date', 'priority', 'venture_id']);
  });

  it('ignores query parameters that are not columns, including server-managed ones', async () => {
    await create('tasks', minimal('tasks'));
    expect((await get('/api/tasks?colour=red&completed_at=x&id=999')).body.data).toHaveLength(1);
  });

  it('accepts an integer filter given as "2"', async () => {
    await create('tasks', { venture_id: 1, title: 'A', priority: 2 });
    await create('tasks', { venture_id: 1, title: 'B', priority: 1 });
    expect((await get('/api/tasks?priority=2')).body.data.map((t: { title: string }) => t.title)).toEqual(['A']);
  });
});

describe('the database stays consistent', () => {
  it('writes nothing when validation fails', async () => {
    expect((await post('/api/tasks', { venture_id: 1, title: '' })).status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM tasks')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM activity_log')).toBe(0);
  });
});
