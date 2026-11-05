// Every rule in the "Data model" tables of docs/SPEC.md, column by column.
import { describe, expect, it } from 'vitest';
import { create, expectErrorShape, get, minimal, patch, post, type TableName } from './helpers';

/** POSTs minimal(table) plus the given fields. Each venture gets its own slug. */
let n = 0;
const tryCreate = (table: TableName, fields: Record<string, unknown>) =>
  post(`/api/${table}`, { ...minimal(table, ++n), ...fields });

async function accepts(table: TableName, fields: Record<string, unknown>) {
  const r = await tryCreate(table, fields);
  expect(r.status, `${JSON.stringify(fields)} -> ${r.text}`).toBe(201);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return r.body.data as any;
}

async function refuses(table: TableName, fields: Record<string, unknown>, column = Object.keys(fields)[0]) {
  const r = await tryCreate(table, fields);
  expectErrorShape(r, 400, 'invalid');
  expect(r.body.fields, r.text).toHaveProperty(column);
  expect(typeof r.body.fields[column]).toBe('string');
  return r.body.fields[column] as string;
}

const s = (n: number, ch = 'x') => ch.repeat(n);

// --- shared rule families ---------------------------------------------------------

function textRule(table: TableName, col: string, max: number, required: boolean) {
  it(`${col}: accepts exactly ${max} characters`, async () => {
    expect((await accepts(table, { [col]: s(max) }))[col]).toBe(s(max));
  });
  it(`${col}: refuses ${max + 1} characters`, async () => {
    expect(await refuses(table, { [col]: s(max + 1) })).toBe(`must be at most ${max} characters`);
  });
  it(`${col}: counts an emoji as one character`, async () => {
    expect((await accepts(table, { [col]: s(max, '😀') }))[col]).toBe(s(max, '😀'));
  });
  it(`${col}: trims spaces around the text`, async () => {
    expect((await accepts(table, { [col]: '  hello  ' }))[col]).toBe('hello');
  });
  it(`${col}: refuses a number instead of text`, async () => {
    expect(await refuses(table, { [col]: 5 })).toBe('must be text');
  });
  if (required) {
    for (const empty of ['', '   ', null]) {
      it(`${col}: is required, so ${JSON.stringify(empty)} is refused`, async () => {
        expect(await refuses(table, { [col]: empty })).toBe('is required');
      });
    }
    it(`${col}: is required, so leaving it out is refused`, async () => {
      const body = minimal(table);
      delete body[col];
      const r = await post(`/api/${table}`, { ...body, notes: 'n', description: 'd' });
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields[col]).toBe('is required');
    });
    it(`${col}: cannot be emptied later`, async () => {
      const row = await create(table, minimal(table));
      const r = await patch(`/api/${table}/${row.id}`, { [col]: '' });
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields[col]).toBe('is required');
    });
  } else {
    it(`${col}: stores an empty string as null`, async () => {
      expect((await accepts(table, { [col]: '' }))[col]).toBeNull();
      expect((await accepts(table, { [col]: '   ' }))[col]).toBeNull();
      expect((await accepts(table, { [col]: null }))[col]).toBeNull();
    });
    it(`${col}: can be cleared later with an empty string`, async () => {
      const row = await create(table, { ...minimal(table), [col]: 'something' });
      expect((await patch(`/api/${table}/${row.id}`, { [col]: '' })).body.data[col]).toBeNull();
    });
  }
}

function enumRule(table: TableName, col: string, values: string[], def: string | null, refused: string) {
  for (const v of values) {
    it(`${col}: accepts "${v}"`, async () => {
      expect((await accepts(table, { [col]: v }))[col]).toBe(v);
    });
  }
  it(`${col}: defaults to ${def === null ? 'null' : `"${def}"`} when left out`, async () => {
    expect((await accepts(table, {}))[col]).toBe(def);
  });
  it(`${col}: refuses the made-up value "${refused}"`, async () => {
    expect(await refuses(table, { [col]: refused })).toBe(`must be one of: ${values.join(', ')}`);
  });
  it(`${col}: refuses a value in the wrong letter case`, async () => {
    await refuses(table, { [col]: values[0].toUpperCase() });
  });
  it(`${col}: refuses a number`, async () => {
    await refuses(table, { [col]: 1 });
  });
  it(`${col}: trims spaces around the value`, async () => {
    expect((await accepts(table, { [col]: `  ${values[0]}  ` }))[col]).toBe(values[0]);
  });
  if (def === null) {
    it(`${col}: stores null or an empty string as null`, async () => {
      expect((await accepts(table, { [col]: null }))[col]).toBeNull();
      expect((await accepts(table, { [col]: '' }))[col]).toBeNull();
    });
  } else {
    for (const empty of [null, '']) {
      it(`${col}: refuses ${JSON.stringify(empty)} (leave it out to get the default)`, async () => {
        await refuses(table, { [col]: empty });
        const row = await create(table, minimal(table));
        expectErrorShape(await patch(`/api/${table}/${row.id}`, { [col]: empty }), 400, 'invalid');
      });
    }
  }
}

function priorityRule(table: TableName) {
  for (const v of [1, 2, 3]) {
    it(`priority: accepts ${v}`, async () => {
      expect((await accepts(table, { priority: v })).priority).toBe(v);
    });
  }
  it('priority: accepts the text "2" and stores the number 2', async () => {
    expect((await accepts(table, { priority: '2' })).priority).toBe(2);
    expect((await accepts(table, { priority: ' 1 ' })).priority).toBe(1);
  });
  it('priority: defaults to 3 (low)', async () => {
    expect((await accepts(table, {})).priority).toBe(3);
  });
  for (const bad of [0, 4, -1, 1.5, '1.5', true, false, 'high', null, '', [1], { v: 1 }]) {
    it(`priority: refuses ${JSON.stringify(bad)}`, async () => {
      expect(await refuses(table, { priority: bad })).toBe('must be 1 (high), 2 (medium) or 3 (low)');
    });
  }
}

function dateRule(table: TableName, col: string) {
  for (const good of ['2026-10-04', '2028-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) {
    it(`${col}: accepts the real date ${good}`, async () => {
      expect((await accepts(table, { [col]: good }))[col]).toBe(good);
    });
  }
  for (const bad of [
    '2027-02-29',
    '1900-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '2026-1-5',
    '26-01-01',
    '2026/01/01',
    '2026-01-01T00:00:00Z',
    'tomorrow',
  ]) {
    it(`${col}: refuses "${bad}"`, async () => {
      expect(await refuses(table, { [col]: bad })).toBe('must be a real date written YYYY-MM-DD');
    });
  }
  it(`${col}: refuses a number`, async () => {
    await refuses(table, { [col]: 20260101 });
  });
  it(`${col}: is optional (empty string or null stores null)`, async () => {
    expect((await accepts(table, { [col]: '' }))[col]).toBeNull();
    expect((await accepts(table, { [col]: null }))[col]).toBeNull();
    expect((await accepts(table, {}))[col]).toBeNull();
  });
}

function refRule(table: TableName, col: string, target: string, required: boolean) {
  it(`${col}: refuses an id that does not exist`, async () => {
    expect(await refuses(table, { [col]: 999 })).toBe(`there is no ${target} with id 999`);
  });
  it(`${col}: accepts an id given as text, like "1"`, async () => {
    const value = col === 'venture_id' ? 1 : (await create(target === 'client' ? 'clients' : 'projects', minimal(target === 'client' ? 'clients' : 'projects'))).id;
    expect((await accepts(table, { [col]: String(value) }))[col]).toBe(value);
  });
  for (const bad of [0, -1, 1.5, '1.5', 'abc', true, [1]]) {
    it(`${col}: refuses ${JSON.stringify(bad)}`, async () => {
      expect(await refuses(table, { [col]: bad })).toBe('must be the id of an existing record (a whole number)');
    });
  }
  if (required) {
    it(`${col}: is required`, async () => {
      expect(await refuses(table, { [col]: null })).toBe('is required');
      expect(await refuses(table, { [col]: '' })).toBe('is required');
    });
    it(`${col}: cannot be changed to an id that does not exist`, async () => {
      const row = await create(table, minimal(table));
      const r = await patch(`/api/${table}/${row.id}`, { [col]: 999 });
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields[col]).toBe(`there is no ${target} with id 999`);
    });
  } else {
    it(`${col}: is optional (empty string stores null)`, async () => {
      expect((await accepts(table, { [col]: '' }))[col]).toBeNull();
      expect((await accepts(table, {}))[col]).toBeNull();
    });
  }
}

// --- the four tables -----------------------------------------------------------------

describe('ventures', () => {
  for (const good of ['ab', 'becs-2', '5freq', 'a-', s(63, 'a'), 'a'.concat(s(62, '-'))]) {
    it(`slug: accepts "${good}"`, async () => {
      expect((await accepts('ventures', { slug: good })).slug).toBe(good);
    });
  }
  for (const bad of ['a', s(64, 'a'), '-ab', 'Ab', 'a_b', 'a b', 'a.b', 'ünï', 5]) {
    it(`slug: refuses ${JSON.stringify(bad)}`, async () => {
      await refuses('ventures', { slug: bad });
    });
  }
  it('slug: trims spaces before checking', async () => {
    expect((await accepts('ventures', { slug: '  spaced  ' })).slug).toBe('spaced');
  });
  it('slug: is required', async () => {
    expect(await refuses('ventures', { slug: '' })).toBe('is required');
    const r = await post('/api/ventures', { name: 'No slug' });
    expect(r.body.fields).toEqual({ slug: 'is required' });
  });
  it('reports every bad field at once', async () => {
    const r = await post('/api/ventures', { slug: 'A', name: '', status: 'gone' });
    expectErrorShape(r, 400, 'invalid');
    expect(Object.keys(r.body.fields).sort()).toEqual(['name', 'slug', 'status']);
  });
  textRule('ventures', 'name', 200, true);
  textRule('ventures', 'description', 2000, false);
  enumRule('ventures', 'status', ['active', 'paused', 'archived'], 'active', 'deleted');
});

describe('clients', () => {
  refRule('clients', 'venture_id', 'venture', true);
  textRule('clients', 'name', 200, true);
  textRule('clients', 'contact_name', 200, false);
  textRule('clients', 'phone', 200, false);
  textRule('clients', 'source', 200, false);
  textRule('clients', 'notes', 5000, false);
  enumRule('clients', 'stage', ['lead', 'contacted', 'proposal', 'active', 'paused', 'closed'], 'lead', 'won');

  it('email: accepts an address with an @', async () => {
    expect((await accepts('clients', { email: 'a@b' })).email).toBe('a@b');
    expect((await accepts('clients', { email: '  jo@example.com ' })).email).toBe('jo@example.com');
  });
  it('email: refuses an address with no @', async () => {
    expect(await refuses('clients', { email: 'jo.example.com' })).toBe('must be an email address (it needs an @)');
  });
  it('email: accepts 200 characters and refuses 201', async () => {
    const at200 = s(190) + '@example.c';
    expect(at200.length).toBe(200);
    expect((await accepts('clients', { email: at200 })).email).toBe(at200);
    await refuses('clients', { email: s(191) + '@example.c' });
  });
  it('email: is optional (empty string stores null)', async () => {
    expect((await accepts('clients', { email: '' })).email).toBeNull();
  });
  it('email: refuses a number', async () => {
    await refuses('clients', { email: 12 });
  });
});

describe('projects', () => {
  refRule('projects', 'venture_id', 'venture', true);
  refRule('projects', 'client_id', 'client', false);
  textRule('projects', 'name', 200, true);
  textRule('projects', 'notes', 5000, false);
  enumRule('projects', 'status', ['planning', 'active', 'paused', 'done', 'cancelled'], 'planning', 'finished');
  enumRule('projects', 'phase', ['plan', 'evolve', 'succeed'], null, 'grow');
  priorityRule('projects');
  dateRule('projects', 'start_date');
  dateRule('projects', 'due_date');

  it('phase: can be cleared back to null', async () => {
    const p = await create('projects', { ...minimal('projects'), phase: 'evolve' });
    expect((await patch(`/api/projects/${p.id}`, { phase: null })).body.data.phase).toBeNull();
  });

  for (const good of [0, 1, 123456, '250', 100_000_000_000, '100000000000']) {
    it(`value_cents: accepts ${JSON.stringify(good)}`, async () => {
      expect((await accepts('projects', { value_cents: good })).value_cents).toBe(Number(good));
    });
  }
  // Over $1 billion (100000000000 cents) is refused, so totals can never overflow.
  for (const tooBig of [100_000_000_001, '100000000001', 9007199254740991, '999999999999999']) {
    it(`value_cents: refuses ${JSON.stringify(tooBig)} (over $1 billion)`, async () => {
      expect(await refuses('projects', { value_cents: tooBig })).toBe('must be at most 100000000000 cents ($1 billion)');
    });
  }
  it('value_cents: refuses an update over $1 billion and keeps the old value', async () => {
    const p = await create('projects', { ...minimal('projects'), value_cents: 500 });
    const r = await patch(`/api/projects/${p.id}`, { value_cents: 100_000_000_001 });
    expectErrorShape(r, 400, 'invalid');
    expect(r.body.fields).toEqual({ value_cents: 'must be at most 100000000000 cents ($1 billion)' });
    expect((await get(`/api/projects/${p.id}`)).body.data.value_cents).toBe(500);
  });
  for (const bad of [-1, 1.5, '1.5', '12abc', true, 'free', 1e20]) {
    it(`value_cents: refuses ${JSON.stringify(bad)}`, async () => {
      expect(await refuses('projects', { value_cents: bad })).toBe('must be a whole number of cents, 0 or more');
    });
  }
  it('value_cents: is optional (empty string or null stores null)', async () => {
    expect((await accepts('projects', { value_cents: '' })).value_cents).toBeNull();
    expect((await accepts('projects', { value_cents: null })).value_cents).toBeNull();
    expect((await accepts('projects', {})).value_cents).toBeNull();
  });
});

describe('tasks', () => {
  refRule('tasks', 'venture_id', 'venture', true);
  refRule('tasks', 'project_id', 'project', false);
  textRule('tasks', 'title', 300, true);
  textRule('tasks', 'notes', 5000, false);
  enumRule('tasks', 'status', ['todo', 'doing', 'done'], 'todo', 'blocked');
  enumRule('tasks', 'filter_tag', ['revenue', 'systems', 'brand', 'workload'], null, 'fun');
  priorityRule('tasks');
  dateRule('tasks', 'due_date');
});

describe('updates use the same rules', () => {
  it('refuses a bad value in a PATCH and changes nothing', async () => {
    const t = await create('tasks', minimal('tasks'));
    const r = await patch(`/api/tasks/${t.id}`, { title: 'New', status: 'blocked' });
    expectErrorShape(r, 400, 'invalid');
    expect(r.body.fields).toEqual({ status: 'must be one of: todo, doing, done' });
    expect((await get(`/api/tasks/${t.id}`)).body.data.title).toBe('Task 1');
  });

  it('lets a PATCH move a task to another existing project and venture', async () => {
    const p = await create('projects', { venture_id: 2, name: 'Other' });
    const t = await create('tasks', minimal('tasks'));
    const r = await patch(`/api/tasks/${t.id}`, { venture_id: 2, project_id: p.id });
    expect(r.body.data).toMatchObject({ venture_id: 2, project_id: p.id });
  });
});
