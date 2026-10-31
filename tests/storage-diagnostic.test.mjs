import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBackend } from '../src/storage/backend.mjs';
import { makeAsset, storageError } from '../src/storage/core.mjs';
import { STORAGE_CHECK_BYTES } from '../src/storage/diagnostic.mjs';

const quota = () => Object.assign(new Error('The browser refused this write'), { name: 'QuotaExceededError' });
const missing = () => Object.assign(new Error('Missing file'), { name: 'NotFoundError' });

// Exercise the real OPFS open/write/flush/close/reopen/read operations with a
// fault-injectable directory. Native OPFS and IDB transactions have additional
// browser coverage; these tests cover every diagnostic failure/cleanup branch.
function memoryDirectory(faults = {}) {
  const files = new Map(), opened = [], closed = [];
  const directory = {
    files, opened, closed,
    async *entries() { for (const name of files.keys()) yield [name, { kind: 'file' }]; },
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) { if (!create) throw missing(); files.set(name, new Uint8Array()); }
      return { name,
        async createSyncAccessHandle() {
          if (faults.open) throw new Error('Cannot open the sync handle');
          opened.push(name);
          return {
            truncate(size) { files.set(name, files.get(name).slice(0, size)); },
            write(source, { at }) {
              if (faults.write) throw quota();
              const next = new Uint8Array(Math.max(files.get(name).length, at + source.length));
              next.set(files.get(name)); next.set(source, at); files.set(name, next); return source.length;
            },
            read(target, { at }) {
              const part = files.get(name).subarray(at, at + target.length); target.set(part);
              if (faults.corrupt && part.length) target[0] ^= 1;
              return part.length;
            },
            flush() { if (faults.flush) throw quota(); },
            close() { closed.push(name); },
          };
        },
        async getFile() { return new Blob([files.get(name)]); },
      };
    },
    async removeEntry(name) { if (faults.remove) throw new Error('Temporary file is locked'); if (!files.delete(name)) throw missing(); },
  };
  return directory;
}

class MemoryBackend extends BrowserBackend {
  constructor(backend = 'opfs', faults = {}) {
    super(); this.backend = backend; this.faults = faults; this.directory = backend === 'opfs' ? memoryDirectory(faults) : null;
    this.assets = new Map(); this.pages = new Map(); this.events = []; this.maintenance = Promise.resolve();
    const original = { ...makeAsset({ id: 'user-recording', projectId: 'user-project', sampleRate: 48000, channels: 1, kind: 'loop' }, backend), status: 'complete', frames: 4, byteLength: 16 };
    this.assets.set(original.id, original); this.pages.set(`${original.id}:0`, { assetId: original.id, index: 0, buffer: new Float32Array([.1, -.2, .3, -.4]).buffer });
    this.directory?.files.set(`${original.id}.pcm`, new Uint8Array(this.pages.get(`${original.id}:0`).buffer.slice(0)));
    this.initial = this.snapshot();
  }
  snapshot() { return structuredClone({ assets: [...this.assets], pages: [...this.pages], files: this.directory ? [...this.directory.files] : [] }); }
  async all(store) { assert.equal(store, 'assets'); return structuredClone([...this.assets.values()]); }
  withMaintenance(operation) {
    const next = this.maintenance.then(operation); this.maintenance = next.catch(() => {}); return next;
  }
  async getAsset(id) { this.events.push(`get:${id}`); return structuredClone(this.assets.get(id)); }
  async getPage(id, index) {
    const result = structuredClone(this.pages.get(`${id}:${index}`));
    if (result && id.startsWith('storage-check-') && this.faults.metadata) result.crc32 ^= 1;
    return result;
  }
  async createAssetRecord(asset) {
    if (this.assets.has(asset.id)) throw storageError('ASSET_EXISTS', 'Already exists');
    if (asset.backend === 'opfs') { const handle = await this.openHandle(asset); handle.truncate(0); handle.flush(); }
    if (this.faults.create) throw quota();
    this.events.push(`create:${asset.id}`); this.assets.set(asset.id, structuredClone(asset));
  }
  async commitPage(asset, page, buffer) {
    if (this.faults.commit) throw quota();
    this.events.push(`commit:${asset.id}`); this.assets.set(asset.id, structuredClone(asset));
    this.pages.set(`${asset.id}:${page.index}`, { ...page, ...(asset.backend === 'indexeddb' ? { buffer: buffer.slice(0) } : {}) });
  }
  async finishAsset(asset) {
    if (this.faults.finish) throw quota();
    this.events.push(`finish:${asset.id}`); this.assets.set(asset.id, structuredClone(asset)); this.closeHandle(asset.id);
  }
  async readData(asset, page) {
    this.events.push(`read:${asset.id}`);
    const result = await super.readData(asset, page);
    if (this.faults.corrupt && asset.backend === 'indexeddb') new Uint8Array(result)[0] ^= 1;
    return result;
  }
  async removeAssetMetadata(id) {
    if (this.faults.removeMetadata) throw new Error('Metadata cleanup failed');
    this.events.push(`remove:${id}`); this.assets.delete(id);
    for (const [key, value] of this.pages) if (value.assetId === id) this.pages.delete(key);
  }
}

for (const selected of ['opfs', 'indexeddb']) {
  test(`${selected}: bounded write check verifies committed bytes and removes only its temporary asset`, async () => {
    const backend = new MemoryBackend(selected), result = await backend.checkStorageWrite();
    assert.equal(result.status, 'passed'); assert.equal(result.testedBytes, 131072); assert.equal(result.bytesVerified, 131072);
    assert.equal(result.backend, selected); assert.equal(result.cleanupComplete, true); assert.ok(result.checkedAt > 0);
    assert.equal(result.error, undefined); assert.equal(result.temporaryAssetId, undefined); assert.deepEqual(backend.snapshot(), backend.initial);
    const id = backend.events.find(event => event.startsWith('create:')).slice(7);
    assert.match(id, /^storage-check-/);
    assert.ok(backend.events.indexOf(`commit:${id}`) < backend.events.indexOf(`finish:${id}`));
    assert.ok(backend.events.indexOf(`finish:${id}`) < backend.events.lastIndexOf(`get:${id}`));
    assert.ok(backend.events.lastIndexOf(`get:${id}`) < backend.events.indexOf(`read:${id}`));
    if (selected === 'opfs') assert.equal(backend.directory.opened.filter(name => name === `${id}.pcm`).length, 2, 'verification reopens the closed file');
  });

  test(`${selected}: actual write quota rejection remains distinct from an estimate and preserves user audio`, async () => {
    const backend = new MemoryBackend(selected, selected === 'opfs' ? { write: true } : { commit: true });
    const result = await backend.checkStorageWrite();
    assert.equal(result.status, 'quota-exceeded'); assert.equal(result.error.name, 'QuotaExceededError'); assert.equal(result.error.code, 'QUOTA_EXCEEDED');
    assert.equal(result.bytesVerified, 0); assert.equal(result.cleanupComplete, true); assert.deepEqual(backend.snapshot(), backend.initial);
  });

  test(`${selected}: byte mismatch fails verification and still cleans its own file`, async () => {
    const backend = new MemoryBackend(selected, { corrupt: true }), result = await backend.checkStorageWrite();
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'STORAGE_CHECK_MISMATCH');
    assert.equal(result.bytesVerified, 0); assert.equal(result.cleanupComplete, true); assert.deepEqual(backend.snapshot(), backend.initial);
  });

  test(`${selected}: concurrent checks use different temporary assets without touching user audio`, async () => {
    const backend = new MemoryBackend(selected), results = await Promise.all([backend.checkStorageWrite(), backend.checkStorageWrite(), backend.checkStorageWrite()]);
    assert.ok(results.every(result => result.status === 'passed'));
    const ids = backend.events.filter(event => event.startsWith('create:'));
    assert.equal(new Set(ids).size, 3); assert.deepEqual(backend.snapshot(), backend.initial);
  });
}

test('a failed OPFS metadata creation removes the physical file it already opened', async () => {
  const backend = new MemoryBackend('opfs', { create: true }), result = await backend.checkStorageWrite();
  assert.equal(result.status, 'quota-exceeded'); assert.equal(result.cleanupComplete, true); assert.deepEqual(backend.snapshot(), backend.initial);
});

test('a committed metadata readback mismatch cannot pass the check', async () => {
  const backend = new MemoryBackend('indexeddb', { metadata: true }), result = await backend.checkStorageWrite();
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'STORAGE_CHECK_METADATA');
  assert.equal(result.bytesVerified, 0); assert.equal(result.cleanupComplete, true); assert.deepEqual(backend.snapshot(), backend.initial);
});

for (const [selected, faults] of [['opfs', { remove: true }], ['indexeddb', { removeMetadata: true }]]) {
  test(`${selected}: cleanup failure cannot claim clean success, and identifies the discoverable temporary item`, async () => {
    const backend = new MemoryBackend(selected, faults), result = await backend.checkStorageWrite();
    assert.equal(result.status, 'failed'); assert.equal(result.bytesVerified, STORAGE_CHECK_BYTES); assert.equal(result.cleanupComplete, false);
    assert.ok(result.cleanupError); assert.equal(result.error.message, result.cleanupError.message); assert.match(result.temporaryAssetId, /^storage-check-/);
    const leftover = backend.assets.get(result.temporaryAssetId);
    assert.equal(leftover.kind, 'diagnostic'); assert.equal(leftover.name, 'Temporary storage check'); assert.equal(leftover.byteLength, STORAGE_CHECK_BYTES);
    assert.deepEqual(backend.assets.get('user-recording'), backend.initial.assets[0][1]);
    assert.deepEqual(backend.pages.get('user-recording:0'), backend.initial.pages[0][1]);
    if (selected === 'opfs') assert.deepEqual(backend.directory.files.get('user-recording.pcm'), backend.initial.files[0][1]);
  });
}

test('identifier reservation skips an existing asset without modifying or deleting it', async () => {
  const backend = new MemoryBackend('indexeddb'); let collision;
  const get = backend.getAsset.bind(backend);
  backend.getAsset = async id => {
    if (!collision && id.startsWith('storage-check-')) { collision = id; backend.assets.set(id, { id, name: 'Existing user asset' }); }
    return get(id);
  };
  const result = await backend.checkStorageWrite();
  assert.equal(result.status, 'passed'); assert.deepEqual(backend.assets.get(collision), { id: collision, name: 'Existing user asset' });
  assert.equal(backend.events.some(event => event === `remove:${collision}`), false);
});

for (const selected of ['opfs', 'indexeddb']) {
  test(`${selected}: a leftover diagnostic persists across reload and prevents another write`, async () => {
    const beforeReload = new MemoryBackend(selected, selected === 'opfs' ? { remove: true } : { removeMetadata: true });
    const first = await beforeReload.checkStorageWrite();
    assert.equal(first.cleanupComplete, false); assert.equal(first.bytesVerified, STORAGE_CHECK_BYTES);
    // A fresh backend instance has no memory of the earlier result. Only the
    // persisted asset/page/file state is carried into this simulated reload.
    const backend = new MemoryBackend(selected);
    backend.assets = structuredClone(beforeReload.assets); backend.pages = structuredClone(beforeReload.pages);
    if (selected === 'opfs') for (const [name, bytes] of beforeReload.directory.files) backend.directory.files.set(name, bytes.slice());
    const snapshot = backend.snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await backend.checkStorageWrite();
      assert.equal(result.status, 'failed'); assert.equal(result.cleanupComplete, false); assert.equal(result.bytesVerified, 0);
      assert.equal(result.temporaryAssetId, first.temporaryAssetId); assert.equal(result.error.code, 'STORAGE_CHECK_CLEANUP_REQUIRED');
      assert.deepEqual(result.cleanupError, result.error); assert.deepEqual(backend.snapshot(), snapshot);
    }
    assert.equal(backend.events.some(event => /^(create|commit|finish|remove):/.test(event)), false);
    assert.equal(backend.directory?.opened.length || 0, 0);
    // Once that exact item is removed, a subsequent bounded check can run.
    backend.assets.delete(first.temporaryAssetId); backend.pages.delete(`${first.temporaryAssetId}:0`);
    backend.directory?.files.delete(`${first.temporaryAssetId}.pcm`);
    assert.equal((await backend.checkStorageWrite()).status, 'passed');
  });
}

test('an exact diagnostic OPFS orphan blocks new probes even when metadata creation failed', async () => {
  const backend = new MemoryBackend('opfs'), id = 'storage-check-01234567-89ab-4cde-8f01-23456789abcd';
  backend.directory.files.set(`${id}.pcm`, new Uint8Array([9, 8, 7]));
  const snapshot = backend.snapshot(), result = await backend.checkStorageWrite();
  assert.equal(result.status, 'failed'); assert.equal(result.cleanupComplete, false); assert.equal(result.bytesVerified, 0);
  assert.equal(result.temporaryAssetId, id); assert.equal(result.error.code, 'STORAGE_CHECK_CLEANUP_REQUIRED');
  assert.deepEqual(backend.snapshot(), snapshot); assert.equal(backend.directory.opened.length, 0);
});

test('similar user filenames and indexed music do not become diagnostic leftovers', async () => {
  const backend = new MemoryBackend('opfs'), indexedId = 'storage-check-01234567-89ab-4cde-8f01-23456789abcd';
  backend.directory.files.set('storage-check-my-song.pcm', new Uint8Array([3, 2, 1]));
  backend.directory.files.set(`${indexedId}.pcm`, new Uint8Array([1, 2, 3]));
  backend.assets.set(indexedId, { id: indexedId, kind: 'loop', name: 'User music' });
  const snapshot = backend.snapshot();
  assert.equal((await backend.checkStorageWrite()).status, 'passed'); assert.deepEqual(backend.snapshot(), snapshot);
});

test('startup capability probe cleans its exact file after success, handle failure, and flush failure', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    for (const faults of [{}, { open: true }, { flush: true }]) {
      const directory = memoryDirectory(faults), backend = new BrowserBackend();
      directory.files.set('saved-user-audio.pcm', new Uint8Array([4, 5, 6]));
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) } } });
      await backend.probeFileBackend();
      assert.equal(backend.backend, faults.open || faults.flush ? 'indexeddb' : 'opfs');
      assert.deepEqual([...directory.files], [['saved-user-audio.pcm', new Uint8Array([4, 5, 6])]]);
      assert.equal(directory.closed.length, faults.open ? 0 : 1);
    }
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; }
});
