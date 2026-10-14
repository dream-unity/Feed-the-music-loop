import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import base from './playwright.config.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  ...base,
  testMatch: 'offline.spec.mjs',
  reporter: [['list'], ['html', { outputFolder: resolve(repository, 'offline-report'), open: 'never' }]],
  outputDir: resolve(repository, 'test-results/offline'),
  use: {
    ...base.use,
    baseURL: 'https://127.0.0.1:4174/Feed-the-music-loop/',
    ignoreHTTPSErrors: true,
    launchOptions: {
      ...base.use.launchOptions,
      // This isolated CI browser accepts the self-signed localhost fixture.
      // The flag is never part of the production website or its deployment.
      args: [...base.use.launchOptions.args, '--ignore-certificate-errors'],
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    cwd: repository,
    url: 'https://127.0.0.1:4174/Feed-the-music-loop/',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 15_000,
    env: { ...process.env, PORT: '4174', FML_TEST_HTTPS: '1', FML_TEST_ROOT: '_site' },
  },
});
