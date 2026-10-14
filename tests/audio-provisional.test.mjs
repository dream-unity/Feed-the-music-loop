import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine } from '../src/audio/loop-worklet.mjs';

function fixture() {
  const events = [], ends = [], pages = new Map();
  const engine = new LoopEngine({ sampleRate: 8000, pageFrames: 256, post: message => events.push(message) });
  engine.command({ type: 'storage-port', port: { postMessage(message) {
    if (message.type === 'write') {
      const buffer = new Float32Array(message.buffer, 0, message.frames * message.channels).slice().buffer;
      pages.set(`${message.assetId}:${message.index}`, { buffer, frames: message.frames, channels: message.channels });
      engine.storageMessage({ type: 'recycle', buffer: structuredClone(message.buffer, { transfer: [message.buffer] }) });
    } else if (message.type === 'end') ends.push(message);
    else if (message.type === 'read') {
      const page = pages.get(`${message.assetId}:${message.index}`);
      if (page) engine.storageMessage({ type: 'page', assetId: message.assetId, index: message.index, ...page, buffer: page.buffer.slice(0) });
    }
  } } });
  engine.command({ type: 'pool', buffers: Array.from({ length: 8 }, () => new ArrayBuffer(256 * 8)) });
  const arm = (id, lengthFrames, kind = 'loop') => engine.command({ type: 'arm', capture: { id, assetId: `${id}-raw`, ...(kind === 'vocal' ? { masterAssetId: `${id}-master` } : {}), kind, lengthFrames,
    track: { id: `${id}-track`, mix: { volume: .7, reverb: 0, delay: 0 } } } });
  const run = frames => { for (let done = 0; done < frames; done += 128) { const count = Math.min(128, frames - done); engine.process(new Float32Array(count).fill(.1), new Float32Array(count), new Float32Array(count)); } };
  const seal = (id, extra = {}) => { const end = ends.find(message => message.assetId === `${id}-raw`); assert.ok(end); engine.storageMessage({ type: 'sealed', assetId: end.assetId, frames: end.frames, status: 'complete', finalized: true, ...extra }); };
  return { engine, events, arm, run, seal };
}

for (const failure of ['storage-error', 'interrupted-seal', 'wrong-length-seal', 'unfinalized-seal']) {
  test(`late ${failure} removes the uncommitted first loop before the next vocal snapshot`, () => {
    const f = fixture(); f.arm('first', 600); f.run(601);
    assert.equal(f.engine.capture, null); assert.equal(f.engine.baseFrames, 600);
    assert.equal(f.engine.tracks.get('first-track').track.frames, 600);
    assert.equal(f.engine.provisionalLoops.size, 1);
    if (failure === 'storage-error') f.engine.storageMessage({ type: 'storage-error', assetId: 'first-raw', message: 'Quota exhausted' });
    else f.seal('first', failure === 'interrupted-seal' ? { status: 'interrupted', frames: 256 } : failure === 'wrong-length-seal' ? { frames: 256 } : { finalized: false });
    assert.equal(f.engine.tracks.size, 0); assert.equal(f.engine.baseFrames, 0);
    assert.equal(f.engine.provisionalLoops.size, 0); assert.equal(f.engine.caches.has('first-raw'), false);
    const invalidated = f.events.find(event => event.type === 'loop-invalidated');
    assert.equal(invalidated.id, 'first-track'); assert.equal(invalidated.captureId, 'first');
    f.arm('voice', 0, 'vocal'); f.run(1);
    const start = f.events.filter(event => event.type === 'capture-start').at(-1);
    assert.deepEqual(start.initialState.tracks, []); assert.equal(start.initialState.baseFrames, 0);
  });
}

test('a failed later loop preserves the committed backing, its DSP, base and phase', () => {
  const f = fixture(); f.arm('good', 600); f.run(601); f.seal('good');
  const backing = f.engine.tracks.get('good-track');
  assert.equal(f.engine.provisionalLoops.size, 0);
  f.arm('bad', 800); f.run(801); const frame = f.engine.frame;
  f.seal('bad', { status: 'interrupted', frames: 512 });
  assert.deepEqual([...f.engine.tracks.keys()], ['good-track']); assert.equal(f.engine.tracks.get('good-track'), backing);
  assert.equal(f.engine.baseFrames, 600); assert.equal(f.engine.frame, frame); assert.equal(f.engine.playing, true);
  assert.equal(f.engine.caches.has('bad-raw'), false); assert.equal(f.engine.caches.has('good-raw'), true);
  f.arm('voice', 0, 'vocal'); f.run(1);
  assert.deepEqual(f.events.filter(event => event.type === 'capture-start').at(-1).initialState.tracks.map(track => track.id), ['good-track']);
});

test('a valid seal commits the loop without restarting audio and unrelated later failures cannot delete it', () => {
  const f = fixture(); f.arm('good', 600); f.run(601);
  const backing = f.engine.tracks.get('good-track'), frame = f.engine.frame;
  f.seal('good'); assert.equal(f.engine.provisionalLoops.size, 0);
  assert.equal(f.engine.tracks.get('good-track'), backing); assert.equal(f.engine.frame, frame);
  f.engine.storageMessage({ type: 'storage-error', assetId: 'other-raw', message: 'Unrelated failure' });
  f.engine.storageMessage({ type: 'storage-error', assetId: 'good-raw', message: 'Later read failure' });
  assert.equal(f.engine.tracks.get('good-track'), backing);
  assert.equal(f.events.some(event => event.type === 'loop-invalidated'), false);
});

test('late failure cannot delete a replacement asset with the provisional track id', () => {
  const f = fixture(); f.arm('old', 600); f.run(601);
  f.engine.command({ type: 'track', track: { id: 'old-track', assetId: 'replacement', frames: 600, channels: 1, mix: {} } });
  f.engine.storageMessage({ type: 'storage-error', assetId: 'old-raw', message: 'Old write failed' });
  assert.equal(f.engine.tracks.get('old-track').track.assetId, 'replacement');
  assert.equal(f.engine.provisionalLoops.size, 0);
});

test('cancel, explicit removal and project clear cannot retain provisional loop markers', () => {
  const f = fixture(); f.engine.command({ type: 'configure', compensationFrames: 200 });
  f.arm('cancelled', 600); f.run(601); assert.equal(f.engine.provisionalLoops.size, 1);
  f.engine.command({ type: 'cancel' }); assert.equal(f.engine.provisionalLoops.size, 0);
  assert.equal(f.engine.caches.has('cancelled-raw'), false);
  f.engine.command({ type: 'configure', compensationFrames: 0 });
  f.arm('removed', 600); f.run(601); f.engine.command({ type: 'remove-track', id: 'removed-track' });
  assert.equal(f.engine.provisionalLoops.size, 0); assert.equal(f.engine.caches.has('removed-raw'), false);
  f.arm('cleared', 600); f.run(601); f.engine.command({ type: 'clear' });
  assert.equal(f.engine.provisionalLoops.size, 0); assert.equal(f.engine.caches.size, 0);
});

test('master and input changes preserve the first loop grid throughout compensation drain and durable sealing', () => {
  const f = fixture(); f.engine.command({ type: 'configure', compensationFrames: 200 });
  f.arm('first', 600); f.run(601);
  const track = f.engine.tracks.get('first-track'), frame = f.engine.frame;
  assert.equal(f.engine.capture.status, 'finishing'); assert.equal(f.engine.baseFrames, 600);
  f.engine.command({ type: 'configure', baseFrames: 0, masterVolume: .2, inputGain: .5 });
  assert.equal(f.engine.baseFrames, 600); assert.equal(f.engine.frame, frame);
  assert.equal(f.engine.masterVolume, .2); assert.equal(f.engine.inputGain, .5);
  assert.equal(f.engine.tracks.get('first-track'), track);
  f.run(200); assert.equal(f.engine.capture, null); assert.equal(f.engine.provisionalLoops.size, 1);
  f.engine.command({ type: 'configure', baseFrames: 0, masterVolume: .3, inputGain: .6 });
  assert.equal(f.engine.baseFrames, 600); assert.equal(f.engine.frame, frame + 200);
  assert.equal(f.engine.tracks.get('first-track'), track);
  f.seal('first'); f.engine.command({ type: 'configure', baseFrames: 600 });
  f.run(600); assert.equal(f.engine.frame, frame + 800); assert.equal(track.track.offsetFrames, 0);
  assert.equal(f.events.some(event => event.type === 'underrun'), false);
  f.engine.command({ type: 'configure', baseFrames: 0 });
  assert.equal(f.engine.baseFrames, 0, 'a sealed loop no longer overrides explicit project configuration');
});

test('failed or cancelled provisional loops release their protection of an old project base', () => {
  for (const action of ['failure', 'cancel']) {
    const f = fixture(); f.engine.command({ type: 'configure', compensationFrames: 200 });
    f.arm('first', 600); f.run(601);
    f.engine.command({ type: 'configure', baseFrames: 0 }); assert.equal(f.engine.baseFrames, 600);
    if (action === 'failure') f.engine.storageMessage({ type: 'storage-error', assetId: 'first-raw', message: 'Storage full' });
    else f.engine.command({ type: 'cancel' });
    f.engine.command({ type: 'configure', baseFrames: 0 });
    assert.equal(f.engine.baseFrames, 0); assert.equal(f.engine.provisionalLoops.size, 0);
  }
});
