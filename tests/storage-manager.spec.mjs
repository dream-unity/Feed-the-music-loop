import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const tracks = page => page.locator('.loop-card[data-track-id]');
const dialog = page => page.getByRole('dialog');
const fileRow = (page, key) => dialog(page).locator('.storage-file-row').filter({ has: page.locator(`[data-action="delete-storage-file"][data-file-key="${key}"]`) });
const allFileRows = page => dialog(page).locator('.storage-file-row');

async function openStorage(page) {
  if (!(await dialog(page).isVisible())) {
    await page.getByTestId('storage').click();
  } else if (await dialog(page).locator('#dialog-title').textContent() !== 'Storage') {
    await dialog(page).getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByTestId('storage').click();
  }
  await expect(dialog(page)).toHaveAccessibleName('Storage');
  await expect(dialog(page).locator('[data-storage-summary]')).toBeVisible();
}
async function closeStorage(page) {
  await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
}
async function deleteFile(page, key) {
  await fileRow(page, key).locator('[data-action="delete-storage-file"]').click();
  await expect(dialog(page)).toContainText('This cannot be undone');
  await dialog(page).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName('Storage');
  await expect(fileRow(page, key)).toHaveCount(0);
}
async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`review-${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
async function inventory(page) {
  return page.evaluate(async () => {
    const path = './src/storage/client.mjs';
    const { StorageClient } = await import(path), storage = new StorageClient();
    try { await storage.init(); return await storage.getStorageInventory(); }
    finally { await storage.dispose(); }
  });
}
async function nativeSnapshot(page) {
  return page.evaluate(async () => {
    const path = './src/project.mjs', { referencedAssets } = await import(path);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('feed-the-music-loop-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const data = await new Promise((resolve, reject) => {
        const tx = db.transaction(['assets', 'pages', 'projects'], 'readonly');
        const assets = tx.objectStore('assets').getAll(), pages = tx.objectStore('pages').getAll(), projects = tx.objectStore('projects').getAll();
        tx.oncomplete = () => resolve({
          assets: assets.result,
          pages: pages.result.map(({ buffer, ...page }) => ({ ...page, payloadBytes: buffer?.byteLength || 0 })),
          projects: projects.result.map(project => ({ id: project.id, name: project.name, tracks: project.tracks, references: referencedAssets(project) })),
        });
        tx.onabort = () => reject(tx.error);
      });
      const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('feed-the-music-loop-v1');
      data.opfs = {};
      for await (const [name, handle] of directory.entries()) if (handle.kind === 'file') data.opfs[name] = (await handle.getFile()).size;
      return data;
    } finally { db.close(); }
  });
}

async function seedFiles(page, context) {
  await context.route('**/__ci-storage-fixtures.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixtures</title>' }));
  await page.goto('./__ci-storage-fixtures.html');
  return page.evaluate(async () => {
    const storagePath = './src/storage/client.mjs', projectPath = './src/project.mjs';
    const { StorageClient } = await import(storagePath), { createProject, createTrack } = await import(projectPath);
    const writer = new StorageClient(), current = createProject('Current file manager song'), neighbor = createProject('Another saved song');
    const pcm = frames => Float32Array.from({ length: frames }, (_, frame) => .2 * Math.sin(2 * Math.PI * 300 * frame / 48000));
    const add = async (project, name, frames, attach = true) => {
      const id = `storage_fixture_${crypto.randomUUID()}`;
      await writer.beginAsset({ id, projectId: project.id, sampleRate: 48000, channels: 1, kind: 'loop', name });
      await writer.putPage(id, 0, pcm(frames).buffer, frames, 1);
      await writer.finishAsset(id, { frames });
      if (attach) project.tracks.push(createTrack({ assetId: id, name, frames }));
      return { id, name, bytes: frames * 4, frames, key: `asset:${id}` };
    };
    let main, survivor, retained, other;
    try {
      await writer.init(); await writer.saveProject(current); await writer.saveProject(neighbor);
      main = await add(current, 'Delete this loop', 4096);
      survivor = await add(current, 'Keep this loop', 4096);
      retained = await add(current, 'Unattached retained recording', 111, false);
      other = await add(neighbor, 'Other project loop', 2048);
      current.baseFrames = 4096; neighbor.baseFrames = 2048;
      await writer.saveProject(current); await writer.saveProject(neighbor);
    } finally { await writer.dispose(); }
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle('feed-the-music-loop-v1');
    const orphanName = `unindexed_${crypto.randomUUID()}.pcm`, orphanBytes = 37;
    const handle = await directory.getFileHandle(orphanName, { create: true }), stream = await handle.createWritable();
    await stream.write(new Uint8Array(orphanBytes).fill(7)); await stream.close();
    const orphanPageId = `unindexed_pages_${crypto.randomUUID()}`, orphanPageBytes = 17 * 4;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('feed-the-music-loop-v1', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('pages', 'readwrite');
        tx.objectStore('pages').put({ assetId: orphanPageId, index: 0, frames: 17, channels: 1, buffer: pcm(17).buffer });
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
    const ownCache = `fml-shell-${encodeURIComponent(new URL('./', location.href).pathname)}-ci-file-manager`;
    const ownPath = './__ci-offline-file.txt', otherPath = './__ci-other-cache.txt';
    const ownUrl = new URL(ownPath, location.href).href;
    const foreignUrl = new URL('/different-app/private.txt', location.href).href;
    const cache = await caches.open(ownCache);
    await cache.put(ownUrl, new Response('a'.repeat(101)));
    await cache.put(foreignUrl, new Response('b'.repeat(207)));
    const otherCache = 'different-app-ci-recordings';
    await (await caches.open(otherCache)).put(new URL(otherPath, location.href).href, new Response('c'.repeat(301)));
    localStorage.setItem('fml:last-project', current.id);
    return { currentId: current.id, neighborId: neighbor.id, main, survivor, retained, other,
      orphan: { key: `orphan-opfs:${orphanName}`, name: orphanName, bytes: orphanBytes },
      orphanPages: { key: `orphan-pages:${orphanPageId}`, id: orphanPageId, bytes: orphanPageBytes },
      cache: { key: `cache:${ownCache}:${ownUrl}`, ownCache, ownUrl, foreignUrl, otherCache, bytes: 101 },
      expectedAudioBytes: main.bytes + survivor.bytes + retained.bytes + other.bytes + orphanBytes + orphanPageBytes,
    };
  });
}

// Only the optional browser quota API is replaced. Storage, project writes,
// OPFS, audio capture and the production worker remain native implementations.
async function setCapacity(page, context, estimate) {
  const bootstrap = `
    const pending = [];
    const hold = event => { pending.push(event.data); event.stopImmediatePropagation(); };
    self.addEventListener('message', hold);
    Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => ${estimate === 'unavailable' ? "{ throw new Error('Estimate unavailable'); }" : `(${JSON.stringify(estimate)})`} });
    const production = './src/storage/worker.mjs';
    await import(new URL(production, self.location.href).href);
    self.removeEventListener('message', hold);
    for (const data of pending) self.onmessage({ data });
  `;
  await context.route('**/__ci-capacity-worker.mjs', route => route.fulfill({ contentType: 'application/javascript', body: bootstrap }));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const requested = new URL(url, location.href);
        const fixturePath = './__ci-capacity-worker.mjs';
        super(requested.pathname.endsWith('/src/storage/worker.mjs') ? new URL(fixturePath, location.href) : url, options);
      }
    };
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.runtimeErrors = [];
  page.on('pageerror', error => testInfo.runtimeErrors.push(error.message));
});
test.afterEach(async ({}, testInfo) => { expect(testInfo.runtimeErrors).toEqual([]); });

test('Storage inventories exact file sizes across projects and permanently deletes only the confirmed source', async ({ page, context }, testInfo) => {
  const fixture = await seedFiles(page, context);
  await page.goto('./');
  await expect(tracks(page)).toHaveCount(2);
  await expect(page.getByTestId('storage')).toHaveAccessibleName('Storage');
  await openStorage(page);
  for (const file of [fixture.main, fixture.survivor, fixture.retained, fixture.other, fixture.orphan, fixture.orphanPages, fixture.cache]) {
    await expect(fileRow(page, file.key)).toHaveAttribute('data-file-bytes', String(file.bytes));
  }
  await expect(fileRow(page, fixture.other.key)).toContainText('Another saved song');
  expect(await inventory(page).then(value => value.audioBytes)).toBe(fixture.expectedAudioBytes);
  await expect(allFileRows(page).filter({ hasText: 'private.txt' })).toHaveCount(0);
  await expect(allFileRows(page).filter({ hasText: '__ci-other-cache.txt' })).toHaveCount(0);
  await screenshot(page, testInfo, 'storage-files-desktop');
  await dialog(page).locator('[data-storage-filter]').selectOption('orphan');
  await expect(fileRow(page, fixture.main.key)).toBeHidden();
  await expect(fileRow(page, fixture.orphan.key)).toBeVisible();
  await dialog(page).locator('[data-storage-filter]').selectOption('all');
  await dialog(page).locator('[data-storage-search]').fill('Other project loop');
  await expect(fileRow(page, fixture.other.key)).toBeVisible();
  await expect(fileRow(page, fixture.main.key)).toBeHidden();
  await dialog(page).locator('[data-storage-search]').fill('');
  const event = page.waitForEvent('download');
  await fileRow(page, fixture.main.key).locator('[data-action="download-storage-file"]').click();
  const downloaded = await event;
  expect(await downloaded.failure()).toBeNull();
  const originalBytes = await readFile(await downloaded.path());
  expect(originalBytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(originalBytes.length).toBeGreaterThan(fixture.main.bytes);
  await expect(dialog(page)).toHaveAccessibleName('Storage');
  await fileRow(page, fixture.main.key).locator('[data-action="delete-storage-file"]').click();
  await expect(dialog(page)).toContainText('Current file manager song');
  await expect(dialog(page)).toContainText('16,384 bytes');
  await expect(dialog(page)).toContainText('1 loop');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(tracks(page)).toHaveCount(2);
  expect((await nativeSnapshot(page)).assets.some(asset => asset.id === fixture.main.id)).toBe(true);
  await openStorage(page);
  await deleteFile(page, fixture.main.key);
  const after = await nativeSnapshot(page), measured = await inventory(page);
  expect(after.assets.some(asset => asset.id === fixture.main.id)).toBe(false);
  expect(after.pages.some(value => value.assetId === fixture.main.id)).toBe(false);
  expect(after.opfs[`${fixture.main.id}.pcm`]).toBeUndefined();
  expect(after.projects.every(project => !project.references.includes(fixture.main.id))).toBe(true);
  expect(after.opfs[`${fixture.survivor.id}.pcm`]).toBe(fixture.survivor.bytes);
  expect(after.opfs[`${fixture.other.id}.pcm`]).toBe(fixture.other.bytes);
  expect(measured.audioBytes).toBe(fixture.expectedAudioBytes - fixture.main.bytes);
  await closeStorage(page);
  await expect(tracks(page)).toHaveCount(1);
  await expect(page.locator('[data-action="undo"]:visible')).toBeDisabled();
  await page.keyboard.press('Control+z');
  await expect(tracks(page)).toHaveCount(1);
  await page.reload();
  await expect(tracks(page)).toHaveCount(1);
  await expect(page.locator('.damaged-panel')).toBeHidden();
  await openStorage(page);
  await expect(fileRow(page, fixture.main.key)).toHaveCount(0);
  await closeStorage(page);
  for (const width of [360, 768]) {
    await page.setViewportSize({ width, height: 800 });
    const box = await page.getByTestId('storage').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeGreaterThanOrEqual(44); expect(box.y + box.height).toBeLessThanOrEqual(800);
    await openStorage(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    if (width === 360) await screenshot(page, testInfo, 'storage-files-phone');
    await closeStorage(page);
  }
  await testInfo.attach('permanent-file-deletion-evidence', { body: JSON.stringify({ beforeAudioBytes: fixture.expectedAudioBytes, afterAudioBytes: measured.audioBytes, deletedBytes: fixture.main.bytes, survivingFileBytes: fixture.survivor.bytes, otherProjectFileBytes: fixture.other.bytes, remainingFiles: measured.files.map(({ key, bytes }) => ({ key, bytes })) }, null, 2), contentType: 'application/json' });
});

test('permanently deleting a stereo performance clears its active preview and saved card while keeping its source loops', async ({ page, context }, testInfo) => {
  const fixture = await seedFiles(page, context);
  await page.goto('./');
  await expect(tracks(page)).toHaveCount(2);
  await page.getByTestId('record-all-loops').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
  await page.waitForTimeout(600);
  await page.getByTestId('finish').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
  const recent = page.locator('[data-ref="recent-recording"]');
  await expect(recent).toContainText('Loop recording 1');
  await openStorage(page);
  const stored = await inventory(page), performance = stored.files.find(file => file.name === 'Loop recording 1');
  expect(performance.channels).toBe(2);
  expect(performance.bytes).toBeGreaterThan(1000);
  const downloadEvent = page.waitForEvent('download');
  await fileRow(page, performance.key).locator('[data-action="download-storage-file"]').click();
  const download = await downloadEvent;
  expect(await download.failure()).toBeNull();
  expect((await readFile(await download.path())).subarray(0, 4).toString()).toBe('RIFF');
  // Export closes a preview, so start listening after downloading. Permanent
  // deletion must retire the loaded media and its object URL itself.
  await closeStorage(page);
  await recent.getByRole('button', { name: 'Listen to Loop recording 1', exact: true }).click();
  await expect(page.locator('#performance-player')).toBeVisible();
  await expect.poll(() => page.locator('#performance-player').evaluate(player => player.currentTime)).toBeGreaterThan(.1);
  await openStorage(page);
  await fileRow(page, performance.key).locator('[data-action="delete-storage-file"]').click();
  await expect(dialog(page)).toContainText('1 performance');
  await dialog(page).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog(page)).toHaveAccessibleName('Storage');
  await expect(fileRow(page, performance.key)).toHaveCount(0);
  expect((await inventory(page)).audioBytes).toBe(stored.audioBytes - performance.bytes);
  const after = await nativeSnapshot(page);
  expect(after.assets.some(asset => asset.id === performance.id)).toBe(false);
  expect(after.opfs[`${performance.id}.pcm`]).toBeUndefined();
  expect(after.projects.find(project => project.id === fixture.currentId).references).not.toContain(performance.id);
  for (const source of [fixture.main, fixture.survivor, fixture.retained, fixture.other]) {
    expect(after.opfs[`${source.id}.pcm`]).toBe(source.bytes);
  }
  await closeStorage(page);
  await expect(page.locator('#performance-player')).toBeHidden();
  await expect(recent).not.toContainText('Loop recording 1');
  await expect(tracks(page)).toHaveCount(2);
  await expect(page.locator('[data-action="undo"]:visible')).toBeDisabled();
  await page.reload();
  await expect(tracks(page)).toHaveCount(2);
  await page.locator('[data-action="view"][data-view="song"]').click();
  await expect(page.locator('.performance-card')).toHaveCount(0);
  await expect(page.locator('.damaged-panel')).toBeHidden();
  await page.getByTestId('play').click();
  await expect(page.locator('#app')).toHaveAttribute('data-playing', 'true');
  await page.getByTestId('stop').click();
  await testInfo.attach('permanent-stereo-deletion-evidence', { body: JSON.stringify({ removedStereoBytes: performance.bytes, survivingLoopBytes: fixture.main.bytes + fixture.survivor.bytes, previewCleared: true, reloadedSongHasNoPerformance: true }), contentType: 'application/json' });
});

test('Storage deletes unindexed OPFS, IndexedDB pages and an offline file while preserving other apps and active project locks', async ({ page, context }, testInfo) => {
  const fixture = await seedFiles(page, context);
  await page.goto('./');
  await expect(tracks(page)).toHaveCount(2);
  await openStorage(page);
  await deleteFile(page, fixture.orphan.key);
  await deleteFile(page, fixture.orphanPages.key);
  await deleteFile(page, fixture.cache.key);
  let snapshot = await nativeSnapshot(page);
  expect(snapshot.opfs[fixture.orphan.name]).toBeUndefined();
  expect(snapshot.pages.some(value => value.assetId === fixture.orphanPages.id)).toBe(false);
  const cacheCheck = await page.evaluate(async fixture => ({
    ownRemoved: !(await (await caches.open(fixture.ownCache)).match(fixture.ownUrl)),
    foreignBytes: (await (await (await caches.open(fixture.ownCache)).match(fixture.foreignUrl)).blob()).size,
    otherCacheExists: (await caches.keys()).includes(fixture.otherCache),
  }), fixture.cache);
  expect(cacheCheck).toEqual({ ownRemoved: true, foreignBytes: 207, otherCacheExists: true });
  expect((await inventory(page)).audioBytes).toBe(fixture.expectedAudioBytes - fixture.orphan.bytes - fixture.orphanPages.bytes);
  await closeStorage(page);

  // A separate actual browser tab holds the other project's writer lock. The
  // delete attempt must fail without removing its audio or saved references.
  const otherPage = await context.newPage();
  await otherPage.goto('./');
  await expect(otherPage.getByTestId('storage')).toBeVisible();
  await otherPage.locator('[data-action="projects"]').click();
  await otherPage.locator(`.project-row[data-id="${fixture.neighborId}"]`).click();
  await expect(otherPage.locator('[data-ref="project-name"]')).toHaveText('Another saved song');
  await expect(tracks(otherPage)).toHaveCount(1);
  await openStorage(page);
  await fileRow(page, fixture.other.key).locator('[data-action="delete-storage-file"]').click();
  await dialog(page).getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByText(/already open for editing in another tab/).first()).toBeVisible();
  await expect(dialog(page)).toHaveAccessibleName('Storage');
  await expect(fileRow(page, fixture.other.key)).toHaveAttribute('data-file-bytes', String(fixture.other.bytes));
  snapshot = await nativeSnapshot(page);
  expect(snapshot.projects.find(project => project.id === fixture.neighborId).references).toContain(fixture.other.id);
  expect(snapshot.opfs[`${fixture.other.id}.pcm`]).toBe(fixture.other.bytes);
  await otherPage.close();
  await deleteFile(page, fixture.other.key);
  snapshot = await nativeSnapshot(page);
  expect(snapshot.projects.find(project => project.id === fixture.neighborId).references).not.toContain(fixture.other.id);
  expect(snapshot.opfs[`${fixture.other.id}.pcm`]).toBeUndefined();
  expect(snapshot.opfs[`${fixture.survivor.id}.pcm`]).toBe(fixture.survivor.bytes);
  await testInfo.attach('orphan-cache-and-lock-deletion-evidence', { body: JSON.stringify({ cacheCheck, project: snapshot.projects.find(project => project.id === fixture.neighborId), finalAudioBytes: (await inventory(page)).audioBytes }, null, 2), contentType: 'application/json' });
});

for (const scenario of [
  { name: 'high used percentage with five GiB left', estimate: { usage: 995 * 1024 ** 3, quota: 1000 * 1024 ** 3 }, remaining: 5 * 1024 ** 3, low: false },
  { name: 'unavailable browser estimate', estimate: 'unavailable', remaining: null, low: false },
  { name: 'low absolute estimate with native writes still available', estimate: { usage: 2 * 1024 ** 3 - 1024 ** 2, quota: 2 * 1024 ** 3 }, remaining: 1024 ** 2, low: true },
]) test(`Storage distinguishes ${scenario.name} and does not invent a recording limit`, async ({ page, context }, testInfo) => {
  await setCapacity(page, context, scenario.estimate);
  await page.goto('./');
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await openStorage(page);
  const remaining = page.getByTestId('storage-remaining');
  if (scenario.remaining === null) {
    await expect(remaining).toContainText(/unavailable|unknown|not available/i);
    await expect(remaining).toHaveAttribute('data-bytes', 'unknown');
  } else {
    await expect(remaining).toHaveAttribute('data-bytes', String(scenario.remaining));
    await expect(dialog(page).locator('[data-storage-summary]')).toContainText(scenario.remaining.toLocaleString('en-US'));
    await expect(dialog(page).locator('[data-storage-summary]')).toContainText(/estimate/i);
  }
  if (scenario.low) await expect(dialog(page).locator('.storage-advisory')).toBeVisible();
  else await expect(dialog(page).locator('.storage-advisory')).toHaveCount(0);
  await closeStorage(page);
  if (!scenario.low) await expect(page.getByText(/very little recording space|very little.*space|storage is nearly full/i)).toHaveCount(0);
  await page.getByTestId('add-loop').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
  await page.waitForTimeout(500);
  await page.getByTestId('finish').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
  await expect(tracks(page)).toHaveCount(1);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await page.getByTestId('stop').click();
  await page.reload();
  await expect(tracks(page)).toHaveCount(1);
  await testInfo.attach('quota-estimate-recording-evidence', { body: JSON.stringify({ estimate: scenario.estimate, recordingSurvivedReload: true }), contentType: 'application/json' });
});
