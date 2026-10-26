import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const RATE = 48000;
const clock = page => page.locator('[data-ref="transport-time"]');
const playing = (page, value) => expect(page.locator('#app')).toHaveAttribute('data-playing', String(value));
const observed = page => page.evaluate(() => window.__transportObserved);
const positions = page => page.locator('.loop-card [data-position]').evaluateAll(nodes => nodes.map(node => Number.parseFloat(node.style.left)));

async function seed(page, context) {
  await context.route('**/__ci-transport-fixtures.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Transport fixtures</title>' }));
  await page.goto('./__ci-transport-fixtures.html');
  return page.evaluate(async () => {
    const storagePath = './src/storage/client.mjs', projectPath = './src/project.mjs';
    const { StorageClient } = await import(storagePath), { createProject, createTrack, validateProject, PAGE_FRAMES } = await import(projectPath);
    const storage = new StorageClient(), project = createProject('Stop and pause verification', 48000);
    try {
      await storage.init(); await storage.saveProject(project);
      for (const [index, duration] of [2, 3].entries()) {
        const id = `transport-${crypto.randomUUID()}`, frames = duration * project.sampleRate;
        await storage.beginAsset({ id, projectId: project.id, sampleRate: project.sampleRate, channels: 1, kind: 'loop', name: `Opening ${index + 1}` });
        for (let start = 0, pageIndex = 0; start < frames; start += PAGE_FRAMES, pageIndex++) {
          const count = Math.min(PAGE_FRAMES, frames - start);
          // Sound exists only at the beginning. Resetting just the global clock
          // while retaining either historical offset would miss this opening.
          const samples = Float32Array.from({ length: count }, (_, i) => start + i < 9600 ? .12 * Math.sin(2 * Math.PI * (index ? 733 : 317) * (start + i) / 48000) : 0);
          await storage.putPage(id, pageIndex, samples.buffer, count, 1);
        }
        await storage.finishAsset(id, { frames });
        project.tracks.push(createTrack({ assetId: id, name: `Opening ${index + 1}`, frames, offsetFrames: index ? 72000 : 12000,
          peaks: Array.from({ length: 64 }, (_, i) => i < 5 ? .12 : 0), mix: { volume: 1, pan: index ? 1 : -1, low: 0, mid: 0, high: 0, highpass: 20, compression: 0, reverb: 0, delay: 0 } }));
      }
      project.baseFrames = 2 * project.sampleRate;
      await storage.saveProject(validateProject(project)); localStorage.setItem('fml:last-project', project.id);
      return { offsets: project.tracks.map(track => track.offsetFrames), lengths: project.tracks.map(track => track.frames) };
    } finally { await storage.dispose(); }
  });
}

async function project(page) {
  return page.evaluate(async () => {
    const path = './src/storage/client.mjs', { StorageClient } = await import(path), storage = new StorageClient();
    try { await storage.init(); return await storage.loadProject(localStorage.getItem('fml:last-project')); }
    finally { await storage.dispose(); }
  });
}

function openingLevels(bytes) {
  let channels, rate, format, bits, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.subarray(offset, offset + 4).toString(), size = bytes.readUInt32LE(offset + 4);
    if (name === 'fmt ') { format = bytes.readUInt16LE(offset + 8); channels = bytes.readUInt16LE(offset + 10); rate = bytes.readUInt32LE(offset + 12); bits = bytes.readUInt16LE(offset + 22); }
    if (name === 'data') data = bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  expect(channels).toBe(2); expect(rate).toBe(RATE); expect(format).toBe(3); expect(bits).toBe(32);
  const start = Math.round(.03 * rate), end = Math.round(.15 * rate), squares = [0, 0];
  expect(data.length / 8).toBeGreaterThan(end);
  for (let frame = start; frame < end; frame++) for (let channel = 0; channel < 2; channel++) squares[channel] += data.readFloatLE((frame * 2 + channel) * 4) ** 2;
  return squares.map(value => Math.sqrt(value / (end - start)));
}

test('Pause holds position, Stop rewinds every loop, and the next capture starts both unequal loops together', async ({ page, context }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.__transportObserved = null; window.__transportEvents = [];
    const NativeNode = window.AudioWorkletNode;
    window.AudioWorkletNode = new Proxy(NativeNode, { construct(target, args, newTarget) {
      const node = Reflect.construct(target, args, newTarget);
      node.port.addEventListener('message', ({ data }) => {
        if (!['state', 'meter', 'capture-start', 'capture-end'].includes(data.type)) return;
        const event = { type: data.type, frame: data.transportFrame, playing: data.playing, paused: data.paused, offsets: data.playbackOffsets,
          startFrame: data.startFrame, endFrame: data.endFrame, frames: data.frames, capture: data.capture?.status || null };
        window.__transportEvents.push(event);
        if (data.type === 'state' || data.type === 'meter') window.__transportObserved = event;
      });
      node.port.start(); return node;
    } });
  });
  const original = await seed(page, context);
  await page.goto('./');
  await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(2);
  await page.getByTestId('play').click(); await playing(page, true);
  await expect.poll(async () => (await observed(page))?.frame || 0).toBeGreaterThan(RATE * .35);
  await page.getByTestId('pause').click(); await playing(page, false);
  await expect.poll(async () => (await observed(page))?.paused).toBe(true);
  const held = await observed(page), heldClock = await clock(page).textContent(), heldPositions = await positions(page);
  await expect(page.getByTestId('play')).toHaveAccessibleName('Resume playback');
  await page.waitForTimeout(250); // Prove the real audio clock no longer advances the transport.
  expect((await observed(page)).frame).toBe(held.frame);
  await expect(clock(page)).toHaveText(heldClock); expect(await positions(page)).toEqual(heldPositions);
  const resumeMark = await page.evaluate(() => window.__transportEvents.length);
  await page.getByTestId('play').click(); await playing(page, true);
  await expect.poll(() => page.evaluate(mark => window.__transportEvents.slice(mark).find(event => event.type === 'state' && event.playing)?.frame, resumeMark)).toBe(held.frame);
  await expect.poll(async () => (await observed(page))?.frame || 0).toBeGreaterThan(held.frame + RATE * .15);

  await page.getByTestId('stop').click(); await playing(page, false);
  await expect(clock(page)).toHaveText('0:00.0');
  await expect.poll(() => positions(page)).toEqual([0, 0]);
  await expect.poll(async () => (await observed(page))?.frame).toBe(0);
  expect(Object.values((await observed(page)).offsets)).toEqual([0, 0]);
  expect((await observed(page)).paused).toBe(false);
  await page.getByTestId('stop').click();
  await page.waitForTimeout(200); await expect(clock(page)).toHaveText('0:00.0'); expect(await positions(page)).toEqual([0, 0]);

  // Space is Pause/Resume, not the hard reset action.
  const restartMark = await page.evaluate(() => window.__transportEvents.length);
  await page.locator('#workspace').focus(); await page.keyboard.press('Space'); await playing(page, true);
  await expect.poll(() => page.evaluate(mark => window.__transportEvents.slice(mark).find(event => event.type === 'state' && event.playing)?.frame, restartMark)).toBe(0);
  await expect.poll(async () => (await observed(page))?.frame || 0).toBeGreaterThan(RATE * .2);
  await page.keyboard.press('Space'); await playing(page, false);
  await expect.poll(async () => (await observed(page))?.paused).toBe(true);
  const keyboardHeld = (await observed(page)).frame; expect(keyboardHeld).toBeGreaterThan(0);
  const keyboardResumeMark = await page.evaluate(() => window.__transportEvents.length);
  await page.keyboard.press('Space'); await playing(page, true);
  await expect.poll(() => page.evaluate(mark => window.__transportEvents.slice(mark).find(event => event.type === 'state' && event.playing)?.frame, keyboardResumeMark)).toBe(keyboardHeld);
  await expect.poll(async () => (await observed(page))?.frame || 0).toBeGreaterThan(keyboardHeld);
  await page.getByTestId('stop').click(); await expect(clock(page)).toHaveText('0:00.0');

  await page.getByTestId('record-all-loops').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
  await expect(page.getByTestId('pause')).toBeDisabled();
  await page.waitForTimeout(800); // Record the actual simultaneous openings into stereo PCM.
  await page.getByTestId('stop').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
  await playing(page, false); await expect(clock(page)).toHaveText('0:00.0');
  await expect.poll(() => positions(page)).toEqual([0, 0]);
  await expect.poll(async () => (await project(page)).performances.length).toBe(1);
  const saved = await project(page), performance = saved.performances[0];
  expect(performance.startFrame).toBe(0); expect(performance.frames).toBeGreaterThan(RATE * .5);
  expect(performance.initialState.tracks.map(track => track.offsetFrames)).toEqual([0, 0]);
  expect(saved.tracks.map(track => track.offsetFrames)).toEqual(original.offsets);
  expect(saved.tracks.map(track => track.frames)).toEqual(original.lengths);
  const downloaded = page.waitForEvent('download');
  await page.locator('[data-ref="recent-recording"]').getByRole('button', { name: 'Download Loop recording 1', exact: true }).click();
  const file = await downloaded; expect(await file.failure()).toBeNull();
  const levels = openingLevels(await readFile(await file.path()));
  expect(levels[0]).toBeGreaterThan(.01); expect(levels[1]).toBeGreaterThan(.01);
  await testInfo.attach('transport-and-simultaneous-audio', { body: JSON.stringify({ held, keyboardHeld, openingRms: levels, performanceFrames: performance.frames,
    events: await page.evaluate(() => window.__transportEvents) }, null, 2), contentType: 'application/json' });
  await page.setViewportSize({ width: 360, height: 800 });
  for (const name of ['play', 'pause', 'stop']) {
    await expect(page.getByTestId(name)).toBeInViewport(); const bounds = await page.getByTestId(name).boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  const screenshot = testInfo.outputPath('review-stop-pause-phone.png');
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('stop-pause-phone', { path: screenshot, contentType: 'image/png' });
  expect(errors).toEqual([]);
});
