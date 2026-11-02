// Piece B: project milestones and the client log. Their own rules: field checks,
// links to parent rows, completion stamping, delete protection, the activity log,
// and which app-key scopes guard them (project and client scopes, no new ones).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { create, day, del, expectErrorShape, get, makeAppKey, minimal, patch, post } from './helpers';

const stampFormat = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const project = () => create('projects', minimal('projects'));
const client = () => create('clients', minimal('clients'));

describe('milestones: field rules', () => {
  it('saves a full milestone', async () => {
    const p = await project();
    const body = { project_id: p.id, title: 'M2 Brand & Digital Trust', position: 3, status: 'doing', due_date: day(14), met_when: 'Site live and reviewed', notes: 'Pilot' };
    const r = await post('/api/milestones', body);
    expect(r.status, r.text).toBe(201);
    expect(r.body.data).toMatchObject(body);
  });

  it('defaults status to todo and leaves the rest empty', async () => {
    const m = await create('milestones', { project_id: (await project()).id, title: 'M0' });
    expect(m).toMatchObject({ status: 'todo', position: null, due_date: null, met_when: null, notes: null, completed_at: null });
  });

  for (const [field, value, message] of [
    ['title', '', 'is required'],
    ['title', 'x'.repeat(201), 'must be at most 200 characters'],
    ['status', 'later', null],
    ['position', -1, 'must be a whole number from 0 to 9999'],
    ['position', 10000, 'must be a whole number from 0 to 9999'],
    ['position', 1.5, 'must be a whole number from 0 to 9999'],
    ['due_date', '2026-02-30', 'must be a real date written YYYY-MM-DD'],
    ['met_when', 'x'.repeat(1001), 'must be at most 1000 characters'],
  ] as const) {
    it(`refuses ${field} = ${JSON.stringify(value).slice(0, 20)}`, async () => {
      const r = await post('/api/milestones', { project_id: (await project()).id, title: 'M1', [field]: value });
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields).toHaveProperty(field);
      if (message) expect(r.body.fields[field]).toContain(message);
    });
  }

  it('needs a project that exists', async () => {
    expectErrorShape(await post('/api/milestones', { title: 'Orphan' }), 400, 'invalid');
    const r = await post('/api/milestones', { project_id: 999999, title: 'Orphan' });
    expectErrorShape(r, 400, 'invalid');
    expect(r.body.fields.project_id).toBe('there is no project with id 999999');
  });

  it('lists one project\'s milestones with ?project_id=', async () => {
    const [a, b] = [await project(), await project()];
    await create('milestones', { project_id: a.id, title: 'A1' });
    await create('milestones', { project_id: b.id, title: 'B1' });
    const r = await get(`/api/milestones?project_id=${a.id}`);
    expect(r.body.data.map((m: { title: string }) => m.title)).toEqual(['A1']);
  });
});

describe('milestones: completion time', () => {
  it('is stamped when a milestone is marked done, and cleared when it is reopened', async () => {
    const m = await create('milestones', { project_id: (await project()).id, title: 'M1' });
    const done = await patch(`/api/milestones/${m.id}`, { status: 'done' });
    expect(done.body.data.completed_at).toMatch(stampFormat);
    const reopened = await patch(`/api/milestones/${m.id}`, { status: 'doing' });
    expect(reopened.body.data.completed_at).toBeNull();
  });

  it('is stamped when a milestone is created already done, and cannot be set by callers', async () => {
    const m = await create('milestones', { project_id: (await project()).id, title: 'M0', status: 'done', completed_at: '2020-01-01 00:00:00' });
    expect(m.completed_at).toMatch(stampFormat);
    expect(m.completed_at).not.toBe('2020-01-01 00:00:00');
  });
});

describe('tasks inside milestones', () => {
  it('lets a task belong to a milestone, and filters by it', async () => {
    const m = await create('milestones', { project_id: (await project()).id, title: 'M1' });
    const t = await create('tasks', { ...minimal('tasks'), milestone_id: m.id });
    expect(t.milestone_id).toBe(m.id);
    expect((await get(`/api/tasks?milestone_id=${m.id}`)).body.data.map((x: { id: number }) => x.id)).toEqual([t.id]);
  });

  it('refuses a milestone that does not exist, and lets the link be cleared', async () => {
    const r = await post('/api/tasks', { ...minimal('tasks'), milestone_id: 999999 });
    expect(r.body.fields.milestone_id).toBe('there is no milestone with id 999999');
    const m = await create('milestones', { project_id: (await project()).id, title: 'M1' });
    const t = await create('tasks', { ...minimal('tasks'), milestone_id: m.id });
    expect((await patch(`/api/tasks/${t.id}`, { milestone_id: null })).body.data.milestone_id).toBeNull();
  });
});

describe('client log: field rules', () => {
  it('saves a full entry', async () => {
    const c = await client();
    const body = { client_id: c.id, kind: 'call', title: 'Kick-off call', body: 'Agreed scope', url: 'https://example.com/proposal', happened_on: day(0) };
    const r = await post('/api/client_notes', body);
    expect(r.status, r.text).toBe(201);
    expect(r.body.data).toMatchObject(body);
  });

  it('defaults kind to note', async () => {
    expect((await create('client_notes', { client_id: (await client()).id, title: 'Hi' })).kind).toBe('note');
  });

  for (const kind of ['note', 'call', 'meeting', 'email', 'decision', 'link']) {
    it(`accepts kind "${kind}"`, async () => {
      expect((await post('/api/client_notes', { client_id: (await client()).id, title: 'x', kind })).status).toBe(201);
    });
  }

  for (const [field, value] of [
    ['kind', 'gossip'],
    ['title', ''],
    ['title', 'x'.repeat(201)],
    ['body', 'x'.repeat(5001)],
    ['url', 'http://example.com'],
    ['url', 'javascript:alert(1)'],
    ['url', 'example.com'],
    ['url', 'https://exa mple.com'],
    ['url', 'https://example.com/' + 'x'.repeat(500)],
    ['happened_on', '01/02/2026'],
  ] as const) {
    it(`refuses ${field} = ${JSON.stringify(value).slice(0, 24)}`, async () => {
      const r = await post('/api/client_notes', { client_id: (await client()).id, title: 'x', [field]: value });
      expectErrorShape(r, 400, 'invalid');
      expect(r.body.fields).toHaveProperty(field);
    });
  }

  it('needs a client that exists', async () => {
    const r = await post('/api/client_notes', { client_id: 999999, title: 'x' });
    expect(r.body.fields.client_id).toBe('there is no client with id 999999');
  });
});

describe('deletes blocked by milestones and log entries', () => {
  it('refuses to delete a project that still has milestones', async () => {
    const p = await project();
    await create('milestones', { project_id: p.id, title: 'M1' });
    await create('milestones', { project_id: p.id, title: 'M2' });
    const r = await del(`/api/projects/${p.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This project still has 2 milestones. Delete or move them first.');
  });

  it('refuses to delete a milestone that still has a task', async () => {
    const m = await create('milestones', { project_id: (await project()).id, title: 'M1' });
    await create('tasks', { ...minimal('tasks'), milestone_id: m.id });
    const r = await del(`/api/milestones/${m.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This milestone still has 1 task. Delete or move them first.');
  });

  it('refuses to delete a client that still has log entries', async () => {
    const c = await client();
    await create('client_notes', { client_id: c.id, title: 'Call' });
    const r = await del(`/api/clients/${c.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toBe('This client still has 1 client log entry. Delete or move them first.');
  });
});

describe('activity log for milestones and the client log', () => {
  it('logs create, update and delete', async () => {
    const m = await create('milestones', { project_id: (await project()).id, title: 'M1' });
    await patch(`/api/milestones/${m.id}`, { title: 'M1 Plan' });
    await del(`/api/milestones/${m.id}`);
    const n = await create('client_notes', { client_id: (await client()).id, title: 'Call' });
    const rows = (
      await env.DB.prepare("SELECT entity_type, entity_id, action FROM activity_log WHERE entity_type IN ('milestones', 'client_notes') ORDER BY id").all()
    ).results;
    expect(rows).toEqual([
      { entity_type: 'milestones', entity_id: m.id, action: 'created' },
      { entity_type: 'milestones', entity_id: m.id, action: 'updated' },
      { entity_type: 'milestones', entity_id: m.id, action: 'deleted' },
      { entity_type: 'client_notes', entity_id: n.id, action: 'created' },
    ]);
  });
});

describe('app-key scopes for the new tables', () => {
  it('milestones need project scopes, and task scopes are not enough', async () => {
    const p = await project();
    const tasksOnly = await makeAppKey(['tasks:read', 'tasks:write']);
    expectErrorShape(await get('/api/milestones', { key: tasksOnly }), 403, 'forbidden');
    const projects = await makeAppKey(['projects:read', 'projects:write']);
    expect((await post('/api/milestones', { project_id: p.id, title: 'M1' }, { key: projects })).status).toBe(201);
  });

  it('the client log needs client scopes', async () => {
    const c = await client();
    const projectsOnly = await makeAppKey(['projects:read', 'projects:write']);
    expectErrorShape(await post('/api/client_notes', { client_id: c.id, title: 'x' }, { key: projectsOnly }), 403, 'forbidden');
    const clients = await makeAppKey(['clients:read', 'clients:write']);
    expect((await post('/api/client_notes', { client_id: c.id, title: 'x' }, { key: clients })).status).toBe(201);
  });

  it('the Chief of Staff key (read everything, write tasks) can read both but write neither', async () => {
    const key = await makeAppKey(['ventures:read', 'clients:read', 'projects:read', 'tasks:read', 'tasks:write', 'activity:read'], 'chief-of-staff');
    const p = await project();
    const c = await client();
    expect((await get('/api/milestones', { key })).status).toBe(200);
    expect((await get('/api/client_notes', { key })).status).toBe(200);
    expectErrorShape(await post('/api/milestones', { project_id: p.id, title: 'M1' }, { key }), 403, 'forbidden');
    expectErrorShape(await post('/api/client_notes', { client_id: c.id, title: 'x' }, { key }), 403, 'forbidden');
  });
});
