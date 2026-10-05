// --- Cloudflare Access sign-in check ------------------------------------------
// When the owner opens the console, Cloudflare Access signs them in and then
// sends every request with a signed token (a JWT) proving who they are. This
// file checks that token. It is only used when ALL THREE of the vars
// ACCESS_TEAM_DOMAIN, ACCESS_AUD and ACCESS_ALLOWED_EMAILS are set
// (see wrangler.jsonc and README).
//
// A token is accepted only if ALL of these hold:
//   - the team domain looks like "<name>.cloudflareaccess.com" (so a typo in
//     the var can never make us trust keys from some other website),
//   - it has the normal three-part JWT shape and its header says alg "RS256"
//     (anything else, including "none", is refused),
//   - its signature checks out against one of the public keys Cloudflare
//     publishes at https://<team domain>/cdn-cgi/access/certs,
//   - iss is exactly https://<team domain>,
//   - aud contains ACCESS_AUD (the Access application's "AUD tag"),
//   - it has not expired (exp) and is not used before its start time (nbf),
//   - it carries an email address that is on the ACCESS_ALLOWED_EMAILS list.
// Any problem at all means "not signed in" (null). This code never throws.

export interface AccessConfig {
  teamDomain: string; // e.g. "myteam.cloudflareaccess.com" (https:// is optional)
  aud: string; // the Access application's AUD tag
  allowedEmails: string; // comma-separated list of emails that may sign in (any letter case)
}

export interface AccessIdentity {
  email: string;
}

// Things the verifier needs from the outside world. Tests can swap these out:
//   accessDeps.fetch = async (url) => new Response(JSON.stringify({ keys: [...] }));
//   accessDeps.now = () => Date.UTC(2026, 0, 1);
// and call clearJwksCache() between tests. By default they use the real
// global fetch (looked up at call time, so mocking globalThis.fetch also works).
export const accessDeps = {
  fetch: (url: string): Promise<Response> => fetch(url),
  now: (): number => Date.now(),
};

const JWKS_TTL_MS = 60 * 60 * 1000; // keep Cloudflare's public keys for 1 hour
const REFETCH_COOLDOWN_MS = 30 * 1000; // never hit the certs URL more than once per 30 s
const NBF_GRACE_S = 60; // allow 60 s of clock difference on the "not before" time
const STALE_MAX_MS = 24 * 60 * 60 * 1000; // if Cloudflare's URL is failing, keep using old keys for up to 24 hours
const MAX_TOKEN_LENGTH = 8192;
const MAX_TOKEN_CANDIDATES = 4; // header + cookies: never try more than this many tokens per request
// Every Cloudflare Access team domain has this shape.
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/;

// The public keys we have downloaded, by key id ("kid"). Lives as long as the
// Worker instance does, so most requests need no network call at all.
let jwksCache: { url: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
let lastFetchAttempt = 0;
// The download in progress, if any. Requests that arrive while it runs wait for
// it instead of starting their own (or being refused).
let inflight: { url: string; promise: Promise<Map<string, CryptoKey> | null> } | null = null;
// Bumped by clearJwksCache, so a download started before a reset cannot refill the cache after it.
let generation = 0;

/** Forget the downloaded keys, any download in progress and the 30 s wait (used by tests). */
export function clearJwksCache(): void {
  jwksCache = null;
  lastFetchAttempt = 0;
  inflight = null;
  generation++;
}

/** Accepts "team.cloudflareaccess.com", "https://team.cloudflareaccess.com/" etc. */
export function normalizeTeamDomain(raw: string): string {
  return raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

/**
 * Turns "Owner@Example.com, other@example.com" into a set of lowercase emails.
 * Spaces and empty entries are ignored.
 */
export function parseAllowedEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * All three vars must be filled in for Access sign-in to be switched on:
 * the team domain, the AUD tag, and a list with at least one allowed email.
 */
export function accessEnabled(
  teamDomain: string | undefined,
  aud: string | undefined,
  allowedEmails: string | undefined
): boolean {
  return !!(teamDomain && teamDomain.trim() && aud && aud.trim() && parseAllowedEmails(allowedEmails).size);
}

/**
 * Reads the possible Access tokens from the request, in the order to try them:
 * the Cf-Access-Jwt-Assertion header first, then every CF_Authorization cookie
 * in the order sent (a browser can send more than one, e.g. an old one for a
 * parent domain). At most 4 in total. Empty list if there are none.
 */
export function readAccessTokens(req: Request): string[] {
  const out: string[] = [];
  const header = (req.headers.get('Cf-Access-Jwt-Assertion') ?? '').trim();
  if (header) out.push(header);
  const cookies = req.headers.get('Cookie') ?? '';
  for (const part of cookies.split(';')) {
    if (out.length >= MAX_TOKEN_CANDIDATES) break;
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === 'CF_Authorization') {
      const value = part.slice(eq + 1).trim();
      if (value) out.push(value);
    }
  }
  return out;
}

/** Returns the signed-in person's email, or null if the token is not good. */
export async function verifyAccessJwt(token: string, cfg: AccessConfig): Promise<AccessIdentity | null> {
  try {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const domain = normalizeTeamDomain(cfg.teamDomain);
    const aud = cfg.aud.trim();
    const allowed = parseAllowedEmails(cfg.allowedEmails);
    if (!domain || !aud || !allowed.size) return null;
    // Only ever fetch keys from a real Cloudflare Access team domain.
    if (!TEAM_DOMAIN.test(domain)) return null;

    // Shape: three non-empty base64url parts. An "alg: none" token has an
    // empty third part, so it already fails here (and again on alg below).
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = parseJsonObject(base64UrlToString(headerB64));
    if (!header) return null;
    // Pin the algorithm. We never let the token choose how it is checked.
    if (header.alg !== 'RS256') return null;
    if (typeof header.kid !== 'string' || !header.kid) return null;
    // "crit" lists extensions the reader must understand; we understand none.
    if (header.crit !== undefined) return null;

    const payload = parseJsonObject(base64UrlToString(payloadB64));
    if (!payload) return null;

    // Signature first: nothing in the payload is trusted until this passes.
    const key = await getSigningKey(`https://${domain}/cdn-cgi/access/certs`, header.kid);
    if (!key) return null;
    const signedPart = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(sigB64), signedPart);
    if (!valid) return null;

    // Claims.
    const nowS = Math.floor(accessDeps.now() / 1000);
    if (payload.iss !== `https://${domain}`) return null;
    const audOk =
      payload.aud === aud || (Array.isArray(payload.aud) && payload.aud.some((a) => a === aud));
    if (!audOk) return null;
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || nowS >= payload.exp) return null;
    if (payload.nbf !== undefined) {
      if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf)) return null;
      if (nowS + NBF_GRACE_S < payload.nbf) return null;
    }
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    if (!email || email.length > 320) return null;
    // Access may let in more people than the owner (e.g. a wide policy). Only
    // the emails on the ACCESS_ALLOWED_EMAILS list get in here.
    if (!allowed.has(email.toLowerCase())) return null;

    return { email };
  } catch {
    // Malformed base64, bad JSON, a broken key: all just mean "not signed in".
    return null;
  }
}

// Finds the public key with this id. Cloudflare's key list is downloaded when we
// have none, when ours is over an hour old, or when the token names a key we have
// not seen (which happens when Cloudflare rotates keys). Rules:
//   - at most one download every 30 s (a stranger could send made-up key ids),
//   - requests that arrive during a download wait for that same download
//     instead of being refused,
//   - a download that fails, or returns no usable keys, never throws away the
//     keys we already have; those keep working for up to 24 hours.
async function getSigningKey(url: string, kid: string): Promise<CryptoKey | null> {
  const now = accessDeps.now();
  const cached = jwksCache && jwksCache.url === url ? jwksCache : null;
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS && cached.keys.has(kid)) return cached.keys.get(kid)!;

  if (!inflight && now - lastFetchAttempt >= REFETCH_COOLDOWN_MS) {
    lastFetchAttempt = now;
    const gen = generation;
    const promise: Promise<Map<string, CryptoKey> | null> = downloadKeys(url)
      .then((keys) => {
        // An empty list is treated like a failed download: keep what we had.
        if (keys.size && gen === generation) jwksCache = { url, keys, fetchedAt: now };
        return keys;
      })
      .catch((err) => {
        console.error('Could not download Cloudflare Access keys', err);
        return null;
      })
      .finally(() => {
        if (inflight?.promise === promise) inflight = null;
      });
    inflight = { url, promise };
  }

  if (inflight && inflight.url === url) {
    const keys = await inflight.promise;
    if (keys?.has(kid)) return keys.get(kid)!;
  }
  // No fresh answer: fall back to the keys we already had, if they are under 24 hours old.
  if (cached && now - cached.fetchedAt < STALE_MAX_MS) return cached.keys.get(kid) ?? null;
  return null;
}

async function downloadKeys(url: string): Promise<Map<string, CryptoKey>> {
  const res = await accessDeps.fetch(url);
  if (!res.ok) throw new Error(`certs request failed with status ${res.status}`);
  const body = (await res.json()) as { keys?: unknown };
  const out = new Map<string, CryptoKey>();
  const list = Array.isArray(body?.keys) ? body.keys : [];
  for (const k of list as Record<string, unknown>[]) {
    if (!k || typeof k !== 'object') continue;
    if (k.kty !== 'RSA' || typeof k.kid !== 'string' || typeof k.n !== 'string' || typeof k.e !== 'string') continue;
    if (k.alg !== undefined && k.alg !== 'RS256') continue;
    if (k.use !== undefined && k.use !== 'sig') continue;
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );
      out.set(k.kid, key);
    } catch {
      /* skip a key we cannot read */
    }
  }
  return out;
}

// --- small helpers -------------------------------------------------------------

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  if (s.length % 4 === 1) throw new Error('bad base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64UrlToString(s: string): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64UrlToBytes(s));
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const v: unknown = JSON.parse(text);
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
