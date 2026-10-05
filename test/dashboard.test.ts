// GET /api/dashboard: every figure, from seeded data, with and without ?venture_id=.
// "Today" is the UTC date unless the caller sends ?today= (see the last block).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { create, day, expectErrorShape, get } from './helpers';

/**
 * Venture 1 (becs) and 2 (leaa) get tasks, clients and projects:
 *   venture 1 tasks: A overdue 3 days, B overdue 1 day (high priority), C due today,
 *     D due in 7 days, E due in 8 days, F done and overdue, G no date, H done due today
 *   venture 2 tasks: I overdue 2 days, J due tomorrow, K doing and due in 2 days
 */
async function seed() {
  const t = async (venture_id: number, title: string, due: number | null, extra: Record<string, unknown> = {}) =>
    create('tasks', { venture_id, title, due_date: due === null ? null : day(due), ...extra });
  const ids: Record<string, number> = {};
  ids.A = (await t(1, 'A', -3, { priority: 2 })).id;
  ids.B = (await t(1, 'B', -1, { priority: 1 })).id;
  ids.C = (await t(1, 'C', 0)).id;
  ids.D = (await t(1, 'D', 7)).id;
  ids.E = (await t(1, 'E', 8)).id;
  ids.F = (await t(1, 'F', -5, { status: 'done' })).id;
  ids.G = (await t(1, 'G', null)).id;
  ids.H = (await t(1, 'H', 0, { status: 'done' })).id;
  ids.I = (await t(2, 'I', -2)).id;
  ids.J = (await t(2, 'J', 1)).id;
  ids.K = (await t(2, 'K', 2, { status: 'doing' })).id;

  for (const [venture_id, stage] of [
    [1, 'lead'],
    [1, 'lead'],
    [1, 'proposal'],
    [2, 'closed'],
    [2, 'active'],
  ] as const) {
    await create('clients', { venture_id, name: `${stage} client`, stage });
  }

  for (const [venture_id, status, value_cents] of [
    [1, 'planning', 100],
    [1, 'active', 250],
    [1, 'paused', 999],
    [1, 'done', 1000],
    [1, 'cancelled', 5],
    [2, 'active', null],
    [2, 'active', 300],
  ] as const) {
    await create('projects', { venture_id, name: `${status} project`, status, value_cents });
  }
  return ids;
}

const item = (id: number, title: string, due: number, priority: number, venture_id: number) => ({
  id,
  title,
  due_date: day(due),
  priority,
  venture_id,
});

describe('dashboard across all ventures', () => {
  it('is all zeros and empty lists on an empty database', async () => {
    const r = await get('/api/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      open_tasks: 0,
      overdue: [],
      overdue_count: 0,
      due_soon: [],
      due_soon_count: 0,
      client_pipeline: [],
      active_projects: 0,
      active_project_value_cents: 0,
    });
    expect(r.body.data.open_tasks_by_venture).toHaveLength(7);
  });

  it('computes every figure from the data', async () => {
    const ids = await seed();
    const d = (await get('/api/dashboard')).body.data;

    expect(Object.keys(d).sort()).toEqual(
      [
        'active_project_value_cents',
        'active_projects',
        'client_pipeline',
        'due_soon',
        'open_tasks',
        'open_tasks_by_venture',
        'overdue',
        'overdue_count',
        'due_soon_count',
      ].sort()
    );

    // Not done: A B C D E G (venture 1) + I J K (venture 2).
    expect(d.open_tasks).toBe(9);

    // Overdue: not done, before today, oldest first. F is done so it is left out.
    expect(d.overdue).toEqual([item(ids.A, 'A', -3, 2, 1), item(ids.I, 'I', -2, 3, 2), item(ids.B, 'B', -1, 1, 1)]);
    expect(d.overdue_count).toBe(3);

    // Due soon: today through today + 7, soonest first. E (8 days) and H (done) are left out.
    expect(d.due_soon).toEqual([
      item(ids.C, 'C', 0, 3, 1),
      item(ids.J, 'J', 1, 3, 2),
      item(ids.K, 'K', 2, 3, 2),
      item(ids.D, 'D', 7, 3, 1),
    ]);
    expect(d.due_soon_count).toBe(4);

    expect(d.open_tasks_by_venture).toEqual([
      { venture_id: 1, slug: 'becs', name: 'BE Consulting Solutions', open_tasks: 6 },
      { venture_id: 2, slug: 'leaa', name: 'Lane Ellis Apparel Agency Co.', open_tasks: 3 },
      { venture_id: 3, slug: 'blnks', name: 'BLNKS', open_tasks: 0 },
      { venture_id: 4, slug: 'me-and-them', name: 'ME & THEM / M3 & TH3M', open_tasks: 0 },
      { venture_id: 5, slug: '4freq', name: '4FREQ', open_tasks: 0 },
      { venture_id: 6, slug: 'be-university', name: 'BE University', open_tasks: 0 },
      { venture_id: 7, slug: 'tethr', name: 'TETHR', open_tasks: 0 },
    ]);

    // In pipeline order, only stages that have clients.
    expect(d.client_pipeline).toEqual([
      { stage: 'lead', n: 2 },
      { stage: 'proposal', n: 1 },
      { stage: 'active', n: 1 },
      { stage: 'closed', n: 1 },
    ]);

    // planning + active only: 100 + 250 + (null) + 300.
    expect(d.active_projects).toBe(4);
    expect(d.active_project_value_cents).toBe(650);
  });

  it('adds up projects at the $1 billion limit exactly', async () => {
    await create('projects', { venture_id: 1, name: 'big 1', value_cents: 100_000_000_000 });
    await create('projects', { venture_id: 1, name: 'big 2', value_cents: 100_000_000_000 });
    await create('projects', { venture_id: 1, name: 'small', value_cents: 1 });
    const d = (await get('/api/dashboard')).body.data;
    expect(d.active_project_value_cents).toBe(200_000_000_001);
  });

  it('does not crash when stored values are too big to add up (older data)', async () => {
    // Written straight into the database, as data from before the $1 billion limit could be.
    await env.DB.exec(
      "INSERT INTO projects (venture_id, name, status, value_cents) VALUES (1, 'huge 1', 'active', 9223372036854775807)"
    );
    await env.DB.exec(
      "INSERT INTO projects (venture_id, name, status, value_cents) VALUES (1, 'huge 2', 'active', 9223372036854775807)"
    );
    const r = await get('/api/dashboard');
    expect(r.status, r.text).toBe(200);
    expect(r.body.data.active_projects).toBe(2);
    expect(typeof r.body.data.active_project_value_cents).toBe('number');
  });

  it('puts equal due dates in priority order', async () => {
    const low = await create('tasks', { venture_id: 1, title: 'low', due_date: day(-1), priority: 3 });
    const high = await create('tasks', { venture_id: 1, title: 'high', due_date: day(-1), priority: 1 });
    expect((await get('/api/dashboard')).body.data.overdue.map((t: { id: number }) => t.id)).toEqual([high.id, low.id]);
  });

  it('shows at most 25 overdue and 25 due-soon tasks', async () => {
    for (let i = 0; i < 30; i++) {
      await create('tasks', { venture_id: 1, title: `late ${i}`, due_date: day(-1 - (i % 5)) });
      await create('tasks', { venture_id: 1, title: `soon ${i}`, due_date: day(i % 8) });
    }
    const d = (await get('/api/dashboard')).body.data;
    expect(d.overdue).toHaveLength(25);
    expect(d.due_soon).toHaveLength(25);
    expect(d.overdue_count).toBe(30);
    expect(d.due_soon_count).toBe(30);
    expect(d.open_tasks).toBe(60);
  });
});

describe('dashboard for one venture', () => {
  it('limits every figure to that venture', async () => {
    const ids = await seed();
    const d = (await get('/api/dashboard?venture_id=1')).body.data;
    expect(d.open_tasks).toBe(6);
    expect(d.overdue).toEqual([item(ids.A, 'A', -3, 2, 1), item(ids.B, 'B', -1, 1, 1)]);
    expect(d.due_soon).toEqual([item(ids.C, 'C', 0, 3, 1), item(ids.D, 'D', 7, 3, 1)]);
    expect(d.open_tasks_by_venture).toEqual([
      { venture_id: 1, slug: 'becs', name: 'BE Consulting Solutions', open_tasks: 6 },
    ]);
    expect(d.client_pipeline).toEqual([
      { stage: 'lead', n: 2 },
      { stage: 'proposal', n: 1 },
    ]);
    expect(d.active_projects).toBe(2);
    expect(d.active_project_value_cents).toBe(350);
  });

  it('works for the second venture too', async () => {
    await seed();
    const d = (await get('/api/dashboard?venture_id=2')).body.data;
    expect(d.open_tasks).toBe(3);
    expect(d.overdue.map((t: { title: string }) => t.title)).toEqual(['I']);
    expect(d.due_soon.map((t: { title: string }) => t.title)).toEqual(['J', 'K']);
    expect(d.client_pipeline).toEqual([
      { stage: 'active', n: 1 },
      { stage: 'closed', n: 1 },
    ]);
    expect(d.active_projects).toBe(2);
    expect(d.active_project_value_cents).toBe(300);
  });

  it('shows one zero row for a venture with nothing in it', async () => {
    await seed();
    const d = (await get('/api/dashboard?venture_id=7')).body.data;
    expect(d).toEqual({
      open_tasks: 0,
      overdue: [],
      overdue_count: 0,
      due_soon: [],
      due_soon_count: 0,
      open_tasks_by_venture: [{ venture_id: 7, slug: 'tethr', name: 'TETHR', open_tasks: 0 }],
      client_pipeline: [],
      active_projects: 0,
      active_project_value_cents: 0,
    });
  });

  it('accepts "2" with spaces, and treats an empty venture_id as no filter', async () => {
    await seed();
    expect((await get('/api/dashboard?venture_id=%202%20')).body.data.open_tasks).toBe(3);
    expect((await get('/api/dashboard?venture_id=')).body.data.open_tasks).toBe(9);
  });

  for (const junk of ['abc', '0', '-1', '1.5', '999']) {
    it(`refuses ?venture_id=${junk}`, async () => {
      const r = await get(`/api/dashboard?venture_id=${junk}`);
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields).toHaveProperty('venture_id');
    });
  }

  it('refuses methods other than GET', async () => {
    const { call } = await import('./helpers');
    expectErrorShape(await call('/api/dashboard', { method: 'POST', body: {} }), 405, 'method_not_allowed');
  });
});

// The owner is not in the UTC time zone. The console sends its own date as ?today=
// so "overdue" and "due soon" follow his day.
describe('dashboard with the caller\'s own date (?today=)', () => {
  const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

  it('treats a task due on the UTC date as due soon, not overdue, when the caller is still on yesterday', async () => {
    await create('tasks', { venture_id: 1, title: 'due utc today', due_date: day(0) });
    await create('tasks', { venture_id: 1, title: 'due utc yesterday', due_date: day(-1) });
    await create('tasks', { venture_id: 1, title: 'due two days ago', due_date: day(-2) });

    const d = (await get(`/api/dashboard?today=${day(-1)}`)).body.data;
    expect(titles(d.overdue)).toEqual(['due two days ago']);
    expect(titles(d.due_soon)).toEqual(['due utc yesterday', 'due utc today']);
  });

  it('counts a task due on the UTC date as overdue when the caller is already on tomorrow', async () => {
    await create('tasks', { venture_id: 1, title: 'due utc today', due_date: day(0) });
    await create('tasks', { venture_id: 1, title: 'due in 8 days', due_date: day(8) });

    const d = (await get(`/api/dashboard?today=${day(1)}`)).body.data;
    expect(titles(d.overdue)).toEqual(['due utc today']);
    // The 7-day window moves with the caller's date: day 8 is now 7 days away.
    expect(titles(d.due_soon)).toEqual(['due in 8 days']);
  });

  it('gives the same answer with the UTC date as with no date at all', async () => {
    await create('tasks', { venture_id: 1, title: 'late', due_date: day(-1) });
    await create('tasks', { venture_id: 1, title: 'soon', due_date: day(3) });
    const plain = (await get('/api/dashboard')).body.data;
    const dated = (await get(`/api/dashboard?today=${day(0)}`)).body.data;
    expect(dated).toEqual(plain);
    const blank = (await get('/api/dashboard?today=')).body.data;
    expect(blank).toEqual(plain);
  });

  it('works together with ?venture_id=', async () => {
    await create('tasks', { venture_id: 1, title: 'becs', due_date: day(0) });
    await create('tasks', { venture_id: 2, title: 'leaa', due_date: day(0) });
    const d = (await get(`/api/dashboard?venture_id=2&today=${day(1)}`)).body.data;
    expect(titles(d.overdue)).toEqual(['leaa']);
  });

  it.each([day(2), day(-2), '2020-01-01', '2026-02-30', '10/04/2026', 'today', "2026-10-04' OR 1=1"])(
    'refuses a date that is not within a day of now, or not a date: %s',
    async (bad) => {
      const r = await get(`/api/dashboard?today=${encodeURIComponent(bad)}`);
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields.today).toBeTruthy();
    }
  );
});

// The overdue and due-soon lists stop at 25 rows. overdue_count and due_soon_count
// are the real totals, so the console can show the true number and say when a list is cut short.
describe('dashboard counts beyond the 25-row lists', () => {
  /** Puts tasks straight into the database (fast): `n` tasks due `due` days from today. */
  async function seedDue(n: number, due: number, extra: { venture_id?: number; status?: string; title?: string } = {}) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      stmts.push(
        env.DB.prepare('INSERT INTO tasks (venture_id, title, due_date, status) VALUES (?, ?, ?, ?)').bind(
          extra.venture_id ?? 1,
          `${extra.title ?? 'task'} ${i}`,
          day(due),
          extra.status ?? 'todo'
        )
      );
    }
    if (stmts.length) await env.DB.batch(stmts);
  }

  it('counts 0 when nothing is overdue or due soon, ignoring done tasks and tasks with no date', async () => {
    await seedDue(3, -2, { status: 'done' });
    await seedDue(2, 3, { status: 'done' });
    await seedDue(2, 9);
    await create('tasks', { venture_id: 1, title: 'no date' });
    const d = (await get('/api/dashboard')).body.data;
    expect(d.overdue_count).toBe(0);
    expect(d.due_soon_count).toBe(0);
    expect(d.overdue).toEqual([]);
    expect(d.due_soon).toEqual([]);
  });

  it('counts exactly 25 when there are exactly 25, and the lists hold all of them', async () => {
    await seedDue(25, -1);
    await seedDue(25, 2);
    const d = (await get('/api/dashboard')).body.data;
    expect(d.overdue).toHaveLength(25);
    expect(d.overdue_count).toBe(25);
    expect(d.due_soon).toHaveLength(25);
    expect(d.due_soon_count).toBe(25);
  });

  it('counts 26 when there are 26, while the list still shows the 25 oldest', async () => {
    await seedDue(1, -10, { title: 'oldest' });
    await seedDue(24, -3);
    await seedDue(1, -1, { title: 'newest' });
    const d = (await get('/api/dashboard')).body.data;
    expect(d.overdue_count).toBe(26);
    expect(d.overdue).toHaveLength(25);
    const titles = d.overdue.map((t: { title: string }) => t.title);
    expect(titles[0]).toBe('oldest 0');
    expect(titles).not.toContain('newest 0');
  });

  it('gives the real totals well past 25 (31 overdue, 40 due soon)', async () => {
    await seedDue(31, -4);
    await seedDue(20, 0);
    await seedDue(20, 7);
    await seedDue(5, 8); // just outside the 7-day window
    const d = (await get('/api/dashboard')).body.data;
    expect(d.overdue_count).toBe(31);
    expect(d.due_soon_count).toBe(40);
    expect(d.overdue).toHaveLength(25);
    expect(d.due_soon).toHaveLength(25);
    expect(d.open_tasks).toBe(31 + 40 + 5);
  });

  it('counts "doing" tasks as well as "to do" ones', async () => {
    await seedDue(27, -1, { status: 'doing' });
    await seedDue(2, -1);
    expect((await get('/api/dashboard')).body.data.overdue_count).toBe(29);
  });

  it('limits the counts to one venture with ?venture_id=', async () => {
    await seedDue(30, -2, { venture_id: 1 });
    await seedDue(4, -2, { venture_id: 2 });
    await seedDue(28, 1, { venture_id: 1 });
    await seedDue(3, 1, { venture_id: 2 });

    const all = (await get('/api/dashboard')).body.data;
    expect(all.overdue_count).toBe(34);
    expect(all.due_soon_count).toBe(31);

    const one = (await get('/api/dashboard?venture_id=1')).body.data;
    expect(one.overdue_count).toBe(30);
    expect(one.overdue).toHaveLength(25);
    expect(one.due_soon_count).toBe(28);

    const two = (await get('/api/dashboard?venture_id=2')).body.data;
    expect(two.overdue_count).toBe(4);
    expect(two.overdue).toHaveLength(4);
    expect(two.due_soon_count).toBe(3);

    const empty = (await get('/api/dashboard?venture_id=7')).body.data;
    expect(empty.overdue_count).toBe(0);
    expect(empty.due_soon_count).toBe(0);
  });

  it('follows the caller\'s own date (?today=) for the counts too', async () => {
    await seedDue(27, 0, { title: 'due utc today' });
    await seedDue(3, -1, { title: 'due utc yesterday' });

    // Caller is still on yesterday: today's 27 are due soon, yesterday's 3 are due today (also due soon).
    const behind = (await get(`/api/dashboard?today=${day(-1)}`)).body.data;
    expect(behind.overdue_count).toBe(0);
    expect(behind.due_soon_count).toBe(30);

    // Caller is already on tomorrow: all 30 are overdue.
    const ahead = (await get(`/api/dashboard?today=${day(1)}`)).body.data;
    expect(ahead.overdue_count).toBe(30);
    expect(ahead.overdue).toHaveLength(25);
    expect(ahead.due_soon_count).toBe(0);

    // Works together with ?venture_id=.
    await seedDue(2, 0, { venture_id: 2 });
    const v2 = (await get(`/api/dashboard?venture_id=2&today=${day(1)}`)).body.data;
    expect(v2.overdue_count).toBe(2);
  });
});
