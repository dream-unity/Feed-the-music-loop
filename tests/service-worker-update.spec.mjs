import { test, expect } from '@playwright/test';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const APP = 'https://127.0.0.1:4174/Feed-the-music-loop/';
const WORKER_URL = new URL('sw.js', APP).href;
const repository = fileURLToPath(new URL('..', import.meta.url));
const workerPath = resolve(repository, '_site/sw.js');
const probePath = resolve(repository, '_site/ci-update-probe.mjs');
const stylePath = resolve(repository, '_site/style.css');
const styleURL = new URL('style.css', APP).href;
const prefix = `fml-shell-${encodeURIComponent(new URL(APP).pathname)}-`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const integrity = bytes => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

function version(source, revision, { addedAssets = [], integrityOverrides = {} } = {}) {
  expect(source).toMatch(/const REVISION = "[a-f0-9]{16}";/);
  expect(source).toContain('const ASSETS = [');
  const match = source.match(/const INTEGRITY = (\{[\s\S]*?\});/);
  expect(match).not.toBeNull();
  const values = { ...JSON.parse(match[1]), ...integrityOverrides };
  const additional = addedAssets.length ? `${addedAssets.map(path => JSON.stringify(path)).join(',')},` : '';
  return source.replace(/const REVISION = "[a-f0-9]{16}";/, `const REVISION = "${revision}";`)
    .replace('const ASSETS = [', `const ASSETS = [${additional}`)
    .replace(/const INTEGRITY = \{[\s\S]*?\};/, `const INTEGRITY = ${JSON.stringify(values)};`);
}

async function cachedText(page, cacheName, url) {
  return page.evaluate(async ({ cacheName, url }) => {
    const response = await (await caches.open(cacheName)).match(url);
    return response ? response.text() : null;
  }, { cacheName, url });
}

async function beginUpdate(page) {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    window.__fmlControllerBeforeUpdate = navigator.serviceWorker.controller;
    window.__fmlUpdateStates = [];
    window.__fmlUpdateError = null;
    window.__fmlInstallingWorker = null;
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      window.__fmlInstallingWorker = installing;
      const observe = () => window.__fmlUpdateStates.push(installing.state);
      observe();
      installing.addEventListener('statechange', observe);
    }, { once: true });
    try { await registration.update(); }
    catch (error) { window.__fmlUpdateError = { name: error.name, message: error.message }; }
  });
}

async function controllerUnchanged(page) {
  return page.evaluate(() => navigator.serviceWorker.controller === window.__fmlControllerBeforeUpdate && navigator.serviceWorker.controller?.state === 'activated');
}

async function playSavedLoop(page) {
  await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(1);
  await expect(page.getByTestId('play')).toBeEnabled();
  await page.getByTestId('play').click();
  await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
  await expect.poll(async () => Number(await page.locator('[data-ref="output-db"]').textContent())).toBeGreaterThan(-60);
  await expect.poll(async () => {
    const [minutes, seconds] = (await page.locator('[data-ref="transport-time"]').textContent()).split(':').map(Number);
    return minutes * 60 + seconds;
  }).toBeGreaterThan(0.3);
}

async function originalRecording(page) {
  await page.locator('[data-action="view"][data-view="mix"]').click();
  const event = page.waitForEvent('download');
  await page.locator('[data-view-panel="mix"] [data-action="export-track"]:visible').click();
  const download = await event;
  expect(await download.failure()).toBeNull();
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  expect(bytes.length).toBeGreaterThan(48_000);
  return digest(bytes);
}

const updateMessage = 'Studio update ready. Finish recording, then close every studio tab or app window and reopen. Your saved audio stays on this device.';
async function expectUpdateNotice(page) {
  const notice = page.locator('[data-ref="update-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toHaveText(updateMessage);
}

test('failed or mismatched shell updates preserve offline audio and a valid fresh update waits until the studio closes', async ({ page, context, request }, testInfo) => {
  test.setTimeout(180_000);
  // Runtime fixture writes affect only the compiled CI package. The HTTPS
  // suite runs serially; production sources and deployed files are untouched.
  const originalWorker = await readFile(workerPath, 'utf8');
  const originalStyle = await readFile(stylePath, 'utf8');
  const unbuiltWorker = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
  expect(unbuiltWorker).toContain('__BUILD_ASSETS__');
  const originalRevision = originalWorker.match(/const REVISION = "([a-f0-9]{16})";/)?.[1];
  expect(originalRevision).toMatch(/^[a-f0-9]{16}$/);
  const badRevision = randomBytes(8).toString('hex'), mismatchRevision = randomBytes(8).toString('hex'), goodRevision = randomBytes(8).toString('hex');
  const oldCache = prefix + originalRevision, badCache = prefix + badRevision, mismatchCache = prefix + mismatchRevision, goodCache = prefix + goodRevision;
  const probeURL = new URL('ci-update-probe.mjs', APP).href;
  const probeSource = `export const revision = ${JSON.stringify(goodRevision)};\n`;
  const updatedStyle = `${originalStyle}\n:root { --fml-ci-package: ${JSON.stringify(goodRevision)}; }\n`;
  const errors = [], unexpectedRequests = [], observations = {};
  let currentPage = page, probeCreated = false;
  const observePage = opened => opened.on('pageerror', error => errors.push(error.message));
  observePage(page);
  context.on('page', observePage);
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== new URL(APP).origin || !url.pathname.startsWith(new URL(APP).pathname) || !['GET', 'HEAD'].includes(request.method()))) {
      unexpectedRequests.push(`${request.method()} ${request.url()}`);
    }
  });

  try {
    await page.goto(APP);
    await expect(page.getByTestId('add-loop')).toBeEnabled();
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe('activated');
    await page.reload();
    await expect(page.getByTestId('add-loop')).toBeEnabled();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    expect(await page.evaluate(key => caches.has(key), oldCache)).toBe(true);
    const oldWorker = context.serviceWorkers().find(worker => worker.url() === WORKER_URL);
    expect(oldWorker).toBeDefined();

    await page.getByTestId('add-loop').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    await page.waitForTimeout(1200);
    await page.getByTestId('finish').click();
    await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(1);
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
    await expect(page.locator('[data-ref="save-state"]')).toHaveText('Saved on this device');
    await page.getByTestId('stop').click();
    await page.getByTestId('enable-mic').click();
    await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
    const recordingHash = await originalRecording(page);

    // A native branch-root publish can briefly expose the source template.
    // Its empty asset list must reject installation instead of erasing the
    // complete packaged shell on activation.
    await writeFile(workerPath, unbuiltWorker);
    await beginUpdate(page);
    await expect.poll(() => page.evaluate(() => window.__fmlInstallingWorker?.state)).toBe('redundant');
    expect(await controllerUnchanged(page)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), oldCache)).toBe(true);
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))).toBe(false);
    observations.unbuiltUpdate = await page.evaluate(() => ({ states: window.__fmlUpdateStates, updateError: window.__fmlUpdateError, controllerState: navigator.serviceWorker.controller?.state }));
    await playSavedLoop(page);
    await page.getByTestId('stop').click();

    // A missing precache member causes the new install promise to reject.
    // The currently controlling worker and its complete shell must survive.
    const missingPath = `./ci-missing-${badRevision}.mjs`;
    await writeFile(workerPath, version(originalWorker, badRevision, {
      addedAssets: [missingPath], integrityOverrides: { [missingPath]: integrity('Intentionally absent CI fixture') },
    }));
    await beginUpdate(page);
    await expect.poll(() => page.evaluate(() => window.__fmlInstallingWorker?.state)).toBe('redundant');
    expect(await controllerUnchanged(page)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), oldCache)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), badCache)).toBe(false);
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.ready).waiting))).toBe(false);
    observations.failedUpdate = await page.evaluate(() => ({ states: window.__fmlUpdateStates, updateError: window.__fmlUpdateError, controllerState: navigator.serviceWorker.controller?.state }));

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('add-loop')).toBeEnabled();
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);
    await playSavedLoop(page);
    await page.getByTestId('stop').click();
    expect(await originalRecording(page)).toBe(recordingHash);
    expect(await page.evaluate(key => caches.has(key), oldCache)).toBe(true);

    // style.css is deliberately HTTP-cacheable in this isolated fixture. A
    // worker-originated fetch bypasses the controlling worker's fetch handler,
    // proving the old bytes remain in the browser HTTP cache after disk changes.
    await context.setOffline(false);
    // Prime from the same worker that will inspect the HTTP cache, so this
    // precondition does not depend on the earlier installation requests.
    expect(await oldWorker.evaluate(async url => (await fetch(url, { cache: 'reload' })).text(), styleURL)).toBe(originalStyle);
    await writeFile(stylePath, updatedStyle);
    // This independent Node HTTP client does not share Chromium's scoped
    // certificate verifier or its HTTP cache.
    const physicalStyle = await request.get(styleURL, { headers: { 'Cache-Control': 'no-cache' }, ignoreHTTPSErrors: true });
    expect(physicalStyle.status()).toBe(200);
    expect(await physicalStyle.text()).toBe(updatedStyle);
    expect(physicalStyle.headers()['cache-control']).toContain('max-age=3600');
    const httpCachedStyle = await oldWorker.evaluate(async url => (await fetch(url, { cache: 'force-cache' })).text(), styleURL);
    expect(httpCachedStyle).toBe(originalStyle);
    observations.httpCache = { cachedSha256: digest(httpCachedStyle), networkSha256: digest(updatedStyle) };

    // Every URL exists, but the manifest still declares the old CSS hash.
    // Reloading from the network must expose and reject this mixed deployment,
    // rather than accepting the stale HTTP-cached asset with the matching hash.
    await writeFile(workerPath, version(originalWorker, mismatchRevision));
    await beginUpdate(page);
    await expect.poll(() => page.evaluate(() => window.__fmlInstallingWorker?.state)).toBe('redundant');
    expect(await controllerUnchanged(page)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), oldCache)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), mismatchCache)).toBe(false);
    expect(await cachedText(page, oldCache, styleURL)).toBe(originalStyle);
    observations.mismatchedUpdate = await page.evaluate(() => ({ states: window.__fmlUpdateStates, updateError: window.__fmlUpdateError, controllerState: navigator.serviceWorker.controller?.state }));
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('add-loop')).toBeEnabled();
    await playSavedLoop(page);
    await page.getByTestId('stop').click();
    expect(await originalRecording(page)).toBe(recordingHash);

    // The next package has a valid new cached asset. Its installed worker must
    // remain waiting while this existing studio keeps its loop playing.
    await context.setOffline(false);
    // The rejected integrity fetch may have refreshed the browser HTTP cache.
    // Prime that cache with the old stylesheet again, then change only the
    // server bytes, so the successful update independently proves reload mode.
    await writeFile(stylePath, originalStyle);
    expect(await oldWorker.evaluate(async url => (await fetch(url, { cache: 'reload' })).text(), styleURL)).toBe(originalStyle);
    await writeFile(stylePath, updatedStyle);
    expect(await oldWorker.evaluate(async url => (await fetch(url, { cache: 'force-cache' })).text(), styleURL)).toBe(originalStyle);
    await writeFile(probePath, probeSource, { flag: 'wx' });
    probeCreated = true;
    await writeFile(workerPath, version(originalWorker, goodRevision, {
      addedAssets: ['./ci-update-probe.mjs'],
      integrityOverrides: { './ci-update-probe.mjs': integrity(probeSource), './style.css': integrity(updatedStyle) },
    }));
    await playSavedLoop(page);
    await page.getByTestId('sing').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    const recordingTimeBeforeUpdate = await page.locator('[data-ref="capture-time"]').textContent();
    const workerEvent = context.waitForEvent('serviceworker', { predicate: worker => worker.url() === WORKER_URL });
    await beginUpdate(page);
    const newWorker = await workerEvent;
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).waiting?.state)).toBe('installed');
    await expectUpdateNotice(page);
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    await expect.poll(() => page.locator('[data-ref="capture-time"]').textContent()).not.toBe(recordingTimeBeforeUpdate);
    expect(await controllerUnchanged(page)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), oldCache)).toBe(true);
    expect(await page.evaluate(key => caches.has(key), goodCache)).toBe(true);
    expect(await cachedText(page, oldCache, styleURL)).toBe(originalStyle);
    expect(await cachedText(page, goodCache, styleURL)).toBe(updatedStyle);
    await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
    const timeBefore = await page.locator('[data-ref="transport-time"]').textContent();
    await expect.poll(() => page.locator('[data-ref="transport-time"]').textContent()).not.toBe(timeBefore);
    observations.waitingUpdate = await page.evaluate(() => ({ states: window.__fmlUpdateStates, controllerState: navigator.serviceWorker.controller?.state }));

    await page.getByTestId('finish').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
    await expect(page.locator('[data-ref="save-state"]')).toHaveText('Saved on this device');
    await expectUpdateNotice(page);
    await page.getByTestId('stop').click();

    // An already installed update must also be explained to a newly opened tab.
    const secondTab = await context.newPage();
    await secondTab.goto(APP);
    await expect(secondTab.locator('.loop-card[data-track-id]')).toHaveCount(1);
    await expectUpdateNotice(secondTab);
    expect(await secondTab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fml-ci-package').trim())).toBe('');
    await secondTab.reload();
    await expect(secondTab.locator('.loop-card[data-track-id]')).toHaveCount(1);
    await expectUpdateNotice(secondTab);
    expect(await secondTab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fml-ci-package').trim())).toBe('');

    await page.close();
    await expect.poll(() => secondTab.evaluate(async () => (await navigator.serviceWorker.ready).waiting?.state)).toBe('installed');
    expect(await secondTab.evaluate(key => caches.has(key), oldCache)).toBe(true);
    // Only closing the final controlled tab permits the new package to activate.
    await secondTab.close();
    await expect.poll(() => newWorker.evaluate(() => self.registration.waiting === null && self.registration.active?.state === 'activated')).toBe(true);
    currentPage = await context.newPage();
    await currentPage.goto(APP);
    await expect(currentPage.getByTestId('add-loop')).toBeEnabled();
    await expect.poll(() => currentPage.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await expect(currentPage.locator('[data-ref="update-notice"]')).toBeHidden();
    await expect.poll(() => currentPage.evaluate(async namespace => (await caches.keys()).filter(key => key.startsWith(namespace)), prefix)).toEqual([goodCache]);
    expect(await currentPage.evaluate(key => caches.has(key), badCache)).toBe(false);
    expect(await currentPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--fml-ci-package').trim())).toBe(JSON.stringify(goodRevision));

    // Only the new worker's asset allowlist contains this file. Retrieving it
    // offline demonstrates that the newly activated package is controlling.
    await context.setOffline(true);
    const offlineProbe = await currentPage.evaluate(async url => {
      const response = await fetch(url);
      return { status: response.status, text: await response.text() };
    }, probeURL);
    expect(offlineProbe).toEqual({ status: 200, text: probeSource });
    expect(await currentPage.evaluate(async url => (await fetch(url)).text(), styleURL)).toBe(updatedStyle);
    await playSavedLoop(currentPage);
    await currentPage.getByTestId('stop').click();
    expect(await originalRecording(currentPage)).toBe(recordingHash);
    observations.activatedUpdate = { cache: goodCache, offlineProbe, recordingSha256: recordingHash };
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
    await expect(currentPage.locator('.toast-error')).toHaveCount(0);
    const notifications = currentPage.locator('.toast:not(.toast-error) [aria-label="Dismiss notification"]');
    while (await notifications.count()) await notifications.first().click();
    const screenshot = testInfo.outputPath('review-service-worker-upgrade.png');
    await currentPage.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach('service-worker-upgrade', { path: screenshot, contentType: 'image/png' });
  } finally {
    await writeFile(workerPath, originalWorker);
    await writeFile(stylePath, originalStyle);
    if (probeCreated) await rm(probePath, { force: true });
    await context.setOffline(false);
    await testInfo.attach('service-worker-update-evidence', {
      body: JSON.stringify({ originalRevision, badRevision, mismatchRevision, goodRevision, observations, errors, unexpectedRequests }, null, 2),
      contentType: 'application/json',
    });
  }
});
