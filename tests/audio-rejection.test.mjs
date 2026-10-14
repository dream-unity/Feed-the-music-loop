import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopEngine } from '../src/audio/loop-worklet.mjs';
import { AudioEngine } from '../src/audio/client.mjs';

function fixture() {
  const events = [], writes = [];
  const engine = new LoopEngine({ sampleRate: 8000, pageFrames: 256, post: message => events.push(message) });
  const port = { rejectReads: false, postMessage(message) {
    if (message.type === 'read' && this.rejectReads) throw new Error('Storage port unavailable');
    if (message.type === 'write') writes.push(message);
  } };
  engine.command({ type: 'storage-port', port });
  engine.command({ type: 'pool', buffers: Array.from({ length: 16 }, () => new ArrayBuffer(256 * 8)) });
  const capture = (id, extra = {}) => ({ id, assetId: `${id}-raw`, kind: 'loop', track: { id: `${id}-track`, mix: { volume: .6 } }, ...extra });
  const run = frames => engine.process(new Float32Array(frames).fill(.1), new Float32Array(frames), new Float32Array(frames));
  return { engine, events, writes, port, capture, run };
}

test('short compensated arm emits a correlated refusal without a live capture or audio writes', () => {
  const f = fixture();
  f.engine.command({ type: 'configure', baseFrames: 4000, compensationFrames: 8000 });
  f.engine.command({ type: 'arm', requestId: 17, capture: f.capture('short', { lengthFrames: 4000, quantized: true }) });
  const rejected = f.events.find(event => event.type === 'capture-rejected');
  assert.equal(rejected.captureId, 'short'); assert.equal(rejected.requestId, 17);
  assert.equal(rejected.activeCaptureId, null); assert.match(rejected.message, /longer than/);
  assert.equal(f.engine.capture, null); assert.equal(f.events.some(event => event.type === 'error'), false);
  f.run(512); assert.equal(f.writes.length, 0);
  f.engine.command({ type: 'arm', requestId: 18, capture: f.capture('valid', { lengthFrames: 10000 }) });
  assert.equal(f.engine.capture.id, 'valid');
});

test('a rejected concurrent arm cannot cancel or seal the unrelated active capture', () => {
  const f = fixture(); f.engine.command({ type: 'arm', capture: f.capture('active') }); f.run(100);
  const before = f.engine.capture;
  f.engine.command({ type: 'arm', requestId: 22, capture: f.capture('later') });
  assert.equal(f.engine.capture, before);
  const rejected = f.events.find(event => event.type === 'capture-rejected');
  assert.equal(rejected.captureId, 'later'); assert.equal(rejected.activeCaptureId, 'active');
  f.run(300); assert.equal(f.engine.capture.raw.frames, 400);
  assert.ok(f.writes.length); assert.ok(f.writes.every(write => write.assetId === 'active-raw'));
});

test('a late arm preparation failure rolls back the new capture before reporting its rejection', () => {
  const f = fixture();
  f.engine.command({ type: 'track', track: { id: 'backing', assetId: 'backing-audio', frames: 4000, channels: 1, offsetFrames: 0, mix: {} } });
  f.engine.tracks.get('backing').cache.pending.clear(); f.engine.frame = 1234;
  const beforeMix = { ...f.engine.inputMixTarget }, poolLength = f.engine.pool.length;
  f.port.rejectReads = true;
  f.engine.command({ type: 'arm', requestId: 23, capture: f.capture('late', { kind: 'vocal', masterAssetId: 'late-master' }) });
  const rejected = f.events.find(event => event.type === 'capture-rejected');
  assert.match(rejected.message, /port unavailable/); assert.equal(rejected.activeCaptureId, null);
  assert.equal(f.engine.capture, null); assert.equal(f.engine.playing, false); assert.equal(f.engine.frame, 1234);
  assert.equal(f.engine.pool.length, poolLength); assert.equal(f.engine.caches.has('late-raw'), false);
  assert.deepEqual(f.engine.inputMixTarget, beforeMix);
  f.port.rejectReads = false; f.run(512); assert.equal(f.writes.length, 0);
});

test('the main-thread client forwards rejection identity without clearing another capture', () => {
  const client = new AudioEngine({}), current = { id: 'active', status: 'recording' };
  client.capture = current;
  let received;
  client.addEventListener('capture-rejected', event => { received = event.detail; });
  const message = { type: 'capture-rejected', captureId: 'older', requestId: 55, message: 'Rejected arm', activeCaptureId: 'active' };
  client.onMessage(message);
  assert.equal(received, message); assert.equal(client.capture, current);
});
