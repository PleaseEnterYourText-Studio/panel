import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityDate: '2026-08-22',
        bindings: {
          ACCESS_TEAM_DOMAIN: 'https://test.cloudflareaccess.com',
          ACCESS_AUD: 'test-aud',
          ENCRYPTION_KEY: 'test-key-0123456789abcdef0123456789',
        },
      },
    }),
  ],
});
