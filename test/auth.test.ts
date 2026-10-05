import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  ALL_SCOPES,
  MASTER_KEY,
  TABLE_NAMES,
  call,
  create,
  del,
  expectErrorShape,
  get,
  makeAppKey,
  minimal,
  patch,
  post,
  sha256Hex,
  type TableName,
} from './helpers';

describe('who is calling', () => {
  it('lets anyone check health without a key', async () => {
    const r = await get('/api/health', { key: null });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, service: 'becs-os-api' });
  });

  it('refuses a request with no key at all', async () => {
    expectErrorShape(await get('/api/tasks', { key: null }), 401, 'unauthorized');
  });

  it('refuses a wrong key', async () => {
    expectErrorShape(await get('/api/tasks', { key: 'not-the-key' }), 401, 'unauthorized');
  });

  it('refuses the master key with one character changed', async () => {
    expectErrorShape(await get('/api/tasks', { key: MASTER_KEY.slice(0, -1) + 'X' }), 401, 'unauthorized');
  });

  it('refuses every key when the server has no master key set', async () => {
    expectErrorShape(await get('/api/me', { env: { API_KEY: '' } }), 401, 'unauthorized');
  });

  it('accepts the master key and says so on /api/me', async () => {
    const r = await get('/api/me');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { kind: 'master' } });
  });

  it('accepts an app key and /api/me shows its app name and scopes', async () => {
    const key = await makeAppKey(['tasks:read', 'clients:read'], 'leaa-portal');
    const r = await get('/api/me', { key });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: { kind: 'app', app: 'leaa-portal', scopes: ['tasks:read', 'clients:read'] } });
  });

  it('lets an app key with no table scopes still ask who it is', async () => {
    const key = await makeAppKey(['activity:read']);
    expect((await get('/api/me', { key })).status).toBe(200);
  });

  it('refuses POST on /api/me and /api/health', async () => {
    expectErrorShape(await call('/api/me', { method: 'POST', body: {} }), 405, 'method_not_allowed');
    expectErrorShape(await call('/api/health', { method: 'POST', body: {} }), 405, 'method_not_allowed');
  });

  it('accepts the word Bearer in any letter case', async () => {
    const r = await get('/api/me', { key: null, headers: { Authorization: `bearer ${MASTER_KEY}` } });
    expect(r.status).toBe(200);
  });

  const badHeaders: [string, string][] = [
    ['the word Bearer with no key', 'Bearer'],
    ['two words after Bearer', `Bearer ${MASTER_KEY} extra`],
    ['a Basic header', `Basic ${btoa('user:' + MASTER_KEY)}`],
    ['the raw key without the Bearer word', MASTER_KEY],
    ['a Token scheme', `Token ${MASTER_KEY}`],
    ['a key over 256 characters', `Bearer ${'a'.repeat(257)}`],
    ['a huge 10 KB header', `Bearer ${'b'.repeat(10_000)}`],
  ];
  for (const [what, header] of badHeaders) {
    it(`refuses ${what}`, async () => {
      const r = await get('/api/me', { key: null, headers: { Authorization: header } });
      expectErrorShape(r, 401, 'unauthorized');
    });
  }

  it('treats a key whose stored record is broken as no key', async () => {
    // Keys shaped like real app keys (64 hex characters), so the stored record is really looked up.
    const brokenKey = await sha256Hex('broken-key');
    const noScopesKey = await sha256Hex('no-scopes-key');
    await env.CONFIG.put('key:' + (await sha256Hex(brokenKey)), 'not json');
    await env.CONFIG.put('key:' + (await sha256Hex(noScopesKey)), JSON.stringify({ app: 'x' }));
    expectErrorShape(await get('/api/me', { key: brokenKey }), 401, 'unauthorized');
    expectErrorShape(await get('/api/me', { key: noScopesKey }), 401, 'unauthorized');
  });
});

describe('made-up keys never reach the key store', () => {
  /** A stand-in for the CONFIG key store that counts how often it is read. */
  function countingStore() {
    const store = {
      reads: 0,
      get: (...args: Parameters<KVNamespace['get']>) => {
        store.reads++;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (env.CONFIG.get as any)(...args);
      },
    };
    return store;
  }

  const junk: [string, string][] = [
    ['a short made-up key', 'not-the-key'],
    ['63 hex characters', 'a'.repeat(63)],
    ['65 hex characters', 'a'.repeat(65)],
    ['64 characters that are not all hex', 'g'.repeat(64)],
    ['64 hex characters in capital letters', 'A'.repeat(64)],
    ['a 256-character key', 'z'.repeat(256)],
  ];
  for (const [what, key] of junk) {
    it(`refuses ${what} without looking it up`, async () => {
      const store = countingStore();
      const r = await get('/api/me', { key, env: { CONFIG: store as unknown as KVNamespace } });
      expectErrorShape(r, 401, 'unauthorized');
      expect(store.reads).toBe(0);
    });
  }

  it('refuses a real app key typed in capital letters, without looking it up', async () => {
    const key = await makeAppKey(['tasks:read']);
    const store = countingStore();
    const r = await get('/api/me', { key: key.toUpperCase(), env: { CONFIG: store as unknown as KVNamespace } });
    expectErrorShape(r, 401, 'unauthorized');
    expect(store.reads).toBe(0);
  });

  it('does look up a key shaped like an app key (one read), and accepts a real one', async () => {
    const store = countingStore();
    expectErrorShape(await get('/api/me', { key: 'a'.repeat(64), env: { CONFIG: store as unknown as KVNamespace } }), 401, 'unauthorized');
    expect(store.reads).toBe(1);
    const key = await makeAppKey(['tasks:read']);
    expect((await get('/api/me', { key, env: { CONFIG: store as unknown as KVNamespace } })).status).toBe(200);
    expect(store.reads).toBe(2);
  });

  it('never looks up the master key', async () => {
    const store = countingStore();
    expect((await get('/api/me', { env: { CONFIG: store as unknown as KVNamespace } })).status).toBe(200);
    expect(store.reads).toBe(0);
  });
});

describe('app key scopes, for every table and action', () => {
  type Action = 'list' | 'read' | 'create' | 'update' | 'delete';
  const actions: { action: Action; scope: 'read' | 'write'; okStatus: number }[] = [
    { action: 'list', scope: 'read', okStatus: 200 },
    { action: 'read', scope: 'read', okStatus: 200 },
    { action: 'create', scope: 'write', okStatus: 201 },
    { action: 'update', scope: 'write', okStatus: 200 },
    { action: 'delete', scope: 'write', okStatus: 200 },
  ];

  async function attempt(table: TableName, action: Action, key: string) {
    // A row to read, change or delete (made with the master key).
    const row = await create(table, minimal(table, 99));
    switch (action) {
      case 'list':
        return get(`/api/${table}`, { key });
      case 'read':
        return get(`/api/${table}/${row.id}`, { key });
      case 'create':
        return post(`/api/${table}`, minimal(table, 2), { key });
      case 'update':
        return patch(`/api/${table}/${row.id}`, table === 'tasks' ? { title: 'Changed' } : { name: 'Changed' }, { key });
      case 'delete':
        return del(`/api/${table}/${row.id}`, { key });
    }
  }

  for (const table of TABLE_NAMES) {
    for (const { action, scope, okStatus } of actions) {
      const needed = `${table}:${scope}`;
      it(`${table}: ${action} works with only "${needed}"`, async () => {
        const key = await makeAppKey([needed]);
        const r = await attempt(table, action, key);
        expect(r.status, r.text).toBe(okStatus);
      });
      it(`${table}: ${action} is refused with every scope except "${needed}"`, async () => {
        const key = await makeAppKey(ALL_SCOPES.filter((s) => s !== needed));
        const r = await attempt(table, action, key);
        expectErrorShape(r, 403, 'forbidden');
        expect(r.body.message).toContain(needed);
      });
    }
  }

  it('does not let a refused write change anything', async () => {
    const key = await makeAppKey(['tasks:read']);
    expect((await post('/api/tasks', minimal('tasks'), { key })).status).toBe(403);
    expect((await get('/api/tasks')).body.data).toHaveLength(0);
  });
});

describe('app keys on the other endpoints', () => {
  it('refuses an app key on key management, even one with every scope', async () => {
    const key = await makeAppKey(ALL_SCOPES);
    expectErrorShape(await get('/api/admin/keys', { key }), 403, 'forbidden');
    expectErrorShape(await post('/api/admin/keys', { app: 'evil', scopes: ['tasks:read'] }, { key }), 403, 'forbidden');
    expectErrorShape(await del('/api/admin/keys/test-app', { key }), 403, 'forbidden');
  });

  it('answers 404 (not 403) for other /api/admin/ addresses, for app keys and the master key alike', async () => {
    const key = await makeAppKey(ALL_SCOPES);
    for (const path of ['/api/admin', '/api/admin/other', '/api/admin/keys/x/y']) {
      expectErrorShape(await get(path, { key }), 404, 'not_found');
      expectErrorShape(await get(path), 404, 'not_found');
    }
  });

  const dashScopes = ['tasks:read', 'clients:read', 'projects:read', 'ventures:read'];
  it('lets an app key with the four read scopes see the dashboard', async () => {
    const key = await makeAppKey(dashScopes);
    expect((await get('/api/dashboard', { key })).status).toBe(200);
  });
  for (const missing of dashScopes) {
    it(`refuses the dashboard to an app key missing "${missing}"`, async () => {
      const key = await makeAppKey(ALL_SCOPES.filter((s) => s !== missing));
      const r = await get('/api/dashboard', { key });
      expectErrorShape(r, 403, 'forbidden');
      expect(r.body.message).toContain(missing);
    });
  }

  it('needs "activity:read" for the activity log', async () => {
    const without = await makeAppKey(ALL_SCOPES.filter((s) => s !== 'activity:read'));
    const r = await get('/api/activity', { key: without });
    expectErrorShape(r, 403, 'forbidden');
    expect(r.body.message).toContain('activity:read');
    const withIt = await makeAppKey(['activity:read']);
    expect((await get('/api/activity', { key: withIt })).status).toBe(200);
  });

  it('lets the master key use key management, dashboard and activity', async () => {
    expect((await get('/api/admin/keys')).status).toBe(200);
    expect((await get('/api/dashboard')).status).toBe(200);
    expect((await get('/api/activity')).status).toBe(200);
  });
});
