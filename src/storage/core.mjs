/** Storage invariants shared by the worker and fault-injection tests. */
export const PAGE_FRAMES = 16384;
export const MAX_FALLBACK_FILE_BYTES = 128 * 1024 * 1024;
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function storageError(code, message) {
  return Object.assign(new Error(message), { name: 'StorageError', code });
}
export function validId(value, label = 'Asset') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) throw storageError('INVALID_ID', `${label} identifier is invalid.`);
  return value;
}
export function makeAsset(input, backend, now = Date.now()) {
  validId(input?.id); validId(input?.projectId, 'Project');
  if (![1, 2].includes(input.channels)) throw storageError('INVALID_CHANNELS', 'Audio must have one or two channels.');
  if (!Number.isInteger(input.sampleRate) || input.sampleRate < 8000 || input.sampleRate > 192000) throw storageError('INVALID_RATE', 'The audio sample rate is invalid.');
  return {
    ...input, id: input.id, projectId: input.projectId, sampleRate: input.sampleRate,
    channels: input.channels, pageFrames: PAGE_FRAMES, backend,
    status: 'recording', frames: 0, checkpointFrames: 0, pageCount: 0,
    byteLength: 0, createdAt: now, updatedAt: now, error: null,
  };
}
export function describePage(asset, index, buffer, frames, channels) {
  if (!(buffer instanceof ArrayBuffer)) throw storageError('INVALID_BUFFER', 'Audio page is missing its sample buffer.');
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isInteger(frames) || frames < 1 || frames > PAGE_FRAMES || channels !== asset.channels) throw storageError('INVALID_PAGE', 'Audio page dimensions are invalid.');
  const byteLength = frames * channels * 4;
  if (buffer.byteLength < byteLength) throw storageError('SHORT_PAGE', 'Audio page is incomplete.');
  const samples = new Float32Array(buffer, 0, frames * channels);
  for (const value of samples) if (!Number.isFinite(value)) throw storageError('INVALID_SAMPLE', 'An audio page contains a non-finite sample.');
  return { assetId: asset.id, index, frames, channels, byteLength, offset: index * PAGE_FRAMES * channels * 4, crc32: crc32(new Uint8Array(buffer, 0, byteLength)) };
}

/**
 * Adapter contract: data writes and flushes MUST precede commitPage's atomic
 * page+asset metadata transaction. A failed commit never advances the prefix.
 * Methods are serialized by the worker; this class deliberately has no timers.
 */
export class AssetJournal {
  constructor(adapter) { this.adapter = adapter; this.assets = new Map(); this.failures = new Map(); }
  async get(id) {
    validId(id);
    if (!this.assets.has(id)) {
      const asset = await this.adapter.getAsset(id);
      if (!asset) throw storageError('ASSET_NOT_FOUND', 'This audio recording could not be found.');
      this.assets.set(id, asset);
    }
    return this.assets.get(id);
  }
  async begin(input) {
    if (await this.adapter.getAsset(input.id)) throw storageError('ASSET_EXISTS', 'An audio recording with this identifier already exists.');
    const asset = makeAsset(input, this.adapter.backend);
    await this.adapter.createAsset(asset);
    this.assets.set(asset.id, asset);
    return { ...asset };
  }
  fail(id, error) { this.failures.set(id, error?.message || String(error)); }
  async write(id, index, buffer, frames, channels) {
    const asset = await this.get(id);
    if (this.failures.has(id)) throw storageError('CAPTURE_INTERRUPTED', this.failures.get(id));
    if (asset.status !== 'recording') throw storageError('ASSET_IMMUTABLE', 'Finished audio cannot be overwritten.');
    const page = describePage(asset, index, buffer, frames, channels);
    if (index < asset.pageCount) {
      const existing = await this.adapter.getPage(id, index);
      if (existing && existing.crc32 === page.crc32 && existing.frames === frames && existing.channels === channels) return { asset: { ...asset }, page: existing, duplicate: true };
      throw storageError('PAGE_CONFLICT', 'A different audio page already occupies this position.');
    }
    if (index !== asset.pageCount || asset.frames !== index * PAGE_FRAMES) throw storageError('PAGE_GAP', 'Audio pages arrived out of sequence. Recording has stopped to preserve the valid prefix.');
    const next = { ...asset, frames: asset.frames + frames, checkpointFrames: asset.frames + frames, pageCount: index + 1, byteLength: asset.byteLength + page.byteLength, updatedAt: Date.now() };
    try {
      await this.adapter.writeData(asset, page, buffer);
      await this.adapter.flush(asset);
      await this.adapter.commitPage(next, page, buffer);
      this.assets.set(id, next);
      return { asset: { ...next }, page };
    } catch (error) { this.fail(id, error); throw error; }
  }
  async finish(id, options = {}) {
    const asset = await this.get(id);
    if (asset.status !== 'recording') return { ...asset };
    const expected = options.frames ?? asset.frames;
    const mismatch = !Number.isSafeInteger(expected) || expected < 0 || expected !== asset.frames;
    const error = this.failures.get(id) || (mismatch ? `Expected ${expected} frames; ${asset.frames} frames were safely checkpointed.` : null);
    const status = error || options.status === 'interrupted' ? 'interrupted' : options.status === 'cancelled' ? 'cancelled' : 'complete';
    const next = { ...asset, ...options, id: asset.id, projectId: asset.projectId, backend: asset.backend, channels: asset.channels, sampleRate: asset.sampleRate, pageFrames: PAGE_FRAMES, frames: asset.frames, checkpointFrames: asset.frames, byteLength: asset.byteLength, pageCount: asset.pageCount, status, error, updatedAt: Date.now(), finishedAt: Date.now() };
    // Each acknowledged page already passed flush+checkpoint. Retrying a failed
    // page's flush here could prevent sealing an otherwise valid saved prefix.
    await this.adapter.finishAsset(next);
    this.assets.set(id, next);
    this.failures.delete(id);
    return { ...next };
  }
  async read(id, index) {
    const asset = await this.get(id);
    if (!Number.isSafeInteger(index) || index < 0) throw storageError('INVALID_PAGE', 'Audio page index is invalid.');
    if (index >= asset.pageCount) return { missing: true, retryable: asset.status === 'recording', assetId: id, index };
    const page = await this.adapter.getPage(id, index);
    if (!page) return { missing: true, retryable: asset.status === 'recording', assetId: id, index };
    const buffer = await this.adapter.readData(asset, page);
    if (buffer.byteLength !== page.byteLength || crc32(new Uint8Array(buffer)) !== page.crc32) throw storageError('CORRUPT_PAGE', 'An audio page failed its integrity check. The original recording has been retained for recovery.');
    return { buffer, frames: page.frames, channels: page.channels, index };
  }
  async recover(id) {
    const asset = await this.get(id);
    const pages = await this.adapter.listPages(id);
    let count = 0, frames = 0, bytes = 0, problem = null;
    for (const page of pages) {
      if (page.index !== count || frames !== count * PAGE_FRAMES || page.channels !== asset.channels || !Number.isInteger(page.frames) || page.frames < 1 || page.frames > PAGE_FRAMES || page.byteLength !== page.frames * asset.channels * 4 || page.offset !== bytes) { problem = 'Non-contiguous audio page metadata.'; break; }
      try {
        const buffer = await this.adapter.readData(asset, page);
        if (buffer.byteLength !== page.byteLength || crc32(new Uint8Array(buffer)) !== page.crc32) { problem = 'An audio page is incomplete or damaged.'; break; }
      } catch (error) { problem = error.message || 'An audio page is unavailable.'; break; }
      frames += page.frames; bytes += page.byteLength; count++;
    }
    if (count !== asset.pageCount || frames !== asset.frames) problem ||= 'The checkpoint and audio pages did not agree.';
    const wasInterrupted = asset.status === 'recording' || Boolean(problem);
    const next = { ...asset, frames, checkpointFrames: frames, pageCount: count, byteLength: bytes,
      status: wasInterrupted ? 'interrupted' : asset.status,
      error: problem || (wasInterrupted ? 'Recording was interrupted before finalization.' : asset.error),
      recoveredAt: Date.now(), updatedAt: Date.now() };
    // Invalid trailing bytes remain available until explicit garbage collection.
    // Only the verified prefix is exposed to the app and exports.
    await this.adapter.recoverAsset(next, count);
    this.assets.set(id, next);
    this.failures.delete(id);
    return { ...next, recovered: wasInterrupted };
  }
}

/** Fair serialized I/O: reads are responsive without starving recording writes. */
export class FairQueue {
  constructor({ maxWrites = 64, maxReads = 1024, maxBytes = 16 * 1024 * 1024 } = {}) {
    this.writes = []; this.reads = []; this.bytes = 0; this.running = false; this.readBurst = 0;
    this.maxWrites = maxWrites; this.maxReads = maxReads; this.maxBytes = maxBytes;
  }
  get stats() { return { pendingWrites: this.writes.length, pendingReads: this.reads.length, queuedBytes: this.bytes, running: this.running }; }
  add(fn, { read = false, bytes = 0 } = {}) {
    const queue = read ? this.reads : this.writes;
    if (queue.length >= (read ? this.maxReads : this.maxWrites) || this.bytes + bytes > this.maxBytes) return Promise.reject(storageError('STORAGE_BACKPRESSURE', 'Storage could not keep up. The verified part of this recording is being preserved.'));
    this.bytes += bytes;
    const promise = new Promise((resolve, reject) => queue.push({ fn, resolve, reject, bytes }));
    this.drain();
    return promise;
  }
  async drain() {
    if (this.running) return;
    this.running = true;
    while (this.writes.length || this.reads.length) {
      const read = this.reads.length && (!this.writes.length || this.readBurst < 2);
      const item = (read ? this.reads : this.writes).shift();
      this.readBurst = read ? this.readBurst + 1 : 0;
      try { item.resolve(await item.fn()); } catch (error) { item.reject(error); }
      finally { this.bytes -= item.bytes; }
    }
    this.running = false;
  }
}
