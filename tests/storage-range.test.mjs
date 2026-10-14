import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBackend } from '../src/storage/backend.mjs';
import { PAGE_FRAMES, MAX_ASSET_RANGE_BYTES, MAX_FALLBACK_FILE_BYTES, describePage } from '../src/storage/core.mjs';

function fixture({ backend = 'indexeddb', frames = PAGE_FRAMES * 3 + 19, channels = 2 } = {}) {
  const disk = new BrowserBackend(), reads = [], asset = { id: 'range-audio', projectId: 'range-project', backend, frames, channels, status: 'complete', byteLength: frames * channels * 4, pageCount: Math.ceil(frames / PAGE_FRAMES) };
  const samples = (start, length) => Float32Array.from({ length: length * channels }, (_, i) => ((start * channels + i) % 101 - 50) / 64);
  const page = index => { const count = Math.min(PAGE_FRAMES, frames - index * PAGE_FRAMES), buffer = samples(index * PAGE_FRAMES, count).buffer; return { ...describePage(asset, index, buffer, count, channels), buffer }; };
  disk.getPage = async (id, index) => { assert.equal(id, asset.id); reads.push(index); return page(index); };
  if (backend === 'opfs') {
    const file = new Blob([samples(0, frames)]);
    disk.directory = { async getFileHandle(name) { assert.equal(name, `${asset.id}.pcm`); return { async getFile() { return file; } }; } };
  }
  return { disk, asset, samples, reads, page };
}

for (const backend of ['indexeddb', 'opfs']) {
  test(`${backend} range exports exact stereo across page edges using only intersecting pages`, async () => {
    const { disk, asset, samples, reads } = fixture({ backend });
    const startFrame = PAGE_FRAMES - 3, frames = PAGE_FRAMES + 10;
    const blob = await disk.getAssetRange(asset, { startFrame, frames });
    assert.equal(blob.size, frames * 8); assert.equal(blob.type, 'application/octet-stream');
    assert.deepEqual(new Float32Array(await blob.arrayBuffer()), samples(startFrame, frames));
    assert.deepEqual(reads, [0, 1, 2]);
    const tail = await disk.getAssetRange(asset, { startFrame: asset.frames - 7, frames: 7 });
    assert.deepEqual(new Float32Array(await tail.arrayBuffer()), samples(asset.frames - 7, 7));
    assert.equal(reads.at(-1), 3);
  });
}

test('large fallback assets can export a small end range without loading the rest of the recording', async () => {
  const frames = MAX_FALLBACK_FILE_BYTES / 8 + 100, { disk, asset, samples, reads } = fixture({ frames });
  await assert.rejects(disk.getAssetFile(asset), { code: 'FALLBACK_EXPORT_LIMIT' });
  const startFrame = frames - 25, blob = await disk.getAssetRange(asset, { startFrame, frames: 25 });
  assert.deepEqual(new Float32Array(await blob.arrayBuffer()), samples(startFrame, 25));
  assert.deepEqual(reads, [Math.floor(startFrame / PAGE_FRAMES)]);
});

test('range validation rejects active, invalid, out of bounds or oversized requests before disk reads', async () => {
  const { disk, asset, reads } = fixture({ frames: MAX_ASSET_RANGE_BYTES / 8 + 10 });
  for (const range of [null, {}, { startFrame: -1, frames: 1 }, { startFrame: 0, frames: 1.5 }, { startFrame: asset.frames, frames: 1 }, { startFrame: 1, frames: Number.MAX_SAFE_INTEGER }]) {
    await assert.rejects(disk.getAssetRange(asset, range), { code: 'INVALID_ASSET_RANGE' });
  }
  await assert.rejects(disk.getAssetRange(asset, { startFrame: 0, frames: MAX_ASSET_RANGE_BYTES / 8 + 1 }), { code: 'ASSET_RANGE_LIMIT' });
  await assert.rejects(disk.getAssetRange({ ...asset, status: 'recording' }, { startFrame: 0, frames: 1 }), { code: 'RECORDING_ACTIVE' });
  assert.deepEqual(reads, []);
  assert.equal((await disk.getAssetRange(asset, { startFrame: asset.frames, frames: 0 })).size, 0);
  assert.deepEqual(reads, []);
});

for (const fault of ['missing', 'checksum', 'offset', 'dimensions']) {
  test(`range refuses ${fault} damage in a required page`, async () => {
    const { disk, asset, page } = fixture();
    disk.getPage = async (id, index) => {
      if (fault === 'missing') return undefined;
      const p = page(index);
      if (fault === 'checksum') new Uint8Array(p.buffer)[0] ^= 1;
      if (fault === 'offset') p.offset += 8;
      if (fault === 'dimensions') p.frames--;
      return p;
    };
    await assert.rejects(disk.getAssetRange(asset, { startFrame: 10, frames: 7 }), { code: fault === 'missing' ? 'MISSING_PAGE' : 'CORRUPT_PAGE' });
  });
}

test('OPFS range checks relevant bytes against the journal and reports a truncated physical file', async () => {
  const { disk, asset } = fixture({ backend: 'opfs' });
  disk.directory = { async getFileHandle() { return { async getFile() { return new Blob([new Uint8Array(asset.byteLength)]); } }; } };
  await assert.rejects(disk.getAssetRange(asset, { startFrame: 1, frames: 1 }), { code: 'CORRUPT_PAGE' });
  disk.directory = { async getFileHandle() { return { async getFile() { return new Blob([new Uint8Array(4)]); } }; } };
  await assert.rejects(disk.getAssetRange(asset, { startFrame: 0, frames: 1 }), { code: 'SHORT_FILE' });
});

test('fallback range Blob remains immutable after page buffers are reused', async () => {
  const { disk, asset, samples, page } = fixture(); const shared = page(0); disk.getPage = async () => shared;
  const blob = await disk.getAssetRange(asset, { startFrame: 5, frames: 9 }); new Float32Array(shared.buffer).fill(0);
  assert.deepEqual(new Float32Array(await blob.arrayBuffer()), samples(5, 9));
});
