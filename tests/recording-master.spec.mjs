import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const RATE = 48000;
const digest = value => createHash('sha256').update(value).digest('hex');
const master = page => page.getByTestId('recording-master');
const choose = page => master(page).getByRole('combobox', { name: 'Song or recording', exact: true });
const control = (page, name) => master(page).getByRole('slider', { name, exact: true });
const button = (page, name) => master(page).getByRole('button', { name, exact: true });
const view = (page, name) => page.locator(`[data-action="view"][data-view="${name}"]`).click();
const samples = (frames, channels, salt = 0) => Float32Array.from({ length: frames * channels }, (_, i) => {
  const frame = Math.floor(i / channels), channel = i % channels;
  return ((frame * (channel ? 5 : 3) + channel * 67 + salt) % 251 - 125) / 1024;
});
const bytes = value => Buffer.from(value.buffer, value.byteOffset, value.byteLength);

async function seed(page, context, { long = false } = {}) {
  await context.route('**/__ci-master-fixtures.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recording master fixtures</title>' }));
  await page.goto('./__ci-master-fixtures.html');
  return page.evaluate(async ({ long }) => {
    const storagePath = './src/storage/client.mjs', projectPath = './src/project.mjs';
    const { StorageClient } = await import(storagePath);
    const { createProject, createTrack, PAGE_FRAMES, roleMix } = await import(projectPath);
    const storage = new StorageClient(), project = createProject('Saved songs mastering fixture', 48000), originals = [];
    const definitions = [
      { name: 'Loop song original', kind: 'master', channels: 2, frames: long ? 48000 * 24 : 60000, salt: 0 },
      { name: 'Vocal performance original', kind: 'master', channels: 2, frames: 60000, salt: 41 },
      { name: 'Separate vocal take', kind: 'vocal', channels: 1, frames: 60000, salt: 83 },
      { name: 'Unchanged loop layer', kind: 'loop', channels: 1, frames: 48000, salt: 127 },
      { name: 'Earlier saved mix', kind: 'mix', channels: 2, frames: 48000, salt: 173 },
    ];
    try {
      await storage.init(); await storage.saveProject(project);
      for (const definition of definitions) {
        const id = `master_fixture_${crypto.randomUUID()}`;
        await storage.beginAsset({ id, projectId: project.id, sampleRate: 48000, ...definition });
        for (let start = 0, index = 0; start < definition.frames; start += PAGE_FRAMES, index++) {
          const frames = Math.min(PAGE_FRAMES, definition.frames - start), { channels, salt } = definition;
          const pcm = Float32Array.from({ length: frames * channels }, (_, i) => {
            const frame = start + Math.floor(i / channels), channel = i % channels;
            return ((frame * (channel ? 5 : 3) + channel * 67 + salt) % 251 - 125) / 1024;
          });
          await storage.putPage(id, index, pcm.buffer, frames, channels);
        }
        await storage.finishAsset(id, { frames: definition.frames });
        originals.push({ id, ...definition });
      }
      const [loopSong, vocalSong, take, loop] = originals;
      const common = { startFrame: 0, status: 'complete', createdAt: new Date().toISOString(), events: [] };
      const loopPerformanceId = `performance_${crypto.randomUUID()}`, vocalPerformanceId = `performance_${crypto.randomUUID()}`;
      project.performances.push(
        { ...common, id: loopPerformanceId, name: loopSong.name, source: 'loops', masterAssetId: loopSong.id, frames: loopSong.frames, endFrame: loopSong.frames },
        { ...common, id: vocalPerformanceId, name: vocalSong.name, leadAssetId: take.id, masterAssetId: vocalSong.id, frames: vocalSong.frames, endFrame: vocalSong.frames },
      );
      const takeId = `take_${crypto.randomUUID()}`;
      project.takes.push({ id: takeId, name: take.name, assetId: take.id, frames: take.frames, startFrame: 0, performanceId: vocalPerformanceId, mix: roleMix('lead'), createdAt: common.createdAt });
      project.selectedTakeId = takeId;
      project.tracks.push(createTrack({ assetId: loop.id, name: loop.name, frames: loop.frames, peaks: Array(64).fill(.1) }));
      project.baseFrames = 48000;
      for (const performance of project.performances) performance.initialState = structuredClone({ tracks: project.tracks, master: project.master, input: project.input, baseFrames: project.baseFrames, frame: 0 });
      await storage.saveProject(project); localStorage.setItem('fml:last-project', project.id);
      return { projectId: project.id, originals, takeId, loopPerformanceId, vocalPerformanceId };
    } finally { await storage.dispose(); }
  }, { long });
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const storagePath = './src/storage/client.mjs';
    const { StorageClient } = await import(storagePath), storage = new StorageClient();
    try {
      await storage.init();
      const project = await storage.loadProject(localStorage.getItem('fml:last-project'));
      const assets = await storage.listAssets(project.id), hashes = {};
      for (const asset of assets) {
        const blob = await storage.getAssetFile(asset.id);
        hashes[asset.id] = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return { project, assets, hashes };
    } finally { await storage.dispose(); }
  });
}

async function setRange(page, name, value) {
  await control(page, name).evaluate((input, next) => {
    input.value = String(next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(control(page, name)).toHaveValue(String(value));
}

async function download(page, start) {
  const pending = page.waitForEvent('download'); await start();
  const file = await pending; expect(await file.failure()).toBeNull();
  return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

function wav(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF'); expect(bytes.subarray(8, 12).toString()).toBe('WAVE');
  let format, pcm;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4), name = bytes.subarray(at, at + 4).toString();
    expect(at + 8 + size).toBeLessThanOrEqual(bytes.length);
    if (name === 'fmt ') format = { encoding: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10), rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    if (name === 'data') pcm = bytes.subarray(at + 8, at + 8 + size);
    at += 8 + size + size % 2;
  }
  expect(format).toEqual({ encoding: 3, channels: 2, rate: RATE, bits: 32 });
  expect(pcm).toBeDefined(); return pcm;
}

function importWav() {
  // Float32 WAV avoids browsers' differing PCM16 full-scale conventions:
  // Firefox divides positive integers by 32767; Chromium/WebKit use 32768.
  // This fixture therefore permits an exact source-to-import PCM assertion.
  const pcm = samples(RATE, 2, 229), data = Buffer.alloc(44 + pcm.length * 4);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(3, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(RATE, 24); data.writeUInt32LE(RATE * 8, 28); data.writeUInt16LE(8, 32); data.writeUInt16LE(32, 34);
  data.write('data', 36); data.writeUInt32LE(pcm.length * 4, 40);
  bytes(pcm).copy(data, 44);
  return { data, expected: bytes(pcm) };
}

async function screenshot(page, testInfo, name) {
  const path = testInfo.outputPath(`review-${testInfo.project.name || 'chromium'}-${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

test.use({ permissions: [] });
test.beforeEach(async ({ page }, testInfo) => {
  testInfo.runtimeErrors = []; page.on('pageerror', error => testInfo.runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    window.__masterMicRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.__masterMicRequests++; throw new DOMException('Mastering saved audio does not need a microphone.', 'NotAllowedError'); };
    // The app permits blob media playback, but its connect-src policy does not
    // permit fetch(blob:). Retain the actual preview Blob for byte inspection
    // while preserving the browser's create/revoke behavior and URL lifetime.
    window.__masterPreviewBlobs = new Map();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); window.__masterPreviewBlobs.set(url, blob); return url; };
    URL.revokeObjectURL = url => { window.__masterPreviewBlobs.delete(url); return revoke(url); };
  });
});
test.afterEach(async ({ page }, testInfo) => {
  expect(testInfo.runtimeErrors).toEqual([]); expect(await page.evaluate(() => window.__masterMicRequests)).toBe(0);
});

test('saved songs, performances, takes and mixes can be mastered as independent stereo downloads without changing originals', async ({ page, context }, testInfo) => {
  const fixture = await seed(page, context), source = fixture.originals[0];
  await page.goto('./'); await view(page, 'mix'); await page.getByRole('button', { name: 'Songs & recordings', exact: true }).click();
  await expect(master(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Songs & recordings', exact: true })).toHaveAttribute('aria-pressed', 'true');
  for (const original of fixture.originals) await expect(choose(page).locator('option')).toContainText([original.name]);
  await choose(page).selectOption(`asset:${source.id}`);
  await expect(master(page).getByRole('checkbox', { name: 'Normalize peak', exact: true })).not.toBeChecked();
  const before = await snapshot(page);
  await button(page, 'Listen to original').click();
  const preview = master(page).getByLabel('Recording master preview', { exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(audio => audio.duration)).toBeCloseTo(1.25, 5);
  await setRange(page, 'Balance', .5);
  await expect(preview).toBeHidden();
  await button(page, 'Preview master').click();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(audio => audio.duration)).toBeCloseTo(1.25, 5);
  expect((await snapshot(page)).assets.map(asset => asset.id).sort()).toEqual(before.assets.map(asset => asset.id).sort());

  await master(page).getByRole('textbox', { name: 'New version name', exact: true }).fill('Loop song mastered');
  const automaticDownload = await download(page, () => button(page, 'Save new master').click());
  await expect.poll(async () => (await snapshot(page)).assets.filter(asset => asset.name === 'Loop song mastered').length).toBe(1);
  const after = await snapshot(page), output = after.assets.find(asset => asset.name === 'Loop song mastered');
  const expected = bytes(Float32Array.from(samples(source.frames, 2), (value, i) => value * (i % 2 ? 1 : .5)));
  expect(wav(automaticDownload.bytes)).toEqual(expected);
  expect(output).toMatchObject({ kind: 'mix', channels: 2, frames: source.frames, sourceAssetId: source.id });
  expect(output.masterSettings.balance).toBe(.5);
  expect(after.hashes[output.id]).toBe(digest(expected));
  for (const original of fixture.originals) expect(after.hashes[original.id]).toBe(before.hashes[original.id]);
  expect(after.project.selectedTakeId).toBe(fixture.takeId);
  expect(after.project.tracks).toEqual(before.project.tracks); expect(after.project.performances).toEqual(before.project.performances);
  expect(after.project.recordingMixSettings[source.id].balance).toBe(.5);
  const exported = await download(page, () => master(page).getByRole('button', { name: 'Download Loop song mastered', exact: true }).click());
  expect(wav(exported.bytes)).toEqual(expected);
  await screenshot(page, testInfo, 'saved-recording-master-desktop');

  await choose(page).selectOption(`asset:${fixture.originals[1].id}`);
  await expect(control(page, 'Balance')).toHaveValue('0');
  await choose(page).selectOption(`asset:${source.id}`);
  await expect(control(page, 'Balance')).toHaveValue('0.5');
  // Explicitly remix this loops-only arrangement while an unrelated vocal
  // take remains selected. With its only loop at zero, the result must be
  // silence: a mistaken fallback to that vocal performance would be audible.
  await button(page, 'Remix individual layers').click();
  await expect(page.getByRole('button', { name: 'Layers & vocals', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const target = page.locator('[data-ref="recording-remix-target"]');
  await expect(target).toContainText(source.name);
  const loopVolume = page.locator('[data-ref="mix-console"] [data-control="mix"][data-key="volume"]');
  await loopVolume.evaluate(input => { input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  const remixed = await download(page, () => target.getByRole('button', { name: 'Render new mix', exact: true }).click());
  const remixedPcm = wav(remixed.bytes);
  expect(remixedPcm.length).toBe((source.frames + 2 * RATE) * 8);
  let nonzero = 0;
  for (let offset = 0; offset < remixedPcm.length; offset += 4) if (remixedPcm.readFloatLE(offset) !== 0) nonzero++;
  expect(nonzero).toBe(0);
  const remixState = await snapshot(page), remix = remixState.assets.find(asset => asset.sourcePerformanceId === fixture.loopPerformanceId);
  expect(remix).toBeDefined(); expect(remixState.project.selectedTakeId).toBe(fixture.takeId);
  await page.getByRole('button', { name: 'Songs & recordings', exact: true }).click();
  await page.reload(); await view(page, 'mix'); await page.getByRole('button', { name: 'Songs & recordings', exact: true }).click(); await choose(page).selectOption(`asset:${source.id}`);
  await expect(control(page, 'Balance')).toHaveValue('0.5');
  await expect(master(page).getByRole('button', { name: 'Download Loop song mastered', exact: true })).toBeVisible();
  await view(page, 'song');
  await expect(page.getByRole('region', { name: 'Saved mixes', exact: true }).getByRole('button', { name: 'Download Loop song mastered', exact: true })).toBeVisible();

  const backup = await download(page, () => page.locator('[data-action="export-project"]:visible').first().click());
  const manifestSize = Number(backup.bytes.readBigUInt64LE(16)), manifest = JSON.parse(backup.bytes.subarray(64, 64 + manifestSize).toString());
  const archived = manifest.assets.find(asset => asset.id === output.id);
  expect(archived.sourceAssetId).toBe(source.id); expect(archived.masterSettings.balance).toBe(.5);
  expect(backup.bytes.subarray(64 + manifestSize + archived.offset, 64 + manifestSize + archived.offset + archived.bytes)).toEqual(expected);
  await page.locator('[data-ref="project-file"]').setInputFiles({ name: backup.filename, mimeType: 'application/octet-stream', buffer: backup.bytes });
  await expect(page.getByText('Backup restored as a separate project.', { exact: true })).toBeVisible();
  const restored = await snapshot(page), restoredSource = restored.assets.find(asset => asset.name === source.name), restoredOutput = restored.assets.find(asset => asset.name === output.name);
  expect(restored.project.id).not.toBe(fixture.projectId);
  expect(restoredOutput.sourceAssetId).toBe(restoredSource.id); expect(restoredOutput.sourceAssetId).not.toBe(source.id);
  expect(restored.hashes[restoredOutput.id]).toBe(digest(expected));
  expect(restored.project.recordingMixSettings[restoredSource.id].balance).toBe(.5);
});

test('recording import preserves stereo; previews stay temporary and the mastering controls fit a phone', async ({ page, context }, testInfo) => {
  const fixture = await seed(page, context, { long: true }), source = fixture.originals[0];
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('./'); await view(page, 'mix'); await page.getByRole('button', { name: 'Songs & recordings', exact: true }).click(); await choose(page).selectOption(`asset:${source.id}`);
  const initial = await snapshot(page);
  // Hold the first worker script request until Cancel is clicked. This makes
  // cancellation deterministic even when the machine renders very quickly;
  // all subsequent previews run the real unmodified renderer and PCM storage.
  let releaseWorker, workerRequested;
  const requested = new Promise(resolve => { workerRequested = resolve; });
  await context.route('**/src/export/master-worker.mjs', async route => {
    const release = new Promise(resolve => { releaseWorker = resolve; });
    workerRequested(); await release; await route.continue().catch(() => {});
  }, { times: 1 });
  try {
    await button(page, 'Preview master').click(); await requested;
    await button(page, 'Cancel preview').click();
  } finally { releaseWorker?.(); }
  await expect(button(page, 'Preview master')).toBeEnabled();
  await expect(master(page).getByLabel('Recording master preview', { exact: true })).toBeHidden();
  expect((await snapshot(page)).assets.map(asset => asset.id).sort()).toEqual(initial.assets.map(asset => asset.id).sort());
  await button(page, 'Preview master').click();
  const preview = master(page).getByLabel('Recording master preview', { exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(audio => audio.duration)).toBeCloseTo(20, 5);
  expect((await snapshot(page)).assets.map(asset => asset.id).sort()).toEqual(initial.assets.map(asset => asset.id).sort());
  const previewStart = master(page).getByRole('spinbutton', { name: 'Preview start in seconds', exact: true });
  await previewStart.fill('22.5'); await previewStart.press('Tab');
  await button(page, 'Preview master').click();
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate(audio => audio.duration)).toBeCloseTo(1.5, 5);
  const tailHash = await preview.evaluate(async audio => {
    const recording = window.__masterPreviewBlobs.get(audio.getAttribute('src'));
    if (!(recording instanceof Blob)) throw new Error('The active preview Blob was revoked or replaced.');
    const blob = await recording.arrayBuffer();
    const data = new DataView(blob); let offset = 12;
    while (offset + 8 <= data.byteLength) {
      const length = data.getUint32(offset + 4, true);
      if (String.fromCharCode(...new Uint8Array(blob, offset, 4)) === 'data') {
        const hash = await crypto.subtle.digest('SHA-256', blob.slice(offset + 8, offset + 8 + length));
        return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      offset += 8 + length + length % 2;
    }
    throw new Error('Preview has no WAV audio.');
  });
  expect(tailHash).toBe(digest(bytes(samples(source.frames, 2)).subarray(Math.round(22.5 * RATE) * 8)));
  await choose(page).selectOption(`asset:${fixture.originals[2].id}`);
  await expect(preview).toBeHidden();
  await expect(control(page, 'Balance')).toBeDisabled();

  const imported = importWav();
  const chooser = page.waitForEvent('filechooser'); await button(page, 'Import recording').click();
  await (await chooser).setFiles({ name: 'Imported stereo song.wav', mimeType: 'audio/wav', buffer: imported.data });
  await expect.poll(async () => (await snapshot(page)).assets.filter(asset => asset.name === 'Imported stereo song').length).toBe(1);
  const importedState = await snapshot(page), asset = importedState.assets.find(value => value.name === 'Imported stereo song');
  expect(asset).toMatchObject({ kind: 'recording', channels: 2, frames: RATE });
  expect(importedState.hashes[asset.id]).toBe(digest(imported.expected));
  expect(importedState.project.tracks).toEqual(initial.project.tracks);
  await expect(choose(page)).toHaveValue(`asset:${asset.id}`);
  await expect(control(page, 'Balance')).toBeEnabled();
  for (const label of ['Input gain', 'Balance', 'Low cut', 'Low EQ', 'Mid EQ', 'High EQ', 'Compression', 'Sample peak ceiling']) {
    const input = control(page, label); await input.scrollIntoViewIfNeeded(); const bounds = await input.boundingBox();
    expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(361);
  }
  for (const label of ['Listen to original', 'Preview master', 'Save new master']) {
    const input = button(page, label); await input.scrollIntoViewIfNeeded(); const bounds = await input.boundingBox();
    expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(361);
  }
  await choose(page).scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, 'saved-recording-master-phone');
});
