// Error shape, no leaking of database errors, CORS, security headers, and
// addresses that do not exist.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { call, count, create, del, expectErrorShape, get, minimal, patch, post, testEnv, type CallResult } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

function expectApiHeaders(r: CallResult) {
  expect(r.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  expect(r.headers.get('Cache-Control')).toBe('no-store');
  expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
}

describe('every error has the same shape and the safety headers', () => {
  const cases: [string, () => Promise<CallResult>, number, string][] = [
    ['400 bad_json', () => call('/api/tasks', { method: 'POST', rawBody: '{' }), 400, 'bad_json'],
    ['400 invalid', () => post('/api/tasks', { venture_id: 1 }), 400, 'invalid'],
    ['400 bad_id', () => get('/api/tasks/abc'), 400, 'bad_id'],
    ['400 empty_body', () => post('/api/tasks', {}), 400, 'empty_body'],
    ['401 unauthorized', () => get('/api/tasks', { key: null }), 401, 'unauthorized'],
    ['404 not_found (row)', () => get('/api/tasks/12345'), 404, 'not_found'],
    ['404 not_found (path)', () => get('/api/nothing-here'), 404, 'not_found'],
    ['404 not_found (outside /api)', () => get('/nothing-here', { key: null }), 404, 'not_found'],
    ['405 method_not_allowed', () => call('/api/tasks', { method: 'PUT', body: {} }), 405, 'method_not_allowed'],
    ['409 conflict', () => post('/api/ventures', { slug: 'becs', name: 'x' }), 409, 'conflict'],
    ['413 too_large', () => post('/api/tasks', { ...minimal('tasks'), pad: 'x'.repeat(70_000) }), 413, 'too_large'],
  ];
  for (const [what, run, status, error] of cases) {
    it(`${what}`, async () => {
      const r = await run();
      expectErrorShape(r, status, error);
      expectApiHeaders(r);
    });
  }

  it('403 forbidden and 429 rate_limited', async () => {
    const { makeAppKey } = await import('./helpers');
    const key = await makeAppKey(['tasks:read']);
    const f = await get('/api/clients', { key });
    expectErrorShape(f, 403, 'forbidden');
    expectApiHeaders(f);
    for (let i = 0; i < 60; i++) await get('/api/tasks', { key });
    const l = await get('/api/tasks', { key });
    expectErrorShape(l, 429, 'rate_limited');
    expectApiHeaders(l);
  });

  it('successful answers carry the same headers', async () => {
    expectApiHeaders(await get('/api/tasks'));
    expectApiHeaders(await get('/api/health', { key: null }));
    expectApiHeaders(await post('/api/tasks', minimal('tasks')));
  });
});

describe('request body size limit (64 KB)', () => {
  const LIMIT = 64 * 1024;
  /** A task body padded with an ignored field to exactly this many bytes. */
  function bodyOfSize(bytes: number): string {
    const base = JSON.stringify({ ...minimal('tasks'), pad: '' });
    return base.replace('"pad":""', `"pad":"${'x'.repeat(bytes - base.length)}"`);
  }

  it('accepts a body of exactly 64 KB', async () => {
    const body = bodyOfSize(LIMIT);
    expect(body.length).toBe(LIMIT);
    const r = await call('/api/tasks', { method: 'POST', rawBody: body });
    expect(r.status, r.text).toBe(201);
  });

  it('refuses a body one byte over 64 KB, and saves nothing', async () => {
    const r = await call('/api/tasks', { method: 'POST', rawBody: bodyOfSize(LIMIT + 1) });
    expectErrorShape(r, 413, 'too_large');
    expect(await count('SELECT COUNT(*) AS n FROM tasks')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM activity_log')).toBe(0);
  });

  it('counts bytes, not characters (emoji take 4 bytes each)', async () => {
    const r = await post('/api/tasks', { ...minimal('tasks'), pad: '😀'.repeat(17_000) });
    expectErrorShape(r, 413, 'too_large');
  });

  it('refuses a big PATCH body too', async () => {
    const t = await create('tasks', minimal('tasks'));
    expectErrorShape(await patch(`/api/tasks/${t.id}`, { title: 'x', pad: 'x'.repeat(70_000) }), 413, 'too_large');
    expect((await get(`/api/tasks/${t.id}`)).body.data.title).toBe('Task 1');
  });

  it('refuses a big body to the key admin endpoint', async () => {
    const r = await post('/api/admin/keys', { app: 'big', scopes: ['tasks:read'], pad: 'x'.repeat(70_000) });
    expectErrorShape(r, 413, 'too_large');
  });

  it('refuses a big body sent in pieces with no Content-Length header', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Never-ending body: the Worker must stop reading once it passes 64 KB.
        if (sent === 0) controller.enqueue(new TextEncoder().encode('{"pad":"'));
        controller.enqueue(chunk);
        sent++;
        if (sent > 1000) controller.close();
      },
    });
    const req = new Request('https://becs.test/api/tasks', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-master-key-0123456789', 'Content-Type': 'application/json' },
      body: stream,
    });
    expect(req.headers.get('Content-Length')).toBeNull();
    const res = await worker.fetch(req, testEnv());
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('too_large');
    expect(sent).toBeLessThan(10);
  });

  it('refuses straight away when Content-Length says the body is over 64 KB', async () => {
    const r = await call('/api/tasks', {
      method: 'POST',
      rawBody: JSON.stringify(minimal('tasks')),
      headers: { 'Content-Length': String(LIMIT + 1) },
    });
    expectErrorShape(r, 413, 'too_large');
  });
});

describe('database failures', () => {
  it('answers 500 server_error without the database message, and logs the real error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.exec('DROP TABLE tasks');
    const r = await get('/api/tasks');
    expectErrorShape(r, 500, 'server_error');
    expect(r.body.message).toBe('Something went wrong on the server. Please try again.');
    expect(r.text).not.toMatch(/sqlite|no such table|D1_|tasks/i);
    expect(spy).toHaveBeenCalled();
    expectApiHeaders(r);
  });

  it('never saves a change it could not log (the change and its log entry go together)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.exec('DROP TABLE activity_log');
    const r = await post('/api/tasks', minimal('tasks'));
    expectErrorShape(r, 500, 'server_error');
    expect(r.text).not.toMatch(/sqlite|activity_log|no such table/i);
    expect(await count('SELECT COUNT(*) AS n FROM tasks')).toBe(0);
  });

  it('keeps an update and a delete whole when the log cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await create('tasks', minimal('tasks'));
    await env.DB.exec('DROP TABLE activity_log');
    expectErrorShape(await patch(`/api/tasks/${t.id}`, { title: 'changed' }), 500, 'server_error');
    expectErrorShape(await del(`/api/tasks/${t.id}`), 500, 'server_error');
    const row = await env.DB.prepare('SELECT title FROM tasks WHERE id = ?').bind(t.id).first<{ title: string }>();
    expect(row?.title).toBe('Task 1');
  });

  it('answers 500 for the dashboard and activity log when their tables are broken', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.DB.exec('DROP TABLE activity_log');
    expectErrorShape(await get('/api/activity'), 500, 'server_error');
    await env.DB.exec('DROP TABLE tasks');
    expectErrorShape(await get('/api/dashboard'), 500, 'server_error');
  });
});

describe('CORS', () => {
  it('answers a preflight request without a key', async () => {
    const r = await call('/api/tasks', {
      method: 'OPTIONS',
      key: null,
      headers: { Origin: 'https://other.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(r.headers.get('Access-Control-Allow-Methods')).toBe('GET,POST,PATCH,DELETE,OPTIONS');
    expect(r.headers.get('Access-Control-Allow-Headers')).toBe('Authorization,Content-Type');
    expect(r.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(r.text).toBe('');
  });

  it('answers a preflight on any /api path', async () => {
    expect((await call('/api/admin/keys/x', { method: 'OPTIONS', key: null })).status).toBe(204);
  });
});

describe('addresses that do not exist', () => {
  for (const old of ['/health', '/tasks', '/clients', '/projects', '/ventures', '/dashboard', '/me', '/admin/keys', '/activity']) {
    it(`answers 404 for the old root address ${old}, even with the master key`, async () => {
      expectErrorShape(await get(old), 404, 'not_found');
      expectErrorShape(await call(old, { method: 'POST', body: minimal('tasks') }), 404, 'not_found');
    });
  }

  it('answers 404 for unknown paths outside /api', async () => {
    expectErrorShape(await get('/nope', { key: null }), 404, 'not_found');
    expectErrorShape(await get('/apis/tasks'), 404, 'not_found');
  });

  it('answers 404 for unknown /api paths once signed in, and 401 before', async () => {
    expectErrorShape(await get('/api'), 404, 'not_found');
    expectErrorShape(await get('/api/payments'), 404, 'not_found');
    expectErrorShape(await get('/api/portal_links'), 404, 'not_found');
    expectErrorShape(await get('/api/activity_log'), 404, 'not_found');
    expectErrorShape(await get('/api/health/x', { key: null }), 401, 'unauthorized');
    expectErrorShape(await get('/api/payments', { key: null }), 401, 'unauthorized');
  });

  it('does not expose the reserved payments and portal_links tables', async () => {
    expectErrorShape(await post('/api/payments', { project_id: 1, label: 'x' }), 404, 'not_found');
    expectErrorShape(await get('/api/portal_links'), 404, 'not_found');
  });
});

describe('the Worker as configured in wrangler.jsonc', () => {
  it('answers /api/health through the real entry point', async () => {
    const res = await exports.default.fetch('https://becs.test/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'becs-os-api' });
  });

  it('runs with the test master key, not a real one', async () => {
    expect(env.API_KEY).toBe('test-master-key-0123456789');
    const res = await exports.default.fetch('https://becs.test/api/me', {
      headers: { Authorization: 'Bearer test-master-key-0123456789' },
    });
    expect(res.status).toBe(200);
  });
});
