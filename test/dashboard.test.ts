// GET /api/dashboard: every figure, from seeded data, with and without ?venture_id=.
// "Today" is the UTC date, the same as the server's SQLite date('now').
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
      due_soon: [],
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
      ].sort()
    );

    // Not done: A B C D E G (venture 1) + I J K (venture 2).
    expect(d.open_tasks).toBe(9);

    // Overdue: not done, before today, oldest first. F is done so it is left out.
    expect(d.overdue).toEqual([item(ids.A, 'A', -3, 2, 1), item(ids.I, 'I', -2, 3, 2), item(ids.B, 'B', -1, 1, 1)]);

    // Due soon: today through today + 7, soonest first. E (8 days) and H (done) are left out.
    expect(d.due_soon).toEqual([
      item(ids.C, 'C', 0, 3, 1),
      item(ids.J, 'J', 1, 3, 2),
      item(ids.K, 'K', 2, 3, 2),
      item(ids.D, 'D', 7, 3, 1),
    ]);

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
      due_soon: [],
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
