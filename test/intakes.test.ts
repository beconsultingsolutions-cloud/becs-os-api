// Intakes: public form submissions written by the separate becs-intake Worker.
// The API lists, reads, updates (status, client, venture) and deletes them, but never creates them.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { create, del, expectErrorShape, get, makeAppKey, minimal, patch, post, seedIntake } from './helpers';

describe('intakes', () => {
  it('lists intakes newest first and filters by status and venture', async () => {
    const a = await seedIntake();
    const b = await seedIntake({ business_name: 'Luxe Salon', venture_id: 2 });
    await patch(`/api/intakes/${a}`, { status: 'reviewed' });

    const all = await get('/api/intakes');
    expect(all.status).toBe(200);
    expect(all.body.data.map((r: { id: number }) => r.id)).toEqual([b, a]);
    expect(all.body.data[0]).toMatchObject({ form: 'business-intake', business_name: 'Luxe Salon', status: 'new', answers: '{"goals":"more bookings"}' });

    expect((await get('/api/intakes?status=new')).body.data.map((r: { id: number }) => r.id)).toEqual([b]);
    expect((await get('/api/intakes?venture_id=1')).body.data.map((r: { id: number }) => r.id)).toEqual([a]);
  });

  it('refuses to create an intake through the API (only the becs-intake Worker writes them)', async () => {
    const r = await post('/api/intakes', { venture_id: 1, form: 'x', answers: '{}' });
    expect(r.status).toBe(405);
    expect(r.headers.get('Allow')).toBe('GET');
  });

  it('moves status along, logs it, and stamps updated_at', async () => {
    const id = await seedIntake();
    const r = await patch(`/api/intakes/${id}`, { status: 'call_booked' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.data.status).toBe('call_booked');
    const log = await env.DB.prepare("SELECT action FROM activity_log WHERE entity_type = 'intakes' AND entity_id = ?").bind(id).all();
    expect(log.results.length).toBeGreaterThan(0);
  });

  it('refuses a status that is not in the list', async () => {
    const id = await seedIntake();
    expectErrorShape(await patch(`/api/intakes/${id}`, { status: 'maybe' }), 400, 'invalid');
  });

  it("never lets the visitor's answers be changed (those columns are ignored)", async () => {
    const id = await seedIntake();
    const r = await patch(`/api/intakes/${id}`, { status: 'reviewed', business_name: 'Edited', answers: '{}', email: 'x@y.co' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'reviewed', business_name: 'Glow Studio', answers: '{"goals":"more bookings"}', email: 'dana@glow.co' });
  });

  it('links a client and moves the venture, checking both exist', async () => {
    const id = await seedIntake();
    const client = await create('clients', minimal('clients', 1));
    expect((await patch(`/api/intakes/${id}`, { client_id: client.id, venture_id: 3 })).body.data).toMatchObject({ client_id: client.id, venture_id: 3 });
    expectErrorShape(await patch(`/api/intakes/${id}`, { client_id: 99999 }), 400, 'invalid');
    expectErrorShape(await patch(`/api/intakes/${id}`, { venture_id: null }), 400, 'invalid');
  });

  it('deletes an intake (spam, tests) and refuses to delete a client an intake still points at', async () => {
    const client = await create('clients', minimal('clients', 1));
    const id = await seedIntake({ client_id: client.id });
    const blocked = await del(`/api/clients/${client.id}`);
    expectErrorShape(blocked, 409, 'conflict');
    expect(blocked.body.message).toContain('1 intake');
    expect((await del(`/api/intakes/${id}`)).status).toBe(200);
    expect((await del(`/api/clients/${client.id}`)).status).toBe(200);
  });

  it('is guarded by client permissions', async () => {
    const id = await seedIntake();
    const reader = await makeAppKey(['clients:read']);
    expect((await get('/api/intakes', { key: reader })).status).toBe(200);
    expect((await patch(`/api/intakes/${id}`, { status: 'reviewed' }, { key: reader })).status).toBe(403);
    const writer = await makeAppKey(['clients:write']);
    expect((await patch(`/api/intakes/${id}`, { status: 'reviewed' }, { key: writer })).status).toBe(200);
    const other = await makeAppKey(['tasks:read', 'tasks:write']);
    expect((await get('/api/intakes', { key: other })).status).toBe(403);
  });

  it('shows new intakes on the dashboard, newest first, filtered by venture', async () => {
    const a = await seedIntake();
    const b = await seedIntake({ business_name: 'Luxe Salon', venture_id: 2 });
    await seedIntake({ status: 'closed' });
    const d = (await get('/api/dashboard')).body.data.intakes;
    expect(d.new_count).toBe(2);
    expect(d.newest.map((r: { id: number }) => r.id)).toEqual([b, a]);
    expect(d.newest[0]).toMatchObject({ business_name: 'Luxe Salon', form: 'business-intake', venture_id: 2 });
    expect((await get('/api/dashboard?venture_id=1')).body.data.intakes.new_count).toBe(1);
  });
});
