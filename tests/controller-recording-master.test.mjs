import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { createProject, createTrack, clone, PAGE_FRAMES } from '../src/project.mjs';
import { listRecordingSources, selectRecordingSource } from '../src/recording-sources.mjs';
import { WAV_HEADER_BYTES } from '../src/export/wav.mjs';

class Storage extends EventTarget {
  constructor() { super(); this.assets = new Map(); this.pages = new Map(); this.projects = new Map(); this.deleted = []; }
  async getAsset(id) { await this.readHook?.(id); const asset = this.assets.get(id); if (!asset) throw new Error('Missing source'); return clone(asset); }
  async beginAsset(asset) { this.assets.set(asset.id, { ...clone(asset), frames: 0, status: 'recording', pageFrames: PAGE_FRAMES }); }
  async putPage(id, index, buffer, frames, channels) { this.pages.set(`${id}:${index}`, { index, frames, channels, buffer: buffer.slice(0, frames * channels * 4) }); this.assets.get(id).frames += frames; }
  async readPage(id, index) { await this.pageHook?.(id, index); const page = this.pages.get(`${id}:${index}`); return page ? { ...page, buffer: page.buffer.slice(0) } : { missing: true }; }
  async finishAsset(id, options = {}) { const asset = this.assets.get(id); Object.assign(asset, { ...options, status: options.status || 'complete' }); return clone(asset); }
  async deleteAsset(id) { this.deleted.push(id); this.assets.delete(id); for (const key of this.pages.keys()) if (key.startsWith(`${id}:`)) this.pages.delete(key); }
  async saveProject(project) { await this.saveHook?.(project); this.projects.set(project.id, clone(project)); }
  async loadProject(id) { return clone(this.projects.get(id)); }
  async listAssets(projectId) { return [...this.assets.values()].filter(asset => asset.projectId === projectId).map(clone); }
  async listProjects() { return [...this.projects.values()].map(clone); }
  async recover() {}
  async releaseProject() {}
  async estimate() { return {}; }
  pcm(id) { return Float32Array.from([...this.pages.entries()].filter(([key]) => key.startsWith(`${id}:`)).sort((a, b) => a[1].index - b[1].index).flatMap(([, page]) => [...new Float32Array(page.buffer)])); }
}
class UI extends EventTarget { render() {} notify() {} confirm() { return true; } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture() {
  const storage = new Storage(), controller = new StudioController(storage, new UI()), project = createProject('Mastering', 8000);
  const track = createTrack({ assetId: 'loop', name: 'Backing', frames: 8 }); project.tracks.push(track); project.baseFrames = 8;
  project.takes.push({ id: 'take-vocal', assetId: 'voice', frames: 8, name: 'Voice', startFrame: 0, performanceId: 'voice-performance', mix: clone(track.mix), role: 'lead', createdAt: project.createdAt }); project.selectedTakeId = 'take-vocal';
  project.performances.push({ id: 'loops-performance', name: 'Loops song', source: 'loops', masterAssetId: 'song', frames: 8, startFrame: 0, status: 'complete', createdAt: project.createdAt,
    events: [], initialState: { tracks: clone(project.tracks), master: clone(project.master), baseFrames: 8, input: clone(project.input) } });
  controller.state.project = project; controller.state.busy = false; controller.state.sampleRate = project.sampleRate;
  controller.releaseWake = async () => {}; controller.scheduleSave = () => {};
  const commands = []; controller.engine = { stop() { commands.push('stop'); }, configure(project) { commands.push(['configure', project.input.monitor]); }, send() {}, async close() {} };
  controller.offerAudioDownload = async (assetId) => { controller.downloaded = assetId; };
  for (const [id, channels, samples] of [['loop', 1, [.1,.1,.1,.1,.1,.1,.1,.1]], ['voice', 1, [.7,.7,.7,.7,.7,.7,.7,.7]], ['song', 2, [.1,.2,.2,.3,.3,.4,.4,.5,.5,.6,.6,.7,.7,.8,.8,.2]]]) {
    await storage.beginAsset({ id, projectId: project.id, sampleRate: 8000, channels, kind: id === 'song' ? 'master' : 'loop', name: id });
    await storage.putPage(id, 0, Float32Array.from(samples).buffer, samples.length / channels, channels); await storage.finishAsset(id);
  }
  await storage.saveProject(project); controller.render(); return { storage, controller, project, track, commands };
}

test('source inventory includes full songs, separate vocals, loops and saved masters once, rejects unfinished and foreign audio', async () => {
  const f = await fixture(), base = { projectId: f.project.id, sampleRate: 8000, channels: 2, frames: 8, status: 'complete' };
  const recovered = [{ ...base, id: 'song', kind: 'master' }, { ...base, id: 'mastered', kind: 'mix', sourceAssetId: 'song' }, { ...base, id: 'imported', kind: 'recording' },
    { ...base, id: 'foreign', projectId: 'elsewhere' }, { ...base, id: 'cancelled', status: 'cancelled' }, { ...base, id: 'active', status: 'recording' }, { ...base, id: 'recover', needsRecovery: true }];
  const sources = listRecordingSources(f.project, recovered);
  assert.deepEqual(sources.map(item => item.assetId), ['song', 'voice', 'loop', 'mastered', 'imported']);
  assert.equal(sources[0].kind, 'loop-song'); assert.equal(sources[0].canRemix, true);
  assert.throws(() => selectRecordingSource(f.project, recovered, 'asset:foreign'), /Choose/);
  assert.throws(() => selectRecordingSource(f.project, recovered, 'asset:song', [{ assetId: 'song' }]), /incomplete/);
});

test('mastering a loop-only performance ignores selected vocal and keeps original stereo PCM and arrangement intact', async () => {
  const f = await fixture(), original = f.storage.pcm('song'), initial = clone(f.project.performances), take = f.project.selectedTakeId;
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
  await f.controller.handle({ type: 'recording-master-setting', settings: { balance: .5 } });
  await f.controller.handle({ type: 'export-recording-master' });
  const output = f.storage.assets.get(f.controller.downloaded); assert.equal(output.kind, 'mix'); assert.equal(output.sourceAssetId, 'song'); assert.equal(output.channels, 2); assert.equal(output.frames, 8);
  assert.deepEqual([...f.storage.pcm(output.id)], [...original].map((sample, index) => index % 2 ? sample : sample * .5));
  assert.deepEqual(f.storage.pcm('song'), original); assert.deepEqual(f.project.performances, initial); assert.equal(f.project.selectedTakeId, take);
  assert.equal(f.controller.state.recordingMixOutputs[0].id, output.id); assert.equal(f.controller.state.busy, false);
});

test('previews make no saved files, select any source moment, and compare untouched original against processing', async () => {
  const f = await fixture(); f.project.input.monitor = true;
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
  await f.controller.handle({ type: 'recording-master-setting', settings: { balance: .5 } });
  await f.controller.handle({ type: 'set-recording-preview-start', seconds: 3 / 8000 });
  await f.controller.handle({ type: 'preview-recording-master', original: true });
  const url = f.controller.state.recordingMix.previewUrl, bytes = await (await fetch(url)).arrayBuffer();
  assert.deepEqual([...new Float32Array(bytes.slice(WAV_HEADER_BYTES))], [...f.storage.pcm('song').slice(6)]);
  assert.equal(f.storage.assets.size, 3); assert.equal(f.project.input.monitor, false); assert.ok(f.commands.includes('stop'));
  await f.controller.handle({ type: 'preview-recording-master' });
  assert.equal(f.storage.assets.size, 3); assert.equal(f.controller.state.recordingMix.previewKind, 'master');
  await assert.rejects(fetch(url));
  await f.controller.handle({ type: 'recording-master-setting', settings: { gainDb: -6 } });
  assert.equal(f.controller.state.recordingMix.previewUrl, null); assert.equal(f.controller.state.recordingMix.analysis, null);
  await assert.rejects(f.controller.handle({ type: 'set-recording-preview-start', seconds: 8 / 8000 }), /within/);
});

test('settings are per asset, undoable, and source selection resets preview and restores saved settings', async () => {
  const f = await fixture(); await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
  await f.controller.handle({ type: 'recording-master-setting', settings: { gainDb: -5, normalize: true } });
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'voice' }); assert.equal(f.controller.state.recordingMix.settings.gainDb, 0);
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' }); assert.equal(f.controller.state.recordingMix.settings.gainDb, -5);
  f.controller.engine.syncTracks = () => {};
  await f.controller.handle({ type: 'undo' }); assert.equal(f.controller.state.recordingMix.settings.gainDb, 0);
  await f.controller.handle({ type: 'redo' }); assert.equal(f.controller.state.recordingMix.settings.gainDb, -5);
});

test('master actions reject capture, read-only writes, stale dimensions and saving failure before creating output', async () => {
  for (const scenario of ['capture', 'readonly', 'changed', 'failed-save']) {
    const f = await fixture(); await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
    if (scenario === 'capture') f.controller.state.capture = { kind: 'mix' };
    if (scenario === 'readonly') f.controller.state.readonly = true;
    if (scenario === 'changed') f.storage.assets.get('song').frames--;
    if (scenario === 'failed-save') f.controller.flushSave = async () => { throw new Error('quota'); };
    await assert.rejects(f.controller.handle({ type: 'export-recording-master' }));
    assert.equal(f.storage.assets.size, 3); assert.equal(f.controller.state.busy, false);
  }
});

test('render guards source changes, deletion and project switch; cancellation cleans unfinished output', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
  f.storage.pageHook = async () => { entered.resolve(); await gate.promise; };
  const operation = f.controller.handle({ type: 'export-recording-master' }); await entered.promise;
  for (const action of [{ type: 'recording-master-setting', settings: { gainDb: 9 } }, { type: 'select-recording', sourceKey: 'asset:voice' }, { type: 'delete-saved-mix', id: 'song' }, { type: 'open-project', id: 'elsewhere' }]) await assert.rejects(f.controller.handle(action), /Finish or cancel/);
  await f.controller.handle({ type: 'cancel-export' }); gate.resolve(); await operation;
  assert.equal(f.storage.assets.size, 3); assert.equal(f.controller.state.recordingMix.busy, false); assert.equal(f.controller.state.exporting, false);
});

test('download failure leaves a completed master visible beside its original', async () => {
  const f = await fixture(); f.controller.offerAudioDownload = async () => { throw new Error('download failed'); };
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
  await assert.rejects(f.controller.handle({ type: 'export-recording-master' }), /download failed/);
  assert.equal(f.controller.state.recordingMixOutputs.length, 1); assert.equal(f.storage.assets.get(f.controller.state.recordingMixOutputs[0].id).status, 'complete');
});

test('recorded arrangement target is independent from selected vocal and does not use a synthetic duration', async () => {
  const f = await fixture(); await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' }); await f.controller.handle({ type: 'remix-recording' });
  assert.equal(f.controller.state.remixPerformanceId, 'loops-performance'); assert.equal(f.project.selectedTakeId, 'take-vocal');
  await assert.rejects(f.controller.handle({ type: 'preview-mix' }), /recorded arrangement/);
  let options; f.controller.renderMix = async (project, input) => { options = input; return { assetId: 'song' }; };
  await f.controller.handle({ type: 'export-mix' }); assert.equal(options.performanceId, 'loops-performance'); assert.equal(options.durationSeconds, undefined);
});

test('song import keeps stereo and does not attach or change loop layers', async () => {
  const f = await fixture(), original = globalThis.AudioContext, left = Float32Array.from([.1,.2,.3]), right = Float32Array.from([-.3,-.2,-.1]), tracks = clone(f.project.tracks);
  globalThis.AudioContext = class { async decodeAudioData() { return { length: 3, numberOfChannels: 2, sampleRate: 8000, getChannelData(channel) { return channel ? right : left; } }; } async close() {} };
  try {
    await f.controller.handle({ type: 'import-recording', file: { size: 10, name: 'Full song.wav', async arrayBuffer() { return new ArrayBuffer(10); } } });
    const source = f.controller.state.recordingSources.find(item => item.name === 'Full song'); assert.ok(source); assert.equal(source.channels, 2);
    assert.deepEqual([...f.storage.pcm(source.assetId)], [left[0],right[0],left[1],right[1],left[2],right[2]]); assert.deepEqual(f.project.tracks, tracks);
    assert.equal(f.controller.state.recordingMix.sourceKey, source.key); assert.equal(f.controller.state.view, 'mix');
  } finally { globalThis.AudioContext = original; }
});

test('interrupted performance mastering uses the full saved stereo file beyond its shorter arrangement', async () => {
  const f = await fixture(), performance = f.project.performances[0]; performance.frames = 5; performance.status = 'interrupted'; performance.editableFrames = 3;
  f.controller.updateAudioIntegrity(f.project, await f.storage.listAssets(f.project.id)); f.controller.render();
  const source = f.controller.state.recordingSources.find(item => item.assetId === 'song'); assert.equal(source.frames, 8); assert.equal(source.damaged, false);
  await f.controller.handle({ type: 'open-recording-mix', assetId: 'song' });
  await f.controller.handle({ type: 'set-recording-preview-start', seconds: 7 / 8000 });
  await f.controller.handle({ type: 'preview-recording-master', original: true }); assert.equal(f.controller.state.recordingMix.previewFrames, 1);
  await f.controller.handle({ type: 'export-recording-master' }); assert.equal(f.storage.assets.get(f.controller.downloaded).frames, 8);
});

test('Mix opens saved recordings by default but preserves an explicit layer selection', async () => {
  const f = await fixture(); await f.controller.handle({ type: 'view', view: 'mix' }); assert.equal(f.controller.state.mixMode, 'recordings');
  await f.controller.handle({ type: 'mix-mode', mode: 'layers' }); await f.controller.handle({ type: 'view', view: 'build' }); await f.controller.handle({ type: 'view', view: 'mix' }); assert.equal(f.controller.state.mixMode, 'layers');
});
