import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const APP = 'https://127.0.0.1:4174/Feed-the-music-loop/';

async function cachedURLs(page) {
  return page.evaluate(async () => {
    const entries = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith('fml-shell-')) continue;
      for (const request of await (await caches.open(name)).keys()) entries.push(request.url);
    }
    return entries.sort();
  });
}

test('packaged HTTPS app reopens offline with its saved audio and only caches the app shell', async ({ page, context }, testInfo) => {
  const errors = [];
  const externalRequests = [];
  context.on('page', opened => opened.on('pageerror', error => errors.push(error.message)));
  page.on('pageerror', error => errors.push(error.message));
  context.on('request', request => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== new URL(APP).origin || !['GET', 'HEAD'].includes(request.method()))) externalRequests.push(`${request.method()} ${request.url()}`);
  });
  await page.goto(APP);
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  expect(await page.evaluate(() => isSecureContext)).toBe(true);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) throw new Error('The app shell service worker did not activate.');
  });
  const shellBefore = await cachedURLs(page);
  expect(shellBefore.length).toBeGreaterThan(10);
  expect(shellBefore).toContain(`${APP}index.html`);
  expect(shellBefore).toContain(`${APP}src/audio/loop-worklet.mjs`);
  const installedIcons = await page.evaluate(async () => {
    const manifestURL = document.querySelector('link[rel="manifest"]').href;
    const manifest = await (await fetch(manifestURL)).json();
    return {
      icons: manifest.icons.map(icon => ({ ...icon, url: new URL(icon.src, manifestURL).href })),
      apple: document.querySelector('link[rel="apple-touch-icon"]').href,
    };
  });
  for (const size of ['192x192', '512x512']) {
    const icon = installedIcons.icons.find(icon => icon.type === 'image/png' && icon.sizes === size && icon.purpose === 'any');
    expect(icon).toBeDefined();
    expect(shellBefore).toContain(icon.url);
  }
  expect(shellBefore).toContain(installedIcons.apple);
  expect(installedIcons.apple).toMatch(/\.png$/);

  // First activation intentionally does not claim an already running studio.
  // A fresh navigation takes control without replacing its current audio graph.
  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await page.getByTestId('add-loop').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
  await page.waitForTimeout(1300);
  await page.getByTestId('finish').click();
  await expect(page.locator('.loop-card')).toHaveCount(1);
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
  await page.getByTestId('stop').click();
  await page.getByTestId('enable-mic').click();
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');
  expect(await cachedURLs(page)).toEqual(shellBefore);

  await context.setOffline(true);
  const reopened = await context.newPage();
  await page.close();
  await reopened.goto(APP);
  await expect(reopened.getByTestId('add-loop')).toBeEnabled();
  await expect(reopened.locator('.loop-card')).toHaveCount(1);
  expect(await reopened.evaluate(() => navigator.onLine)).toBe(false);
  await expect.poll(() => reopened.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await reopened.getByTestId('play').click();
  await expect(reopened.locator('#app')).toHaveAttribute('data-playing', 'true');
  await expect.poll(() => reopened.locator('[data-ref="output-db"]').textContent()).not.toBe('−∞');
  await reopened.getByTestId('stop').click();
  await reopened.locator('[data-action="view"][data-view="mix"]').click();
  const downloadEvent = reopened.waitForEvent('download');
  await reopened.locator('[data-action="export-track"]:visible').click();
  const exported = await downloadEvent;
  expect(await exported.failure()).toBeNull();
  const bytes = await readFile(await exported.path());
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  expect(bytes.length).toBeGreaterThan(48_000);

  const shellAfter = await cachedURLs(reopened);
  expect(shellAfter).toEqual(shellBefore);
  expect(shellAfter.every(url => /(?:\.(?:html|css|svg|png|mjs|webmanifest)|\/\.nojekyll)$/.test(url))).toBe(true);
  expect(shellAfter.some(url => /(?:\.(?:wav|pcm|fml)|^blob:)/.test(url))).toBe(false);
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
  await testInfo.attach('offline-observations', { body: JSON.stringify({ errors, externalRequests, cachedURLs: shellAfter }, null, 2), contentType: 'application/json' });
  const screenshot = testInfo.outputPath('review-offline-studio.png');
  await reopened.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('offline-studio', { path: screenshot, contentType: 'image/png' });
});
