import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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
  let servedWorker, finalWorkerHash, registration, recording, loopRecording;
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
    await page.getByTestId('add-loop').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    await page.waitForTimeout(1100); // A real recording needs elapsed audio time.
    await page.getByTestId('finish').click();
    await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(1);
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
    await expect(page.locator('[data-ref="save-state"]')).toHaveText('Saved on this device');
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    await expect.poll(async () => Number(await page.locator('[data-ref="output-db"]').textContent())).toBeGreaterThan(-60);
    await page.getByTestId('stop').click();
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'false');
    await page.getByTestId('enable-mic').click();
    await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
    await page.locator('[data-action="view"][data-view="mix"]').click();
    const downloading = page.waitForEvent('download');
    await page.locator('[data-view-panel="mix"] [data-action="export-track"]:visible').click();
    const file = await downloading;
    expect(await file.failure()).toBeNull();
    expect(file.suggestedFilename()).toMatch(/\.wav$/i);
    recording = inspectRecording(await readFile(await file.path()));
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
    loopRecording = inspectRecording(await readFile(await loopFile.path()), 2);
    expect(await page.evaluate(() => window.__unexpectedLoopMicRequests)).toBe(0);
    await expect(page.locator('[data-ref="recovery"], [data-ref="downloads"]')).toHaveCount(0);
    await page.getByTestId('stop').click();
    // The public deployment must expose the on-demand file manager, with
    // actual captured audio and its offline shell inside this site's scope.
    await page.getByTestId('storage').click();
    const storageDialog = page.getByRole('dialog', { name: 'Storage', exact: true });
    await expect(storageDialog).toBeVisible();
    await expect(storageDialog.locator('[data-testid=storage-remaining]')).toBeVisible();
    const capturedFile = storageDialog.locator('.storage-file-row').filter({ hasText: 'Loop recording 1' });
    await expect(capturedFile).toHaveCount(1);
    expect(Number(await capturedFile.getAttribute('data-file-bytes'))).toBeGreaterThan(0);
    await expect(capturedFile.getByRole('button', { name: 'Permanently delete Loop recording 1', exact: true })).toBeEnabled();
    await expect(storageDialog.locator('.storage-file-row').filter({ hasText: 'Offline app file' }).first()).toBeVisible();
    const storageScreenshot = testInfo.outputPath('review-live-storage-manager.png');
    await page.screenshot({ path: storageScreenshot, animations: 'disabled' });
    await testInfo.attach('live-storage-manager', { path: storageScreenshot, contentType: 'image/png' });
    await storageDialog.getByRole('button', { name: 'Done', exact: true }).click();
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
      body: JSON.stringify({ expectedSwSha256: expectedHash, servedSwSha256: servedWorker ? sha256(Buffer.from(servedWorker.source, 'utf8')) : null, finalSwSha256: finalWorkerHash, registration, recording, loopRecording, indexResponses, propagationChecks, errors, unexpectedRequests }, null, 2),
      contentType: 'application/json',
    });
  }
});
