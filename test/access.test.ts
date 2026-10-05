// Cloudflare Access sign-in. The test makes its own RSA key pair, serves the
// public half as the team's key list through accessDeps.fetch, and signs tokens
// with the private half, so every check in src/access.ts runs for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessDeps, accessEnabled, clearJwksCache, readAccessTokens, verifyAccessJwt } from '../src/access';
import { ORIGIN, call, count, expectErrorShape, get, minimal, post } from './helpers';

const TEAM = 'becs-team.cloudflareaccess.com';
const AUD = 'aud-tag-0123456789abcdef';
const ISS = `https://${TEAM}`;
const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
const EMAIL = 'owner@example.com';
const NOW_MS = Date.UTC(2026, 9, 4, 12, 0, 0);
const NOW_S = NOW_MS / 1000;
const accessOn = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: EMAIL };

// --- token making ---------------------------------------------------------------

const enc = new TextEncoder();
function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Signer {
  kid: string;
  jwk: JsonWebKey & { kid: string };
  priv: CryptoKey;
}

async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { kid, priv: pair.privateKey, jwk: { kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid } };
}

function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISS, aud: [AUD], email: EMAIL, sub: 'user-1', iat: NOW_S - 10, exp: NOW_S + 3600, ...over };
}

async function sign(signer: Signer, payload: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid: signer.kid, typ: 'JWT', ...header }));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.priv, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

// --- fake key list server ---------------------------------------------------------

let signer: Signer;
let served: JsonWebKey[];
let fetches: string[];
let certsStatus = 200;
const realFetch = accessDeps.fetch;
const realNow = accessDeps.now;
let nowMs = NOW_MS;

beforeEach(async () => {
  signer = await makeSigner('kid-1');
  served = [signer.jwk];
  fetches = [];
  certsStatus = 200;
  nowMs = NOW_MS;
  clearJwksCache();
  accessDeps.fetch = async (url: string) => {
    fetches.push(url);
    return new Response(JSON.stringify({ keys: served }), { status: certsStatus });
  };
  accessDeps.now = () => nowMs;
});

afterEach(() => {
  accessDeps.fetch = realFetch;
  accessDeps.now = realNow;
  clearJwksCache();
  vi.restoreAllMocks();
});

const cfg = { teamDomain: TEAM, aud: AUD, allowedEmails: EMAIL };

/** /api/me with a token in the Access header, Access switched on. */
const meWith = (token: string, extra: { headers?: Record<string, string> } = {}) =>
  get('/api/me', { key: null, env: accessOn, headers: { 'Cf-Access-Jwt-Assertion': token, ...extra.headers } });

// ------------------------------------------------------------------------------------

describe('Access sign-in: good tokens', () => {
  it('signs in the owner from the Cf-Access-Jwt-Assertion header', async () => {
    const r = await meWith(await sign(signer, claims()));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toEqual({ data: { kind: 'user', email: EMAIL } });
    expect(fetches).toEqual([CERTS_URL]);
  });

  it('signs in the owner from the CF_Authorization cookie', async () => {
    const token = await sign(signer, claims());
    const r = await get('/api/me', {
      key: null,
      env: accessOn,
      headers: { Cookie: `theme=dark; CF_Authorization=${token}; other=1` },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.data).toEqual({ kind: 'user', email: EMAIL });
  });

  it('accepts aud given as a single string', async () => {
    expect((await meWith(await sign(signer, claims({ aud: AUD })))).status).toBe(200);
  });

  it('accepts the team domain written with https:// and a trailing slash', async () => {
    const token = await sign(signer, claims());
    const r = await get('/api/me', {
      key: null,
      env: { ...accessOn, ACCESS_TEAM_DOMAIN: `https://${TEAM}/` },
      headers: { 'Cf-Access-Jwt-Assertion': token },
    });
    expect(r.status).toBe(200);
  });

  it('downloads the key list once and reuses it', async () => {
    const token = await sign(signer, claims());
    for (let i = 0; i < 3; i++) expect((await meWith(token)).status).toBe(200);
    expect(fetches).toHaveLength(1);
  });

  it('downloads the key list again once it is over an hour old', async () => {
    const token = await sign(signer, claims({ exp: NOW_S + 10_000 }));
    expect((await meWith(token)).status).toBe(200);
    nowMs = NOW_MS + 61 * 60 * 1000;
    expect((await meWith(token)).status).toBe(200);
    expect(fetches).toHaveLength(2);
  });

  it('accepts a token one second before it expires', async () => {
    nowMs = (NOW_S + 3599) * 1000;
    expect((await meWith(await sign(signer, claims()))).status).toBe(200);
  });

  it('accepts a token whose start time is up to 60 seconds in the future (clock drift)', async () => {
    expect((await meWith(await sign(signer, claims({ nbf: NOW_S + 60 })))).status).toBe(200);
  });
});

describe('Access sign-in: bad tokens are refused', () => {
  const refuses = async (token: string) => expectErrorShape(await meWith(token), 401, 'unauthorized');

  it('refuses a token for another application (wrong aud)', async () => {
    await refuses(await sign(signer, claims({ aud: ['someone-else'] })));
  });
  it('refuses a token with no aud', async () => {
    await refuses(await sign(signer, claims({ aud: undefined })));
  });
  it('refuses a token from another team (wrong iss)', async () => {
    await refuses(await sign(signer, claims({ iss: 'https://evil.cloudflareaccess.com' })));
  });
  it('refuses an iss that differs only by a trailing slash', async () => {
    await refuses(await sign(signer, claims({ iss: ISS + '/' })));
  });
  it('refuses a token at the exact second it expires', async () => {
    await refuses(await sign(signer, claims({ exp: NOW_S })));
  });
  it('refuses an expired token', async () => {
    await refuses(await sign(signer, claims({ exp: NOW_S - 1 })));
  });
  it('refuses a token with no expiry', async () => {
    await refuses(await sign(signer, claims({ exp: undefined })));
  });
  it('refuses a token with a text expiry', async () => {
    await refuses(await sign(signer, claims({ exp: String(NOW_S + 3600) })));
  });
  it('refuses a token not valid for another 61 seconds', async () => {
    await refuses(await sign(signer, claims({ nbf: NOW_S + 61 })));
  });
  it('refuses a token with a text start time', async () => {
    await refuses(await sign(signer, claims({ nbf: 'soon' })));
  });
  it('refuses a token with no email', async () => {
    await refuses(await sign(signer, claims({ email: undefined })));
  });
  it('refuses a token with an empty email', async () => {
    await refuses(await sign(signer, claims({ email: '   ' })));
  });
  it('refuses a token whose payload was changed after signing', async () => {
    const token = await sign(signer, claims());
    const [h, , s] = token.split('.');
    const forged = b64url(JSON.stringify(claims({ email: 'attacker@example.com' })));
    await refuses(`${h}.${forged}.${s}`);
  });
  it('refuses a token whose signature was changed', async () => {
    const token = await sign(signer, claims());
    const [h, p, s] = token.split('.');
    const flipped = (s[10] === 'A' ? 'B' : 'A');
    await refuses(`${h}.${p}.${s.slice(0, 10)}${flipped}${s.slice(11)}`);
  });
  it('refuses a token signed by a different key that claims the known key id', async () => {
    const impostor = await makeSigner('kid-1');
    await refuses(await sign(impostor, claims()));
  });
  it('refuses an unsigned token (alg none)', async () => {
    const h = b64url(JSON.stringify({ alg: 'none', kid: 'kid-1', typ: 'JWT' }));
    const p = b64url(JSON.stringify(claims()));
    await refuses(`${h}.${p}.`);
    await refuses(`${h}.${p}.c2ln`);
  });
  it('refuses an HS256 token signed with the public key as the secret (algorithm confusion)', async () => {
    const h = b64url(JSON.stringify({ alg: 'HS256', kid: 'kid-1', typ: 'JWT' }));
    const p = b64url(JSON.stringify(claims()));
    const secret = await crypto.subtle.importKey(
      'raw',
      enc.encode(JSON.stringify(signer.jwk)),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', secret, enc.encode(`${h}.${p}`));
    await refuses(`${h}.${p}.${b64url(new Uint8Array(sig))}`);
  });
  it('refuses a correctly signed token whose header says RS512', async () => {
    await refuses(await sign(signer, claims(), { alg: 'RS512' }));
  });
  it('refuses a token with no key id', async () => {
    await refuses(await sign(signer, claims(), { kid: undefined }));
  });
  it('refuses a token with a "crit" header', async () => {
    await refuses(await sign(signer, claims(), { crit: ['exp'] }));
  });
  it('refuses a token longer than 8192 characters', async () => {
    await refuses(await sign(signer, claims({ pad: 'x'.repeat(9000) })));
  });

  const garbage = ['garbage', 'a.b', 'a.b.c', 'a.b.c.d', '...', 'a b.c d.e f', 'eyJhbGciOiJSUzI1NiJ9.e30.!!!', '%%%.%%%.%%%'];
  for (const g of garbage) {
    it(`refuses the garbage token "${g}"`, async () => {
      await refuses(g);
    });
  }

  it('refuses a token whose header is a JSON array', async () => {
    const h = b64url('["RS256"]');
    await refuses(`${h}.${b64url(JSON.stringify(claims()))}.c2ln`);
  });

  it('refuses everyone (and does not crash) when the key list cannot be downloaded', async () => {
    certsStatus = 500;
    await refuses(await sign(signer, claims()));
  });

  it('refuses everyone when the key list download throws', async () => {
    accessDeps.fetch = async () => {
      throw new Error('network down');
    };
    await refuses(await sign(signer, claims()));
  });

  it('skips keys in the list that are not RSA signing keys', async () => {
    served = [{ ...signer.jwk, kty: 'EC' }, { ...signer.jwk, use: 'enc' }, { ...signer.jwk, alg: 'RS512' }];
    await refuses(await sign(signer, claims()));
  });
});

describe('Access sign-in: key rotation', () => {
  it('fetches the key list once more for an unknown key id, then accepts the new key', async () => {
    expect((await meWith(await sign(signer, claims()))).status).toBe(200);
    expect(fetches).toHaveLength(1);

    // Cloudflare rotates its keys. 31 seconds later a token signed by the new key arrives.
    const rotated = await makeSigner('kid-2');
    served = [signer.jwk, rotated.jwk];
    nowMs = NOW_MS + 31_000;
    expect((await meWith(await sign(rotated, claims()))).status).toBe(200);
    expect(fetches).toHaveLength(2);
  });

  it('does not fetch again for unknown key ids within 30 seconds', async () => {
    expect((await meWith(await sign(signer, claims()))).status).toBe(200);
    const stranger = await makeSigner('kid-made-up');
    for (let i = 0; i < 5; i++) expect((await meWith(await sign(stranger, claims()))).status).toBe(401);
    expect(fetches).toHaveLength(1);
  });

  it('after 30 seconds refetches exactly once for an unknown key id and still refuses it', async () => {
    expect((await meWith(await sign(signer, claims()))).status).toBe(200);
    const stranger = await makeSigner('kid-made-up');
    nowMs = NOW_MS + 31_000;
    expect((await meWith(await sign(stranger, claims()))).status).toBe(401);
    expect((await meWith(await sign(stranger, claims()))).status).toBe(401);
    expect(fetches).toHaveLength(2);
    // The known key still works without another download.
    expect((await meWith(await sign(signer, claims()))).status).toBe(200);
    expect(fetches).toHaveLength(2);
  });
});

describe('Access switched on and off', () => {
  it('is off when any of the three settings is empty or blank', () => {
    expect(accessEnabled(TEAM, AUD, EMAIL)).toBe(true);
    expect(accessEnabled('', AUD, EMAIL)).toBe(false);
    expect(accessEnabled(TEAM, '', EMAIL)).toBe(false);
    expect(accessEnabled('  ', AUD, EMAIL)).toBe(false);
    expect(accessEnabled(TEAM, undefined, EMAIL)).toBe(false);
    expect(accessEnabled(TEAM, AUD, '')).toBe(false);
    expect(accessEnabled(TEAM, AUD, undefined)).toBe(false);
    expect(accessEnabled(TEAM, AUD, ' , ,  ')).toBe(false);
  });

  const offs: [string, Record<string, string>][] = [
    ['the team domain is unset', { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: EMAIL }],
    ['the AUD tag is unset', { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '', ACCESS_ALLOWED_EMAILS: EMAIL }],
    ['the allowed emails are unset', { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ACCESS_ALLOWED_EMAILS: '' }],
    ['the allowed emails list is only commas and spaces', { ...accessOn, ACCESS_ALLOWED_EMAILS: ' , , ' }],
    ['all three are unset', { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', ACCESS_ALLOWED_EMAILS: '' }],
  ];
  for (const [what, vars] of offs) {
    it(`ignores a valid token when ${what}`, async () => {
      const token = await sign(signer, claims());
      const r = await get('/api/me', { key: null, env: vars, headers: { 'Cf-Access-Jwt-Assertion': token } });
      expectErrorShape(r, 401, 'unauthorized');
      expect(fetches).toHaveLength(0);
    });
  }

  it('lists the header first, then every CF_Authorization cookie in order', () => {
    const tokens = (headers: Record<string, string> = {}) => readAccessTokens(new Request(ORIGIN, { headers }));
    expect(tokens({ 'Cf-Access-Jwt-Assertion': ' h ', Cookie: 'CF_Authorization=c' })).toEqual(['h', 'c']);
    expect(tokens({ Cookie: 'a=1; CF_Authorization=c' })).toEqual(['c']);
    expect(tokens({ Cookie: 'CF_Authorization=c1; x=2; CF_Authorization=c2' })).toEqual(['c1', 'c2']);
    expect(tokens({ Cookie: 'XCF_Authorization=c' })).toEqual([]);
    expect(tokens({ Cookie: 'CF_Authorization=' })).toEqual([]);
    expect(tokens({ 'Cf-Access-Jwt-Assertion': '   ' })).toEqual([]);
    expect(tokens()).toEqual([]);
  });

  it('never lists more than 4 tokens', () => {
    const cookies = ['c1', 'c2', 'c3', 'c4', 'c5'].map((c) => `CF_Authorization=${c}`).join('; ');
    expect(readAccessTokens(new Request(ORIGIN, { headers: { 'Cf-Access-Jwt-Assertion': 'h', Cookie: cookies } }))).toEqual(
      ['h', 'c1', 'c2', 'c3']
    );
    expect(readAccessTokens(new Request(ORIGIN, { headers: { Cookie: cookies } }))).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('verifyAccessJwt never throws, even on nonsense input', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await verifyAccessJwt(undefined as any, cfg)).toBe(null);
    expect(await verifyAccessJwt('', cfg)).toBe(null);
    expect(await verifyAccessJwt(await sign(signer, claims()), { ...cfg, teamDomain: '' })).toBe(null);
    expect(await verifyAccessJwt(await sign(signer, claims()), { ...cfg, allowedEmails: '' })).toBe(null);
    expect(await verifyAccessJwt(await sign(signer, claims()), cfg)).toEqual({ email: EMAIL });
  });
});

describe('Access sign-in: the allowed emails list', () => {
  it('refuses a good token for someone who is not on the list', async () => {
    const r = await meWith(await sign(signer, claims({ email: 'stranger@example.com' })));
    expectErrorShape(r, 401, 'unauthorized');
  });

  it('ignores letter case and spaces in the list', async () => {
    const r = await get('/api/me', {
      key: null,
      env: { ...accessOn, ACCESS_ALLOWED_EMAILS: ' helper@example.com ,  OWNER@Example.COM ,' },
      headers: { 'Cf-Access-Jwt-Assertion': await sign(signer, claims()) },
    });
    expect(r.status, r.text).toBe(200);
    expect(r.body.data).toEqual({ kind: 'user', email: EMAIL });
  });

  it('ignores letter case in the email inside the token', async () => {
    const r = await meWith(await sign(signer, claims({ email: 'Owner@EXAMPLE.com' })));
    expect(r.status, r.text).toBe(200);
  });

  it('lets in every email on a list of several', async () => {
    const env = { ...accessOn, ACCESS_ALLOWED_EMAILS: `${EMAIL},helper@example.com` };
    for (const email of [EMAIL, 'helper@example.com']) {
      const token = await sign(signer, claims({ email }));
      const r = await get('/api/me', { key: null, env, headers: { 'Cf-Access-Jwt-Assertion': token } });
      expect(r.body.data, r.text).toEqual({ kind: 'user', email });
    }
  });
});

describe('Access sign-in: the team domain must be a Cloudflare Access domain', () => {
  const badDomains = [
    'evil.example.com',
    'becs-team.cloudflareaccess.com.evil.example',
    'evil.example/becs-team.cloudflareaccess.com',
    'becs.team.cloudflareaccess.com',
    'cloudflareaccess.com',
    'becs-team.cloudflareaccess.co',
  ];
  for (const domain of badDomains) {
    it(`refuses every token, without downloading anything, when the team domain is "${domain}"`, async () => {
      const token = await sign(signer, claims({ iss: `https://${domain}` }));
      const r = await get('/api/me', {
        key: null,
        env: { ...accessOn, ACCESS_TEAM_DOMAIN: domain },
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
      expectErrorShape(r, 401, 'unauthorized');
      expect(fetches).toHaveLength(0);
    });
  }

  it('accepts the team domain in capital letters', async () => {
    const r = await get('/api/me', {
      key: null,
      env: { ...accessOn, ACCESS_TEAM_DOMAIN: TEAM.toUpperCase() },
      headers: { 'Cf-Access-Jwt-Assertion': await sign(signer, claims()) },
    });
    expect(r.status, r.text).toBe(200);
  });
});

describe('Access sign-in: several tokens in one request', () => {
  const meWithHeaders = (headers: Record<string, string>) => get('/api/me', { key: null, env: accessOn, headers });

  it('uses a good cookie when the header token is bad', async () => {
    const good = await sign(signer, claims());
    const r = await meWithHeaders({ 'Cf-Access-Jwt-Assertion': 'garbage', Cookie: `CF_Authorization=${good}` });
    expect(r.status, r.text).toBe(200);
    expect(r.body.data).toEqual({ kind: 'user', email: EMAIL });
  });

  it('uses the second cookie when the first one has expired', async () => {
    const old = await sign(signer, claims({ exp: NOW_S - 100 }));
    const good = await sign(signer, claims());
    const r = await meWithHeaders({ Cookie: `CF_Authorization=${old}; theme=dark; CF_Authorization=${good}` });
    expect(r.status, r.text).toBe(200);
  });

  it('tries at most 4 tokens, so a good fifth one is not reached', async () => {
    const good = await sign(signer, claims());
    const bad = await sign(signer, claims({ aud: ['other'] }));
    const fourth = `CF_Authorization=${bad}; CF_Authorization=${bad}; CF_Authorization=${good}`;
    expect((await meWithHeaders({ 'Cf-Access-Jwt-Assertion': bad, Cookie: fourth })).status).toBe(200);
    const fifth = `CF_Authorization=${bad}; CF_Authorization=${bad}; CF_Authorization=${bad}; CF_Authorization=${good}`;
    expectErrorShape(await meWithHeaders({ 'Cf-Access-Jwt-Assertion': bad, Cookie: fifth }), 401, 'unauthorized');
  });

  it('still never falls back to Access when any Authorization header is sent', async () => {
    const good = await sign(signer, claims());
    const r = await meWithHeaders({ Authorization: 'Bearer wrong', Cookie: `CF_Authorization=${good}` });
    expectErrorShape(r, 401, 'unauthorized');
  });
});

describe('Access sign-in: downloading the key list safely', () => {
  /** Makes the fake key list server answer after a short pause, like a real network. */
  function slowServer() {
    accessDeps.fetch = async (url: string) => {
      fetches.push(url);
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ keys: served }), { status: certsStatus });
    };
  }

  it('signs in 10 requests that arrive together on a fresh server, with one download', async () => {
    slowServer();
    const token = await sign(signer, claims());
    const results = await Promise.all(Array.from({ length: 10 }, () => meWith(token)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(fetches).toHaveLength(1);
  });

  it('keeps using a known key for up to 24 hours while the key list cannot be downloaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await sign(signer, claims({ exp: NOW_S + 3 * 24 * 3600 }));
    expect((await meWith(token)).status).toBe(200);

    certsStatus = 500; // Cloudflare's key URL starts failing
    nowMs = NOW_MS + 61 * 60 * 1000; // past the 1 hour refresh time
    expect((await meWith(token)).status).toBe(200);
    expect(fetches).toHaveLength(2);

    nowMs = NOW_MS + 23 * 3600 * 1000;
    expect((await meWith(token)).status).toBe(200);

    nowMs = NOW_MS + 24 * 3600 * 1000 + 60_000; // over 24 hours old: no longer trusted
    expectErrorShape(await meWith(token), 401, 'unauthorized');
  });

  it('keeps using a known key when the download throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await sign(signer, claims({ exp: NOW_S + 10_000 }));
    expect((await meWith(token)).status).toBe(200);
    accessDeps.fetch = async () => {
      throw new Error('network down');
    };
    nowMs = NOW_MS + 61 * 60 * 1000;
    expect((await meWith(token)).status).toBe(200);
  });

  it('does not throw away good keys when the key list comes back empty', async () => {
    const token = await sign(signer, claims({ exp: NOW_S + 10_000 }));
    expect((await meWith(token)).status).toBe(200);

    // 31 seconds later an unknown key id makes us download again, and the list is empty.
    served = [];
    nowMs = NOW_MS + 31_000;
    const stranger = await makeSigner('kid-made-up');
    expectErrorShape(await meWith(await sign(stranger, claims())), 401, 'unauthorized');
    expect(fetches).toHaveLength(2);

    // The known key still works, without another download.
    expect((await meWith(token)).status).toBe(200);
    expect(fetches).toHaveLength(2);

    // And after the hour, an empty list still does not replace it.
    nowMs = NOW_MS + 61 * 60 * 1000;
    expect((await meWith(token)).status).toBe(200);
    expect(fetches).toHaveLength(3);
  });

  it('downloads at most once per 30 seconds during a flood of made-up key ids', async () => {
    slowServer();
    expect((await meWith(await sign(signer, claims()))).status).toBe(200);
    const strangers = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => sign(await makeSigner(`made-up-${i}`), claims()))
    );

    // Within 30 seconds of the first download: no downloads at all.
    const early = await Promise.all(strangers.map((t) => meWith(t)));
    expect(early.every((r) => r.status === 401)).toBe(true);
    expect(fetches).toHaveLength(1);

    // After 30 seconds: one download for the whole flood.
    nowMs = NOW_MS + 31_000;
    const late = await Promise.all(strangers.map((t) => meWith(t)));
    expect(late.every((r) => r.status === 401)).toBe(true);
    expect(fetches).toHaveLength(2);
    for (const t of strangers) expect((await meWith(t)).status).toBe(401);
    expect(fetches).toHaveLength(2);
  });
});

describe('Bearer keys and Access together', () => {
  it('does not fall back to a valid Access cookie when a wrong Bearer key is sent', async () => {
    const token = await sign(signer, claims());
    const r = await get('/api/me', {
      key: 'wrong-key',
      env: accessOn,
      headers: { Cookie: `CF_Authorization=${token}`, 'Cf-Access-Jwt-Assertion': token },
    });
    expectErrorShape(r, 401, 'unauthorized');
  });

  it('does not fall back to Access when the Authorization header is malformed', async () => {
    const token = await sign(signer, claims());
    const r = await get('/api/me', {
      key: null,
      env: accessOn,
      headers: { Authorization: 'Basic abc', 'Cf-Access-Jwt-Assertion': token },
    });
    expectErrorShape(r, 401, 'unauthorized');
  });

  it('uses the Bearer key when both a good key and a good token are sent', async () => {
    const token = await sign(signer, claims());
    const r = await get('/api/me', { env: accessOn, headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect(r.body.data).toEqual({ kind: 'master' });
  });
});

describe('CSRF guard for signed-in users', () => {
  let token: string;
  beforeEach(async () => {
    token = await sign(signer, claims());
  });
  const asUser = (method: string, path: string, body: unknown, origin?: string) =>
    call(path, {
      method,
      body,
      key: null,
      env: accessOn,
      headers: { Cookie: `CF_Authorization=${token}`, ...(origin === undefined ? {} : { Origin: origin }) },
    });

  it('refuses a user write with no Origin header', async () => {
    expectErrorShape(await asUser('POST', '/api/tasks', minimal('tasks')), 403, 'bad_origin');
    expect(await count('SELECT COUNT(*) AS n FROM tasks')).toBe(0);
  });

  it('refuses a user write from another website', async () => {
    expectErrorShape(await asUser('POST', '/api/tasks', minimal('tasks'), 'https://evil.example'), 403, 'bad_origin');
    expectErrorShape(await asUser('POST', '/api/tasks', minimal('tasks'), 'null'), 403, 'bad_origin');
    expectErrorShape(await asUser('POST', '/api/tasks', minimal('tasks'), ORIGIN + '.evil.example'), 403, 'bad_origin');
    expectErrorShape(await asUser('POST', '/api/tasks', minimal('tasks'), 'http://becs.test'), 403, 'bad_origin');
  });

  it('refuses user PATCH and DELETE from another website', async () => {
    const t = (await post('/api/tasks', minimal('tasks'))).body.data;
    expectErrorShape(await asUser('PATCH', `/api/tasks/${t.id}`, { title: 'x' }, 'https://evil.example'), 403, 'bad_origin');
    expectErrorShape(await asUser('DELETE', `/api/tasks/${t.id}`, undefined, 'https://evil.example'), 403, 'bad_origin');
    expect((await get(`/api/tasks/${t.id}`)).body.data.title).toBe('Task 1');
  });

  it('accepts a user write from the same site', async () => {
    const r = await asUser('POST', '/api/tasks', minimal('tasks'), ORIGIN);
    expect(r.status, r.text).toBe(201);
  });

  it('lets a user read without an Origin header', async () => {
    expect((await asUser('GET', '/api/tasks', undefined)).status).toBe(200);
  });

  it('does not ask Bearer callers for an Origin header', async () => {
    expect((await post('/api/tasks', minimal('tasks'))).status).toBe(201);
    expect((await post('/api/tasks', minimal('tasks'), { headers: { Origin: 'https://evil.example' } })).status).toBe(201);
  });

  it('lets a signed-in user manage keys and read the activity log, logged as user:<email>', async () => {
    const created = await asUser('POST', '/api/admin/keys', { app: 'from-console', scopes: ['tasks:read'] }, ORIGIN);
    expect(created.status, created.text).toBe(201);
    expect((await asUser('GET', '/api/admin/keys', undefined)).body.data).toHaveLength(1);
    expect((await asUser('GET', '/api/dashboard', undefined)).status).toBe(200);

    const t = await asUser('POST', '/api/tasks', minimal('tasks'), ORIGIN);
    const log = await asUser('GET', '/api/activity', undefined);
    expect(log.status).toBe(200);
    expect(log.body.data[0]).toMatchObject({ entity_id: t.body.data.id, action: 'created', actor: `user:${EMAIL}` });

    expect((await asUser('DELETE', '/api/admin/keys/from-console', undefined, ORIGIN)).status).toBe(200);
  });
});
