// Bindings available to the tests (see wrangler.jsonc and vitest.config.mts).
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CONFIG: KVNamespace;
    APP_LIMITER: RateLimit;
    API_KEY: string;
    ACCESS_TEAM_DOMAIN: string;
    ACCESS_AUD: string;
    ACCESS_ALLOWED_EMAILS: string;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
