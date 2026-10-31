import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const RATE = 48000, ORIGINAL_BYTES = 5_834_752, ORIGINAL_FRAMES = ORIGINAL_BYTES / 4;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dialog = page => page.getByRole('dialog', { name: 'Storage', exact: true });
const health = page => page.getByTestId('storage-write-status');
const row = (page, id) => dialog(page).locator('.storage-file-row').filter({ has: page.locator(`[data-file-key="asset:${id}"]`) });

// Only estimate() and the explicitly selected failure are substituted. All
// project, audio, write/readback, cleanup and recording paths are production.
async function environment(page, context, { estimate, failDiagnosticWrite = false }) {
  let reported = estimate;
  await context.route('**/__ci-storage-capacity.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(reported) }));
  const bootstrap = `
    const pending = [];
    const hold = event => { pending.push(event.data); event.stopImmediatePropagation(); };
    self.addEventListener('message', hold);
    // WebKit does not expose StorageManager on WorkerNavigator. Substitute
    // only estimate(); absent OPFS APIs still choose the real IDB backend.
    if (!navigator.storage) Object.defineProperty(navigator, 'storage', { configurable: true, value: {} });
    Object.defineProperty(navigator.storage, 'estimate', { configurable: true, value: async () => {
      const capacityPath = './__ci-storage-capacity.json';
      const response = await fetch(new URL(capacityPath, self.location.href), { cache: 'no-store' });
      return response.json();
    } });
    if (${JSON.stringify(failDiagnosticWrite)}) {
      const quotaError = () => new DOMException('The test browser refused the temporary audio write', 'QuotaExceededError');
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, ...args) {
        if (this.name === 'pages' && value?.assetId?.startsWith('storage-check-')) throw quotaError();
        return put.call(this, value, ...args);
      };
      if (typeof FileSystemFileHandle !== 'undefined' && FileSystemFileHandle.prototype.createSyncAccessHandle) {
        const open = FileSystemFileHandle.prototype.createSyncAccessHandle;
        FileSystemFileHandle.prototype.createSyncAccessHandle = async function(...args) {
          const handle = await open.apply(this, args);
          if (this.name.startsWith('storage-check-')) {
            Object.defineProperty(handle, 'write', { configurable: true, value: () => { throw quotaError(); } });
          }
          return handle;
        };
      }
    }
    const productionPath = './src/storage/worker.mjs';
    await import(new URL(productionPath, self.location.href).href);
    self.removeEventListener('message', hold);
    for (const data of pending) self.onmessage({ data });
  `;
  await context.route('**/__ci-storage-diagnostic-worker.mjs', route => route.fulfill({ contentType: 'application/javascript', body: bootstrap }));
  await page.addInitScript(() => {
    window.__storageChecks = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        const requested = new URL(url, location.href);
        const fixturePath = './__ci-storage-diagnostic-worker.mjs';
        super(requested.pathname.endsWith('/src/storage/worker.mjs') ? new URL(fixturePath, location.href) : url, options);
        this.addEventListener('message', ({ data }) => {
          if (data?.type === 'rpc-result' && data.result?.testedBytes === 131072) window.__storageChecks.push(data.result);
        });
      }
    };
  });
  return { setEstimate(value) { reported = value; } };
}

async function seed(page, context) {
  await context.route('**/__ci-storage-recording.html', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>One saved recording</title>' }));
  await page.goto('./__ci-storage-recording.html');
  return page.evaluate(async ({ frames, rate }) => {
    const stage = async (label, operation) => {
      window.__storageSeedStage = label;
      let timer;
      try {
        return await Promise.race([operation(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Storage fixture timed out at: ${label}`)), 15_000);
        })]);
      } finally { clearTimeout(timer); }
    };
    const storagePath = './src/storage/client.mjs', projectPath = './src/project.mjs';
    const { StorageClient } = await stage('load storage client', () => import(storagePath));
    const { createProject, createTrack, validateProject, PAGE_FRAMES } = await stage('load project module', () => import(projectPath));
    const storage = new StorageClient(), project = createProject('Single recording storage check', rate);
    const id = `retained_bass_${crypto.randomUUID()}`;
    let initialized = false;
    try {
      await stage('initialize native storage', () => storage.init()); initialized = true;
      await stage('save fixture project', () => storage.saveProject(project));
      await stage('begin fixture recording', () => storage.beginAsset({ id, projectId: project.id, sampleRate: rate, channels: 1, kind: 'loop', name: 'Bass 2' }));
      for (let start = 0, index = 0; start < frames; start += PAGE_FRAMES, index++) {
        const count = Math.min(PAGE_FRAMES, frames - start);
        const samples = Float32Array.from({ length: count }, (_, offset) => .15 * Math.sin(2 * Math.PI * 196 * (start + offset) / rate));
        await stage(`write fixture audio page ${index}`, () => storage.putPage(id, index, samples.buffer, count, 1));
      }
      await stage('seal fixture recording', () => storage.finishAsset(id, { frames }));
      project.tracks.push(createTrack({ assetId: id, name: 'Bass 2', role: 'bass', frames, peaks: Array(64).fill(.15) }));
      project.baseFrames = frames;
      await stage('save fixture track', () => storage.saveProject(validateProject(project)));
      localStorage.setItem('fml:last-project', project.id);
      return { id, projectId: project.id };
    } finally {
      try { if (initialized) await stage('close fixture storage', () => storage.dispose()); }
      finally { storage.worker?.terminate(); }
    }
  }, { frames: ORIGINAL_FRAMES, rate: RATE });
}

async function snapshot(page, fixture) {
  return page.evaluate(async ({ id, projectId }) => {
    const path = './src/storage/client.mjs', { StorageClient } = await import(path), storage = new StorageClient();
    try {
      await storage.init();
      const project = await storage.loadProject(projectId), inventory = await storage.getStorageInventory();
      const blob = await storage.getAssetFile(id), bytes = await blob.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { project, sourceBytes: bytes.byteLength, sourceHash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join(''),
        files: inventory.files.map(({ key, id, bytes, name, assetKind }) => ({ key, id, bytes, name, assetKind })),
        assetIds: (await storage.listAssets(projectId)).map(asset => asset.id).sort() };
    } finally { await storage.dispose(); }
  }, fixture);
}

async function openStorage(page, status = 'passed') {
  if (!(await dialog(page).isVisible())) await page.getByTestId('storage').click();
  await expect(dialog(page)).toBeVisible();
  await expect(health(page)).toHaveAttribute('data-status', status);
  await expect(page.getByTestId('check-storage')).toBeEnabled();
}
async function closeStorage(page) { await dialog(page).getByRole('button', { name: 'Done', exact: true }).click(); await expect(dialog(page)).toBeHidden(); }
async function download(page, action) {
  const event = page.waitForEvent('download'); await action(); const file = await event;
  expect(await file.failure()).toBeNull(); return readFile(await file.path());
}
function pcm(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(offset + 4);
    if (bytes.subarray(offset, offset + 4).toString() === 'data') return bytes.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  throw new Error('The downloaded recording has no PCM payload');
}
async function assertUnknownCapacity(page) {
  await expect(page.getByTestId('storage-remaining')).toHaveAttribute('data-bytes', 'unknown');
  await expect(page.getByTestId('storage-remaining')).toContainText(/unknown|not confirmed|unavailable/i);
  await expect(dialog(page)).not.toContainText(/About 0s|0 seconds|0 B available/i);
}
async function awaitNewCheck(page, previous, status = 'passed') {
  await expect.poll(() => page.evaluate(() => window.__storageChecks.length)).toBeGreaterThan(previous);
  await expect(health(page)).toHaveAttribute('data-status', status);
  await expect(page.getByTestId('check-storage')).toBeEnabled();
}

test('one 5.56 MiB recording remains writable with zero or over-quota estimates, and Refresh updates the report', async ({ page, context }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const quota = 2 * 1024 ** 3, browser = await environment(page, context, { estimate: { quota, usage: quota } });
  const fixture = await seed(page, context);
  await page.goto('./');
  await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(1);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  const before = await snapshot(page, fixture);
  expect(before.sourceBytes).toBe(ORIGINAL_BYTES); expect(before.files).toHaveLength(1);
  await openStorage(page); await assertUnknownCapacity(page);
  await expect(row(page, fixture.id)).toHaveAttribute('data-file-bytes', String(ORIGINAL_BYTES));
  await expect(dialog(page).locator('.storage-file-row')).toHaveCount(1);
  expect(await snapshot(page, fixture)).toEqual(before);
  const zeroScreenshot = testInfo.outputPath('review-storage-diagnostic-zero-headroom.png');
  await page.screenshot({ path: zeroScreenshot, animations: 'disabled' });
  await testInfo.attach('storage-diagnostic-zero-headroom', { path: zeroScreenshot, contentType: 'image/png' });

  // A manual check updates its result without replacing the user's file filter.
  await dialog(page).getByRole('searchbox', { name: 'Search files', exact: true }).fill('Bass 2');
  let previous = await page.evaluate(() => window.__storageChecks.length);
  await page.getByTestId('check-storage').click(); await awaitNewCheck(page, previous);
  await expect(dialog(page).getByRole('searchbox', { name: 'Search files', exact: true })).toHaveValue('Bass 2');
  expect(await snapshot(page, fixture)).toEqual(before);

  // An over-quota reading is a report to inspect, not a manufactured zero-byte
  // recording limit. Refresh must make an actual controller request.
  browser.setEstimate({ quota, usage: quota + 1024 ** 3 });
  previous = await page.evaluate(() => window.__storageChecks.length);
  await dialog(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await awaitNewCheck(page, previous); await assertUnknownCapacity(page);
  await expect(dialog(page).locator('.storage-accounting')).toContainText((quota + 1024 ** 3).toLocaleString('en-US'));
  expect(await snapshot(page, fixture)).toEqual(before);
  const checks = await page.evaluate(() => window.__storageChecks);
  expect(checks.length).toBeGreaterThanOrEqual(3);
  for (const check of checks) {
    expect(check.status).toBe('passed'); expect(check.bytesVerified).toBe(131072); expect(check.cleanupComplete).toBe(true);
  }
  await closeStorage(page);

  // Real worklet capture, native storage, reload and WAV download prove that
  // the apparent zero is not being used to prevent the user from recording.
  await page.getByTestId('record-all-loops').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'recording');
  await page.waitForTimeout(700);
  await page.getByTestId('stop').click();
  await expect(page.locator('#app')).toHaveAttribute('data-capture-state', 'idle');
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  await page.reload();
  await expect(page.locator('[data-ref="recent-recording"]')).toContainText('Loop recording 1');
  const capturedWav = await download(page, () => page.locator('[data-ref="recent-recording"]').getByRole('button', { name: 'Download Loop recording 1', exact: true }).click());
  const capturedPCM = pcm(capturedWav);
  expect(capturedPCM.length / 8).toBeGreaterThan(RATE * .5);
  expect([...new Float32Array(capturedPCM.buffer.slice(capturedPCM.byteOffset, capturedPCM.byteOffset + capturedPCM.byteLength))].some(sample => Math.abs(sample) > .005)).toBe(true);
  await openStorage(page); await assertUnknownCapacity(page);
  const sourceWav = await download(page, () => row(page, fixture.id).locator('[data-action="download-storage-file"]').click());
  expect(hash(pcm(sourceWav))).toBe(before.sourceHash);
  const afterRecording = await snapshot(page, fixture);
  expect(afterRecording.sourceHash).toBe(before.sourceHash); expect(afterRecording.sourceBytes).toBe(ORIGINAL_BYTES);
  expect(afterRecording.files).toHaveLength(2); expect(afterRecording.project.performances).toHaveLength(1);

  browser.setEstimate({ quota: 10 * 1024 ** 3, usage: 5 * 1024 ** 3 });
  previous = await page.evaluate(() => window.__storageChecks.length);
  await dialog(page).getByRole('button', { name: 'Refresh', exact: true }).click(); await awaitNewCheck(page, previous);
  await expect(page.getByTestId('storage-remaining')).toHaveAttribute('data-bytes', String(5 * 1024 ** 3));
  await expect(dialog(page).locator('.storage-accounting')).toContainText((10 * 1024 ** 3).toLocaleString('en-US'));
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.getByTestId('check-storage').scrollIntoViewIfNeeded();
  const bounds = await page.getByTestId('check-storage').boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44); expect(bounds.height).toBeGreaterThanOrEqual(44);
  const screenshot = testInfo.outputPath('review-storage-diagnostic-phone.png');
  await page.screenshot({ path: screenshot, animations: 'disabled' });
  await testInfo.attach('storage-diagnostic-phone', { path: screenshot, contentType: 'image/png' });
  await testInfo.attach('zero-headroom-native-recording-evidence', { body: JSON.stringify({ originalBytes: ORIGINAL_BYTES, originalHash: before.sourceHash,
    unchangedHashAfterChecksAndRecording: afterRecording.sourceHash, capturedFrames: capturedPCM.length / 8, checks }, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});

test('a native temporary-write quota error is reported without deleting the remaining recording or blocking its download', async ({ page, context }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await environment(page, context, { estimate: { quota: 2 * 1024 ** 3, usage: 2 * 1024 ** 3 }, failDiagnosticWrite: true });
  const fixture = await seed(page, context);
  await page.goto('./'); await expect(page.locator('.loop-card[data-track-id]')).toHaveCount(1);
  await expect(page.locator('[data-ref="save-state"]')).toContainText(/saved/i);
  const before = await snapshot(page, fixture);
  await openStorage(page, 'quota-exceeded'); await assertUnknownCapacity(page);
  await expect(health(page)).toContainText(/refused|blocked|quota/i);
  await expect(dialog(page).getByRole('button', { name: 'Backup current project', exact: true })).toBeEnabled();
  await expect(row(page, fixture.id)).toHaveAttribute('data-file-bytes', String(ORIGINAL_BYTES));
  expect(await snapshot(page, fixture)).toEqual(before);
  const sourceWav = await download(page, () => row(page, fixture.id).locator('[data-action="download-storage-file"]').click());
  expect(hash(pcm(sourceWav))).toBe(before.sourceHash);
  const backup = await download(page, () => dialog(page).getByRole('button', { name: 'Backup current project', exact: true }).click());
  expect(backup.subarray(0, 8).toString()).toBe('FMLPACK\n');
  const manifestLength = Number(backup.readBigUInt64LE(16)), manifest = JSON.parse(backup.subarray(64, 64 + manifestLength).toString());
  expect(manifest.assets).toHaveLength(1);
  const source = manifest.assets[0];
  expect(source.id).toBe(fixture.id); expect(source.bytes).toBe(ORIGINAL_BYTES);
  expect(hash(backup.subarray(64 + manifestLength + source.offset, 64 + manifestLength + source.offset + source.bytes))).toBe(before.sourceHash);
  await openStorage(page, 'quota-exceeded');
  const check = (await page.evaluate(() => window.__storageChecks)).at(-1);
  expect(check.status).toBe('quota-exceeded'); expect(check.cleanupComplete).toBe(true); expect(check.bytesVerified).toBe(0);
  expect(await snapshot(page, fixture)).toEqual(before);
  await testInfo.attach('native-write-refusal-preserves-recording', { body: JSON.stringify({ check, originalHash: before.sourceHash, originalBytes: before.sourceBytes }, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]);
});
