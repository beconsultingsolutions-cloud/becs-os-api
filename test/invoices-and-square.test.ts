// Invoices (the payments table, piece C) and the Square sync.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { applyUpdate } from '../src/index';
import { mapSquareStatus, reconcileSquare } from '../src/square';
import { call, create, del, day, expectErrorShape, get, minimal, patch, post, testEnv } from './helpers';

const SQ_KEY = 'test-square-signature-key';
const SQ_URL = 'https://becs.test/api/webhooks/square';
const sqEnv = { SQUARE_WEBHOOK_SIGNATURE_KEY: SQ_KEY, SQUARE_WEBHOOK_URL: SQ_URL };

async function sign(body: string, key = SQ_KEY, url = SQ_URL): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(url + body)));
  return btoa(String.fromCharCode(...sig));
}

/** POST a Square-style event to the webhook, signed (or with the given signature). */
async function squareEvent(invoiceId: string, status: string, opts: { signature?: string; type?: string } = {}) {
  const body = JSON.stringify({ type: opts.type ?? 'invoice.updated', event_id: crypto.randomUUID(), data: { object: { invoice: { id: invoiceId, status } } } });
  return call('/api/webhooks/square', {
    method: 'POST', rawBody: body, key: null, env: sqEnv,
    headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': opts.signature ?? (await sign(body)) },
  });
}

async function project(over: Record<string, unknown> = {}) {
  return create('projects', { ...minimal('projects', Math.floor(Math.random() * 1e6)), ...over });
}

const apply = (table: Parameters<typeof applyUpdate>[1], id: number, existing: Record<string, unknown>, values: Record<string, string | number | null>, actor: string) =>
  applyUpdate(testEnv(), table, id, existing, values, actor);

describe('invoices', () => {
  it('stamps paid_at when an invoice becomes paid, and clears it if it stops being paid', async () => {
    const p = await project();
    const inv = await create('payments', { project_id: p.id, label: 'Deposit 50%', amount_cents: 280000, status: 'sent' });
    expect(inv.paid_at).toBeNull();
    const paid = (await patch(`/api/payments/${inv.id}`, { status: 'paid' })).body.data;
    expect(paid.paid_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect((await patch(`/api/payments/${inv.id}`, { status: 'sent' })).body.data.paid_at).toBeNull();
    const createdPaid = await create('payments', { project_id: p.id, label: 'Cash', amount_cents: 100, status: 'paid' });
    expect(createdPaid.paid_at).not.toBeNull();
  });

  it('requires a label and an amount, and checks status, amount and links', async () => {
    const p = await project();
    const r = await post('/api/payments', { project_id: p.id });
    expectErrorShape(r, 400, 'invalid');
    expect(r.body.fields).toHaveProperty('label');
    expect(r.body.fields).toHaveProperty('amount_cents');
    for (const [field, bad] of [['amount_cents', -5], ['status', 'late'], ['square_url', 'http://squareup.com/x'], ['square_url', 'not a link'], ['due_date', '2026-02-30']] as const) {
      const res = await post('/api/payments', { project_id: p.id, label: 'x', amount_cents: 1, [field]: bad });
      expectErrorShape(res, 400, 'invalid');
      expect(res.body.fields, field + '=' + bad).toHaveProperty(field);
    }
    expect((await post('/api/payments', { project_id: p.id, label: 'x', amount_cents: 1, square_url: 'https://squareup.com/pay-invoice/abc' })).status).toBe(201);
  });

  it('can be tied to a milestone, and a milestone with invoices cannot be deleted', async () => {
    const p = await project();
    const m = await create('milestones', { project_id: p.id, title: 'M4 Launch' });
    await create('payments', { project_id: p.id, milestone_id: m.id, label: 'Balance at launch', amount_cents: 280000 });
    const r = await del(`/api/milestones/${m.id}`);
    expectErrorShape(r, 409, 'conflict');
    expect(r.body.message).toContain('invoice');
  });

  it('blocks deleting a project that still has invoices', async () => {
    const p = await project();
    await create('payments', { project_id: p.id, label: 'Deposit', amount_cents: 100 });
    expectErrorShape(await del(`/api/projects/${p.id}`), 409, 'conflict');
  });
});

describe('dashboard money summary', () => {
  it('adds up owed, late and paid this month, and leaves void out', async () => {
    const p = await project({ venture_id: 2 });
    await create('payments', { project_id: p.id, label: 'Late', amount_cents: 1000, status: 'sent', due_date: day(-3) });
    await create('payments', { project_id: p.id, label: 'Owed later', amount_cents: 2000, status: 'unpaid', due_date: day(10) });
    await create('payments', { project_id: p.id, label: 'Part paid', amount_cents: 500, status: 'partial' });
    await create('payments', { project_id: p.id, label: 'Paid', amount_cents: 4000, status: 'paid' });
    await create('payments', { project_id: p.id, label: 'Void', amount_cents: 9000, status: 'void', due_date: day(-1) });
    const m = (await get(`/api/dashboard?today=${day(0)}`)).body.data.money;
    expect(m).toMatchObject({ outstanding_count: 3, outstanding_cents: 3500, late_count: 1, late_cents: 1000, paid_this_month_count: 1, paid_this_month_cents: 4000 });
    expect(m.due_within_14_days.map((x: { label: string }) => x.label)).toEqual(['Late', 'Owed later']);
    expect(m.due_within_14_days[0]).toMatchObject({ project_name: p.name, amount_cents: 1000, status: 'sent' });
  });

  it('follows the venture filter through the invoice project', async () => {
    const a = await project({ venture_id: 2 }), b = await project({ venture_id: 3 });
    await create('payments', { project_id: a.id, label: 'A', amount_cents: 100 });
    await create('payments', { project_id: b.id, label: 'B', amount_cents: 7000 });
    expect((await get('/api/dashboard?venture_id=3')).body.data.money.outstanding_cents).toBe(7000);
  });
});

describe('Square webhook', () => {
  it('maps Square invoice statuses', () => {
    expect([mapSquareStatus('PAID'), mapSquareStatus('PARTIALLY_PAID'), mapSquareStatus('CANCELED'), mapSquareStatus('UNPAID'), mapSquareStatus('DRAFT'), mapSquareStatus('REFUNDED'), mapSquareStatus(undefined)])
      .toEqual(['paid', 'partial', 'void', 'sent', 'unpaid', null, null]);
  });

  it('answers 503 until the signature key is set', async () => {
    const r = await call('/api/webhooks/square', { method: 'POST', rawBody: '{}', key: null });
    expectErrorShape(r, 503, 'not_configured');
  });

  it('marks the linked invoice paid on a signed PAID event, as app:square, with no API key', async () => {
    const p = await project();
    const inv = await create('payments', { project_id: p.id, label: 'Deposit', amount_cents: 280000, status: 'sent', square_invoice_id: 'inv:sq-paid-1' });
    const r = await squareEvent('inv:sq-paid-1', 'PAID', { type: 'invoice.payment_made' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'paid', updated: 1 });
    const now = (await get(`/api/payments/${inv.id}`)).body.data;
    expect(now.status).toBe('paid');
    expect(now.paid_at).not.toBeNull();
    const log = (await get(`/api/activity?entity_type=payments&entity_id=${inv.id}`)).body.data;
    expect(log[0]).toMatchObject({ action: 'updated', actor: 'app:square' });
  });

  it('sets partial and void, and a repeat of the same event changes nothing', async () => {
    const p = await project();
    const inv = await create('payments', { project_id: p.id, label: 'Balance', amount_cents: 500, status: 'sent', square_invoice_id: 'inv:sq-2' });
    expect((await squareEvent('inv:sq-2', 'PARTIALLY_PAID')).body.data.updated).toBe(1);
    expect((await get(`/api/payments/${inv.id}`)).body.data.status).toBe('partial');
    expect((await squareEvent('inv:sq-2', 'PARTIALLY_PAID')).body.data.updated).toBe(0);
    expect((await squareEvent('inv:sq-2', 'CANCELED')).body.data.updated).toBe(1);
    expect((await get(`/api/payments/${inv.id}`)).body.data.status).toBe('void');
  });

  it('refuses a forged or missing signature and changes nothing', async () => {
    const p = await project();
    const inv = await create('payments', { project_id: p.id, label: 'Target', amount_cents: 100, status: 'sent', square_invoice_id: 'inv:sq-forge' });
    const body = JSON.stringify({ data: { object: { invoice: { id: 'inv:sq-forge', status: 'PAID' } } } });
    expectErrorShape(await squareEvent('inv:sq-forge', 'PAID', { signature: await sign(body, 'wrong-key') }), 401, 'bad_signature');
    expectErrorShape(await call('/api/webhooks/square', { method: 'POST', rawBody: body, key: null, env: sqEnv }), 401, 'bad_signature');
    // Signed for a different URL (Square signs URL + body).
    expectErrorShape(await squareEvent('inv:sq-forge', 'PAID', { signature: await sign(body, SQ_KEY, 'https://evil.test/hook') }), 401, 'bad_signature');
    expect((await get(`/api/payments/${inv.id}`)).body.data.status).toBe('sent');
  });

  it('acknowledges events it does not act on: unknown invoices, non-invoice events, refunds', async () => {
    expect((await squareEvent('inv:nobody', 'PAID')).body.data).toMatchObject({ updated: 0 });
    const payEvent = JSON.stringify({ type: 'payment.updated', data: { object: { payment: { id: 'p1' } } } });
    const r = await call('/api/webhooks/square', { method: 'POST', rawBody: payEvent, key: null, env: sqEnv, headers: { 'x-square-hmacsha256-signature': await sign(payEvent) } });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ ignored: true });
    expect((await squareEvent('inv:any', 'REFUNDED')).body.data).toEqual({ ignored: true });
  });

  it('only accepts POST', async () => {
    expect((await call('/api/webhooks/square', { method: 'GET', key: null, env: sqEnv })).status).toBe(405);
  });
});

describe('daily Square check', () => {
  it('does nothing without an access token', async () => {
    expect(await reconcileSquare(testEnv(), apply)).toMatchObject({ checked: 0, skipped: 'no access token' });
  });

  it('asks Square about open linked invoices, fixes drift, and counts errors', async () => {
    const p = await project();
    const a = await create('payments', { project_id: p.id, label: 'A', amount_cents: 100, status: 'sent', square_invoice_id: 'inv:rc-a' });
    await create('payments', { project_id: p.id, label: 'B', amount_cents: 100, status: 'sent', square_invoice_id: 'inv:rc-b' });
    await create('payments', { project_id: p.id, label: 'Done', amount_cents: 100, status: 'paid', square_invoice_id: 'inv:rc-done' });
    const asked: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      asked.push(url);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      if (url.endsWith('inv%3Arc-a')) return Response.json({ invoice: { id: 'inv:rc-a', status: 'PAID' } });
      return new Response('boom', { status: 500 });
    }) as typeof fetch;
    const res = await reconcileSquare({ ...testEnv(), SQUARE_ACCESS_TOKEN: 'test-token', SQUARE_API_BASE: 'https://sq.test' }, apply, fakeFetch);
    expect(res).toEqual({ checked: 2, updated: 1, errors: 1 });
    expect(asked.every((u) => u.startsWith('https://sq.test/v2/invoices/'))).toBe(true);
    expect((await get(`/api/payments/${a.id}`)).body.data.status).toBe('paid');
  });
});

void env;
