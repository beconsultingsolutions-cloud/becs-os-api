// Task completion stamping (completed_at), and the 409 conflicts: a slug that is
// already taken, and deletes blocked by rows that still point at the record.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { count, create, del, expectErrorShape, get, minimal, patch, post } from './helpers';

const stampFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const nearNow = (stamp: string) => Math.abs(Date.parse(stamp.replace(' ', 'T') + 'Z') - Date.now()) < 60_000;

describe('task completion time (completed_at)', () => {
  it('is empty on a new task that is not done', async () => {
    expect((await create('tasks', minimal('tasks'))).completed_at).toBeNull();
  });

  it('is stamped when a task is created already done', async () => {
    const t = await create('tasks', { ...minimal('tasks'), status: 'done' });
    expect(t.completed_at).toMatch(stampFormat);
    expect(nearNow(t.completed_at)).toBe(true);
  });

  it('is stamped when a task is marked done', async () => {
    const t = await create('tasks', minimal('tasks'));
    const r = await patch(`/api/tasks/${t.id}`, { status: 'done' });
    expect(r.body.data.completed_at).toMatch(stampFormat);
    expect(nearNow(r.body.data.completed_at)).toBe(true);
  });

  it('is kept when a done task is edited in other ways', async () => {
    const t = await create('tasks', minimal('tasks'));
    // Use a fixed old stamp so a change would be visible.
    await patch(`/api/tasks/${t.id}`, { status: 'done' });
    await env.DB.prepare("UPDATE tasks SET completed_at = '2026-01-02 03:04:05' WHERE id = ?").bind(t.id).run();
    const r = await patch(`/api/tasks/${t.id}`, { notes: 'more detail', title: 'Renamed' });
    expect(r.body.data.completed_at).toBe('2026-01-02 03:04:05');
  });

  it('is kept when a done task is marked done again', async () => {
    const t = await create('tasks', minimal('tasks'));
    await patch(`/api/tasks/${t.id}`, { status: 'done' });
    await env.DB.prepare("UPDATE tasks SET completed_at = '2026-01-02 03:04:05' WHERE id = ?").bind(t.id).run();
    const r = await patch(`/api/tasks/${t.id}`, { status: 'done' });
    expect(r.body.data.completed_at).toBe('2026-01-02 03:04:05');
  });

  for (const next of ['todo', 'doing']) {
    it(`is cleared when a done task goes back to ${next}`, async () => {
      const t = await create('tasks', { ...minimal('tasks'), status: 'done' });
      const r = await patch(`/api/tasks/${t.id}`, { status: next });
      expect(r.body.data.status).toBe(next);
      expect(r.body.data.completed_at).toBeNull();
    });
  }

  it('is not stamped when a task moves between todo and doing', async () => {
    const t = await create('tasks', minimal('tasks'));
    expect((await patch(`/api/tasks/${t.id}`, { status: 'doing' })).body.data.completed_at).toBeNull();
  });

  it('cannot be written by callers on create or update', async () => {
    const t = await create('tasks', { ...minimal('tasks'), completed_at: '2020-01-01 00:00:00' });
    expect(t.completed_at).toBeNull();
    expectErrorShape(await patch(`/api/tasks/${t.id}`, { completed_at: '2020-01-01 00:00:00' }), 400, 'empty_body');
    const r = await patch(`/api/tasks/${t.id}`, { completed_at: '2020-01-01 00:00:00', notes: 'x' });
    expect(r.body.data.completed_at).toBeNull();
    await patch(`/api/tasks/${t.id}`, { status: 'done' });
    const r2 = await patch(`/api/tasks/${t.id}`, { completed_at: null, notes: 'y' });
    expect(r2.body.data.completed_at).toMatch(stampFormat);
  });
});

describe('slug conflicts', () => {
  it('refuses a new venture whose slug is taken, with a plain message', async () => {
    const r = await post('/api/ventures', { slug: 'becs', name: 'Duplicate' });
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('A venture with the slug "becs" already exists. Pick another slug.');
    expect(await count("SELECT COUNT(*) AS n FROM ventures WHERE slug = 'becs'")).toBe(1);
  });

  it('refuses renaming a venture to a slug that is taken', async () => {
    const v = await create('ventures', minimal('ventures'));
    const r = await patch(`/api/ventures/${v.id}`, { slug: 'leaa' });
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toContain('"leaa"');
    expect((await get(`/api/ventures/${v.id}`)).body.data.slug).toBe('test-venture-1');
  });

  it('logs nothing for a refused duplicate', async () => {
    await post('/api/ventures', { slug: 'becs', name: 'Duplicate' });
    expect(await count('SELECT COUNT(*) AS n FROM activity_log')).toBe(0);
  });
});

describe('deletes blocked by other rows', () => {
  it('refuses to delete a venture that still has clients, projects and tasks, and says how many', async () => {
    const v = await create('ventures', minimal('ventures'));
    await create('clients', { venture_id: v.id, name: 'C' });
    await create('projects', { venture_id: v.id, name: 'P1' });
    await create('projects', { venture_id: v.id, name: 'P2' });
    await create('tasks', { venture_id: v.id, title: 'T' });
    const r = await del(`/api/ventures/${v.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This venture still has 1 client, 2 projects and 1 task. Delete or move them first.');
    expect((await get(`/api/ventures/${v.id}`)).status).toBe(200);
  });

  it('names only the kinds of rows that are in the way', async () => {
    const v = await create('ventures', minimal('ventures'));
    await create('tasks', { venture_id: v.id, title: 'T1' });
    await create('tasks', { venture_id: v.id, title: 'T2' });
    expect((await del(`/api/ventures/${v.id}`)).body.message).toBe('This venture still has 2 tasks. Delete or move them first.');
  });

  it('refuses to delete a client that still has a project', async () => {
    const c = await create('clients', minimal('clients'));
    await create('projects', { venture_id: 1, client_id: c.id, name: 'P' });
    const r = await del(`/api/clients/${c.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This client still has 1 project. Delete or move them first.');
  });

  it('refuses to delete a client that has a client portal link (reserved table)', async () => {
    const c = await create('clients', minimal('clients'));
    await env.DB.prepare("INSERT INTO portal_links (token, client_id) VALUES ('tok', ?)").bind(c.id).run();
    const r = await del(`/api/clients/${c.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This client still has 1 client portal link. Delete or move them first.');
  });

  it('refuses to delete a project that still has tasks and payments (reserved table)', async () => {
    const p = await create('projects', minimal('projects'));
    await create('tasks', { venture_id: 1, project_id: p.id, title: 'T1' });
    await create('tasks', { venture_id: 1, project_id: p.id, title: 'T2' });
    await env.DB.prepare("INSERT INTO payments (project_id, label) VALUES (?, 'Deposit')").bind(p.id).run();
    const r = await del(`/api/projects/${p.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This project still has 2 tasks and 1 payment. Delete or move them first.');
  });

  it('logs nothing for a blocked delete', async () => {
    const p = await create('projects', minimal('projects'));
    await create('tasks', { venture_id: 1, project_id: p.id, title: 'T' });
    const before = await count('SELECT COUNT(*) AS n FROM activity_log');
    await del(`/api/projects/${p.id}`);
    expect(await count('SELECT COUNT(*) AS n FROM activity_log')).toBe(before);
  });

  it('allows the delete once the rows in the way are gone or moved', async () => {
    const v = await create('ventures', minimal('ventures'));
    const c = await create('clients', { venture_id: v.id, name: 'C' });
    const p = await create('projects', { venture_id: v.id, client_id: c.id, name: 'P' });
    const t = await create('tasks', { venture_id: v.id, project_id: p.id, title: 'T' });

    expect((await del(`/api/projects/${p.id}`)).status).toBe(409);
    expect((await patch(`/api/tasks/${t.id}`, { project_id: null, venture_id: 1 })).status).toBe(200);
    expect((await del(`/api/projects/${p.id}`)).status).toBe(200);
    expect((await del(`/api/clients/${c.id}`)).status).toBe(200);
    expect((await del(`/api/ventures/${v.id}`)).status).toBe(200);
  });

  it('can delete a seeded venture that nothing points at', async () => {
    expect((await del('/api/ventures/7')).body).toEqual({ data: { id: 7, deleted: true } });
  });

  it('can always delete a task (nothing points at tasks)', async () => {
    const t = await create('tasks', minimal('tasks'));
    expect((await del(`/api/tasks/${t.id}`)).status).toBe(200);
  });
});
