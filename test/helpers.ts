// Shared helpers for the tests. Requests go straight to the Worker's fetch
// handler (src/index.ts) inside workerd, with the real local D1, KV and
// rate-limit bindings. Each test can switch Access on or change the master key
// by passing its own env values.
import { env } from 'cloudflare:workers';
import worker, { type Env } from '../src/index';
import { TABLE_NAMES, type TableName } from '../src/tables';

export const MASTER_KEY = 'test-master-key-0123456789';
export const ORIGIN = 'https://becs.test';

export { TABLE_NAMES, type TableName };

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    DB: env.DB,
    CONFIG: env.CONFIG,
    APP_LIMITER: env.APP_LIMITER,
    API_KEY: MASTER_KEY,
    ACCESS_TEAM_DOMAIN: '',
    ACCESS_AUD: '',
    ACCESS_ALLOWED_EMAILS: '',
    ...over,
  };
}

export interface CallOptions {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent exactly as given (for broken JSON etc.). */
  rawBody?: string;
  /** Bearer key. Defaults to the master key. null = no Authorization header. */
  key?: string | null;
  headers?: Record<string, string>;
  env?: Partial<Env>;
}

export interface CallResult {
  status: number;
  headers: Headers;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export async function call(path: string, opts: CallOptions = {}): Promise<CallResult> {
  const headers = new Headers(opts.headers ?? {});
  const key = opts.key === undefined ? MASTER_KEY : opts.key;
  if (key !== null && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${key}`);
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  const req = new Request(ORIGIN + path, { method: opts.method ?? 'GET', headers, body });
  const res = await worker.fetch(req, testEnv(opts.env));
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, headers: res.headers, text, body: parsed };
}

export const get = (path: string, opts: CallOptions = {}) => call(path, { ...opts, method: 'GET' });
export const post = (path: string, body: unknown, opts: CallOptions = {}) =>
  call(path, { ...opts, method: 'POST', body });
export const patch = (path: string, body: unknown, opts: CallOptions = {}) =>
  call(path, { ...opts, method: 'PATCH', body });
export const del = (path: string, opts: CallOptions = {}) => call(path, { ...opts, method: 'DELETE' });

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Puts an app key straight into KV (the same format the admin endpoint writes). Returns the raw key. */
export async function makeAppKey(scopes: string[], app = 'test-app'): Promise<string> {
  const raw = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.CONFIG.put(
    'key:' + (await sha256Hex(raw)),
    JSON.stringify({ app, scopes, created_at: new Date().toISOString() })
  );
  return raw;
}

export const ALL_SCOPES = [...TABLE_NAMES.flatMap((t) => [`${t}:read`, `${t}:write`]), 'activity:read'];

/** Creates a row through the API as master and returns it. Fails the test if refused. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function create(table: TableName, body: Record<string, unknown>): Promise<any> {
  const r = await post(`/api/${table}`, body);
  if (r.status !== 201) throw new Error(`could not create ${table}: ${r.status} ${r.text}`);
  return r.body.data;
}

/** A minimal valid body for each table. */
export function minimal(table: TableName, n = 1): Record<string, unknown> {
  switch (table) {
    case 'ventures':
      return { slug: `test-venture-${n}`, name: `Test venture ${n}` };
    case 'clients':
      return { venture_id: 1, name: `Client ${n}` };
    case 'projects':
      return { venture_id: 1, name: `Project ${n}` };
    case 'tasks':
      return { venture_id: 1, title: `Task ${n}` };
  }
}

/** The UTC date offset by some days, as YYYY-MM-DD. */
export function day(offset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export async function count(sql: string, ...params: unknown[]): Promise<number> {
  const r = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Every error answer has this shape. */
export function expectErrorShape(r: CallResult, status: number, error: string) {
  if (r.status !== status || !r.body || r.body.error !== error) {
    throw new Error(`expected ${status} ${error}, got ${r.status} ${r.text}`);
  }
  if (typeof r.body.message !== 'string' || !r.body.message.trim()) {
    throw new Error(`error ${error} has no message: ${r.text}`);
  }
  const allowed = error === 'invalid' ? ['error', 'message', 'fields'] : ['error', 'message'];
  const extra = Object.keys(r.body).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`unexpected keys in error body: ${extra.join(', ')}`);
  if (error === 'invalid' && (typeof r.body.fields !== 'object' || r.body.fields === null)) {
    throw new Error(`invalid without fields: ${r.text}`);
  }
}
