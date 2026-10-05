// Live check: proves the deployed server works end to end, then cleans up after itself.
//
// Run from the project folder:   node scripts/live-check.mjs
//
// What it does:
//   1. Makes a temporary app key in memory. Only its hash goes to Cloudflare KV, with a
//      10-minute expiry, so it dies on its own even if this script crashes. The key is
//      never printed and never written to disk.
//   2. Walks the live API through the acceptance test: add a client, a project and a task,
//      mark the task done, and watch the dashboard numbers change.
//   3. Checks the guard rails: bad input is refused, deletes that would orphan rows are
//      blocked, and an app key cannot reach the admin endpoints.
//   4. Deletes everything it created and revokes the temporary key.
//
// Everything it creates is named "[live-check] ..." so a leftover is easy to spot.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fixed on purpose: the temporary key must never be sent to any other address.
const BASE = 'https://becs-os-api.be-consulting-solutions.workers.dev';
const KV_NAMESPACE = '2d7e6ec8dcdf42168a74609d1d8e0edf'; // becs-os-config, same id as wrangler.jsonc
const TAG = '[live-check]';

const key = randomBytes(32).toString('hex');
const kvName = 'key:' + createHash('sha256').update(key).digest('hex');

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function api(method, path, body, auth = true) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(auth ? { Authorization: 'Bearer ' + key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, json };
}

let passed = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log('  ok    ' + name); }
  else { failures.push(name); console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
const brief = (r) => r.status + ' ' + JSON.stringify(r.json).slice(0, 200);

const created = { task: null, project: null, client: null };

async function main() {
  console.log('Checking ' + BASE);

  // --- no key needed ---
  const health = await api('GET', '/api/health', null, false);
  check('health answers without a key', health.status === 200 && health.json?.ok === true, brief(health));
  const anon = await api('GET', '/api/tasks', null, false);
  check('data is refused without a key (401)', anon.status === 401, brief(anon));
  // Once Cloudflare Access is on, the console page answers with a redirect to the sign-in page instead.
  const home = await fetch(BASE + '/', { redirect: 'manual' });
  const html = home.status === 200 ? await home.text() : '';
  const behindAccess = home.status >= 300 && home.status < 400 && (home.headers.get('location') || '').includes('cloudflareaccess.com');
  check(behindAccess ? 'console page is behind the Access sign-in' : 'console page is served',
    behindAccess || (home.status === 200 && html.includes('BECS OS')), String(home.status));

  // --- temporary key ---
  const dir = mkdtempSync(join(tmpdir(), 'becs-check-'));
  const file = join(dir, 'record.json');
  const scopes = ['ventures:read', 'clients:read', 'clients:write', 'projects:read', 'projects:write', 'tasks:read', 'tasks:write', 'activity:read'];
  writeFileSync(file, JSON.stringify({ app: 'live-check', scopes, created_at: new Date().toISOString() }));
  try {
    wrangler(['kv', 'key', 'put', `"${kvName}"`, '--path', `"${file}"`, '--namespace-id', KV_NAMESPACE, '--remote', '--ttl', '600']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // KV can take a little while to show a new key everywhere.
  let me = null;
  for (let i = 0; i < 30; i++) {
    me = await api('GET', '/api/me');
    if (me.status === 200) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  check('temporary key is accepted', me.status === 200 && me.json?.data?.kind === 'app', brief(me));
  if (me.status !== 200) return;

  // --- starting point ---
  const ventures = await api('GET', '/api/ventures');
  const becs = ventures.json?.data?.find((v) => v.slug === 'becs');
  check('ventures list includes becs', ventures.status === 200 && !!becs, brief(ventures));
  if (!becs) return;
  const before = await api('GET', '/api/dashboard');
  check('dashboard loads', before.status === 200 && typeof before.json?.data?.open_tasks === 'number', brief(before));
  const clientsBefore = (await api('GET', '/api/clients?limit=500')).json?.data?.length;

  // --- the acceptance test: client -> project -> task -> done ---
  const client = await api('POST', '/api/clients', { venture_id: becs.id, name: TAG + ' Test Client', stage: 'lead' });
  check('create a client (201)', client.status === 201 && client.json?.data?.id > 0, brief(client));
  created.client = client.json?.data?.id ?? null;

  const project = await api('POST', '/api/projects', {
    venture_id: becs.id, client_id: created.client, name: TAG + ' Test Project', status: 'active', phase: 'plan', value_cents: 123400,
  });
  check('create a project with a phase (201)', project.status === 201 && project.json?.data?.phase === 'plan', brief(project));
  created.project = project.json?.data?.id ?? null;

  const task = await api('POST', '/api/tasks', {
    venture_id: becs.id, project_id: created.project, title: TAG + ' Test Task', priority: 1, filter_tag: 'systems',
  });
  check('create a task (201)', task.status === 201 && task.json?.data?.status === 'todo', brief(task));
  created.task = task.json?.data?.id ?? null;

  const mid = await api('GET', '/api/dashboard');
  check('dashboard: open tasks went up by 1', mid.json?.data?.open_tasks === before.json.data.open_tasks + 1, `${before.json.data.open_tasks} -> ${mid.json?.data?.open_tasks}`);
  check('dashboard: active projects went up by 1', mid.json?.data?.active_projects === before.json.data.active_projects + 1);
  check('dashboard: project value went up by $1,234', mid.json?.data?.active_project_value_cents === before.json.data.active_project_value_cents + 123400);

  const done = await api('PATCH', '/api/tasks/' + created.task, { status: 'done' });
  check('mark the task done (completion time stamped)', done.status === 200 && done.json?.data?.status === 'done' && !!done.json?.data?.completed_at, brief(done));
  const after = await api('GET', '/api/dashboard');
  check('dashboard: open tasks went back down', after.json?.data?.open_tasks === before.json.data.open_tasks, `${after.json?.data?.open_tasks}`);

  const reopened = await api('PATCH', '/api/tasks/' + created.task, { status: 'todo' });
  check('reopen the task (completion time cleared)', reopened.status === 200 && reopened.json?.data?.completed_at === null, brief(reopened));

  // --- guard rails ---
  const bad = await api('POST', '/api/tasks', { venture_id: becs.id, title: TAG + ' bad', status: 'bogus', priority: 9 });
  check('bad values are refused with field errors (400)', bad.status === 400 && bad.json?.error === 'invalid' && !!bad.json?.fields?.status, brief(bad));
  if (bad.status === 201) await api('DELETE', '/api/tasks/' + bad.json.data.id);
  const blocked = await api('DELETE', '/api/clients/' + created.client);
  check('deleting a client that still has a project is blocked (409)', blocked.status === 409, brief(blocked));
  const admin = await api('GET', '/api/admin/keys');
  check('an app key cannot reach admin (403)', admin.status === 403, brief(admin));
  const missing = await api('GET', '/api/tasks/999999999');
  check('a missing record is 404', missing.status === 404, brief(missing));
  const log = await api('GET', '/api/activity?limit=5');
  check('activity log records who did it', log.status === 200 && log.json?.data?.[0]?.actor === 'app:live-check', brief(log));
  const oldPath = await api('GET', '/tasks');
  check('old paths without /api are gone (404)', oldPath.status === 404, String(oldPath.status));

  return clientsBefore;
}

async function cleanup(clientsBefore) {
  console.log('Cleaning up');
  for (const [table, id] of [['tasks', created.task], ['projects', created.project], ['clients', created.client]]) {
    if (id == null) continue;
    const r = await api('DELETE', `/api/${table}/${id}`);
    check(`delete the test ${table.slice(0, -1)}`, r.status === 200, brief(r));
  }
  if (clientsBefore != null) {
    const now = (await api('GET', '/api/clients?limit=500')).json?.data?.length;
    check('client count is back where it started', now === clientsBefore, `${clientsBefore} -> ${now}`);
  }
  try {
    wrangler(['kv', 'key', 'delete', `"${kvName}"`, '--namespace-id', KV_NAMESPACE, '--remote']);
    check('temporary key revoked', true);
  } catch {
    check('temporary key revoked', false, 'delete failed; it still expires within 10 minutes');
  }
}

let clientsBefore;
try {
  clientsBefore = await main();
} catch (err) {
  check('script ran without crashing', false, err.message);
} finally {
  await cleanup(clientsBefore);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('Failed: ' + failures.join('; ')); process.exit(1); }
