import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import base from './playwright.config.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
if (!process.env.FML_TEST_CERT_PATH) throw new Error('The HTTPS browser fixture requires FML_TEST_CERT_PATH.');
const certificate = new X509Certificate(readFileSync(process.env.FML_TEST_CERT_PATH));
const certificateSPKI = createHash('sha256').update(certificate.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

export default defineConfig({
  ...base,
  testMatch: ['offline.spec.mjs', 'service-worker-update.spec.mjs'],
  reporter: [['list'], ['html', { outputFolder: resolve(repository, 'offline-report'), open: 'never' }]],
  outputDir: resolve(repository, 'test-results/offline'),
  use: {
    ...base.use,
    baseURL: 'https://127.0.0.1:4174/Feed-the-music-loop/',
    ignoreHTTPSErrors: false,
    launchOptions: {
      ...base.use.launchOptions,
      // Accept only this isolated CI certificate. Broad certificate-error
      // suppression disables Chromium HTTP caching and would invalidate the
      // warm-cache service-worker upgrade regression. Production uses neither.
      args: [...base.use.launchOptions.args, `--ignore-certificate-errors-spki-list=${certificateSPKI}`],
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    cwd: repository,
    url: 'https://127.0.0.1:4174/Feed-the-music-loop/',
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 15_000,
    env: { ...process.env, PORT: '4174', FML_TEST_HTTPS: '1', FML_TEST_ROOT: '_site', FML_TEST_CACHE_ASSETS: '1' },
  },
});
