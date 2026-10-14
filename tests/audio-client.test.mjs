import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioEngine } from '../src/audio/client.mjs';
import { createProject, createTrack } from '../src/project.mjs';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise(resolve => setImmediate(resolve));

/** Device fakes leave EventTarget/CustomEvent native, including browser listener semantics. */
function fakeBrowser(t, options = {}) {
  const requests = [], contexts = [], nodes = [], sources = [], channels = [];
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class Port {
    constructor() { this.messages = []; this.closed = false; }
    postMessage(message) { if (this.closed) throw new Error('Port is closed'); this.messages.push(message); }
    close() { this.closed = true; }
    start() {}
  }
  class Context {
    constructor({ sampleRate }) {
      this.sampleRate = options.sampleRate ?? sampleRate;
      this.state = 'suspended'; this.destination = {}; this.resumeCount = 0; this.closeCount = 0;
      this.audioWorklet = { addModule: async url => {
        this.moduleURL = url; await options.moduleGate?.promise;
        if (options.moduleError) throw options.moduleError;
      } };
      contexts.push(this);
    }
    async resume() {
      this.resumeCount++; await options.resumeGate?.promise;
      if (this.state !== 'closed') this.state = 'running';
    }
    async close() { this.closeCount++; this.state = 'closed'; this.onstatechange?.(); }
    createMediaStreamSource(stream) {
      if (options.sourceError) throw options.sourceError;
      const source = { stream, connected: false, disconnected: false,
        connect(node) { if (options.connectError) throw options.connectError; this.connected = !!node; },
        disconnect() { this.disconnected = true; this.connected = false; } };
      sources.push(source); return source;
    }
    changeState(state) { this.state = state; this.onstatechange?.(); }
  }
  class Worklet {
    constructor(context, name) { this.context = context; this.name = name; this.port = new Port(); nodes.push(this); }
    connect() { this.connected = true; }
    disconnect() { this.connected = false; }
    emit(message) { this.port.onmessage?.({ data: message }); }
  }
  replace('AudioContext', Context);
  replace('AudioWorkletNode', Worklet);
  replace('MessageChannel', class {
    constructor() { this.port1 = new Port(); this.port2 = new Port(); channels.push(this); }
  });
  replace('navigator', { mediaDevices: { getUserMedia(constraints) {
    const request = deferred(); requests.push({ ...request, constraints }); return request.promise;
  } } });
  const storage = { async attachAudioPort(port) {
    await options.storageGate?.promise;
    if (options.storageError) throw options.storageError;
    this.port = port;
  } };
  const engine = new AudioEngine(storage, { resumeTimeoutMs: options.resumeTimeoutMs });
  t.after(async () => {
    await engine.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  return { engine, requests, contexts, nodes, sources, channels, storage,
    init: () => engine.init(createProject('Lifecycle test')),
    commands: () => nodes.flatMap(node => node.port.messages).filter(message => !['storage-port', 'pool'].includes(message.type)) };
}

function microphone() {
  class Track extends EventTarget {
    constructor() { super(); this.readyState = 'live'; this.stopCount = 0; }
    stop() { this.stopCount++; this.readyState = 'ended'; }
    getSettings() { return { sampleRate: 48000, channelCount: 1 }; }
    interrupt(type) { if (type === 'ended') this.readyState = 'ended'; this.dispatchEvent(new Event(type)); }
  }
  const track = new Track();
  return { track, getAudioTracks: () => [track], getTracks: () => [track] };
}

test('concurrent initialization shares one audio context and preserves project sample rate', async t => {
  const moduleGate = deferred(), h = fakeBrowser(t, { moduleGate });
  const first = h.init(), second = h.init();
  await turn(); assert.equal(h.contexts.length, 1); assert.equal(h.nodes.length, 0);
  moduleGate.resolve(); await Promise.all([first, second]);
  assert.equal(h.nodes.length, 1); assert.equal(h.contexts[0].sampleRate, 48000);
  assert.equal(h.nodes[0].connected, true);
});

test('a sample-rate mismatch closes the rejected context before any node or microphone opens', async t => {
  const h = fakeBrowser(t, { sampleRate: 44100 });
  await assert.rejects(h.init(), /48000 Hz/);
  assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.nodes.length, 0); assert.equal(h.requests.length, 0);
});

test('an audio context that never resumes times out with guidance and closes before opening a worklet', { timeout: 1000 }, async t => {
  const resumeGate = deferred(), h = fakeBrowser(t, { resumeGate, resumeTimeoutMs: 20 });
  await assert.rejects(h.init(), error => {
    assert.match(error.message, /audio|sound/i);
    assert.match(error.message, /try|tap|click|allow|reopen|check/i);
    return true;
  });
  assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.nodes.length, 0); assert.equal(h.requests.length, 0);
});

test('a late resume completion cannot revive an expired audio initialization or replace a successful retry', { timeout: 1000 }, async t => {
  const resumeGate = deferred(), options = { resumeGate, resumeTimeoutMs: 20 }, h = fakeBrowser(t, options);
  await assert.rejects(h.init()); const expired = h.contexts[0];
  options.resumeGate = null; await h.init(); const current = h.contexts[1];
  assert.equal(h.nodes.length, 1); assert.equal(current.state, 'running');
  resumeGate.resolve(); await turn();
  assert.equal(expired.state, 'closed'); assert.equal(h.nodes.length, 1); assert.equal(h.engine.context, current);
  assert.equal(h.nodes[0].connected, true);
});

test('closing while the worklet module loads rejects initialization without reviving audio', async t => {
  const moduleGate = deferred(), h = fakeBrowser(t, { moduleGate });
  const initializing = h.init(); const rejected = assert.rejects(initializing, { name: 'AbortError' });
  await turn(); await h.engine.close(); moduleGate.resolve(); await rejected;
  assert.equal(h.nodes.length, 0); assert.equal(h.contexts[0].state, 'closed');
  await assert.rejects(h.init(), /closed/i);
});

test('closing while storage attaches rejects initialization as cancellation and closes both ports', async t => {
  const storageGate = deferred(), h = fakeBrowser(t, { storageGate });
  const initializing = h.init(); const rejected = assert.rejects(initializing, { name: 'AbortError' });
  await turn(); assert.equal(h.nodes.length, 1);
  await h.engine.close(); storageGate.resolve(); await rejected;
  assert.equal(h.nodes[0].connected, false); assert.equal(h.contexts[0].state, 'closed');
  assert.equal(h.channels[0].port1.closed, true); assert.equal(h.channels[0].port2.closed, true);
});

test('a second init call cannot report ready while the first is still attaching storage', async t => {
  const storageGate = deferred(), h = fakeBrowser(t, { storageGate });
  const first = h.init(); await turn();
  let ready = false; const second = h.init().then(value => { ready = true; return value; });
  await turn(); const premature = ready;
  storageGate.resolve(); await Promise.all([first, second]);
  assert.equal(premature, false, 'Recording callers must wait for storage and pooled capture buffers');
  assert.equal(h.nodes.length, 1); assert.equal(h.nodes[0].connected, true);
});

test('repeated enable-microphone requests share one unresolved permission request', async t => {
  const h = fakeBrowser(t); await h.init();
  const first = h.engine.enableMic(), second = h.engine.enableMic(), stream = microphone();
  assert.equal(h.requests.length, 1); h.requests[0].resolve(stream);
  assert.deepEqual(await Promise.all([first, second]), [stream, stream]);
  assert.equal(h.sources.length, 1); assert.equal(h.sources[0].connected, true);
  assert.equal(await h.engine.enableMic(), stream); assert.equal(h.requests.length, 1);
});

for (const action of ['stop', 'cancel', 'clear', 'disableMic', 'close']) {
  test(`${action} while microphone permission is unresolved prevents a late grant from reopening it`, async t => {
    const h = fakeBrowser(t); await h.init();
    const events = []; h.engine.addEventListener('mic', e => events.push(e.detail));
    const enabling = h.engine.enableMic(); const rejected = assert.rejects(enabling, { name: 'AbortError' });
    await h.engine[action](); const stream = microphone(); h.requests[0].resolve(stream); await rejected;
    assert.equal(stream.track.readyState, 'ended'); assert.equal(h.sources.length, 0);
    assert.equal(events.some(e => e.enabled), false);
  });
}

test('a stale permission result cannot stop or replace a newer successful microphone request', async t => {
  const h = fakeBrowser(t); await h.init();
  const oldAttempt = h.engine.enableMic(); const rejected = assert.rejects(oldAttempt, { name: 'AbortError' });
  h.engine.stop(); const currentAttempt = h.engine.enableMic();
  const oldStream = microphone(), currentStream = microphone();
  h.requests[1].resolve(currentStream); assert.equal(await currentAttempt, currentStream);
  h.requests[0].resolve(oldStream); await rejected;
  assert.equal(oldStream.track.readyState, 'ended'); assert.equal(currentStream.track.readyState, 'live');
  assert.equal(await h.engine.enableMic(), currentStream); assert.equal(h.requests.length, 2);
});

test('permission denial is actionable and a deliberate retry can subsequently succeed', async t => {
  const h = fakeBrowser(t); await h.init();
  const denied = h.engine.enableMic(); const rejected = assert.rejects(denied, /denied.*browser settings/i);
  h.requests[0].reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); await rejected;
  const retry = h.engine.enableMic(), stream = microphone(); h.requests[1].resolve(stream);
  assert.equal(await retry, stream); assert.equal(h.sources.length, 1);
});

for (const failure of ['sourceError', 'connectError']) {
  test(`a ${failure} after permission grant closes the stream and permits a fresh retry`, async t => {
    const options = { [failure]: new Error('Input connection failed') }, h = fakeBrowser(t, options);
    await h.init(); const first = h.engine.enableMic(); const rejected = assert.rejects(first, /Input connection failed/);
    const abandoned = microphone(); h.requests[0].resolve(abandoned); await rejected;
    assert.equal(abandoned.track.readyState, 'ended', 'A failed graph connection must not leave the microphone live');
    if (h.sources.length) assert.equal(h.sources[0].disconnected, true);
    options[failure] = null;
    const second = h.engine.enableMic(), replacement = microphone();
    assert.equal(h.requests.length, 2); h.requests[1].resolve(replacement);
    assert.equal(await second, replacement); assert.equal(replacement.track.readyState, 'live');
  });
}

test('a disconnected input interrupts capture, releases the microphone and emits a native device-lost event', async t => {
  const h = fakeBrowser(t); await h.init(); const enabling = h.engine.enableMic(), stream = microphone();
  h.requests[0].resolve(stream); await enabling;
  const events = []; h.engine.addEventListener('device-lost', e => events.push(e));
  const microphoneEvents = []; h.engine.addEventListener('mic', e => microphoneEvents.push(e.detail));
  h.nodes[0].emit({ type: 'state', playing: true, transportFrame: 300, capture: { id: 'take', status: 'recording' } });
  stream.track.interrupt('ended');
  assert.equal(events.length, 1); assert(events[0] instanceof CustomEvent);
  assert.equal(h.sources[0].disconnected, true); assert.equal(stream.track.readyState, 'ended');
  assert.equal(microphoneEvents.at(-1).enabled, false);
  assert(h.commands().some(m => m.type === 'interrupt'));
  assert.equal(h.commands().some(m => m.type === 'stop'), false, 'Input loss cannot drain an unavailable compensation tail');
});

test('events from a retired microphone cannot interrupt a new recording', async t => {
  const h = fakeBrowser(t); await h.init();
  const enabling = h.engine.enableMic(), retired = microphone(); h.requests[0].resolve(retired); await enabling;
  h.engine.disableMic();
  const retry = h.engine.enableMic(), current = microphone(); h.requests[1].resolve(current); await retry;
  h.nodes[0].emit({ type: 'state', playing: true, transportFrame: 300, capture: { id: 'current', status: 'recording' } });
  const interrupted = []; h.engine.addEventListener('interrupted', e => interrupted.push(e.detail));
  const before = h.commands().length; retired.track.interrupt('mute'); retired.track.interrupt('ended');
  assert.equal(interrupted.length, 0); assert.equal(current.track.readyState, 'live');
  assert.equal(h.commands().slice(before).some(m => ['stop', 'interrupt'].includes(m.type)), false);
});

test('an interrupted audio context requests valid-prefix capture interruption and reports recovery guidance', async t => {
  const h = fakeBrowser(t); await h.init(); const events = [];
  h.engine.addEventListener('interrupted', e => events.push(e.detail));
  h.nodes[0].emit({ type: 'state', playing: true, transportFrame: 300, capture: { id: 'take', status: 'recording' } });
  h.contexts[0].changeState('interrupted');
  assert(h.commands().some(m => m.type === 'interrupt')); assert.equal(events.length, 1);
  assert.equal(h.commands().some(m => m.type === 'stop'), false, 'Context loss cannot drain an unavailable compensation tail');
  assert.match(events[0].message, /saved portion.*retained/i);
});

test('worklet processor failure surfaces a fatal error through native event dispatch', async t => {
  const h = fakeBrowser(t); await h.init(); const events = [];
  h.engine.addEventListener('error', e => events.push(e)); h.nodes[0].onprocessorerror();
  assert.equal(events.length, 1); assert(events[0] instanceof CustomEvent);
  assert.equal(events[0].detail.fatal, true); assert.match(events[0].detail.message, /recover/i);
});

test('readiness waits for every current track and resolves concurrent callers only after the final acknowledgement', async t => {
  const h = fakeBrowser(t); await h.init();
  const tracks = ['one', 'two'].map(id => createTrack({ id, assetId: `asset-${id}`, frames: 48000 }));
  h.engine.syncTracks(tracks);
  let settled = 0;
  const first = h.engine.waitUntilReady(1000).then(() => settled++);
  const second = h.engine.waitUntilReady(1000).then(() => settled++);
  await turn(); assert.equal(settled, 0);
  h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'asset-one' });
  await turn(); assert.equal(settled, 0);
  h.nodes[0].emit({ type: 'track-ready', id: 'two', assetId: 'asset-two' });
  await Promise.all([first, second]); assert.equal(settled, 2);
});

test('missing audio readiness times out with recovery guidance, then a fresh wait can succeed', async t => {
  const h = fakeBrowser(t); await h.init();
  h.engine.syncTracks([createTrack({ id: 'one', assetId: 'asset-one', frames: 48000 })]);
  await assert.rejects(h.engine.waitUntilReady(5), /taking too long.*reopen/i);
  const retry = h.engine.waitUntilReady(1000);
  h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'asset-one' }); await retry;
});

for (const action of ['stop', 'cancel', 'clear', 'close']) {
  test(`${action} cancels a pending readiness wait so a late page cannot resume an abandoned operation`, async t => {
    const h = fakeBrowser(t); await h.init();
    h.engine.syncTracks([createTrack({ id: 'one', assetId: 'asset-one', frames: 48000 })]);
    const waiting = h.engine.waitUntilReady(50); const rejected = assert.rejects(waiting, { name: 'AbortError' });
    await h.engine[action](); await rejected;
  });
}

test('a closed engine never reports readiness, including when it has no tracks', async t => {
  const h = fakeBrowser(t); await h.init(); await h.engine.close();
  await assert.rejects(h.engine.waitUntilReady(50), { name: 'AbortError' });
});

test('replacing a track asset invalidates readiness and ignores the old asset acknowledgement', async t => {
  const h = fakeBrowser(t); await h.init();
  const track = createTrack({ id: 'one', assetId: 'original', frames: 48000 });
  h.engine.syncTracks([track]); h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'original' });
  await h.engine.waitUntilReady(50);
  h.engine.syncTracks([{ ...track, assetId: 'replacement' }]);
  let settled = false; const waiting = h.engine.waitUntilReady(1000).then(() => { settled = true; });
  await turn(); const readyBeforeReplacement = settled;
  h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'original' });
  await turn(); const readyAfterStaleAcknowledgement = settled;
  h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'replacement' }); await waiting;
  assert.equal(readyBeforeReplacement, false, 'A previous recording cannot stand in for replacement audio');
  assert.equal(readyAfterStaleAcknowledgement, false, 'Acknowledgements must identify the current asset');
});

test('renaming or mixing a resident track preserves readiness without waiting for another page', async t => {
  const h = fakeBrowser(t); await h.init();
  const track = createTrack({ id: 'one', assetId: 'asset-one', frames: 48000 });
  h.engine.syncTracks([track]); h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'asset-one' });
  await h.engine.waitUntilReady(50);
  h.engine.syncTracks([{ ...track, name: 'Renamed layer', mix: { ...track.mix, volume: 0.35 } }]);
  await h.engine.waitUntilReady(50);
});

test('removing the only unready track unblocks waiting for the remaining resident audio', async t => {
  const h = fakeBrowser(t); await h.init();
  const tracks = ['one', 'two'].map(id => createTrack({ id, assetId: `asset-${id}`, frames: 48000 }));
  h.engine.syncTracks(tracks); h.nodes[0].emit({ type: 'track-ready', id: 'one', assetId: 'asset-one' });
  const waiting = h.engine.waitUntilReady(50); h.engine.syncTracks([tracks[0]]); await waiting;
});
