import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function pcmData(bytes) {
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (bytes.subarray(offset, offset + 4).toString() === 'data') return bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  throw new Error('WAV contains no audio data');
}

function inspectRecording(bytes, channels = 1) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
  let sampleRate, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.subarray(offset, offset + 4).toString();
    const length = bytes.readUInt32LE(offset + 4);
    expect(offset + 8 + length).toBeLessThanOrEqual(bytes.length);
    if (name === 'fmt ') {
      expect(bytes.readUInt16LE(offset + 8)).toBe(3);
      expect(bytes.readUInt16LE(offset + 10)).toBe(channels);
      sampleRate = bytes.readUInt32LE(offset + 12);
      expect(bytes.readUInt16LE(offset + 20)).toBe(4 * channels);
      expect(bytes.readUInt16LE(offset + 22)).toBe(32);
    }
    if (name === 'data') data = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  expect(sampleRate).toBeGreaterThanOrEqual(8000);
  expect(data).toBeDefined();
  expect(data.length % 4).toBe(0);
  expect(data.length / 4 / channels / sampleRate).toBeGreaterThan(0.9);
  let peak = 0, invalid = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    const sample = data.readFloatLE(offset);
    if (!Number.isFinite(sample)) invalid++;
    peak = Math.max(peak, Math.abs(sample));
  }
  expect(invalid).toBe(0);
  expect(peak).toBeGreaterThan(0.005);
  return { sampleRate, channels, frames: data.length / 4 / channels, peak, sha256: sha256(bytes) };
}

test('the exact deployed HTTPS studio records, loops, saves and exports real audio', async ({ page, context, request, baseURL }, testInfo) => {
  const expectedHash = process.env.FML_EXPECTED_SW_SHA256;
  const swURL = new URL('sw.js', baseURL).href;
  const errors = [], unexpectedRequests = [], indexResponses = [], propagationChecks = [];
  let servedWorker, finalWorkerHash, registration, recording, loopRecording, originalLoopBytes, loopRecordingBytes, editedRecording, masteredRecording, loopStartTiming;
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', incoming => {
    const url = new URL(incoming.url());
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== new URL(baseURL).origin || !['GET', 'HEAD'].includes(incoming.method()))) {
      unexpectedRequests.push(`${incoming.method()} ${incoming.url()}`);
    }
  });
  page.on('response', response => {
    if (response.request().isNavigationRequest()) indexResponses.push({ url: response.url(), status: response.status(), fromServiceWorker: response.fromServiceWorker() });
  });

  try {
    // CDN propagation is allowed a bounded wait. An old or unbuilt deployment
    // cannot pass: this compares exact bytes with the package job's hash.
    await expect.poll(async () => {
      try {
        const response = await request.get(swURL, { timeout: 10_000, maxRedirects: 0, headers: { 'Cache-Control': 'no-cache' } });
        const body = await response.body();
        const hash = sha256(body);
        propagationChecks.push({ at: new Date().toISOString(), url: response.url(), status: response.status(), sha256: hash });
        return response.status() === 200 ? hash : `HTTP ${response.status()}`;
      } catch (error) {
        propagationChecks.push({ at: new Date().toISOString(), error: error.message });
        return 'unavailable';
      }
    }, { timeout: 60_000, intervals: [2000], message: 'GitHub Pages must serve sw.js from this exact deployment package' }).toBe(expectedHash);

    const initial = await page.goto('./');
    expect(initial?.status()).toBe(200);
    expect(initial?.url()).toBe(baseURL);
    expect(await page.evaluate(() => isSecureContext)).toBe(true);
    await expect(page.getByTestId('add-loop')).toBeEnabled();
    servedWorker = await page.evaluate(async url => {
      const response = await fetch(url, { cache: 'no-store' });
      return { url: response.url, status: response.status, source: await response.text() };
    }, swURL);
    expect(servedWorker.status).toBe(200);
    expect(servedWorker.url).toBe(swURL);
    expect(sha256(Buffer.from(servedWorker.source, 'utf8'))).toBe(expectedHash);
    expect(servedWorker.source).not.toContain('__BUILD_REVISION__');
    expect(servedWorker.source).not.toContain('__BUILD_ASSETS__');
    const revision = servedWorker.source.match(/const REVISION = "([a-f0-9]{16})";/)?.[1];
    expect(revision).toMatch(/^[a-f0-9]{16}$/);

    await expect.poll(() => page.evaluate(async scope => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      return registrations.find(item => item.scope === scope)?.active?.state;
    }, baseURL)).toBe('activated');
    registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return { scope: ready.scope, scriptURL: ready.active?.scriptURL, state: ready.active?.state };
    });
    expect(registration).toEqual({ scope: baseURL, scriptURL: swURL, state: 'activated' });
    const shell = await page.evaluate(async ({ scope, revision }) => {
      const key = `fml-shell-${encodeURIComponent(new URL(scope).pathname)}-${revision}`;
      if (!(await caches.keys()).includes(key)) return [];
      return (await (await caches.open(key)).keys()).map(entry => entry.url);
    }, { scope: baseURL, revision });
    expect(shell).toContain(new URL('index.html', baseURL).href);
    expect(shell).toContain(new URL('src/audio/loop-worklet.mjs', baseURL).href);

    // The production service worker intentionally takes control on navigation,
    // so no claim, skipWaiting, service-worker mocking or cache clearing occurs.
    await page.reload();
    await expect(page.getByTestId('add-loop')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(swURL);
    await expect(page.getByRole('combobox', { name: 'New loop length', exact: true })).toHaveValue('free');
    await expect(page.getByRole('combobox', { name: 'Recording starts', exact: true })).toHaveValue('immediate');
    await page.getByRole('combobox', { name: 'New loop length', exact: true }).selectOption('seconds');
    const duration = page.getByRole('spinbutton', { name: 'Loop duration in seconds', exact: true });
    await duration.fill('3.25'); await duration.press('Tab');
    await page.getByTestId('enable-mic').click();
    await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Disconnect microphone');
    await page.evaluate(() => {
      const root = document.querySelector('#app'), button = document.querySelector('[data-testid="add-loop"]');
      const timing = window.__liveLoopOnset = { clickedAt: null, recordingAt: null };
      button.addEventListener('click', () => { timing.clickedAt = performance.now(); }, { once: true, capture: true });
      const observer = new MutationObserver(() => {
        if (root.dataset.captureState === 'recording' && timing.clickedAt !== null) { timing.recordingAt = performance.now(); observer.disconnect(); }
      });
      observer.observe(root, { attributes: true, attributeFilter: ['data-capture-state'] });
    });
    await page.getByTestId('add-loop').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    loopStartTiming = await page.evaluate(() => window.__liveLoopOnset);
    expect(loopStartTiming.clickedAt).toEqual(expect.any(Number)); expect(loopStartTiming.recordingAt).toEqual(expect.any(Number));
    expect(loopStartTiming.recordingAt - loopStartTiming.clickedAt).toBeLessThan(500);
    // Timed first-loop capture finishes itself at the selected exact duration.
    await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(1);
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
    await expect(page.locator('[data-ref="save-state"]')).toHaveText('Saved on this device');
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    await expect.poll(async () => Number(await page.locator('[data-ref="output-db"]').textContent())).toBeGreaterThan(-60);
    await page.getByTestId('pause').click();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'false');
    await page.waitForTimeout(100); // Let the audio-thread acknowledgement update the visible clock.
    const heldTime = await page.locator('[data-ref="transport-time"]').textContent();
    const heldPositions = await page.locator('.loop-card [data-position]').evaluateAll(nodes => nodes.map(node => node.style.left));
    expect(heldTime).not.toBe('0:00.0');
    await page.waitForTimeout(200);
    await expect(page.locator('[data-ref="transport-time"]')).toHaveText(heldTime);
    expect(await page.locator('.loop-card [data-position]').evaluateAll(nodes => nodes.map(node => node.style.left))).toEqual(heldPositions);
    await page.getByTestId('play').click();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    await expect(page.locator('[data-ref="transport-time"]')).not.toHaveText(heldTime);
    await page.getByTestId('stop').click();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'false');
    await expect(page.locator('[data-ref="transport-time"]')).toHaveText('0:00.0');
    await expect.poll(() => page.locator('.loop-card [data-position]').evaluateAll(nodes => nodes.map(node => Number.parseFloat(node.style.left)))).toEqual([0]);
    await page.getByTestId('enable-mic').click();
    await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
    await page.locator('[data-action="view"][data-view="mix"]').click();
    await page.getByRole('button', { name: 'Layers & vocals', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.locator('[data-view-panel="mix"] [data-action="export-track"]:visible').click();
    const file = await downloading;
    expect(await file.failure()).toBeNull();
    expect(file.suggestedFilename()).toMatch(/\.wav$/i);
    originalLoopBytes = await readFile(await file.path());
    recording = inspectRecording(originalLoopBytes);
    expect(recording.frames).toBe(Math.round(recording.sampleRate * 3.25));
    // Prove the deployed loop-only action works after disconnecting the mic.
    await page.locator('[data-action="view"][data-view="build"]').click();
    await page.evaluate(() => {
      window.__unexpectedLoopMicRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => {
        window.__unexpectedLoopMicRequests++;
        throw new DOMException('Microphone is unavailable.', 'NotAllowedError');
      };
    });
    await page.getByTestId('record-all-loops').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    await expect(page.getByTestId('pause')).toBeDisabled();
    await expect(page.locator('[data-ref="capture-live-label"]')).toHaveText('LIVE LOOPS');
    await page.waitForTimeout(1100);
    await page.getByTestId('finish').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
    const recent = page.locator('[data-ref="recent-recording"]');
    await expect(recent).toContainText('Loop recording 1');
    await expect(recent).toContainText('Loops only');
    const loopDownload = page.waitForEvent('download');
    await recent.getByRole('button', { name: 'Download Loop recording 1', exact: true }).click();
    const loopFile = await loopDownload;
    expect(await loopFile.failure()).toBeNull();
    loopRecordingBytes = await readFile(await loopFile.path());
    loopRecording = inspectRecording(loopRecordingBytes, 2);
    expect(await page.evaluate(() => window.__unexpectedLoopMicRequests)).toBe(0);
    await expect(page.locator('[data-ref="recovery"], [data-ref="downloads"]')).toHaveCount(0);
    await page.getByTestId('stop').click();
    // The public deployment must expose the on-demand file manager, with
    // actual captured audio and its offline shell inside this site's scope.
    await page.getByTestId('storage').click();
    const storageDialog = page.getByRole('dialog', { name: 'Storage', exact: true });
    await expect(storageDialog).toBeVisible();
    await expect(storageDialog.locator('[data-testid=storage-remaining]')).toBeVisible();
    await expect(storageDialog.getByTestId('storage-write-status')).toHaveAttribute('data-status', 'passed');
    await expect(storageDialog.getByTestId('check-storage')).toBeEnabled();
    await expect(storageDialog).not.toContainText(/About 0s|0 B available/i);
    const capturedFile = storageDialog.locator('.storage-file-row').filter({ hasText: 'Loop recording 1' });
    await expect(capturedFile).toHaveCount(1);
    expect(Number(await capturedFile.getAttribute('data-file-bytes'))).toBeGreaterThan(0);
    await expect(capturedFile.getByRole('button', { name: 'Permanently delete Loop recording 1', exact: true })).toBeEnabled();
    await expect(storageDialog.locator('.storage-file-row').filter({ hasText: 'Offline app file' }).first()).toBeVisible();
    const storageScreenshot = testInfo.outputPath('review-live-storage-manager.png');
    await page.screenshot({ path: storageScreenshot, animations: 'disabled' });
    await testInfo.attach('live-storage-manager', { path: storageScreenshot, contentType: 'image/png' });
    await storageDialog.getByRole('button', { name: 'Done', exact: true }).click();
    // Exercise the editor in the exact deployed shell, using real recorded
    // samples rather than a mocked model. The copied selection must survive
    // trimming its source and paste at the requested sample position.
    await page.locator('.loop-card [data-action="edit-track"]').first().click();
    const editor = page.getByTestId('track-editor');
    await expect(editor).toBeVisible();
    await editor.getByLabel('Selection end in seconds', { exact: true }).fill('0.875');
    await editor.getByLabel('Selection end in seconds', { exact: true }).press('Tab');
    await editor.getByLabel('Selection start in seconds', { exact: true }).fill('0.125');
    await editor.getByLabel('Selection start in seconds', { exact: true }).press('Tab');
    await editor.getByRole('button', { name: 'Copy selection', exact: true }).click();
    await expect(editor.locator('[data-editor-ref="clipboard"]')).toContainText('0.75 s copied.');
    await editor.getByRole('button', { name: 'Trim to selection', exact: true }).click();
    const editorLength = editor.getByLabel('Track length in seconds', { exact: true });
    await expect.poll(async () => Number(await editorLength.inputValue())).toBe(.75);
    await editor.getByLabel('Paste position in seconds', { exact: true }).fill('0.25');
    await editor.getByLabel('Paste position in seconds', { exact: true }).press('Tab');
    await editor.getByRole('button', { name: 'Paste', exact: true }).click();
    await expect.poll(async () => Number(await editorLength.inputValue())).toBe(1.5);
    await expect(page.locator('[data-ref="save-state"]')).toHaveText('Saved on this device');
    const editorScreenshot = testInfo.outputPath('review-live-track-editor.png');
    await page.screenshot({ path: editorScreenshot, animations: 'disabled' });
    await testInfo.attach('live-track-editor', { path: editorScreenshot, contentType: 'image/png' });
    await page.getByRole('dialog', { name: 'Edit audio', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('[data-action="view"][data-view="mix"]').click();
    await page.getByRole('button', { name: 'Layers & vocals', exact: true }).click();
    const editedDownload = page.waitForEvent('download');
    await page.locator('[data-view-panel="mix"] [data-action="export-track"]:visible').click();
    const editedFile = await editedDownload;
    expect(await editedFile.failure()).toBeNull();
    const editedBytes = await readFile(await editedFile.path());
    editedRecording = inspectRecording(editedBytes);
    const originalPCM = pcmData(originalLoopBytes), rate = recording.sampleRate;
    const copied = originalPCM.subarray(Math.round(.125 * rate) * 4, Math.round(.875 * rate) * 4);
    const pasteByte = Math.round(.25 * rate) * 4;
    const expectedPCM = Buffer.concat([copied.subarray(0, pasteByte), copied, copied.subarray(pasteByte)]);
    expect(pcmData(editedBytes).equals(expectedPCM)).toBe(true);
    await page.locator('[data-action="view"][data-view="build"]').click();
    // A saved loops-only song must be selectable independently of the edited
    // loop mixer, processed in stereo, and downloaded as a separate version.
    await recent.getByRole('button', { name: 'Mix and master Loop recording 1', exact: true }).click();
    const master = page.getByTestId('recording-master');
    await expect(master).toBeVisible();
    await expect(master.getByRole('heading', { name: 'Loop recording 1', exact: true })).toBeVisible();
    const gain = master.locator('input[data-control="recording-master"][data-key="gainDb"]');
    await gain.focus();
    for (let step = 0; step < 12; step++) await gain.press('ArrowLeft');
    await expect(gain).toHaveValue('-6');
    await expect(master.locator('[data-control="recording-master-normalize"]')).not.toBeChecked();
    await master.getByLabel('New version name', { exact: true }).fill('Live mastered loop song');
    await master.getByTestId('preview-master').click();
    const player = master.locator('#recording-master-player');
    await expect(player).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => player.evaluate(audio => audio.readyState)).toBeGreaterThanOrEqual(2);
    await master.getByRole('button', { name: 'Close preview', exact: true }).click();
    const masterDownload = page.waitForEvent('download');
    await master.getByRole('button', { name: 'Save new master', exact: true }).click();
    const masterFile = await masterDownload;
    expect(await masterFile.failure()).toBeNull();
    const masterBytes = await readFile(await masterFile.path());
    masteredRecording = inspectRecording(masterBytes, 2);
    expect(masteredRecording.frames).toBe(loopRecording.frames);
    expect(masteredRecording.sampleRate).toBe(loopRecording.sampleRate);
    const sourceSongPCM = pcmData(loopRecordingBytes), masterPCM = pcmData(masterBytes);
    expect(masterPCM.length).toBe(sourceSongPCM.length);
    const expectedMasterPCM = Buffer.alloc(sourceSongPCM.length);
    for (let offset = 0; offset < masterPCM.length; offset += 4) {
      expectedMasterPCM.writeFloatLE(Math.fround(sourceSongPCM.readFloatLE(offset) * 10 ** (-6 / 20)), offset);
    }
    expect(masterPCM.equals(expectedMasterPCM)).toBe(true);
    await expect(master.locator('[data-ref="recording-master-outputs"]')).toContainText('Live mastered loop song');
    const masterScreenshot = testInfo.outputPath('review-live-recording-master.png');
    await page.screenshot({ path: masterScreenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach('live-recording-master', { path: masterScreenshot, contentType: 'image/png' });
    await page.locator('[data-action="view"][data-view="build"]').click();
    const originalAgain = page.waitForEvent('download');
    await recent.getByRole('button', { name: 'Download Loop recording 1', exact: true }).click();
    expect(sha256(await readFile(await (await originalAgain).path()))).toBe(loopRecording.sha256);
    // Recheck the network after the recording. A competing branch-root Pages
    // publish must not replace this package while its cached shell still works.
    const finalWorker = await request.get(swURL, { timeout: 10_000, maxRedirects: 0, headers: { 'Cache-Control': 'no-cache' } });
    expect(finalWorker.status()).toBe(200);
    finalWorkerHash = sha256(await finalWorker.body());
    expect(finalWorkerHash).toBe(expectedHash);
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    await expect(page.locator('.toast-error')).toHaveCount(0);
    const notifications = page.locator('.toast:not(.toast-error) [aria-label="Dismiss notification"]');
    while (await notifications.count()) await notifications.first().click();
    const screenshot = testInfo.outputPath('review-live-pages-studio.png');
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach('live-pages-studio', { path: screenshot, contentType: 'image/png' });
  } finally {
    await testInfo.attach('live-deployment-evidence', {
      body: JSON.stringify({ expectedSwSha256: expectedHash, servedSwSha256: servedWorker ? sha256(Buffer.from(servedWorker.source, 'utf8')) : null, finalSwSha256: finalWorkerHash, registration, recording, loopRecording, editedRecording, masteredRecording, loopStartTiming, indexResponses, propagationChecks, errors, unexpectedRequests }, null, 2),
      contentType: 'application/json',
    });
  }
});
