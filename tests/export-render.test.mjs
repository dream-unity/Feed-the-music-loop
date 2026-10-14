import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { Worker as NodeWorker } from 'node:worker_threads';
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
