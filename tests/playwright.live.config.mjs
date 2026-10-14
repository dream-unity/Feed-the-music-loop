import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import base from './playwright.config.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const url = new URL(process.env.FML_LIVE_URL || 'https://dream-unity.github.io/Feed-the-music-loop/');
if (url.origin !== 'https://dream-unity.github.io' || url.pathname !== '/Feed-the-music-loop/' || url.search || url.hash || url.username || url.password) {
  throw new Error('The live smoke is restricted to the owned Feed-the-music-loop GitHub Pages URL.');
}
if (!/^[a-f0-9]{64}$/.test(process.env.FML_EXPECTED_SW_SHA256 || '')) {
  throw new Error('Set FML_EXPECTED_SW_SHA256 to the SHA-256 of sw.js from the exact deployed package.');
}

// Run only in remote CI after deployment. Chromium's deterministic microphone
// fixture still traverses real getUserMedia, AudioWorklet and storage APIs.
export default defineConfig({
  ...base,
  testMatch: 'live.spec.mjs',
  timeout: 150_000,
  retries: process.env.CI ? 1 : 0,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { outputFolder: resolve(repository, 'live-report'), open: 'never' }]],
  outputDir: resolve(repository, 'test-results/live'),
  use: { ...base.use, baseURL: url.href },
  webServer: undefined,
});
