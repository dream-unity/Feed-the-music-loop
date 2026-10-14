import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Remote CI only. No microphone substitution, permission grant or audio mock:
// the built-in generated demo enters the production storage/worklet paths.
const tracks = page => page.locator('.loop-card[data-track-id]');
const action = (page, name) => page.locator(`[data-action="${name}"]:visible`).first();
const view = (page, name) => page.locator(`[data-action="view"][data-view="${name}"]`).click();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(page, start) {
  const event = page.waitForEvent('download');
  await start();
  const file = await event;
  expect(await file.failure()).toBeNull();
  const path = await file.path();
  expect(path).not.toBeNull();
  return { filename: file.suggestedFilename(), bytes: await readFile(path) };
}

function inspectWav(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  let format, samples;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.subarray(offset, offset + 4).toString();
    const length = bytes.readUInt32LE(offset + 4);
    expect(offset + 8 + length).toBeLessThanOrEqual(bytes.length);
    if (name === 'fmt ') {
      format = {
        encoding: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10),
        sampleRate: bytes.readUInt32LE(offset + 12), blockAlign: bytes.readUInt16LE(offset + 20),
        bits: bytes.readUInt16LE(offset + 22),
      };
    }
    if (name === 'data') samples = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  expect(format).toBeDefined();
  expect(samples).toBeDefined();
  expect(format.encoding).toBe(3);
  expect(format.bits).toBe(32);
  expect(format.blockAlign).toBe(format.channels * 4);
  expect(format.sampleRate).toBeGreaterThanOrEqual(8000);
  expect(samples.length % format.blockAlign).toBe(0);
  let peak = 0, invalid = 0, energy = 0;
  for (let offset = 0; offset < samples.length; offset += 4) {
    const sample = samples.readFloatLE(offset);
    if (!Number.isFinite(sample)) invalid++;
    peak = Math.max(peak, Math.abs(sample));
    energy += sample * sample;
  }
  expect(invalid).toBe(0);
  expect(peak).toBeGreaterThan(0.005);
  expect(energy).toBeGreaterThan(0);
  return { ...format, frames: samples.length / format.blockAlign, peak, energy };
}

function inspectBackup(bytes) {
  expect(bytes.subarray(0, 8).toString()).toBe('FMLPACK\n');
  expect(bytes.readUInt32LE(8)).toBe(1);
  expect(bytes.readUInt32LE(12)).toBe(64);
  const manifestLength = Number(bytes.readBigUInt64LE(16));
  const payloadLength = Number(bytes.readBigUInt64LE(24));
  expect(64 + manifestLength + payloadLength).toBe(bytes.length);
  const manifestBytes = bytes.subarray(64, 64 + manifestLength);
  expect(hash(manifestBytes)).toBe(bytes.subarray(32, 64).toString('hex'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  expect(manifest.format).toBe('feed-the-music-loop');
  expect(manifest.assets.length).toBeGreaterThanOrEqual(3);
  const assets = new Map();
  for (const asset of manifest.assets) {
    const start = 64 + manifestLength + asset.offset;
    expect(asset.bytes).toBe(asset.frames * asset.channels * 4);
    expect(hash(bytes.subarray(start, start + asset.bytes))).toBe(asset.sha256);
    assets.set(asset.id, asset);
  }
  // Import allocates new project and audio IDs. Compare every loop's settings,
  // timing, waveform summary and original PCM content independently of IDs.
  const loops = manifest.project.tracks.map(track => {
    expect(assets.has(track.assetId)).toBe(true);
    return { ...track, assetId: assets.get(track.assetId).sha256 };
  });
  return {
    projectId: manifest.project.id,
    name: manifest.project.name,
    musicalContent: {
      loops, sections: manifest.project.sections, master: manifest.project.master,
      baseFrames: manifest.project.baseFrames, sampleRate: manifest.project.sampleRate,
    },
  };
}

async function renderMix(page) {
  await action(page, 'export-menu').click();
  await page.locator('[data-export-duration]').fill('1.25');
  const exported = await download(page, () => action(page, 'export-mix').click());
  expect(exported.filename).toMatch(/\.wav$/i);
  const audio = inspectWav(exported.bytes);
  expect(audio.channels).toBe(2);
  // The selected body plus the app's two-second effect tail must be present.
  expect(audio.frames / audio.sampleRate).toBeCloseTo(3.25, 3);
  return { ...exported, audio };
}

async function screenshot(page, testInfo, name) {
  const notifications = page.locator('.toast:not(.toast-error) [aria-label="Dismiss notification"]');
  while (await notifications.count()) await notifications.first().click();
  const path = testInfo.outputPath(`review-${testInfo.project.name}-${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test('generated loops play, mixer edits render, and exact recordings survive reload and backup restore', async ({ page, context, baseURL }, testInfo) => {
  const errors = [], consoleMessages = [], remoteRequests = [], uploadRequests = [], workerURLs = [], moduleRequests = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() }); });
  page.on('worker', worker => workerURLs.push(worker.url()));
  context.on('request', request => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return;
    if (url.origin !== new URL(baseURL).origin) remoteRequests.push(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) uploadRequests.push(`${request.method()} ${request.url()}`);
    if (url.pathname.endsWith('.mjs')) moduleRequests.add(url.pathname);
  });

  // Observe native contexts without replacing their methods, output, promises
  // or audio clocks. This distinguishes a missing CI audio sink from a module
  // or storage failure if a browser cannot finish opening the studio.
  await page.addInitScript(() => {
    const contexts = [], events = [];
    window.__fmlAudioDiagnostics = { contexts, events };
    for (const name of ['AudioContext', 'webkitAudioContext']) {
      const NativeContext = window[name];
      if (typeof NativeContext !== 'function') continue;
      window[name] = new Proxy(NativeContext, {
        construct(target, args, newTarget) {
          const context = Reflect.construct(target, args, newTarget);
          const index = contexts.push(context) - 1;
          const observe = type => events.push({ type, index, at: performance.now(), state: context.state, currentTime: context.currentTime, activeGesture: navigator.userActivation?.isActive ?? null });
          observe('created');
          context.addEventListener('statechange', () => observe('statechange'));
          return context;
        },
      });
    }
  });

  try {
    await page.goto('./');
    await expect(page.getByTestId('demo')).toBeEnabled();
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    await page.getByTestId('demo').click();
    await expect(tracks(page)).toHaveCount(3);
    await expect(page.getByTestId('demo')).toBeHidden();
    await expect(action(page, 'export-menu')).toBeEnabled();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    await expect.poll(async () => Number(await page.locator('[data-ref="output-db"]').textContent())).toBeGreaterThan(-60);
    // The two-second demo must pass its first wrap on the actual audio clock.
    await expect.poll(async () => {
      const [minutes, seconds] = (await page.locator('[data-ref="transport-time"]').textContent()).split(':').map(Number);
      return minutes * 60 + seconds;
    }).toBeGreaterThan(2.1);
    await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
    await screenshot(page, testInfo, 'build');

    await view(page, 'mix');
    const original = await download(page, () => action(page, 'export-track').click());
    expect(inspectWav(original.bytes).channels).toBe(1);
    const baseline = await renderMix(page);

    const warmth = page.getByRole('slider', { name: 'Warmth · low EQ', exact: true });
    const pan = page.getByRole('slider', { name: 'Pan', exact: true });
    await warmth.focus();
    await warmth.press('End');
    await expect(warmth).toHaveValue('18');
    await pan.focus();
    await pan.press('End');
    await expect(pan).toHaveValue('1');
    const edited = await renderMix(page);
    expect(edited.audio.frames).toBe(baseline.audio.frames);
    expect(hash(edited.bytes)).not.toBe(hash(baseline.bytes));
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    await screenshot(page, testInfo, 'mix');

    await page.getByTestId('stop').click();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'false');
    const backup = await download(page, () => action(page, 'export-project').click());
    expect(backup.filename).toMatch(/\.fml$/i);
    const saved = inspectBackup(backup.bytes);

    await page.reload();
    await expect(action(page, 'export-menu')).toBeEnabled();
    await expect(tracks(page)).toHaveCount(3);
    await view(page, 'mix');
    await expect(warmth).toHaveValue('18');
    await expect(pan).toHaveValue('1');
    const reopened = inspectBackup((await download(page, () => action(page, 'export-project').click())).bytes);
    expect(reopened.projectId).toBe(saved.projectId);
    expect(reopened.musicalContent).toEqual(saved.musicalContent);

    await page.locator('[data-ref="project-file"]').setInputFiles({ name: backup.filename, mimeType: 'application/octet-stream', buffer: backup.bytes });
    await expect(page.locator('[data-ref="project-name"]')).toHaveText(`${saved.name} (imported)`);
    await expect(action(page, 'export-menu')).toBeEnabled();
    await view(page, 'mix');
    await expect(warmth).toHaveValue('18');
    await expect(pan).toHaveValue('1');
    const restoredOriginal = await download(page, () => action(page, 'export-track').click());
    expect(restoredOriginal.bytes).toEqual(original.bytes);
    const restored = inspectBackup((await download(page, () => action(page, 'export-project').click())).bytes);
    expect(restored.projectId).not.toBe(saved.projectId);
    expect(restored.musicalContent).toEqual(saved.musicalContent);

    // A restored loop must be usable by the audio engine, not just listed in UI.
    await page.getByTestId('play').click();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    await expect.poll(async () => {
      const [minutes, seconds] = (await page.locator('[data-ref="transport-time"]').textContent()).split(':').map(Number);
      return minutes * 60 + seconds;
    }).toBeGreaterThan(0.3);
    await expect.poll(async () => Number(await page.locator('[data-ref="output-db"]').textContent())).toBeGreaterThan(-60);
    await page.getByTestId('stop').click();
    await screenshot(page, testInfo, 'restored');
    expect(workerURLs.some(url => url.endsWith('/src/export/render-worker.mjs'))).toBe(true);
    expect(errors).toEqual([]);
    await expect(page.locator('.toast-error')).toHaveCount(0);
    expect(remoteRequests).toEqual([]);
    expect(uploadRequests).toEqual([]);
    await testInfo.attach('audio-and-backup-results', {
      body: JSON.stringify({ baseline: baseline.audio, edited: edited.audio, loops: restored.musicalContent.loops.length, backupBytes: backup.bytes.length }, null, 2),
      contentType: 'application/json',
    });
  } finally {
    const audioDiagnostics = await page.evaluate(() => ({
      contexts: (window.__fmlAudioDiagnostics?.contexts || []).map(context => ({
        state: context.state, currentTime: context.currentTime, sampleRate: context.sampleRate,
        baseLatency: context.baseLatency ?? null, outputLatency: context.outputLatency ?? null,
        audioWorklet: Boolean(context.audioWorklet),
      })),
      events: window.__fmlAudioDiagnostics?.events || [],
    })).catch(error => ({ unavailable: error.message }));
    await testInfo.attach('runtime-observations', {
      body: JSON.stringify({ errors, consoleMessages, audioDiagnostics, remoteRequests, uploadRequests, workerURLs, moduleRequests: [...moduleRequests] }, null, 2),
      contentType: 'application/json',
    });
  }
});
