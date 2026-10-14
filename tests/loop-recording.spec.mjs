import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const tracks = page => page.locator('.loop-card[data-track-id]');
const action = (page, name) => page.locator(`[data-action="${name}"]:visible`).first();
const captureState = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-capture-state', value);
const playing = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-playing', String(value));

async function download(page, click) {
  const event = page.waitForEvent('download');
  await click();
  const result = await event;
  expect(await result.failure()).toBeNull();
  return { filename: result.suggestedFilename(), bytes: await readFile(await result.path()) };
}

function toneWav(frequency) {
  const rate = 48000, frames = rate;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(.12 * Math.sin(2 * Math.PI * frequency * i / rate) * 32767), 44 + i * 2);
  return wav;
}

function decodeWav(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.subarray(offset, offset + 4).toString(), size = bytes.readUInt32LE(offset + 4);
    expect(offset + 8 + size).toBeLessThanOrEqual(bytes.length);
    if (name === 'fmt ') format = { encoding: bytes.readUInt16LE(offset + 8), channels: bytes.readUInt16LE(offset + 10), rate: bytes.readUInt32LE(offset + 12), bits: bytes.readUInt16LE(offset + 22) };
    if (name === 'data') data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  expect(format).toBeDefined(); expect(data).toBeDefined();
  expect(format.channels).toBe(2);
  expect([1, 3]).toContain(format.encoding);
  const sampleBytes = format.bits / 8, frames = data.length / sampleBytes / format.channels;
  const mono = new Float64Array(frames);
  let peak = 0, invalidSamples = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < format.channels; channel++) {
      const offset = (frame * format.channels + channel) * sampleBytes;
      const sample = format.encoding === 3 ? data.readFloatLE(offset) : data.readInt16LE(offset) / 32768;
      if (!Number.isFinite(sample)) invalidSamples++;
      mono[frame] += sample / format.channels; peak = Math.max(peak, Math.abs(sample));
    }
  }
  expect(invalidSamples).toBe(0);
  return { ...format, frames, mono, peak };
}

function amplitude(audio, frequency) {
  // A half-second window has an integer number of beat periods between these
  // test tones, excluding start-up ramps while separating their contributions.
  const start = Math.round(.2 * audio.rate), end = start + Math.round(.5 * audio.rate);
  expect(audio.frames).toBeGreaterThan(end);
  let real = 0, imaginary = 0;
  for (let frame = start; frame < end; frame++) {
    const angle = 2 * Math.PI * frequency * frame / audio.rate;
    real += audio.mono[frame] * Math.cos(angle); imaginary += audio.mono[frame] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / (end - start);
}

async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`review-${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.use({ permissions: [] });
test.beforeEach(async ({ page }, testInfo) => {
  testInfo.runtimeErrors = [];
  page.on('pageerror', error => testInfo.runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    window.__loopRecordingMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.__loopRecordingMicRequests++;
      throw new DOMException('Microphone is unavailable for this loop-only session.', 'NotAllowedError');
    };
  });
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => window.__loopRecordingMicRequests)).toBe(0);
});

test('loop-only recording includes every unmuted loop despite Solo, excludes muted audio, and survives backup without a microphone', async ({ page }, testInfo) => {
  await page.goto('./');
  const record = page.getByRole('button', { name: 'Record all the loops', exact: true });
  await expect(record).toBeVisible();
  await expect(record).toBeDisabled();
  for (const [index, frequency] of [317, 733, 1217].entries()) {
    await page.locator('[data-ref="audio-file"]').setInputFiles({ name: `Tone ${frequency}.wav`, mimeType: 'audio/wav', buffer: toneWav(frequency) });
    await expect(tracks(page)).toHaveCount(index + 1);
    await expect(record).toBeEnabled();
  }
  await tracks(page).first().locator('[data-action="solo"]').click();
  await tracks(page).nth(1).locator('[data-action="mute"]').click();
  await expect(tracks(page).first().locator('[data-action="solo"]')).toHaveAttribute('aria-pressed', 'true');
  await record.click();
  await captureState(page, 'recording');
  await expect(page.getByTestId('add-loop')).toBeDisabled();
  await expect(page.getByTestId('sing')).toBeDisabled();
  // Real worklet capture needs elapsed audio time, not a simulated app clock.
  await page.waitForTimeout(1000);
  await page.getByTestId('finish').click();
  await captureState(page, 'idle');
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await playing(page, true);
  const recent = page.locator('[data-ref="recent-recording"]');
  await expect(recent).toContainText('Loop recording 1');
  await expect(recent).toContainText('Loops only');
  await expect(page.locator('[data-view-panel="build"]')).toBeVisible();
  expect(await page.locator('[data-ref="capture-panel"]').evaluate(element => element.nextElementSibling.dataset.ref)).toBe('recent-recording');
  const wav = await download(page, () => recent.getByRole('button', { name: 'Download Loop recording 1', exact: true }).click());
  const audio = decodeWav(wav.bytes);
  expect(audio.peak).toBeGreaterThan(.01);
  const amplitudes = [317, 733, 1217].map(frequency => amplitude(audio, frequency));
  expect(amplitudes[0]).toBeGreaterThan(.01);
  expect(amplitudes[2]).toBeGreaterThan(.01);
  expect(amplitudes[1]).toBeLessThan(Math.min(amplitudes[0], amplitudes[2]) * .03);
  await testInfo.attach('recorded-loop-frequency-amplitudes', { body: JSON.stringify({ frequencies: [317, 733, 1217], amplitudes }), contentType: 'application/json' });

  await recent.getByRole('button', { name: 'Listen to Loop recording 1', exact: true }).click();
  await expect(page.locator('#performance-player')).toBeVisible();
  await expect.poll(() => page.locator('#performance-player').evaluate(player => player.currentTime)).toBeGreaterThan(.2);
  await expect(page.locator('[data-view-panel="build"]')).toBeVisible();
  await playing(page, false);
  await screenshot(page, testInfo, 'loop-only-finished-desktop');
  await page.getByTestId('stop').click();
  expect(await page.evaluate(() => window.__loopRecordingMicRequests)).toBe(0);
  await page.reload();
  await expect(recent).toContainText('Loop recording 1');
  const reopened = await download(page, () => recent.getByRole('button', { name: 'Download Loop recording 1', exact: true }).click());
  expect(reopened.bytes).toEqual(wav.bytes);
  const backup = await download(page, () => action(page, 'export-project').click());
  const manifestSize = Number(backup.bytes.readBigUInt64LE(16));
  const manifest = JSON.parse(backup.bytes.subarray(64, 64 + manifestSize).toString());
  expect(manifest.project.takes).toHaveLength(0);
  expect(manifest.project.performances).toHaveLength(1);
  const saved = manifest.project.performances[0];
  expect(saved.source).toBe('loops');
  expect(saved.leadAssetId || null).toBeNull();
  expect(manifest.assets.filter(asset => asset.kind === 'master')).toHaveLength(1);
  await page.locator('[data-ref="project-file"]').setInputFiles({ name: backup.filename, mimeType: 'application/octet-stream', buffer: backup.bytes });
  await expect(page.getByText('Backup restored as a separate project.', { exact: true })).toBeVisible();
  await expect(record).toBeEnabled();
  await expect(tracks(page)).toHaveCount(3);
  await expect(recent).toContainText('Loop recording 1');
  const restored = await download(page, () => recent.getByRole('button', { name: 'Download Loop recording 1', exact: true }).click());
  expect(restored.bytes).toEqual(wav.bytes);
  await page.locator('[data-action="view"][data-view="song"]').click();
  await expect(page.locator('.performance-card')).toHaveCount(1);
  await expect(page.locator('.take-card')).toHaveCount(0);
});

test('live loop capture follows mute changes, allows Cancel and Stop, and keeps the phone action reachable', async ({ page }, testInfo) => {
  await page.goto('./');
  await page.getByTestId('demo').click();
  await expect(tracks(page)).toHaveCount(3);
  const record = page.getByTestId('record-all-loops');
  await expect(record).toBeEnabled();
  for (const width of [680, 768]) {
    await page.setViewportSize({ width, height: 800 });
    for (const name of ['play', 'stop', 'add-loop', 'sing', 'record-all-loops']) {
      const control = await page.getByTestId(name).boundingBox();
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.x + control.width).toBeLessThanOrEqual(width);
      expect(control.y + control.height).toBeLessThanOrEqual(800);
    }
  }
  await page.setViewportSize({ width: 360, height: 800 });
  const bounds = await record.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(800);
  await screenshot(page, testInfo, 'loop-only-action-phone');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await record.click();
  await captureState(page, 'recording');
  const level = page.locator('[data-ref="capture-level"]');
  const measuredDb = async () => {
    const value = (await level.textContent()).replaceAll('−', '-').replace(' dB', '').trim();
    return value.includes('∞') ? -Infinity : Number(value);
  };
  await expect.poll(measuredDb).toBeGreaterThan(-50);
  const waveform = page.locator('[data-ref="capture-waveform"] .live-input-peak');
  const initialPath = await waveform.getAttribute('d');
  await expect(waveform).not.toHaveAttribute('d', initialPath);
  for (let i = 0; i < 3; i++) await tracks(page).nth(i).locator('[data-action="mute"]').click();
  // Give existing reverb/delay tails time to decay; the capture meter samples
  // the recorded backing mix, even though no microphone is connected.
  await expect.poll(measuredDb, { timeout: 10000 }).toBeLessThan(-65);
  await tracks(page).nth(1).locator('[data-action="mute"]').click();
  await expect.poll(measuredDb).toBeGreaterThan(-50);
  await page.getByTestId('cancel').click();
  await captureState(page, 'idle');
  await expect(page.locator('[data-ref="capture-panel"]')).toBeVisible();
  await expect(page.locator('[data-ref="recent-recording"]')).toBeHidden();
  await record.click();
  await captureState(page, 'recording');
  await page.waitForTimeout(600);
  await page.getByTestId('stop').click();
  await captureState(page, 'idle');
  await playing(page, false);
  await expect(page.locator('[data-ref="recent-recording"]')).toContainText('Loop recording 1');
  await page.locator('[data-action="view"][data-view="song"]').click();
  await expect(page.locator('.performance-card')).toHaveCount(1);
  await expect(page.locator('.take-card')).toHaveCount(0);
});
