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

    it('reads the whole list page by page with ?offset=, with no row twice and none missed', async () => {
      for (let i = 1; i <= 5; i++) await create(table, minimal(table, i));
      const all = (await get(`/api/${table}?limit=500`)).body.data.map((x: { id: number }) => x.id);
      const paged: number[] = [];
      for (let offset = 0; offset < all.length + 2; offset += 2) {
        const r = await get(`/api/${table}?limit=2&offset=${offset}`);
        expect(r.status).toBe(200);
        paged.push(...r.body.data.map((x: { id: number }) => x.id));
      }
      expect(paged).toEqual(all);
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

// Lists stop at 500 rows per request. ?offset= skips rows, so a caller (like the
// console) can read a longer list in pages of 500.
describe('paging through long lists with ?offset= (tasks)', () => {
  /** Puts n tasks straight into the database (fast). Every third one is done; venture 1 or 2 alternately. */
  async function seedTasks(n: number) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      stmts.push(
        env.DB.prepare('INSERT INTO tasks (venture_id, title, status) VALUES (?, ?, ?)').bind(
          (i % 2) + 1,
          `Seeded ${i}`,
          i % 3 === 0 ? 'done' : 'todo'
        )
      );
    }
    await env.DB.batch(stmts);
  }
  const idsOf = (r: { body: { data: { id: number }[] } }) => r.body.data.map((x) => x.id);
  const allIds = async (where = '') =>
    (await env.DB.prepare(`SELECT id FROM tasks ${where} ORDER BY id DESC`).all<{ id: number }>()).results.map(
      (x) => x.id
    );

  it('reads 1,234 tasks in pages of 500 with no overlap and no gaps, newest first', async () => {
    await seedTasks(1234);
    const p1 = idsOf(await get('/api/tasks?limit=500&offset=0'));
    const p2 = idsOf(await get('/api/tasks?limit=500&offset=500'));
    const p3 = idsOf(await get('/api/tasks?limit=500&offset=1000'));
    expect([p1.length, p2.length, p3.length]).toEqual([500, 500, 234]);
    // Each page carries on exactly where the one before stopped.
    expect(Math.min(...p1)).toBeGreaterThan(Math.max(...p2));
    expect(Math.min(...p2)).toBeGreaterThan(Math.max(...p3));
    const joined = [...p1, ...p2, ...p3];
    expect(new Set(joined).size).toBe(1234);
    expect(joined).toEqual(await allIds());
  });

  it('gives the same page every time it is asked for', async () => {
    await seedTasks(700);
    const a = idsOf(await get('/api/tasks?limit=500&offset=500'));
    const b = idsOf(await get('/api/tasks?limit=500&offset=500'));
    expect(a).toHaveLength(200);
    expect(a).toEqual(b);
  });

  it('starts at the first row when there is no offset, or it is 0', async () => {
    await seedTasks(30);
    const plain = idsOf(await get('/api/tasks?limit=10'));
    expect(idsOf(await get('/api/tasks?limit=10&offset=0'))).toEqual(plain);
    expect(plain).toEqual((await allIds()).slice(0, 10));
  });

  it('uses the default page size of 100 when only ?offset= is sent', async () => {
    await seedTasks(250);
    const r = await get('/api/tasks?offset=100');
    expect(idsOf(r)).toEqual((await allIds()).slice(100, 200));
  });

  it('answers an empty list (not an error) for an offset past the end', async () => {
    await seedTasks(12);
    for (const offset of ['12', '13', '5000', '99999999999999999999']) {
      const r = await get(`/api/tasks?offset=${offset}`);
      expect(r.status, offset).toBe(200);
      expect(r.body.data, offset).toEqual([]);
    }
  });

  const junk: [string, number][] = [
    ['abc', 0],
    ['', 0],
    ['-5', 0],
    ['Infinity', 0],
    ['NaN', 0],
    ['2.9', 2],
    ['%207%20', 7],
  ];
  for (const [raw, expected] of junk) {
    it(`treats ?offset=${raw} as ${expected}`, async () => {
      await seedTasks(20);
      const r = await get(`/api/tasks?limit=5&offset=${raw}`);
      expect(r.status).toBe(200);
      expect(idsOf(r)).toEqual((await allIds()).slice(expected, expected + 5));
    });
  }

  it('combines ?offset= with filters: pages of done tasks in one venture', async () => {
    await seedTasks(1300);
    const want = await allIds("WHERE status = 'done' AND venture_id = 2");
    expect(want.length).toBeGreaterThan(200);
    const got: number[] = [];
    // At most 20 pages, so a broken offset fails the test instead of looping forever.
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = idsOf(await get(`/api/tasks?status=done&venture_id=2&limit=100&offset=${offset}`));
      got.push(...page);
      if (page.length < 100) break;
    }
    expect(got).toEqual(want);
  });

  it('still refuses a bad filter when an offset is sent', async () => {
    const r = await get('/api/tasks?status=bogus&offset=10');
    expectErrorShape(r, 400, 'invalid');
    expect(r.body.fields).toHaveProperty('status');
  });

  it('does not treat offset as a column filter on any table', async () => {
    for (const table of TABLE_NAMES) {
      const r = await get(`/api/${table}?offset=0`);
      expect(r.status, table).toBe(200);
    }
    // The seven seeded ventures, skipping the newest five.
    expect((await get('/api/ventures?offset=5')).body.data).toHaveLength(2);
  });
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
