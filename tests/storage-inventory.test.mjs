import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBackend } from '../src/storage/backend.mjs';
import { createProject, createTrack, referencedAssets } from '../src/project.mjs';

class InventoryDisk extends BrowserBackend {
  constructor() {
    super(); this.assets = new Map(); this.projects = new Map(); this.pageGroups = new Map(); this.files = new Map(); this.events = []; this.foreign = new Set();
    this.directory = {
      entries: async function* () { for (const [name, stored] of this.files) yield [name, { kind: 'file', getFile: async () => {
        if (stored.error) throw new Error(stored.error);
        return { size: stored.bytes, lastModified: stored.lastModified || 1 };
      } }]; }.bind(this),
      removeEntry: async name => { this.events.push(`file:${name}`); if (this.failFile === name) throw new Error('Physical deletion failed'); this.files.delete(name); },
    };
  }
  async all(store) { if (store === this.failListing) throw new Error('Listing failed'); return [...this[store].values()].map(value => structuredClone(value)); }
  async inventoryPages() { if (this.failPages) throw new Error('Page inspection failed'); return new Map([...this.pageGroups].map(([id, value]) => [id, { ...value }])); }
  async estimate() { return { usage: 10000, quota: 200000, persistent: false }; }
  async withMaintenance(operation, { required } = {}) { this.events.push(`maintenance:${required === true}`); if (this.noLocks && required) throw Object.assign(new Error('No locks'), { code: 'LOCKING_UNAVAILABLE' }); return operation(); }
  async lockProject(id) { this.events.push(`lock:${id}`); if (this.foreign.has(id)) throw Object.assign(new Error('Foreign editor'), { code: 'PROJECT_BUSY' }); this.projectLocks.set(id, { ready: Promise.resolve(), release() {} }); }
  async getAsset(id) { return structuredClone(this.assets.get(id)); }
  async loadProject(id) { return structuredClone(this.projects.get(id)); }
  async saveDetachedProjects(projects) {
    this.events.push('save-detached'); if (this.failSave) throw new Error('Metadata save failed');
    for (const project of projects) this.projects.set(project.id, structuredClone(project));
  }
  async removeAssetMetadata(id) { this.events.push(`metadata:${id}`); if (this.failMetadata) throw new Error('Metadata delete failed'); this.assets.delete(id); this.pageGroups.delete(id); }
  addProject(id, assetId, { deleted = false } = {}) {
    const project = createProject(id); project.id = id;
    if (assetId) project.tracks.push(createTrack({ id: `track-${id}`, assetId, frames: 100 }));
    if (deleted) project.deletedAt = 123;
    this.projects.set(id, project); return project;
  }
  addAsset(id, projectId, backend = 'opfs', bytes = 400) {
    const asset = { id, projectId, name: id, backend, status: 'complete', sampleRate: 48000, channels: 1, frames: 100, byteLength: bytes, updatedAt: 1, kind: 'loop' };
    this.assets.set(id, asset);
    this.pageGroups.set(id, { bytes: backend === 'indexeddb' ? bytes : 0, metadataBytes: 100, pages: 1, unknown: false });
    if (backend === 'opfs') this.files.set(`${id}.pcm`, { bytes });
    return asset;
  }
}
const select = async (disk, id, kind = 'asset') => (await disk.getStorageInventory()).files.find(file => file.kind === kind && file.id === id);

test('inventory includes deleted projects, missing owners, unindexed files/pages and actual physical bytes', async () => {
  const disk = new InventoryDisk();
  disk.addProject('deleted', 'past', { deleted: true }); disk.addAsset('past', 'deleted'); disk.files.get('past.pcm').bytes = 700;
  disk.addAsset('ownerless', 'missing-project', 'indexeddb', 100); disk.pageGroups.get('ownerless').bytes = 180;
  disk.files.set('extra.pcm', { bytes: 90 }); disk.files.set('probe-leftover', { bytes: 5 });
  disk.pageGroups.set('unindexed', { bytes: 80, metadataBytes: 9, pages: 2 });
  const inventory = await disk.getStorageInventory();
  assert.equal(inventory.complete, true); assert.equal(inventory.knownAudioBytes, 1055); assert.equal(inventory.audioBytes, 1055);
  assert.equal(inventory.files.length, 5); assert.equal(inventory.projects[0].deletedAt, 123);
  assert.equal(inventory.files.find(file => file.id === 'past').bytes, 700);
  assert.equal(inventory.files.find(file => file.id === 'past').deletedProject, true);
  assert.equal(inventory.files.find(file => file.id === 'ownerless').bytes, 180);
  assert.equal(inventory.files.find(file => file.id === 'ownerless').projectName, null);
  assert.ok(inventory.metadataBytes > 209); assert.equal(inventory.includesMetadataOverhead, false);
});

test('unavailable estimates and inaccessible files remain unknown rather than fabricated zero', async () => {
  const disk = new InventoryDisk(); disk.addAsset('locked', 'p'); disk.files.get('locked.pcm').error = 'File unavailable';
  let inventory = await disk.getStorageInventory();
  assert.equal(inventory.complete, false); assert.equal(inventory.audioBytes, null); assert.equal(inventory.files[0].bytes, null); assert.equal(inventory.unknownFiles, 1);
  disk.directory = null; inventory = await disk.getStorageInventory(); assert.equal(inventory.audioBytes, null); assert.equal(inventory.files[0].bytes, null);
  disk.failPages = true; inventory = await disk.getStorageInventory(); assert.equal(inventory.metadataBytes, null); assert.ok(inventory.errors.some(error => error.startsWith('Audio pages:')));
});

test('an unreadable index never reclassifies owned physical files as deletable orphans', async () => {
  const disk = new InventoryDisk(); disk.addAsset('owned', 'p'); disk.failListing = 'assets';
  const inventory = await disk.getStorageInventory(); assert.equal(inventory.complete, false); assert.deepEqual(inventory.files, []);
  await assert.rejects(disk.deleteStoredFile({ kind: 'orphan-opfs', id: 'owned.pcm' }), { code: 'FILE_CHANGED' });
  assert.equal(disk.files.has('owned.pcm'), true);
});

test('per-file deletion detaches every shared manifest before physical deletion and preserves other audio', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'shared'); disk.addProject('second', 'shared', { deleted: true }); disk.addAsset('shared', 'first'); disk.addAsset('other', 'first');
  disk.projectLocks.set('first', { ready: Promise.resolve(), release() {} });
  let detached = false;
  const result = await disk.deleteStoredFile(await select(disk, 'shared'), { onDetached(id) { assert.equal(id, 'shared'); detached = true; assert.equal(referencedAssets(disk.projects.get('first')).length, 0); } });
  assert.equal(detached, true); assert.deepEqual(result.affectedProjectIds, ['first', 'second']);
  assert.equal(disk.assets.has('shared'), false); assert.equal(disk.assets.has('other'), true);
  assert.ok(disk.events.indexOf('save-detached') < disk.events.indexOf('file:shared.pcm'));
  assert.equal(referencedAssets(disk.projects.get('second')).length, 0);
  assert.equal(disk.projectLocks.has('first'), true, 'existing active project lease retained');
  assert.equal(disk.projectLocks.has('second'), false, 'temporary foreign project lease released');
});

test('a failed manifest save or foreign editor cannot remove any referenced bytes', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'shared'); disk.addProject('second', 'shared'); disk.addAsset('shared', 'first');
  disk.failSave = true;
  await assert.rejects(disk.deleteStoredFile(await select(disk, 'shared')), /Metadata save failed/);
  assert.equal(disk.files.has('shared.pcm'), true); assert.deepEqual(referencedAssets(disk.projects.get('first')), ['shared']);
  disk.failSave = false; disk.foreign.add('second'); disk.events = [];
  await assert.rejects(disk.deleteStoredFile(await select(disk, 'shared')), { code: 'PROJECT_BUSY' });
  assert.equal(disk.events.includes('save-detached'), false); assert.equal(disk.files.has('shared.pcm'), true); assert.equal(disk.projectLocks.size, 0);
});

test('physical failure and later metadata failure remain listed and safely retryable', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'audio'); disk.addAsset('audio', 'first'); disk.failFile = 'audio.pcm';
  await assert.rejects(disk.deleteStoredFile(await select(disk, 'audio')), /Physical deletion failed/);
  assert.equal(disk.files.has('audio.pcm'), true); assert.equal(disk.assets.has('audio'), true); assert.deepEqual(referencedAssets(disk.projects.get('first')), []);
  disk.failFile = null; disk.failMetadata = true;
  await assert.rejects(disk.deleteStoredFile(await select(disk, 'audio')), /Metadata delete failed/);
  assert.equal(disk.files.has('audio.pcm'), false); assert.equal(disk.assets.has('audio'), true);
  const retry = await select(disk, 'audio'); assert.equal(retry.missing, true); assert.equal(retry.bytes, 0);
  disk.failMetadata = false; await disk.deleteStoredFile(retry); assert.equal(disk.assets.size, 0); assert.equal(disk.pageGroups.size, 0);
});

test('unfinished deletion requires explicit discard and a successful owner lock', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'audio'); disk.addAsset('audio', 'first').status = 'recording';
  await assert.rejects(disk.deleteStoredFile(await select(disk, 'audio')), { code: 'RECORDING_ACTIVE' });
  disk.foreign.add('first'); await assert.rejects(disk.deleteStoredFile({ ...await select(disk, 'audio'), discardUnfinished: true }), { code: 'PROJECT_BUSY' });
  disk.foreign.clear(); await disk.deleteStoredFile({ ...await select(disk, 'audio'), discardUnfinished: true }); assert.equal(disk.assets.size, 0);
});

test('confirmation fingerprint catches physical changes and manifest changes without a revision bump', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'audio'); disk.addAsset('audio', 'first');
  let file = await select(disk, 'audio'); disk.files.get('audio.pcm').bytes++;
  await assert.rejects(disk.deleteStoredFile(file), { code: 'FILE_CHANGED' });
  file = await select(disk, 'audio'); disk.projects.get('first').name = 'Changed while confirmation open';
  await assert.rejects(disk.deleteStoredFile(file), { code: 'FILE_CHANGED' });
  assert.equal(disk.files.has('audio.pcm'), true);
});

test('an unindexed OPFS file still detaches historical manifest references by its asset identifier', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'missing-index'); disk.files.set('missing-index.pcm', { bytes: 100 });
  const file = await select(disk, 'missing-index.pcm', 'orphan-opfs'); assert.equal(file.assetId, 'missing-index'); assert.deepEqual(file.referencedProjectIds, ['first']);
  await disk.deleteStoredFile(file); assert.deepEqual(referencedAssets(disk.projects.get('first')), []); assert.equal(disk.files.size, 0);
});

test('unindexed fallback pages can be deleted independently and traversal names are rejected', async () => {
  const disk = new InventoryDisk(); disk.pageGroups.set('stranded', { bytes: 900, metadataBytes: 90, pages: 1 });
  await disk.deleteStoredFile(await select(disk, 'stranded', 'orphan-pages')); assert.equal(disk.pageGroups.size, 0);
  for (const id of ['../foreign.pcm', '/foreign.pcm', 'folder/file.pcm', '..', 'a\\b', 'a\0b']) await assert.rejects(disk.deleteStoredFile({ kind: 'orphan-opfs', id }), { code: 'INVALID_STORAGE_FILE' });
  await assert.rejects(disk.deleteStoredFile({ kind: 'project', id: 'first' }), { code: 'INVALID_STORAGE_FILE' });
});

test('estimate failures and invalid numbers cannot disable storage or become a false free-space figure', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { estimate: async () => { throw new Error('Unavailable'); }, persisted: async () => { throw new Error('Unavailable'); } } } });
    const disk = new BrowserBackend(); assert.deepEqual(await disk.estimate(), { usage: null, quota: null, persistent: false });
    navigator.storage.estimate = async () => ({ usage: NaN, quota: Infinity }); assert.deepEqual(await disk.estimate(), { usage: null, quota: null, persistent: false });
    navigator.storage.estimate = async () => ({ usage: -1, quota: Number.MAX_SAFE_INTEGER + 1 }); assert.deepEqual(await disk.estimate(), { usage: null, quota: null, persistent: false });
    navigator.storage.estimate = async () => ({ usage: 0, quota: 1000 }); assert.deepEqual(await disk.estimate(), { usage: 0, quota: 1000, persistent: false });
    await assert.rejects(disk.withMaintenance(async () => assert.fail('Deletion must not run'), { required: true }), { code: 'LOCKING_UNAVAILABLE' });
  } finally { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator; }
});

test('page inventory measures actual buffers with a bounded cursor and never calls getAll', async () => {
  const disk = new BrowserBackend(); let next = 0, maxOutstanding = 0, outstanding = 0;
  const pages = [{ assetId: 'a', index: 0, byteLength: 900, buffer: new ArrayBuffer(12) }, { assetId: 'a', index: 1, byteLength: 900, buffer: new ArrayBuffer(8) }, { assetId: 'b', index: 0, byteLength: 900 }];
  disk.db = { transaction() {
    const tx = { objectStore() { return { getAll() { assert.fail('Must not materialize PCM'); }, openCursor() {
      const request = {};
      const advance = () => queueMicrotask(() => {
        outstanding--; const value = pages[next++];
        request.result = value ? { value, continue() { outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding); advance(); } } : null;
        request.onsuccess(); if (!value) queueMicrotask(() => tx.oncomplete());
      });
      outstanding++; maxOutstanding = Math.max(maxOutstanding, outstanding); advance(); return request;
    } }; } }; return tx;
  } };
  const groups = await disk.inventoryPages(); assert.equal(groups.get('a').bytes, 20); assert.equal(groups.get('a').pages, 2); assert.equal(groups.get('b').bytes, 0); assert.equal(maxOutstanding, 1);
  assert.ok(groups.get('a').metadataBytes > 0); assert.equal(Object.hasOwn(groups.get('a'), 'buffer'), false);
});

test('a stray OPFS twin can be removed without detaching its retained fallback recording', async () => {
  const disk = new InventoryDisk(); disk.addProject('first', 'audio'); disk.addAsset('audio', 'first', 'indexeddb'); disk.files.set('audio.pcm', { bytes: 80 });
  const file = await select(disk, 'audio.pcm', 'orphan-opfs');
  assert.equal(file.assetId, null); assert.equal(file.retainedAssetId, 'audio'); assert.deepEqual(file.referencedProjectIds, []); assert.equal(file.projectId, 'first');
  let fenced = null;
  await disk.deleteStoredFile(file, { onDetached(id) { fenced = id; } });
  assert.equal(fenced, null); assert.equal(disk.files.size, 0); assert.equal(disk.assets.get('audio').backend, 'indexeddb'); assert.equal(disk.pageGroups.get('audio').bytes, 400);
  assert.deepEqual(referencedAssets(disk.projects.get('first')), ['audio']);
});

test('synchronous failure while staging manifests aborts the whole detach transaction', async () => {
  const disk = new BrowserBackend(), committed = new Map(), staged = new Map(); let aborts = 0;
  disk.db = { transaction() {
    const tx = {
      abort() { aborts++; staged.clear(); queueMicrotask(() => tx.onabort()); },
      objectStore() { return { put(project) { if (project.id === 'second') throw new Error('Could not clone second manifest'); staged.set(project.id, project); } }; },
    }; return tx;
  } };
  await assert.rejects(disk.saveDetachedProjects([{ id: 'first' }, { id: 'second' }]), /Could not clone second manifest/);
  assert.equal(aborts, 1); assert.equal(staged.size, 0); assert.equal(committed.size, 0);
});
