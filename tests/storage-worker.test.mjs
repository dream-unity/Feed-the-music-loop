import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { AssetJournal, FairQueue, PAGE_FRAMES, storageError, validId } from '../src/storage/core.mjs';

// Executes the actual worker message handler with a fault-injectable disk;
// this is a protocol test, not a substitute for browser OPFS verification.
const workerSource = (await readFile(new URL('../src/storage/worker.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
async function fixture() {
  let backend;
  class Disk {
    constructor() { backend = this; this.backend = 'opfs'; this.assets = new Map(); this.pages = new Map(); this.failSeal = false; }
    async init() { return { backend: this.backend }; }
    async getAsset(id) { return structuredClone(this.assets.get(id)); }
    async createAsset(asset) { this.assets.set(asset.id, structuredClone(asset)); }
    async writeData() {}
    async flush() {}
    async commitPage(asset, page, buffer) { this.assets.set(asset.id, structuredClone(asset)); this.pages.set(`${asset.id}:${page.index}`, { ...page, buffer: buffer.slice(0, page.byteLength) }); }
    async getPage(id, index) { return structuredClone(this.pages.get(`${id}:${index}`)); }
    async readData(asset, page) { return this.pages.get(`${asset.id}:${page.index}`).buffer.slice(0); }
    async finishAsset(asset) { if (this.failSeal) throw Object.assign(new Error('Disk full'), { name: 'QuotaExceededError' }); this.assets.set(asset.id, structuredClone(asset)); }
    async getAssetRange(asset, range) { this.rangeRequest = { id: asset.id, ...range }; return new Blob([new Uint8Array([1, 2, 3, 4])]); }
    async deleteAsset(id) { if (this.failDelete) throw new Error('Deletion failed'); this.assets.delete(id); for (const key of this.pages.keys()) if (key.startsWith(`${id}:`)) this.pages.delete(key); return { id, deleted: true }; }
    async getStorageInventory() { return { files: [...this.assets.values()].map(asset => ({ kind: 'asset', id: asset.id, bytes: asset.byteLength })) }; }
    async checkStorageWrite() { this.writeChecks = (this.writeChecks || 0) + 1; return this.writeCheckResult || { checkedAt: 123, backend: this.backend, status: 'passed', testedBytes: 131072, bytesVerified: 131072, cleanupComplete: true }; }
    async deleteStoredFile(file, { onDetached } = {}) {
      this.deleteFileRequest = file;
      await this.lockProject();
      if (this.failDetach) throw new Error('Manifest save failed');
      onDetached(file.id);
      await this.deleteAsset(file.id);
      return { id: file.id, assetId: file.id, deleted: true, affectedProjectIds: ['project-1'] };
    }
    async lockProject() { if (this.foreignLock) throw storageError('PROJECT_BUSY', 'Another tab owns this project'); }
    async listAssets(projectId) { return [...this.assets.values()].filter(asset => asset.projectId === projectId).map(asset => structuredClone(asset)); }
    async purgeProject(projectId, options, { onDelete } = {}) { this.purgeOptions = options; if (this.sharedProject) throw storageError('PROJECT_AUDIO_SHARED', 'Another project uses this recording'); const assets = await this.listAssets(projectId); onDelete?.(assets); for (const asset of assets) await this.deleteAsset(asset.id); return { purged: true }; }
    closeHandle() {}
    async releaseProject() { this.released = true; }
  }
  const messages = [], pending = new Map(); let id = 0;
  const self = { postMessage(data, transfer = []) {
    const copy = structuredClone(data, { transfer }); messages.push(copy);
    if (copy.type === 'rpc-result') {
      const waiter = pending.get(copy.id); pending.delete(copy.id);
      copy.error ? waiter.reject(Object.assign(new Error(copy.error.message), copy.error)) : waiter.resolve(copy.result);
    }
  } };
  const context = vm.createContext({ self, BrowserBackend: Disk, AssetJournal, FairQueue, PAGE_FRAMES, storageError, validId, ArrayBuffer, Set, Map, Object, Error, navigator: {}, console });
  new vm.Script(workerSource, { filename: 'storage-worker.mjs' }).runInContext(context);
  const rpc = (method, args = []) => new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); self.onmessage({ data: { type: 'rpc', id: requestId, method, args } }); });
  const port = { messages: [], start() {}, close() {}, postMessage(data, transfer = []) { this.messages.push(structuredClone(data, { transfer })); } };
  self.onmessage({ data: { type: 'attach-audio', port } });
  await rpc('init');
  await rpc('beginAsset', [{ id: 'asset-1', projectId: 'project-1', sampleRate: 48000, channels: 1, kind: 'loop' }]);
  return { backend, rpc, messages, port, send: (data) => port.onmessage({ data }) };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); }
  assert.fail('Worker protocol did not finish.');
}

test('direct audio writes, recycled buffers and sealing preserve ordering', async () => {
  const { send, port, backend } = await fixture();
  const first = new Float32Array(PAGE_FRAMES * 2).fill(0.3).buffer;
  const tail = new Float32Array(PAGE_FRAMES * 2).fill(-0.2).buffer;
  send({ type: 'write', assetId: 'asset-1', index: 0, frames: PAGE_FRAMES, channels: 1, buffer: first });
  send({ type: 'write', assetId: 'asset-1', index: 1, frames: 117, channels: 1, buffer: tail });
  send({ type: 'end', assetId: 'asset-1', frames: PAGE_FRAMES + 117, status: 'complete' });
  await until(() => port.messages.some((message) => message.type === 'sealed'));
  const written = port.messages.filter((message) => message.type === 'written');
  assert.deepEqual(written.map((message) => message.index), [0, 1]);
  assert.equal(port.messages.filter((message) => message.type === 'recycle').length, 2);
  assert.equal(first.byteLength, 0); assert.equal(tail.byteLength, 0);
  const sealed = port.messages.find((message) => message.type === 'sealed');
  assert.equal(sealed.finalized, true); assert.equal(sealed.frames, PAGE_FRAMES + 117);
  assert.equal(backend.assets.get('asset-1').frames, PAGE_FRAMES + 117);
});
test('metadata quota failure reports the durable prefix without hanging finalization', async () => {
  const { send, port, backend, messages } = await fixture();
  send({ type: 'write', assetId: 'asset-1', index: 0, frames: 91, channels: 1, buffer: new Float32Array(91).buffer });
  await until(() => port.messages.some((message) => message.type === 'written'));
  backend.failSeal = true;
  send({ type: 'end', assetId: 'asset-1', frames: 91, status: 'complete' });
  await until(() => port.messages.some((message) => message.type === 'sealed'));
  const sealed = port.messages.find((message) => message.type === 'sealed');
  assert.equal(sealed.frames, 91); assert.equal(sealed.finalized, false); assert.equal(sealed.status, 'interrupted');
  assert.equal(port.messages.find((message) => message.type === 'storage-error').code, 'QUOTA_EXCEEDED');
  assert.equal(port.messages.find((message) => message.type === 'storage-error').name, 'QuotaExceededError');
  assert.match(port.messages.find((message) => message.type === 'storage-error').message, /refused a storage write/);
  assert.doesNotMatch(port.messages.find((message) => message.type === 'storage-error').message, /storage is full|checkpoint was saved/);
  const progress = messages.filter((message) => message.event === 'progress').at(-1).detail;
  assert.equal(progress.saved, false); assert.equal(progress.checkpointFrames, 91);
  assert.equal(backend.assets.get('asset-1').status, 'recording', 'no invented final commit');
});

test('storage write diagnostic refuses active recording and runs after its final seal', async () => {
  const { rpc, backend } = await fixture();
  await assert.rejects(rpc('checkStorageWrite'), { code: 'STORAGE_BUSY' });
  assert.equal(backend.writeChecks, undefined);
  await rpc('putPage', ['asset-1', 0, new Float32Array([.25, -.25]).buffer, 2, 1]);
  await rpc('finishAsset', ['asset-1', { frames: 2 }]);
  const before = structuredClone([...backend.assets]);
  const result = await rpc('checkStorageWrite');
  assert.equal(result.status, 'passed'); assert.equal(result.bytesVerified, 131072); assert.equal(backend.writeChecks, 1);
  assert.deepEqual([...backend.assets], before);
});

test('old unfinished metadata does not masquerade as an active writer during diagnosis', async () => {
  const { rpc, backend } = await fixture();
  await rpc('finishAsset', ['asset-1', { frames: 0 }]);
  const old = { ...backend.assets.get('asset-1'), id: 'old-unfinished', status: 'recording' };
  backend.assets.set(old.id, old);
  assert.equal((await rpc('getAsset', [old.id])).status, 'recording');
  assert.equal((await rpc('checkStorageWrite')).status, 'passed');
  assert.equal(backend.assets.get(old.id).status, 'recording', 'the health check does not recover or edit old audio');
});

test('failed sealing ends the active-writer guard while keeping durable recovery metadata', async () => {
  const { rpc, backend } = await fixture();
  backend.failSeal = true;
  await assert.rejects(rpc('finishAsset', ['asset-1', { frames: 0 }]), { name: 'QuotaExceededError', code: 'QUOTA_EXCEEDED' });
  assert.equal(backend.assets.get('asset-1').status, 'recording');
  assert.equal((await rpc('checkStorageWrite')).status, 'passed');
});

test('diagnostic quota results remain scoped to the check and do not emit recording failure events', async () => {
  const { rpc, backend, messages } = await fixture();
  await rpc('finishAsset', ['asset-1', { frames: 0 }]);
  backend.writeCheckResult = { checkedAt: 456, backend: 'opfs', status: 'quota-exceeded', testedBytes: 131072, bytesVerified: 0, cleanupComplete: true, error: { name: 'QuotaExceededError', code: 'QUOTA_EXCEEDED', message: 'Write refused' } };
  assert.deepEqual(await rpc('checkStorageWrite'), backend.writeCheckResult);
  assert.equal(messages.some(message => message.event === 'error'), false);
});
test('a future page is a retryable miss, not a fatal recording error', async () => {
  const { send, port } = await fixture();
  send({ type: 'read', assetId: 'asset-1', index: 0 });
  await until(() => port.messages.length > 0);
  assert.deepEqual(port.messages[0], { type: 'page-missing', assetId: 'asset-1', index: 0, retryable: true });
});

test('queued old-project reads cannot reopen a file after releaseProject', async () => {
  const { send, port, rpc, backend } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array(17).buffer, 17, 1]);
  await rpc('finishAsset', ['asset-1', { frames: 17 }]);
  let unblock; const gate = new Promise(resolve => { unblock = resolve; });
  const read = backend.readData.bind(backend); let calls = 0, readsAfterRelease = 0;
  backend.readData = async (...args) => { if (backend.released) readsAfterRelease++; if (++calls === 1) await gate; return read(...args); };
  for (let i = 0; i < 6; i++) send({ type: 'read', assetId: 'asset-1', index: 0 });
  const released = rpc('releaseProject', ['project-1']); unblock(); await released;
  await until(() => port.messages.filter(message => ['page', 'page-missing'].includes(message.type)).length === 6);
  assert.equal(readsAfterRelease, 0);
  assert.ok(port.messages.some(message => message.type === 'page-missing' && message.retryable === false));
  await assert.rejects(rpc('readPage', ['asset-1', 0]), { code: 'PROJECT_RELEASED' });
});

test('worker routes immutable bounded range requests without transferring the Blob buffer', async () => {
  const { rpc, backend } = await fixture();
  const blob = await rpc('getAssetRange', ['asset-1', { startFrame: 13, frames: 25 }]);
  assert.deepEqual(backend.rangeRequest, { id: 'asset-1', startFrame: 13, frames: 25 });
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3, 4]);
});

test('intentional deletion turns queued and late worklet reads into terminal misses', async () => {
  const { send, port, rpc, backend, messages } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array(17).buffer, 17, 1]); await rpc('finishAsset', ['asset-1', { frames: 17 }]);
  let unblock; const gate = new Promise(resolve => { unblock = resolve; }); const read = backend.readData.bind(backend); let calls = 0;
  backend.readData = async (...args) => { if (++calls === 1) await gate; return read(...args); };
  for (let i = 0; i < 6; i++) send({ type: 'read', assetId: 'asset-1', index: 0 });
  const deleting = rpc('deleteAsset', ['asset-1']); unblock(); await deleting;
  await until(() => port.messages.filter(message => ['page', 'page-missing'].includes(message.type)).length === 6);
  assert.ok(port.messages.some(message => message.type === 'page-missing' && message.retryable === false));
  send({ type: 'read', assetId: 'asset-1', index: 0 });
  await until(() => port.messages.filter(message => ['page', 'page-missing'].includes(message.type)).length === 7);
  assert.equal(port.messages.at(-1).type, 'page-missing'); assert.equal(port.messages.some(message => message.type === 'storage-error'), false);
  assert.equal(messages.some(message => message.type === 'event' && message.event === 'error'), false);
  await assert.rejects(rpc('readPage', ['asset-1', 0]), { code: 'ASSET_DELETED' });
});

test('failed deletion does not fence surviving audio and unexpected missing audio remains an error', async () => {
  const { send, port, rpc, backend } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array(17).buffer, 17, 1]); await rpc('finishAsset', ['asset-1', { frames: 17 }]);
  backend.failDelete = true; await assert.rejects(rpc('deleteAsset', ['asset-1']), /Deletion failed/);
  send({ type: 'read', assetId: 'asset-1', index: 0 }); await until(() => port.messages.some(message => message.type === 'page'));
  assert.equal((await rpc('readPage', ['asset-1', 0])).frames, 17);
  send({ type: 'read', assetId: 'unexpected-missing', index: 0 }); await until(() => port.messages.some(message => message.type === 'storage-error'));
  assert.equal(port.messages.find(message => message.type === 'storage-error').code, 'ASSET_NOT_FOUND');
});

test('successful intentional ID reuse clears the recent deletion fence', async () => {
  const { rpc } = await fixture();
  await rpc('finishAsset', ['asset-1', { frames: 0, status: 'cancelled' }]); await rpc('deleteAsset', ['asset-1']);
  await rpc('beginAsset', [{ id: 'asset-1', projectId: 'project-1', sampleRate: 48000, channels: 1, kind: 'loop' }]);
  await rpc('putPage', ['asset-1', 0, new Float32Array([0.25]).buffer, 1, 1]);
  assert.equal(new Float32Array((await rpc('readPage', ['asset-1', 0])).buffer)[0], .25);
});

test('confirmed project purge fences old worklet writes, reads and ends, including reused audio IDs', async () => {
  const { rpc, send, port, backend, messages } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array([.2]).buffer, 1, 1]);
  await rpc('purgeProject', ['project-1', { discardUnfinished: true }]);
  assert.deepEqual(backend.purgeOptions, { discardUnfinished: true }); assert.equal(backend.assets.size, 0);
  const before = messages.length;
  send({ type: 'write', assetId: 'asset-1', index: 1, frames: 1, channels: 1, buffer: new Float32Array([.8]).buffer });
  send({ type: 'read', assetId: 'asset-1', index: 0 });
  send({ type: 'end', assetId: 'asset-1', frames: 2, status: 'complete' });
  await until(() => port.messages.some(message => message.type === 'recycle') && port.messages.some(message => message.type === 'page-missing'));
  await rpc('estimate').catch(() => {}); // Wait for preceding queued writes/end.
  assert.equal(backend.assets.size, 0); assert.equal(backend.pages.size, 0);
  assert.equal(messages.slice(before).some(message => message.event === 'error'), false);
  await rpc('beginAsset', [{ id: 'asset-1', projectId: 'project-1', sampleRate: 48000, channels: 1, kind: 'loop' }]);
  send({ type: 'write', assetId: 'asset-1', index: 0, frames: 1, channels: 1, buffer: new Float32Array([.9]).buffer });
  await until(() => port.messages.filter(message => message.type === 'recycle').length === 2);
  assert.equal(backend.assets.get('asset-1').frames, 0, 'old port cannot write into an intentionally reused ID');
  await rpc('putPage', ['asset-1', 0, new Float32Array([.4]).buffer, 1, 1]);
  assert.equal(backend.assets.get('asset-1').frames, 1);
});

test('default purge refusal and foreign writer lock do not fence a live recording', async () => {
  const { rpc, backend } = await fixture();
  await assert.rejects(rpc('purgeProject', ['project-1']), { code: 'RECORDING_ACTIVE' });
  backend.foreignLock = true;
  await assert.rejects(rpc('purgeProject', ['project-1', { discardUnfinished: true }]), { code: 'PROJECT_BUSY' });
  backend.foreignLock = false;
  await rpc('putPage', ['asset-1', 0, new Float32Array([.2]).buffer, 1, 1]);
  assert.equal(backend.assets.get('asset-1').frames, 1);
});

test('storage inventory and file deletion RPC preserve the revision and fence retired worklet traffic', async () => {
  const { rpc, send, port, backend, messages } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array([.2]).buffer, 1, 1]);
  const inventory = await rpc('getStorageInventory'); assert.equal(inventory.files[0].id, 'asset-1'); assert.equal(inventory.files[0].bytes, 4);
  const file = { kind: 'asset', id: 'asset-1', revision: 'reviewed-revision', discardUnfinished: true };
  await rpc('deleteStoredFile', [file]); assert.deepEqual(backend.deleteFileRequest, file);
  const before = messages.length;
  send({ type: 'write', assetId: 'asset-1', index: 1, frames: 1, channels: 1, buffer: new Float32Array([.8]).buffer });
  send({ type: 'read', assetId: 'asset-1', index: 0 });
  send({ type: 'end', assetId: 'asset-1', frames: 2, status: 'complete' });
  await until(() => port.messages.some(message => message.type === 'recycle') && port.messages.some(message => message.type === 'page-missing'));
  await rpc('getStorageInventory');
  assert.equal(backend.assets.size, 0); assert.equal(backend.pages.size, 0); assert.equal(messages.slice(before).some(message => message.event === 'error'), false);
  await rpc('beginAsset', [{ id: 'asset-1', projectId: 'project-1', sampleRate: 48000, channels: 1, kind: 'loop' }]);
  send({ type: 'write', assetId: 'asset-1', index: 0, frames: 1, channels: 1, buffer: new Float32Array([.9]).buffer });
  await until(() => port.messages.filter(message => message.type === 'recycle').length === 2);
  assert.equal(backend.assets.get('asset-1').frames, 0, 'retired port cannot resurrect a reused identifier');
});

test('failed durable detachment preserves playback; failure after detachment fences late writes', async () => {
  const { rpc, backend, send, port } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array([.2]).buffer, 1, 1]);
  backend.failDetach = true;
  await assert.rejects(rpc('deleteStoredFile', [{ kind: 'asset', id: 'asset-1', discardUnfinished: true }]), /Manifest save failed/);
  assert.equal((await rpc('readPage', ['asset-1', 0])).frames, 1);
  backend.failDetach = false; backend.failDelete = true;
  await assert.rejects(rpc('deleteStoredFile', [{ kind: 'asset', id: 'asset-1', discardUnfinished: true }]), /Deletion failed/);
  assert.equal(backend.assets.size, 1, 'failed physical delete is still listed for retry');
  send({ type: 'write', assetId: 'asset-1', index: 1, frames: 1, channels: 1, buffer: new Float32Array([.8]).buffer });
  send({ type: 'end', assetId: 'asset-1', frames: 2, status: 'complete' });
  await until(() => port.messages.some(message => message.type === 'recycle'));
  await rpc('getStorageInventory');
  assert.equal(backend.assets.get('asset-1').frames, 1); assert.equal(backend.assets.get('asset-1').status, 'recording');
});

test('shared-audio purge refusal does not fence surviving project reads', async () => {
  const { rpc, backend, send, port } = await fixture();
  await rpc('putPage', ['asset-1', 0, new Float32Array([.2]).buffer, 1, 1]);
  await rpc('finishAsset', ['asset-1', { frames: 1 }]); backend.sharedProject = true;
  await assert.rejects(rpc('purgeProject', ['project-1']), { code: 'PROJECT_AUDIO_SHARED' });
  assert.equal((await rpc('readPage', ['asset-1', 0])).frames, 1);
  send({ type: 'read', assetId: 'asset-1', index: 0 }); await until(() => port.messages.some(message => message.type === 'page'));
  assert.equal(backend.assets.size, 1);
});
