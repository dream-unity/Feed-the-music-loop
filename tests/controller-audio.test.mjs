import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { AudioEngine } from '../src/audio/client.mjs';
import { LoopEngine } from '../src/audio/loop-worklet.mjs';
import { createProject, createTrack, clone } from '../src/project.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const energy = audio => audio.reduce((sum, value) => sum + value * value, 0) / audio.length;

/** Real controller, client and audio state machine; only devices/storage are in memory. */
function studio({ failLoopSealAt = null } = {}) {
  const assets = new Map(), pages = new Map();
  const storage = new EventTarget();
  Object.assign(storage, {
    async estimate() { return { usage: 0, quota: 1e9 }; },
    async saveProject(project) { this.saved = clone(project); },
    async listProjects() { return []; },
    async getAsset(id) { return clone(assets.get(id)); },
    async beginAsset(asset) { assets.set(asset.id, { ...clone(asset), frames: 0, checkpointFrames: 0, status: 'recording' }); },
    async finishAsset(id, options) { Object.assign(assets.get(id), options); return clone(assets.get(id)); },
  });
  const ui = new EventTarget(); ui.render = () => {}; ui.notify = () => {};
  const client = new AudioEngine(storage), controller = new StudioController(storage, ui);
  const loop = new LoopEngine({ sampleRate: 8000, pageFrames: 256, post: message => client.onMessage(message) });
  client.node = { port: { postMessage: message => loop.command(message) } };
  client.context = { state: 'running' }; client.enableMic = async () => {};
  controller.engine = client; controller.state.project = createProject('Audio reconciliation', 8000);
  controller.state.sampleRate = 8000; controller.state.busy = false;
  controller.scheduleSave = () => {}; controller.keepAwake = async () => {};
  controller.releaseWake = async () => {}; controller.summarize = async () => [];
  for (const type of ['state', 'meter', 'capture-start', 'capture-end', 'asset-sealed', 'section', 'command', 'error']) {
    client.addEventListener(type, event => controller.audioEvent(type, event.detail));
  }
  loop.command({ type: 'pool', buffers: Array.from({ length: 24 }, () => new ArrayBuffer(256 * 8)) });
  loop.command({ type: 'storage-port', port: { postMessage(message) {
    if (message.type === 'write') {
      const audio = new Float32Array(message.buffer, 0, message.frames * message.channels).slice();
      pages.set(`${message.assetId}:${message.index}`, { buffer: audio.buffer, frames: message.frames, channels: message.channels });
      const asset = assets.get(message.assetId); asset.frames += message.frames; asset.checkpointFrames = asset.frames;
      loop.storageMessage({ type: 'recycle', buffer: structuredClone(message.buffer, { transfer: [message.buffer] }) });
    } else if (message.type === 'end') {
      const asset = assets.get(message.assetId), failed = failLoopSealAt !== null && asset.kind === 'loop';
      const status = failed ? 'interrupted' : message.status, frames = failed ? Math.min(failLoopSealAt, message.frames) : message.frames;
      Object.assign(asset, { status, frames, checkpointFrames: frames });
      loop.storageMessage({ type: 'sealed', assetId: message.assetId, status, frames });
    } else if (message.type === 'read') {
      const page = pages.get(`${message.assetId}:${message.index}`);
      loop.storageMessage(page ? { type: 'page', assetId: message.assetId, index: message.index, ...page, buffer: page.buffer.slice(0) }
        : { type: 'page-missing', assetId: message.assetId, index: message.index, retryable: true });
    }
  } } });
  function run(frames, microphone = () => 0) {
    const output = new Float32Array(frames);
    for (let at = 0; at < frames; at += 73) {
      const size = Math.min(73, frames - at), input = Float32Array.from({ length: size }, (_, index) => microphone(at + index));
      loop.process(input, output.subarray(at, at + size), new Float32Array(size));
    }
    return output;
  }
  function addExisting() {
    const track = createTrack({ assetId: 'existing-audio', frames: 1003, mix: { volume: .8, pan: 0, low: 0, mid: 0, high: 0, highpass: 20, compression: 0, reverb: 0, delay: 0 } });
    controller.state.project.tracks.push(track); controller.state.project.baseFrames = track.frames;
    for (let at = 0; at < track.frames; at += 256) {
      const audio = Float32Array.from({ length: Math.min(256, track.frames - at) }, (_, index) => .2 * Math.sin((at + index) * .17));
      pages.set(`${track.assetId}:${at / 256}`, { buffer: audio.buffer, frames: audio.length, channels: 1 });
    }
    client.configure(controller.state.project); client.syncTracks([track]); client.play(); run(1003);
    return track;
  }
  return { controller, client, loop, assets, run, addExisting };
}

test('recorded loop Undo removes the audible loop, Redo restores it, and readiness never waits for a lost acknowledgement', async () => {
  const h = studio();
  await h.controller.startCapture('loop', 0);
  h.run(1003, index => .2 * Math.sin(index * .17));
  await h.controller.handle({ type: 'finish' }); h.run(1);
  for (let attempts = 0; h.controller.pending && attempts < 20; attempts++) await turn();
  assert.equal(h.controller.pending, null);
  const track = h.controller.state.project.tracks[0]; assert.ok(track);
  const runningTrack = h.loop.tracks.get(track.id), dsp = runningTrack.dsp, cache = runningTrack.cache;
  await h.client.waitUntilReady(20);
  assert.equal(h.loop.tracks.get(track.id).dsp, dsp); assert.equal(h.loop.tracks.get(track.id).cache, cache);
  assert.ok(energy(h.run(1003)) > 1e-4);
  await h.controller.handle({ type: 'undo' });
  assert.equal(h.controller.state.project.tracks.length, 0); assert.equal(h.loop.tracks.size, 0);
  h.run(32000); assert.ok(energy(h.run(1003)) < 1e-12, 'Only a decaying effects tail may remain after Undo');
  await h.controller.handle({ type: 'redo' }); await h.client.waitUntilReady(20);
  assert.equal(h.loop.tracks.size, 1); assert.ok(energy(h.run(1003)) > 1e-4);
  assert.ok(h.assets.has(track.assetId), 'Undo never deletes original audio');
});

for (const action of [
  { type: 'mute' }, { type: 'solo' }, { type: 'mix', mix: { volume: .1, pan: -.7, reverb: .15 } },
  { type: 'nudge', frames: 151 }, { type: 'role', role: 'texture' }, { type: 'remove-track' },
]) {
  test(`Undo and Redo reconcile the real audio graph after ${action.type}`, async () => {
    const h = studio(), original = clone(h.addExisting()), initialFrame = h.loop.frame;
    await h.controller.handle({ ...action, id: original.id });
    const changed = clone(h.controller.state.project.tracks);
    await h.controller.handle({ type: 'undo' }); await h.client.waitUntilReady(20);
    const restored = h.loop.tracks.get(original.id).track;
    for (const key of ['mix', 'muted', 'solo', 'offsetFrames', 'assetId']) assert.deepEqual(restored[key], original[key], key);
    assert.equal(h.loop.frame, initialFrame, 'Reconciliation cannot restart the musical clock');
    assert.ok(energy(h.run(1003)) > 1e-4, 'Restored loop must actually be audible');
    await h.controller.handle({ type: 'redo' });
    if (!changed.length) assert.equal(h.loop.tracks.size, 0);
    else for (const key of ['mix', 'muted', 'solo', 'offsetFrames']) assert.deepEqual(h.loop.tracks.get(original.id).track[key], changed[0][key], key);
  });
}

test('Undo restores the audible mix after a section changes it on a cycle boundary', async () => {
  const h = studio(), original = clone(h.addExisting());
  h.controller.state.project.sections.push({ id: 'silent', name: 'Silent section', createdAt: new Date().toISOString(), tracks: { [original.id]: { muted: true, solo: false, mix: { ...original.mix, volume: .1 } } } });
  await h.controller.handle({ type: 'launch-section', id: 'silent' }); h.run(1004);
  assert.equal(h.loop.tracks.get(original.id).track.muted, true);
  await h.controller.handle({ type: 'undo' });
  assert.equal(h.loop.tracks.get(original.id).track.muted, false);
  assert.deepEqual(h.loop.tracks.get(original.id).track.mix, original.mix);
  assert.ok(energy(h.run(1003)) > 1e-4);
});

for (const action of ['undo', 'delete-section']) {
  test(`${action} cancels a queued section before it can change a later audio cycle`, async () => {
    const h = studio(), original = clone(h.addExisting());
    h.controller.state.project.sections.push({ id: 'queued', name: 'Queued silence', createdAt: new Date().toISOString(), tracks: { [original.id]: { muted: true, solo: false, mix: original.mix } } });
    await h.controller.handle({ type: 'launch-section', id: 'queued' });
    assert.equal(h.loop.pendingSection.section.id, 'queued');
    await h.controller.handle({ type: action, id: 'queued' });
    h.run(3009);
    assert.equal(h.loop.pendingSection, null); assert.equal(h.controller.state.queuedSectionId, null);
    assert.equal(h.loop.tracks.get(original.id).track.muted, false);
    assert.ok(energy(h.run(1003)) > 1e-4);
  });
}

for (const existing of [false, true]) {
  test(`a failed final loop seal cannot enter the next vocal backing snapshot (${existing ? 'existing backing' : 'first loop'})`, async () => {
    const h = studio({ failLoopSealAt: 256 });
    const original = existing ? clone(h.addExisting()) : null;
    await h.controller.startCapture('loop', 0);
    const failedTrackId = h.controller.pending.track.id, failedAssetId = h.controller.pending.assetId;
    h.run(1003, index => .2 * Math.sin(index * .17));
    await h.controller.handle({ type: 'finish' }); h.run(1);
    for (let attempts = 0; h.controller.pending && attempts < 20; attempts++) await turn();
    assert.equal(h.controller.pending, null); assert.equal(h.loop.tracks.has(failedTrackId), false);
    assert.equal(h.controller.state.project.tracks.length, existing ? 1 : 0);
    assert.equal(h.loop.baseFrames, existing ? original.frames : 0);
    assert.equal(h.assets.get(failedAssetId).frames, 256, 'The verified prefix remains available for recovery');
    assert.ok(h.controller.state.recovered.some(asset => asset.id === failedAssetId));
    await h.controller.startCapture('vocal', 0); h.run(2100);
    assert.equal(h.controller.pending.started, true);
    assert.deepEqual(h.controller.pending.initialState.tracks.map(track => track.id), original ? [original.id] : []);
    await h.controller.handle({ type: 'finish' }); h.run(1);
    for (let attempts = 0; h.controller.pending && attempts < 20; attempts++) await turn();
    assert.equal(h.controller.state.project.performances.length, 1);
    assert.equal(h.controller.pending, null);
  });
}

test('controller Stop preserves the compensated vocal window while every transport acknowledgement stays at zero', async () => {
  const h = studio(); h.addExisting();
  h.controller.state.project.input.compensationMs = 20;
  await h.controller.startCapture('vocal', 0);
  h.run(633, index => .2 * Math.sin(index * .21));
  const pending = h.controller.pending, startFrame = pending.startFrame;
  assert.equal(h.loop.frame - startFrame, 633);
  await h.controller.handle({ type: 'stop' });
  assert.equal(h.loop.frame, 0); assert.equal(h.controller.state.transportFrame, 0);
  assert.equal(h.controller.state.capture.status, 'finishing');
  await assert.rejects(h.controller.handle({ type: 'play' }), /Finish saving/);
  assert.equal(energy(h.run(161, index => .2 * Math.sin(index * .21))), 0);
  for (let attempts = 0; h.controller.pending && attempts < 20; attempts++) await turn();
  assert.equal(h.controller.pending, null); assert.equal(h.loop.frame, 0); assert.equal(h.controller.state.transportFrame, 0);
  const performance = h.controller.state.project.performances[0];
  assert.equal(performance.startFrame, startFrame); assert.equal(performance.frames, 633);
  assert.equal(h.assets.get(performance.masterAssetId).frames, 633);
  assert.equal(h.controller.state.project.takes[0].frames, 633);
  assert.equal(h.controller.state.playing, false);
});

test('controller Pause resumes the same audio phase while Stop aligns loop starts without altering saved timing', async () => {
  const h = studio(), track = h.addExisting();
  await h.controller.handle({ type: 'nudge', id: track.id, frames: 319 });
  const authoredOffset = track.offsetFrames, atPause = h.loop.frame;
  await h.controller.handle({ type: 'pause' });
  assert.equal(energy(h.run(357)), 0); assert.equal(h.loop.frame, atPause);
  await h.controller.handle({ type: 'play' });
  assert.ok(energy(h.run(219)) > 1e-4); assert.equal(h.loop.frame, atPause + 219);
  await h.controller.handle({ type: 'stop' });
  assert.equal(h.loop.frame, 0); assert.equal(h.controller.state.transportFrame, 0);
  assert.equal(h.loop.playbackOffset(h.loop.tracks.get(track.id)), 0);
  assert.equal(track.offsetFrames, authoredOffset);
  await h.controller.handle({ type: 'play' });
  assert.ok(energy(h.run(219)) > 1e-4); assert.equal(h.loop.frame, 219);
  assert.equal(h.controller.currentPlaybackProject().tracks[0].offsetFrames, 0);
});
