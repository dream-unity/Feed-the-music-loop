import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { createProject, createTrack, clone } from '../src/project.mjs';

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
  async finishAsset(id, options = {}) { this.finishCalls.push({ id, ...options }); if (this.finishHook) await this.finishHook(id, options); const asset = this.assets.get(id); if (!asset) throw new Error('Asset not found'); Object.assign(asset, { ...options, frames: asset.frames }); return clone(asset); }
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
  f.controller.renderMix = async (project, options) => { requests.push(options); return { assetId: 'render-x' }; };
  f.controller.offerAudioDownload = async (...args) => downloads.push(args);
  await f.controller.exportMix({}); await f.controller.exportMix({ durationSeconds: 3.5 });
  assert.equal(Object.hasOwn(requests[0], 'durationSeconds'), false); assert.equal(requests[0].performanceId, 'perf-x');
  assert.equal(requests[1].durationSeconds, 3.5); assert.equal(downloads[0][0], 'render-x');
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
