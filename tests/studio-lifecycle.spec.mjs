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
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
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

test('a first-loop count-in can be stopped without a deferred recording, then retried and saved', async ({ page }, testInfo) => {
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

  await page.getByTestId('add-loop').click();
  await captureState(page, 'counting');
  await captureState(page, 'recording');
  await expect(page.getByTestId('finish')).toBeVisible();
  await page.waitForTimeout(1100);
  await page.getByTestId('finish').click();
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
