import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { createProject, createTrack, clone, MAX_TRACKS } from '../src/project.mjs';

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
  async deleteAsset(id) { this.assets.delete(id); }
  async getAsset(id) { if (this.readHook) await this.readHook(id); const asset = this.assets.get(id); if (!asset) throw new Error('Asset not found'); return clone(asset); }
  async recover() { if (this.recoverError) throw this.recoverError; return []; }
  async releaseProject(id) { this.released.push(id); }
}
class FakeUI extends EventTarget {
  constructor() { super(); this.notifications = []; this.renders = []; }
  render(state) { this.renders.push({ status: state.status, busy: state.busy, capture: state.capture ? { ...state.capture } : null }); }
  notify(message, kind) { this.notifications.push({ message, kind }); }
}
class FakeEngine {
  constructor() { this.commands = []; this.micHook = null; }
  async enableMic() { if (this.micHook) await this.micHook(); }
  configure(project) { this.commands.push({ type: 'configure', id: project.id }); }
  syncTracks(tracks) { this.commands.push({ type: 'sync-tracks', ids: tracks.map(track => track.id) }); }
  arm(capture) { this.commands.push({ type: 'arm', capture }); }
  cancel() { this.commands.push({ type: 'cancel' }); }
  stop() { this.commands.push({ type: 'stop' }); }
  play() { this.commands.push({ type: 'play' }); }
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
  const track = createTrack({ assetId: 'raw-1', name: 'Vocal take 1', role: kind === 'loop' ? 'beat' : 'lead', frames: rawFrames });
  const done = deferred();
  controller.pending = { id: 'capture-1', kind, assetId: 'raw-1', masterAssetId: kind === 'vocal' ? 'master-1' : null, performanceId: 'performance-1', takeId: 'take-1',
    track, startFrame: 1000, createdAt: new Date().toISOString(), events: [], initialState: { tracks: [], baseFrames: 0, master: { volume: .8 }, input: clone(project.input), frame: 1000 },
    ended: true, end: { captureId: 'capture-1', kind, status: 'complete', startFrame: 1000, frames: rawFrames, track }, done: done.promise, resolveDone: done.resolve };
  project.pendingCapture = { id: 'capture-1', assetId: 'raw-1' };
  const raw = { id: 'raw-1', projectId: project.id, channels: 1, sampleRate: 48000, kind, frames: rawFrames, checkpointFrames: rawFrames, status: rawStatus };
  storage.assets.set(raw.id, raw); controller.sealed.set(raw.id, { ...raw, finalized });
  if (kind === 'vocal') { const master = { id: 'master-1', projectId: project.id, channels: 2, sampleRate: 48000, kind: 'master', frames: masterFrames, checkpointFrames: masterFrames, status: masterStatus }; storage.assets.set(master.id, master); controller.sealed.set(master.id, { ...master, finalized }); }
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
test('canceling permanent project deletion leaves recordings and playback untouched', async () => {
  const f=fixture();f.storage.projects.set(f.controller.state.project.id,clone(f.controller.state.project));
  f.ui.confirm=async()=>false;f.storage.purgeProject=()=>{throw new Error('must not purge');};
  await f.controller.deleteProject(f.controller.state.project.id);
  assert.equal(f.engine.commands.length,0);assert.equal(f.storage.projects.size,1);
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
  assert.ok(f.ui.notifications.some(item=>/unfinished recording was recovered/i.test(item.message)));
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
  assert.equal(f.storage.assets.size, 2); assert.ok([...f.storage.assets.values()].every((asset) => asset.status === 'cancelled'));
});

test('failed second-asset preparation cancels the first asset and never arms', async () => {
  const f = fixture(); let begun = 0;
  f.storage.beginHook = () => { if (++begun === 2) throw new Error('Master storage quota'); };
  await assert.rejects(f.controller.startCapture('vocal'), /Master storage quota/);
  assert.equal(f.engine.commands.some((item) => item.type === 'arm'), false);
  assert.equal(f.controller.pending, null); assert.equal(f.controller.state.capture, null);
  assert.equal(f.storage.assets.size, 1); assert.equal([...f.storage.assets.values()][0].status, 'cancelled');
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

test('recovery checks the layer limit before reading waveforms and immediately before publishing', async () => {
  const f = fixture(); recoverable(f); f.controller.state.project.tracks = Array.from({ length: MAX_TRACKS }, (_, i) => createTrack({ assetId: `used-${i}`, frames: 10 }));
  f.controller.summarize = () => { throw new Error('must not summarize full project'); };
  await assert.rejects(f.controller.recoverAsset('recover-1'), /layer limit/); assert.equal(f.controller.state.project.tracks.length, MAX_TRACKS);
  f.controller.state.project.tracks.pop(); const gate = deferred(); f.controller.summarize = async () => { await gate.promise; return []; };
  const recovering = f.controller.recoverAsset('recover-1'); await tick(); f.controller.state.project.tracks.push(createTrack({ assetId: 'new-last', frames: 10 })); gate.resolve();
  await assert.rejects(recovering, /layer limit/); assert.equal(f.controller.state.project.tracks.length, MAX_TRACKS); assert.equal(f.storage.assets.get('recover-1').frames, 100);
});
