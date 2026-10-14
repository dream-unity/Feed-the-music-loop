import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// These tests run in GitHub Actions. They use a real Chromium audio graph with
// a deterministic fake microphone; physical devices and acoustic latency still
// require hands-on verification.
const tracks = page => page.locator('.loop-card[data-track-id]');
const takes = page => page.locator('.take-card[data-take-id]');
const action = (page, name) => page.locator(`[data-action="${name}"]:visible`).first();
const view = (page, name) => page.locator(`[data-action="view"][data-view="${name}"]`).click();
const state = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-capture-state', value);
const playing = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-playing', String(value));

async function boot(page) {
  await page.goto('./');
  await expect(page.getByTestId('add-loop')).toBeVisible();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  expect(await page.evaluate(() => isSecureContext)).toBe(true);
}

async function download(page, click) {
  const event = page.waitForEvent('download');
  await click();
  const result = await event;
  expect(await result.failure()).toBeNull();
  return { filename: result.suggestedFilename(), bytes: await readFile(await result.path()) };
}

async function reviewScreenshot(page, testInfo, name) {
  const notifications = page.locator('.toast:not(.toast-error) [aria-label="Dismiss notification"]');
  while (await notifications.count()) await notifications.first().click();
  const path = testInfo.outputPath(`review-${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

function inspectWav(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  let format, data;
  for (let position = 12; position + 8 <= bytes.length;) {
    const name = bytes.subarray(position, position + 4).toString();
    const length = bytes.readUInt32LE(position + 4);
    expect(position + 8 + length).toBeLessThanOrEqual(bytes.length);
    if (name === 'fmt ') {
      format = {
        encoding: bytes.readUInt16LE(position + 8), channels: bytes.readUInt16LE(position + 10),
        sampleRate: bytes.readUInt32LE(position + 12), blockAlign: bytes.readUInt16LE(position + 20),
        bits: bytes.readUInt16LE(position + 22),
      };
    }
    if (name === 'data') data = bytes.subarray(position + 8, position + 8 + length);
    position += 8 + length + (length % 2);
  }
  expect(format).toBeDefined();
  expect(data).toBeDefined();
  expect([1, 3]).toContain(format.encoding);
  expect(data.length % format.blockAlign).toBe(0);
  let peak = 0, invalidSamples = 0;
  for (let position = 0; position < data.length; position += format.bits / 8) {
    const sample = format.encoding === 3 ? data.readFloatLE(position) : data.readInt16LE(position) / 32768;
    if (!Number.isFinite(sample)) invalidSamples++;
    peak = Math.max(peak, Math.abs(sample));
  }
  expect(invalidSamples).toBe(0);
  return { ...format, frames: data.length / format.blockAlign, peak };
}

async function recordFirstLoop(page) {
  await page.getByTestId('add-loop').click();
  await state(page, 'recording');
  // A recording needs elapsed audio time. Other waits use observable state.
  await page.waitForTimeout(1300);
  await page.getByTestId('finish').click();
  await expect(tracks(page)).toHaveCount(1);
  await state(page, 'idle');
  await playing(page, true);
}

test.beforeEach(async ({ page }, testInfo) => {
  const errors = [];
  const remoteRequests = [];
  const uploadRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.context().on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.origin !== 'http://127.0.0.1:4173') remoteRequests.push(request.url());
    if (['http:', 'https:'].includes(url.protocol) && !['GET', 'HEAD'].includes(request.method())) uploadRequests.push(`${request.method()} ${request.url()}`);
  });
  testInfo.appErrors = errors;
  testInfo.remoteRequests = remoteRequests;
  testInfo.uploadRequests = uploadRequests;
  await page.addInitScript(() => {
    window.__testMicStreams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      window.__testMicStreams.push(stream);
      return stream;
    };
  });
});

test.afterEach(async ({ page }, testInfo) => {
  await testInfo.attach('runtime-observations', {
    body: JSON.stringify({ errors: testInfo.appErrors, remoteRequests: testInfo.remoteRequests, uploadRequests: testInfo.uploadRequests }, null, 2),
    contentType: 'application/json',
  });
  expect(testInfo.appErrors).toEqual([]);
  expect(testInfo.remoteRequests).toEqual([]);
  expect(testInfo.uploadRequests).toEqual([]);
  if (!page.isClosed() && testInfo.status === testInfo.expectedStatus) {
    await testInfo.attach('studio', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  }
});

test('record loops, a continuous vocal, another take, and recover after reload', async ({ page }, testInfo) => {
  await boot(page);
  await reviewScreenshot(page, testInfo, 'desktop-welcome');
  await recordFirstLoop(page);

  // The default second layer is one synchronized cycle and ends automatically.
  await page.getByTestId('add-loop').click();
  await expect(tracks(page)).toHaveCount(2);
  await state(page, 'idle');
  await playing(page, true);
  await reviewScreenshot(page, testInfo, 'desktop-build');

  await page.getByTestId('sing').click();
  await state(page, 'recording');
  await page.waitForTimeout(1600);
  await page.getByTestId('finish').click();
  await state(page, 'idle');
  await playing(page, true);
  await view(page, 'song');
  await expect(takes(page)).toHaveCount(1);
  await expect(page.locator('.performance-card')).toHaveCount(1);

  const master = await download(page, () => action(page, 'export-master').click());
  expect(master.filename).toMatch(/\.wav$/i);
  const masterAudio = inspectWav(master.bytes);
  expect(masterAudio.channels).toBe(2);
  expect(masterAudio.frames / masterAudio.sampleRate).toBeGreaterThan(1);
  expect(masterAudio.peak).toBeGreaterThan(0.005);

  await page.getByTestId('sing').click();
  await state(page, 'recording');
  await page.waitForTimeout(1100);
  await page.getByTestId('finish').click();
  await state(page, 'idle');
  await expect(takes(page)).toHaveCount(2);
  await expect(page.locator('.performance-card')).toHaveCount(2);
  await playing(page, true);
  await reviewScreenshot(page, testInfo, 'desktop-song');

  await page.getByTestId('stop').click();
  await playing(page, false);
  await action(page, 'toggle-mic').click();
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
  expect(await page.evaluate(() => window.__testMicStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);

  // Editing a saved vocal and rendering a new song exercises the actual
  // rendering worker and its independent storage reader, beyond live capture.
  await takes(page).first().locator('[data-action="select-track"]').click();
  const vocalPan = page.getByRole('slider', { name: 'Pan', exact: true });
  await vocalPan.focus();
  await vocalPan.press('End');
  await expect(vocalPan).toHaveValue('1');
  await action(page, 'export-menu').click();
  await page.locator('[data-export-duration]').fill('2');
  const edited = await download(page, () => action(page, 'export-mix').click());
  const editedAudio = inspectWav(edited.bytes);
  expect(editedAudio.channels).toBe(2);
  expect(editedAudio.frames / editedAudio.sampleRate).toBeGreaterThanOrEqual(2);
  expect(editedAudio.peak).toBeGreaterThan(0.005);

  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await view(page, 'build');
  await expect(tracks(page)).toHaveCount(2);
  await view(page, 'song');
  await expect(takes(page)).toHaveCount(2);
  await expect(page.locator('.performance-card')).toHaveCount(2);
  const reopenedMaster = await download(page, () => action(page, 'export-master').click());
  expect(inspectWav(reopenedMaster.bytes).peak).toBeGreaterThan(0.005);
});

test('demo, mix controls, sections, portable backup and invalid-import preservation', async ({ page }, testInfo) => {
  await boot(page);
  await page.getByTestId('demo').click();
  await expect.poll(() => tracks(page).count()).toBeGreaterThan(1);
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  const count = await tracks(page).count();
  const sectionCount = await page.locator('.section-pad').count();

  await action(page, 'save-section').click();
  await page.getByRole('textbox', { name: 'Section name' }).fill('Quiet opening');
  await page.getByRole('button', { name: 'Save section', exact: true }).last().click();
  await expect(page.locator('.section-pad')).toHaveCount(sectionCount + 1);

  await tracks(page).first().locator('[data-action="mute"]').click();
  await expect(tracks(page).first().locator('[data-action="mute"]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.section-pad').filter({ hasText: 'Quiet opening' }).click();
  await expect(tracks(page).first().locator('[data-action="mute"]')).toHaveAttribute('aria-pressed', 'false');

  await view(page, 'mix');
  const warmth = page.getByRole('slider', { name: 'Warmth · low EQ', exact: true });
  await warmth.focus();
  await warmth.press('End');
  await expect(warmth).toHaveValue('18');
  await reviewScreenshot(page, testInfo, 'desktop-mix');
  const stem = await download(page, () => action(page, 'export-track').click());
  expect(inspectWav(stem.bytes).peak).toBeGreaterThan(0.005);

  await page.getByTestId('stop').click();
  const backup = await download(page, () => action(page, 'export-project').click());
  expect(backup.filename).toMatch(/\.fml$/i);
  expect(backup.bytes.length).toBeGreaterThan(1000);
  const name = await page.locator('[data-ref="project-name"]').textContent();

  const corrupt = Buffer.from(backup.bytes);
  corrupt[corrupt.length - 1] ^= 255;
  await page.locator('[data-ref="project-file"]').setInputFiles({ name: 'damaged.fml', mimeType: 'application/octet-stream', buffer: corrupt });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('[data-ref="project-name"]')).toHaveText(name);
  await view(page, 'build');
  await expect(tracks(page)).toHaveCount(count);

  await page.locator('[data-ref="project-file"]').setInputFiles({ name: backup.filename, mimeType: 'application/octet-stream', buffer: backup.bytes });
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(tracks(page)).toHaveCount(count);
  await expect(page.locator('.section-pad')).toHaveCount(sectionCount + 1);
  await view(page, 'mix');
  await expect(page.getByRole('slider', { name: 'Warmth · low EQ', exact: true })).toHaveValue('18');
  const restoredStem = await download(page, () => action(page, 'export-track').click());
  expect(restoredStem.bytes).toEqual(stem.bytes);
});

test('stop while microphone permission is pending cancels the late stream', async ({ page }) => {
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = constraints => new Promise((resolve, reject) => {
      window.__releaseMicrophoneRequest = async () => {
        try { resolve(await original(constraints)); } catch (error) { reject(error); }
      };
    });
  });
  await boot(page);
  await page.getByTestId('add-loop').click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseMicrophoneRequest)).toBe('function');
  await expect(page.getByTestId('stop')).toBeEnabled();
  await page.getByTestId('stop').click();
  await page.evaluate(() => window.__releaseMicrophoneRequest());
  await state(page, 'idle');
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(tracks(page)).toHaveCount(0);
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
  await expect.poll(() => page.evaluate(() => window.__testMicStreams.length > 0 && window.__testMicStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('microphone inputs switch between takes and remain locked while recording', async ({ page }) => {
  await boot(page);
  await page.getByTestId('enable-mic').click();
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Disconnect microphone');
  await page.locator('.advanced-settings > summary').click();
  const input = page.getByRole('combobox', { name: 'Microphone input', exact: true });
  await expect(input).toBeEnabled();
  await expect.poll(() => input.locator('option').count()).toBeGreaterThan(1);
  const deviceId = await input.evaluate(select => [...select.options].findLast(option => option.value && !option.disabled).value);
  await input.selectOption(deviceId);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue(deviceId);
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => {
    const streams = window.__testMicStreams;
    return streams.length >= 2 && streams.slice(0, -1).every(stream => stream.getTracks().every(track => track.readyState === 'ended')) && streams.at(-1).getAudioTracks().some(track => track.readyState === 'live');
  })).toBe(true);

  await page.getByTestId('add-loop').click();
  await state(page, 'recording');
  await expect(input).toBeDisabled();
  await page.waitForTimeout(1100);
  await page.getByTestId('finish').click();
  await state(page, 'idle');
  await expect(tracks(page)).toHaveCount(1);
  await expect(input).toBeEnabled();
  await expect.poll(async () => Number(await page.locator('[data-ref="output-db"]').textContent())).toBeGreaterThan(-60);
  await page.getByTestId('stop').click();
  await page.getByTestId('enable-mic').click();
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
  await expect.poll(() => page.evaluate(() => window.__testMicStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});

test('browser storage keeps exact PCM and prevents competing recovery during recording', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const { StorageClient } = await import('./src/storage/client.mjs');
    const { createProject } = await import('./src/project.mjs');
    const first = new StorageClient();
    const second = new StorageClient();
    try {
      const capabilities = await first.init();
      await second.init();
      const project = createProject('Storage integrity check');
      await first.saveProject(project);
      const assetId = `ci_complete_${crypto.randomUUID()}`;
      const interruptedId = `ci_interrupted_${crypto.randomUUID()}`;
      await first.beginAsset({ id: assetId, projectId: project.id, sampleRate: 48000, channels: 1, kind: 'loop', name: 'Exact PCM' });
      const pcm = Float32Array.from({ length: 512 }, (_, index) => (index % 17 - 8) / 16);
      const expected = [...pcm];
      await first.putPage(assetId, 0, pcm.buffer, pcm.length, 1);
      const finished = await first.finishAsset(assetId, { frames: expected.length });
      const stored = new Float32Array(await (await first.getAssetFile(assetId)).arrayBuffer());
      // Reopen the first worker's exclusive read handle. Another worker must
      // still be able to audition this immutable asset using its readonly path.
      await first.readPage(assetId, 0);
      const otherWorkerPage = await second.readPage(assetId, 0);
      const concurrentReadExact = JSON.stringify([...new Float32Array(otherWorkerPage.buffer)]) === JSON.stringify(expected);
      await first.beginAsset({ id: interruptedId, projectId: project.id, sampleRate: 48000, channels: 1, kind: 'vocal', name: 'Interrupted prefix' });
      await first.putPage(interruptedId, 0, new Float32Array(700).fill(0.125).buffer, 700, 1);
      let competingError = null;
      try { await second.recover(project.id); } catch (error) { competingError = error.code; }
      let competingPurgeError = null, recordingPurgeError = null;
      try { await second.purgeProject(project.id); } catch (error) { competingPurgeError = error.code; }
      try { await first.purgeProject(project.id); } catch (error) { recordingPurgeError = error.code; }
      const activeStatus = (await first.getAsset(interruptedId)).status;
      await first.dispose();
      const recovered = await second.recover(project.id);
      const reopened = await second.loadProject(project.id);
      const prefix = await second.readPage(interruptedId, 0);
      const recovery = {
        backend: capabilities.backend,
        locking: capabilities.locking,
        exact: JSON.stringify([...stored]) === JSON.stringify(expected),
        concurrentReadExact,
        finishedStatus: finished.status,
        competingError,
        activeStatus,
        recoveredFrames: recovered.find(asset => asset.id === interruptedId)?.frames,
        recoveredStatus: (await second.getAsset(interruptedId)).status,
        prefixCorrect: [...new Float32Array(prefix.buffer)].every(value => value === 0.125),
        reopenedName: reopened.name,
      };
      const neighbor = createProject('Keep this other project');
      await second.saveProject(neighbor);
      const neighborAssetId = `ci_neighbor_${crypto.randomUUID()}`;
      await second.beginAsset({ id: neighborAssetId, projectId: neighbor.id, sampleRate: 48000, channels: 1, kind: 'loop', name: 'Untouched PCM' });
      await second.putPage(neighborAssetId, 0, new Float32Array(64).fill(0.25).buffer, 64, 1);
      await second.finishAsset(neighborAssetId, { frames: 64 });
      const usage = await second.projectUsage(project.id);
      const purged = await second.purgeProject(project.id);
      const remainingAssets = await second.listAssets(project.id);
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('feed-the-music-loop-v1');
      const pcmFiles = [];
      for await (const name of directory.keys()) pcmFiles.push(name);
      const neighborAudio = new Float32Array(await (await second.getAssetFile(neighborAssetId)).arrayBuffer());
      const repeated = await second.purgeProject(project.id);
      const neighborPreserved = (await second.loadProject(neighbor.id)).name === neighbor.name && neighborAudio.length === 64 && neighborAudio.every(value => value === 0.25);
      // Switching projects must release both the writer lock and exclusive
      // file handles, so another tab can manage the former project's audio.
      await second.readPage(neighborAssetId, 0);
      await second.releaseProject(neighbor.id);
      const handoff = new StorageClient();
      let handoffDeletedAssets;
      try { await handoff.init(); handoffDeletedAssets = (await handoff.purgeProject(neighbor.id)).deletedAssets; }
      finally { await handoff.dispose(); }
      return { ...recovery,
        competingPurgeError, recordingPurgeError,
        audioBytes: usage.audioBytes, deletedAssets: purged.deletedAssets,
        projectRemoved: !(await second.loadProject(project.id)), assetMetadataRemoved: remainingAssets.length === 0,
        pcmRemoved: !pcmFiles.includes(`${assetId}.pcm`) && !pcmFiles.includes(`${interruptedId}.pcm`),
        neighborPreserved, handoffDeletedAssets, repeatDeletedAssets: repeated.deletedAssets,
      };
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
  expect(result).toEqual({
    backend: 'opfs', locking: true, exact: true, concurrentReadExact: true, finishedStatus: 'complete',
    competingError: 'PROJECT_BUSY', activeStatus: 'recording', recoveredFrames: 700,
    recoveredStatus: 'interrupted', prefixCorrect: true, reopenedName: 'Storage integrity check',
    competingPurgeError: 'PROJECT_BUSY', recordingPurgeError: 'RECORDING_ACTIVE',
    audioBytes: (512 + 700) * 4, deletedAssets: 2, projectRemoved: true,
    assetMetadataRemoved: true, pcmRemoved: true, neighborPreserved: true, handoffDeletedAssets: 1, repeatDeletedAssets: 0,
  });
});

test('narrow touch layout keeps recording controls visible and usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await boot(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.getByTestId('add-loop')).toBeInViewport();
  await expect(page.getByTestId('stop')).toBeInViewport();
  await recordFirstLoop(page);
  await expect(page.getByTestId('sing')).toBeInViewport();
  await reviewScreenshot(page, testInfo, 'mobile-build');
  await page.getByTestId('stop').click();
  await playing(page, false);
  await view(page, 'mix');
  await expect(page.getByRole('slider', { name: 'Warmth · low EQ', exact: true })).toBeVisible();
  await reviewScreenshot(page, testInfo, 'mobile-mix');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.locator('.advanced-settings > summary').click();
  await page.locator('.advanced-settings').scrollIntoViewIfNeeded();
  const timingScreenshot = testInfo.outputPath('review-mobile-timing.png');
  await page.screenshot({ path: timingScreenshot, animations: 'disabled' });
  await testInfo.attach('mobile-timing', { path: timingScreenshot, contentType: 'image/png' });
});
