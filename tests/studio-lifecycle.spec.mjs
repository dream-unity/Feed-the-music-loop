import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// GitHub Actions only. These flows exercise the visible studio against real
// Chromium audio/storage APIs and the deterministic fake microphone in config.
const action = (page, name) => page.locator(`[data-action="${name}"]:visible`).first();
const tracks = page => page.locator('.loop-card[data-track-id]');
const captureState = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-capture-state', value);
const playing = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-playing', String(value));

async function boot(page) {
  await page.goto('./');
  await expect(page.getByTestId('add-loop')).toBeEnabled();
}

async function firstLoop(page) {
  await page.getByTestId('add-loop').click();
  await captureState(page, 'recording');
  // Real microphone capture needs elapsed audio time.
  await page.waitForTimeout(1100);
  await page.getByTestId('finish').click();
  await captureState(page, 'idle');
  await expect(tracks(page)).toHaveCount(1);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
}

async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`review-${name}.png`);
  // Native dialogs and their backdrops are viewport overlays. Capturing the
  // entire scrolled document would stitch the fixed overlay into the page.
  const fullPage = !await page.getByRole('dialog').isVisible();
  await page.screenshot({ path, fullPage, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.runtimeErrors = [];
  page.on('pageerror', error => testInfo.runtimeErrors.push(error.message));
});

test.afterEach(async ({}, testInfo) => {
  await testInfo.attach('lifecycle-runtime-errors', { body: JSON.stringify(testInfo.runtimeErrors), contentType: 'application/json' });
  expect(testInfo.runtimeErrors).toEqual([]);
});

test('performance trash removes only the chosen card, supports Undo and persists with the vocal arrangement intact', async ({ page }, testInfo) => {
  await boot(page);
  await firstLoop(page);
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('sing').click();
    await captureState(page, 'recording');
    await page.waitForTimeout(600);
    await page.getByTestId('finish').click();
    await captureState(page, 'idle');
  }
  await page.getByTestId('stop').click();
  await page.locator('[data-action="view"][data-view="song"]').click();
  const cards = page.locator('.performance-card');
  const takes = page.locator('.take-card');
  await expect(cards).toHaveCount(2);
  await expect(takes).toHaveCount(2);
  const chosen = cards.first();
  const performanceId = await chosen.getAttribute('data-performance-id');
  const performanceName = await chosen.locator('h3').textContent();
  const removedCard = page.locator(`.performance-card[data-performance-id="${performanceId}"]`);
  const remove = removedCard.getByRole('button', { name: `Remove ${performanceName}`, exact: true });
  const dialog = page.getByRole('dialog');
  await remove.click();
  await expect(dialog).toHaveAccessibleName('Remove performance?');
  await expect(dialog).toContainText('does not free device storage');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cards).toHaveCount(2);

  await chosen.locator('[data-action="preview-performance"]').click();
  await expect(page.locator('#performance-player')).toBeVisible();
  await remove.click();
  await dialog.getByRole('button', { name: 'Remove performance', exact: true }).click();
  await expect(removedCard).toHaveCount(0);
  await expect(cards).toHaveCount(1);
  await expect(page.locator('[data-ref="performance-count"]')).toHaveText('1 recording');
  await expect(page.locator('#performance-player')).toBeHidden();
  await expect(page.locator('#performance-player')).not.toHaveAttribute('src');
  await expect(takes).toHaveCount(2);
  await action(page, 'export-menu').click();
  await expect(dialog.locator(`[data-action="export-master"][data-performance-id="${performanceId}"]`)).toHaveCount(0);
  await expect(dialog.locator('[data-action="export-master"]')).toHaveCount(1);
  await expect(dialog.locator('[data-action="export-mix"]')).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await action(page, 'undo').click();
  await expect(cards).toHaveCount(2);
  await action(page, 'redo').click();
  await expect(cards).toHaveCount(1);
  await action(page, 'undo').click();

  // The same accessible trash control must remain reachable on a small phone.
  await page.setViewportSize({ width: 360, height: 800 });
  await remove.scrollIntoViewIfNeeded();
  await expect(remove).toBeVisible();
  const bounds = await remove.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  await screenshot(page, testInfo, 'performance-trash-phone');
  await remove.click();
  await dialog.getByRole('button', { name: 'Remove performance', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(tracks(page)).toHaveCount(1);
  await page.locator('[data-action="view"][data-view="song"]').click();
  await expect(cards).toHaveCount(1);
  await expect(removedCard).toHaveCount(0);
  await expect(takes).toHaveCount(2);
  await expect(page.locator('.recovery-card')).toHaveCount(0);

  const downloadEvent = page.waitForEvent('download');
  await action(page, 'export-project').click();
  const backup = await downloadEvent;
  const bytes = await readFile(await backup.path());
  const size = Number(bytes.readBigUInt64LE(16));
  const manifest = JSON.parse(bytes.subarray(64, 64 + size).toString());
  const performance = manifest.project.performances.find(item => item.id === performanceId);
  expect(performance.removed).toBe(true);
  expect(manifest.project.takes.some(take => take.performanceId === performanceId)).toBe(true);
  expect(performance.initialState.tracks).toHaveLength(1);
  expect(manifest.assets.some(asset => asset.id === performance.masterAssetId)).toBe(true);
  expect(manifest.assets.some(asset => asset.id === performance.leadAssetId)).toBe(true);
});

test('recorder remains below The Groove when empty, cancelled, switched between views and reopened', async ({ page }, testInfo) => {
  await boot(page);
  const panel = page.locator('[data-ref="capture-panel"]');
  const recent = page.locator('[data-ref="recent-recording"]');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-status', 'idle');
  await expect(panel).toContainText('Your recorder is ready');
  expect(await page.locator('.transport-panel').evaluate(element => element.nextElementSibling.dataset.ref)).toBe('capture-panel');
  for (const view of ['song', 'mix', 'build']) {
    await page.locator(`[data-action="view"][data-view="${view}"]`).click();
    await expect(panel).toBeVisible();
  }
  await page.getByTestId('add-loop').click();
  await captureState(page, 'recording');
  await page.getByTestId('cancel').click();
  await captureState(page, 'idle');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Your recorder is ready');
  await expect(recent).toBeHidden();

  await firstLoop(page);
  await page.getByTestId('sing').click();
  await captureState(page, 'recording');
  await page.waitForTimeout(500);
  await page.getByTestId('finish').click();
  await captureState(page, 'idle');
  await expect(recent).toContainText('Performance 1');
  await page.getByTestId('stop').click();
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(panel).toBeVisible();
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('Performance 1');
  expect(await panel.evaluate(element => element.nextElementSibling.dataset.ref)).toBe('recent-recording');
  await recent.getByRole('button', { name: 'Listen to Performance 1', exact: true }).click();
  await expect(page.locator('#performance-player')).toBeVisible();
  await expect(page.locator('[data-view-panel="build"]')).toBeVisible();
  await screenshot(page, testInfo, 'persistent-recorder-after-reopen');
  await recent.getByRole('button', { name: 'Remove Performance 1', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove performance', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Your recorder is ready');
});
 
test('live microphone history follows input and finished recordings stay beneath the capture bar in Build', async ({ page }, testInfo) => {
  await boot(page);
  await firstLoop(page);
  const recent = page.locator('[data-ref="recent-recording"]');
  const panel = page.locator('[data-ref="capture-panel"]');
  await expect(panel).toHaveAttribute('data-status', 'saved');
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('Original loop');
  await recent.getByRole('button', { name: /^Listen to / }).click();
  await expect(page.locator('#performance-player')).toBeVisible();
  await page.getByTestId('stop').click();

  await page.getByTestId('sing').click();
  await captureState(page, 'recording');
  const waveform = page.locator('[data-ref="capture-waveform"]');
  const peak = waveform.locator('.live-input-peak');
  await expect(waveform).toBeVisible();
  await expect.poll(async () => Number(await waveform.getAttribute('data-samples'))).toBeGreaterThan(8);
  const initialPath = await peak.getAttribute('d');
  const heights = [...initialPath.matchAll(/,([\d.]+)V([\d.]+)/g)].map(match => Number(match[2]) - Number(match[1]));
  expect(Math.max(...heights)).toBeGreaterThan(2);
  expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(1);
  await expect(peak).not.toHaveAttribute('d', initialPath);
  await screenshot(page, testInfo, 'live-microphone');

  // Zero mic gain must become silent even while the backing loops are audible.
  const gain = page.locator('input[data-control="input"][data-key="gain"]');
  await gain.evaluate(input => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('[data-ref="capture-level"]')).toHaveText('−∞ dB');
  await expect(peak).toHaveAttribute('d', /,36\.00V36\.00$/);
  await gain.evaluate(input => { input.value = '1'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(page.locator('[data-ref="capture-level"]')).not.toHaveText('−∞ dB');
  await page.getByTestId('finish').click();
  await captureState(page, 'idle');
  await expect(page.locator('[data-view-panel="build"]')).toBeVisible();
  await expect(panel).toHaveAttribute('data-status', 'saved');
  await expect(page.locator('[data-ref="capture-title"]')).toHaveText('Performance recorded');
  await expect(recent).toBeVisible();
  await expect(recent).toContainText('Performance 1');
  await expect(recent).toContainText('Voice + backing');
  expect(await panel.evaluate(element => element.nextElementSibling.dataset.ref)).toBe('recent-recording');
  const frozenPath = await peak.getAttribute('d');
  await page.waitForTimeout(200);
  await expect(peak).toHaveAttribute('d', frozenPath);
  await playing(page, true);
  await expect(page.locator('[data-ref="dock-label"]')).toHaveText('Your world is playing.');
  await expect(page.locator('#performance-player')).toBeHidden();
  await screenshot(page, testInfo, 'finished-performance-build');
  await recent.getByRole('button', { name: 'Listen to Performance 1', exact: true }).click();
  await expect(page.locator('#performance-player')).toBeVisible();
  await expect(page.locator('[data-ref="preview-name"]')).toHaveText('Performance 1');
  await expect(page.locator('[data-view-panel="build"]')).toBeVisible();
  await playing(page, false);

  await page.setViewportSize({ width: 360, height: 800 });
  await recent.scrollIntoViewIfNeeded();
  const listen = recent.getByRole('button', { name: 'Listen to Performance 1', exact: true });
  const bounds = await listen.boundingBox();
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  await screenshot(page, testInfo, 'finished-performance-phone');
});

test('project dialogs cancel empty names safely and create a distinct saved project', async ({ page }) => {
  await boot(page);
  const originalName = await page.locator('[data-ref="project-name"]').textContent();
  const dialog = page.getByRole('dialog');
  await action(page, 'projects').click();
  const originalId = await dialog.locator('.project-row.is-current').getAttribute('data-id');
  await dialog.getByRole('button', { name: 'New project', exact: true }).click();
  await expect(dialog).toHaveAccessibleName('A new beginning');
  await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-ref="project-name"]')).toHaveText(originalName);

  await action(page, 'projects').click();
  await expect(dialog.locator('.project-row')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'New project', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-ref="project-name"]')).toHaveText(originalName);

  await action(page, 'projects').click();
  await expect(dialog.locator('.project-row')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'New project', exact: true }).click();
  const name = 'Late-night harmonies';
  await dialog.getByRole('textbox', { name: 'Project name', exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-ref="project-name"]')).toHaveText(name);
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await action(page, 'projects').click();
  await expect(dialog.locator('.project-row')).toHaveCount(2);
  await expect(dialog.locator('.project-row.is-current')).not.toHaveAttribute('data-id', originalId);
  await expect(dialog.locator(`[data-action="open-project"][data-id="${originalId}"]`)).toContainText(originalName);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await action(page, 'rename-project').click();
  const renamed = 'Late-night harmonies · session two';
  const nameInput = dialog.getByRole('textbox', { name: 'Project name', exact: true });
  await nameInput.fill(renamed);
  await nameInput.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-ref="project-name"]')).toHaveText(renamed);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(page.locator('[data-ref="project-name"]')).toHaveText(renamed);
});

test('a first-loop count-in cancels safely, preserves chosen focus, and Enter saves after recording starts', async ({ page }, testInfo) => {
  await boot(page);
  await page.getByTestId('enable-mic').click();
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Disconnect microphone');
  await page.locator('.advanced-settings > summary').click();
  const tempo = page.getByRole('spinbutton', { name: 'Metronome tempo in beats per minute' });
  await tempo.fill('120');
  await tempo.press('Tab');
  await page.locator('[data-control="metronome-count"]').selectOption('4');
  await expect(tempo).toHaveValue('120');

  await page.getByTestId('add-loop').click();
  await captureState(page, 'counting');
  await expect(page.getByTestId('finish')).toBeHidden();
  await expect(page.getByTestId('stop')).toBeVisible();
  await expect(page.getByTestId('stop')).toBeEnabled();
  await page.getByTestId('stop').click();
  await captureState(page, 'idle');
  await playing(page, false);
  // Four beats at 120 BPM take two seconds. Wait past the abandoned boundary to
  // prove Stop cancelled the scheduled start, rather than merely hiding it.
  await page.waitForTimeout(2400);
  await captureState(page, 'idle');
  await expect(tracks(page)).toHaveCount(0);
  await expect(page.getByTestId('add-loop')).toBeEnabled();

  // Returning to Cancel deliberately must preserve that choice when recording
  // starts; automatic focus repair must not override keyboard navigation.
  await page.getByTestId('add-loop').click();
  await captureState(page, 'counting');
  await expect(page.getByTestId('cancel')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('stop')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('cancel')).toBeFocused();
  await captureState(page, 'recording');
  await expect(page.getByTestId('cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await captureState(page, 'idle');
  await expect(tracks(page)).toHaveCount(0);

  // With no intervening navigation, focus initially redirected to Cancel must
  // move to Finish as soon as recording begins. Enter must keep the recording.
  await page.getByTestId('add-loop').click();
  await captureState(page, 'counting');
  await expect(page.getByTestId('cancel')).toBeFocused();
  await captureState(page, 'recording');
  await expect(page.getByTestId('finish')).toBeVisible();
  await expect(page.getByTestId('finish')).toBeFocused();
  await page.waitForTimeout(1100);
  await page.keyboard.press('Enter');
  await captureState(page, 'idle');
  await expect(tracks(page)).toHaveCount(1);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await playing(page, true);
  await screenshot(page, testInfo, 'count-in-recording-saved');

  await page.getByTestId('stop').click();
  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(tracks(page)).toHaveCount(1);
});

test('a truncated saved source preserves song timing and offers only its verified incomplete prefix', async ({ page, context }, testInfo) => {
  await boot(page);
  await page.getByTestId('demo').click();
  await expect(tracks(page)).toHaveCount(3);
  await playing(page, true);
  await page.getByTestId('sing').click();
  await captureState(page, 'recording');
  await page.waitForTimeout(1100);
  await page.getByTestId('finish').click();
  await captureState(page, 'idle');
  await page.getByTestId('stop').click();
  await playing(page, false);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);

  const readSaved = () => page.evaluate(async () => {
    const modulePath = './src/storage/client.mjs';
    const { StorageClient } = await import(modulePath);
    const storage = new StorageClient();
    try {
      const { backend } = await storage.init();
      const project = await storage.loadProject(localStorage.getItem('fml:last-project'));
      return { backend, project, assets: await storage.listAssets(project.id) };
    } finally { await storage.dispose(); }
  });
  const before = await readSaved();
  expect(before.backend).toBe('opfs');
  const damagedTrack = before.project.tracks[0];
  expect(damagedTrack.frames).toBeGreaterThan(2 * 16_384);
  const performance = before.project.performances[0];
  expect(performance.frames).toBeGreaterThan(0);
  const getDownload = async click => {
    const event = page.waitForEvent('download');
    await click();
    const file = await event;
    expect(await file.failure()).toBeNull();
    return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
  };
  await page.locator('[data-action="view"][data-view="song"]').click();
  const masterButton = () => page.locator(`.performance-card [data-action="export-master"][data-performance-id="${performance.id}"]`);
  const intactMaster = await getDownload(() => masterButton().click());
  expect(intactMaster.bytes.length).toBeGreaterThan(1000);

  // Leave the app so its real worker releases OPFS handles. The isolated same-
  // origin fixture changes one actual PCM file; no production fault switch or
  // recovery mock is used, and project/page metadata remains untouched.
  await context.route('**/__ci-storage-maintenance.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Isolated storage maintenance</title>' }));
  await page.goto('./__ci-storage-maintenance.html');
  await expect.poll(() => page.evaluate(async assetId => {
    try {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle('feed-the-music-loop-v1');
      const file = await directory.getFileHandle(`${assetId}.pcm`);
      const writer = await file.createWritable({ keepExistingData: true });
      try { await writer.truncate(16_384 * 4 + 13); } finally { await writer.close(); }
      return 'truncated';
    } catch (error) { return `${error.name}: ${error.message}`; }
  }, damagedTrack.assetId), { timeout: 10_000 }).toBe('truncated');
  const survivingPcm = Buffer.from(await page.evaluate(async assetId => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('feed-the-music-loop-v1');
    const file = await (await directory.getFileHandle(`${assetId}.pcm`)).getFile();
    return Array.from(new Uint8Array(await file.slice(0, 16_384 * 4).arrayBuffer()));
  }, damagedTrack.assetId));

  await page.goto('./');
  const panel = page.locator('.damaged-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Some source audio is incomplete.' })).toBeVisible();
  await expect(panel.locator('.damaged-card')).toHaveCount(1);
  await expect(panel).toContainText('Your song’s timing has been kept');
  await expect(panel).toContainText('This download is incomplete');
  await expect(tracks(page)).toHaveCount(3);
  for (const control of ['play', 'add-loop', 'sing']) await expect(page.getByTestId(control)).toBeDisabled();
  await expect(action(page, 'export-project')).toBeDisabled();
  await playing(page, false);

  const timing = p => ({
    baseFrames: p.baseFrames,
    tracks: p.tracks.map(t => ({ id: t.id, frames: t.frames, offsetFrames: t.offsetFrames })),
    takes: p.takes.map(t => ({ id: t.id, frames: t.frames, startFrame: t.startFrame })),
    performances: p.performances.map(t => ({ id: t.id, frames: t.frames, startFrame: t.startFrame, endFrame: t.endFrame })),
  });
  const after = await readSaved();
  expect(timing(after.project)).toEqual(timing(before.project));
  const recovered = after.assets.find(asset => asset.id === damagedTrack.assetId);
  expect(recovered.status).toBe('interrupted');
  expect(recovered.frames).toBe(16_384);
  expect(recovered.checkpointFrames).toBe(16_384);
  const incomplete = await getDownload(() => panel.locator(`[data-action="export-damaged-audio"][data-id="${damagedTrack.assetId}"]`).click());
  expect(incomplete.filename).toMatch(/-incomplete\.wav$/i);
  expect(incomplete.bytes.subarray(0, 4).toString()).toBe('RIFF');
  expect(incomplete.bytes.readUInt32LE(4) + 8).toBe(incomplete.bytes.length);
  let format, pcm;
  for (let offset = 12; offset + 8 <= incomplete.bytes.length;) {
    const name = incomplete.bytes.subarray(offset, offset + 4).toString();
    const length = incomplete.bytes.readUInt32LE(offset + 4);
    expect(offset + 8 + length).toBeLessThanOrEqual(incomplete.bytes.length);
    if (name === 'fmt ') format = { encoding: incomplete.bytes.readUInt16LE(offset + 8), channels: incomplete.bytes.readUInt16LE(offset + 10), sampleRate: incomplete.bytes.readUInt32LE(offset + 12), blockAlign: incomplete.bytes.readUInt16LE(offset + 20) };
    if (name === 'data') pcm = incomplete.bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  expect(format).toEqual({ encoding: 3, channels: 1, sampleRate: before.project.sampleRate, blockAlign: 4 });
  expect(pcm).toEqual(survivingPcm);
  expect(pcm.length / format.blockAlign).toBe(16_384);

  await page.locator(`.loop-card[data-track-id="${damagedTrack.id}"] .track-select`).click();
  await expect(action(page, 'export-track')).toBeDisabled();
  await action(page, 'export-menu').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('[data-action="export-project"]')).toBeDisabled();
  await expect(dialog.locator('[data-action="preview-mix"]')).toBeDisabled();
  await expect(dialog.locator('[data-action="export-mix"]')).toBeDisabled();
  await expect(dialog.locator(`[data-action="export-master"][data-performance-id="${performance.id}"]`)).toBeEnabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('[data-action="view"][data-view="song"]').click();
  await expect(masterButton()).toBeEnabled();
  const retainedMaster = await getDownload(() => masterButton().click());
  expect(retainedMaster.bytes).toEqual(intactMaster.bytes);
  await expect(panel).toBeVisible();
  await screenshot(page, testInfo, 'incomplete-source-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot(page, testInfo, 'incomplete-source-mobile');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await testInfo.attach('incomplete-source-recovery', { body: JSON.stringify({ assetId: damagedTrack.assetId, expectedFrames: damagedTrack.frames, recoveredFrames: recovered.frames, incompleteFilename: incomplete.filename, originalMasterUnchanged: true, projectTimingUnchanged: true }, null, 2), contentType: 'application/json' });
});

test('storage management preserves a cancelled deletion, then removes the confirmed project and opens a usable studio', async ({ page }, testInfo) => {
  await boot(page);
  await firstLoop(page);
  const originalTrackId = await tracks(page).first().getAttribute('data-track-id');
  await page.getByTestId('stop').click();
  await playing(page, false);

  // Keep a downloadable recovery copy before exercising permanent deletion.
  const downloading = page.waitForEvent('download');
  await action(page, 'export-project').click();
  const backup = await downloading;
  expect(await backup.failure()).toBeNull();
  expect(backup.suggestedFilename()).toMatch(/\.fml$/i);
  expect((await readFile(await backup.path())).length).toBeGreaterThan(1000);

  await action(page, 'manage-storage').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveAccessibleName('Make room for your next song');
  const currentProject = dialog.locator('.storage-project.is-current');
  await expect(currentProject).toContainText('Current project');
  await screenshot(page, testInfo, 'storage-manager');
  const originalProjectId = await currentProject.locator('[data-action="delete-project"]').getAttribute('data-id');
  await currentProject.locator('[data-action="delete-project"]').click();
  await expect(dialog).toContainText('permanently removes this project');
  await screenshot(page, testInfo, 'permanent-deletion-confirmation');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(tracks(page)).toHaveCount(1);
  await expect(tracks(page).first()).toHaveAttribute('data-track-id', originalTrackId);

  await action(page, 'manage-storage').click();
  await dialog.locator(`[data-action="delete-project"][data-id="${originalProjectId}"]`).click();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(tracks(page)).toHaveCount(0);
  await playing(page, false);
  await expect(page.getByTestId('enable-mic')).toHaveAccessibleName('Connect microphone');

  await action(page, 'manage-storage').click();
  await expect(dialog.locator(`[data-action="delete-project"][data-id="${originalProjectId}"]`)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('add-loop')).toBeEnabled();
  await expect(tracks(page)).toHaveCount(0);
  await action(page, 'manage-storage').click();
  await expect(dialog.locator(`[data-action="delete-project"][data-id="${originalProjectId}"]`)).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await firstLoop(page);
  await expect(tracks(page).first()).not.toHaveAttribute('data-track-id', originalTrackId);
  await screenshot(page, testInfo, 'new-project-after-permanent-deletion');
});
