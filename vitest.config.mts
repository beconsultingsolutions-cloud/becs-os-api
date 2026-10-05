// Test setup: every test runs inside the real Workers runtime (workerd) through
// @cloudflare/vitest-plugin, with a real local D1 database, KV namespace and
// rate-limit binding built from wrangler.jsonc. Nothing here touches the live
// Cloudflare account.
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  // The SQL files in migrations/, in number order. Applied before every test (test/setup.ts).
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // A made-up master key, only ever used by the tests.
            API_KEY: 'test-master-key-0123456789',
            // Access stays off unless a test switches it on.
            ACCESS_TEAM_DOMAIN: '',
            ACCESS_AUD: '',
            ACCESS_ALLOWED_EMAILS: '',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
