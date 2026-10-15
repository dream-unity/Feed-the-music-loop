import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBackend } from '../src/storage/backend.mjs';

class FakeDiskBackend extends BrowserBackend {
  constructor() {
    super(); this.assets = new Map(); this.projects = new Map(); this.files = new Set(); this.pages = new Map(); this.events = []; this.foreign = new Set(); this.failFile = null; this.failAssetMetadata = null; this.failProjectMetadata = false;
    this.directory = { removeEntry: async (name) => {
      this.events.push(`file:${name}`);
      if (this.failFile === name) throw new Error('Injected file deletion failure');
      if (!this.files.has(name)) throw Object.assign(new Error('Already removed'), { name: 'NotFoundError' });
      this.files.delete(name);
    } };
  }
  add(id, projectId, kind = 'loop', backend = 'opfs', status = 'complete', frames = 100) {
    const asset = { id, projectId, kind, backend, status, frames, channels: kind === 'master' || kind === 'mix' ? 2 : 1 };
    asset.byteLength = asset.frames * asset.channels * 4;
    this.assets.set(id, asset); this.pages.set(id, ['binary-page']); if (backend === 'opfs') this.files.add(`${id}.pcm`);
    this.projects.set(projectId, { id: projectId, name: projectId }); return asset;
  }
  async lockProject(id) { this.events.push(`lock:${id}`); if (this.foreign.has(id)) throw Object.assign(new Error('Another tab owns this project'), { code: 'PROJECT_BUSY' }); }
  async releaseProject(id) { this.events.push(`release:${id}`); }
  async all(store) { assert.equal(store, 'projects'); return [...this.projects.values()].map(project => structuredClone(project)); }
  async getAsset(id) { return this.assets.get(id); }
  async listAssets(projectId) { return [...this.assets.values()].filter(asset => asset.projectId === projectId); }
  async loadProject(id) { return this.projects.get(id); }
  async put(store, project) { assert.equal(store, 'projects'); this.events.push(`mark:${project.id}`); this.projects.set(project.id, structuredClone(project)); }
  closeHandle(id) { this.events.push(`close:${id}`); super.closeHandle(id); }
  async removeAssetMetadata(id) {
    this.events.push(`metadata:${id}`);
    if (this.failAssetMetadata === id) throw new Error('Injected asset metadata failure');
    this.assets.delete(id); this.pages.delete(id);
  }
  async removeProjectMetadata(id) {
    this.events.push(`project:${id}`);
    if (this.failProjectMetadata) throw new Error('Injected project metadata failure');
    this.projects.delete(id);
  }
}

test('purge removes only the selected project, including rendered mixes and fallback PCM pages', async () => {
  const disk = new FakeDiskBackend();
  disk.add('loop-a', 'project-a'); disk.add('master-a', 'project-a', 'master'); disk.add('mix-a', 'project-a', 'mix'); disk.add('fallback-a', 'project-a', 'vocal', 'indexeddb');
  disk.add('loop-b', 'project-b'); const foreign = structuredClone(disk.assets.get('loop-b'));
  const result = await disk.purgeProject('project-a');
  assert.equal(result.purged, true); assert.equal(result.deletedAssets, 4); assert.equal(result.freedAudioBytes, 2400);
  assert.deepEqual([...disk.assets.keys()], ['loop-b']); assert.deepEqual([...disk.files], ['loop-b.pcm']); assert.deepEqual([...disk.pages.keys()], ['loop-b']);
  assert.equal(disk.projects.has('project-a'), false); assert.deepEqual(disk.assets.get('loop-b'), foreign); assert.equal(disk.projects.has('project-b'), true);
  assert.ok(disk.events.indexOf('close:loop-a') < disk.events.indexOf('file:loop-a.pcm'));
  assert.ok(disk.events.indexOf('file:loop-a.pcm') < disk.events.indexOf('metadata:loop-a'));
  assert.ok(disk.events.indexOf('metadata:fallback-a') < disk.events.indexOf('project:project-a'));
});

test('foreign writer lock prevents any purge mutation', async () => {
  const disk = new FakeDiskBackend(); disk.add('loop-a', 'project-a'); disk.foreign.add('project-a');
  await assert.rejects(disk.purgeProject('project-a'), { code: 'PROJECT_BUSY' });
  assert.deepEqual(disk.events, ['lock:project-a']); assert.equal(disk.files.has('loop-a.pcm'), true); assert.equal(disk.projects.get('project-a').purgePendingAt, undefined);
});

test('an active recording refuses purge before deleting any completed asset', async () => {
  const disk = new FakeDiskBackend(); disk.add('complete-a', 'project-a'); disk.add('active-a', 'project-a', 'vocal', 'opfs', 'recording');
  await assert.rejects(disk.purgeProject('project-a'), { code: 'RECORDING_ACTIVE' });
  assert.equal(disk.assets.size, 2); assert.equal(disk.files.size, 2); assert.deepEqual(disk.events, ['lock:project-a']);
});

test('explicitly confirmed unfinished deletion frees orphan recordings without requiring a metadata seal', async () => {
  const disk = new FakeDiskBackend(); disk.add('orphan-a', 'project-a', 'vocal', 'opfs', 'recording'); disk.add('other-b', 'project-b');
  disk.put = async () => { throw Object.assign(new Error('Storage full'), { name: 'QuotaExceededError' }); };
  const result = await disk.purgeProject('project-a', { discardUnfinished: true });
  assert.equal(result.purged, true); assert.equal(result.deletedAssets, 1);
  assert.deepEqual([...disk.assets.keys()], ['other-b']); assert.deepEqual([...disk.files], ['other-b.pcm']);
  assert.equal(disk.projects.has('project-a'), false);
});

test('unfinished deletion opt-in still requires the project writer lock', async () => {
  const disk = new FakeDiskBackend(); disk.add('orphan-a', 'project-a', 'vocal', 'opfs', 'recording'); disk.foreign.add('project-a');
  await assert.rejects(disk.purgeProject('project-a', { discardUnfinished: true }), { code: 'PROJECT_BUSY' });
  assert.equal(disk.assets.has('orphan-a'), true); assert.deepEqual(disk.events, ['lock:project-a']);
});

test('partial quota-limited deletion retries its discoverability marker after freeing a file', async () => {
  const disk = new FakeDiskBackend(); disk.add('first-a', 'project-a'); disk.add('second-a', 'project-a'); disk.failFile = 'second-a.pcm';
  const put = disk.put.bind(disk); let attempts = 0;
  disk.put = async (...args) => { if (++attempts === 1) throw Object.assign(new Error('Storage full'), { name: 'QuotaExceededError' }); return put(...args); };
  await assert.rejects(disk.purgeProject('project-a'), { code: 'PROJECT_PURGE_INCOMPLETE' });
  assert.equal(attempts, 2); assert.ok(disk.projects.get('project-a').purgePendingAt);
  assert.equal(disk.assets.has('second-a'), true);
});

test('file deletion failure retains metadata and resumes safely on retry', async () => {
  const disk = new FakeDiskBackend(); disk.add('first-a', 'project-a'); disk.add('second-a', 'project-a'); disk.add('foreign-b', 'project-b'); disk.failFile = 'second-a.pcm';
  await assert.rejects(disk.purgeProject('project-a'), error => error.code === 'PROJECT_PURGE_INCOMPLETE' && error.deletedAssets === 1);
  assert.equal(disk.assets.has('first-a'), false); assert.equal(disk.assets.has('second-a'), true); assert.equal(disk.files.has('second-a.pcm'), true);
  assert.ok(disk.projects.get('project-a').purgePendingAt); assert.equal(disk.projects.has('project-b'), true);
  disk.failFile = null; const retried = await disk.purgeProject('project-a'); assert.equal(retried.deletedAssets, 1);
  assert.deepEqual([...disk.assets.keys()], ['foreign-b']); assert.equal(disk.projects.has('project-a'), false);
});

test('metadata deletion failure after file removal remains idempotently retryable', async () => {
  const disk = new FakeDiskBackend(); disk.add('loop-a', 'project-a'); disk.failAssetMetadata = 'loop-a';
  await assert.rejects(disk.purgeProject('project-a'), { code: 'PROJECT_PURGE_INCOMPLETE' });
  assert.equal(disk.files.has('loop-a.pcm'), false); assert.equal(disk.assets.has('loop-a'), true); assert.equal(disk.pages.has('loop-a'), true);
  disk.failAssetMetadata = null; await disk.purgeProject('project-a');
  assert.equal(disk.assets.size, 0); assert.equal(disk.pages.size, 0); assert.equal(disk.projects.size, 0);
});

test('a failure deleting final project metadata can be retried with no remaining assets', async () => {
  const disk = new FakeDiskBackend(); disk.add('loop-a', 'project-a'); disk.failProjectMetadata = true;
  await assert.rejects(disk.purgeProject('project-a'), { code: 'PROJECT_PURGE_INCOMPLETE' });
  assert.equal(disk.assets.size, 0); assert.equal(disk.projects.has('project-a'), true);
  disk.failProjectMetadata = false; await disk.purgeProject('project-a');
  const again = await disk.purgeProject('project-a'); assert.equal(again.purged, true); assert.equal(again.deletedAssets, 0); assert.equal(again.freedAudioBytes, 0);
});

test('inconsistent owner metadata stops purge without crossing project identifiers', async () => {
  const disk = new FakeDiskBackend(); const foreign = disk.add('loop-b', 'project-b');
  disk.listAssets = async () => [foreign];
  await assert.rejects(disk.purgeProject('project-a'), { code: 'ASSET_OWNER_MISMATCH' });
  assert.equal(disk.files.has('loop-b.pcm'), true); assert.equal(disk.assets.has('loop-b'), true);
  await assert.rejects(disk.deleteAsset('loop-b', 'project-a'), { code: 'ASSET_OWNER_MISMATCH' });
  assert.equal(disk.files.has('loop-b.pcm'), true);
});

test('unavailable OPFS never discards the only index of undeleted audio', async () => {
  const disk = new FakeDiskBackend(); disk.add('loop-a', 'project-a'); disk.directory = null;
  await assert.rejects(disk.purgeProject('project-a'), { code: 'PROJECT_PURGE_INCOMPLETE' });
  assert.equal(disk.assets.has('loop-a'), true); assert.equal(disk.pages.has('loop-a'), true);
});

test('a full disk can still be purged when even the optional deletion marker cannot be saved', async () => {
  const disk = new FakeDiskBackend(); disk.add('loop-a', 'project-a');
  disk.put = async () => { throw Object.assign(new Error('Storage full'), { name: 'QuotaExceededError' }); };
  const result = await disk.purgeProject('project-a');
  assert.equal(result.purged, true); assert.equal(disk.assets.size, 0); assert.equal(disk.projects.size, 0);
});

test('projectUsage totals audio metadata without reading PCM and includes mixes', async () => {
  const disk = new FakeDiskBackend(); disk.add('loop-a', 'project-a', 'loop', 'opfs', 'complete', 100); disk.add('mix-a', 'project-a', 'mix', 'opfs', 'complete', 200); disk.add('take-a', 'project-a', 'vocal', 'indexeddb', 'recording', 50); disk.add('foreign', 'project-b', 'mix');
  disk.readData = () => assert.fail('Usage must not read audio'); disk.openHandle = () => assert.fail('Usage must not open audio files');
  const usage = await disk.projectUsage('project-a');
  assert.equal(usage.audioBytes, 2200); assert.equal(usage.assetCount, 3); assert.equal(usage.recordingAssets, 1); assert.equal(usage.byKind.mix.bytes, 1600); assert.equal(usage.includesMetadataOverhead, false);
});

test('whole-project purge refuses shared audio before mutating any metadata or bytes', async () => {
  const disk = new FakeDiskBackend(); disk.add('shared-audio', 'owner');
  disk.projects.set('other-project', { id: 'other-project', name: 'Other song', deletedAt: 123, tracks: [{ assetId: 'shared-audio' }] });
  await assert.rejects(disk.purgeProject('owner'), error => error.code === 'PROJECT_AUDIO_SHARED' && /Other song/.test(error.message) && /individually in Storage/.test(error.message));
  assert.equal(disk.assets.has('shared-audio'), true); assert.equal(disk.files.has('shared-audio.pcm'), true);
  assert.equal(disk.projects.get('owner').purgePendingAt, undefined); assert.deepEqual(disk.events, ['lock:owner']);
});
