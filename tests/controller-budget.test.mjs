import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioController } from '../src/controller.mjs';
import { createProject, createTrack, clone, CaptureMetadataBudget, measureMetadata, MAX_PROJECT_NODES, MAX_PROJECT_BYTES, CAPTURE_RESERVE_NODES, CAPTURE_RESERVE_BYTES } from '../src/project.mjs';

function fixture() {
  const storage = new EventTarget(), ui = new EventTarget(), commands = [], saves = [];
  const engine = { async enableMic() {}, configure() {}, send(type) { commands.push(type); }, arm() { commands.push('arm'); }, finish() { commands.push('finish'); }, stop() { commands.push('stop'); }, cancel() { commands.push('cancel'); } };
  const notifications = [];
  ui.render = () => {}; ui.notify = message => notifications.push(message);
  storage.estimate = async () => ({ quota: 1e9, usage: 0 });
  storage.beginAsset = async () => commands.push('begin-asset');
  storage.finishAsset = async () => { throw new Error('No asset created'); };
  storage.listAssets = async () => []; storage.listProjects = async () => [];
  storage.saveProject = async project => saves.push(clone(project));
  const controller = new StudioController(storage, ui);
  controller.engine = engine; controller.state.project = createProject('Budget test'); controller.state.busy = false;
  controller.ensureAudio = async () => engine;
  controller.scheduleSave = () => {}; controller.keepAwake = async () => {}; controller.releaseWake = async () => {};
  return { controller, commands, notifications, saves };
}

function active(f) {
  const c = f.controller, p = c.state.project;
  c.pending = { id: 'capture-budget', projectId: p.id, kind: 'vocal', assetId: 'raw-budget', masterAssetId: 'master-budget', takeId: 'take-budget', performanceId: 'performance-budget',
    started: true, startFrame: 1000, createdAt: new Date().toISOString(), events: [], track: createTrack({ assetId: 'raw-budget', role: 'lead' }),
    initialState: { tracks: [], master: clone(p.master), input: clone(p.input), inputMix: {}, frame: 1000 } };
  c.state.capture = { kind: 'vocal', status: 'recording' };
  c.updateCaptureIntent(); c.pending.metadataBudget = new CaptureMetadataBudget(p);
  return c.pending;
}

test('rejected automation stops once, persists the first missing boundary and locks edits', async () => {
  const f = fixture(), c = f.controller, pending = active(f);
  pending.metadataBudget.nodes = MAX_PROJECT_NODES - CAPTURE_RESERVE_NODES;
  c.recordEvent({ type: 'mix', frame: 1200, id: 'beat', mix: { volume: .6 } });
  c.recordEvent({ type: 'mix', frame: 1250, id: 'beat', mix: { volume: .5 } });
  assert.deepEqual(f.commands, ['finish']); assert.equal(f.notifications.length, 1);
  assert.equal(pending.arrangementIncomplete, true); assert.equal(pending.arrangementThroughFrame, 1200);
  assert.equal(pending.events.length, 0); assert.equal(c.state.busy, true);
  assert.equal(c.state.project.pendingCapture.arrangementThroughFrame, 1200);
  assert.equal(c.state.project.pendingCapture.arrangementIncomplete, true);
  assert.throws(() => c.assertWritable(), /arrangement limit/);
  await c.handle({ type: 'stop' }); await c.handle({ type: 'cancel' });
  assert.deepEqual(f.commands, ['finish', 'stop', 'cancel']);
});

test('the last accepted boundary event is retained without falsely marking the arrangement incomplete', () => {
  const f = fixture(), c = f.controller, pending = active(f);
  const event = { type: 'mix', frame: 1100, id: 'beat', mix: { volume: .6 } }, cost = measureMetadata(event);
  pending.metadataBudget.nodes = MAX_PROJECT_NODES - CAPTURE_RESERVE_NODES - cost.nodes;
  c.recordEvent(event);
  assert.deepEqual(pending.events, [event]); assert.deepEqual(f.commands, ['finish']);
  assert.equal(pending.arrangementIncomplete, undefined);
  c.updateCaptureIntent();
  assert.deepEqual(c.state.project.pendingCapture.events, [event]);
});

test('capture-start refreshes the budget from the authoritative state and checkpoints count other edits', () => {
  const f = fixture(), c = f.controller, pending = active(f);
  const track = createTrack({ assetId: 'beat-audio', frames: 48000 });
  const initialState = { tracks: [track], master: { volume: .4 }, input: clone(c.state.project.input), inputMix: clone(track.mix), frame: 4000 };
  c.audioEvent('capture-start', { captureId: pending.id, kind: 'vocal', startFrame: 4000, initialState });
  const actual = measureMetadata(c.state.project);
  assert.equal(pending.metadataBudget.nodes, actual.nodes); assert.equal(pending.metadataBudget.bytes, actual.bytes);
  assert.equal(pending.startFrame, 4000); assert.equal(pending.initialState.master.volume, .4);
  c.state.project.notes = Array.from({ length: 125 }, () => 'x'.repeat(100000));
  c.updateCaptureIntent();
  assert.ok(pending.metadataBudget.bytes < MAX_PROJECT_BYTES);
  assert.ok(pending.metadataBudget.bytes > MAX_PROJECT_BYTES - CAPTURE_RESERVE_BYTES);
  assert.deepEqual(f.commands, ['finish']); assert.equal(pending.arrangementIncomplete, undefined);
  c.updateCaptureIntent(); assert.equal(f.notifications.length, 1);
});

test('an oversized checkpoint stops safely without recursively measuring the invalid project', () => {
  const f = fixture(), c = f.controller, pending = active(f);
  c.state.project.notes = Array.from({ length: 130 }, () => 'x'.repeat(100000)); c.state.transportFrame = 7000;
  c.updateCaptureIntent(); c.updateCaptureIntent();
  assert.deepEqual(f.commands, ['finish']); assert.equal(f.notifications.length, 1);
  assert.equal(pending.arrangementIncomplete, true); assert.equal(pending.arrangementThroughFrame, 7000);
});

test('recording is rejected before audio assets or worklet arm when the project lacks metadata reserve', async () => {
  const f = fixture(), c = f.controller;
  c.state.project.notes = Array.from({ length: 125 }, () => 'x'.repeat(100000));
  await assert.rejects(c.startCapture('vocal'), /arrangement memory limit/);
  assert.deepEqual(f.commands, []); assert.equal(c.pending, null); assert.equal(c.state.capture, null);
  assert.equal(c.state.project.pendingCapture, undefined);
});

test('long loop capture keeps current mixer edits without retaining an unused arrangement log', async () => {
  const f = fixture(), c = f.controller, pending = active(f);
  pending.kind = 'loop'; pending.masterAssetId = null;
  const track = createTrack({ assetId: 'existing-loop', frames: 48000 }); c.state.project.tracks.push(track);
  pending.metadataBudget.nodes = MAX_PROJECT_NODES - CAPTURE_RESERVE_NODES;
  await c.handle({ type: 'mix', id: track.id, mix: { volume: .4 } });
  c.audioEvent('command', { command: 'mix', frame: 1300, id: track.id, mix: clone(track.mix) });
  assert.equal(track.mix.volume, .4); assert.equal(pending.events.length, 0);
  assert.deepEqual(f.commands, ['mix']); assert.equal(pending.budgetReached, undefined);
  c.updateCaptureIntent(); assert.deepEqual(c.state.project.pendingCapture.events, []);
});
