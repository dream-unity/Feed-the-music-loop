import { test, expect } from '@playwright/test';

// This same-origin test worker is supplied by the remote browser test route.
// The app's CSP intentionally disallows Blob workers. No production module or
// runtime capability switch is modified to select the IndexedDB fallback.
const bootstrap = `
const earlyMessages = [];
const holdMessage = event => { earlyMessages.push(event.data); event.stopImmediatePropagation(); };
self.addEventListener('message', holdMessage);
Object.defineProperty(navigator.storage, 'getDirectory', {
  configurable: true,
  value: async () => { throw new DOMException('OPFS unavailable in this test worker', 'NotSupportedError'); },
});
const chosenAsset = new URL(self.location.href).searchParams.get('abortAsset');
const transactions = new WeakMap();
const nativePut = IDBObjectStore.prototype.put;
let injected = false;
IDBObjectStore.prototype.put = function(value, ...args) {
  const transaction = this.transaction;
  if (!injected && chosenAsset && this.name === 'pages' && value.assetId === chosenAsset && value.index === 1) {
    transactions.set(transaction, { assetId: value.assetId, index: value.index, pageSucceeded: false });
  }
  const request = nativePut.call(this, value, ...args);
  const pending = transactions.get(transaction);
  if (pending && this.name === 'pages') request.addEventListener('success', () => { pending.pageSucceeded = true; }, { once: true });
  if (pending && this.name === 'assets') request.addEventListener('success', () => {
    // Both writes have succeeded inside the transaction. Abort before commit
    // so an atomic backend must roll back the audio page AND its checkpoint.
    injected = true;
    transaction.abort();
    self.postMessage({ type: 'ci-page-transaction-aborted', ...pending, assetSucceeded: true,
      checkpointFrames: value.checkpointFrames, stores: Array.from(transaction.objectStoreNames) });
  }, { once: true });
  return request;
};
const productionWorkerPath = './src/storage/worker.mjs';
await import(new URL(productionWorkerPath, self.location.href).href);
self.removeEventListener('message', holdMessage);
for (const data of earlyMessages) self.onmessage({ data });
`;

test('native IndexedDB fallback preserves stereo PCM, rolls back aborted checkpoints, recovers and isolates deletion', async ({ page, context }, testInfo) => {
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await context.route('**/__ci-indexeddb-worker.mjs*', route => route.fulfill({ status: 200, contentType: 'application/javascript', body: bootstrap }));
  await page.goto('./');
  await expect(page.getByTestId('add-loop')).toBeEnabled();

  const result = await page.evaluate(async () => {
    // These paths resolve in the served page/worker, not beside this Node spec.
    const storageModulePath = './src/storage/client.mjs', projectModulePath = './src/project.mjs', wavModulePath = './src/export/wav.mjs';
    const fixtureWorkerPath = './__ci-indexeddb-worker.mjs';
    const { StorageClient } = await import(storageModulePath);
    const { createProject, PAGE_FRAMES } = await import(projectModulePath);
    const { exportWavParts } = await import(wavModulePath);
    const project = createProject('Native fallback transaction test');
    const neighbor = createProject('Fallback neighbor must survive');
    const completeId = `fallback_complete_${crypto.randomUUID()}`;
    const interruptedId = `fallback_interrupted_${crypto.randomUUID()}`;
    const neighborId = `fallback_neighbor_${crypto.randomUUID()}`;
    const injected = [], workerErrors = [];
    const makeClient = abortAsset => new StorageClient({ workerFactory: () => {
      const url = new URL(fixtureWorkerPath, location.href);
      if (abortAsset) url.searchParams.set('abortAsset', abortAsset);
      const worker = new Worker(url, { type: 'module' });
      worker.addEventListener('message', event => { if (event.data?.type === 'ci-page-transaction-aborted') injected.push(event.data); });
      worker.addEventListener('error', event => workerErrors.push(event.message));
      return worker;
    } });
    const pcm = (frames, start = 0) => Float32Array.from({ length: frames * 2 }, (_, index) => {
      const frame = start + Math.floor(index / 2);
      return index % 2 === 0 ? ((frame % 257) - 128) / 256 : ((frame % 131) - 65) / 128;
    });
    const exact = (buffer, expected) => {
      const actual = new Float32Array(buffer);
      return actual.length === expected.length && actual.every((sample, index) => sample === expected[index]);
    };
    // Inspect committed native data, independently of the journal's memory.
    const nativeSnapshot = async assetId => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('feed-the-music-loop-v1', 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction(['assets', 'pages'], 'readonly');
          const asset = transaction.objectStore('assets').get(assetId);
          const pages = transaction.objectStore('pages').index('assetId').getAll(IDBKeyRange.only(assetId));
          transaction.oncomplete = () => resolve({ asset: asset.result || null, pages: pages.result.map(({ index, frames, channels, buffer }) => ({ index, frames, channels, bytes: buffer.byteLength })) });
          transaction.onabort = () => reject(transaction.error || new Error('Snapshot transaction aborted'));
        });
      } finally { db.close(); }
    };

    let first = makeClient(interruptedId), second;
    try {
      const initial = await first.init();
      await first.saveProject(project);
      await first.beginAsset({ id: completeId, projectId: project.id, sampleRate: 48000, channels: 2, kind: 'master', name: 'Full and partial stereo pages' });
      const tailFrames = 137;
      const full = pcm(PAGE_FRAMES), tail = pcm(tailFrames, PAGE_FRAMES);
      const firstAck = await first.putPage(completeId, 0, full.slice().buffer, PAGE_FRAMES, 2);
      const tailAck = await first.putPage(completeId, 1, tail.slice().buffer, tailFrames, 2);
      const sealed = await first.finishAsset(completeId, { frames: PAGE_FRAMES + tailFrames });
      const page0 = await first.readPage(completeId, 0), page1 = await first.readPage(completeId, 1);
      const completePCM = await (await first.getAssetFile(completeId)).arrayBuffer();
      const complete = {
        firstCheckpoint: firstAck.checkpointFrames, finalCheckpoint: tailAck.checkpointFrames,
        status: sealed.status, frames: sealed.frames, channels: sealed.channels,
        fullPageExact: exact(page0.buffer, full), partialPageExact: exact(page1.buffer, tail),
        fileExact: exact(completePCM, pcm(PAGE_FRAMES + tailFrames)), byteLength: completePCM.byteLength,
      };
      const ranges = [];
      for (const range of [
        { startFrame: 5, frames: 31 },
        { startFrame: PAGE_FRAMES - 17, frames: tailFrames + 17 },
        { startFrame: PAGE_FRAMES + 100, frames: 37 },
        { startFrame: PAGE_FRAMES + tailFrames, frames: 0 },
      ]) {
        const blob = await first.getAssetRange(completeId, range);
        ranges.push({ ...range, bytes: blob.size, exact: exact(await blob.arrayBuffer(), pcm(range.frames, range.startFrame)) });
      }

      // Force only the whole-file export limit, then use the REAL native page
      // range API and REAL WAV generator. This tests the long-recording route
      // with a small fixture rather than allocating a 130 MiB test recording.
      const requestedRanges = [], waveParts = [], wavePayloads = [];
      let wholeFileAttempts = 0;
      const rangeStorage = {
        getAsset: id => first.getAsset(id),
        getAssetFile: async () => { wholeFileAttempts++; throw Object.assign(new Error('Whole-file fallback limit'), { code: 'FALLBACK_EXPORT_LIMIT' }); },
        getAssetRange: (id, range) => { requestedRanges.push({ ...range }); return first.getAssetRange(id, range); },
      };
      const maxPartFrames = PAGE_FRAMES - 17;
      for await (const part of exportWavParts(rangeStorage, completeId, { name: 'Native fallback stereo', maxDataBytes: maxPartFrames * 8 + 3 })) {
        const buffer = await part.blob.arrayBuffer(), view = new DataView(buffer);
        const text = (offset, length) => new TextDecoder().decode(new Uint8Array(buffer, offset, length));
        let format, factFrames, payloadOffset, payloadBytes;
        for (let offset = 12; offset + 8 <= buffer.byteLength;) {
          const chunk = text(offset, 4), length = view.getUint32(offset + 4, true);
          if (offset + 8 + length > buffer.byteLength) throw new Error('WAV chunk exceeds the generated file');
          if (chunk === 'fmt ') format = { encoding: view.getUint16(offset + 8, true), channels: view.getUint16(offset + 10, true), rate: view.getUint32(offset + 12, true), align: view.getUint16(offset + 20, true), bits: view.getUint16(offset + 22, true) };
          if (chunk === 'fact') factFrames = view.getUint32(offset + 8, true);
          if (chunk === 'data') { payloadOffset = offset + 8; payloadBytes = length; }
          offset += 8 + length + (length % 2);
        }
        if (payloadOffset === undefined) throw new Error('Generated WAV has no audio data');
        const payload = buffer.slice(payloadOffset, payloadOffset + payloadBytes);
        wavePayloads.push(payload);
        waveParts.push({ part: part.part, count: part.partCount, startFrame: part.startFrame, frames: part.frames,
          filename: part.filename, riffValid: text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE' && view.getUint32(4, true) + 8 === buffer.byteLength,
          format, factFrames, dataFrames: payloadBytes / 8, exact: exact(payload, pcm(part.frames, part.startFrame)) });
      }
      const rangedWav = { wholeFileAttempts, requestedRanges, parts: waveParts, reconstructedExact: exact(await new Blob(wavePayloads).arrayBuffer(), pcm(PAGE_FRAMES + tailFrames)) };

      await first.beginAsset({ id: interruptedId, projectId: project.id, sampleRate: 48000, channels: 2, kind: 'master', name: 'Interrupted native transaction' });
      await first.putPage(interruptedId, 0, full.slice().buffer, PAGE_FRAMES, 2);
      let writeError = null;
      try { await first.putPage(interruptedId, 1, tail.slice().buffer, tailFrames, 2); }
      catch (error) { writeError = { name: error.name, code: error.code }; }
      const committed = await nativeSnapshot(interruptedId);
      // Disposal leaves the unfinalized checkpoint for a fresh worker to verify.
      await first.dispose();
      second = makeClient(); const reopened = await second.init();
      const reopenedCompleteExact = exact(await (await second.getAssetFile(completeId)).arrayBuffer(), pcm(PAGE_FRAMES + tailFrames));
      const recovered = await second.recover(project.id);
      const recoveredAsset = await second.getAsset(interruptedId);
      const recoveredPCM = await (await second.getAssetFile(interruptedId)).arrayBuffer();
      const absentTail = await second.readPage(interruptedId, 1);
      const recovery = {
        reopenedCompleteExact,
        found: recovered.some(asset => asset.id === interruptedId),
        status: recoveredAsset.status, frames: recoveredAsset.frames, pageCount: recoveredAsset.pageCount,
        exactPrefix: exact(recoveredPCM, full), tailMissing: absentTail.missing, tailRetryable: absentTail.retryable,
      };

      await second.saveProject(neighbor);
      await second.beginAsset({ id: neighborId, projectId: neighbor.id, sampleRate: 48000, channels: 2, kind: 'master', name: 'Neighbor stereo' });
      const neighborPCM = pcm(71, 400);
      await second.putPage(neighborId, 0, neighborPCM.slice().buffer, 71, 2);
      await second.finishAsset(neighborId, { frames: 71 });
      await second.deleteAsset(completeId);
      const deletedAsset = await nativeSnapshot(completeId);
      const prefixSurvivedAssetDeletion = exact(await (await second.getAssetFile(interruptedId)).arrayBuffer(), full);
      const softDeleted = await second.deleteProject(project.id);
      const softDeleteKeptAudio = exact(await (await second.getAssetFile(interruptedId)).arrayBuffer(), full);
      const purged = await second.purgeProject(project.id);
      const purgedAsset = await nativeSnapshot(interruptedId);
      const remainingProject = await second.loadProject(project.id);
      const repeated = await second.purgeProject(project.id);
      const isolation = {
        deletedAssetAbsent: !deletedAsset.asset && deletedAsset.pages.length === 0,
        prefixSurvivedAssetDeletion, softDeleteRetained: softDeleted.audioRetained && softDeleteKeptAudio,
        deletedAssets: purged.deletedAssets, repeatDeletedAssets: repeated.deletedAssets,
        purgedMetadataAbsent: !purgedAsset.asset && purgedAsset.pages.length === 0 && !remainingProject,
        neighborName: (await second.loadProject(neighbor.id)).name,
        neighborExact: exact(await (await second.getAssetFile(neighborId)).arrayBuffer(), neighborPCM),
      };
      await second.purgeProject(neighbor.id);
      return {
        backends: [initial.backend, reopened.backend], workerErrors, complete, ranges, rangedWav,
        injected: injected.map(({ type, assetId, ...details }) => details), writeError,
        rollback: { frames: committed.asset.frames, checkpointFrames: committed.asset.checkpointFrames, pageCount: committed.asset.pageCount, status: committed.asset.status, pages: committed.pages },
        recovery, isolation,
      };
    } finally { await first.dispose(); await second?.dispose(); }
  });

  await testInfo.attach('native-indexeddb-fallback-evidence', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(runtimeErrors).toEqual([]);
  expect(result.backends).toEqual(['indexeddb', 'indexeddb']);
  expect(result.workerErrors).toEqual([]);
  expect(result.complete).toEqual({ firstCheckpoint: 16384, finalCheckpoint: 16521, status: 'complete', frames: 16521, channels: 2, fullPageExact: true, partialPageExact: true, fileExact: true, byteLength: 16521 * 8 });
  expect(result.ranges).toEqual([
    { startFrame: 5, frames: 31, bytes: 248, exact: true },
    { startFrame: 16367, frames: 154, bytes: 1232, exact: true },
    { startFrame: 16484, frames: 37, bytes: 296, exact: true },
    { startFrame: 16521, frames: 0, bytes: 0, exact: true },
  ]);
  expect(result.rangedWav).toEqual({
    wholeFileAttempts: 1,
    requestedRanges: [{ startFrame: 0, frames: 16367 }, { startFrame: 16367, frames: 154 }],
    parts: [
      { part: 1, count: 2, startFrame: 0, frames: 16367, filename: 'Native fallback stereo-part-1.wav', riffValid: true,
        format: { encoding: 3, channels: 2, rate: 48000, align: 8, bits: 32 }, factFrames: 16367, dataFrames: 16367, exact: true },
      { part: 2, count: 2, startFrame: 16367, frames: 154, filename: 'Native fallback stereo-part-2.wav', riffValid: true,
        format: { encoding: 3, channels: 2, rate: 48000, align: 8, bits: 32 }, factFrames: 154, dataFrames: 154, exact: true },
    ],
    reconstructedExact: true,
  });
  expect(result.injected).toEqual([{ index: 1, pageSucceeded: true, assetSucceeded: true, checkpointFrames: 16521, stores: ['assets', 'pages'] }]);
  expect(result.writeError?.code).toBe('TRANSACTION_ABORTED');
  expect(result.rollback).toEqual({ frames: 16384, checkpointFrames: 16384, pageCount: 1, status: 'recording', pages: [{ index: 0, frames: 16384, channels: 2, bytes: 16384 * 8 }] });
  expect(result.recovery).toEqual({ reopenedCompleteExact: true, found: true, status: 'interrupted', frames: 16384, pageCount: 1, exactPrefix: true, tailMissing: true, tailRetryable: false });
  expect(result.isolation).toEqual({ deletedAssetAbsent: true, prefixSurvivedAssetDeletion: true, softDeleteRetained: true, deletedAssets: 1, repeatDeletedAssets: 0, purgedMetadataAbsent: true, neighborName: 'Fallback neighbor must survive', neighborExact: true });
});
