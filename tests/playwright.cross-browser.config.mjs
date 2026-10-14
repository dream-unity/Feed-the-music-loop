import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

// Keep this independent of the Chromium microphone fixture. These projects
// exercise generated audio, real AudioWorklet playback and browser storage;
// they do not request a microphone or represent physical-device verification.
export default defineConfig({
  testDir: '.',
  testMatch: 'cross-browser.spec.mjs',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: resolve(repository, 'cross-browser-report'), open: 'never' }]],
  outputDir: resolve(repository, 'test-results/cross-browser'),
  use: {
    baseURL: 'http://127.0.0.1:4175/Feed-the-music-loop/',
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    cwd: repository,
    url: 'http://127.0.0.1:4175/Feed-the-music-loop/',
    reuseExistingServer: false,
    timeout: 15_000,
    env: { ...process.env, PORT: '4175', FML_TEST_HTTPS: '0', FML_TEST_ROOT: '.' },
  },
});
