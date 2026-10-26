import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { createProject, createTrack, DEFAULT_MIX } from '../src/project.mjs';
import { prepareRenderPlan, renderEditedMix } from '../src/export/render.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const SR = 8000, PAGE = 16384;
const plainMix = { ...DEFAULT_MIX, highpass: 20, compression: 0, reverb: 0, delay: 0, volume: .5 };

class RenderStorage {
  constructor() { this.assets = new Map(); this.reads = []; this.writes = []; this.failAfter = Infinity; }
  async beginAsset(asset) { this.assets.set(asset.id, { ...asset, frames: 0, status: 'recording', pages: [] }); }
  async putPage(id, index, buffer, frames, channels) {
    if (this.writes.length >= this.failAfter) throw new Error('Disk full during render');
    const asset = this.assets.get(id); assert.equal(index, asset.pages.length); assert.equal(channels, asset.channels);
    asset.pages.push(buffer.slice(0, frames * channels * 4)); asset.frames += frames;
    this.writes.push({ id, index, frames, bytes: buffer.byteLength });
  }
  async finishAsset(id, meta) { const asset = this.assets.get(id); assert.equal(asset.frames, meta.frames); Object.assign(asset, meta); return this.getAsset(id); }
  async getAsset(id) { const asset = this.assets.get(id); if (!asset) throw new Error('Missing asset'); const { pages, ...meta } = asset; return { ...meta }; }
  async readPage(id, index) {
    const asset = this.assets.get(id), page = asset?.pages[index];
    this.reads.push({ id, index }); if (!page) throw new Error('Missing page');
    return { buffer: page.slice(0), index, channels: asset.channels, frames: page.byteLength / (asset.channels * 4) };
  }
  async deleteAsset(id) { this.assets.delete(id); }
  samples(id) { const asset = this.assets.get(id), samples = new Float32Array(asset.frames * asset.channels); let offset = 0; for (const page of asset.pages) { const a = new Float32Array(page); samples.set(a, offset); offset += a.length; } return samples; }
}

async function addAudio(storage, project, id, frames, channels = 1, sample = i => Math.sin(i * 2 * Math.PI * 311 / SR) * .2) {
  await storage.beginAsset({ id, projectId: project.id, sampleRate: project.sampleRate, channels, kind: 'loop', name: id });
  for (let offset = 0, index = 0; offset < frames; offset += PAGE, index++) {
    const count = Math.min(PAGE, frames - offset), pcm = new Float32Array(count * channels);
    for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = sample(offset + i, c);
    await storage.putPage(id, index, pcm.buffer, count, channels);
  }
  await storage.finishAsset(id, { frames, status: 'complete' });
}

async function fixture({ vocal = true } = {}) {
  const storage = new RenderStorage(), project = createProject('Render test', SR);
  await addAudio(storage, project, 'loop-audio', 17003);
  const loop = createTrack({ id: 'loop-track', assetId: 'loop-audio', name: 'Beat', frames: 17003, mix: { ...plainMix }, offsetFrames: 701 });
  project.tracks.push(loop); project.baseFrames = 17003; project.master.volume = .8;
  if (vocal) {
    await addAudio(storage, project, 'voice-audio', 40001, 1, i => Math.sin(i * 2 * Math.PI * 179 / SR) * .15);
    await addAudio(storage, project, 'live-master', 40001, 2);
    project.takes.push({ id: 'take', name: 'Vocal', assetId: 'voice-audio', frames: 40001, startFrame: 16137, performanceId: 'performance', mix: { ...plainMix, volume: .4 } });
    project.selectedTakeId = 'take';
    project.performances.push({ id: 'performance', name: 'Song', frames: 40001, startFrame: 16137, endFrame: 56138, leadAssetId: 'voice-audio', masterAssetId: 'live-master', status: 'complete', tailFrames: 0, events: [], initialState: { tracks: [structuredClone(loop)], frame: 16137, baseFrames: 17003, master: { volume: .8 }, input: { gain: 3 }, inputMix: { ...plainMix, volume: .4 }, engineVersion: 1 } });
  }
  storage.reads = []; storage.writes = [];
  return { storage, project };
}

const rms = (samples, begin, end) => { let sum = 0; for (let i = begin; i < end; i++) sum += samples[i] ** 2; return Math.sqrt(sum / (end - begin)); };

class BrowserWorkerBridge {
  constructor(url) {
    this.worker = new NodeWorker(new URL('./export-worker-harness.mjs', import.meta.url), { workerData: { url: url.href } });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.(error));
    this.worker.on('messageerror', error => this.onmessageerror?.(error));
  }
  postMessage(message, transfer) { this.worker.postMessage(message, transfer); }
  terminate() { return this.worker.terminate(); }
}

test('edited song retains its exact body length, nonzero loop phase and full dry vocal without double input gain', async () => {
  const { storage, project } = await fixture();
  const output = await renderEditedMix(storage, project, { useWorker: false, tailSeconds: .25, prerollSeconds: 0 });
  assert.equal(output.frames, 42001); assert.equal(output.bodyFrames, 40001); assert.equal(output.startFrame, 16137);
  assert.equal(output.sampleRate, SR); assert.equal(output.channels, 2); assert.equal(output.tailFrames, 2000);
  const pcm = storage.samples(output.assetId); assert.ok(pcm.every(Number.isFinite)); assert.ok(rms(pcm, 4000, 60000) > .02); assert.equal(Math.abs(pcm.at(-1)), 0);
  assert.ok(storage.writes.every(write => write.frames <= PAGE && write.bytes <= PAGE * 8));
  assert.ok(storage.reads.some(read => read.id === 'voice-audio' && read.index === 2));
  const original = project.input.gain; project.input.gain = 4;
  const second = await renderEditedMix(storage, project, { useWorker: false, tailSeconds: .25, prerollSeconds: 0 });
  assert.deepEqual(storage.samples(second.assetId), pcm, 'raw capture gain must not be applied twice'); project.input.gain = original;
});

test('actual-frame mute automation is applied between audio blocks with no early samples changed', async () => {
  const { storage, project } = await fixture(); project.takes[0].mix.volume = 0;
  const baseline = await renderEditedMix(storage, project, { useWorker: false, tailSeconds: 0, prerollSeconds: 0 });
  const start = project.performances[0].startFrame, muteAt = 777;
  project.performances[0].events = [{ frame: start + muteAt, type: 'mix', id: 'loop-track', muted: true }];
  const muted = await renderEditedMix(storage, project, { useWorker: false, tailSeconds: 0, prerollSeconds: 0 });
  const a = storage.samples(baseline.assetId), b = storage.samples(muted.assetId);
  assert.deepEqual(b.subarray(0, muteAt * 2), a.subarray(0, muteAt * 2));
  assert.ok(rms(b, 16000, 32000) < rms(a, 16000, 32000) * .001);
});

test('current mix keeps performed sections while original mode replays recorded fader changes', async () => {
  const { storage, project } = await fixture();
  const perf = project.performances[0], start = perf.startFrame;
  project.tracks[0].mix.volume = .2;
  perf.events = [
    { frame: start + 123, type: 'mix', id: 'loop-track', mix: { volume: .9 } },
    { frame: start + 10003, type: 'section', section: { id: 'quiet', name: 'Quiet', tracks: {} } },
    { frame: start + 17003, type: 'section', section: { id: 'return', name: 'Return', tracks: { 'loop-track': { muted: false, solo: false, mix: { ...plainMix, volume: .8 } } } } },
  ];
  project.takes[0].mix.volume = 0; perf.initialState.inputMix.volume = 0;
  const current = await renderEditedMix(storage, project, { useWorker: false, mode: 'current', tailSeconds: 0, prerollSeconds: 0 });
  const original = await renderEditedMix(storage, project, { useWorker: false, mode: 'performance', tailSeconds: 0, prerollSeconds: 0 });
  const a = storage.samples(current.assetId), b = storage.samples(original.assetId);
  assert.ok(rms(b, 5000, 16000) > rms(a, 5000, 16000) * 3);
  assert.ok(rms(a, 26000, 30000) < .00001); assert.ok(rms(b, 26000, 30000) < .00001);
  assert.ok(rms(b, 40000, 50000) > rms(a, 40000, 50000) * 3);
});

test('replacing a loop with edited stereo audio changes current rendering while recorded arrangements keep original PCM', async () => {
  const { storage, project } = await fixture();
  const options = { mode: 'performance', tailSeconds: 0, prerollSeconds: 0 };
  const originalTrack = structuredClone(project.tracks[0]);
  const originalSource = storage.samples(originalTrack.assetId).slice();
  const before = await renderEditedMix(storage, project, options);
  const recorded = storage.samples(before.assetId).slice();
  await addAudio(storage, project, 'edited-loop', 7003, 2, (frame, channel) => Math.sin(frame * (channel ? .081 : .037)) * .12);
  Object.assign(project.tracks[0], { assetId: 'edited-loop', frames: 7003, channels: 2 });
  const currentPlan = await prepareRenderPlan(storage, project, { ...options, mode: 'current' });
  const originalPlan = await prepareRenderPlan(storage, project, options);
  assert.equal(currentPlan.tracks[0].assetId, 'edited-loop');
  assert.equal(currentPlan.tracks[0].frames, 7003);
  assert.equal(currentPlan.tracks[0].channels, 2);
  assert.equal(originalPlan.tracks[0].assetId, originalTrack.assetId);
  assert.equal(originalPlan.tracks[0].frames, originalTrack.frames);
  assert.equal(currentPlan.baseFrames, 17003, 'editing one loop must not move the recorded groove boundaries');
  const after = await renderEditedMix(storage, project, options);
  assert.deepEqual(storage.samples(after.assetId), recorded, 'original arrangement rendering must remain byte-for-byte reproducible');
  const edited = await renderEditedMix(storage, project, { ...options, mode: 'current' });
  assert.notDeepEqual(storage.samples(edited.assetId), recorded);
  assert.deepEqual(storage.samples(originalTrack.assetId), originalSource);
  assert.deepEqual(project.performances[0].initialState.tracks[0], originalTrack);
});

test('natural FX tail continues after source cutoff and ends with a taper', async () => {
  const { storage, project } = await fixture({ vocal: false });
  project.tracks[0].mix.reverb = .6; project.tracks[0].mix.delay = .5;
  const output = await renderEditedMix(storage, project, { useWorker: false, durationSeconds: .6, tailSeconds: 1, prerollSeconds: .5 });
  const pcm = storage.samples(output.assetId);
  assert.equal(output.frames, 12800); assert.equal(output.prerollFrames, 4000);
  assert.ok(rms(pcm, 10000, 12000) > .00001, 'tail must retain earlier echo and room energy');
  assert.equal(Math.abs(pcm.at(-1)), 0); assert.equal(Math.abs(pcm.at(-2)), 0);
});

test('storage failure and cancellation remove only the new render', async () => {
  for (const cancelled of [false, true]) {
    const { storage, project } = await fixture(); const originals = [...storage.assets.keys()]; const controller = new AbortController();
    if (!cancelled) storage.failAfter = 1;
    await assert.rejects(renderEditedMix(storage, project, { useWorker: false, tailSeconds: 0, prerollSeconds: 0, signal: controller.signal, onProgress: () => { if (cancelled) controller.abort(); } }), cancelled ? { name: 'AbortError' } : /Disk full/);
    assert.deepEqual([...storage.assets.keys()], originals);
  }
});

test('recovery remix is limited to its verified editable interval without changing saved master or raw audio', async () => {
  const { storage, project } = await fixture(); const perf = project.performances[0];
  perf.status = 'interrupted'; perf.editableFrames = 16013;
  const plan = await prepareRenderPlan(storage, project, { tailSeconds: 0 }); assert.equal(plan.bodyFrames, 16013);
  await assert.rejects(prepareRenderPlan(storage, project, { durationSeconds: 4 }), { code: 'INCOMPLETE_PERFORMANCE' });
  assert.equal((await storage.getAsset(perf.masterAssetId)).frames, 40001); assert.equal((await storage.getAsset(perf.leadAssetId)).frames, 40001);
});

test('actual renderer worker transfers pages and reproduces the deterministic rendering core', async () => {
  const previous = globalThis.Worker; globalThis.Worker = BrowserWorkerBridge;
  try {
    const { storage, project } = await fixture();
    const options = { durationSeconds: 2.2, tailSeconds: .05, prerollSeconds: .1 };
    const direct = await renderEditedMix(storage, project, { ...options, useWorker: false });
    const threaded = await renderEditedMix(storage, project, options);
    assert.deepEqual(storage.samples(threaded.assetId), storage.samples(direct.assetId));
  } finally { if (previous) globalThis.Worker = previous; else delete globalThis.Worker; }
});

test('worker cancellation waits for a pending storage write before deleting its output asset', async () => {
  const previous = globalThis.Worker; globalThis.Worker = BrowserWorkerBridge;
  try {
    const { storage, project } = await fixture(); const originals = [...storage.assets.keys()];
    const controller = new AbortController(), write = storage.putPage.bind(storage);
    let delayedWriteCompleted = false;
    storage.putPage = async (...args) => {
      controller.abort();
      await new Promise(resolve => setTimeout(resolve, 20));
      await write(...args); delayedWriteCompleted = true;
    };
    await assert.rejects(renderEditedMix(storage, project, { durationSeconds: 2.2, tailSeconds: 0, prerollSeconds: 0, signal: controller.signal }), { name: 'AbortError' });
    assert.ok(delayedWriteCompleted); assert.deepEqual([...storage.assets.keys()], originals);
  } finally { if (previous) globalThis.Worker = previous; else delete globalThis.Worker; }
});

test('same-frame events keep their saved order exactly across output-page and DSP-block boundaries', async () => {
  for (const at of [127, 128, PAGE - 1, PAGE, PAGE + 1]) {
    const { storage, project } = await fixture(); project.takes[0].mix.volume = 0;
    const perf = project.performances[0], options = { useWorker: false, tailSeconds: 0, prerollSeconds: 0 };
    const baseline = await renderEditedMix(storage, project, options);
    perf.events = [
      { frame: perf.startFrame + at, type: 'mix', id: 'loop-track', muted: false },
      { frame: perf.startFrame + at, type: 'mix', id: 'loop-track', muted: true },
    ];
    const muted = await renderEditedMix(storage, project, options);
    const a = storage.samples(baseline.assetId), b = storage.samples(muted.assetId);
    assert.deepEqual(b.subarray(0, at * 2), a.subarray(0, at * 2));
    assert.ok(rms(b, (at + 4000) * 2, (at + 8000) * 2) < rms(a, (at + 4000) * 2, (at + 8000) * 2) * .001);
    perf.events.reverse();
    const restored = await renderEditedMix(storage, project, options);
    assert.deepEqual(storage.samples(restored.assetId), a, 'last same-frame event wins without a single muted sample');
  }
});

test('current sound preserves the mute state at a recorded track entrance', async () => {
  const { storage, project } = await fixture();
  const perf = project.performances[0], options = { useWorker: false, tailSeconds: 0, prerollSeconds: 0 };
  project.takes[0].mix.volume = 0; perf.initialState.tracks = [];
  const entered = { ...structuredClone(project.tracks[0]), muted: true };
  perf.events = [{ frame: perf.startFrame + 173, type: 'track', track: entered }];
  const quiet = await renderEditedMix(storage, project, options);
  assert.equal(rms(storage.samples(quiet.assetId), 0, 40001 * 2), 0);
  perf.events.push({ frame: perf.startFrame + PAGE, type: 'mix', id: entered.id, muted: false });
  const audible = await renderEditedMix(storage, project, options), pcm = storage.samples(audible.assetId);
  assert.equal(rms(pcm, 0, PAGE * 2), 0);
  assert.ok(rms(pcm, (PAGE + 1000) * 2, (PAGE + 8000) * 2) > .01);
});

test('a performance captured after Stop retains aligned loop phase in both current and original renders', async () => {
  const { storage, project } = await fixture();
  const options = { useWorker: false, tailSeconds: 0, prerollSeconds: 0 };
  const performance = project.performances[0], recorded = performance.initialState.tracks[0];
  recorded.sourceOffsetFrames = recorded.offsetFrames;
  recorded.offsetFrames = 0;
  const untouched = structuredClone(project);
  const reference = structuredClone(project);
  reference.tracks[0].offsetFrames = 0;
  delete reference.performances[0].initialState.tracks[0].sourceOffsetFrames;
  for (const mode of ['current', 'performance']) {
    const expected = await renderEditedMix(storage, reference, { ...options, mode });
    const actual = await renderEditedMix(storage, project, { ...options, mode });
    assert.deepEqual(storage.samples(actual.assetId), storage.samples(expected.assetId), `${mode} must use the heard zero phase rather than the saved capture origin`);
  }
  assert.deepEqual(project, untouched, 'rendering must not rewrite the authored timing or recorded snapshot');
});

test('current remix applies only the later timing delta to a restarted performance while original sound stays fixed', async () => {
  const { storage, project } = await fixture();
  const options = { useWorker: false, tailSeconds: 0, prerollSeconds: 0 };
  const recorded = project.performances[0].initialState.tracks[0];
  recorded.sourceOffsetFrames = 701; recorded.offsetFrames = 0;
  const original = await renderEditedMix(storage, project, { ...options, mode: 'performance' });
  project.tracks[0].offsetFrames += 38;
  const plan = await prepareRenderPlan(storage, project, options);
  assert.equal(plan.tracks[0].offsetFrames, 38);
  const reference = structuredClone(project);
  reference.tracks[0].offsetFrames = 38;
  delete reference.performances[0].initialState.tracks[0].sourceOffsetFrames;
  const current = await renderEditedMix(storage, project, options);
  const expected = await renderEditedMix(storage, reference, options);
  assert.deepEqual(storage.samples(current.assetId), storage.samples(expected.assetId));
  const originalAgain = await renderEditedMix(storage, project, { ...options, mode: 'performance' });
  assert.deepEqual(storage.samples(originalAgain.assetId), storage.samples(original.assetId));
});

test('track entrances replay their effective phase after Stop and preserve current timing edits', async () => {
  const { storage, project } = await fixture();
  const performance = project.performances[0], options = { useWorker: false, tailSeconds: 0, prerollSeconds: 0 };
  const entered = { ...structuredClone(project.tracks[0]), offsetFrames: 23, sourceOffsetFrames: 701 };
  performance.initialState.tracks = [];
  performance.events = [{ frame: performance.startFrame + 173, type: 'command', command: 'track', track: entered }];
  project.tracks[0].offsetFrames = 739;
  const reference = structuredClone(project);
  reference.tracks[0].offsetFrames = 61;
  delete reference.performances[0].events[0].track.sourceOffsetFrames;
  for (const mode of ['current', 'performance']) {
    const actual = await renderEditedMix(storage, project, { ...options, mode });
    const expected = await renderEditedMix(storage, reference, { ...options, mode });
    assert.deepEqual(storage.samples(actual.assetId), storage.samples(expected.assetId), `${mode} must preserve the recorded track entrance phase`);
  }
});

test('invalid or overflowing recorded timing rejects before creating a rendered asset', async () => {
  for (const location of ['initial', 'event']) {
    for (const sourceOffsetFrames of [0.5, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER]) {
      const { storage, project } = await fixture();
      const performance = project.performances[0];
      const recorded = { ...structuredClone(project.tracks[0]), offsetFrames: 1, sourceOffsetFrames };
      if (location === 'initial') performance.initialState.tracks = [recorded];
      else {
        performance.initialState.tracks = [];
        performance.events = [{ frame: performance.startFrame + 173, type: 'track', track: recorded }];
      }
      const originalIds = [...storage.assets.keys()];
      await assert.rejects(renderEditedMix(storage, project, { useWorker: false, tailSeconds: 0, prerollSeconds: 0 }), /timing|offset/i);
      assert.deepEqual([...storage.assets.keys()], originalIds);
    }
  }
});

test('a performance that starts with Spotlight already held retains its backing attenuation', async () => {
  const { storage, project } = await fixture(); project.takes[0].mix.volume = 0;
  const options = { useWorker: false, tailSeconds: 0, prerollSeconds: .1 };
  const normal = await renderEditedMix(storage, project, options);
  project.performances[0].initialState.spotlight = true;
  const spotlight = await renderEditedMix(storage, project, options);
  const ratio = rms(storage.samples(spotlight.assetId), 2000, 60000) / rms(storage.samples(normal.assetId), 2000, 60000);
  assert.ok(ratio > .34 && ratio < .36);
});

test('cancellation during the final asset seal removes the cancelled render after sealing settles', async () => {
  const { storage, project } = await fixture(), controller = new AbortController();
  const originals = [...storage.assets.keys()], finish = storage.finishAsset.bind(storage);
  storage.finishAsset = async (...args) => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 5)); return finish(...args); };
  await assert.rejects(renderEditedMix(storage, project, { useWorker: false, tailSeconds: 0, prerollSeconds: 0, signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual([...storage.assets.keys()], originals);
});

test('long rendering of six independently phased consumers shares audio without cache collisions or full-song buffers', async () => {
  const run = async shared => {
    const project = createProject('Streaming stress', SR), frames = PAGE * 101 + 37;
    const assets = new Map(), hash = createHash('sha256');
    let reads = 0, written = 0, largestWrite = 0, largestRead = 0, activeReads = 0, maxConcurrentReads = 0;
    for (let i = 0; i < 6; i++) {
      const assetId = shared ? 'shared-audio' : `audio-${i}`;
      assets.set(assetId, { id: assetId, projectId: project.id, frames, channels: 1, sampleRate: SR, status: 'complete' });
      project.tracks.push(createTrack({ id: `track-${i}`, assetId, frames, offsetFrames: (i * 12 + 5) * PAGE + i * 73, mix: { ...plainMix, volume: .08 } }));
    }
    project.baseFrames = frames;
    const storage = {
      getAsset: async id => assets.get(id),
      beginAsset: async asset => assets.set(asset.id, { ...asset, frames: 0, status: 'recording' }),
      readPage: async (id, index) => {
        reads++; maxConcurrentReads = Math.max(maxConcurrentReads, ++activeReads);
        await new Promise(resolve => setImmediate(resolve));
        const count = Math.min(PAGE, frames - index * PAGE), pcm = new Float32Array(count);
        for (let i = 0; i < count; i++) pcm[i] = Math.sin((index * PAGE + i) * .117) * .2;
        largestRead = Math.max(largestRead, pcm.byteLength); activeReads--;
        return { buffer: pcm.buffer, frames: count, channels: 1, index };
      },
      putPage: async (id, index, buffer, count, channels) => {
        assert.equal(index, Math.floor(written / PAGE)); assert.equal(channels, 2);
        largestWrite = Math.max(largestWrite, buffer.byteLength);
        const pcm = new Float32Array(buffer, 0, count * 2); assert.ok(pcm.every(Number.isFinite));
        hash.update(new Uint8Array(buffer, 0, count * 8)); written += count; assets.get(id).frames += count;
      },
      finishAsset: async (id, meta) => { Object.assign(assets.get(id), meta); return assets.get(id); },
      deleteAsset: async id => assets.delete(id),
    };
    const result = await renderEditedMix(storage, project, { durationSeconds: 60, tailSeconds: .031, prerollSeconds: .017, useWorker: false });
    assert.equal(written, SR * 60 + Math.round(.031 * SR)); assert.equal(result.frames, written);
    assert.ok(reads > 100, 'must advance through many cache windows');
    assert.ok(largestRead <= PAGE * 4); assert.ok(largestWrite <= PAGE * 8);
    assert.ok(maxConcurrentReads <= 32, `unbounded pending reads: ${maxConcurrentReads}`);
    return hash.digest('hex');
  };
  assert.equal(await run(true), await run(false), 'reusing an asset at different phases must match independent immutable copies');
});

async function withFakeWorker(behavior, action) {
  const previous = globalThis.Worker, instances = [];
  globalThis.Worker = class {
    constructor() { this.terminated = false; instances.push(this); }
    postMessage(message) { behavior.call(this, message); }
    terminate() { this.terminated = true; }
    emit(message) { queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: message }); }); }
  };
  try { return await action(instances); }
  finally { if (previous) globalThis.Worker = previous; else delete globalThis.Worker; }
}

test('worker startup and response transport failures terminate the worker and remove only its new render', async () => {
  for (const stage of ['startup', 'response']) {
    await withFakeWorker(function (message) {
      if (stage === 'startup' || message.type === 'rpc-result') throw new Error('Simulated transport failure');
      this.emit({ type: 'rpc', requestId: 1, method: 'readPage', args: ['loop-audio', 0] });
    }, async instances => {
      const { storage, project } = await fixture(), originals = [...storage.assets.keys()];
      await assert.rejects(renderEditedMix(storage, project, { tailSeconds: 0, prerollSeconds: 0, workerIdleTimeoutMs: 500 }), /transport failure/);
      assert.equal(instances.length, 1); assert.ok(instances[0].terminated); assert.deepEqual([...storage.assets.keys()], originals);
    });
  }
});

test('a silent render worker times out without leaving an output asset or a running worker', async () => {
  await withFakeWorker(function () {}, async instances => {
    const { storage, project } = await fixture(), originals = [...storage.assets.keys()];
    await assert.rejects(renderEditedMix(storage, project, { workerIdleTimeoutMs: 15 }), { code: 'RENDER_TIMEOUT' });
    assert.ok(instances[0].terminated); assert.deepEqual([...storage.assets.keys()], originals);
  });
});

test('cancellation does not wait for a stuck read of an immutable source recording', async () => {
  await withFakeWorker(function (message) {
    if (message.type === 'render') this.emit({ type: 'rpc', requestId: 1, method: 'readPage', args: ['loop-audio', 0] });
  }, async instances => {
    const { storage, project } = await fixture(), originals = [...storage.assets.keys()], controller = new AbortController();
    storage.readPage = async () => { controller.abort(); return new Promise(() => {}); };
    await assert.rejects(renderEditedMix(storage, project, { signal: controller.signal, workerIdleTimeoutMs: 500 }), { name: 'AbortError' });
    assert.ok(instances[0].terminated); assert.deepEqual([...storage.assets.keys()], originals);
  });
});

test('invalid renderer requests and incomplete completion are rejected before accepting output', async () => {
  const messages = [
    null,
    { type: 'rpc', requestId: 1, method: 'readPage', args: ['unrelated-project-audio', 0] },
    { type: 'rpc', requestId: 1, method: 'readPage', args: ['loop-audio', 2] },
    { type: 'rpc', requestId: 1, method: 'putPage', args: [1, new ArrayBuffer(PAGE * 8), PAGE, 2] },
    { type: 'rpc', requestId: 1, method: 'putPage', args: [0, new ArrayBuffer(4), PAGE, 2] },
    { type: 'rpc', requestId: 1, method: 'deleteAsset', args: ['loop-audio'] },
    { type: 'complete', result: { frames: 40001, bodyFrames: 40001, tailFrames: 0, sampleRate: SR, channels: 2 } },
  ];
  for (const message of messages) await withFakeWorker(function (command) {
    if (command.type === 'render') this.emit(message);
  }, async instances => {
    const { storage, project } = await fixture(), originals = [...storage.assets.keys()];
    await assert.rejects(renderEditedMix(storage, project, { tailSeconds: 0, prerollSeconds: 0, workerIdleTimeoutMs: 500 }), { code: 'RENDER_PROTOCOL' });
    assert.ok(instances[0].terminated); assert.deepEqual(storage.writes, []); assert.deepEqual([...storage.assets.keys()], originals);
  });
});

test('renderer refuses truncated or incorrectly labelled source pages instead of exporting silence', async () => {
  for (const change of [page => ({ ...page, channels: 2 }), page => ({ ...page, frames: page.frames - 1 }), page => ({ ...page, buffer: page.buffer.slice(0, -4) })]) {
    const { storage, project } = await fixture(), originals = [...storage.assets.keys()], read = storage.readPage.bind(storage);
    storage.readPage = async (...args) => change(await read(...args));
    await assert.rejects(renderEditedMix(storage, project, { useWorker: false, tailSeconds: 0, prerollSeconds: 0 }), /inconsistent saved length or channel count/);
    assert.deepEqual([...storage.assets.keys()], originals);
  }
});

test('cancellation during output creation does not start a render worker', async () => {
  await withFakeWorker(function () { throw new Error('Worker should not start'); }, async instances => {
    const { storage, project } = await fixture(), controller = new AbortController(), originals = [...storage.assets.keys()], begin = storage.beginAsset.bind(storage);
    storage.beginAsset = async (...args) => { await begin(...args); controller.abort(); };
    await assert.rejects(renderEditedMix(storage, project, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(instances.length, 0); assert.deepEqual([...storage.assets.keys()], originals);
  });
});

test('an explicit loop-only performance render never falls back to the selected dry vocal or solo controls', async () => {
  const { storage, project } = await fixture();
  const loop = project.tracks[0];
  await addAudio(storage, project, 'other-loop', loop.frames, 1, i => Math.sin(i * 2 * Math.PI * 739 / SR) * .1);
  project.tracks.push(createTrack({ id: 'other-track', assetId: 'other-loop', name: 'Other loop', frames: loop.frames, mix: { ...plainMix }, solo: true }));
  await addAudio(storage, project, 'loops-master', 8000, 2);
  project.performances.push({ id: 'loops-performance', name: 'Loop recording 1', source: 'loops', masterAssetId: 'loops-master', frames: 8000, startFrame: 16137, endFrame: 24137,
    status: 'complete', events: [{ type: 'mix', id: loop.id, solo: true, frame: 16400 }, { type: 'spotlight', active: true, frame: 16500 },
      { type: 'section', frame: 17000, section: { id: 'loop-section', name: 'Loops', tracks: Object.fromEntries(project.tracks.map(track => [track.id, { muted: false, solo: true, mix: track.mix }])) } }],
    initialState: { tracks: structuredClone(project.tracks), baseFrames: project.baseFrames, master: { volume: .8 }, input: { gain: 4 }, spotlight: true } });
  const options = { performanceId: 'loops-performance', mode: 'performance', useWorker: false, tailSeconds: 0, prerollSeconds: 0 };
  const before = structuredClone(project);
  const plan = await prepareRenderPlan(storage, project, options);
  assert.equal(plan.vocal, null); assert.equal(plan.spotlight, true);
  assert.equal(plan.assetIds.includes('voice-audio'), false); assert.ok(plan.tracks.every(track => !track.solo));
  assert.equal(plan.events[0].solo, false); assert.equal(plan.events[1].active, true);
  assert.ok(Object.values(plan.events[2].section.tracks).every(track => !track.solo));
  const output = await renderEditedMix(storage, project, options), pcm = storage.samples(output.assetId);
  assert.ok(rms(pcm, 2000, pcm.length) > .005);
  assert.equal(storage.reads.some(read => read.id === 'voice-audio'), false);
  assert.deepEqual(project, before, 'loop-only render does not change the stored solo or selected vocal settings');
  const reference = structuredClone(project); reference.selectedTakeId = null;
  const performance = reference.performances.at(-1);
  for (const track of performance.initialState.tracks) track.solo = false;
  performance.events = performance.events.map(event => event.type === 'mix' ? { ...event, solo: false } : event);
  for (const settings of Object.values(performance.events[2].section.tracks)) settings.solo = false;
  const expected = await renderEditedMix(storage, reference, options);
  assert.deepEqual(pcm, storage.samples(expected.assetId));
});
