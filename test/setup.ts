// Runs before every test in every file: wipe the database, KV and rate-limit
// counters, then rebuild the schema from migrations/. So every test starts from
// the same known state: the seven seeded ventures and nothing else.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';
import { clearJwksCache } from '../src/access';

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  clearJwksCache();
});
