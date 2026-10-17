import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const RATE = 48000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const editor = page => page.getByTestId('track-editor');
const tracks = page => page.locator('.loop-card[data-track-id]');
const field = (page, name) => editor(page).getByRole('spinbutton', { name, exact: true });
const button = (page, name) => (['Undo', 'Redo', 'Done'].includes(name) ? page.getByRole('dialog', { name: 'Edit audio', exact: true }) : editor(page)).getByRole('button', { name, exact: true });
const pcm = (frames, channels) => Float32Array.from({ length: frames * channels }, (_, index) => {
  const frame = Math.floor(index / channels), channel = index % channels;
  return ((frame * (channel ? 3 : 1) + channel * 71) % 257 - 128) / 512;
});
const bytes = samples => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
const join = (...parts) => Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : bytes(part)));
const stereo = mono => {
  const input = new Float32Array(mono.buffer, mono.byteOffset, mono.byteLength / 4);
  return bytes(Float32Array.from({ length: input.length * 2 }, (_, i) => input[Math.floor(i / 2)]));
};

async function seed(page, context) {
  await context.route('**/__ci-editor-fixtures.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Audio editor fixtures</title>' }));
  await page.goto('./__ci-editor-fixtures.html');
  return page.evaluate(async () => {
    const storagePath = './src/storage/client.mjs', projectPath = './src/project.mjs';
    const { StorageClient } = await import(storagePath);
    const { createProject, createTrack, sectionFromProject, PAGE_FRAMES } = await import(projectPath);
    const storage = new StorageClient(), project = createProject('Exact audio edit fixture', 48000);
    const originals = [];
    try {
      await storage.init(); await storage.saveProject(project);
      for (const [index, channels] of [1, 2].entries()) {
        const id = `editor_source_${crypto.randomUUID()}`, name = index ? 'Stereo source' : 'Mono source', frames = 48000;
        await storage.beginAsset({ id, projectId: project.id, sampleRate: 48000, channels, kind: 'loop', name });
        for (let start = 0, pageIndex = 0; start < frames; start += PAGE_FRAMES, pageIndex++) {
          const count = Math.min(PAGE_FRAMES, frames - start);
          const samples = Float32Array.from({ length: count * channels }, (_, sample) => {
            const frame = start + Math.floor(sample / channels), channel = sample % channels;
            return ((frame * (channel ? 3 : 1) + channel * 71) % 257 - 128) / 512;
          });
          await storage.putPage(id, pageIndex, samples.buffer, count, channels);
        }
        await storage.finishAsset(id, { frames });
        const track = createTrack({ assetId: id, name, frames, channels, offsetFrames: index ? 0 : 36000, peaks: Array(64).fill(.25) });
        project.tracks.push(track); originals.push({ id, trackId: track.id, name, channels });
      }
      project.baseFrames = 48000;
      project.sections.push(sectionFromProject(project, 'Keep this arrangement'));
      await storage.saveProject(project);
      localStorage.setItem('fml:last-project', project.id);
      return { projectId: project.id, originals, section: project.sections[0] };
    } finally { await storage.dispose(); }
  });
}

async function snapshot(page, originalIds = []) {
  return page.evaluate(async ids => {
    const path = './src/storage/client.mjs', { StorageClient } = await import(path), storage = new StorageClient();
    const digest = async blob => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    try {
      await storage.init();
      const project = await storage.loadProject(localStorage.getItem('fml:last-project'));
      const audio = [];
      for (const track of project.tracks) audio.push({ ...track, hash: await digest(await storage.getAssetFile(track.assetId)) });
      const originals = {};
      for (const id of ids) originals[id] = await digest(await storage.getAssetFile(id));
      return { project, audio, originals };
    } finally { await storage.dispose(); }
  }, originalIds);
}

async function select(page, start, end) {
  // Fill the end first so growing a range cannot temporarily invert it.
  await field(page, 'Selection end in seconds').fill(String(end));
  await field(page, 'Selection end in seconds').press('Tab');
  await field(page, 'Selection start in seconds').fill(String(start));
  await field(page, 'Selection start in seconds').press('Tab');
}

async function cursor(page, at) {
  await field(page, 'Paste position in seconds').fill(String(at));
  await field(page, 'Paste position in seconds').press('Tab');
}

async function expectTrack(page, trackId, expected, channels, frames = expected.length / channels / 4) {
  await expect.poll(async () => {
    const state = await snapshot(page), track = state.audio.find(value => value.id === trackId);
    return { hash: track?.hash, channels: track?.channels, frames: track?.frames };
  }).toEqual({ hash: hash(expected), channels, frames });
  await expect(button(page, 'Copy selection')).toBeEnabled();
}

async function download(page, start) {
  const pending = page.waitForEvent('download'); await start();
  const file = await pending; expect(await file.failure()).toBeNull();
  return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

function backupAudio(backup, trackName) {
  expect(backup.subarray(0, 8).toString()).toBe('FMLPACK\n');
  const length = Number(backup.readBigUInt64LE(16)), manifest = JSON.parse(backup.subarray(64, 64 + length).toString());
  const track = manifest.project.tracks.find(value => value.name === trackName);
  const asset = manifest.assets.find(value => value.id === track.assetId);
  const data = backup.subarray(64 + length + asset.offset, 64 + length + asset.offset + asset.bytes);
  expect(hash(data)).toBe(asset.sha256);
  return { manifest, track, asset, data };
}

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.runtimeErrors = [];
  page.on('pageerror', error => testInfo.runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    window.__editorMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__editorMicRequests++; throw new DOMException('No microphone is needed for editing.', 'NotAllowedError'); };
  });
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => window.__editorMicRequests)).toBe(0);
});

test('portable editor selects exact PCM, trims, copies to itself and another track, extends, and preserves saved audio', async ({ page, context }, testInfo) => {
  const fixture = await seed(page, context), [monoSource, stereoSource] = fixture.originals;
  const originalMono = bytes(pcm(RATE, 1)), originalStereo = bytes(pcm(RATE, 2));
  await page.goto('./'); await expect(tracks(page)).toHaveCount(2);
  await tracks(page).first().getByRole('button', { name: 'Edit Mono source', exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await select(page, .25, .75);
  await button(page, 'Copy selection').click();
  await expect(editor(page).locator('[data-editor-ref="clipboard"]')).toContainText('Mono source · 0.5 s copied.');
  await button(page, 'Listen to selection').click();
  const preview = page.getByTestId('editor-preview');
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(audio => audio.duration)).toBeCloseTo(.5, 5);
  const selected = originalMono.subarray(RATE / 4 * 4, RATE * 3 / 4 * 4);
  await button(page, 'Trim to selection').click();
  await expectTrack(page, monoSource.trackId, selected, 1);
  let current = await snapshot(page);
  expect(current.project.baseFrames).toBe(RATE);
  expect(current.audio[0].offsetFrames).toBe(12000);
  expect(current.project.sections).toEqual([fixture.section]);

  // The clipboard remains the exact pre-edit range, including after its own
  // source track has been trimmed to a fresh immutable audio asset.
  await cursor(page, .25);
  await editor(page).getByRole('combobox', { name: 'Paste mode', exact: true }).selectOption('insert');
  await button(page, 'Paste').click();
  const selfPaste = join(selected.subarray(0, RATE / 4 * 4), selected, selected.subarray(RATE / 4 * 4));
  await expectTrack(page, monoSource.trackId, selfPaste, 1);

  await editor(page).getByRole('combobox', { name: 'Track to edit', exact: true }).selectOption(stereoSource.trackId);
  await select(page, .125, .375);
  await button(page, 'Copy selection').click();
  await expect(editor(page).locator('[data-editor-ref="clipboard"]')).toContainText('Stereo source · 0.25 s copied.');
  await editor(page).getByRole('combobox', { name: 'Track to edit', exact: true }).selectOption(monoSource.trackId);
  await cursor(page, .5);
  await button(page, 'Paste').click();
  const promoted = stereo(selfPaste), stereoSelection = originalStereo.subarray(RATE / 8 * 8, RATE * 3 / 8 * 8);
  const crossPaste = join(promoted.subarray(0, RATE / 2 * 8), stereoSelection, promoted.subarray(RATE / 2 * 8));
  await expectTrack(page, monoSource.trackId, crossPaste, 2);

  await field(page, 'Track length in seconds').fill('2.5');
  await editor(page).getByRole('combobox', { name: 'When lengthening', exact: true }).selectOption('repeat');
  await button(page, 'Set length').click();
  const repeated = join(crossPaste, crossPaste);
  await expectTrack(page, monoSource.trackId, repeated, 2);
  await field(page, 'Track length in seconds').fill('2.75');
  await editor(page).getByRole('combobox', { name: 'When lengthening', exact: true }).selectOption('silence');
  await button(page, 'Set length').click();
  const extended = join(repeated, Buffer.alloc(RATE / 4 * 8));
  await expectTrack(page, monoSource.trackId, extended, 2);
  await button(page, 'Undo').click();
  await expectTrack(page, monoSource.trackId, repeated, 2);
  await button(page, 'Redo').click();
  await expectTrack(page, monoSource.trackId, extended, 2);
  current = await snapshot(page, [monoSource.id, stereoSource.id]);
  expect(current.originals).toEqual({ [monoSource.id]: hash(originalMono), [stereoSource.id]: hash(originalStereo) });
  expect(current.audio[1].hash).toBe(hash(originalStereo));
  expect(current.project.sections).toEqual([fixture.section]);
  const screenshotPath = testInfo.outputPath(`review-${testInfo.project.name || 'chromium'}-audio-editor.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });
  await testInfo.attach('audio-editor', { path: screenshotPath, contentType: 'image/png' });

  await button(page, 'Done').click();
  await page.reload(); await expect(tracks(page)).toHaveCount(2);
  current = await snapshot(page, [monoSource.id, stereoSource.id]);
  expect(current.audio[0].hash).toBe(hash(extended));
  expect(current.audio[0].frames).toBe(RATE * 2.75);
  expect(current.originals[monoSource.id]).toBe(hash(originalMono));
  const backup = await download(page, () => page.locator('[data-action="export-project"]:visible').first().click());
  const saved = backupAudio(backup.bytes, monoSource.name);
  expect(saved.data).toEqual(extended); expect(saved.track.channels).toBe(2);
  await page.locator('[data-ref="project-file"]').setInputFiles({ name: backup.filename, mimeType: 'application/octet-stream', buffer: backup.bytes });
  await expect(page.getByText('Backup restored as a separate project.', { exact: true })).toBeVisible();
  current = await snapshot(page);
  expect(current.project.id).not.toBe(fixture.projectId);
  expect(current.audio[0].hash).toBe(hash(extended));
  expect(current.audio[1].hash).toBe(hash(originalStereo));
  expect(current.project.baseFrames).toBe(RATE);
});

test.describe('Chromium editor interaction checks', () => {
  test.skip(({ browserName }) => browserName !== 'chromium');

  test('phone selection handles and controls remain reachable; replacing a selection is exact and edits are blocked during capture', async ({ page, context }, testInfo) => {
    const fixture = await seed(page, context), source = fixture.originals[0], original = bytes(pcm(RATE, 1));
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('./'); await expect(tracks(page)).toHaveCount(2);
    await tracks(page).first().getByRole('button', { name: 'Edit Mono source', exact: true }).click();
    const waveform = page.getByTestId('editor-waveform');
    await expect(waveform).toBeVisible();
    // Waveform loading intentionally blocks editing until the selected source
    // has been read. Pointer input cannot auto-wait for disabled DOM controls.
    await expect(button(page, 'Copy selection')).toBeEnabled();
    await waveform.scrollIntoViewIfNeeded();
    const rectangle = await waveform.boundingBox();
    await page.mouse.move(rectangle.x + rectangle.width * .2, rectangle.y + rectangle.height / 2);
    await page.mouse.down();
    await page.mouse.move(rectangle.x + rectangle.width * .6, rectangle.y + rectangle.height / 2, { steps: 8 });
    await page.mouse.up();
    expect(Number(await field(page, 'Selection start in seconds').inputValue())).toBeCloseTo(.2, 1);
    expect(Number(await field(page, 'Selection end in seconds').inputValue())).toBeCloseTo(.6, 1);
    const startHandle = editor(page).getByRole('slider', { name: 'Selection start', exact: true });
    const priorFrame = Number(await startHandle.getAttribute('aria-valuenow'));
    await startHandle.focus(); await startHandle.press('ArrowRight');
    await expect(startHandle).toHaveAttribute('aria-valuenow', String(priorFrame + 1));
    await field(page, 'Track length in seconds').fill('0');
    await button(page, 'Set length').click();
    await expect(editor(page).getByRole('alert')).toContainText('Choose a length greater than zero.');
    expect((await snapshot(page)).audio[0].hash).toBe(hash(original));
    // Numeric bounds also provide exact, keyboard-accessible selection on a
    // phone where dragging a very short moment would otherwise be imprecise.
    await select(page, .125, .375); await button(page, 'Copy selection').click();
    await expect(editor(page).locator('[data-editor-ref="clipboard"]')).toContainText('Mono source · 0.25 s copied.');
    await select(page, .5, .625);
    await editor(page).getByRole('combobox', { name: 'Paste mode', exact: true }).selectOption('replace');
    await button(page, 'Paste').click();
    const expected = join(original.subarray(0, RATE / 2 * 4), original.subarray(RATE / 8 * 4, RATE * 3 / 8 * 4), original.subarray(RATE * 5 / 8 * 4));
    await expectTrack(page, source.trackId, expected, 1);
    for (const label of ['Selection start in seconds', 'Selection end in seconds', 'Paste position in seconds', 'Track length in seconds']) {
      const control = field(page, label); await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(361);
    }
    for (const label of ['Copy selection', 'Trim to selection', 'Set length', 'Paste', 'Undo', 'Redo', 'Done']) {
      const control = button(page, label); await control.scrollIntoViewIfNeeded();
      const box = await control.boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(361);
    }
    for (const name of ['Selection start', 'Selection end', 'Paste position']) {
      const box = await editor(page).getByRole('slider', { name, exact: true }).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(361);
    }
    expect(await editor(page).evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await waveform.scrollIntoViewIfNeeded();
    const path = testInfo.outputPath('review-audio-editor-phone.png');
    await page.screenshot({ path, animations: 'disabled' });
    await testInfo.attach('audio-editor-phone', { path, contentType: 'image/png' });
    await button(page, 'Done').click();
    await page.getByTestId('record-all-loops').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
    await expect(tracks(page).first().getByRole('button', { name: 'Edit Mono source', exact: true })).toBeDisabled();
    await page.getByTestId('cancel').click();
    await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
    await page.getByTestId('stop').click();
    await expect(tracks(page).first().getByRole('button', { name: 'Edit Mono source', exact: true })).toBeEnabled();
    expect((await snapshot(page, [source.id])).originals[source.id]).toBe(hash(original));
  });
});
