// Rate limiting with the real APP_LIMITER binding from wrangler.jsonc
// (60 requests per 60 seconds per app key). The local binding counts the same
// way inside the test runtime, and reset() clears it before every test.
import { describe, expect, it } from 'vitest';
import { expectErrorShape, get, makeAppKey } from './helpers';

describe('rate limiting', () => {
  it('cuts an app key off after 60 requests, with 429 and Retry-After: 60', async () => {
    const key = await makeAppKey(['tasks:read']);
    for (let i = 1; i <= 60; i++) {
      const r = await get('/api/tasks', { key });
      expect(r.status, `request ${i}`).toBe(200);
    }
    const r = await get('/api/tasks', { key });
    expectErrorShape(r, 429, 'rate_limited');
    expect(r.headers.get('Retry-After')).toBe('60');
    // Still blocked on any endpoint, including /api/me.
    expectErrorShape(await get('/api/me', { key }), 429, 'rate_limited');
  });

  it('counts refused requests too, so a key cannot probe without limit', async () => {
    const key = await makeAppKey(['tasks:read']);
    for (let i = 0; i < 60; i++) expect((await get('/api/clients', { key })).status).toBe(403);
    expectErrorShape(await get('/api/clients', { key }), 429, 'rate_limited');
  });

  it('gives a second app key its own budget', async () => {
    const first = await makeAppKey(['tasks:read'], 'first');
    const second = await makeAppKey(['tasks:read'], 'second');
    for (let i = 0; i < 61; i++) await get('/api/tasks', { key: first });
    expect((await get('/api/tasks', { key: first })).status).toBe(429);
    expect((await get('/api/tasks', { key: second })).status).toBe(200);
  });

  it('never limits the master key', async () => {
    for (let i = 0; i < 100; i++) expect((await get('/api/me')).status).toBe(200);
  });

  it('does not count requests with a wrong key against any app key', async () => {
    const key = await makeAppKey(['tasks:read']);
    for (let i = 0; i < 70; i++) await get('/api/tasks', { key: 'wrong' });
    expect((await get('/api/tasks', { key })).status).toBe(200);
  });

  describe('failed sign-ins (AUTH_LIMITER)', () => {
    const from = (ip: string) => ({ 'CF-Connecting-IP': ip });

    it('answers 401 ten times, then cuts the caller IP off with 429 and Retry-After: 60', async () => {
      for (let i = 1; i <= 10; i++) {
        expect((await get('/api/tasks', { key: 'wrong', headers: from('203.0.113.7') })).status, `try ${i}`).toBe(401);
      }
      const r = await get('/api/tasks', { key: 'wrong', headers: from('203.0.113.7') });
      expectErrorShape(r, 429, 'rate_limited');
      expect(r.headers.get('Retry-After')).toBe('60');
    });

    it('counts a missing key the same way', async () => {
      for (let i = 0; i < 10; i++) expect((await get('/api/me', { key: null, headers: from('203.0.113.8') })).status).toBe(401);
      expectErrorShape(await get('/api/me', { key: null, headers: from('203.0.113.8') }), 429, 'rate_limited');
    });

    it('keeps a blocked IP out even with a guess, but never blocks the master key or an app key', async () => {
      const key = await makeAppKey(['tasks:read']);
      for (let i = 0; i < 11; i++) await get('/api/tasks', { key: 'wrong', headers: from('203.0.113.9') });
      expect((await get('/api/me', { headers: from('203.0.113.9') })).status).toBe(200);
      expect((await get('/api/tasks', { key, headers: from('203.0.113.9') })).status).toBe(200);
    });

    it('gives each IP its own budget', async () => {
      for (let i = 0; i < 11; i++) await get('/api/tasks', { key: 'wrong', headers: from('203.0.113.10') });
      expect((await get('/api/tasks', { key: 'wrong', headers: from('203.0.113.11') })).status).toBe(401);
    });

    it('lets requests through when the limiter is missing or broken', async () => {
      const broken = {
        limit: async () => {
          throw new Error('limiter down');
        },
      } as unknown as RateLimit;
      const { vi } = await import('vitest');
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await get('/api/tasks', { key: 'wrong', env: { AUTH_LIMITER: undefined } })).status).toBe(401);
      expect((await get('/api/tasks', { key: 'wrong', env: { AUTH_LIMITER: broken } })).status).toBe(401);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it('lets requests through when the limiter is missing or broken', async () => {
    const key = await makeAppKey(['tasks:read']);
    expect((await get('/api/tasks', { key, env: { APP_LIMITER: undefined } })).status).toBe(200);
    const broken = {
      limit: async () => {
        throw new Error('limiter down');
      },
    } as unknown as RateLimit;
    const { vi } = await import('vitest');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await get('/api/tasks', { key, env: { APP_LIMITER: broken } })).status).toBe(200);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
