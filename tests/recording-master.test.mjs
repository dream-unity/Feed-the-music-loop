import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { renderMasteredRecording, previewMasteredRecording, prepareMasterPlan, normalizeMasterSettings, DEFAULT_MASTER_SETTINGS } from '../src/export/master.mjs';
import { renderMasterFrames, MASTER_PAGE_FRAMES as PAGE } from '../src/export/master-core.mjs';
import { WAV_HEADER_BYTES } from '../src/export/wav.mjs';

const SR = 8000;
class MemoryStorage {
  constructor() { this.assets = new Map(); this.reads = []; this.writes = []; this.deleted = []; }
  async beginAsset(asset) { this.assets.set(asset.id, { ...asset, frames: 0, status: 'recording', pages: [] }); }
  async putPage(id, index, buffer, frames, channels) {
    const asset = this.assets.get(id); assert.equal(index, asset.pages.length); assert.equal(channels, asset.channels);
    asset.pages.push(buffer.slice(0, frames * channels * 4)); asset.frames += frames;
    this.writes.push({ id, index, frames, bytes: buffer.byteLength });
  }
  async finishAsset(id, meta) { const asset = this.assets.get(id); assert.equal(asset.frames, meta.frames); Object.assign(asset, meta); return this.getAsset(id); }
  async getAsset(id) { const asset = this.assets.get(id); if (!asset) throw new Error('Missing asset'); const { pages, ...meta } = asset; return { ...meta }; }
  async readPage(id, index) {
    const asset = this.assets.get(id), page = asset?.pages[index]; this.reads.push({ id, index });
    if (!page) throw new Error('Missing page');
    return { buffer: page.slice(0), index, channels: asset.channels, frames: page.byteLength / (asset.channels * 4) };
  }
  async deleteAsset(id) { this.deleted.push(id); this.assets.delete(id); }
  samples(id) { const asset = this.assets.get(id), result = new Float32Array(asset.frames * asset.channels); let offset = 0; for (const page of asset.pages) { const pcm = new Float32Array(page); result.set(pcm, offset); offset += pcm.length; } return result; }
}
async function fixture({ frames = PAGE * 2 + 317, channels = 2, sample = (frame, channel) => Math.sin(frame * .07) * (channel ? -.1 : .2) } = {}) {
  const storage = new MemoryStorage(), project = { id: 'project', sampleRate: SR };
  await storage.beginAsset({ id: 'original', projectId: project.id, sampleRate: SR, channels, name: 'Original performance', kind: 'master' });
  for (let offset = 0, index = 0; offset < frames; offset += PAGE, index++) {
    const count = Math.min(PAGE, frames - offset), pcm = new Float32Array(count * channels);
    for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = sample(offset + i, c);
    await storage.putPage('original', index, pcm.buffer, count, channels);
  }
  await storage.finishAsset('original', { frames, status: 'complete' }); storage.reads = []; storage.writes = [];
  return { storage, project, options: { assetId: 'original', useWorker: false } };
}
const peak = pcm => pcm.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
const rms = (pcm, from = 0) => Math.sqrt(pcm.subarray(from).reduce((sum, value) => sum + value * value, 0) / (pcm.length - from));
async function previewSamples(result) { return new Float32Array(await result.blob.slice(WAV_HEADER_BYTES).arrayBuffer()); }

for (const channels of [1, 2]) test(`neutral mastering preserves ${channels}-channel source exactly, duration and metadata, without mutating project`, async () => {
  const { storage, project, options } = await fixture({ channels }), before = storage.samples('original'), beforeProject = structuredClone(project);
  const result = await renderMasteredRecording(storage, project, options);
  assert.deepEqual(storage.samples(result.assetId), before); assert.deepEqual(storage.samples('original'), before); assert.deepEqual(project, beforeProject);
  assert.equal(result.frames, before.length / channels); assert.equal(result.channels, channels); assert.equal(result.sampleRate, SR);
  const asset = await storage.getAsset(result.assetId);
  assert.equal(asset.kind, 'mix'); assert.equal(asset.sourceAssetId, 'original'); assert.deepEqual(asset.masterSettings, DEFAULT_MASTER_SETTINGS); assert.deepEqual(asset.analysis, result.analysis);
  assert.equal(result.analysis.outputGainDb, 0); assert.equal(result.analysis.peakType, 'sample');
  assert.ok(storage.writes.every(write => write.bytes === PAGE * channels * 4));
});

test('gain and stereo balance preserve distinct channels and their signs', async () => {
  const { storage, project, options } = await fixture({ sample: (frame, channel) => channel ? -.1 : .2 });
  const result = await renderMasteredRecording(storage, project, { ...options, settings: { gainDb: -6, balance: .5 } }), pcm = storage.samples(result.assetId);
  assert.equal(pcm[0], Math.fround(Math.fround(.2) * 10 ** (-6 / 20) * .5));
  assert.equal(pcm[1], Math.fround(Math.fround(-.1) * 10 ** (-6 / 20)));
  assert.ok(pcm.every((value, i) => value === pcm[i % 2]));
});

test('stereo linked compression preserves the image even with asymmetric channel levels', async () => {
  const { storage, project, options } = await fixture({ sample: (frame, channel) => (.1 + .4 * (frame % 700 < 350)) * (channel ? -.25 : 1) });
  const result = await renderMasteredRecording(storage, project, { ...options, settings: { compression: .8 } }), pcm = storage.samples(result.assetId);
  for (let i = 0; i < pcm.length; i += 2) assert.ok(Math.abs(pcm[i + 1] / pcm[i] + .25) < 1e-6);
  assert.ok(rms(pcm) < rms(storage.samples('original')));
});

test('sample peak normalization uses the complete recording and does not change its channel ratio', async () => {
  const { storage, project, options } = await fixture({ sample: (frame, channel) => (frame === PAGE + 51 ? .8 : .1) * (channel ? -.5 : 1) });
  const result = await renderMasteredRecording(storage, project, { ...options, settings: { normalize: true, ceilingDb: -3 } }), pcm = storage.samples(result.assetId);
  assert.ok(Math.abs(20 * Math.log10(peak(pcm)) + 3) < 1e-6);
  assert.ok(peak(pcm) <= 10 ** (-3 / 20));
  assert.ok(Math.abs(pcm[0] / pcm[(PAGE + 51) * 2] - .125) < 1e-7);
  for (let i = 0; i < pcm.length; i += 2) assert.equal(pcm[i + 1], -.5 * pcm[i]);
});

test('ceiling attenuates the whole file uniformly instead of clipping when normalization is off', async () => {
  const { storage, project, options } = await fixture({ sample: frame => frame % 2 ? 1.6 : -.4 });
  const result = await renderMasteredRecording(storage, project, options), pcm = storage.samples(result.assetId);
  assert.ok(peak(pcm) <= 10 ** (-1 / 20)); assert.ok(Math.abs(pcm[0] / pcm[2] + .25) < 1e-7);
  assert.ok(result.analysis.outputGainDb < 0); assert.ok(result.analysis.inputPeakDb > 0);
});

test('silence stays silence with normalization enabled and reports nullable silence levels', async () => {
  const { storage, project, options } = await fixture({ frames: 17, sample: () => 0 });
  const result = await renderMasteredRecording(storage, project, { ...options, settings: { normalize: true, highpass: 80, compression: 1 } });
  assert.ok(storage.samples(result.assetId).every(value => value === 0));
  assert.equal(result.analysis.inputPeakDb, null); assert.equal(result.analysis.outputPeakDb, null); assert.equal(result.analysis.inputRmsDb, null); assert.equal(result.analysis.outputRmsDb, null); assert.equal(result.analysis.outputGainDb, 0);
});

test('high pass removes low frequency content and EQ changes its intended band without channel folding', async () => {
  const run = async (frequency, settings) => {
    const { storage, project, options } = await fixture({ frames: 24000, sample: (frame, channel) => Math.sin(frame * 2 * Math.PI * frequency / SR) * (channel ? -.1 : .1) });
    const result = await renderMasteredRecording(storage, project, { ...options, settings }); return rms(storage.samples(result.assetId), 8000);
  };
  assert.ok(await run(30, { highpass: 200 }) < await run(30, {}) * .04);
  assert.ok(await run(1500, { mid: 6 }) > await run(1500, {}) * 1.95);
  assert.ok(await run(50, { low: -12 }) < await run(50, {}) * .3);
});

test('preview from arbitrary offset matches the exact fully rendered samples including previous DSP history', async () => {
  const { storage, project, options } = await fixture(), originals = [...storage.assets.keys()];
  const settings = { gainDb: 4, low: 3, mid: -4, high: 2, highpass: 100, compression: .6, normalize: true, ceilingDb: -2 };
  const startFrame = PAGE - 29, previewSeconds = .111;
  const preview = await previewMasteredRecording(storage, project, { ...options, settings, startFrame, previewSeconds });
  assert.deepEqual([...storage.assets.keys()], originals); assert.equal(storage.writes.length, 0); assert.equal(storage.deleted.length, 0);
  const result = await renderMasteredRecording(storage, project, { ...options, settings }), expected = storage.samples(result.assetId).subarray(startFrame * 2, (startFrame + Math.round(SR * previewSeconds)) * 2);
  assert.deepEqual(await previewSamples(preview), expected); assert.equal(preview.startFrame, startFrame); assert.equal(preview.sourceFrames, result.frames);
  assert.equal(preview.analysis.outputGainDb, result.analysis.outputGainDb);
});

test('preview near the recording end stops exactly there and original comparison bypasses ceiling and all DSP', async () => {
  const { storage, project, options } = await fixture({ sample: (frame, channel) => channel ? -1.4 : 1.6 }), original = storage.samples('original');
  const startFrame = original.length / 2 - 53;
  const result = await previewMasteredRecording(storage, project, { ...options, original: true, startFrame, settings: { gainDb: -12, balance: 1, highpass: 2000, compression: 1, normalize: true } });
  assert.deepEqual(await previewSamples(result), original.subarray(startFrame * 2));
  assert.equal(result.frames, 53); assert.equal(result.analysis.outputGainDb, 0); assert.ok(result.analysis.outputPeakDb > 0);
  assert.equal(storage.writes.length, 0);
});

test('preview normalization sees a late peak beyond its preview interval', async () => {
  const { storage, project, options } = await fixture({ sample: frame => frame > PAGE * 2 ? .8 : .1 });
  const result = await previewMasteredRecording(storage, project, { ...options, previewSeconds: .1, settings: { normalize: true } });
  assert.ok(peak(await previewSamples(result)) < .12); assert.ok(result.analysis.processedPeakDb > -2);
});

test('all invalid settings are rejected before creating any output', async () => {
  const { storage, project, options } = await fixture();
  for (const settings of [null, [], { gainDb: 25 }, { gainDb: NaN }, { gainDb: null }, { balance: 2 }, { highpass: -1 }, { compression: 1.1 }, { normalize: 'true' }, { ceilingDb: .1 }, { low: -19 }]) {
    await assert.rejects(renderMasteredRecording(storage, project, { ...options, settings }), { code: 'INVALID_MASTER' });
    assert.deepEqual([...storage.assets.keys()], ['original']);
  }
  assert.deepEqual(normalizeMasterSettings(), DEFAULT_MASTER_SETTINGS);
});

test('recordings must be saved, nonempty, compatible metadata and belong to this project', async () => {
  for (const change of [{ projectId: 'other' }, { status: 'recording' }, { frames: 0 }, { channels: 3 }, { frames: SR * 86400 + 1 }, { sampleRate: 7 }]) {
    const { storage, project, options } = await fixture(); Object.assign(storage.assets.get('original'), change);
    await assert.rejects(prepareMasterPlan(storage, project, options)); assert.deepEqual([...storage.assets.keys()], ['original']);
  }
  const { storage, project, options } = await fixture(); project.sampleRate = 16000;
  await assert.rejects(prepareMasterPlan(storage, project, options), { code: 'RECORDING_NOT_READY' });
  assert.deepEqual([...storage.assets.keys()], ['original']);
});

test('known insufficient space blocks creation while unavailable estimates defer to checked writes', async () => {
  const { storage, project, options } = await fixture(); storage.estimate = async () => ({ quota: 100, usage: 99 });
  await assert.rejects(renderMasteredRecording(storage, project, options), { code: 'INSUFFICIENT_STORAGE' }); assert.deepEqual([...storage.assets.keys()], ['original']);
  storage.estimate = async () => { throw new Error('Not supported'); };
  assert.ok((await renderMasteredRecording(storage, project, options)).assetId);
});

test('bad source page lengths, channels and nonfinite samples fail without changing original or retaining output', async () => {
  for (const mutate of [page => ({ ...page, channels: 1 }), page => ({ ...page, frames: page.frames - 1 }), page => ({ ...page, buffer: page.buffer.slice(0, -4) }), page => { new Float32Array(page.buffer)[11] = NaN; return page; }]) {
    const { storage, project, options } = await fixture(), original = storage.samples('original'), read = storage.readPage.bind(storage);
    storage.readPage = async (...args) => mutate(await read(...args));
    await assert.rejects(renderMasteredRecording(storage, project, options), { code: 'DAMAGED_AUDIO' });
    assert.deepEqual([...storage.assets.keys()], ['original']); assert.deepEqual(storage.samples('original'), original);
  }
});

test('source PCM changes between analysis and rendering are detected by streaming hashes', async () => {
  const { storage, project, options } = await fixture({ frames: PAGE + 1 }), read = storage.readPage.bind(storage);
  let count = 0; storage.readPage = async (...args) => { const page = await read(...args); if (++count > 2) new Float32Array(page.buffer)[0] += .01; return page; };
  await assert.rejects(renderMasteredRecording(storage, project, options), { code: 'AUDIO_SNAPSHOT_MISMATCH' });
  assert.deepEqual([...storage.assets.keys()], ['original']);
});

test('source metadata changes during rendering discard the new output', async () => {
  const { storage, project, options } = await fixture();
  await assert.rejects(renderMasteredRecording(storage, project, { ...options, onProgress: progress => { if (progress.ratio === 1) storage.assets.get('original').sampleRate = 16000; } }), { code: 'AUDIO_SNAPSHOT_MISMATCH' });
  assert.deepEqual([...storage.assets.keys()], ['original']);
});

test('storage write failure and cancellation at analysis, output, and seal clean up only the new asset', async () => {
  for (const stage of ['write', 'analysis', 'output', 'seal']) {
    const { storage, project, options } = await fixture(), controller = new AbortController(), before = storage.samples('original');
    if (stage === 'write') storage.putPage = async () => { throw new Error('Disk full'); };
    if (stage === 'seal') { const finish = storage.finishAsset.bind(storage); storage.finishAsset = async (...args) => { const result = await finish(...args); controller.abort(); return result; }; }
    await assert.rejects(renderMasteredRecording(storage, project, { ...options, signal: controller.signal, onProgress: progress => { if ((stage === 'analysis' && progress.phase === 'analysing') || (stage === 'output' && progress.phase === 'mastering')) controller.abort(); } }), stage === 'write' ? /Disk full/ : { name: 'AbortError' });
    assert.deepEqual([...storage.assets.keys()], ['original']); assert.deepEqual(storage.samples('original'), before);
  }
});

test('cleanup failures identify only the provisional new asset', async () => {
  const { storage, project, options } = await fixture(); storage.putPage = async () => { throw new Error('Disk full'); }; storage.deleteAsset = async () => { throw new Error('Read only'); };
  await assert.rejects(renderMasteredRecording(storage, project, options), error => error.message === 'Disk full' && error.cleanupIds.length === 1 && error.cleanupIds[0].startsWith('master-'));
  assert.ok(storage.assets.has('original'));
});

class BrowserWorkerBridge {
  constructor(url) { this.worker = new NodeWorker(new URL('./export-worker-harness.mjs', import.meta.url), { workerData: { url: url.href } }); this.worker.on('message', data => this.onmessage?.({ data })); this.worker.on('error', error => this.onerror?.(error)); this.worker.on('messageerror', error => this.onmessageerror?.(error)); }
  postMessage(message, transfer) { this.worker.postMessage(message, transfer); }
  terminate() { return this.worker.terminate(); }
}
async function withWorker(action) { const previous = globalThis.Worker; globalThis.Worker = BrowserWorkerBridge; try { await action(); } finally { if (previous) globalThis.Worker = previous; else delete globalThis.Worker; } }

test('real worker exactly reproduces direct output and offset preview with transferred pages', async () => withWorker(async () => {
  const { storage, project, options } = await fixture(), settings = { compression: .5, gainDb: 5, low: 4, normalize: true };
  const direct = await renderMasteredRecording(storage, project, { ...options, settings });
  const threaded = await renderMasteredRecording(storage, project, { ...options, settings, useWorker: true });
  assert.deepEqual(storage.samples(threaded.assetId), storage.samples(direct.assetId)); assert.deepEqual(threaded.analysis, direct.analysis);
  const preview = await previewMasteredRecording(storage, project, { ...options, settings, useWorker: true, startFrame: 17003, previewSeconds: .04 });
  assert.deepEqual(await previewSamples(preview), storage.samples(direct.assetId).subarray(17003 * 2, (17003 + 320) * 2));
}));

test('worker cancellation waits for in-flight output writes before deleting its asset', async () => withWorker(async () => {
  const { storage, project, options } = await fixture(), controller = new AbortController(), write = storage.putPage.bind(storage); let completed = false;
  storage.putPage = async (...args) => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 15)); await write(...args); completed = true; };
  await assert.rejects(renderMasteredRecording(storage, project, { ...options, useWorker: true, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(completed); assert.deepEqual([...storage.assets.keys()], ['original']);
}));

test('invalid preview windows are rejected without persistent assets', async () => {
  const { storage, project, options } = await fixture();
  for (const change of [{ startFrame: -1 }, { startFrame: .5 }, { startFrame: PAGE * 2 + 317 }, { previewSeconds: 0 }, { previewSeconds: 61 }]) await assert.rejects(previewMasteredRecording(storage, project, { ...options, ...change }), { code: 'INVALID_MASTER' });
  assert.deepEqual([...storage.assets.keys()], ['original']); assert.equal(storage.writes.length, 0);
});

test('many source pages use bounded reads and writes, with monotonic progress and exact final length', async () => {
  const frames = PAGE * 31 + 73, channels = 2, progress = []; let written = 0, reads = 0;
  const result = await renderMasterFrames({ sourceAssetId: 'audio', frames, channels, sampleRate: SR, settings: {} }, {
    readPage: async (_id, index) => { reads++; const count = Math.min(PAGE, frames - index * PAGE); return { frames: count, channels, buffer: new Float32Array(count * channels).fill(.1).buffer }; },
    writePage: async (index, buffer, count, actualChannels) => { assert.equal(index, Math.floor(written / PAGE)); assert.equal(buffer.byteLength, PAGE * channels * 4); assert.equal(actualChannels, channels); written += count; },
    onProgress: value => progress.push(value.ratio),
  });
  assert.equal(written, frames); assert.equal(result.frames, frames); assert.equal(reads, 64); assert.equal(progress.at(-1), 1); assert.ok(progress.every((ratio, i) => i === 0 || ratio >= progress[i - 1]));
});

async function withFakeWorker(behavior, action) {
  const previous = globalThis.Worker, instances = [];
  globalThis.Worker = class {
    constructor() { this.terminated = false; instances.push(this); }
    postMessage(message) { behavior.call(this, message); }
    terminate() { this.terminated = true; }
    emit(message) { queueMicrotask(() => { if (!this.terminated) this.onmessage?.({ data: message }); }); }
  };
  try { await action(instances); } finally { if (previous) globalThis.Worker = previous; else delete globalThis.Worker; }
}

test('malformed worker requests cannot read another asset or write invalid output', async () => {
  const messages = [null,
    { type: 'rpc', requestId: 1, method: 'readPage', args: ['private-other-source', 0] },
    { type: 'rpc', requestId: 1, method: 'readPage', args: ['original', -1] },
    { type: 'rpc', requestId: 1, method: 'readPage', args: ['original', 3] },
    { type: 'rpc', requestId: 1, method: 'deleteAsset', args: ['original'] },
    { type: 'rpc', requestId: 1, method: 'putPage', args: [1, new ArrayBuffer(PAGE * 8), PAGE, 2] },
    { type: 'rpc', requestId: 1, method: 'putPage', args: [0, new ArrayBuffer(4), PAGE, 2] },
    { type: 'complete', result: { frames: PAGE * 2 + 317, sourceFrames: PAGE * 2 + 317, sampleRate: SR, channels: 2, analysis: { peakType: 'sample' }, settings: DEFAULT_MASTER_SETTINGS } },
  ];
  for (const message of messages) await withFakeWorker(function (command) { if (command.type === 'master') this.emit(message); }, async instances => {
    const { storage, project, options } = await fixture();
    await assert.rejects(renderMasteredRecording(storage, project, { ...options, useWorker: true, workerIdleTimeoutMs: 200 }), { code: 'MASTER_PROTOCOL' });
    assert.deepEqual([...storage.assets.keys()], ['original']); assert.equal(storage.writes.length, 0); assert.ok(instances[0].terminated);
  });
});

test('silent worker and failed startup terminate safely without a retained output', async () => {
  for (const startup of [false, true]) await withFakeWorker(function () { if (startup) throw new Error('Transport failed'); }, async instances => {
    const { storage, project, options } = await fixture();
    await assert.rejects(renderMasteredRecording(storage, project, { ...options, useWorker: true, workerIdleTimeoutMs: 10 }), startup ? /Transport failed/ : { code: 'MASTER_TIMEOUT' });
    assert.deepEqual([...storage.assets.keys()], ['original']); assert.ok(instances[0].terminated);
  });
});

test('worker cancellation does not wait for a stuck immutable read', async () => {
  await withFakeWorker(function (command) { if (command.type === 'master') this.emit({ type: 'rpc', requestId: 1, method: 'readPage', args: ['original', 0] }); }, async instances => {
    const { storage, project, options } = await fixture(), controller = new AbortController();
    storage.readPage = async () => { controller.abort(); return new Promise(() => {}); };
    await assert.rejects(renderMasteredRecording(storage, project, { ...options, useWorker: true, signal: controller.signal, workerIdleTimeoutMs: 100 }), { name: 'AbortError' });
    assert.deepEqual([...storage.assets.keys()], ['original']); assert.ok(instances[0].terminated);
  });
});

test('real worker propagates storage integrity error codes without replacing the original', async () => withWorker(async () => {
  const { storage, project, options } = await fixture();
  storage.readPage = async () => { throw Object.assign(new Error('Checksum mismatch'), { code: 'CORRUPT_PAGE' }); };
  await assert.rejects(renderMasteredRecording(storage, project, { ...options, useWorker: true }), { code: 'CORRUPT_PAGE' });
  assert.deepEqual([...storage.assets.keys()], ['original']);
}));

test('cancellation during output creation prevents renderer startup', async () => {
  await withFakeWorker(function () { throw new Error('Should not start'); }, async instances => {
    const { storage, project, options } = await fixture(), controller = new AbortController(), begin = storage.beginAsset.bind(storage);
    storage.beginAsset = async (...args) => { const result = await begin(...args); controller.abort(); return result; };
    await assert.rejects(renderMasteredRecording(storage, project, { ...options, useWorker: true, signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual([...storage.assets.keys()], ['original']); assert.equal(instances.length, 0);
  });
});
