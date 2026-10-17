import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));
const audioDirectory = resolve(tmpdir(), 'feed-the-music-loop-ci');
const audioPath = resolve(audioDirectory, 'microphone.wav');
mkdirSync(audioDirectory, { recursive: true });

// A deterministic fake microphone exercises Chromium's real getUserMedia,
// AudioWorklet and storage paths; it does not substitute an app audio mock.
const sampleRate = 48000;
const frames = sampleRate * 2;
const wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(frames * 2, 40);
for (let index = 0; index < frames; index++) {
  const time = index / sampleRate;
  const envelope = 0.35 + 0.2 * Math.cos(2 * Math.PI * 2 * time);
  const sample = envelope * (0.6 * Math.sin(2 * Math.PI * 196 * time) + 0.2 * Math.sin(2 * Math.PI * 392 * time));
  wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 2);
}
writeFileSync(audioPath, wav);

export default defineConfig({
  testDir: '.',
  testMatch: ['browser.spec.mjs', 'studio-lifecycle.spec.mjs', 'storage-fallback.spec.mjs', 'loop-recording.spec.mjs', 'storage-manager.spec.mjs', 'track-editor.spec.mjs', 'recording-master.spec.mjs'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: resolve(repository, 'playwright-report'), open: 'never' }]],
  outputDir: resolve(repository, 'test-results/browser'),
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4173/Feed-the-music-loop/',
    permissions: ['microphone'],
    acceptDownloads: true,
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${audioPath}`,
      ],
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    cwd: repository,
    url: 'http://127.0.0.1:4173/Feed-the-music-loop/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
