// App key management: /api/admin/keys (master and signed-in owner only).
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { call, del, expectErrorShape, get, post, sha256Hex } from './helpers';

const newKey = (app: string, scopes: string[]) => post('/api/admin/keys', { app, scopes });

describe('creating app keys', () => {
  it('creates a key and shows it once, with the app, sorted scopes and creation time', async () => {
    const r = await newKey('leaa-portal', ['tasks:read', 'clients:read', 'tasks:read']);
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.data).sort()).toEqual(['app', 'created_at', 'key', 'scopes']);
    expect(r.body.data.app).toBe('leaa-portal');
    expect(r.body.data.scopes).toEqual(['clients:read', 'tasks:read']);
    expect(r.body.data.key).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(r.body.data.created_at))).toBe(false);
  });

  it('gives a key that works straight away with exactly its scopes', async () => {
    const { key } = (await newKey('reader', ['tasks:read'])).body.data;
    const me = await get('/api/me', { key });
    expect(me.body.data).toEqual({ kind: 'app', app: 'reader', scopes: ['tasks:read'] });
    expect((await get('/api/tasks', { key })).status).toBe(200);
    expect((await post('/api/tasks', { venture_id: 1, title: 'x' }, { key })).status).toBe(403);
  });

  it('stores only the hash of the key, never the key itself', async () => {
    const { key } = (await newKey('reader', ['tasks:read'])).body.data;
    const list = await env.CONFIG.list();
    expect(list.keys.map((k) => k.name)).toEqual(['key:' + (await sha256Hex(key))]);
    const stored = await env.CONFIG.get(list.keys[0].name);
    expect(stored).not.toContain(key);
  });

  it('gives a different key every time, even for the same app', async () => {
    const a = (await newKey('twice', ['tasks:read'])).body.data.key;
    const b = (await newKey('twice', ['tasks:read'])).body.data.key;
    expect(a).not.toBe(b);
  });

  it('trims spaces around the app name', async () => {
    expect((await newKey('  spaced-app  ', ['tasks:read'])).body.data.app).toBe('spaced-app');
  });

  for (const bad of ['', 'a', 'A-app', '-app', 'my_app', 'my app', 'x'.repeat(64), 5, null]) {
    it(`refuses the app name ${JSON.stringify(bad)}`, async () => {
      const r = await post('/api/admin/keys', { app: bad, scopes: ['tasks:read'] });
      expectErrorShape(r, 400, 'invalid');
      expect(Object.keys(r.body.fields)).toEqual(['app']);
    });
  }

  it('refuses a missing app name', async () => {
    const r = await post('/api/admin/keys', { scopes: ['tasks:read'] });
    expectErrorShape(r, 400, 'invalid');
    expect(r.body.fields).toHaveProperty('app');
  });

  for (const bad of [undefined, [], 'tasks:read', ['tasks:delete'], ['tasks:read', 'admin'], [1], ['TASKS:READ'], [null], {}]) {
    it(`refuses the scopes ${JSON.stringify(bad)}`, async () => {
      const r = await post('/api/admin/keys', { app: 'ok-app', scopes: bad });
      expectErrorShape(r, 400, 'invalid');
      expect(Object.keys(r.body.fields)).toEqual(['scopes']);
      expect(r.body.fields.scopes).toContain('activity:read');
    });
  }

  it('accepts every documented scope', async () => {
    const all = ['activity:read', 'clients:read', 'clients:write', 'projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'ventures:read', 'ventures:write'];
    expect((await newKey('everything', all)).body.data.scopes).toEqual(all);
  });

  it('reports a bad name and bad scopes together', async () => {
    const r = await post('/api/admin/keys', { app: 'X', scopes: [] });
    expect(Object.keys(r.body.fields).sort()).toEqual(['app', 'scopes']);
  });

  it('refuses a broken or empty body', async () => {
    expectErrorShape(await call('/api/admin/keys', { method: 'POST', rawBody: '{' }), 400, 'bad_json');
    expectErrorShape(await call('/api/admin/keys', { method: 'POST', rawBody: '[]' }), 400, 'bad_json');
    expectErrorShape(await call('/api/admin/keys', { method: 'POST', rawBody: '' }), 400, 'empty_body');
  });

  it('creates nothing when refused', async () => {
    await post('/api/admin/keys', { app: 'X', scopes: [] });
    expect((await env.CONFIG.list()).keys).toHaveLength(0);
  });
});

describe('listing app keys', () => {
  it('lists app, scopes and created_at only, sorted by app', async () => {
    const k1 = (await newKey('zeta', ['tasks:read'])).body.data;
    const k2 = (await newKey('alpha', ['clients:read', 'activity:read'])).body.data;
    const r = await get('/api/admin/keys');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([
      { app: 'alpha', scopes: ['activity:read', 'clients:read'], created_at: k2.created_at },
      { app: 'zeta', scopes: ['tasks:read'], created_at: k1.created_at },
    ]);
    for (const k of [k1.key, k2.key]) {
      expect(r.text).not.toContain(k);
      expect(r.text).not.toContain(await sha256Hex(k));
    }
  });

  it('is an empty list when there are no keys', async () => {
    expect((await get('/api/admin/keys')).body).toEqual({ data: [] });
  });

  it('skips unrelated or broken KV entries', async () => {
    await newKey('real', ['tasks:read']);
    await env.CONFIG.put('key:broken', 'not json');
    await env.CONFIG.put('something-else', JSON.stringify({ app: 'ghost', scopes: [] }));
    expect((await get('/api/admin/keys')).body.data.map((k: { app: string }) => k.app)).toEqual(['real']);
  });
});

describe('revoking app keys', () => {
  it('revokes every key of that app, and they stop working', async () => {
    const a = (await newKey('portal', ['tasks:read'])).body.data.key;
    const b = (await newKey('portal', ['clients:read'])).body.data.key;
    const other = (await newKey('other-app', ['tasks:read'])).body.data.key;
    expect((await get('/api/me', { key: a })).status).toBe(200);

    const r = await del('/api/admin/keys/portal');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { app: 'portal', revoked: 2 } });

    expectErrorShape(await get('/api/me', { key: a }), 401, 'unauthorized');
    expectErrorShape(await get('/api/me', { key: b }), 401, 'unauthorized');
    expect((await get('/api/me', { key: other })).status).toBe(200);
    expect((await get('/api/admin/keys')).body.data.map((k: { app: string }) => k.app)).toEqual(['other-app']);
  });

  it('answers 404 for an app with no keys', async () => {
    const r = await del('/api/admin/keys/nobody');
    expectErrorShape(r, 404, 'not_found');
    expect(r.body.message).toContain('"nobody"');
  });

  it('answers 404 for an app name that could never exist', async () => {
    expectErrorShape(await del('/api/admin/keys/BAD_NAME'), 404, 'not_found');
  });

  it('answers 404 when revoking the same app twice', async () => {
    await newKey('once', ['tasks:read']);
    expect((await del('/api/admin/keys/once')).status).toBe(200);
    expectErrorShape(await del('/api/admin/keys/once'), 404, 'not_found');
  });
});

describe('key management addresses and methods', () => {
  it('refuses methods that are not allowed', async () => {
    const r1 = await call('/api/admin/keys', { method: 'PUT', body: {} });
    expectErrorShape(r1, 405, 'method_not_allowed');
    expect(r1.headers.get('Allow')).toBe('GET,POST');
    const r2 = await call('/api/admin/keys', { method: 'DELETE' });
    expectErrorShape(r2, 405, 'method_not_allowed');
    const r3 = await get('/api/admin/keys/some-app');
    expectErrorShape(r3, 405, 'method_not_allowed');
    expect(r3.headers.get('Allow')).toBe('DELETE');
  });

  it('answers 404 for other admin paths', async () => {
    expectErrorShape(await get('/api/admin'), 404, 'not_found');
    expectErrorShape(await get('/api/admin/users'), 404, 'not_found');
    expectErrorShape(await del('/api/admin/keys/a/b'), 404, 'not_found');
  });

  it('needs a key: no credentials is 401', async () => {
    expectErrorShape(await get('/api/admin/keys', { key: null }), 401, 'unauthorized');
  });
});
