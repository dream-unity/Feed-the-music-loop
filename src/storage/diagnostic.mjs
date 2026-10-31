import { PAGE_FRAMES, describePage, makeAsset, storageError } from './core.mjs';

// One ordinary stereo recording page. This is a write-health check, never a
// capacity benchmark: success does not establish how much space is available.
export const STORAGE_CHECK_BYTES = PAGE_FRAMES * 2 * 4;
const errorDetail = error => ({ name: error?.name || 'Error', code: error?.name === 'QuotaExceededError' ? 'QUOTA_EXCEEDED' : error?.code || error?.name || 'STORAGE_CHECK_FAILED', message: error?.message || String(error) });
const diagnosticFile = /^(storage-check-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.pcm$/i;

async function previousTemporaryAsset(backend) {
  // Read persisted ownership, not controller memory: a reload must not produce
  // more temporary files when an earlier check could not finish cleaning up.
  const assets = await backend.all('assets');
  const previous = assets.find(asset => asset.kind === 'diagnostic');
  if (previous) return previous.id;
  const indexedIds = new Set(assets.map(asset => asset.id));
  if (backend.directory) {
    for await (const [name, handle] of backend.directory.entries()) {
      const match = handle.kind === 'file' && diagnosticFile.exec(name);
      if (match && !indexedIds.has(match[1])) return match[1];
    }
  }
  return null;
}

async function unusedId(backend) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `storage-check-${crypto.randomUUID()}`;
    if (await backend.getAsset(id) || await backend.getPage(id, 0)) continue;
    if (backend.directory) {
      try { await backend.directory.getFileHandle(`${id}.pcm`); continue; }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    return id;
  }
  throw storageError('STORAGE_CHECK_ID_CONFLICT', 'A temporary storage-check identifier could not be reserved. No recording was changed.');
}

export async function runStorageWriteCheck(backend) {
  const result = { checkedAt: Date.now(), backend: backend.backend, status: 'failed', testedBytes: STORAGE_CHECK_BYTES, bytesVerified: 0, cleanupComplete: true };
  try {
    await backend.withMaintenance(async () => {
      const previous = await previousTemporaryAsset(backend);
      if (previous) {
        const error = errorDetail(storageError('STORAGE_CHECK_CLEANUP_REQUIRED', 'A temporary file from an earlier storage check still exists. Remove that specific item in Storage before checking again. No new test file was written.'));
        result.cleanupComplete = false; result.temporaryAssetId = previous; result.error = error; result.cleanupError = error;
        return;
      }
      const id = await unusedId(backend);
      const asset = makeAsset({ id, projectId: id, name: 'Temporary storage check', kind: 'diagnostic', sampleRate: 48000, channels: 2 }, backend.backend);
      let owned = true;
      try {
        // The encompassing maintenance lease keeps orphan cleanup from racing
        // the temporary file/index. No project or existing asset is modified.
        await backend.createAssetRecord(asset);
        const random = new Uint32Array(PAGE_FRAMES), samples = new Float32Array(PAGE_FRAMES * 2);
        for (let channel = 0; channel < 2; channel++) {
          crypto.getRandomValues(random);
          for (let frame = 0; frame < PAGE_FRAMES; frame++) samples[frame * 2 + channel] = (random[frame] >>> 8) / 16777216 - .5;
        }
        const page = describePage(asset, 0, samples.buffer, PAGE_FRAMES, 2);
        await backend.writeData(asset, page, samples.buffer);
        await backend.flush(asset);
        const complete = { ...asset, frames: PAGE_FRAMES, checkpointFrames: PAGE_FRAMES, pageCount: 1, byteLength: STORAGE_CHECK_BYTES, updatedAt: Date.now() };
        await backend.commitPage(complete, page, samples.buffer);
        await backend.finishAsset({ ...complete, status: 'complete', finishedAt: Date.now() });
        // Read persisted metadata and re-open the audio after the writing handle
        // closed. A successful write call alone is insufficient evidence.
        const stored = await backend.getAsset(id), storedPage = await backend.getPage(id, 0);
        if (!stored || stored.id !== id || stored.projectId !== id || stored.kind !== 'diagnostic' || stored.status !== 'complete'
          || stored.backend !== asset.backend || stored.frames !== PAGE_FRAMES || stored.checkpointFrames !== PAGE_FRAMES || stored.pageCount !== 1
          || stored.channels !== 2 || stored.sampleRate !== 48000 || stored.byteLength !== STORAGE_CHECK_BYTES
          || !storedPage || storedPage.assetId !== id || storedPage.index !== 0 || storedPage.offset !== 0 || storedPage.frames !== PAGE_FRAMES
          || storedPage.channels !== 2 || storedPage.byteLength !== STORAGE_CHECK_BYTES || storedPage.crc32 !== page.crc32) {
          throw storageError('STORAGE_CHECK_METADATA', 'The temporary storage-check metadata could not be read back correctly.');
        }
        const read = await backend.readData(stored, storedPage), actual = new Uint8Array(read), expected = new Uint8Array(samples.buffer);
        if (actual.byteLength !== expected.byteLength || actual.some((value, index) => value !== expected[index])) throw storageError('STORAGE_CHECK_MISMATCH', 'The temporary storage-check audio did not match the saved bytes.');
        result.bytesVerified = STORAGE_CHECK_BYTES; result.status = 'passed';
      } catch (error) {
        // An identifier conflict means this operation did not own that asset.
        if (error.code === 'ASSET_EXISTS') owned = false;
        result.error = errorDetail(error); result.status = result.error.code === 'QUOTA_EXCEEDED' ? 'quota-exceeded' : 'failed';
      } finally {
        if (owned) {
          try {
            backend.closeHandle(id);
            if (asset.backend === 'opfs') {
              try { await backend.directory.removeEntry(`${id}.pcm`); }
              catch (error) { if (error.name !== 'NotFoundError') throw error; }
            }
            // A failed physical removal keeps its index discoverable. If the
            // initial metadata write failed, this also cleans any lone page.
            await backend.removeAssetMetadata(id);
          } catch (error) {
            result.cleanupComplete = false; result.cleanupError = errorDetail(error); result.temporaryAssetId = id;
            if (result.status === 'passed') { result.status = 'failed'; result.error = result.cleanupError; }
          }
        }
      }
    });
  } catch (error) { result.error = errorDetail(error); result.status = result.error.code === 'QUOTA_EXCEEDED' ? 'quota-exceeded' : 'failed'; }
  result.checkedAt = Date.now();
  return result;
}
