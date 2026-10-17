import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { createProject, createTrack, clone, PAGE_FRAMES } from '../src/project.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Storage extends EventTarget {
  constructor() { super(); this.assets = new Map(); this.pages = new Map(); this.projects = new Map(); this.saved = []; this.deleted = []; }
  async getAsset(id) { await this.readHook?.(id); const asset = this.assets.get(id); if (!asset) throw new Error('Missing source'); return clone(asset); }
  async beginAsset(asset) { this.assets.set(asset.id, { ...clone(asset), frames: 0, status: 'recording', pageFrames: PAGE_FRAMES }); }
  async putPage(id, index, buffer, frames, channels) { await this.writeHook?.(id); this.pages.set(`${id}:${index}`, { index, frames, channels, buffer: buffer.slice(0) }); this.assets.get(id).frames += frames; }
  async readPage(id, index) { const page = this.pages.get(`${id}:${index}`); return page ? { ...page, buffer: page.buffer.slice(0) } : { missing: true }; }
  async finishAsset(id, options = {}) { const asset = this.assets.get(id); Object.assign(asset, { ...options, status: options.status || 'complete' }); return clone(asset); }
  async deleteAsset(id) { this.deleted.push(id); this.assets.delete(id); for (const key of this.pages.keys()) if (key.startsWith(`${id}:`)) this.pages.delete(key); }
  async saveProject(project) { await this.saveHook?.(project); this.projects.set(project.id, clone(project)); this.saved.push(clone(project)); }
  async loadProject(id) { await this.loadHook?.(id); return clone(this.projects.get(id)); }
  async getAssetRange(id, { startFrame, frames }) { const asset = this.assets.get(id), pcm = this.pcm(id); return new Blob([pcm.slice(startFrame * asset.channels, (startFrame + frames) * asset.channels).buffer]); }
  pcm(id) { return Float32Array.from([...this.pages.entries()].filter(([key]) => key.startsWith(`${id}:`)).sort((a, b) => a[1].index - b[1].index).flatMap(([, page]) => [...new Float32Array(page.buffer)])); }
  async listAssets(projectId) { return [...this.assets.values()].filter(asset => asset.projectId === projectId).map(clone); }
  async listProjects() { return [...this.projects.values()].map(clone); }
  async recover() {}
  async releaseProject() {}
}
class UI extends EventTarget {
  constructor() { super(); this.notifications = []; }
  render() {}
  notify(message) { this.notifications.push(message); }
  showTrackEditor(model) { this.editor = model; }
  updateTrackEditor(model) { this.editor = model; }
  closeTrackEditor() { this.editor = null; }
}
async function fixture({ channels = 1, samples = [.1, .2, .3, .4, .5, .6, .7, .8] } = {}) {
  const storage = new Storage(), ui = new UI(), controller = new StudioController(storage, ui);
  const project = createProject('Editor', 8000), track = createTrack({ assetId: 'audio-original', name: 'Original', frames: samples.length / channels, channels, offsetFrames: -2 });
  project.tracks.push(track); project.baseFrames = track.frames;
  controller.state.project = project; controller.state.busy = false; controller.state.sampleRate = 8000;
  const commands = []; controller.engine = { stop() { commands.push('stop'); }, send(type) { commands.push(type); }, configure() {}, syncTracks(tracks) { commands.push(tracks.map(item => item.assetId)); } };
  controller.releaseWake = async () => {}; controller.scheduleSave = () => {};
  const asset = { id: track.assetId, projectId: project.id, name: track.name, channels, sampleRate: 8000, frames: track.frames, status: 'complete', pageFrames: PAGE_FRAMES, kind: 'import' };
  storage.assets.set(asset.id, asset); storage.pages.set(`${asset.id}:0`, { index: 0, frames: track.frames, channels, buffer: Float32Array.from(samples).buffer });
  await storage.saveProject(project);
  return { storage, ui, controller, project, track, commands, original: storage.pcm(asset.id) };
}
const pcmEqual = (actual, expected) => assert.deepEqual([...actual], [...Float32Array.from(expected)]);

test('trim saves exact selected PCM, stable track identity and grid, while preserving original and Undo', async () => {
  const f = await fixture(); f.project.sections = [{ id: 'section-one', name: 'First', tracks: { [f.track.id]: { muted: true, solo: false, mix: clone(f.track.mix) } } }];
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await f.controller.handle({ type: 'editor-select', startFrame: 2, endFrame: 6 });
  await f.controller.handle({ type: 'editor-trim' });
  const edited = f.controller.state.project.tracks[0];
  assert.equal(edited.id, f.track.id); assert.notEqual(edited.assetId, f.track.assetId); assert.equal(edited.frames, 4); assert.equal(edited.offsetFrames, 2);
  assert.equal(f.controller.state.project.baseFrames, 8); assert.deepEqual(f.controller.state.project.sections, f.project.sections);
  assert.deepEqual(edited.mix, f.track.mix); pcmEqual(f.storage.pcm(edited.assetId), [.3, .4, .5, .6]); pcmEqual(f.storage.pcm(f.track.assetId), f.original);
  assert.equal((await f.storage.loadProject(f.project.id)).tracks[0].assetId, edited.assetId);
  assert.equal(f.controller.history.past.length, 1);
  await f.controller.handle({ type: 'undo' }); assert.equal(f.controller.state.project.tracks[0].assetId, f.track.assetId); assert.equal(f.controller.state.trackEditor.frames, 8);
  await f.controller.handle({ type: 'redo' }); assert.equal(f.controller.state.project.tracks[0].assetId, edited.assetId); assert.equal(f.controller.state.trackEditor.frames, 4);
  assert.equal(f.storage.assets.size, 2);
});

test('resize repeats samples or appends true silence, and supports shortening', async () => {
  for (const extension of ['repeat', 'silence']) {
    const f = await fixture({ samples: [.2, .4, .6] });
    await f.controller.handle({ type: 'edit-track', id: f.track.id });
    await f.controller.handle({ type: 'editor-resize', frames: 8, extension });
    pcmEqual(f.storage.pcm(f.controller.state.project.tracks[0].assetId), extension === 'repeat' ? [.2, .4, .6, .2, .4, .6, .2, .4] : [.2, .4, .6, 0, 0, 0, 0, 0]);
    await f.controller.handle({ type: 'editor-resize', frames: 2, extension });
    pcmEqual(f.storage.pcm(f.controller.state.project.tracks[0].assetId), [.2, .4]);
    assert.equal(f.controller.state.project.baseFrames, 3);
  }
});

test('clipboard freezes selected source across edits and closes, then pastes into the same or another track', async () => {
  const f = await fixture();
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await f.controller.handle({ type: 'editor-select', startFrame: 1, endFrame: 3 });
  await f.controller.handle({ type: 'editor-copy' }); const clipboard = f.controller.audioClipboard;
  assert.ok(Object.isFrozen(clipboard));
  await f.controller.handle({ type: 'editor-trim' });
  await f.controller.handle({ type: 'editor-cursor', frame: 1 });
  await f.controller.handle({ type: 'editor-paste', mode: 'insert' });
  pcmEqual(f.storage.pcm(f.controller.state.project.tracks[0].assetId), [.2, .2, .3, .3]);
  await f.controller.handle({ type: 'editor-close' }); assert.equal(f.controller.audioClipboard, clipboard);
  const other = createTrack({ ...f.track, id: 'track-destination', name: 'Destination' });
  f.controller.state.project.tracks.push(other);
  await f.controller.handle({ type: 'edit-track', id: other.id });
  await f.controller.handle({ type: 'editor-select', startFrame: 3, endFrame: 7 });
  await f.controller.handle({ type: 'editor-paste', mode: 'replace' });
  pcmEqual(f.storage.pcm(f.controller.state.project.tracks[1].assetId), [.1, .2, .3, .2, .3, .8]);
  assert.equal(f.controller.audioClipboard.assetId, f.track.assetId);
});

test('copy uses the selection at the click even if numeric selection changes while storage is read', async () => {
  const f = await fixture(), gate = deferred();
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await f.controller.handle({ type: 'editor-select', startFrame: 1, endFrame: 3 });
  f.storage.readHook = () => gate.promise;
  const copying = f.controller.handle({ type: 'editor-copy' });
  await f.controller.handle({ type: 'editor-select', startFrame: 4, endFrame: 8 });
  gate.resolve(); await copying;
  assert.equal(f.controller.audioClipboard.startFrame, 1); assert.equal(f.controller.audioClipboard.endFrame, 3);
});

test('a slower earlier copy cannot replace a newer copied selection', async () => {
  const f = await fixture(), gates = [deferred(), deferred()]; let reads = 0;
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await new Promise(resolve => setImmediate(resolve));
  f.storage.readHook = () => gates[reads++].promise;
  await f.controller.handle({ type: 'editor-select', startFrame: 1, endFrame: 3 }); const first = f.controller.handle({ type: 'editor-copy' });
  await f.controller.handle({ type: 'editor-select', startFrame: 4, endFrame: 8 }); const second = f.controller.handle({ type: 'editor-copy' });
  gates[1].resolve(); await second; gates[0].resolve(); await first;
  assert.equal(f.controller.audioClipboard.startFrame, 4); assert.equal(f.controller.audioClipboard.endFrame, 8);
});

test('only selected source range is playable in preview and closing revokes its URL', async () => {
  const f = await fixture();
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await f.controller.handle({ type: 'editor-select', startFrame: 3, endFrame: 5 });
  await f.controller.handle({ type: 'editor-preview' });
  const url = f.controller.state.trackEditor.previewUrl, bytes = await (await fetch(url)).arrayBuffer();
  pcmEqual(new Float32Array(bytes.slice(58)), [.4, .5]); assert.equal(bytes.byteLength, 66);
  await f.controller.handle({ type: 'editor-close' }); assert.equal(f.controller.state.trackEditor, null); assert.equal(f.controller.urls.has(url), false);
  await assert.rejects(fetch(url)); assert.equal(f.storage.assets.size, 1);
});

test('failed metadata save keeps original/history unchanged and cleans unreferenced output', async () => {
  const f = await fixture(); f.storage.saveHook = () => { throw new Error('Quota exceeded'); };
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await f.controller.handle({ type: 'editor-select', startFrame: 1, endFrame: 4 });
  await assert.rejects(f.controller.handle({ type: 'editor-trim' }), /Quota exceeded/);
  assert.equal(f.controller.state.project, f.project); assert.equal(f.controller.history.past.length, 0); assert.equal(f.storage.assets.size, 1);
  assert.equal(f.storage.deleted.length, 1); assert.equal(f.controller.state.busy, false); pcmEqual(f.storage.pcm(f.track.assetId), f.original);
  f.storage.saveHook = null;
  await f.controller.handle({ type: 'editor-trim' }); assert.equal(f.controller.state.project.tracks[0].frames, 3);
});

test('lost save acknowledgement never deletes an output already attached durably', async () => {
  const f = await fixture(); f.storage.saveHook = project => { f.storage.projects.set(project.id, clone(project)); throw new Error('Acknowledgement lost'); };
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await f.controller.handle({ type: 'editor-resize', frames: 4, extension: 'silence' });
  const edited = f.controller.state.project.tracks[0];
  assert.notEqual(edited.assetId, f.track.assetId); assert.ok(f.storage.assets.has(edited.assetId)); assert.equal(f.storage.deleted.length, 0);
  assert.equal((await f.storage.loadProject(f.project.id)).tracks[0].assetId, edited.assetId);
  f.storage.saveHook = null;
  await f.controller.handle({ type: 'editor-resize', frames: 3, extension: 'silence' }); assert.equal(f.controller.state.project.tracks[0].frames, 3);
});

test('ambiguous save failure retains completed PCM for recovery and does not mutate live history', async () => {
  const f = await fixture(); f.storage.saveHook = () => { throw new Error('Worker disconnected'); }; f.storage.loadHook = () => { throw new Error('Worker disconnected'); };
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  await assert.rejects(f.controller.handle({ type: 'editor-resize', frames: 4, extension: 'silence' }), /Worker disconnected/);
  assert.equal(f.storage.assets.size, 2); assert.equal(f.storage.deleted.length, 0); assert.equal(f.controller.history.past.length, 0); assert.equal(f.controller.state.project, f.project);
  assert.equal(f.controller.state.readonly, true); await assert.rejects(f.controller.handle({ type: 'mute', id: f.track.id }), /could not be verified/);
});

test('closing a slow render cancels the new asset and leaves original intact', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.storage.writeHook = async () => { entered.resolve(); await gate.promise; };
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  const editing = f.controller.handle({ type: 'editor-resize', frames: 16, extension: 'repeat' }); await entered.promise;
  await assert.rejects(f.controller.handle({ type: 'mute', id: f.track.id }), /Wait for the audio edit/);
  await assert.rejects(f.controller.handle({ type: 'undo' }), /Wait for the audio edit/);
  await assert.rejects(f.controller.openProject(), /Wait for the audio edit/);
  await f.controller.handle({ type: 'editor-close' }); gate.resolve(); await editing;
  assert.equal(f.controller.state.project, f.project); assert.equal(f.controller.history.past.length, 0); assert.equal(f.storage.assets.size, 1); assert.equal(f.controller.state.busy, false);
});

test('closing after atomic metadata commit starts allows it to finish safely', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.storage.saveHook = async () => { entered.resolve(); await gate.promise; };
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  const editing = f.controller.handle({ type: 'editor-resize', frames: 3, extension: 'silence' }); await entered.promise;
  assert.equal(f.controller.trackEditOperation.committing, true);
  await f.controller.handle({ type: 'editor-close' }); gate.resolve(); await editing;
  assert.equal(f.controller.state.trackEditor, null); assert.equal(f.controller.state.project.tracks[0].frames, 3); assert.equal(f.storage.assets.size, 2); assert.equal(f.controller.history.past.length, 1);
});

test('queued section acknowledgement cannot mutate a rendering edit snapshot', async () => {
  const f = await fixture(), entered = deferred(), gate = deferred();
  f.storage.writeHook = async () => { entered.resolve(); await gate.promise; };
  await f.controller.handle({ type: 'edit-track', id: f.track.id });
  const editing = f.controller.handle({ type: 'editor-resize', frames: 3, extension: 'silence' }); await entered.promise;
  f.controller.audioEvent('section', { section: { id: 'late-section', tracks: { [f.track.id]: { muted: true, solo: false, mix: f.track.mix } } } });
  gate.resolve(); await editing;
  assert.equal(f.controller.state.project.tracks[0].muted, false); assert.equal(f.controller.state.activeSectionId, null);
});

test('recording, readonly and corrupt source sessions refuse audio editing', async () => {
  for (const state of ['capture', 'readonly', 'corrupt']) {
    const f = await fixture();
    if (state === 'capture') f.controller.state.capture = { status: 'recording' };
    if (state === 'readonly') f.controller.state.readonly = true;
    if (state === 'corrupt') f.controller.state.damagedAudio = [{ assetId: f.track.assetId, name: 'Original', message: 'Audio missing' }];
    await assert.rejects(f.controller.handle({ type: 'edit-track', id: f.track.id }));
    assert.equal(f.storage.assets.size, 1); assert.equal(f.controller.state.trackEditor, null);
  }
});

test('deleted clipboard source cannot overwrite a destination', async () => {
  const f = await fixture();
  await f.controller.handle({ type: 'edit-track', id: f.track.id }); await f.controller.handle({ type: 'editor-copy' });
  await f.controller.handle({ type: 'editor-resize', frames: 4, extension: 'silence' });
  const edited = f.controller.state.project.tracks[0].assetId;
  await f.storage.deleteAsset(f.track.assetId);
  await assert.rejects(f.controller.handle({ type: 'editor-paste', mode: 'insert' }), /Missing source/);
  assert.equal(f.controller.state.project.tracks[0].assetId, edited); assert.equal(f.controller.history.past.length, 1); assert.equal(f.storage.assets.size, 1);
});
