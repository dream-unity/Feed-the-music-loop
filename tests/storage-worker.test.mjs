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
  const progress = messages.filter((message) => message.event === 'progress').at(-1).detail;
  assert.equal(progress.saved, false); assert.equal(progress.checkpointFrames, 91);
  assert.equal(backend.assets.get('asset-1').status, 'recording', 'no invented final commit');
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
