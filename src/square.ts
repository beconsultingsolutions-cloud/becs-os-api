// --- Square sync (read-only) -------------------------------------------------------
// Keeps invoice status in step with Square, by square_invoice_id. Two paths:
//   1. Webhook: Square POSTs to /api/webhooks/square the moment an invoice
//      changes. We accept it only if Square's HMAC signature checks out.
//   2. Daily check (Worker cron): asks Square for every open linked invoice and fixes
//      anything a missed webhook left behind.
// It only READS from Square. It never creates, sends or changes anything there.
// Every change is written through applyUpdate (same rules and activity log as PATCH),
// with the actor "app:square".

import type { TableName } from './tables';

export interface SquareEnv {
  DB: D1Database;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string; // from the Square webhook subscription (Worker secret)
  SQUARE_ACCESS_TOKEN?: string; // Square production token (Worker secret). Owner chose full access; this code only reads.
  SQUARE_WEBHOOK_URL?: string; // the exact URL registered in Square (signature input). Default: the request URL.
  SQUARE_API_BASE?: string; // default https://connect.squareup.com
}

type Apply = (
  table: TableName,
  id: number,
  existing: Record<string, unknown>,
  values: Record<string, string | number | null>,
  actor: string
) => Promise<Response>;

const ACTOR = 'app:square';
const MAX_BODY = 64 * 1024;

/** Square invoice status -> our invoice status. null = no change (e.g. refunds stay as they are). */
export function mapSquareStatus(s: unknown): 'unpaid' | 'sent' | 'partial' | 'paid' | 'void' | null {
  switch (String(s || '').toUpperCase()) {
    case 'DRAFT': return 'unpaid';
    case 'UNPAID': case 'SCHEDULED': case 'PAYMENT_PENDING': return 'sent';
    case 'PARTIALLY_PAID': return 'partial';
    case 'PAID': return 'paid';
    case 'CANCELED': case 'FAILED': return 'void';
    default: return null;
  }
}

const err = (status: number, error: string, message: string) => Response.json({ error, message }, { status });

async function hmacBase64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Constant-time string compare (hash both sides first, so lengths never leak). */
async function sameText(a: string, b: string): Promise<boolean> {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([h(a), h(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Square signs: base64(HMAC-SHA256(signature key, notification URL + raw body)). */
export async function squareSignatureValid(key: string, url: string, body: string, header: string | null): Promise<boolean> {
  if (!header) return false;
  return sameText(await hmacBase64(key, url + body), header);
}

/** Set every invoice linked to this Square invoice to `status`. Returns how many changed. */
export async function applySquareStatus(env: SquareEnv, apply: Apply, squareInvoiceId: string, status: string): Promise<number> {
  const rows = (await env.DB.prepare('SELECT * FROM payments WHERE square_invoice_id = ?').bind(squareInvoiceId).all()).results as Record<string, unknown>[];
  let changed = 0;
  for (const row of rows) {
    if (row.status === status) continue;
    const res = await apply('payments', row.id as number, row, { status }, ACTOR);
    if (res.ok) changed++;
  }
  return changed;
}

/** POST /api/webhooks/square */
export async function squareWebhook(req: Request, env: SquareEnv, apply: Apply): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY) return err(503, 'not_configured', 'Square sync is not set up yet.');

  const body = await req.text();
  if (body.length > MAX_BODY) return err(413, 'too_large', 'Message too large.');
  const url = env.SQUARE_WEBHOOK_URL || req.url;
  if (!(await squareSignatureValid(env.SQUARE_WEBHOOK_SIGNATURE_KEY, url, body, req.headers.get('x-square-hmacsha256-signature')))) {
    return err(401, 'bad_signature', 'Signature does not match.');
  }

  let event: { type?: string; data?: { object?: { invoice?: { id?: string; status?: string } } } };
  try { event = JSON.parse(body); } catch { return err(400, 'bad_json', 'Body is not JSON.'); }

  const invoice = event?.data?.object?.invoice;
  const status = mapSquareStatus(invoice?.status);
  // Not an invoice event, or a status we leave alone: acknowledge so Square stops retrying.
  if (!invoice?.id || !status) return Response.json({ data: { ignored: true } });

  const updated = await applySquareStatus(env, apply, String(invoice.id), status);
  return Response.json({ data: { invoice: invoice.id, status, updated } });
}

/** Daily check: ask Square about every open linked invoice and fix any drift. */
export async function reconcileSquare(env: SquareEnv, apply: Apply, fetchFn: typeof fetch = fetch): Promise<{ checked: number; updated: number; errors: number; skipped?: string }> {
  if (!env.SQUARE_ACCESS_TOKEN) return { checked: 0, updated: 0, errors: 0, skipped: 'no access token' };
  const base = env.SQUARE_API_BASE || 'https://connect.squareup.com';
  const ids = ((await env.DB.prepare(
    "SELECT DISTINCT square_invoice_id AS sid FROM payments WHERE square_invoice_id IS NOT NULL AND square_invoice_id != '' AND status IN ('unpaid', 'sent', 'partial') LIMIT 200"
  ).all()).results as { sid: string }[]).map((r) => r.sid);

  let updated = 0, errors = 0;
  for (const sid of ids) {
    try {
      const res = await fetchFn(`${base}/v2/invoices/${encodeURIComponent(sid)}`, {
        headers: { Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`, Accept: 'application/json' },
      });
      if (!res.ok) { errors++; continue; }
      const status = mapSquareStatus(((await res.json()) as { invoice?: { status?: string } })?.invoice?.status);
      if (status) updated += await applySquareStatus(env, apply, sid, status);
    } catch { errors++; }
  }
  return { checked: ids.length, updated, errors };
}
