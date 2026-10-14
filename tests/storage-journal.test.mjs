import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetJournal, FairQueue, PAGE_FRAMES, crc32 } from '../src/storage/core.mjs';

class MemoryDisk {
  constructor() { this.backend = 'opfs'; this.assets = new Map(); this.pages = new Map(); this.files = new Map(); this.events = []; this.failAt = null; }
  fail(operation) { this.events.push(operation); if (this.failAt === operation) throw new Error(`Injected ${operation} failure`); }
  async getAsset(id) { return structuredClone(this.assets.get(id)); }
  async createAsset(asset) { this.assets.set(asset.id, structuredClone(asset)); this.files.set(asset.id, new Uint8Array()); }
  async getPage(id, index) { return structuredClone(this.pages.get(`${id}:${index}`)); }
  async listPages(id) { return [...this.pages.values()].filter((p) => p.assetId === id).map((p) => structuredClone(p)).sort((a, b) => a.index - b.index); }
  async writeData(asset, page, buffer) {
    this.fail('write');
    const old = this.files.get(asset.id), next = new Uint8Array(Math.max(old.length, page.offset + page.byteLength));
    next.set(old); next.set(new Uint8Array(buffer, 0, page.byteLength), page.offset); this.files.set(asset.id, next);
  }
  async flush() { this.fail('flush'); }
  async commitPage(asset, page) { this.fail('checkpoint'); this.pages.set(`${asset.id}:${page.index}`, structuredClone(page)); this.assets.set(asset.id, structuredClone(asset)); }
  async finishAsset(asset) { this.fail('seal'); this.assets.set(asset.id, structuredClone(asset)); }
  async recoverAsset(asset) { this.assets.set(asset.id, structuredClone(asset)); }
  async readData(asset, page) { return this.files.get(asset.id).slice(page.offset, page.offset + page.byteLength).buffer; }
}
const metadata = { id: 'audio-1', projectId: 'project-1', channels: 1, sampleRate: 48000, kind: 'loop' };
const samples = (frames, channels = 1, fill = 0.25) => new Float32Array(frames * channels).fill(fill).buffer;
async function setup() { const disk = new MemoryDisk(), journal = new AssetJournal(disk); await journal.begin(metadata); return { disk, journal }; }

test('CRC32 matches independently known reference vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});
test('a page is acknowledged only after audio flush and metadata checkpoint', async () => {
  const { disk, journal } = await setup();
  await journal.write(metadata.id, 0, samples(PAGE_FRAMES), PAGE_FRAMES, 1);
  assert.deepEqual(disk.events, ['write', 'flush', 'checkpoint']);
  assert.equal((await journal.get(metadata.id)).checkpointFrames, PAGE_FRAMES);
  assert.equal((await journal.read(metadata.id, 0)).buffer.byteLength, PAGE_FRAMES * 4);
});
for (const failAt of ['write', 'flush', 'checkpoint']) {
  test(`${failAt} failure never advances the saved prefix`, async () => {
    const { disk, journal } = await setup();
    await journal.write(metadata.id, 0, samples(PAGE_FRAMES), PAGE_FRAMES, 1);
    disk.failAt = failAt;
    await assert.rejects(journal.write(metadata.id, 1, samples(PAGE_FRAMES), PAGE_FRAMES, 1), /Injected/);
    assert.equal((await journal.get(metadata.id)).checkpointFrames, PAGE_FRAMES);
    disk.failAt = null;
    // A fresh journal models termination of the entire JS worker.
    const recovered = await new AssetJournal(disk).recover(metadata.id);
    assert.equal(recovered.frames, PAGE_FRAMES);
    assert.equal(recovered.status, 'interrupted');
  });
}
test('duplicate retries are idempotent and conflicting retries fail', async () => {
  const { journal } = await setup();
  await journal.write(metadata.id, 0, samples(PAGE_FRAMES), PAGE_FRAMES, 1);
  assert.equal((await journal.write(metadata.id, 0, samples(PAGE_FRAMES), PAGE_FRAMES, 1)).duplicate, true);
  await assert.rejects(journal.write(metadata.id, 0, samples(PAGE_FRAMES, 1, 0.5), PAGE_FRAMES, 1), { code: 'PAGE_CONFLICT' });
  assert.equal((await journal.get(metadata.id)).frames, PAGE_FRAMES);
});
test('missing pages, invalid PCM, channel mismatch and partial interior pages are rejected', async () => {
  const { journal } = await setup();
  await assert.rejects(journal.write(metadata.id, 1, samples(20), 20, 1), { code: 'PAGE_GAP' });
  await assert.rejects(journal.write(metadata.id, 0, samples(20, 1, NaN), 20, 1), { code: 'INVALID_SAMPLE' });
  await assert.rejects(journal.write(metadata.id, 0, samples(20, 2), 20, 2), { code: 'INVALID_PAGE' });
  await journal.write(metadata.id, 0, samples(20), 20, 1);
  await assert.rejects(journal.write(metadata.id, 1, samples(20), 20, 1), { code: 'PAGE_GAP' });
});
test('pooled buffer padding never becomes part of the audio file', async () => {
  const { disk, journal } = await setup();
  const pool = samples(PAGE_FRAMES, 2);
  await journal.write(metadata.id, 0, pool, 17, 1);
  const finished = await journal.finish(metadata.id, { frames: 17 });
  assert.equal(finished.byteLength, 68); assert.equal(disk.files.get(metadata.id).length, 68);
  assert.equal((await journal.read(metadata.id, 0)).buffer.byteLength, 68);
});
test('seal mismatch preserves exact durable frames as interrupted, never false complete', async () => {
  const { journal } = await setup();
  await journal.write(metadata.id, 0, samples(117), 117, 1);
  const finished = await journal.finish(metadata.id, { frames: 118, status: 'complete' });
  assert.equal(finished.frames, 117); assert.equal(finished.status, 'interrupted');
  assert.match(finished.error, /117 frames/);
  assert.deepEqual(await journal.finish(metadata.id, { frames: 117 }), finished);
  await assert.rejects(journal.write(metadata.id, 1, samples(10), 10, 1), { code: 'ASSET_IMMUTABLE' });
});
test('crash during finalization recovers a fully flushed final partial page', async () => {
  const { disk, journal } = await setup();
  await journal.write(metadata.id, 0, samples(PAGE_FRAMES), PAGE_FRAMES, 1);
  await journal.write(metadata.id, 1, samples(73), 73, 1);
  disk.failAt = 'seal';
  await assert.rejects(journal.finish(metadata.id, { frames: PAGE_FRAMES + 73 }));
  disk.failAt = null;
  const recovered = await new AssetJournal(disk).recover(metadata.id);
  assert.equal(recovered.frames, PAGE_FRAMES + 73); assert.equal(recovered.status, 'interrupted');
});
test('truncated disk at every position of a partial page returns only whole verified pages', async () => {
  const { disk, journal } = await setup();
  await journal.write(metadata.id, 0, samples(PAGE_FRAMES), PAGE_FRAMES, 1);
  await journal.write(metadata.id, 1, samples(67), 67, 1);
  const originalFile = disk.files.get(metadata.id).slice();
  const originalAsset = structuredClone(disk.assets.get(metadata.id));
  for (let missing = 1; missing <= 268; missing++) {
    disk.assets.set(metadata.id, structuredClone(originalAsset));
    disk.files.set(metadata.id, originalFile.slice(0, originalFile.length - missing));
    const recovered = await new AssetJournal(disk).recover(metadata.id);
    assert.equal(recovered.frames, PAGE_FRAMES, `truncation ${missing}`);
    assert.equal(recovered.pageCount, 1);
  }
});
test('damaged interior page excludes that page and all later pages', async () => {
  const { disk, journal } = await setup();
  for (let i = 0; i < 3; i++) await journal.write(metadata.id, i, samples(PAGE_FRAMES), PAGE_FRAMES, 1);
  disk.files.get(metadata.id)[PAGE_FRAMES * 4 + 91] ^= 4;
  await assert.rejects(journal.read(metadata.id, 1), { code: 'CORRUPT_PAGE' });
  const recovered = await new AssetJournal(disk).recover(metadata.id);
  assert.equal(recovered.frames, PAGE_FRAMES); assert.equal(recovered.status, 'interrupted');
  assert.equal(disk.files.get(metadata.id).length, PAGE_FRAMES * 12, 'original damaged bytes retained');
  const reopened = new AssetJournal(disk);
  assert.equal((await reopened.read(metadata.id, 2)).missing, true);
});
test('future capture pages are retryable misses while finished out-of-range pages are final misses', async () => {
  const { journal } = await setup();
  assert.deepEqual(await journal.read(metadata.id, 0), { missing: true, retryable: true, assetId: metadata.id, index: 0 });
  await journal.finish(metadata.id, { frames: 0 });
  assert.equal((await journal.read(metadata.id, 0)).retryable, false);
});
test('fair queue interleaves reads while writes retain order and bounded admission', async () => {
  const queue = new FairQueue({ maxWrites: 3, maxBytes: 30 });
  let unblock; const wait = new Promise((resolve) => { unblock = resolve; }); const order = [];
  const promises = [queue.add(async () => { order.push('w0'); await wait; }, { bytes: 10 })];
  promises.push(queue.add(() => order.push('w1'), { bytes: 10 }));
  promises.push(queue.add(() => order.push('w2'), { bytes: 10 }));
  await assert.rejects(queue.add(() => {}, { bytes: 1 }), { code: 'STORAGE_BACKPRESSURE' });
  for (let i = 0; i < 5; i++) promises.push(queue.add(() => order.push(`r${i}`), { read: true }));
  unblock(); await Promise.all(promises);
  assert.deepEqual(order, ['w0', 'r0', 'r1', 'w1', 'r2', 'r3', 'w2', 'r4']);
  assert.equal(queue.stats.queuedBytes, 0);
});
