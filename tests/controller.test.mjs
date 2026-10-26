import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { createProject, createTrack, clone, validateProject, referencedAssets, MAX_TRACKS } from '../src/project.mjs';
import { removeAssetReferences } from '../src/storage-management.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
class FakeStorage extends EventTarget {
  constructor() { super(); this.assets = new Map(); this.projects = new Map(); this.saved = []; this.beginCalls = []; this.finishCalls = []; this.released = []; this.saveHook = null; this.beginHook = null; this.readHook = null; this.recoverError = null; }
  async estimate() { return { usage: 0, quota: 1000000000 }; }
  async listProjects() { return [...this.projects.values()].map(clone); }
  async listAssets(projectId) { return [...this.assets.values()].filter((asset) => asset.projectId === projectId).map(clone); }
  async loadProject(id) { return clone(this.projects.get(id)); }
  async saveProject(project) { if (this.saveHook) await this.saveHook(project); this.saved.push(clone(project)); this.projects.set(project.id, clone(project)); return { saved: true }; }
  async beginAsset(asset) { this.beginCalls.push(clone(asset)); if (this.beginHook) await this.beginHook(asset); this.assets.set(asset.id, { ...clone(asset), frames: 0, checkpointFrames: 0, status: 'recording' }); }
  async finishAsset(id, options = {}) { this.finishCalls.push({ id, ...options }); if (this.finishHook) await this.finishHook(id, options); const asset = this.assets.get(id); if (!asset) throw new Error('Asset not found'); Object.assign(asset, { ...options, status: options.status || 'complete', frames: asset.frames }); return clone(asset); }
  async putPage(id, index, buffer, frames) { const asset=this.assets.get(id); asset.frames+=frames; asset.checkpointFrames=asset.frames; }
  async deleteAsset(id) { if (this.deleteHook) await this.deleteHook(id); this.assets.delete(id); }
  async getAsset(id) { if (this.readHook) await this.readHook(id); const asset = this.assets.get(id); if (!asset) throw new Error('Asset not found'); return clone(asset); }
  async recover() { if (this.recoverError) throw this.recoverError; return []; }
  async releaseProject(id) { this.released.push(id); }
  async projectUsage(projectId) { return { projectId, audioBytes: (await this.listAssets(projectId)).reduce((bytes, asset) => bytes + asset.frames * asset.channels * 4, 0) }; }
  async getStorageInventory() {
    const files = [...this.assets.values()].map(asset => {
      const projects = [...this.projects.values()].filter(project => referencedAssets(project).includes(asset.id));
      return { ...clone(asset), assetKind: asset.kind, key: `asset:${asset.id}`, kind: 'asset', assetId: asset.id, bytes: asset.frames * asset.channels * 4,
        referencedProjectIds: projects.map(project => project.id), revision: JSON.stringify([asset, projects]) };
    });
    return { files, projects: await this.listProjects(), complete: true, unknownFiles: 0, errors: [], ...(await this.estimate()) };
  }
  async deleteStoredFile(file) {
    if (this.storedDeleteHook) await this.storedDeleteHook(file);
    const fresh = (await this.getStorageInventory()).files.find(item => item.id === file.id);
    if (!fresh || fresh.revision !== file.revision) throw new Error('File changed');
    for (const [id, project] of this.projects) { const result = removeAssetReferences(project, file.id); if (result.changed) this.projects.set(id, result.project); }
    if (this.storedPhysicalDeleteHook) await this.storedPhysicalDeleteHook(file);
    this.assets.delete(file.id); return { deleted: true };
  }
}
class FakeUI extends EventTarget {
  constructor() { super(); this.notifications = []; this.renders = []; }
  render(state) { this.renders.push({ status: state.status, busy: state.busy, capture: state.capture ? { ...state.capture } : null }); }
  notify(message, kind) { this.notifications.push({ message, kind }); }
}
class FakeEngine {
  constructor() { this.commands = []; this.micHook = null; this.node = {}; this.transportGeneration = 0; this.playing = false; }
  async enableMic() { if (this.micHook) await this.micHook(); }
  configure(project) { this.commands.push({ type: 'configure', id: project.id }); }
  syncTracks(tracks) { this.commands.push({ type: 'sync-tracks', ids: tracks.map(track => track.id) }); }
  arm(capture) { this.commands.push({ type: 'arm', capture }); }
  cancel() { this.commands.push({ type: 'cancel' }); }
  stop() { this.transportGeneration++; this.playing = false; this.commands.push({ type: 'stop' }); }
  pause() { this.transportGeneration++; this.playing = false; this.commands.push({ type: 'pause' }); }
  play() { this.transportGeneration++; this.playing = true; this.commands.push({ type: 'play' }); }
  disableMic() { this.commands.push({ type: 'mic-off' }); }
  send(type, payload) { this.commands.push({ type, payload }); }
  async close() { this.commands.push({ type: 'close' }); }
}
function fixture() {
  const storage = new FakeStorage(), ui = new FakeUI(), engine = new FakeEngine();
  const controller = new StudioController(storage, ui);
  controller.state.project = createProject('Test song'); controller.state.busy = false; controller.engine = engine;
  controller.ensureAudio = async () => engine; controller.keepAwake = async () => {}; controller.releaseWake = async () => {};
  controller.summarize = async () => []; controller.scheduleSave = () => {};
  return { controller, storage, ui, engine };
}
function finishedCapture(f, { kind = 'vocal', rawStatus = 'complete', masterStatus = 'complete', rawFrames = 100, masterFrames = 100, finalized = true } = {}) {
  const { controller, storage } = f, project = controller.state.project;
  const track = createTrack({ assetId: 'raw-1', name: kind === 'mix' ? 'Loop recording 1' : 'Vocal take 1', role: kind === 'loop' ? 'beat' : 'lead', frames: rawFrames });
  const done = deferred();
  controller.pending = { id: 'capture-1', kind, assetId: 'raw-1', masterAssetId: kind === 'vocal' ? 'master-1' : null, performanceId: 'performance-1', takeId: 'take-1',
    track, startFrame: 1000, createdAt: new Date().toISOString(), events: [], initialState: { tracks: [], baseFrames: 0, master: { volume: .8 }, input: clone(project.input), frame: 1000 },
    ended: true, end: { captureId: 'capture-1', kind, status: 'complete', startFrame: 1000, frames: rawFrames, track }, done: done.promise, resolveDone: done.resolve };
  project.pendingCapture = { id: 'capture-1', assetId: 'raw-1' };
  const raw = { id: 'raw-1', projectId: project.id, captureId: 'capture-1', channels: kind === 'mix' ? 2 : 1, sampleRate: 48000, kind: kind === 'mix' ? 'master' : kind, ...(kind === 'mix' ? { source: 'loops' } : {}), frames: rawFrames, checkpointFrames: rawFrames, status: rawStatus };
  storage.assets.set(raw.id, raw); controller.sealed.set(raw.id, { ...raw, finalized });
  if (kind === 'vocal') { const master = { id: 'master-1', projectId: project.id, captureId: 'capture-1', channels: 2, sampleRate: 48000, kind: 'master', frames: masterFrames, checkpointFrames: masterFrames, status: masterStatus }; storage.assets.set(master.id, master); controller.sealed.set(master.id, { ...master, finalized }); }
  controller.state.capture = { kind, status: 'finishing' };
  return done;
}
test('a dead storage worker stops the microphone and transport without waiting forever for sealing', async () => {
  const f=fixture(); const done=finishedCapture(f);
  f.controller.state.playing=true; f.controller.state.micEnabled=true;
  await f.controller.storageFailed('Storage worker crashed');
  await done.promise;
  assert.equal(f.controller.pending,null);assert.equal(f.controller.engine,null);
  assert.equal(f.controller.state.capture,null);assert.equal(f.controller.state.playing,false);
  assert.equal(f.controller.state.micEnabled,false);assert.equal(f.controller.state.storageFailed,true);
  assert.ok(f.engine.commands.some(command=>command.type==='close'));
  assert.equal(f.storage.assets.get('raw-1').frames,100);assert.equal(f.storage.saved.length,0);
  assert.ok(f.controller.state.project.pendingCapture,'persisted intent remains available for recovery');
  await assert.rejects(f.controller.handle({type:'add-loop'}),/Reopen the studio/);
  await f.controller.handle({type:'dismiss-error'});assert.match(f.controller.state.error,/Reopen the studio/);
});
test('a failed audio processor is retired so the next user gesture can open a fresh engine', async () => {
  const f=fixture(); f.controller.state.playing=true;f.controller.state.micEnabled=true;
  await f.controller.recoverAudioEngine('Audio processor crashed');
  assert.equal(f.controller.engine,null);assert.equal(f.controller.state.playing,false);assert.equal(f.controller.state.micEnabled,false);
  assert.ok(f.engine.commands.some(command=>command.type==='close'));
  assert.match(f.controller.state.error,/fresh audio session/);
  assert.equal(f.controller.state.storageFailed,undefined);
});

test('suspended playback exposes Play again, ignores stale meters, and resumes only on a user gesture', async () => {
  const f = fixture();
  f.engine.context = { state: 'suspended' }; f.controller.state.playing = true;
  f.controller.state.monitor = true; f.controller.state.project.input.monitor = true;
  f.controller.state.transportFrame = 731;
  f.controller.audioEvent('context-state', { state: 'suspended' });
  assert.equal(f.controller.engine, f.engine); assert.equal(f.controller.state.playing, false);
  assert.equal(f.controller.state.monitor, false); assert.equal(f.controller.state.project.input.monitor, false);
  assert.match(f.controller.state.status, /press Play or Record to resume/);
  assert.ok(f.engine.commands.some(command => command.type === 'pause'));
  f.controller.audioEvent('meter', { playing: true, transportFrame: 859, inputLevel: .7, outputLevel: .5 });
  assert.equal(f.controller.state.playing, false); assert.equal(f.controller.state.transportFrame, 731);
  f.engine.context.state = 'running'; f.controller.audioEvent('context-state', { state: 'running' });
  assert.equal(f.controller.state.playing, false); assert.equal(f.engine.commands.some(command => command.type === 'play'), false);
  await f.controller.handle({ type: 'play' });
  assert.equal(f.engine.commands.filter(command => command.type === 'play').length, 1);
  assert.equal(f.ui.notifications.length, 0);
});

test('normal audio closure and project switching do not display interruption errors', () => {
  for (const flag of ['closed', 'suppressedStateChange', 'openingProject']) {
    const f = fixture(), status = f.controller.state.status, generation = f.controller.generation;
    if (flag === 'openingProject') f.controller.openingProject = true; else f.engine[flag] = true;
    f.controller.audioEvent('context-state', { state: 'closed' });
    assert.equal(f.controller.state.status, status); assert.equal(f.controller.generation, generation);
    assert.equal(f.controller.audioRecovery, undefined); assert.equal(f.ui.notifications.length, 0); assert.equal(f.engine.commands.length, 0);
  }
});

test('an unexpectedly closed idle context is retired and offers a fresh audio session', async () => {
  const f = fixture(); f.engine.context = { state: 'closed' };
  f.controller.audioEvent('context-state', { state: 'closed' });
  await f.controller.audioRecovery; await tick();
  assert.equal(f.controller.engine, null); assert.equal(f.controller.state.playing, false);
  assert.equal(f.engine.commands.filter(command => command.type === 'close').length, 1);
  assert.match(f.controller.state.error, /fresh audio session/);
});

test('device suspension during microphone permission cannot arm a delayed recording', async () => {
  const f = fixture(), permission = deferred(); f.engine.micHook = () => permission.promise;
  const starting = f.controller.startCapture('loop'); await tick();
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture.status, 'arming');
  f.engine.context = { state: 'interrupted' };
  f.controller.audioEvent('context-state', { state: 'interrupted' });
  await f.controller.audioRecovery; permission.resolve(); await starting;
  assert.equal(f.engine.commands.some(command => command.type === 'arm'), false); assert.equal(f.storage.beginCalls.length, 0);
  assert.equal(f.controller.state.capture, null); assert.equal(f.controller.state.busy, false); assert.equal(f.controller.engine, null);
});

test('suspension during asset preparation lets its owner cancel without sealing an asset before creation', async () => {
  const f = fixture(), creation = deferred(); let count = 0;
  f.storage.beginHook = () => ++count === 1 ? creation.promise : undefined;
  const starting = f.controller.startCapture('vocal'); await tick();
  assert.ok(f.controller.pending); assert.equal(f.storage.assets.size, 0);
  f.engine.context = { state: 'suspended' }; f.controller.audioEvent('context-state', { state: 'suspended' });
  const recovery = f.controller.audioRecovery;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.storage.finishCalls.length, 0); assert.ok(f.controller.pending);
  creation.resolve(); await starting; await recovery;
  assert.equal(f.engine.commands.some(command => command.type === 'arm'), false);
  assert.equal(f.storage.assets.size, 0, 'cancelled preparation releases its stored audio');
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.project.pendingCapture, undefined);
  assert.equal(f.controller.state.capture, null); assert.equal(f.controller.engine, null);
});

test('overlapping context and microphone interruption notifications seal each captured stream once', async () => {
  const f = fixture(); finishedCapture(f, { rawStatus: 'recording', masterStatus: 'recording', masterFrames: 91 });
  f.controller.pending.started = true; f.controller.pending.ended = false; delete f.controller.pending.end; f.controller.sealed.clear();
  f.engine.context = { state: 'suspended' }; f.controller.state.playing = true;
  f.controller.audioEvent('context-state', { state: 'suspended' });
  f.controller.audioEvent('interrupted', { message: 'Microphone muted simultaneously' });
  f.controller.audioEvent('device-lost', { message: 'Microphone disconnected simultaneously' });
  await f.controller.audioRecovery; await tick();
  assert.deepEqual(f.storage.finishCalls.map(call => call.id).sort(), ['master-1', 'raw-1']);
  assert.equal(f.engine.commands.filter(command => command.type === 'interrupt').length, 1);
  assert.equal(f.engine.commands.filter(command => command.type === 'close').length, 1);
  assert.equal(f.controller.state.project.takes.length, 1); assert.equal(f.controller.state.project.performances.length, 1);
  assert.equal(f.controller.state.project.takes[0].frames, 100); assert.equal(f.controller.state.project.performances[0].frames, 91);
  assert.equal(f.controller.state.project.performances[0].status, 'interrupted');
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.playing, false); assert.equal(f.controller.engine, null);
  assert.equal(f.ui.notifications.filter(item => item.kind === 'error').length, 1);
});

test('a genuine capture end received during fallback sealing keeps its actual timing metadata', async () => {
  const f = fixture(); finishedCapture(f, { rawStatus: 'recording', masterStatus: 'recording' });
  const pending = f.controller.pending; pending.started = true; pending.ended = false; delete pending.end; f.controller.sealed.clear();
  const reached = deferred(), released = deferred();
  f.storage.finishHook = async id => { if (id === 'raw-1') { reached.resolve(); await released.promise; } };
  const interruption = f.controller.interrupt('Temporary interruption'); await reached.promise;
  const end = { captureId: pending.id, kind: 'vocal', status: 'complete', frames: 100, startFrame: 1000, endFrame: 1100, compensationFrames: 73 };
  f.controller.audioEvent('capture-end', end); released.resolve(); await interruption;
  assert.equal(pending.end, end); assert.equal(f.controller.state.project.performances[0].compensationFrames, 73);
  assert.equal(f.controller.state.project.performances.length, 1);
});

test('a slow failed-engine close cannot overwrite a newly opened engine or another project', async () => {
  for (const replacement of ['engine', 'project']) {
    const f = fixture(), closing = deferred(); f.engine.close = async () => closing.promise;
    const recovery = f.controller.recoverAudioEngine('Old processor failed'); await tick();
    assert.equal(f.controller.engine, null); assert.equal(f.controller.state.playing, false);
    if (replacement === 'engine') f.controller.engine = new FakeEngine(); else f.controller.state.project = createProject('New song');
    f.controller.state.status = 'New session ready'; f.controller.state.playing = true;
    closing.resolve(); await recovery;
    assert.equal(f.controller.state.status, 'New session ready'); assert.equal(f.controller.state.playing, true);
    assert.equal(f.ui.notifications.length, 0);
  }
});

test('a fatal storage failure during audio interruption retains the storage recovery message and checkpoints', async () => {
  const f = fixture(); finishedCapture(f, { rawStatus: 'recording', masterStatus: 'recording' });
  f.controller.pending.started = true; f.controller.pending.ended = false; delete f.controller.pending.end; f.controller.sealed.clear();
  f.engine.context = { state: 'suspended' };
  f.controller.audioEvent('context-state', { state: 'suspended' });
  const recovery = f.controller.audioRecovery;
  await f.controller.storageFailed('Storage connection lost'); const banner = f.controller.state.error;
  await recovery;
  assert.equal(f.controller.state.error, banner); assert.match(banner, /Reopen the studio/);
  assert.equal(f.storage.finishCalls.length, 0); assert.equal(f.storage.assets.get('raw-1').frames, 100);
  assert.ok(f.controller.state.project.pendingCapture); assert.equal(f.controller.state.storageFailed, true);
});
test('canceling permanent project deletion leaves recordings and playback untouched', async () => {
  const f=fixture();f.storage.projects.set(f.controller.state.project.id,clone(f.controller.state.project));
  f.ui.confirm=async()=>false;f.storage.purgeProject=()=>{throw new Error('must not purge');};
  await f.controller.deleteProject(f.controller.state.project.id);
  assert.equal(f.engine.commands.length,0);assert.equal(f.storage.projects.size,1);
});

test('confirmed deletion frees the only quota-full project before saving its replacement', async () => {
  const f = fixture(), project = clone(f.controller.state.project), order = [];
  f.storage.projects.set(project.id, project); f.ui.confirm = async () => true;
  f.controller.state.readonly = true; f.controller.state.recoveryRequired = true;
  let full = true;
  f.storage.saveHook = async next => { order.push('save'); assert.notEqual(next.id, project.id); if (full) throw Object.assign(new Error('Storage full'), { code: 'QUOTA_EXCEEDED' }); };
  f.storage.purgeProject = async (id, options) => {
    order.push('purge'); assert.equal(id, project.id); assert.deepEqual(options, { discardUnfinished: true });
    assert.equal(f.controller.engine, null); assert.ok(f.engine.commands.some(command => command.type === 'close'));
    assert.equal(f.controller.state.readonly, true); assert.equal(f.controller.state.deletionPending, true);
    full = false; f.storage.projects.delete(id);
  };
  await f.controller.deleteProject(project.id);
  assert.deepEqual(order, ['purge', 'save']); assert.notEqual(f.controller.state.project.id, project.id);
  assert.equal(f.controller.state.readonly, false); assert.equal(f.controller.state.deletionPending, false);
  assert.equal(f.controller.state.recoveryRequired, false); assert.equal(f.controller.state.busy, false);
  assert.equal(f.storage.projects.size, 1); assert.equal(f.storage.projects.has(project.id), false);
});

test('partial current-project purge remains frozen with Manage storage and permanent deletion retry available', async () => {
  const f = fixture(), project = clone(f.controller.state.project); f.storage.projects.set(project.id, project);
  f.storage.assets.set('leftover', { id: 'leftover', projectId: project.id, status: 'recording', frames: 64 });
  f.ui.confirm = async () => true; let attempts = 0;
  f.storage.purgeProject = async (id, options) => {
    assert.deepEqual(options, { discardUnfinished: true });
    if (++attempts === 1) { f.storage.projects.get(id).purgePendingAt = Date.now(); throw Object.assign(new Error('Injected disk failure'), { code: 'PROJECT_PURGE_INCOMPLETE' }); }
    f.storage.projects.delete(id); f.storage.assets.delete('leftover');
  };
  f.controller.saveTimer = setTimeout(() => assert.fail('A frozen project must not autosave'), 10000);
  await assert.rejects(f.controller.deleteProject(project.id), { code: 'PROJECT_PURGE_INCOMPLETE' });
  assert.equal(f.controller.state.project.id, project.id); assert.equal(f.controller.engine, null);
  assert.equal(f.controller.state.deletionPending, true); assert.equal(f.controller.state.readonly, true);
  assert.equal(f.controller.state.busy, false); assert.equal(f.controller.saveTimer, null);
  assert.match(f.controller.state.readonlyReason, /retry permanent deletion/i);
  for (const type of ['play', 'sing', 'add-loop', 'retry-recovery', 'export-project', 'preview-mix']) {
    await assert.rejects(f.controller.handle({ type }), /deletion|deleting/i);
  }
  await assert.rejects(StudioController.prototype.ensureAudio.call(f.controller), /being deleted/);
  await assert.rejects(f.controller.withExport(() => assert.fail('must not export')), /deleting/);
  f.storage.projectUsage = async id => ({ projectId: id, audioBytes: 256 });
  await f.controller.handle({ type: 'manage-storage' }); assert.equal(f.controller.state.storageProjects[0].id, project.id);
  await f.controller.handle({ type: 'delete-project', id: project.id });
  assert.equal(attempts, 2); assert.equal(f.storage.assets.size, 0); assert.equal(f.controller.state.deletionPending, false);
  assert.notEqual(f.controller.state.project.id, project.id);
});

test('current-project deletion waits for an existing save before removing its manifest', async () => {
  const f = fixture(), project = clone(f.controller.state.project), saving = deferred();
  f.storage.projects.set(project.id, project); f.ui.confirm = async () => true;
  f.controller.saveChain = saving.promise; let purges = 0;
  f.storage.purgeProject = async id => { purges++; f.storage.projects.delete(id); };
  const deleting = f.controller.deleteProject(project.id); await tick();
  assert.equal(purges, 0); assert.equal(f.controller.state.deletionPending, true);
  assert.equal(f.controller.engine, null); await assert.rejects(f.controller.openProject(null), /deletion to finish/);
  await f.controller.handle({ type: 'stop' }); assert.equal(f.controller.state.busy, true);
  await assert.rejects(f.controller.handle({ type: 'new-project', name: 'Racing replacement' }), /deletion to finish/);
  saving.resolve(); await deleting; assert.equal(purges, 1); assert.equal(f.storage.projects.has(project.id), false);
});

test('a failed replacement save after successful purge keeps the deleted manifest frozen until another project opens', async () => {
  const f = fixture(), project = clone(f.controller.state.project); f.storage.projects.set(project.id, project); f.ui.confirm = async () => true;
  f.storage.purgeProject = async id => f.storage.projects.delete(id);
  f.storage.saveHook = async () => { throw Object.assign(new Error('Disk unavailable'), { code: 'QUOTA_EXCEEDED' }); };
  await assert.rejects(f.controller.deleteProject(project.id), { code: 'QUOTA_EXCEEDED' });
  assert.equal(f.storage.projects.has(project.id), false); assert.equal(f.controller.state.readonly, true);
  assert.equal(f.controller.state.deletionPending, true); assert.match(f.controller.state.readonlyReason, /was deleted/);
  assert.equal(f.controller.state.busy, false); assert.equal(f.controller.state.projects.length, 0);
  f.storage.saveHook = null; await f.controller.handle({ type: 'new-project', name: 'Fresh start' });
  assert.equal(f.controller.state.project.name, 'Fresh start'); assert.equal(f.controller.state.deletionPending, false);
});

test('a foreign project lock blocks confirmed deletion and leaves its audio indexed for retry', async () => {
  const f = fixture(), project = clone(f.controller.state.project); f.storage.projects.set(project.id, project); f.ui.confirm = async () => true;
  f.storage.assets.set('foreign-active', { id: 'foreign-active', projectId: project.id, status: 'recording', frames: 64 });
  f.storage.purgeProject = async () => { throw Object.assign(new Error('Another tab is recording'), { code: 'PROJECT_BUSY' }); };
  await assert.rejects(f.controller.deleteProject(project.id), { code: 'PROJECT_BUSY' });
  assert.equal(f.storage.projects.has(project.id), true); assert.equal(f.storage.assets.has('foreign-active'), true);
  assert.equal(f.controller.state.deletionPending, true); assert.equal(f.controller.state.readonly, true);
  assert.equal(f.controller.state.busy, false); assert.equal(f.storage.saved.length, 0);
});

test('switching projects while deletion confirmation is open cancels that stale deletion', async () => {
  const f = fixture(), project = clone(f.controller.state.project), confirm = deferred(); f.storage.projects.set(project.id, project);
  f.ui.confirm = () => confirm.promise; let purges = 0; f.storage.purgeProject = async () => purges++;
  const deleting = f.controller.deleteProject(project.id); await tick();
  ++f.controller.generation; f.controller.state.project = createProject('Another song'); confirm.resolve(true); await deleting;
  assert.equal(purges, 0); assert.equal(f.controller.state.deletionPending, false); assert.equal(f.controller.projectDeletion, null);
});

test('deleting a different project keeps default unfinished-recording protection and the current project writable', async () => {
  const f = fixture(), original = f.controller.state.project, other = createProject('Another song');
  f.storage.projects.set(original.id, clone(original)); f.storage.projects.set(other.id, other); f.ui.confirm = async () => true;
  f.storage.purgeProject = async (id, options) => { assert.equal(id, other.id); assert.deepEqual(options, {}); f.storage.projects.delete(id); };
  await f.controller.deleteProject(other.id);
  assert.equal(f.controller.state.project, original); assert.equal(f.controller.state.readonly, false);
  assert.equal(f.controller.state.deletionPending, false); assert.equal(f.controller.engine, f.engine);
});

test('reload of the only partially deleted project restores a frozen retry session without allocating a replacement', async () => {
  const f = fixture(), project = clone(f.controller.state.project), previousDocument = globalThis.document;
  project.purgePendingAt = Date.now(); f.storage.projects.set(project.id, project);
  f.controller.state.project = null; f.storage.init = async () => ({ backend: 'opfs' });
  f.storage.saveHook = async () => assert.fail('Reload must not allocate another project before freeing storage');
  f.storage.recover = async () => assert.fail('Partly deleted audio must not be recovered or republished');
  globalThis.document = { addEventListener() {}, querySelector() { return null; } };
  try { await f.controller.init(); } finally { globalThis.document = previousDocument; }
  assert.equal(f.controller.state.project.id, project.id); assert.equal(f.controller.state.deletionPending, true);
  assert.equal(f.controller.state.readonly, true); assert.equal(f.controller.state.recoveryRequired, false);
  assert.match(f.controller.state.status, /Deletion unfinished/); assert.equal(f.storage.saved.length, 0);
  f.storage.projectUsage = async id => ({ projectId: id, audioBytes: 0 });
  await f.controller.handle({ type: 'manage-storage' }); assert.equal(f.controller.state.storageProjects[0].purgePending, true);
  await assert.rejects(f.controller.handle({ type: 'play' }), /deletion/);
  await assert.rejects(f.controller.handle({ type: 'save' }), /deletion/);
});

test('a failed recovery seal still closes the dead processor and preserves capture intent', async () => {
  const f=fixture(); const done=finishedCapture(f); f.controller.pending.ended=false;
  f.storage.finishHook=()=>{throw new Error('Seal unavailable');};
  f.storage.readHook=()=>{throw new Error('Checkpoint temporarily unavailable');};
  await f.controller.recoverAudioEngine('Audio processor crashed'); await done.promise;
  assert.equal(f.controller.engine,null); assert.equal(f.controller.pending,null);
  assert.equal(f.controller.state.capture,null); assert.equal(f.controller.state.busy,false);
  assert.ok(f.engine.commands.some(command=>command.type==='close'));
  assert.ok(f.controller.state.project.pendingCapture);
  assert.match(f.controller.state.error,/Reopen this project/);
  assert.equal(f.storage.assets.get('raw-1').frames,100);
});

test('concurrent project opening cannot let a slow earlier request replace a later selection', async () => {
  const f=fixture(), load=deferred(), first=createProject('First'), second=createProject('Second');
  f.storage.projects.set(first.id,first);f.storage.projects.set(second.id,second);
  f.storage.loadProject=async id=>{if(id===first.id)await load.promise;return clone(f.storage.projects.get(id));};
  const opening=f.controller.openProject(first.id); await tick();
  await assert.rejects(f.controller.openProject(second.id),/still opening/);
  load.resolve();await opening;
  assert.equal(f.controller.state.project.id,first.id);
  await f.controller.openProject(second.id);assert.equal(f.controller.state.project.id,second.id);
});

test('a completed older save does not change the timestamp or status of another project', async () => {
  const f=fixture(), save=deferred();f.storage.saveHook=()=>save.promise;
  const old=f.controller.state.project, saving=f.controller.saveNow();await tick();
  const next=createProject('Different project');next.updatedAt='2000-01-01T00:00:00.000Z';
  f.controller.state.project=next;f.controller.state.status='Opening different project';save.resolve();await saving;
  assert.equal(f.storage.saved.at(-1).id,old.id);assert.equal(next.updatedAt,'2000-01-01T00:00:00.000Z');
  assert.equal(f.controller.state.status,'Opening different project');
});

test('reopening exposes audio named by an unfinished capture intent for recovery', async () => {
  const f=fixture(), project=createProject('Interrupted song');
  project.pendingCapture={id:'capture-1',assetId:'raw-pending',masterAssetId:'master-pending'};
  f.storage.projects.set(project.id,project);
  for(const [id,channels] of [['raw-pending',1],['master-pending',2]]) f.storage.assets.set(id,{id,projectId:project.id,channels,sampleRate:48000,frames:128,status:'recovered'});
  await f.controller.openProject(project.id);
  assert.deepEqual(new Set(f.controller.state.recovered.map(asset=>asset.id)),new Set(['raw-pending','master-pending']));
  assert.ok(f.ui.notifications.some(item=>/unfinished recording was recovered.*Manage storage/i.test(item.message)));
});

test('Stop cancels recorded playback preparation without creating a late audio player', async () => {
  const f=fixture(), read=deferred(), id='preview-raw';
  f.storage.assets.set(id,{id,frames:128,channels:1,sampleRate:48000,status:'complete',name:'Take'});
  f.storage.getAssetFile=async()=>{await read.promise;return new Blob([new Float32Array(128)]);};
  const preparing=f.controller.previewRecordedAsset(id,'Take');await tick();
  assert.equal(f.controller.state.previewPreparing.name,'Take');
  await f.controller.handle({type:'stop'});assert.equal(f.controller.state.previewPreparing,null);
  read.resolve();await preparing;assert.equal(f.controller.state.preview,null);assert.equal(f.controller.urls.size,0);
});

test('numbered WAV exports retain every part even when automatic multi-file downloads are blocked', () => {
  const f=fixture(), result={blob:new Blob(['test']),filename:'part.wav'};
  for(let part=1;part<=20;part++) f.controller.offerDownload({...result,part,partCount:20},`Part ${part}`,{group:'long-recording',autoDownload:false,notify:false});
  for(let i=0;i<7;i++) f.controller.offerDownload(result,'Another export',{group:`other-${i}`,autoDownload:false,notify:false});
  assert.equal(f.controller.state.downloads.filter(item=>item.group==='long-recording').length,20);
  assert.equal(f.controller.urls.size,27);
  f.controller.offerDownload(result,'Ninth export',{group:'ninth',autoDownload:false,notify:false});
  assert.equal(f.controller.state.downloads.length,8);assert.equal(f.controller.urls.size,8);
  for(const url of f.controller.urls)URL.revokeObjectURL(url);
});

test('microphone selection is session-only, validates available inputs, and is blocked during capture', async () => {
  const f=fixture(), selected=[];f.engine.enableMic=async deviceId=>selected.push(deviceId);
  f.controller.state.micDevices=[{id:'usb-mic',label:'USB microphone'}];
  await assert.rejects(f.controller.selectMicrophone('unknown'),/available microphone/);
  await f.controller.selectMicrophone('usb-mic');
  assert.deepEqual(selected,['usb-mic']);assert.equal(f.controller.state.preferredDeviceId,'usb-mic');
  assert.equal(JSON.stringify(f.controller.state.project).includes('usb-mic'),false);
  f.controller.state.capture={kind:'vocal',status:'recording'};
  await assert.rejects(f.controller.selectMicrophone(''),/Finish or cancel/);
});

test('Stop during microphone replacement does not leave the recording controls busy', async () => {
  const f=fixture(), permission=deferred();f.engine.enableMic=()=>permission.promise;
  f.controller.state.micDevices=[{id:'usb-mic',label:'USB microphone'}];
  const selecting=f.controller.selectMicrophone('usb-mic');await tick();
  assert.equal(f.controller.state.micChanging,true);
  await f.controller.handle({type:'stop'});assert.equal(f.controller.state.micChanging,false);assert.equal(f.controller.state.busy,false);
  permission.resolve();await selecting;assert.equal(f.controller.state.preferredDeviceId,'');
});

test('autosave reports pending changes immediately and an older write cannot mark newer changes saved', async () => {
  const f=fixture(), write=deferred();f.controller.scheduleSave=StudioController.prototype.scheduleSave;
  f.storage.saveHook=()=>write.promise;f.controller.state.status='Saved on this device';
  f.controller.edit(project=>{project.name='Renamed song';});
  assert.equal(f.controller.state.status,'Saving…');
  const first=f.controller.flushSave();await tick();
  f.controller.edit(project=>{project.name='Another edit';});write.resolve();await first;
  assert.equal(f.controller.state.status,'Saving…','queued newer edits remain visibly unsaved');
  await f.controller.flushSave();
  assert.equal(f.controller.state.status,'Saved on this device');assert.equal(f.storage.saved.at(-1).name,'Another edit');
});

test('a performance commits only after both raw vocal and master seal', async () => {
  const f = fixture(); finishedCapture(f); const masterSeal = f.controller.sealed.get('master-1'); f.controller.sealed.delete('master-1');
  await f.controller.tryFinalize();
  assert.equal(f.storage.saved.length, 0); assert.equal(f.controller.state.project.performances.length, 0); assert.ok(f.controller.pending);
  f.controller.sealed.set('master-1', masterSeal); await f.controller.tryFinalize();
  assert.equal(f.controller.state.project.performances.length, 1); assert.equal(f.controller.state.project.takes.length, 1);
  assert.equal(f.storage.saved.at(-1).performances.length, 1); assert.equal(f.storage.saved.at(-1).pendingCapture, undefined);
  assert.equal(f.controller.pending, null);
});

for (const kind of ['loop', 'vocal', 'mix']) {
  test(`recent ${kind} recording is published only after its project save commits and keeps the current view`, async () => {
    const f = fixture(), saved = deferred();
    const previous = { kind: 'loop', id: 'previous-loop', captureId: 'previous-capture' };
    f.controller.state.recentRecording = previous; f.controller.state.view = 'mix';
    finishedCapture(f, { kind });
    const expected = { kind: kind === 'loop' ? 'loop' : 'performance', id: kind === 'loop' ? f.controller.pending.track.id : 'performance-1', captureId: 'capture-1' };
    f.storage.saveHook = () => saved.promise;
    const finalizing = f.controller.tryFinalize(); await tick();
    assert.equal(f.controller.state.recentRecording, previous, 'uncommitted capture must not replace the last saved recording');
    assert.equal(f.controller.state.capture.status, 'finishing');
    assert.equal(f.storage.saved.length, 0);
    saved.resolve(); await finalizing;
    assert.deepEqual(f.controller.state.recentRecording, expected);
    assert.equal(f.controller.state.capture, null);
    assert.equal(f.controller.state.view, 'mix');
    assert.equal(f.storage.saved.length, 1);
    assert.equal(f.storage.saved[0].recentRecording, undefined, 'recent recording is session UI state, not project data');
  });
}

test('the recent performance waits for both audio streams to seal', async () => {
  const f = fixture(); finishedCapture(f);
  const master = f.controller.sealed.get('master-1'); f.controller.sealed.delete('master-1');
  await f.controller.tryFinalize();
  assert.equal(f.controller.state.recentRecording, null);
  f.controller.sealed.set('master-1', master); await f.controller.tryFinalize();
  assert.deepEqual(f.controller.state.recentRecording, { kind: 'performance', id: 'performance-1', captureId: 'capture-1' });
});

for (const kind of ['loop', 'vocal', 'mix']) {
  test(`discarded ${kind} capture does not become the recent saved recording`, async () => {
    const f = fixture(), previous = { kind: 'loop', id: 'previous-loop', captureId: 'previous-capture' };
    f.controller.state.recentRecording = previous;
    finishedCapture(f, { kind, rawStatus: 'cancelled', masterStatus: 'cancelled' });
    f.controller.pending.end.status = 'cancelled';
    await f.controller.tryFinalize();
    assert.equal(f.controller.state.recentRecording, previous);
    assert.equal(f.controller.state.capture, null);
    assert.equal(f.controller.state.project.tracks.length, 0);
    assert.equal(f.controller.state.project.performances.length, 0);
  });
}

for (const kind of ['loop', 'vocal', 'mix']) {
  test(`a failed ${kind} project save does not publish a recent recording`, async () => {
    const f = fixture(), previous = { kind: 'loop', id: 'previous-loop', captureId: 'previous-capture' };
    f.controller.state.recentRecording = previous;
    finishedCapture(f, { kind });
    f.storage.saveHook = () => { throw new Error('Cannot commit recorded project'); };
    await assert.rejects(f.controller.tryFinalize(), /Cannot commit/);
    assert.equal(f.controller.state.recentRecording, previous);
    assert.equal(f.storage.saved.length, 0);
    assert.ok(f.storage.assets.has('raw-1'), 'audio remains available for recovery');
    assert.equal(f.controller.state.capture, null);
  });
}

test('audio still requiring recovery is not described as a recent playable recording', async () => {
  const f = fixture(); finishedCapture(f, { rawStatus: 'recording', masterStatus: 'recording', finalized: false });
  f.storage.finishHook = () => { throw new Error('Seal unavailable'); };
  f.storage.recoverError = new Error('Recovery unavailable');
  await f.controller.tryFinalize();
  assert.equal(f.controller.state.recentRecording, null);
  assert.equal(f.controller.state.project.performances.length, 0);
  assert.equal(f.controller.state.recovered.length, 2);
});

test('opening another project clears the recent recording instead of pointing to foreign audio', async () => {
  const f = fixture(); finishedCapture(f); await f.controller.tryFinalize();
  assert.equal(f.controller.state.recentRecording.id, 'performance-1');
  const next = createProject('New song'); f.storage.projects.set(next.id, next);
  await f.controller.openProject(next.id);
  assert.equal(f.controller.state.project.id, next.id);
  assert.equal(f.controller.state.recentRecording, null);
  assert.equal(f.controller.state.capture, null);
});

for (const kind of ['loop', 'vocal', 'mix']) {
  test(`opening a saved ${kind} project restores immediate playback below the recorder`, async () => {
    const f = fixture(); finishedCapture(f, { kind }); await f.controller.tryFinalize();
    const expected = { kind: f.controller.state.recentRecording.kind, id: f.controller.state.recentRecording.id };
    const projectId = f.controller.state.project.id;
    await f.controller.openProject(projectId);
    assert.deepEqual(f.controller.state.recentRecording, expected);
    assert.equal(f.controller.state.capture, null);
    assert.equal(f.controller.state.view, 'build');
  });
}

test('removed performances do not reappear as the latest recording after reopening', async () => {
  const f = fixture(); finishedCapture(f); await f.controller.tryFinalize();
  f.controller.state.project.performances[0].removed = true;
  await f.controller.saveNow();
  await f.controller.openProject(f.controller.state.project.id);
  assert.equal(f.controller.state.recentRecording, null);
  assert.equal(f.controller.state.project.takes.length, 1);
});

test('reopening selects the newest saved audio rather than the previously selected mix channel', async () => {
  const f = fixture(); finishedCapture(f); await f.controller.tryFinalize();
  const project = f.controller.state.project;
  project.performances[0].createdAt = '2026-10-13T00:00:00.000Z';
  const track = createTrack({ assetId: 'raw-1', name: 'Newer loop', frames: 100, createdAt: '2026-10-14T00:00:00.000Z' });
  project.tracks.push(track); project.baseFrames = 100;
  await f.controller.saveNow();
  await f.controller.openProject(project.id);
  assert.deepEqual(f.controller.state.recentRecording, { kind: 'loop', id: track.id });
});

test('real meter events forward their microphone peak, RMS and capture identity to the live input display', () => {
  const f = fixture(), forwarded = [];
  f.ui.updateLiveInput = data => forwarded.push(data);
  const sample = { inputLevel: .7, inputRms: .24, outputLevel: .3, playing: true, capture: { id: 'live-capture', kind: 'vocal', status: 'recording', elapsedFrames: 1200 } };
  f.controller.audioEvent('meter', sample);
  assert.deepEqual(forwarded, [sample]);
  assert.equal(f.controller.state.inputLevel, .7);
  f.controller.audioEvent('state', { playing: true, capture: sample.capture });
  f.controller.render();
  assert.equal(forwarded.length, 1, 'state changes and renders must not manufacture waveform samples');
});

test('stale meter events from suspended or closed audio do not advance the microphone display', () => {
  for (const state of ['suspended', 'interrupted', 'closed']) {
    const f = fixture(), forwarded = [];
    f.engine.context = { state };
    f.ui.updateLiveInput = data => forwarded.push(data);
    f.controller.audioEvent('meter', { inputLevel: .9, inputRms: .6, playing: true, capture: { id: 'stale-capture', status: 'recording' } });
    assert.equal(forwarded.length, 0);
    assert.equal(f.controller.state.inputLevel, 0);
    assert.equal(f.controller.state.capture, null);
  }
});

test('recent loop playback targets its recorded source and keeps the current view', async () => {
  const f = fixture(); finishedCapture(f, { kind: 'loop' }); await f.controller.tryFinalize();
  f.controller.state.view = 'mix';
  const previews = []; f.controller.previewRecordedAsset = async (assetId, name) => previews.push({ assetId, name });
  const track = f.controller.state.project.tracks[0];
  await f.controller.handle({ type: 'preview-track', id: f.controller.state.recentRecording.id });
  assert.deepEqual(previews, [{ assetId: track.assetId, name: track.name }]);
  assert.equal(f.controller.state.view, 'mix');
  await f.controller.handle({ type: 'preview-track', id: 'missing-track' });
  assert.equal(previews.length, 1);
});

test('an incomplete arrangement preserves full recorded audio while limiting edits to its acknowledged prefix', async () => {
  const f = fixture(); finishedCapture(f);
  f.controller.pending.arrangementIncomplete = true; f.controller.pending.arrangementThroughFrame = 1043;
  await f.controller.tryFinalize();
  const project = f.controller.state.project, performance = project.performances[0];
  assert.equal(performance.status, 'interrupted'); assert.equal(performance.arrangementIncomplete, true);
  assert.equal(performance.frames, 100); assert.equal(performance.editableFrames, 43);
  assert.equal(project.takes[0].frames, 100); assert.equal(f.storage.assets.get('master-1').frames, 100);
  const { prepareRenderPlan } = await import('../src/export/render.mjs');
  const plan = await prepareRenderPlan(f.storage, project, { performanceId: performance.id, tailSeconds: 0 });
  assert.equal(plan.bodyFrames, 43);
  await assert.rejects(prepareRenderPlan(f.storage, project, { performanceId: performance.id, durationSeconds: 100 / 48000 }), { code: 'INCOMPLETE_PERFORMANCE' });
});

test('an incomplete arrangement without a valid boundary never claims an editable exact prefix', async () => {
  const f = fixture(); finishedCapture(f); f.controller.pending.arrangementIncomplete = true;
  await f.controller.tryFinalize();
  assert.equal(f.controller.state.project.performances[0].editableFrames, 0);
  assert.equal(f.controller.state.project.performances[0].frames, 100);
});

for (const fault of [{ masterStatus: 'interrupted' }, { masterFrames: 91 }, { masterStatus: 'recording', finalized: false }]) {
  test(`partial performance never reports complete success (${JSON.stringify(fault)})`, async () => {
    const f = fixture(); finishedCapture(f, fault); await f.controller.tryFinalize();
    assert.equal(f.controller.state.project.performances[0].status, 'interrupted');
    assert.notEqual(f.controller.state.status, 'Saved on this device');
    assert.equal(f.ui.notifications.some((item) => item.kind === 'success' && /performance saved/i.test(item.message)), false);
  });
}

test('duplicate capture-end and seal notifications publish one take', async () => {
  const f = fixture(); finishedCapture(f); const gate = deferred(); f.storage.readHook = () => gate.promise;
  const first = f.controller.tryFinalize(); await f.controller.tryFinalize(); gate.resolve(); await first;
  assert.equal(f.controller.state.project.takes.length, 1); assert.equal(f.controller.state.project.performances.length, 1);
});

test('a metadata read failure clears finishing so recovery remains reachable', async () => {
  const f = fixture(); finishedCapture(f); f.storage.readHook = () => { throw new Error('Storage disconnected'); };
  await assert.rejects(f.controller.tryFinalize(), /Storage disconnected/);
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
  assert.doesNotThrow(() => f.controller.assertIdle());
  assert.equal(f.ui.notifications.some((item) => item.kind === 'success'), false);
});

test('project commit failure leaves both audio assets available and reports unsaved metadata', async () => {
  const f = fixture(); finishedCapture(f); f.storage.saveHook = () => { throw new Error('Metadata quota exceeded'); };
  await assert.rejects(f.controller.tryFinalize(), /Metadata quota exceeded/);
  assert.equal(f.storage.assets.get('raw-1').frames, 100); assert.equal(f.storage.assets.get('master-1').frames, 100);
  assert.equal(f.controller.state.project.takes.length, 1, 'in-memory recovery information retained');
  assert.match(f.controller.state.status, /save needs attention/i);
  assert.equal(f.controller.state.capture, null);
});

test('final metadata commit keeps a second recording from overwriting finishing state', async () => {
  const f = fixture(); finishedCapture(f); const commit = deferred(); f.storage.saveHook = () => commit.promise;
  const finishing = f.controller.tryFinalize(); await tick();
  assert.ok(f.controller.pending, 'capture stays owned until final project commit');
  await assert.rejects(f.controller.startCapture('loop'), /recording is already active/);
  assert.equal(f.controller.state.capture.status, 'finishing');
  commit.resolve(); await finishing;
  assert.equal(f.controller.pending, null); assert.equal(f.storage.saved.at(-1).pendingCapture, undefined);
});

for (const action of ['cancel', 'stop', 'mic-off']) {
  test(`${action} during microphone permission cannot arm a delayed recording`, async () => {
    const f = fixture(), permission = deferred(); f.engine.micHook = () => permission.promise;
    const start = f.controller.startCapture('loop'); await tick(); await f.controller.handle({ type: action }); permission.resolve(); await start;
    assert.equal(f.engine.commands.some((item) => item.type === 'arm'), false); assert.equal(f.storage.beginCalls.length, 0);
    assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null); assert.equal(f.controller.state.busy, false);
  });
}

test('cancel during asset creation seals prepared assets without arming', async () => {
  const f = fixture(), firstBegin = deferred(); let begun = 0;
  f.storage.beginHook = () => ++begun === 1 ? firstBegin.promise : undefined;
  const start = f.controller.startCapture('vocal'); await tick(); assert.ok(f.controller.pending);
  await f.controller.handle({ type: 'cancel' }); firstBegin.resolve(); await start;
  assert.equal(f.engine.commands.some((item) => item.type === 'arm'), false);
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
  assert.equal(f.storage.assets.size, 0, 'cancelled preparation releases its stored audio');
});

test('failed second-asset preparation cancels the first asset and never arms', async () => {
  const f = fixture(); let begun = 0;
  f.storage.beginHook = () => { if (++begun === 2) throw new Error('Master storage quota'); };
  await assert.rejects(f.controller.startCapture('vocal'), /Master storage quota/);
  assert.equal(f.engine.commands.some((item) => item.type === 'arm'), false);
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
  assert.equal(f.storage.assets.size, 0, 'partly prepared recording is discarded after its intent is saved');
});

test('an incompatible loop length and timing alignment is rejected before creating recording assets', async () => {
  const f = fixture(); f.controller.state.project.baseFrames = 24000; f.controller.state.project.input.compensationMs = 1000;
  await assert.rejects(f.controller.startCapture('loop', 1), /longer than 1003 ms.*Recording compensation/);
  assert.equal(f.storage.beginCalls.length, 0); assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
  assert.equal(f.controller.state.busy, false); assert.equal(f.engine.commands.some(command => command.type === 'arm'), false);
  f.controller.state.project.input.compensationMs = 0;
  await f.controller.startCapture('loop', 1); assert.ok(f.controller.pending); assert.ok(f.engine.commands.some(command => command.type === 'arm'));
});

test('a correlated arm rejection clears prepared assets and allows a later recording', async () => {
  const f = fixture(); await f.controller.startCapture('vocal');
  const p = f.controller.pending, originalError = console.error; console.error = () => {};
  try {
    f.controller.audioEvent('capture-rejected', { captureId: p.id, message: 'Recording buffers are not ready.', activeCaptureId: null });
    const rejection = p.rejection;
    f.controller.audioEvent('capture-rejected', { captureId: p.id, message: 'Duplicate rejection', activeCaptureId: null });
    await rejection;
  } finally { console.error = originalError; }
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null); assert.equal(f.storage.assets.size, 0);
  assert.equal(f.storage.saved.at(-1).pendingCapture, undefined); assert.match(f.controller.state.error, /Recording buffers are not ready/);
  assert.equal(f.ui.notifications.filter(item => item.kind === 'error').length, 1);
  await f.controller.startCapture('loop'); assert.ok(f.controller.pending); assert.equal(f.controller.state.error, null);
});

test('arm rejection cannot cancel another capture or an already active matching capture', async () => {
  const f = fixture(); await f.controller.startCapture('loop'); const p = f.controller.pending;
  f.controller.audioEvent('capture-rejected', { captureId: 'unrelated', message: 'Old arm failed' });
  f.controller.audioEvent('capture-rejected', { captureId: p.id, activeCaptureId: p.id, message: 'Duplicate arm refused' });
  assert.equal(f.controller.pending, p); assert.equal(p.rejection, undefined); assert.equal(f.storage.finishCalls.length, 0);
  p.started = true;
  f.controller.audioEvent('capture-rejected', { captureId: p.id, activeCaptureId: null, message: 'Stale rejection' });
  assert.equal(p.rejection, undefined); assert.equal(f.storage.finishCalls.length, 0);
});

test('failed arm cleanup retains intent and audio while displaying the original recording error', async () => {
  const f = fixture(); await f.controller.startCapture('vocal'); const p = f.controller.pending;
  f.storage.saveHook = () => { throw new Error('Metadata storage full'); };
  const originalError = console.error; console.error = () => {};
  try {
    f.controller.audioEvent('capture-rejected', { captureId: p.id, message: 'Audio buffers unavailable', activeCaptureId: null });
    await p.rejection;
  } finally { console.error = originalError; }
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
  assert.equal(f.storage.assets.size, 2); assert.equal(f.controller.state.project.pendingCapture.id, p.id);
  assert.equal(f.controller.state.discarded.length, 2); assert.match(f.controller.state.error, /Audio buffers unavailable.*Metadata storage full/);
});

function cancelledCapture(f, options = {}) {
  finishedCapture(f, { rawStatus: 'cancelled', masterStatus: 'cancelled', ...options });
  f.controller.pending.end.status = 'cancelled';
  f.controller.state.project.pendingCapture.masterAssetId = f.controller.pending.masterAssetId;
  f.storage.projects.set(f.controller.state.project.id, clone(f.controller.state.project));
}

test('cancelled raw and master audio are deleted only after intent removal commits, retaining backing and real history', async () => {
  const f = fixture(), commit = deferred(); cancelledCapture(f, { rawFrames: 10000000, masterFrames: 10000000 });
  const project = f.controller.state.project, backing = createTrack({ assetId: 'backing', frames: 48000 });
  project.tracks.push(backing); f.storage.assets.set('backing', { id: 'backing', projectId: project.id, status: 'complete' });
  f.controller.history.push(project); // Stale pendingCapture alone must not prevent cleanup.
  const deleted = []; f.storage.deleteHook = id => { assert.equal(f.storage.projects.get(project.id).pendingCapture, undefined); deleted.push(id); };
  f.storage.saveHook = () => commit.promise;
  const finishing = f.controller.tryFinalize(); await tick();
  assert.equal(deleted.length, 0); assert.ok(f.controller.pending);
  await assert.rejects(f.controller.startCapture('loop'), /recording is already active/);
  commit.resolve(); await finishing;
  assert.deepEqual(new Set(deleted), new Set(['raw-1', 'master-1'])); assert.ok(f.storage.assets.has('backing'));
  assert.equal(f.controller.state.discarded.length, 0); assert.equal(f.controller.state.recovered.length, 0);
  await f.controller.handle({ type: 'undo' }); assert.equal(f.controller.state.project.pendingCapture, undefined);
  assert.equal(f.controller.state.project.tracks[0].assetId, 'backing');
});

test('cancel metadata failure preserves its intent and audio until an explicit cleanup retry commits', async () => {
  const f = fixture(); cancelledCapture(f); const project = f.controller.state.project;
  f.storage.saveHook = () => { throw new Error('Metadata quota exceeded'); };
  await assert.rejects(f.controller.tryFinalize(), /Metadata quota/);
  assert.equal(f.storage.assets.size, 2); assert.equal(project.pendingCapture.id, 'capture-1');
  assert.equal(f.storage.projects.get(project.id).pendingCapture.id, 'capture-1'); assert.equal(f.controller.state.discarded.length, 2);
  await assert.rejects(f.controller.deleteDiscardedRecording('raw-1'), /Metadata quota/);
  assert.equal(f.storage.assets.size, 2); assert.equal(project.pendingCapture.id, 'capture-1');
  f.storage.saveHook = null;
  await f.controller.handle({ type: 'delete-discarded', id: 'raw-1' });
  assert.equal(project.pendingCapture, undefined); assert.equal(f.storage.projects.get(project.id).pendingCapture, undefined);
  assert.equal(f.storage.assets.has('raw-1'), false); assert.ok(f.storage.assets.has('master-1'));
  await f.controller.deleteDiscardedRecording('master-1'); assert.equal(f.storage.assets.size, 0);
});

test('failed cancellation deletion stays discoverable and retry reclaims only the discarded recording', async () => {
  const f = fixture(); cancelledCapture(f);
  f.storage.deleteHook = id => { if (id === 'master-1') throw new Error('Disk deletion failed'); };
  await f.controller.tryFinalize();
  assert.equal(f.controller.pending, null); assert.equal(f.storage.assets.has('raw-1'), false); assert.ok(f.storage.assets.has('master-1'));
  assert.deepEqual(f.controller.state.discarded.map(asset => asset.id), ['master-1']);
  assert.equal(f.controller.state.recovered.length, 0); assert.ok(f.ui.notifications.some(item => /cleanup is pending/.test(item.message)));
  f.storage.deleteHook = null; await f.controller.deleteDiscardedRecording('master-1');
  assert.equal(f.storage.assets.size, 0); assert.equal(f.controller.state.discarded.length, 0);
});

for (const source of ['project', 'past', 'future']) {
  test(`cancel cleanup preserves audio with a real ${source} reference`, async () => {
    const f = fixture(); cancelledCapture(f, { kind: 'loop' });
    const snapshot = clone(f.controller.state.project); snapshot.tracks.push(createTrack({ assetId: 'raw-1', frames: 100 }));
    if (source === 'project') f.controller.state.project.tracks = snapshot.tracks;
    else f.controller.history[source].push(snapshot);
    await f.controller.tryFinalize(); assert.ok(f.storage.assets.has('raw-1'));
    await assert.rejects(f.controller.deleteDiscardedRecording('raw-1'), /still used/);
    assert.ok(f.storage.assets.has('raw-1'));
  });
}

test('cancel cleanup cannot delete an asset from a different capture or an unsealed recoverable partner', async () => {
  const f = fixture(); cancelledCapture(f);
  f.storage.assets.get('raw-1').captureId = 'another-capture';
  f.storage.assets.get('master-1').status = 'interrupted';
  await f.controller.tryFinalize(); assert.equal(f.storage.assets.size, 2);
  assert.equal(f.controller.state.project.pendingCapture.id, 'capture-1');
  assert.deepEqual(f.controller.state.recovered.map(asset => asset.id), ['master-1']);
  await assert.rejects(f.controller.deleteDiscardedRecording('raw-1'), /still used/);
});

test('reopening shows cancelled recordings as discard cleanup, and a stop during retry prevents deletion', async () => {
  const f = fixture(); cancelledCapture(f); f.controller.pending = null; f.controller.state.capture = null;
  await f.controller.openProject(f.controller.state.project.id);
  assert.equal(f.controller.state.discarded.length, 2); assert.equal(f.controller.state.recovered.length, 0);
  const read = deferred(), originalList = f.storage.listAssets.bind(f.storage);
  f.storage.listAssets = async id => { await read.promise; return originalList(id); };
  const deleting = f.controller.deleteDiscardedRecording('raw-1'); await tick();
  await f.controller.handle({ type: 'stop' }); read.resolve(); await deleting;
  assert.equal(f.storage.assets.size, 2); assert.equal(f.controller.state.busy, false);
});

test('Stop during an already issued discard deletion removes its completed card without affecting a new operation', async () => {
  const f = fixture(), deletion = deferred(); cancelledCapture(f, { kind: 'loop' });
  f.storage.deleteHook = () => { throw new Error('Retain for retry'); }; await f.controller.tryFinalize();
  f.storage.deleteHook = () => deletion.promise;
  const deleting = f.controller.deleteDiscardedRecording('raw-1'); await tick();
  await f.controller.handle({ type: 'stop' }); f.controller.state.busy = true;
  deletion.resolve(); await deleting;
  assert.equal(f.storage.assets.has('raw-1'), false); assert.equal(f.controller.state.discarded.length, 0);
  assert.equal(f.controller.state.busy, true, 'an older deletion cannot unlock a newer operation');
});

test('a fatal storage failure during cancelled-capture cleanup keeps the recovery banner and retained audio', async () => {
  const f = fixture(), deletion = deferred(); cancelledCapture(f);
  f.storage.deleteHook = () => deletion.promise;
  const finishing = f.controller.tryFinalize(); await tick();
  await f.controller.storageFailed('The storage worker stopped');
  deletion.reject(new Error('Worker is unavailable')); await finishing;
  assert.equal(f.controller.state.status, 'Saved audio needs recovery');
  assert.match(f.controller.state.error, /Reopen the studio/); assert.equal(f.storage.assets.size, 2);
  assert.equal(f.controller.state.capture, null); assert.equal(f.controller.state.busy, false);
});

test('a stale RPC error cannot replace the fatal storage recovery banner', async () => {
  const f = fixture(); await f.controller.storageFailed('Storage worker stopped');
  const message = f.controller.state.error, notifications = f.ui.notifications.length, originalError = console.error, logged = [];
  console.error = error => logged.push(error);
  try { f.controller.handleError(new Error('RPC failed after worker shutdown')); }
  finally { console.error = originalError; }
  assert.equal(f.controller.state.error, message); assert.equal(f.controller.state.status, 'Saved audio needs recovery');
  assert.equal(f.ui.notifications.length, notifications); assert.equal(logged.length, 1);
});

test('discard cleanup cards are limited to cancelled captures supported by the safe retry action', async () => {
  const f = fixture(); cancelledCapture(f); f.controller.pending = null; f.controller.state.capture = null;
  const project = f.controller.state.project;
  f.storage.assets.set('import-cancelled', { id: 'import-cancelled', projectId: project.id, kind: 'import', status: 'cancelled', frames: 100 });
  await f.controller.openProject(project.id);
  assert.deepEqual(new Set(f.controller.state.discarded.map(asset => asset.id)), new Set(['raw-1', 'master-1']));
  await assert.rejects(f.controller.deleteDiscardedRecording('import-cancelled'), /Choose a discarded recording/);
  assert.ok(f.storage.assets.has('import-cancelled'));
});

test('undo and project switching are blocked while capture intent is pending', async () => {
  const f = fixture(); finishedCapture(f); f.controller.pending.ended = false;
  f.controller.history.push(createProject('Before'));
  await assert.rejects(f.controller.handle({ type: 'undo' }), /Finish or cancel/);
  await assert.rejects(f.controller.openProject('other'), /Finish or cancel/);
  assert.equal(f.controller.state.project.name, 'Test song');
});

test('a foreign project lock opens read only without claiming recovery ownership', async () => {
  const f = fixture(), existing = createProject('Other tab'); f.storage.projects.set(existing.id, existing);
  f.storage.recoverError = Object.assign(new Error('Owned by another tab'), { code: 'PROJECT_BUSY' });
  await f.controller.openProject(existing.id);
  assert.equal(f.controller.state.readonly, true); assert.equal(f.controller.state.project.id, existing.id);
  assert.match(f.controller.state.status, /Read only/);
  await assert.rejects(f.controller.startCapture('loop'), /another tab/);
});

test('sound presets apply to vocal takes while preserving their balance', async () => {
  const f = fixture(); const take = { id: 'take-1', assetId: 'raw-1', name: 'Vocal', frames: 100, startFrame: 0, mix: { volume: .42, pan: -.3 } };
  f.controller.state.project.takes.push(take);
  await f.controller.handle({ type: 'role', id: take.id, role: 'texture' });
  assert.equal(take.role, 'texture'); assert.equal(take.mix.reverb, .42); assert.equal(take.mix.volume, .42); assert.equal(take.mix.pan, -.3);
  assert.equal(f.engine.commands.at(-1).payload.id, take.id);
});

test('a surviving stereo master is immediately recoverable even if the raw vocal is empty', async () => {
  const f = fixture(); finishedCapture(f, { rawFrames: 0, masterFrames: 100 }); await f.controller.tryFinalize();
  assert.equal(f.controller.state.project.takes.length, 0);
  assert.deepEqual(f.controller.state.recovered.map(asset => asset.id), ['master-1']);
  assert.ok(f.controller.state.project.pendingCapture);
});

test('unfinalized audio retries sealing before publishing a usable interrupted performance', async () => {
  const f = fixture(); finishedCapture(f, { masterStatus: 'recording', finalized: false }); await f.controller.tryFinalize();
  assert.ok(f.storage.finishCalls.some(call => call.id === 'master-1' && call.status === 'interrupted'));
  assert.equal(f.storage.assets.get('master-1').status, 'interrupted');
  assert.equal(f.controller.state.project.performances[0].status, 'interrupted');
});

test('continued metadata failure exposes recovery without publishing an unusable take', async () => {
  const f = fixture(); finishedCapture(f, { masterStatus: 'recording', finalized: false });
  f.storage.finishHook = () => { throw new Error('Quota remains full'); }; f.storage.recoverError = new Error('Quota remains full');
  await f.controller.tryFinalize();
  assert.equal(f.controller.state.project.takes.length, 0); assert.equal(f.controller.state.project.performances.length, 0);
  assert.ok(f.controller.state.recovered.some(asset => asset.id === 'master-1' && asset.needsRecovery));
  assert.match(f.controller.state.status, /recovery required/); assert.ok(f.storage.saved.at(-1).pendingCapture);
});

test('capture start uses the audio-thread snapshot after queued section and mix changes', () => {
  const f = fixture(); finishedCapture(f); f.controller.pending.ended = false;
  const track = createTrack({ assetId: 'backing', frames: 100 }); track.mix.volume = .23; track.muted = true;
  const initialState = { tracks: [track], master: { volume: .57 }, input: { gain: 1.4, monitor: false, compensationMs: 14 }, inputMix: { ...track.mix, reverb: .31 }, baseFrames: 100, spotlight: true, engineVersion: 1 };
  f.controller.audioEvent('capture-start', { captureId: 'capture-1', kind: 'vocal', startFrame: 5000, initialState });
  assert.equal(f.controller.pending.initialState.tracks[0].mix.volume, .23); assert.equal(f.controller.pending.initialState.tracks[0].muted, true);
  assert.equal(f.controller.pending.initialState.frame, 5000); assert.equal(f.controller.pending.track.mix.reverb, .31);
  initialState.tracks[0].mix.volume = 1; assert.equal(f.controller.pending.initialState.tracks[0].mix.volume, .23);
});

test('export owns the UI before its pending save and prevents capture or a second export', async () => {
  const f = fixture(), gate = deferred(); f.controller.flushSave = () => gate.promise;
  const exporting = f.controller.withExport(async () => 'done');
  assert.equal(f.controller.state.exporting, true); assert.equal(f.controller.state.exportProgress, 0);
  await assert.rejects(f.controller.startCapture('loop'), /export/);
  await assert.rejects(f.controller.withExport(async () => {}), /already running/);
  gate.resolve(); await exporting;
  assert.equal(f.controller.state.exportProgress, null); assert.equal(f.controller.state.exporting, false);
});

test('a failed metadata save cannot trap sealed recordings behind the export button', async () => {
  const f = fixture();
  f.storage.saveHook = async () => { throw Object.assign(new Error('Device storage is full'), { name: 'QuotaExceededError' }); };
  await assert.rejects(f.controller.saveNow(), { name: 'QuotaExceededError' });
  let exported = false;
  const result = await f.controller.withExport(async signal => {
    assert.equal(signal.aborted, false); exported = true; return 'independent backup';
  });
  assert.equal(result, 'independent backup'); assert.equal(exported, true);
  assert.equal(f.controller.state.exporting, false);
  assert.match(f.controller.state.status, /save needs attention/i);
  assert.match(f.controller.state.error, /could not be saved.*Download a backup/);
  assert.ok(f.ui.notifications.some(item => item.kind === 'error' && /storage is full/.test(item.message)));
  assert.equal(f.storage.saved.length, 0, 'export must not pretend the device save succeeded');
});

test('invalid local edits cannot overwrite the last reloadable project manifest', async () => {
  const f = fixture(); await f.controller.saveNow();
  const durable = clone(f.storage.projects.get(f.controller.state.project.id));
  f.controller.state.project.sections.push({ id: 'bad-section', name: 'Invalid section', tracks: null });
  await assert.rejects(f.controller.saveNow(), { code: 'INVALID_PROJECT' });
  assert.deepEqual(f.storage.projects.get(durable.id), durable);
  assert.equal(f.storage.saved.length, 1);
  f.controller.state.project.sections.pop();
  await f.controller.saveNow();
  assert.equal(f.storage.saved.length, 2, 'corrected edits remain saveable');
});

test('cancelled or dead-worker exports never bypass the failed-save gate', async () => {
  for (const failure of ['cancel', 'worker']) {
    const f = fixture(), gate = deferred(); let exports = 0;
    f.controller.flushSave = () => gate.promise;
    const operation = f.controller.withExport(async () => { exports++; });
    if (failure === 'cancel') f.controller.exportAbort.abort();
    else await f.controller.storageFailed('Storage transport closed');
    gate.reject(new Error('Save unavailable'));
    await assert.rejects(operation);
    assert.equal(exports, 0); assert.equal(f.controller.state.exporting, false);
    if (failure === 'worker') assert.match(f.controller.state.error, /Reopen the studio/);
  }
  const f = fixture(); f.controller.state.storageFailed = true;
  await assert.rejects(f.controller.withExport(async () => assert.fail('No export with a dead worker')), /Reopen/);
});

test('export after a save error still rejects an active recording before reading any files', async () => {
  const f = fixture(); f.controller.state.capture = { status: 'recording' };
  f.controller.flushSave = async () => { throw new Error('Quota full'); };
  await assert.rejects(f.controller.withExport(async () => assert.fail('No export during capture')), /Finish or cancel/);
  assert.equal(f.controller.state.exporting, false);
});

test('WAV fallback opens only the requested recording’s numbered parts', async () => {
  const f = fixture(), dialogs = [], pcm = new Float32Array([.1, -.2, .3, -.4]);
  f.controller.offerDownload({ blob: new Blob(['backup']), filename: 'Earlier project.fml' }, 'Project backup', { autoDownload: false, notify: false });
  f.ui.showDownloadParts = (entries, label) => dialogs.push({ entries, label });
  f.storage.assets.set('fallback-master', { id: 'fallback-master', projectId: f.controller.state.project.id, name: 'Long original', sampleRate: 48000, channels: 2, frames: 2, status: 'complete' });
  f.storage.getAssetFile = async () => { throw Object.assign(new Error('Whole-file fallback limit'), { code: 'FALLBACK_EXPORT_LIMIT' }); };
  f.storage.getAssetRange = async (assetId, range) => {
    assert.equal(assetId, 'fallback-master'); assert.deepEqual(range, { startFrame: 0, frames: 2 }); return new Blob([pcm]);
  };
  await f.controller.downloadAsset('fallback-master', 'Stereo performance');
  assert.equal(dialogs.length, 1); assert.equal(dialogs[0].label, 'Stereo performance');
  const [part] = dialogs[0].entries;
  assert.equal(dialogs[0].entries.length, 1); assert.equal(part.assetId, 'fallback-master');
  assert.equal(part.part, 1); assert.equal(part.partCount, 1); assert.match(part.filename, /^Long original-part-1\.wav$/);
  assert.equal(f.controller.state.downloads.length, 2, 'earlier URL remains tracked for revocation, but is absent from this dialog');
  assert.ok(f.controller.urls.has(part.url));
  assert.match(f.ui.notifications.at(-1).message, /numbered WAV parts/);
  assert.equal(f.controller.state.exporting, false);
  for (const url of f.controller.urls) URL.revokeObjectURL(url);
});

test('a later WAV part failure leaves the finished parts in the recording’s dialog', async () => {
  const f = fixture(), dialogs = [], partBytes = 64 * 1024 * 1024;
  const page = new Blob([new Uint8Array(1024 * 1024)]), firstPart = new Blob(Array(64).fill(page));
  f.ui.showDownloadParts = (entries, label) => dialogs.push({ entries, label });
  f.storage.assets.set('long-master', { id: 'long-master', projectId: f.controller.state.project.id, name: 'Long original', sampleRate: 48000, channels: 2, frames: partBytes / 8 + 1, status: 'complete' });
  f.storage.getAssetFile = async () => { throw Object.assign(new Error('Whole-file fallback limit'), { code: 'FALLBACK_EXPORT_LIMIT' }); };
  f.storage.getAssetRange = async (assetId, range) => {
    assert.equal(assetId, 'long-master');
    if (range.startFrame) throw new Error('Second part unavailable');
    assert.equal(range.frames, partBytes / 8); return firstPart;
  };
  await assert.rejects(f.controller.downloadAsset('long-master', 'Stereo performance'), /Second part unavailable/);
  assert.equal(dialogs.length, 1); assert.equal(dialogs[0].label, 'Stereo performance');
  assert.equal(dialogs[0].entries.length, 1); assert.equal(dialogs[0].entries[0].part, 1); assert.equal(dialogs[0].entries[0].partCount, 2);
  assert.ok(f.controller.urls.has(dialogs[0].entries[0].url));
  assert.equal(f.ui.notifications.some(item => /complete recording.*ready/.test(item.message)), false);
  assert.equal(f.controller.state.exporting, false);
  for (const url of f.controller.urls) URL.revokeObjectURL(url);
});

test('single downloads do not promise a studio-wide download list', () => {
  const f = fixture();
  f.ui.showDownloadParts = () => assert.fail('A single download does not need a parts dialog');
  f.controller.offerDownload({ blob: new Blob(['recording']), filename: 'Original.wav' }, 'Clean recording', { autoDownload: false });
  assert.deepEqual(f.ui.notifications.at(-1), { message: 'Your download is ready.', kind: 'success' });
  for (const url of f.controller.urls) URL.revokeObjectURL(url);
});

test('edited export delegates default performance duration and honors explicit durations', async () => {
  const f = fixture(); f.controller.state.project.takes.push({ id: 'take-x', assetId: 'raw-x', frames: 400, startFrame: 0, performanceId: 'perf-x' }); f.controller.state.project.selectedTakeId = 'take-x';
  const requests = [], downloads = [];
  f.storage.assets.set('render-x',{id:'render-x',kind:'mix',name:'Edited mix',frames:100,channels:2,sampleRate:48000,status:'complete'});
  f.controller.renderMix = async (project, options) => { requests.push(options); return { assetId: 'render-x' }; };
  f.controller.offerAudioDownload = async (...args) => downloads.push(args);
  await f.controller.exportMix({}); await f.controller.exportMix({ durationSeconds: 3.5 });
  assert.equal(Object.hasOwn(requests[0], 'durationSeconds'), false); assert.equal(requests[0].performanceId, 'perf-x');
  assert.equal(requests[1].durationSeconds, 3.5); assert.equal(downloads[0][0], 'render-x');
  assert.equal(f.controller.state.recovered.length,1,'saved mixes remain immediately reachable without duplicate cards');
  await assert.rejects(f.controller.exportMix({ durationSeconds: -2 }), /positive export duration/);
});

test('Stop cancels a Play action still awaiting audio readiness', async () => {
  const f = fixture(), ready = deferred(); f.controller.ensureAudio = () => ready.promise;
  const playing = f.controller.handle({ type: 'play' }); await f.controller.handle({ type: 'stop' }); ready.resolve(f.engine); await playing;
  assert.equal(f.engine.commands.some(command => command.type === 'play'), false);
  assert.equal(f.controller.state.project.input.monitor, false);
});

test('live audition start/end and Stop expose truthful transport state', async () => {
  const f = fixture(); f.controller.audioEvent('audition-start', { id: 'take-1', startFrame: 100, endFrame: 900 });
  assert.equal(f.controller.state.audition.status, 'playing'); assert.equal(f.controller.state.playing, true);
  f.controller.audioEvent('audition-end', { id: 'take-1', reason: 'finished' });
  assert.equal(f.controller.state.audition, null); assert.equal(f.controller.state.playing, false);
  f.controller.state.project.input.monitor = true; f.controller.state.monitor = true;
  await f.controller.handle({ type: 'stop' }); assert.equal(f.controller.state.monitor, false);
});

function importedFile(f, frames = 24) {
  const channels = [Float32Array.from({ length: frames }, (_, i) => i / frames)];
  f.engine.context = { decodeAudioData: async () => ({ length: frames, numberOfChannels: 1, getChannelData: c => channels[c] }) };
  return { name: 'voice.wav', size: frames * 4, arrayBuffer: async () => new ArrayBuffer(frames * 4) };
}
function recoverable(f, overrides = {}) {
  const asset = { id: 'recover-1', projectId: f.controller.state.project.id, sampleRate: f.controller.state.project.sampleRate, channels: 1, kind: 'loop', status: 'interrupted', frames: 100, checkpointFrames: 100, ...overrides };
  f.storage.assets.set(asset.id, asset); f.controller.state.recovered.push(clone(asset)); return asset;
}

test('opening a project with truncated published audio preserves timing and blocks consumption as a complete source', async () => {
  const f = fixture(), project = f.controller.state.project;
  project.tracks.push(createTrack({ assetId: 'damaged-loop', name: 'Beat', frames: 32768, offsetFrames: 127 })); project.baseFrames = 32768;
  f.storage.projects.set(project.id, clone(project));
  recoverable(f, { id: 'damaged-loop', name: 'Beat', frames: 16384 });
  await f.controller.openProject(project.id);
  assert.equal(f.controller.state.project.tracks[0].frames, 32768); assert.equal(f.controller.state.project.tracks[0].offsetFrames, 127); assert.equal(f.controller.state.project.baseFrames, 32768);
  assert.equal(f.controller.state.damagedAudio[0].reason, 'truncated'); assert.match(f.controller.state.status, /incomplete/);
  await assert.rejects(StudioController.prototype.ensureAudio.call(f.controller), /Original song timing has been preserved/);
  await assert.rejects(f.controller.previewRecordedAsset('damaged-loop', 'Beat'), /shorter verified portion/);
  await assert.rejects(f.controller.downloadAsset('damaged-loop', 'Clean recording'), /shorter verified portion/);
  await assert.rejects(f.controller.handle({ type: 'export-project' }), /shorter verified portion/);
  await f.controller.handle({ type: 'dismiss-error' }); assert.equal(f.controller.state.damagedAudio.length, 1, 'integrity notice survives ordinary error dismissal');
});

test('verified incomplete WAV filenames and labels are explicit while an intact original remains downloadable', async () => {
  const f = fixture(); finishedCapture(f); await f.controller.tryFinalize();
  const project = f.controller.state.project; f.storage.assets.get('raw-1').frames = 50; f.storage.assets.get('raw-1').status = 'interrupted';
  f.controller.updateAudioIntegrity(project, await f.storage.listAssets(project.id));
  f.storage.getAssetFile = async id => { const a = f.storage.assets.get(id); return new Blob([new Float32Array(a.frames * a.channels)]); };
  const offered = []; f.controller.offerDownload = (result, label) => offered.push({ result, label });
  await f.controller.handle({ type: 'export-damaged-audio', id: 'raw-1' });
  assert.match(offered[0].result.filename, /-incomplete\.wav$/); assert.match(offered[0].label, /Incomplete/); assert.equal(offered[0].result.blob.size, 58 + 50 * 4);
  await f.controller.downloadAsset('master-1', 'Stereo performance'); assert.equal(offered[1].result.blob.size, 58 + 100 * 8); assert.doesNotMatch(offered[1].result.filename, /incomplete/);
  assert.equal(project.takes[0].frames, 100); assert.equal(project.performances[0].frames, 100);
  const { prepareRenderPlan } = await import('../src/export/render.mjs');
  await assert.rejects(prepareRenderPlan(f.storage, project, { performanceId: project.performances[0].id }), { code: 'DAMAGED_AUDIO' });
});

test('removing damaged references clears active restrictions while Undo safely restores the warning and original timing', async () => {
  const f = fixture(), project = f.controller.state.project, track = createTrack({ assetId: 'lost', frames: 30000 });
  project.tracks.push(track); f.controller.updateAudioIntegrity(project, []);
  assert.equal(f.controller.state.damagedAudio[0].reason, 'missing');
  await f.controller.handle({ type: 'remove-track', id: track.id }); assert.equal(f.controller.state.damagedAudio.length, 0);
  f.controller.assertAudioSources([]);
  f.controller.state.playing = true;
  await f.controller.handle({ type: 'undo' });
  assert.equal(f.controller.state.damagedAudio.length, 1); assert.equal(f.controller.state.project.tracks[0].frames, 30000);
  assert.equal(f.controller.state.playing, false); assert.deepEqual(f.engine.commands.filter(command => command.type === 'sync-tracks').at(-1).ids, []);
  await assert.rejects(f.controller.downloadDamagedAudio('lost'), /no verified audio/);
  await f.controller.handle({ type: 'redo' }); assert.equal(f.controller.state.damagedAudio.length, 0);
  const newTrack = createTrack({ assetId: 'new-audio', frames: 500 }); f.controller.state.project.tracks.push(newTrack); f.controller.render();
  assert.equal(f.controller.state.damagedAudio.length, 0, 'new assets are never compared with the stale startup index');
});

test('a damaged vocal cannot be turned into a misleading shorter loop', async () => {
  const f = fixture(); finishedCapture(f); await f.controller.tryFinalize();
  f.storage.assets.get('raw-1').frames = 50;
  f.controller.updateAudioIntegrity(f.controller.state.project, await f.storage.listAssets(f.controller.state.project.id));
  await assert.rejects(f.controller.handle({ type: 'layer-vocal', id: f.controller.state.project.takes[0].id }), /shorter verified portion/);
  assert.equal(f.controller.state.project.tracks.length, 0);
});

test('import reserves its operation before audio readiness and Stop prevents a delayed import', async () => {
  const f = fixture(), file = importedFile(f), ready = deferred(); f.controller.ensureAudio = () => ready.promise;
  const importing = f.controller.importAudio(file);
  assert.equal(f.controller.state.busy, true);
  await assert.rejects(f.controller.importAudio(file), /current operation/);
  await f.controller.handle({ type: 'stop' }); ready.resolve(f.engine); await importing;
  assert.equal(f.storage.beginCalls.length, 0); assert.equal(f.controller.state.project.tracks.length, 0);
  assert.equal(f.controller.state.busy, false); assert.equal(f.controller.importOperation, null);
});

for (const stage of ['decode', 'seal', 'summary']) {
  test(`Stop during import ${stage} cannot attach late audio and cleans only the new asset`, async () => {
    const f = fixture(), file = importedFile(f), gate = deferred(); recoverable(f);
    if (stage === 'decode') { const decoded = await f.engine.context.decodeAudioData(); f.engine.context.decodeAudioData = async () => { await gate.promise; return decoded; }; }
    if (stage === 'seal') { let first = true; f.storage.finishHook = async () => { if (first) { first = false; await gate.promise; } }; }
    if (stage === 'summary') f.controller.summarize = async () => { await gate.promise; return []; };
    const importing = f.controller.importAudio(file); await tick();
    await f.controller.handle({ type: 'stop' }); gate.resolve(); await importing;
    assert.equal(f.controller.state.project.tracks.length, 0);
    assert.deepEqual([...f.storage.assets.keys()], ['recover-1']);
    assert.equal(f.ui.notifications.some(item => item.kind === 'success'), false);
    assert.equal(f.controller.state.busy, false);
  });
}

test('project switching during import summary cannot attach to either project', async () => {
  const f = fixture(), file = importedFile(f), gate = deferred(), original = f.controller.state.project, next = createProject('Next song');
  f.storage.projects.set(next.id, clone(next)); f.controller.summarize = async () => { await gate.promise; return []; };
  const importing = f.controller.importAudio(file); await tick(); await f.controller.openProject(next.id);
  gate.resolve(); await importing;
  assert.equal(f.controller.state.project.id, next.id); assert.equal(f.controller.state.project.tracks.length, 0);
  assert.equal(original.tracks.length, 0); assert.equal(f.storage.assets.size, 0); assert.equal(f.controller.state.status, 'Saved on this device');
});

test('import metadata failure retains attached audio for a save retry', async () => {
  const f = fixture(), file = importedFile(f); f.storage.saveHook = () => { throw new Error('Metadata disk full'); };
  await assert.rejects(f.controller.importAudio(file), /Metadata disk full/);
  assert.equal(f.controller.state.project.tracks.length, 1); assert.equal(f.storage.assets.size, 1);
  assert.equal([...f.storage.assets.values()][0].status, 'complete'); assert.equal(f.controller.state.busy, false);
  assert.equal(f.ui.notifications.some(item => item.kind === 'success'), false);
});

test('recovery validates project ownership before scanning or publishing audio', async () => {
  const f = fixture(); recoverable(f, { projectId: 'foreign-project' });
  f.storage.recover = () => { throw new Error('must not recover foreign assets'); };
  await assert.rejects(f.controller.recoverAsset('recover-1'), /different project/);
  assert.equal(f.controller.state.project.tracks.length, 0); assert.equal(f.storage.assets.size, 1); assert.equal(f.controller.state.busy, false);
});

test('recovery rejects duplicate in-flight requests and is idempotent after publication', async () => {
  const f = fixture(), gate = deferred(); recoverable(f); f.controller.summarize = async () => { await gate.promise; return []; };
  const recovering = f.controller.recoverAsset('recover-1'); await tick();
  await assert.rejects(f.controller.recoverAsset('recover-1'), /current operation/);
  gate.resolve(); await recovering; await f.controller.recoverAsset('recover-1');
  assert.equal(f.controller.state.project.tracks.length, 1); assert.equal(f.storage.saved.length, 1);
  assert.equal(f.controller.recoveryOperation, null); assert.equal(f.controller.state.busy, false);
});

test('Stop and project switching cancel recovery without deleting saved audio', async () => {
  const f = fixture(), gate = deferred(), original = f.controller.state.project, next = createProject('Another song');
  recoverable(f); f.storage.projects.set(next.id, clone(next)); f.controller.summarize = async () => { await gate.promise; return []; };
  const recovering = f.controller.recoverAsset('recover-1'); await tick(); await f.controller.handle({ type: 'stop' }); await f.controller.openProject(next.id);
  gate.resolve(); await recovering;
  assert.equal(original.tracks.length, 0); assert.equal(f.controller.state.project.id, next.id); assert.equal(f.controller.state.project.tracks.length, 0);
  assert.equal(f.storage.assets.get('recover-1').frames, 100); assert.equal(f.controller.state.busy, false); assert.equal(f.controller.state.status, 'Saved on this device');
});

test('recovering an older vocal preserves unrelated pending capture intent and automation', async () => {
  const f = fixture(); recoverable(f, { kind: 'vocal', captureId: 'old-capture' }); recoverable(f, { id: 'old-master', kind: 'master', channels: 2, leadAssetId: 'recover-1', captureId: 'old-capture' });
  recoverable(f, { id: 'new-raw', kind: 'vocal', captureId: 'new-capture' });
  const pending = { id: 'new-capture', assetId: 'new-raw', startFrame: 800, sealedThroughFrame: 900, events: [{ type: 'gain', frame: 850 }], initialState: { frame: 800, sentinel: 'unrelated' } };
  f.controller.state.project.pendingCapture = clone(pending);
  await f.controller.recoverAsset('recover-1');
  assert.deepEqual(f.controller.state.project.pendingCapture, pending);
  assert.equal(f.controller.state.project.takes[0].startFrame, 0); assert.equal(f.controller.state.project.takes[0].role, 'lead');
  assert.deepEqual(f.controller.state.project.performances[0].events, []); assert.equal(f.controller.state.project.performances[0].initialState.sentinel, undefined);
  assert.deepEqual(f.controller.state.recovered.map(asset => asset.id), ['new-raw']);
});

test('recovery uses and clears only matching persisted capture intent', async () => {
  const f = fixture(); recoverable(f, { kind: 'vocal' }); recoverable(f, { id: 'master', kind: 'master', channels: 2, leadAssetId: 'recover-1' });
  f.controller.state.project.pendingCapture = { assetId: 'recover-1', startFrame: 200, sealedThroughFrame: 290, events: [{ type: 'mix', frame: 220 }], initialState: { frame: 200 } };
  await f.controller.recoverAsset('recover-1');
  assert.equal(f.controller.state.project.pendingCapture, undefined); assert.equal(f.controller.state.project.takes[0].startFrame, 200);
  assert.equal(f.controller.state.project.performances[0].editableFrames, 90); assert.equal(f.controller.state.project.performances[0].events[0].frame, 220);
});

test('recovery retains an incomplete arrangement boundary even when more vocal and master samples survived', async () => {
  const f = fixture(); recoverable(f, { kind: 'vocal' }); recoverable(f, { id: 'master', kind: 'master', channels: 2, leadAssetId: 'recover-1' });
  f.controller.state.project.pendingCapture = { assetId: 'recover-1', startFrame: 200, sealedThroughFrame: 290, arrangementIncomplete: true, arrangementThroughFrame: 235, events: [], initialState: { frame: 200 } };
  await f.controller.recoverAsset('recover-1');
  const performance = f.controller.state.project.performances[0];
  assert.equal(performance.arrangementIncomplete, true); assert.equal(performance.status, 'interrupted'); assert.equal(performance.editableFrames, 35);
  assert.equal(performance.frames, 100); assert.equal(f.controller.state.project.takes[0].frames, 100);
  assert.equal(f.storage.assets.get('master').frames, 100);
});

test('recovery checks the layer limit before reading waveforms and immediately before publishing', async () => {
  const f = fixture(); recoverable(f); f.controller.state.project.tracks = Array.from({ length: MAX_TRACKS }, (_, i) => createTrack({ assetId: `used-${i}`, frames: 10 }));
  f.controller.summarize = () => { throw new Error('must not summarize full project'); };
  await assert.rejects(f.controller.recoverAsset('recover-1'), /layer limit/); assert.equal(f.controller.state.project.tracks.length, MAX_TRACKS);
  f.controller.state.project.tracks.pop(); const gate = deferred(); f.controller.summarize = async () => { await gate.promise; return []; };
  const recovering = f.controller.recoverAsset('recover-1'); await tick(); f.controller.state.project.tracks.push(createTrack({ assetId: 'new-last', frames: 10 })); gate.resolve();
  await assert.rejects(recovering, /layer limit/); assert.equal(f.controller.state.project.tracks.length, MAX_TRACKS); assert.equal(f.storage.assets.get('recover-1').frames, 100);
});

function savedMix(f, overrides = {}) {
  const asset = recoverable(f, { id: 'saved-mix', kind: 'mix', channels: 2, name: 'Evening song · edited mix', frames: 2000, status: 'complete', ...overrides });
  f.ui.confirm = async () => true;
  f.controller.removedDownloadAssets = [];
  f.controller.removeDownloadAsset = id => f.controller.removedDownloadAssets.push(id);
  return asset;
}

async function removablePerformance(f) {
  const project = f.controller.state.project;
  const backing = createTrack({ assetId: 'backing-1', name: 'Backing loop', frames: 100 });
  project.tracks.push(backing); project.baseFrames = 100;
  f.storage.assets.set(backing.assetId, { id: backing.assetId, projectId: project.id, sampleRate: project.sampleRate, channels: 1, kind: 'loop', status: 'complete', frames: 100 });
  finishedCapture(f);
  f.controller.pending.initialState.tracks = clone(project.tracks);
  f.controller.pending.initialState.baseFrames = project.baseFrames;
  f.controller.pending.events = [{ type: 'mix', frame: 1040, id: backing.id, muted: true }];
  await f.controller.tryFinalize();
  // A current mixer edit must not replace the recorded entrance or automation.
  backing.muted = true;
  f.controller.history.clear();
  f.ui.confirm = async () => true;
  f.storage.deleteHook = () => { throw new Error('Removing a performance must not delete shared audio'); };
  return project.performances[0];
}

test('performance removal preserves strict project validity, shared sources and its vocal arrangement through Undo and Redo', async () => {
  const f = fixture(), performance = await removablePerformance(f), project = f.controller.state.project;
  const { prepareRenderPlan } = await import('../src/export/render.mjs');
  const planBefore = await prepareRenderPlan(f.storage, project, { tailSeconds: 0, prerollSeconds: 0 });
  assert.equal(planBefore.tracks[0].muted, false);
  assert.equal(planBefore.events[0].muted, true);
  const takesBefore = clone(project.takes), tracksBefore = clone(project.tracks), audioBefore = clone([...f.storage.assets]);
  let confirmation, savesScheduled = 0;
  f.ui.confirm = async options => { confirmation = options; return true; };
  f.controller.scheduleSave = () => savesScheduled++;

  await f.controller.handle({ type: 'delete-performance', performanceId: performance.id });

  assert.equal(confirmation.title, 'Remove performance?');
  assert.equal(confirmation.confirmLabel, 'Remove performance');
  assert.equal(confirmation.danger, true);
  assert.equal(project.performances[0].removed, true);
  assert.equal(validateProject(project).performances[0].removed, true);
  assert.deepEqual(project.takes, takesBefore);
  assert.deepEqual(project.tracks, tracksBefore);
  assert.deepEqual([...f.storage.assets], audioBefore);
  assert.deepEqual(await prepareRenderPlan(f.storage, project, { tailSeconds: 0, prerollSeconds: 0 }), planBefore);
  assert.equal(savesScheduled, 1);
  assert.equal(f.controller.state.undoAvailable, true);

  await f.controller.handle({ type: 'undo' });
  assert.notEqual(f.controller.state.project.performances[0].removed, true);
  assert.deepEqual(f.controller.state.project.takes, takesBefore);
  assert.equal(f.controller.state.redoAvailable, true);
  await f.controller.handle({ type: 'redo' });
  assert.equal(f.controller.state.project.performances[0].removed, true);
  assert.deepEqual(await prepareRenderPlan(f.storage, f.controller.state.project, { tailSeconds: 0, prerollSeconds: 0 }), planBefore);
  assert.deepEqual([...f.storage.assets], audioBefore);
  assert.equal(f.controller.performanceRemoval, null);
});

test('canceling performance removal leaves its project, audio, preview and undo history unchanged', async () => {
  const f = fixture(), performance = await removablePerformance(f);
  const before = clone(f.controller.state.project), audioBefore = clone([...f.storage.assets]);
  const preview = { assetId: performance.masterAssetId, name: performance.name };
  f.controller.state.preview = preview;
  f.controller.closePreview = () => { throw new Error('Cancel must not close playback'); };
  f.ui.confirm = async () => false;
  await f.controller.removePerformance(performance.id);
  assert.deepEqual(f.controller.state.project, before);
  assert.deepEqual([...f.storage.assets], audioBefore);
  assert.equal(f.controller.state.preview, preview);
  assert.equal(f.controller.history.past.length, 0);
  assert.equal(f.controller.performanceRemoval, null);
});

test('removed performances stay removed on reopen without appearing as recovered audio', async () => {
  const f = fixture(), performance = await removablePerformance(f);
  await f.controller.handle({ type: 'delete-performance', id: performance.id });
  await f.controller.saveNow();
  await f.controller.openProject(f.controller.state.project.id);
  assert.equal(f.controller.state.project.performances[0].removed, true);
  assert.equal(f.controller.state.project.takes[0].performanceId, performance.id);
  assert.equal(f.controller.state.recovered.length, 0);
  assert.equal(f.controller.state.damagedAudio.length, 0);
  assert.ok(f.storage.assets.has(performance.masterAssetId));
  assert.ok(f.storage.assets.has(performance.leadAssetId));
});

for (const previewState of ['matching-ready', 'matching-preparing', 'unrelated-ready', 'unrelated-preparing']) {
  test(`performance removal closes only its own preview: ${previewState}`, async () => {
    const f = fixture(), performance = await removablePerformance(f);
    const matching = previewState.startsWith('matching'), preparing = previewState.endsWith('preparing');
    const preview = { name: performance.name, assetId: matching ? performance.masterAssetId : 'another-master' };
    f.controller.state[preparing ? 'previewPreparing' : 'preview'] = preview;
    let closed = 0; f.controller.closePreview = () => { closed++; f.controller.state.preview = null; f.controller.state.previewPreparing = null; };
    await f.controller.removePerformance(performance.id);
    assert.equal(closed, matching ? 1 : 0);
    if (!matching) assert.equal(f.controller.state[preparing ? 'previewPreparing' : 'preview'], preview);
    assert.equal(f.controller.state.project.performances[0].removed, true);
  });
}

for (const blocked of ['readonly', 'busy', 'capture', 'pending', 'exporting']) {
  test(`performance removal rejects ${blocked} state without confirmation or edits`, async () => {
    const f = fixture(), performance = await removablePerformance(f);
    if (blocked === 'pending') f.controller.pending = { id: 'other-capture' };
    else f.controller.state[blocked] = blocked === 'capture' ? { kind: 'vocal', status: 'recording' } : true;
    let confirmations = 0; f.ui.confirm = async () => { confirmations++; return true; };
    await assert.rejects(f.controller.removePerformance(performance.id), /Finish|read only|another tab|current operation|export/i);
    assert.equal(confirmations, 0);
    assert.notEqual(performance.removed, true);
    assert.equal(f.controller.history.past.length, 0);
  });
}

test('performance removal rejects concurrent dialogs and abandons confirmation after Stop or project change', async () => {
  for (const change of ['stop', 'project']) {
    const f = fixture(), performance = await removablePerformance(f), gate = deferred();
    f.ui.confirm = () => gate.promise;
    const removing = f.controller.removePerformance(performance.id); await tick();
    await assert.rejects(f.controller.removePerformance(performance.id), /current operation|remov/i);
    if (change === 'stop') await f.controller.handle({ type: 'stop' });
    else {
      const next = createProject('Other song'); f.storage.projects.set(next.id, next);
      await f.controller.openProject(next.id);
    }
    gate.resolve(true); await removing;
    assert.notEqual(performance.removed, true);
    assert.equal(f.controller.history.past.length, 0);
    assert.equal(f.controller.performanceRemoval, null);
  }
});

test('performance removal rechecks write, recording, busy and export guards after confirmation', async () => {
  for (const change of ['readonly', 'capture', 'busy', 'exporting']) {
    const f = fixture(), performance = await removablePerformance(f), gate = deferred();
    f.ui.confirm = () => gate.promise;
    const removing = f.controller.removePerformance(performance.id); await tick();
    f.controller.state[change] = change === 'capture' ? { kind: 'vocal', status: 'recording' } : true;
    gate.resolve(true);
    await assert.rejects(removing, /Finish|read only|another tab|current operation|export/i);
    assert.notEqual(performance.removed, true);
    assert.equal(f.controller.history.past.length, 0);
    assert.equal(f.controller.performanceRemoval, null);
  }
});

test('unknown and already removed performances are harmless, including changes during confirmation', async () => {
  for (const change of ['missing', 'removed', 'missing-after-confirmation', 'removed-after-confirmation']) {
    const f = fixture(), performance = await removablePerformance(f), gate = deferred();
    let confirmations = 0; f.ui.confirm = () => { confirmations++; return gate.promise; };
    const duringConfirmation = change.endsWith('after-confirmation');
    if (!duringConfirmation && change === 'removed') performance.removed = true;
    const removing = f.controller.removePerformance(change === 'missing' ? 'missing-performance' : performance.id);
    await tick();
    if (change === 'missing-after-confirmation') f.controller.state.project.performances = [];
    if (change === 'removed-after-confirmation') performance.removed = true;
    gate.resolve(true); await removing;
    assert.equal(confirmations, duringConfirmation ? 1 : 0);
    assert.equal(f.controller.history.past.length, 0);
  }
});

test('saved mix deletion confirms its exact name and PCM bytes, keeping every source recording', async () => {
  const f = fixture(), mix = savedMix(f); recoverable(f, { id: 'loop-source' }); recoverable(f, { id: 'vocal-source', kind: 'vocal' });
  let confirmation; f.ui.confirm = async options => { confirmation = options; return true; };
  let estimated = false; f.storage.estimate = async () => { estimated = true; return { usage: 1234, quota: 9999 }; };
  await f.controller.handle({ type: 'delete-saved-mix', id: mix.id });
  assert.equal(confirmation.title, `Delete ${mix.name}?`); assert.match(confirmation.message, /16,000 bytes/); assert.match(confirmation.message, /backup/); assert.equal(confirmation.danger, true);
  assert.deepEqual([...f.storage.assets.keys()], ['loop-source', 'vocal-source']);
  assert.deepEqual(f.controller.state.recovered.map(asset => asset.id), ['loop-source', 'vocal-source']);
  assert.deepEqual(f.controller.removedDownloadAssets, [mix.id]); assert.equal(estimated, true); assert.equal(f.controller.state.storage.usage, 1234);
  assert.equal(f.controller.state.busy, false); assert.equal(f.controller.savedMixDeletion, null);
});

test('canceling saved mix deletion keeps its audio, recovery card and download links', async () => {
  const f = fixture(), mix = savedMix(f); f.ui.confirm = async () => false;
  await f.controller.deleteSavedMix(mix.id);
  assert.ok(f.storage.assets.has(mix.id)); assert.ok(f.controller.state.recovered.some(asset => asset.id === mix.id)); assert.deepEqual(f.controller.removedDownloadAssets, []);
  assert.equal(f.controller.state.busy, false); assert.equal(f.engine.commands.length, 0);
});

for (const source of ['project', 'pending', 'undo', 'redo']) {
  test(`saved mix deletion rejects a ${source} reference before confirmation`, async () => {
    const f = fixture(), mix = savedMix(f); const reference = { assetId: mix.id };
    if (source === 'project') f.controller.state.project.tracks.push(createTrack({ assetId: mix.id, frames: mix.frames }));
    if (source === 'pending') f.controller.state.project.pendingCapture = reference;
    if (source === 'undo') f.controller.history.past.push({ tracks: [reference] });
    if (source === 'redo') f.controller.history.future.push({ performances: [{ masterAssetId: mix.id }] });
    f.ui.confirm = () => { throw new Error('must not offer destructive confirmation'); };
    await assert.rejects(f.controller.deleteSavedMix(mix.id), /still used/);
    assert.ok(f.storage.assets.has(mix.id)); assert.equal(f.controller.savedMixDeletion, null);
  });
}

for (const badAsset of [{ projectId: 'another-project' }, { kind: 'loop' }, { kind: 'vocal' }, { kind: 'master' }, { status: 'recording' }]) {
  test(`saved mix deletion rejects protected audio ${JSON.stringify(badAsset)}`, async () => {
    const f = fixture(), mix = savedMix(f, badAsset); f.ui.confirm = () => { throw new Error('must not confirm'); };
    await assert.rejects(f.controller.deleteSavedMix(mix.id), /Only generated|still being written/);
    assert.ok(f.storage.assets.has(mix.id)); assert.equal(f.controller.state.recovered.length, 1);
  });
}

test('saved mix confirmation is invalidated by project change or Stop', async () => {
  for (const change of ['stop', 'project']) {
    const f = fixture(), mix = savedMix(f), gate = deferred(); f.ui.confirm = () => gate.promise;
    const deleting = f.controller.deleteSavedMix(mix.id); await tick();
    await assert.rejects(f.controller.deleteSavedMix(mix.id), /current operation/);
    if (change === 'stop') await f.controller.handle({ type: 'stop' });
    else { const next = createProject('New selection'); f.storage.projects.set(next.id, next); await f.controller.openProject(next.id); }
    gate.resolve(true); await deleting;
    assert.ok(f.storage.assets.has(mix.id)); assert.deepEqual(f.controller.removedDownloadAssets, []); assert.equal(f.controller.savedMixDeletion, null);
  }
});

test('saved mix deletion rechecks references and ongoing export after confirmation', async () => {
  for (const change of ['reference', 'export']) {
    const f = fixture(), mix = savedMix(f), gate = deferred(); f.ui.confirm = () => gate.promise;
    const deleting = f.controller.deleteSavedMix(mix.id); await tick();
    if (change === 'reference') f.controller.history.past.push({ assetId: mix.id }); else f.controller.state.exporting = true;
    gate.resolve(true); await assert.rejects(deleting, /still used|current operation/);
    assert.ok(f.storage.assets.has(mix.id)); assert.deepEqual(f.controller.removedDownloadAssets, []);
  }
});

test('a disk failure while deleting a saved mix keeps its card and download links for retry', async () => {
  const f = fixture(), mix = savedMix(f); f.storage.deleteHook = () => { throw new Error('Disk deletion failed'); };
  await assert.rejects(f.controller.deleteSavedMix(mix.id), /Disk deletion failed/);
  assert.ok(f.storage.assets.has(mix.id)); assert.ok(f.controller.state.recovered.some(asset => asset.id === mix.id)); assert.deepEqual(f.controller.removedDownloadAssets, []);
  assert.equal(f.controller.state.busy, false); assert.equal(f.controller.savedMixDeletion, null);
  f.storage.deleteHook = null; await f.controller.deleteSavedMix(mix.id); assert.equal(f.storage.assets.has(mix.id), false);
});

for (const failure of [Object.assign(new Error('Disk quota full'), { name: 'QuotaExceededError' }), Object.assign(new Error('Checkpoint transaction interrupted'), { code: 'TRANSACTION_ABORTED' })]) {
  test(`startup retains read-only access when recovery cannot commit (${failure.name}/${failure.code || ''})`, async () => {
    const f = fixture(), existing = createProject('Recover safely');
    f.controller.state.project = null; f.controller.engine = null; f.storage.projects.set(existing.id, clone(existing));
    f.storage.assets.set('sealed', { id: 'sealed', projectId: existing.id, frames: 100, status: 'complete', channels: 1, sampleRate: existing.sampleRate, kind: 'loop' });
    f.storage.assets.set('unfinished', { id: 'unfinished', projectId: existing.id, frames: 80, status: 'recording', channels: 1, sampleRate: existing.sampleRate, kind: 'loop' });
    f.storage.recoverError = failure;
    await f.controller.openProject(existing.id);
    assert.equal(f.controller.state.project.id, existing.id); assert.equal(f.controller.state.readonly, true); assert.equal(f.controller.state.recoveryRequired, true);
    assert.match(f.controller.state.readonlyReason, /Recovery could not be saved/); assert.doesNotMatch(f.controller.state.readonlyReason, /another tab/);
    assert.equal(f.controller.state.status, 'Recovery required · read only'); assert.equal(f.controller.state.busy, false);
    assert.equal(f.controller.state.recovered.find(asset => asset.id === 'unfinished').needsRecovery, true);
    assert.equal(f.controller.state.recovered.find(asset => asset.id === 'sealed').needsRecovery, false);
    await assert.rejects(f.controller.startCapture('loop'), /Recovery could not be saved/);
    await assert.rejects(f.controller.handle({ type: 'rename-project', name: 'Unsafe edit' }), /Recovery could not be saved/);
    await assert.rejects(f.controller.handle({ type: 'save' }), /Recovery could not be saved/);
    await f.controller.saveNow(); assert.equal(f.storage.saved.length, 0);
    let exported; f.controller.offerAudioDownload = async assetId => { exported = assetId; };
    await f.controller.downloadAsset('sealed', 'Saved recording'); assert.equal(exported, 'sealed');
    f.storage.projectUsage = async projectId => ({ projectId, audioBytes: 720 }); let manager;
    f.ui.showStorageManager = rows => { manager = rows; }; await f.controller.manageStorage(); assert.equal(manager[0].id, existing.id);
    await f.controller.handle({ type: 'dismiss-error' }); assert.match(f.controller.state.readonlyReason, /Retry recovery/); assert.equal(f.controller.state.recoveryRequired, true);
    f.storage.recoverError = null;
    f.storage.recover = async () => { f.storage.assets.get('unfinished').status = 'interrupted'; return [f.storage.assets.get('unfinished')]; };
    await f.controller.handle({ type: 'retry-recovery' });
    assert.equal(f.controller.state.readonly, false); assert.equal(f.controller.state.readonlyReason, null); assert.equal(f.controller.state.recoveryRequired, false); assert.equal(f.controller.state.error, null);
    assert.doesNotThrow(() => f.controller.assertWritable());
  });
}

test('startup worker failure and an unreadable asset index remain fatal instead of claiming read-only recovery', async () => {
  for (const failure of ['worker', 'asset-index']) {
    const f = fixture(), existing = createProject('Unreadable'); f.controller.state.project = null; f.controller.engine = null;
    f.storage.projects.set(existing.id, existing);
    if (failure === 'worker') f.storage.recoverError = Object.assign(new Error('Worker lost'), { code: 'STORAGE_WORKER_FAILED' });
    else { f.storage.recoverError = Object.assign(new Error('Storage full'), { name: 'QuotaExceededError' }); f.storage.listAssets = async () => { throw new Error('Asset index unreadable'); }; }
    await assert.rejects(f.controller.openProject(existing.id), /Worker lost|Asset index unreadable/);
    assert.equal(f.controller.state.project, null); assert.equal(f.controller.state.recoveryRequired, false); assert.equal(f.controller.state.busy, false);
  }
});

test('failure creating a first project is not described as recovery of existing audio', async () => {
  const f = fixture(); f.controller.state.project = null; f.controller.engine = null;
  f.storage.saveHook = async () => { throw Object.assign(new Error('Quota full'), { name: 'QuotaExceededError' }); };
  await assert.rejects(f.controller.openProject(), /Quota full/);
  assert.equal(f.controller.state.project, null); assert.equal(f.controller.state.recoveryRequired, false);
});

function loopMixFixture() {
  const f = fixture(), project = f.controller.state.project;
  project.tracks.push(createTrack({ assetId: 'backing', name: 'Saved loop', frames: 48000 })); project.baseFrames = 48000;
  f.storage.assets.set('backing', { id: 'backing', projectId: project.id, sampleRate: project.sampleRate, kind: 'loop', channels: 1, frames: 48000, status: 'complete' });
  return f;
}

test('record all loops never requests a microphone and prepares one stereo master with no vocal asset', async () => {
  const f = loopMixFixture(), project = f.controller.state.project;
  f.controller.state.capabilities.microphone = false;
  project.input.compensationMs = 500;
  project.tracks[0].solo = true;
  project.tracks.push(createTrack({ assetId: 'another-loop', name: 'Another loop', frames: 48000 }));
  const before = clone(project.tracks);
  let microphoneRequests = 0;
  f.engine.micHook = () => { microphoneRequests++; throw new Error('Microphone denied'); };
  await f.controller.handle({ type: 'record-all-loops' });
  assert.equal(microphoneRequests, 0);
  assert.equal(f.storage.beginCalls.length, 1);
  const asset = f.storage.beginCalls[0], pending = f.controller.pending, capture = f.engine.commands.find(command => command.type === 'arm').capture;
  assert.equal(asset.channels, 2); assert.equal(asset.kind, 'master'); assert.equal(asset.source, 'loops');
  assert.equal(asset.name, 'Loop recording 1'); assert.equal(asset.leadAssetId, undefined); assert.equal(asset.track, undefined);
  assert.equal(capture.kind, 'mix'); assert.equal(capture.masterAssetId, null); assert.equal(capture.lengthFrames, 0); assert.equal(capture.quantized, false);
  assert.equal(pending.takeId, null); assert.equal(project.takes.length, 0); assert.deepEqual(project.tracks, before);
  assert.equal(project.pendingCapture.kind, 'mix'); assert.equal(project.pendingCapture.masterAssetId, null);
  f.controller.state.transportFrame = 5000; f.controller.updateCaptureIntent();
  assert.equal(project.pendingCapture.sealedThroughFrame, 5000, 'loop audio is not delayed by microphone compensation');
  await f.controller.cancelPrepared(pending);
});

test('record all loops rejects empty and all-muted projects before opening audio or microphone', async () => {
  for (const muted of [false, true]) {
    const f = muted ? loopMixFixture() : fixture();
    if (muted) f.controller.state.project.tracks[0].muted = true;
    let audioCalls = 0; f.controller.ensureAudio = async () => { audioCalls++; return f.engine; };
    await assert.rejects(f.controller.startCapture('mix', 0), /Unmute at least one saved loop/);
    assert.equal(audioCalls, 0); assert.equal(f.storage.beginCalls.length, 0); assert.equal(f.controller.state.capture, null);
  }
});

test('loop recording numbering counts loop performances without renaming or selecting existing vocal takes', async () => {
  const f = loopMixFixture(); finishedCapture(f); await f.controller.tryFinalize();
  const project = f.controller.state.project, selectedTakeId = project.selectedTakeId;
  const originalTakes = clone(project.takes), tracks = clone(project.tracks);
  finishedCapture(f, { kind: 'mix' });
  f.controller.pending.performanceId = 'loop-performance-1';
  await f.controller.tryFinalize();
  const performance = project.performances.at(-1);
  assert.equal(performance.source, 'loops'); assert.equal(performance.name, 'Loop recording 1');
  assert.equal(performance.masterAssetId, 'raw-1'); assert.equal(Object.hasOwn(performance, 'leadAssetId'), false);
  assert.equal(performance.compensationFrames, 0); assert.equal(performance.status, 'complete');
  assert.deepEqual(project.takes, originalTakes); assert.equal(project.selectedTakeId, selectedTakeId); assert.deepEqual(project.tracks, tracks);
  assert.deepEqual(f.controller.state.recentRecording, { kind: 'performance', id: 'loop-performance-1', captureId: 'capture-1' });
  validateProject(project);
  await f.controller.startCapture('mix', 0);
  assert.equal(f.storage.beginCalls.at(-1).name, 'Loop recording 2');
  await f.controller.cancelPrepared(f.controller.pending);
});

test('microphone off and microphone interruption cannot cancel loop-only capture during audio preparation', async () => {
  const f = loopMixFixture(), ready = deferred();
  f.controller.ensureAudio = () => ready.promise;
  const starting = f.controller.startCapture('mix', 0), generation = f.controller.generation;
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture.waitingForMic, false);
  await f.controller.handle({ type: 'mic-off' });
  f.controller.audioEvent('device-lost', { message: 'Microphone disconnected' });
  f.controller.audioEvent('interrupted', { message: 'Microphone muted' });
  assert.equal(f.controller.generation, generation); assert.equal(f.controller.state.capture.kind, 'mix');
  ready.resolve(f.engine); await starting;
  assert.equal(f.engine.commands.some(command => command.type === 'interrupt'), false);
  assert.ok(f.engine.commands.some(command => command.type === 'arm'));
  await f.controller.cancelPrepared(f.controller.pending);
});

test('microphone off and device loss keep an active loop recording running', async () => {
  const f = loopMixFixture(); await f.controller.startCapture('mix', 0);
  const pending = f.controller.pending, generation = f.controller.generation;
  f.controller.audioEvent('capture-start', { captureId: pending.id, kind: 'mix', startFrame: 48000 });
  await f.controller.handle({ type: 'mic-off' });
  f.controller.audioEvent('device-lost', { message: 'Microphone disconnected' });
  f.controller.audioEvent('interrupted', { message: 'Microphone muted' });
  await tick();
  assert.equal(f.controller.pending, pending); assert.equal(pending.interrupted, undefined);
  assert.equal(f.controller.state.capture.status, 'recording'); assert.equal(f.controller.generation, generation);
  assert.equal(f.engine.commands.some(command => command.type === 'interrupt'), false);
  assert.equal(f.storage.finishCalls.length, 0);
  await f.controller.cancelPrepared(pending);
});

test('audio suspension during loop-only asset preparation waits for creation before cancelling', async () => {
  const f = loopMixFixture(), creation = deferred(); f.storage.beginHook = () => creation.promise;
  const starting = f.controller.startCapture('mix', 0); await tick();
  const assetId = f.controller.pending.assetId;
  f.engine.context = { state: 'suspended' }; f.controller.audioEvent('context-state', { state: 'suspended' });
  const recovery = f.controller.audioRecovery;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(f.storage.finishCalls.length, 0); assert.ok(f.controller.pending);
  creation.resolve(); await starting; await recovery;
  assert.equal(f.engine.commands.some(command => command.type === 'arm'), false);
  assert.equal(f.storage.assets.has(assetId), false); assert.equal(f.storage.assets.has('backing'), true);
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
});

test('audio context interruption retains a loop-only stereo prefix as a performance without creating a take', async () => {
  const f = loopMixFixture(); finishedCapture(f, { kind: 'mix', rawStatus: 'recording' });
  f.controller.pending.started = true; f.controller.pending.ended = false; delete f.controller.pending.end; f.controller.sealed.clear();
  f.engine.context = { state: 'suspended' }; f.controller.audioEvent('context-state', { state: 'suspended' });
  await f.controller.audioRecovery;
  const project = f.controller.state.project, performance = project.performances[0];
  assert.equal(performance.source, 'loops'); assert.equal(performance.status, 'interrupted'); assert.equal(performance.frames, 100);
  assert.equal(performance.masterAssetId, 'raw-1'); assert.equal(performance.leadAssetId, undefined);
  assert.equal(project.takes.length, 0); assert.equal(project.selectedTakeId, null);
  assert.equal(f.storage.finishCalls.filter(call => call.id === 'raw-1').length, 1); validateProject(project);
});

test('loop-only crash recovery restores a performance and latest playback without microphone or another vocal take', async () => {
  const f = loopMixFixture(), project = f.controller.state.project;
  const asset = recoverable(f, { kind: 'master', channels: 2, source: 'loops', name: 'Loop recording 4', captureId: 'loop-crash' });
  project.pendingCapture = { id: 'loop-crash', kind: 'mix', assetId: asset.id, startFrame: 200, sealedThroughFrame: 290,
    events: [{ type: 'mix', frame: 220 }, { type: 'mix', frame: 400 }], initialState: { frame: 200 } };
  f.engine.micHook = () => { throw new Error('Microphone must not be requested'); };
  await f.controller.recoverAsset(asset.id);
  const performance = project.performances[0];
  assert.equal(performance.source, 'loops'); assert.equal(performance.name, 'Loop recording 4 · recovered');
  assert.equal(performance.masterAssetId, asset.id); assert.equal(performance.leadAssetId, undefined);
  assert.equal(performance.startFrame, 200); assert.equal(performance.endFrame, 300); assert.equal(performance.status, 'recovered');
  assert.deepEqual(performance.events, [{ type: 'mix', frame: 220 }]); assert.equal(performance.compensationFrames, 0);
  assert.equal(project.pendingCapture, undefined); assert.equal(project.takes.length, 0); assert.equal(project.selectedTakeId, null);
  assert.deepEqual(f.controller.state.recentRecording, { kind: 'performance', id: performance.id });
  assert.equal(f.controller.state.recovered.length, 0); validateProject(project);
  await f.controller.recoverAsset(asset.id); assert.equal(project.performances.length, 1, 'recovery is idempotent');
});

test('recovering an older loop-only master retains an unrelated capture intent', async () => {
  const f = loopMixFixture(); recoverable(f, { kind: 'master', channels: 2, source: 'loops' });
  const intent = { id: 'other-capture', kind: 'vocal', assetId: 'other-vocal', events: [], startFrame: 300 };
  f.controller.state.project.pendingCapture = clone(intent);
  await f.controller.recoverAsset('recover-1');
  assert.deepEqual(f.controller.state.project.pendingCapture, intent);
  assert.equal(f.controller.state.project.performances[0].startFrame, 0);
});

test('loop-only arrangement interruption keeps full stereo audio and a bounded editable interval', async () => {
  const f = loopMixFixture(); recoverable(f, { kind: 'master', channels: 2, source: 'loops' });
  f.controller.state.project.pendingCapture = { kind: 'mix', assetId: 'recover-1', startFrame: 200, arrangementIncomplete: true, arrangementThroughFrame: 235, events: [] };
  await f.controller.recoverAsset('recover-1');
  const performance = f.controller.state.project.performances[0];
  assert.equal(performance.arrangementIncomplete, true); assert.equal(performance.status, 'interrupted');
  assert.equal(performance.editableFrames, 35); assert.equal(performance.frames, 100);
  assert.equal(f.storage.assets.get('recover-1').frames, 100); validateProject(f.controller.state.project);
});

test('a loop-only performance can be removed, undone and reopened without losing its stereo recording', async () => {
  const f = loopMixFixture(); finishedCapture(f, { kind: 'mix' }); await f.controller.tryFinalize();
  f.ui.confirm = async options => { assert.doesNotMatch(options.message, /Your vocal take/); return true; };
  const projectId = f.controller.state.project.id, performanceId = f.controller.state.project.performances[0].id;
  await f.controller.removePerformance(performanceId);
  assert.equal(f.controller.state.project.performances[0].removed, true); assert.equal(f.storage.assets.has('raw-1'), true);
  await f.controller.handle({ type: 'undo' }); assert.equal(f.controller.state.project.performances[0].removed, undefined);
  await f.controller.saveNow(); await f.controller.openProject(projectId);
  assert.deepEqual(f.controller.state.recentRecording, { kind: 'performance', id: performanceId });
  assert.equal(f.controller.state.project.takes.length, 0); assert.equal(f.controller.state.recovered.length, 0);
});

for (const capacity of [{ usage: 1, quota: 1 }, { usage: null, quota: 500 }, { usage: 0, quota: 0 }, { usage: NaN, quota: 1000 }]) test(`recording uses actual writes rather than rejecting the browser quota estimate ${JSON.stringify(capacity)}`, async () => {
  const f = loopMixFixture(); f.controller.state.storage = capacity; f.storage.estimate = async () => capacity;
  await f.controller.startCapture('mix', 0);
  assert.equal(f.storage.beginCalls.length, 1); assert.ok(f.engine.commands.some(command => command.type === 'arm'));
  assert.equal(f.ui.notifications.some(item => /browser estimates/.test(item.message)), Number.isFinite(capacity.usage) && capacity.usage >= 0 && capacity.quota > 0);
});
test('unavailable quota estimation does not block recording but an actual storage write failure does', async () => {
  const f = loopMixFixture(); f.storage.estimate = async () => { throw new Error('Estimate unavailable'); };
  await f.controller.startCapture('mix', 0); assert.ok(f.engine.commands.some(command => command.type === 'arm')); await tick();
  assert.equal(f.controller.state.storage.usage, null); assert.equal(f.controller.state.storage.quota, null);
  const blocked = loopMixFixture(); blocked.storage.beginHook = () => { throw Object.assign(new Error('Device storage is full'), { name: 'QuotaExceededError' }); };
  await assert.rejects(blocked.controller.startCapture('mix', 0), /Device storage is full/);
  assert.equal(blocked.engine.commands.some(command => command.type === 'arm'), false);
});

function storageFileFixture() {
  const f = loopMixFixture(), project = f.controller.state.project;
  f.storage.assets.get('backing').name = 'Bass'; f.storage.projects.set(project.id, clone(project));
  f.controller.history.push(project); f.ui.confirm = async () => true;
  f.ui.showStorageManager = (...args) => { f.manager = args; };
  return f;
}
test('Storage lists files across projects and keeps unknown capacity unknown', async () => {
  const f = storageFileFixture(), other = createProject('Other song'); f.storage.projects.set(other.id, other);
  f.storage.assets.set('elsewhere', { id: 'elsewhere', projectId: other.id, name: 'Other vocal', frames: 10, channels: 1, status: 'complete' });
  f.storage.estimate = async () => ({ usage: null, quota: null });
  await f.controller.manageStorage(); assert.equal(f.manager[0].length, 2);
  assert.deepEqual(f.manager[2].files.map(file => file.id).sort(), ['backing', 'elsewhere']); assert.equal(f.manager[1].usage, null); assert.equal(f.manager[1].quota, null);
});
test('permanent file deletion confirms consequences, closes audio and clears Undo before deleting referenced bytes', async () => {
  const f = storageFileFixture(); let confirmation;
  f.ui.confirm = async options => { confirmation = options; return true; };
  f.storage.storedDeleteHook = () => {
    assert.ok(f.engine.commands.some(command => command.type === 'close')); assert.equal(f.controller.engine, null); assert.equal(f.controller.history.past.length, 0);
  };
  await f.controller.handle({ type: 'delete-storage-file', fileKey: 'asset:backing' });
  assert.match(confirmation.message, /Bass/); assert.match(confirmation.message, /1 loop/); assert.match(confirmation.message, /cannot be undone/);
  assert.equal(f.storage.assets.has('backing'), false); assert.equal(f.controller.state.project.tracks.length, 0);
  assert.equal(f.controller.state.selectedTrackId, null); assert.equal(f.controller.state.busy, false); assert.equal(f.controller.fileDeletion, null);
  await f.controller.handle({ type: 'undo' }); assert.equal(f.controller.state.project.tracks.length, 0); assert.equal(f.manager[2].files.length, 0);
});
test('canceling a permanent file deletion leaves storage, playback and history unchanged', async () => {
  const f = storageFileFixture(), before = clone(f.controller.state.project); f.ui.confirm = async () => false;
  await f.controller.deleteStorageFile('asset:backing'); assert.ok(f.storage.assets.has('backing')); assert.deepEqual(f.controller.state.project, before);
  assert.equal(f.controller.engine, f.engine); assert.equal(f.controller.history.past.length, 1); assert.equal(f.controller.fileDeletion, null);
});
for (const change of ['bytes', 'project', 'selection', 'capture']) test(`file deletion rechecks ${change} after confirmation`, async () => {
  const f = storageFileFixture(), gate = deferred(); f.ui.confirm = () => gate.promise;
  const deleting = f.controller.deleteStorageFile('asset:backing'); await tick();
  if (change === 'bytes') f.storage.assets.get('backing').frames++;
  if (change === 'project') f.controller.edit(project => { project.name = 'Changed'; });
  if (change === 'selection') f.controller.generation++;
  if (change === 'capture') f.controller.state.capture = { kind: 'loop' };
  gate.resolve(true);
  if (change === 'selection') await deleting; else await assert.rejects(deleting, /changed|Finish or cancel/);
  assert.ok(f.storage.assets.has('backing')); assert.equal(f.controller.fileDeletion, null);
});
test('physical deletion failure reloads durable reference pruning and retains the file for retry', async () => {
  const f = storageFileFixture(); f.storage.storedPhysicalDeleteHook = () => { throw new Error('Disk removal failed'); };
  await assert.rejects(f.controller.deleteStorageFile('asset:backing'), /Disk removal failed/);
  assert.equal(f.controller.state.project.tracks.length, 0); assert.equal(f.controller.history.past.length, 0); assert.equal(f.controller.state.busy, false);
  assert.ok(f.storage.assets.has('backing')); assert.ok(f.controller.state.recovered.some(asset => asset.id === 'backing'));
  f.storage.storedPhysicalDeleteHook = null; await f.controller.deleteStorageFile('asset:backing'); assert.equal(f.storage.assets.has('backing'), false);
});
test('file deletion preserves an unrelated project and blocks competing edits during its commit', async () => {
  const f = storageFileFixture(), other = createProject('Other song'); f.storage.projects.set(other.id, other);
  f.storage.assets.set('elsewhere', { id: 'elsewhere', projectId: other.id, name: 'Other file', frames: 10, channels: 1, status: 'complete' });
  const gate = deferred(), entered = deferred(); f.storage.storedDeleteHook = async () => { entered.resolve(); await gate.promise; };
  const before = clone(f.controller.state.project), deleting = f.controller.deleteStorageFile('asset:elsewhere'); await entered.promise;
  await assert.rejects(f.controller.handle({ type: 'remove-track', id: before.tracks[0].id }), /Wait for file deletion/);
  await assert.rejects(f.controller.openProject(other.id), /Wait for deletion/);
  await assert.rejects(f.controller.deleteStorageFile('asset:backing'), /current operation/);
  gate.resolve(); await deleting; assert.deepEqual(f.controller.state.project, before); assert.equal(f.storage.assets.has('backing'), true);
});

test('an edit during the final storage inventory cannot be lost by permanent file deletion', async () => {
  const f = storageFileFixture(), gate = deferred(), entered = deferred(), inventory = f.storage.getStorageInventory.bind(f.storage); let calls = 0;
  f.storage.getStorageInventory = async () => { if (++calls === 3) { entered.resolve(); await gate.promise; } return inventory(); };
  const deleting = f.controller.deleteStorageFile('asset:backing'); await entered.promise;
  f.controller.edit(project => { project.name = 'Keep this edit'; }); gate.resolve();
  await assert.rejects(deleting, /project changed/); assert.equal(f.controller.state.project.name, 'Keep this edit'); assert.ok(f.storage.assets.has('backing')); assert.equal(f.controller.engine, f.engine);
});
test('a quota-limited recovery session can permanently delete referenced audio using its durable manifest', async () => {
  const f = storageFileFixture(); f.controller.state.readonly = true; f.controller.state.recoveryRequired = true; f.controller.state.readonlyReason = 'Recovery could not be saved.';
  f.storage.saveHook = () => { throw new Error('Do not overwrite the recovery manifest before deletion'); };
  await f.controller.deleteStorageFile('asset:backing'); assert.equal(f.storage.assets.has('backing'), false); assert.equal(f.controller.state.project.tracks.length, 0);
  assert.equal(f.storage.saved.length, 0); assert.equal(f.controller.state.readonly, true, 'recovery remains explicit until the user reopens/retries');
});
test('Storage includes soft-deleted projects and measures their actual remaining files', async () => {
  const f = storageFileFixture(), other = createProject('Retained deleted song'); other.deletedAt = new Date().toISOString(); f.storage.projects.set(other.id, other);
  f.storage.assets.set('retained', { id: 'retained', projectId: other.id, name: 'Retained take', frames: 13, channels: 2, status: 'complete' });
  const inventory = f.storage.getStorageInventory.bind(f.storage);
  f.storage.getStorageInventory = async () => ({ ...await inventory(), projects: [...f.storage.projects.values()].map(clone) });
  f.storage.listProjects = async () => [...f.storage.projects.values()].filter(project => !project.deletedAt).map(clone);
  await f.controller.manageStorage(); const retained = f.manager[0].find(project => project.id === other.id);
  assert.ok(retained); assert.equal(retained.deletedAt, other.deletedAt); assert.equal(retained.audioBytes, 104); assert.equal(retained.assetCount, 1);
  f.storage.purgeProject = async id => { f.storage.projects.delete(id); for (const [assetId, asset] of f.storage.assets) if (asset.projectId === id) f.storage.assets.delete(assetId); };
  await f.controller.deleteProject(other.id); assert.equal(f.storage.projects.has(other.id), false); assert.equal(f.storage.assets.has('retained'), false); assert.ok(f.storage.assets.has('backing'));
});
test('Storage does not turn an incomplete audio inventory into a zero-byte project claim', async () => {
  const f = storageFileFixture(), inventory = f.storage.getStorageInventory.bind(f.storage);
  f.storage.getStorageInventory = async () => ({ ...await inventory(), files: [], complete: false, errors: ['Recording index: unavailable'] });
  await f.controller.manageStorage(); assert.equal(f.manager[0][0].audioBytes, null); assert.equal(f.manager[0][0].knownAudioBytes, 0);
});

test('shared-audio project purge rejection keeps individual file cleanup available without reopening', async () => {
  const f = storageFileFixture(), project = f.controller.state.project, other = createProject('Other arrangement');
  other.tracks = clone(project.tracks); f.storage.projects.set(other.id, other);
  f.storage.purgeProject = async () => { throw Object.assign(new Error('Delete shared files individually in Storage first.'), { code: 'PROJECT_AUDIO_SHARED' }); };
  await assert.rejects(f.controller.deleteProject(project.id), { code: 'PROJECT_AUDIO_SHARED' });
  assert.equal(f.controller.engine, null); assert.equal(f.controller.state.playing, false);
  assert.equal(f.controller.state.readonly, false); assert.equal(f.controller.state.deletionPending, false); assert.equal(f.controller.state.busy, false);
  assert.equal(f.storage.projects.get(project.id).purgePendingAt, undefined); assert.ok(f.storage.assets.has('backing'));
  await f.controller.handle({ type: 'delete-storage-file', fileKey: 'asset:backing' });
  assert.equal(f.storage.assets.has('backing'), false); assert.equal(f.controller.state.project.tracks.length, 0); assert.equal(f.storage.projects.get(other.id).tracks.length, 0);
});
test('shared-audio purge preflight preserves pre-existing quota recovery restrictions', async () => {
  const f = storageFileFixture(); f.controller.state.readonly = true; f.controller.state.recoveryRequired = true; f.controller.state.readonlyReason = 'Recovery could not be saved.';
  f.storage.purgeProject = async () => { throw Object.assign(new Error('Shared audio'), { code: 'PROJECT_AUDIO_SHARED' }); };
  await assert.rejects(f.controller.deleteProject(f.controller.state.project.id), { code: 'PROJECT_AUDIO_SHARED' });
  assert.equal(f.controller.state.readonly, true); assert.equal(f.controller.state.recoveryRequired, true); assert.equal(f.controller.state.readonlyReason, 'Recovery could not be saved.');
  assert.equal(f.controller.state.deletionPending, false);
  await f.controller.handle({ type: 'delete-storage-file', fileKey: 'asset:backing' }); assert.equal(f.storage.assets.has('backing'), false);
});
for (const existingPartial of ['state', 'manifest', 'unreadable']) test(`shared-audio rejection cannot unfreeze an existing partial purge: ${existingPartial}`, async () => {
  const f = storageFileFixture(), project = f.controller.state.project;
  if (existingPartial === 'state') { f.controller.state.deletionPending = true; f.controller.state.readonly = true; }
  if (existingPartial === 'manifest') f.storage.projects.get(project.id).purgePendingAt = Date.now();
  f.storage.purgeProject = async () => {
    if (existingPartial === 'unreadable') f.storage.loadProject = async () => { throw new Error('Manifest unavailable'); };
    throw Object.assign(new Error('Shared audio'), { code: 'PROJECT_AUDIO_SHARED' });
  };
  await assert.rejects(f.controller.deleteProject(project.id), { code: 'PROJECT_AUDIO_SHARED' });
  assert.equal(f.controller.state.readonly, true); assert.equal(f.controller.state.deletionPending, true);
  await assert.rejects(f.controller.handle({ type: 'delete-storage-file', fileKey: 'asset:backing' }), /Project deletion is unfinished/); assert.ok(f.storage.assets.has('backing'));
});

test('first and later loops default to free recording with immediate start', async () => {
  for (const baseFrames of [0, 96000]) {
    const f = fixture(); f.controller.state.project.baseFrames = baseFrames; f.controller.state.playing = !!baseFrames;
    await f.controller.handle({ type: 'add-loop' });
    const armed = f.engine.commands.find(command => command.type === 'arm').capture;
    assert.equal(armed.lengthFrames, 0); assert.equal(armed.quantized, false);
    assert.equal(f.controller.pending.lengthMode, 'free'); assert.equal(f.controller.pending.startMode, 'immediate');
    assert.doesNotMatch(f.controller.state.status, /next cycle/i);
    await f.controller.cancelPrepared(f.controller.pending);
  }
});

test('custom seconds creates exact frame targets for both the first loop and later loops', async () => {
  for (const baseFrames of [0, 96000]) {
    const f = fixture(), p = f.controller.state.project; p.baseFrames = baseFrames;
    await f.controller.handle({ type: 'set-loop-recording', settings: { mode: 'seconds', seconds: 3.2500209 } });
    await f.controller.handle({ type: 'add-loop' });
    const armed = f.engine.commands.find(command => command.type === 'arm').capture;
    assert.equal(armed.lengthFrames, Math.round(3.2500209 * p.sampleRate)); assert.equal(armed.quantized, false);
    assert.equal(f.controller.state.capture.lengthMode, 'seconds'); assert.equal(f.controller.state.capture.targetFrames, 156001);
    assert.deepEqual(f.storage.saved.at(-1).loopRecording, { mode: 'seconds', seconds: 3.2500209, cycles: 1, start: 'immediate' });
    await f.controller.cancelPrepared(f.controller.pending);
  }
});

test('cycle duration and next-cycle start are separate choices without the old 64-cycle cap', async () => {
  const f = fixture(), p = f.controller.state.project; p.baseFrames = 48000; f.controller.state.playing = true;
  await f.controller.handle({ type: 'set-loop-recording', settings: { mode: 'cycles', cycles: 100, start: 'next-cycle' } });
  await f.controller.handle({ type: 'add-loop' });
  let armed = f.engine.commands.find(command => command.type === 'arm').capture;
  assert.equal(armed.lengthFrames, 4800000); assert.equal(armed.quantized, true); assert.match(f.controller.state.status, /next cycle/i);
  await f.controller.cancelPrepared(f.controller.pending); f.engine.commands = [];
  await f.controller.handle({ type: 'set-loop-recording', settings: { mode: 'free' } });
  await f.controller.handle({ type: 'add-loop' }); armed = f.engine.commands.find(command => command.type === 'arm').capture;
  assert.equal(armed.lengthFrames, 0); assert.equal(armed.quantized, true); await f.controller.cancelPrepared(f.controller.pending);
});

test('vocal and loops-only recording start immediately unless next-cycle is explicitly selected', async () => {
  for (const kind of ['vocal', 'mix']) for (const start of ['immediate', 'next-cycle']) {
    const f = loopMixFixture(); f.controller.state.playing = true;
    await f.controller.handle({ type: 'set-loop-recording', settings: { mode: 'seconds', seconds: 8, start } });
    await f.controller.handle({ type: kind === 'vocal' ? 'sing' : 'record-all-loops' });
    const armed = f.engine.commands.find(command => command.type === 'arm').capture;
    assert.equal(armed.lengthFrames, 0); assert.equal(armed.quantized, start === 'next-cycle');
    await f.controller.cancelPrepared(f.controller.pending);
  }
});

test('invalid custom duration and first-loop cycle mode reject before microphone permission or storage creation', async () => {
  for (const settings of [{ mode: 'seconds', seconds: Number.MIN_VALUE }, { mode: 'seconds', seconds: .001 }, { mode: 'seconds', seconds: Number.MAX_VALUE }, { mode: 'cycles', cycles: 1 }]) {
    const f = fixture(); let micCalls = 0; f.engine.micHook = () => { micCalls++; };
    await f.controller.handle({ type: 'set-loop-recording', settings });
    await assert.rejects(f.controller.handle({ type: 'add-loop' }), /valid recording length|longer than|first loop/);
    assert.equal(micCalls, 0); assert.equal(f.storage.beginCalls.length, 0); assert.equal(f.controller.pending, null); assert.equal(f.controller.state.busy, false);
  }
  const f = fixture(); f.controller.state.project.baseFrames = 48000;
  await f.controller.handle({ type: 'set-loop-recording', settings: { mode: 'cycles', cycles: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(f.controller.handle({ type: 'add-loop' }), /valid recording length/);
});

test('recording options cannot change while capture is preparing or active', async () => {
  const f = fixture(), permission = deferred(); f.engine.micHook = () => permission.promise;
  const start = f.controller.handle({ type: 'add-loop' });
  await assert.rejects(f.controller.handle({ type: 'set-loop-recording', settings: { mode: 'seconds', seconds: 5 } }), /Finish or cancel/);
  permission.resolve(); await start;
  await assert.rejects(f.controller.handle({ type: 'set-loop-recording', settings: { start: 'next-cycle' } }), /Finish or cancel/);
  assert.equal(f.controller.state.project.loopRecording.mode, 'free'); await f.controller.cancelPrepared(f.controller.pending);
});

test('advisory storage estimates never delay arming and cannot overwrite a newer session', async () => {
  const f = fixture(), estimate = deferred(); let estimateCalls = 0; f.storage.estimate = () => { estimateCalls++; return estimate.promise; };
  await f.controller.handle({ type: 'add-loop' });
  assert.equal(estimateCalls, 1); assert.ok(f.engine.commands.some(command => command.type === 'arm')); assert.equal(f.controller.state.busy, false);
  const pending = f.controller.pending; await f.controller.handle({ type: 'cancel' });
  f.controller.state.storage = { usage: 50, quota: 100 };
  estimate.resolve({ usage: 1, quota: 999 }); await tick();
  assert.deepEqual(f.controller.state.storage, { usage: 50, quota: 100 }); await f.controller.cancelPrepared(pending);
});

test('background capacity refresh occurs only after durable capture metadata and assets are prepared', async () => {
  const f = fixture(), order = [];
  f.storage.saveHook = () => { order.push('save'); }; f.storage.beginHook = () => { order.push('asset'); };
  const arm = f.engine.arm.bind(f.engine); f.engine.arm = capture => { order.push('arm'); arm(capture); };
  f.storage.estimate = async () => { order.push('estimate'); return { usage: 10, quota: 5000 }; };
  await f.controller.handle({ type: 'sing' }); await tick();
  assert.deepEqual(order, ['save', 'asset', 'asset', 'arm', 'estimate']); assert.equal(f.controller.state.storage.usage, 10);
  await f.controller.cancelPrepared(f.controller.pending);
});

function playbackMedia({ source = 'blob:recording', currentTime = 2.25, paused = false } = {}) {
  return { src: source, currentTime, paused, ended: false, playCalls: 0, pauseCalls: 0,
    getAttribute(name) { return name === 'src' ? this.src : null; },
    pause() { this.paused = true; this.pauseCalls++; },
    async play() { this.paused = false; this.playCalls++; } };
}

test('Stop resets every loaded audio player and transport without removing their selected recordings or authored timing', async () => {
  const f = fixture(), project = f.controller.state.project;
  project.tracks = [createTrack({ assetId: 'a', frames: 1000, offsetFrames: 319 }), createTrack({ assetId: 'b', frames: 1500, offsetFrames: -421 })];
  const tracks = clone(project.tracks), media = [playbackMedia(), playbackMedia({ source: 'blob:master', currentTime: 4.5 }), playbackMedia({ source: 'blob:editor', currentTime: .8 })];
  f.ui.getPlaybackMedia = () => media;
  f.controller.state.preview = { url: media[0].src, name: 'Song' };
  f.controller.state.recordingMix = { previewUrl: media[1].src };
  f.controller.state.trackEditor = { previewUrl: media[2].src };
  f.controller.refreshTrackEditor = () => {}; f.controller.refreshRecordingMix = () => {}; f.controller.loadEditorWaveform = () => {};
  f.controller.state.playing = true; f.controller.state.transportFrame = 4719; f.controller.state.queuedSectionId = 'later';
  f.controller.state.project.input.monitor = true; f.controller.state.monitor = true;
  await f.controller.handle({ type: 'stop' });
  assert.equal(f.controller.state.transportFrame, 0); assert.equal(f.controller.state.playing, false); assert.equal(f.controller.state.paused, false);
  assert.equal(f.controller.state.queuedSectionId, null); assert.equal(f.controller.state.monitor, false);
  assert.deepEqual(project.tracks, tracks); assert.deepEqual(Object.values(f.controller.state.playbackOffsets), [0, 0]);
  assert.deepEqual(f.controller.state.playbackBaselines, Object.fromEntries(tracks.map(track => [track.id, track.offsetFrames])));
  for (const item of media) { assert.equal(item.currentTime, 0); assert.equal(item.paused, true); assert.ok(item.src); }
  assert.equal(f.controller.state.preview.url, 'blob:recording'); assert.equal(f.controller.state.recordingMix.previewUrl, 'blob:master'); assert.equal(f.controller.state.trackEditor.previewUrl, 'blob:editor');
});

test('Pause holds transport and microphone-monitor preference, and Play resumes only that transport', async () => {
  const f = fixture(); f.controller.state.playing = true; f.engine.playing = true; f.controller.state.transportFrame = 901;
  f.controller.state.monitor = true; f.controller.state.project.input.monitor = true;
  const idlePreview = playbackMedia({ paused: true }); f.ui.getPlaybackMedia = () => [idlePreview];
  await f.controller.handle({ type: 'pause' });
  assert.equal(f.controller.state.paused, true); assert.equal(f.controller.state.playing, false); assert.equal(f.controller.state.transportFrame, 901);
  assert.equal(f.controller.state.project.input.monitor, true); assert.ok(f.engine.commands.some(command => command.type === 'pause'));
  await f.controller.handle({ type: 'play' });
  assert.equal(idlePreview.playCalls, 0); assert.equal(f.engine.commands.filter(command => command.type === 'play').length, 1);
  assert.equal(f.controller.state.paused, false); assert.equal(f.controller.state.transportFrame, 901);
});

test('Pause and Stop preserve the pending-save status until the durable save completes', async () => {
  const f = fixture(), write = deferred();
  f.controller.state.playing = true; f.engine.playing = true;
  f.storage.saveHook = () => write.promise;
  const saving = f.controller.saveNow(); await tick();
  assert.equal(f.controller.state.status, 'Saving…');
  await f.controller.handle({ type: 'pause' });
  assert.equal(f.controller.state.status, 'Saving…', 'Pause must preserve the unsaved-change guard');
  await f.controller.handle({ type: 'stop' });
  assert.equal(f.controller.state.status, 'Saving…', 'Stop must preserve the unsaved-change guard');
  write.resolve(); await saving;
  assert.equal(f.controller.state.status, 'Saved on this device');
  await f.controller.handle({ type: 'stop' });
  assert.equal(f.controller.state.status, 'Saved on this device', 'Transport controls do not replace durable save status');
});

test('Pause and Play retain the native recording position, and Stop restarts that recording from zero without starting backing', async () => {
  const f = fixture(), media = playbackMedia(); f.ui.getPlaybackMedia = () => [media];
  await f.controller.handle({ type: 'pause' });
  assert.equal(media.currentTime, 2.25); assert.equal(media.paused, true); assert.equal(f.controller.state.paused, true);
  await f.controller.handle({ type: 'play' });
  assert.equal(media.currentTime, 2.25); assert.equal(media.playCalls, 1); assert.equal(media.paused, false);
  assert.equal(f.engine.commands.some(command => command.type === 'play'), false);
  await f.controller.handle({ type: 'stop' }); assert.equal(media.currentTime, 0); assert.equal(media.paused, true);
  await f.controller.handle({ type: 'play' }); assert.equal(media.playCalls, 2); assert.equal(media.currentTime, 0);
  assert.equal(f.engine.commands.some(command => command.type === 'play'), false);
});

test('native Play clears a global pause and replacing the preview cannot resume an obsolete audio source', async () => {
  const f = fixture(), media = playbackMedia(); f.ui.getPlaybackMedia = () => [media];
  await f.controller.handle({ type: 'pause' }); assert.equal(f.controller.pausedMedia.length, 1);
  await f.controller.handle({ type: 'media-playback', playing: true, id: 'performance-player' });
  assert.equal(f.controller.state.paused, false); assert.equal(f.controller.pausedMedia.length, 0);
  media.paused = false; await f.controller.handle({ type: 'pause' });
  f.ui.getPlaybackMedia = () => []; f.controller.closePreview(); await f.controller.handle({ type: 'play' });
  assert.equal(media.playCalls, 0); assert.equal(f.engine.commands.filter(command => command.type === 'play').length, 1);
});

test('old meter and audition acknowledgements cannot resurrect playback after Stop', async () => {
  const f = fixture(); f.controller.state.transportFrame = 4500; f.controller.state.playing = true;
  await f.controller.handle({ type: 'stop' }); const generation = f.engine.transportGeneration;
  f.controller.audioEvent('meter', { transportGeneration: generation - 1, playing: true, transportFrame: 4600, outputLevel: .5 });
  f.controller.audioEvent('audition-start', { transportGeneration: generation - 1, id: 'old', startFrame: 4600, endFrame: 6000 });
  assert.equal(f.controller.state.transportFrame, 0); assert.equal(f.controller.state.playing, false); assert.equal(f.controller.state.audition, null);
  f.controller.audioEvent('state', { transportGeneration: generation, playing: false, transportFrame: 0, paused: false });
  await f.controller.handle({ type: 'play' }); f.controller.state.playing = true;
  f.controller.audioEvent('audition-end', { transportGeneration: generation, reason: 'stopped' });
  assert.equal(f.controller.state.playing, true);
});

test('Pause and Play cannot interrupt an active recording or its finishing tail', async () => {
  for (const kind of ['loop', 'vocal', 'mix']) for (const status of ['arming', 'recording', 'finishing']) {
    const f = fixture(); f.controller.state.capture = { kind, status }; f.controller.state.transportFrame = 719;
    await assert.rejects(f.controller.handle({ type: 'pause' }), /recording before pausing/);
    await assert.rejects(f.controller.handle({ type: 'play' }), /Finish saving the recording/);
    assert.equal(f.controller.state.transportFrame, 719); assert.equal(f.engine.commands.length, 0);
  }
});

test('Stop leaves capture recovery progress on its original timeline while the visible transport returns to zero', async () => {
  const f = fixture(); finishedCapture(f, { rawFrames: 700, masterFrames: 700 });
  f.controller.state.transportFrame = 2000; f.controller.pending.finalizing = false; f.controller.updateCaptureIntent();
  const checkpoint = f.controller.state.project.pendingCapture.sealedThroughFrame;
  await f.controller.handle({ type: 'stop' }); f.controller.updateCaptureIntent();
  assert.equal(f.controller.state.transportFrame, 0); assert.equal(f.controller.pending.stopRequested, true);
  assert.equal(f.controller.state.project.pendingCapture.sealedThroughFrame, checkpoint);
  assert.equal(f.controller.state.capture.status, 'finishing');
});

test('a cold Stop requests a source-aligned reset after the graph is initialized', async () => {
  const f = fixture(); f.controller.engine = null;
  await f.controller.handle({ type: 'stop' }); assert.equal(f.controller.resetTransportOnInit, true);
  const engine = f.engine; engine.init = async () => engine; engine.waitUntilReady = async () => {}; f.controller.engine = engine;
  await StudioController.prototype.ensureAudio.call(f.controller);
  assert.equal(f.controller.resetTransportOnInit, false); assert.equal(engine.commands.filter(command => command.type === 'stop').length, 1);
});

test('current playback exports derive a fresh nudge from the reset baseline without changing stored loop offsets', async () => {
  const f = fixture(), track = createTrack({ assetId: 'phase', frames: 1000, offsetFrames: 327 });
  f.controller.state.project.tracks.push(track); await f.controller.handle({ type: 'stop' });
  assert.equal(f.controller.currentPlaybackProject().tracks[0].offsetFrames, 0);
  track.offsetFrames += 57; // Export immediately, before a later meter can arrive.
  assert.equal(f.controller.currentPlaybackProject().tracks[0].offsetFrames, 57);
  assert.equal(f.controller.state.project.tracks[0].offsetFrames, 384);
});

test('current playback exports preserve exact phase when valid authored offsets have an unsafe difference', async () => {
  const f = fixture(), track = createTrack({ assetId: 'extreme-offset', frames: 1003, offsetFrames: -Number.MAX_SAFE_INTEGER });
  f.controller.state.project.tracks = [track];
  await f.controller.handle({ type: 'stop' });
  track.offsetFrames = Number.MAX_SAFE_INTEGER;
  const exported = f.controller.currentPlaybackProject();
  assert.equal(exported.tracks[0].offsetFrames, Number((2n * BigInt(Number.MAX_SAFE_INTEGER)) % BigInt(track.frames)));
  assert.ok(Number.isSafeInteger(exported.tracks[0].offsetFrames));
  assert.equal(track.offsetFrames, Number.MAX_SAFE_INTEGER, 'The authored timing is not rewritten');
});
