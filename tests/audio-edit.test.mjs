import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetJournal, PAGE_FRAMES } from '../src/storage/core.mjs';
import { createAudioSelection, planAudioEdit, renderAudioEdit, summarizeAudioEditSource, MAX_AUDIO_EDIT_SECONDS } from '../src/audio/edit.mjs';

/** Uses the production journal, including finite-sample and CRC validation. */
function storageFixture() {
  const assets = new Map(), pages = new Map(), data = new Map(), reads = [], writes = [], deletes = [];
  const key = (id, index) => `${id}:${index}`;
  const adapter = {
    backend: 'indexeddb',
    async getAsset(id) { return structuredClone(assets.get(id)); },
    async createAsset(asset) { assets.set(asset.id, structuredClone(asset)); },
    async getPage(id, index) { return structuredClone(pages.get(key(id, index))); },
    async writeData(asset, page, buffer) { data.set(key(asset.id, page.index), buffer.slice(0, page.byteLength)); },
    async flush() {},
    async commitPage(asset, page) { assets.set(asset.id, structuredClone(asset)); pages.set(key(asset.id, page.index), structuredClone(page)); },
    async finishAsset(asset) { assets.set(asset.id, structuredClone(asset)); },
    async readData(asset, page) { return data.get(key(asset.id, page.index)).slice(0); },
  };
  const journal = new AssetJournal(adapter);
  const storage = {
    async getAsset(id) { return { ...await journal.get(id) }; },
    async beginAsset(metadata) { return journal.begin(metadata); },
    async readPage(id, index) { reads.push({ id, index }); return journal.read(id, index); },
    async putPage(id, index, buffer, frames, channels) {
      writes.push({ id, index, bytes: buffer.byteLength, frames, channels });
      // Match StorageClient's transferred-buffer ownership.
      return journal.write(id, index, structuredClone(buffer, { transfer: [buffer] }), frames, channels);
    },
    async finishAsset(id, options) { return journal.finish(id, options); },
    async deleteAsset(id) {
      deletes.push(id); assets.delete(id); journal.assets.delete(id); journal.failures.delete(id);
      for (const name of data.keys()) if (name.startsWith(`${id}:`)) { data.delete(name); pages.delete(name); }
    },
  };
  async function seed(values, { id = 'source', channels = 1, sampleRate = 48000, projectId = 'project', status = 'complete' } = {}) {
    const samples = Float32Array.from(values), frames = samples.length / channels;
    await storage.beginAsset({ id, projectId, sampleRate, channels });
    for (let start = 0, index = 0; start < frames; start += PAGE_FRAMES, index++) {
      const count = Math.min(PAGE_FRAMES, frames - start);
      await storage.putPage(id, index, samples.slice(start * channels, (start + count) * channels).buffer, count, channels);
    }
    const asset = await storage.finishAsset(id, { frames, status });
    reads.length = 0; writes.length = 0;
    return asset;
  }
  function pcm(id) {
    const asset = assets.get(id), output = new Float32Array(asset.frames * asset.channels);
    for (let index = 0; index < asset.pageCount; index++) output.set(new Float32Array(data.get(key(id, index))), index * PAGE_FRAMES * asset.channels);
    return output;
  }
  return { storage, seed, pcm, assets, pages, data, reads, writes, deletes, journal };
}
const metadata = { id: 'edited', projectId: 'project', name: 'Edited loop' };
const render = (fixture, asset, edit, options = {}) => renderAudioEdit(fixture.storage, { asset, edit, metadata, ...options });
const vector = length => Float32Array.from({ length }, (_, i) => ((i * 37) % 201 - 100) / 128);

test('selection is an immutable, sample-accurate half-open range without PCM allocation', async () => {
  const f = storageFixture(), asset = await f.seed([0.1, 0.2, 0.3, 0.4]);
  const selected = createAudioSelection(asset, { startFrame: 1, endFrame: 3 });
  assert.equal(selected.frames, 2); assert.equal(selected.assetFrames, 4); assert.ok(Object.isFrozen(selected));
  assert.throws(() => { selected.startFrame = 0; }, TypeError);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
  const plan = planAudioEdit(asset, { type: 'trim', startFrame: 1, endFrame: 3 });
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.segments)); assert.ok(Object.isFrozen(plan.segments[0]));
});

for (const channels of [1, 2]) {
  test(`${channels}-channel trim preserves exact PCM across both page edges`, async () => {
    const f = storageFixture(), input = vector((PAGE_FRAMES * 3 + 17) * channels), asset = await f.seed(input, { channels });
    const startFrame = PAGE_FRAMES - 3, endFrame = PAGE_FRAMES * 2 + 9;
    const output = await render(f, asset, { type: 'trim', startFrame, endFrame });
    assert.equal(output.frames, endFrame - startFrame); assert.equal(output.channels, channels); assert.equal(output.status, 'complete');
    assert.deepEqual(f.pcm(output.id), input.slice(startFrame * channels, endFrame * channels));
    assert.deepEqual(f.pcm(asset.id), input, 'original remains byte-for-byte unchanged');
    assert.deepEqual(f.reads.map(read => read.index), [0, 1, 2]);
    assert.ok(f.writes.every(page => page.bytes <= PAGE_FRAMES * channels * 4));
    assert.deepEqual(f.writes.map(page => page.frames), [PAGE_FRAMES, 12]);
  });
}

for (const extension of ['repeat', 'silence']) {
  for (const channels of [1, 2]) {
    test(`${extension} extension has exact requested length and preserves ${channels} channels`, async () => {
      const f = storageFixture(), input = vector(7 * channels), asset = await f.seed(input, { channels });
      const output = await render(f, asset, { type: 'resize', frames: PAGE_FRAMES + 13, extension });
      const expected = new Float32Array(output.frames * channels);
      for (let i = 0; i < expected.length; i++) expected[i] = extension === 'repeat' ? input[i % input.length] : (input[i] ?? 0);
      assert.deepEqual(f.pcm(output.id), expected); assert.deepEqual(f.pcm(asset.id), input);
      assert.equal(f.reads.length, 1, 'short repeated input remains a single cached page');
      assert.equal(f.writes.length, 2); assert.equal(output.byteLength, expected.byteLength);
    });
  }
}

test('shortening and a one-frame loop are exact, without an accidental trailing frame', async () => {
  const f = storageFixture(), asset = await f.seed([0.5, -0, 0.75]);
  await render(f, asset, { type: 'resize', frames: 1, extension: 'silence' });
  assert.deepEqual(f.pcm('edited'), Float32Array.of(0.5));
  await render(f, asset, { type: 'trim', startFrame: 1, endFrame: 2 }, { metadata: { ...metadata, id: 'one-sample' } });
  assert.ok(Object.is(f.pcm('one-sample')[0], -0), 'float32 signed zero is retained exactly');
});

test('same-asset overlapping insert reads the frozen original rather than edited output', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3, 4, 5, 6]);
  const selection = createAudioSelection(asset, { startFrame: 1, endFrame: 5 });
  await render(f, asset, { type: 'paste', mode: 'insert', startFrame: 3, selection });
  assert.deepEqual([...f.pcm('edited')], [1, 2, 3, 2, 3, 4, 5, 4, 5, 6]);
  assert.deepEqual([...f.pcm('source')], [1, 2, 3, 4, 5, 6]);
  assert.ok(f.reads.every(read => read.id === 'source'));
});

test('replace permits a different selection length and preserves untouched prefix/suffix', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3, 4, 5, 6]);
  const other = await f.seed([7, 8, 9, 10], { id: 'other' });
  await render(f, asset, { type: 'paste', mode: 'replace', startFrame: 1, endFrame: 5,
    selection: createAudioSelection(other, { startFrame: 1, endFrame: 3 }) });
  assert.deepEqual([...f.pcm('edited')], [1, 8, 9, 6]);
  assert.deepEqual([...f.pcm('other')], [7, 8, 9, 10]);
});

for (const atEnd of [false, true]) {
  test(`insert at ${atEnd ? 'EOF' : 'frame zero'} and replacement of the whole source work`, async () => {
    const f = storageFixture(), asset = await f.seed([1, 2, 3]), other = await f.seed([8, 9], { id: 'other' });
    const selection = createAudioSelection(other);
    await render(f, asset, { type: 'paste', mode: 'insert', startFrame: atEnd ? 3 : 0, selection });
    assert.deepEqual([...f.pcm('edited')], atEnd ? [1, 2, 3, 8, 9] : [8, 9, 1, 2, 3]);
    await render(f, asset, { type: 'paste', mode: 'replace', startFrame: 0, endFrame: 3, selection }, { metadata: { ...metadata, id: 'replaced' } });
    assert.deepEqual([...f.pcm('replaced')], [8, 9]);
  });
}

for (const targetChannels of [1, 2]) {
  test(`pasting ${targetChannels === 1 ? 'stereo into mono promotes the loop' : 'mono into stereo duplicates the mono channel'}`, async () => {
    const f = storageFixture(), target = await f.seed(targetChannels === 1 ? [1, 2] : [1, -1, 2, -2], { channels: targetChannels });
    const other = await f.seed(targetChannels === 1 ? [3, -3, 4, -4] : [3, 4], { id: 'other', channels: 3 - targetChannels });
    const output = await render(f, target, { type: 'paste', mode: 'insert', startFrame: 1, selection: createAudioSelection(other) });
    assert.equal(output.channels, 2);
    assert.deepEqual([...f.pcm('edited')], targetChannels === 1 ? [1, 1, 3, -3, 4, -4, 2, 2] : [1, -1, 3, 3, 4, 4, 2, -2]);
  });
}

test('page-sized paste spanning source and destination page boundaries matches a flat independent oracle', async () => {
  const f = storageFixture(), left = vector(PAGE_FRAMES * 2 + 17), right = vector(PAGE_FRAMES * 2 + 43).map(x => x / 2);
  const asset = await f.seed(left), other = await f.seed(right, { id: 'other' });
  const selection = createAudioSelection(other, { startFrame: PAGE_FRAMES - 3, endFrame: PAGE_FRAMES * 2 + 9 });
  const startFrame = PAGE_FRAMES - 7, endFrame = PAGE_FRAMES + 4;
  await render(f, asset, { type: 'paste', mode: 'replace', startFrame, endFrame, selection });
  assert.deepEqual(f.pcm('edited'), Float32Array.from([...left.slice(0, startFrame), ...right.slice(selection.startFrame, selection.endFrame), ...left.slice(endFrame)]));
  assert.ok(f.writes.every(page => page.bytes <= PAGE_FRAMES * 4));
});

test('invalid selections and unsafe lengths reject before any storage read or allocation', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]);
  const ranges = [{ startFrame: -1, endFrame: 1 }, { startFrame: 1, endFrame: 1 }, { startFrame: 2, endFrame: 1 },
    { startFrame: 0, endFrame: 4 }, { startFrame: 0.5, endFrame: 1 }, { startFrame: NaN, endFrame: 2 }, { startFrame: 0, endFrame: Infinity }];
  for (const range of ranges) {
    assert.throws(() => createAudioSelection(asset, range), { code: 'EDIT_RANGE_INVALID' });
    await assert.rejects(render(f, asset, { type: 'trim', ...range }), { code: 'EDIT_RANGE_INVALID' });
  }
  for (const frames of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(render(f, asset, { type: 'resize', frames, extension: 'repeat' }), { code: 'EDIT_LENGTH_INVALID' });
  }
  await assert.rejects(render(f, asset, { type: 'resize', frames: 4, extension: 'stretch' }), { code: 'EDIT_LENGTH_INVALID' });
  assert.equal(f.assets.size, 1); assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});

test('a one-frame repeat has one bounded plan segment and refuses edits exceeding 24 hours', async () => {
  const f = storageFixture(), asset = await f.seed([0.5]);
  const frames = MAX_AUDIO_EDIT_SECONDS * asset.sampleRate;
  const plan = planAudioEdit(asset, { type: 'resize', frames, extension: 'repeat' });
  assert.equal(plan.segments.length, 1); assert.equal(plan.frames, frames); assert.equal(plan.segments[0].source.frames, 1);
  await assert.rejects(render(f, asset, { type: 'resize', frames: frames + 1, extension: 'repeat' }), { code: 'EDIT_LENGTH_LIMIT' });
  assert.equal(f.assets.size, 1); assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});

test('clipboard/project/rate mismatch and ambiguous insert cannot silently change the selected audio', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]), selection = createAudioSelection(asset, { startFrame: 0, endFrame: 1 });
  for (const [patch, code] of [[{ frames: 2 }, 'EDIT_RANGE_INVALID'], [{ projectId: 'elsewhere' }, 'EDIT_PROJECT_MISMATCH'], [{ sampleRate: 44100 }, 'EDIT_RATE_MISMATCH']]) {
    await assert.rejects(render(f, asset, { type: 'paste', startFrame: 1, selection: { ...selection, ...patch } }), { code });
  }
  await assert.rejects(render(f, asset, { type: 'paste', mode: 'insert', startFrame: 0, endFrame: 1, selection }), { code: 'EDIT_RANGE_INVALID' });
  await assert.rejects(render(f, asset, { type: 'paste', mode: 'replace', startFrame: 1, endFrame: 1, selection }), { code: 'EDIT_RANGE_INVALID' });
  assert.equal(f.assets.size, 1); assert.deepEqual(f.reads, []);
});

test('sources must be sealed and valid, and overwrite or foreign output is always rejected', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]), edit = { type: 'trim', startFrame: 0, endFrame: 2 };
  for (const status of ['recording', 'cancelled', undefined]) await assert.rejects(render(f, { ...asset, status }, edit), { code: 'EDIT_SOURCE_ACTIVE' });
  for (const patch of [{ frames: 0 }, { channels: 3 }, { sampleRate: 1 }, { pageFrames: 128 }, { frames: Number.MAX_SAFE_INTEGER }]) {
    await assert.rejects(render(f, { ...asset, ...patch }, edit), { code: 'EDIT_SOURCE_INVALID' });
  }
  await assert.rejects(render(f, asset, edit, { metadata: { ...metadata, id: asset.id } }), { code: 'EDIT_SOURCE_OVERWRITE' });
  await assert.rejects(render(f, asset, edit, { metadata: { ...metadata, projectId: 'other-project' } }), { code: 'EDIT_PROJECT_MISMATCH' });
  assert.deepEqual([...f.pcm('source')], [1, 2, 3]); assert.deepEqual(f.deletes, []);
});

test('changed source identity or dimensions after copying reject before creation', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]), other = await f.seed([4, 5], { id: 'other' });
  const selection = createAudioSelection(other), originalGet = f.storage.getAsset;
  f.storage.getAsset = async id => ({ ...await originalGet(id), ...(id === 'other' ? { finishedAt: other.finishedAt + 1 } : {}) });
  await assert.rejects(render(f, asset, { type: 'paste', startFrame: 1, selection }), { code: 'EDIT_SOURCE_CHANGED' });
  assert.equal(f.assets.size, 2); assert.deepEqual(f.reads, []); assert.deepEqual(f.deletes, []);
});

for (const fault of ['missing', 'short', 'dimensions', 'index', 'nonfinite', 'crc']) {
  test(`${fault} source page damage aborts and cleans only the new asset`, async () => {
    const f = storageFixture(), input = vector(PAGE_FRAMES + 19), asset = await f.seed(input), originalRead = f.storage.readPage;
    if (fault === 'crc') new Uint8Array(f.data.get('source:1'))[0] ^= 1;
    else f.storage.readPage = async (id, index) => {
      const page = await originalRead(id, index); if (index !== 1) return page;
      if (fault === 'missing') return { missing: true };
      if (fault === 'short') page.buffer = page.buffer.slice(0, page.buffer.byteLength - 4);
      if (fault === 'dimensions') page.frames--;
      if (fault === 'index') page.index = 0;
      if (fault === 'nonfinite') new Float32Array(page.buffer)[0] = NaN;
      return page;
    };
    const originalBytes = f.pcm('source').slice();
    await assert.rejects(render(f, asset, { type: 'trim', startFrame: 0, endFrame: asset.frames }), {
      code: fault === 'crc' ? 'CORRUPT_PAGE' : fault === 'nonfinite' ? 'EDIT_SOURCE_SAMPLE_INVALID' : 'EDIT_SOURCE_PAGE_INVALID',
    });
    assert.deepEqual(f.deletes, ['edited']); assert.equal(f.assets.has('edited'), false);
    assert.deepEqual(f.pcm('source'), originalBytes, 'even damaged source bytes are never altered');
  });
}

for (const fault of ['write', 'seal', 'incomplete', 'progress']) {
  test(`${fault} failure leaves source unchanged and removes unpublished PCM`, async () => {
    const f = storageFixture(), input = vector(PAGE_FRAMES + 19), asset = await f.seed(input), originalPut = f.storage.putPage, originalFinish = f.storage.finishAsset;
    if (fault === 'write') f.storage.putPage = async (...args) => { if (args[1] === 1) throw Object.assign(new Error('No space'), { name: 'QuotaExceededError' }); return originalPut(...args); };
    if (fault === 'seal') f.storage.finishAsset = async (id, options) => { if (options.frames) throw new Error('Seal failed'); return originalFinish(id, options); };
    if (fault === 'incomplete') f.storage.finishAsset = async (id, options) => ({ ...await originalFinish(id, options), status: 'interrupted' });
    await assert.rejects(render(f, asset, { type: 'resize', frames: PAGE_FRAMES * 2, extension: 'repeat' }, {
      onProgress: fault === 'progress' ? p => { if (p.frames) throw new Error('UI stopped'); } : undefined,
    }));
    assert.deepEqual(f.pcm('source'), input); assert.deepEqual(f.deletes, ['edited']); assert.equal(f.assets.size, 1);
  });
}

test('aborted edits clean their new PCM; aborted-before-start and identifier collisions delete nothing', async () => {
  const f = storageFixture(), input = vector(PAGE_FRAMES + 19), asset = await f.seed(input), abort = new AbortController();
  await assert.rejects(render(f, asset, { type: 'resize', frames: PAGE_FRAMES * 3, extension: 'repeat' }, {
    signal: abort.signal, onProgress: p => { if (p.frames) abort.abort(); },
  }), { name: 'AbortError' });
  assert.equal(f.writes.length, 1); assert.deepEqual(f.deletes, ['edited']); assert.deepEqual(f.pcm('source'), input);
  f.deletes.length = 0;
  await assert.rejects(render(f, asset, { type: 'trim', startFrame: 0, endFrame: 1 }, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(f.deletes, []);
  await f.seed([99], { id: 'edited' });
  await assert.rejects(render(f, asset, { type: 'trim', startFrame: 0, endFrame: 1 }), { code: 'ASSET_EXISTS' });
  assert.deepEqual(f.deletes, []); assert.deepEqual([...f.pcm('edited')], [99]);
});

test('failed cleanup identifies only the new retained asset and preserves the original error', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]), cause = Object.assign(new Error('Quota full'), { name: 'QuotaExceededError' });
  f.storage.putPage = async () => { throw cause; }; f.storage.deleteAsset = async () => { throw new Error('Disk unavailable'); };
  await assert.rejects(render(f, asset, { type: 'resize', frames: 7, extension: 'repeat' }), failure => failure === cause && failure.cleanupAssetId === 'edited');
  assert.equal(f.assets.get('edited').status, 'cancelled'); assert.deepEqual([...f.pcm('source')], [1, 2, 3]);
});

test('caller changes during an edit cannot redirect writes or failure cleanup to the source', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]), destination = { ...metadata };
  const abort = new AbortController();
  await assert.rejects(render(f, asset, { type: 'resize', frames: PAGE_FRAMES * 2, extension: 'repeat' }, {
    metadata: destination, signal: abort.signal,
    onProgress: progress => {
      destination.id = asset.id; destination.projectId = 'foreign-project';
      if (progress.frames) abort.abort();
    },
  }), { name: 'AbortError' });
  assert.ok(f.writes.every(page => page.id === 'edited')); assert.deepEqual(f.deletes, ['edited']);
  assert.deepEqual([...f.pcm('source')], [1, 2, 3]);
});

test('progress counts durably written frames and ends exactly at the requested length', async () => {
  const f = storageFixture(), asset = await f.seed([1, 2, 3]), updates = [];
  const result = await render(f, asset, { type: 'resize', frames: PAGE_FRAMES + 1, extension: 'silence' }, { onProgress: p => updates.push(p) });
  assert.deepEqual(updates.map(p => p.frames), [0, PAGE_FRAMES, PAGE_FRAMES + 1]);
  assert.ok(updates.every(p => p.totalFrames === result.frames)); assert.equal(updates.at(-1).ratio, 1);
});

test('full-duration waveform includes isolated transients on every page and keeps bins proportional to actual time', async () => {
  const f = storageFixture(), frames = PAGE_FRAMES * 31 + 13, input = new Float32Array(frames * 2), points = 400;
  const expected = Array(points).fill(0);
  // Signals in all 32 pages, including pages the former twelve-page sampler
  // skipped, plus both endpoints and every exact waveform-bin boundary.
  const spikes = [0, frames - 1];
  for (let index = 0; index < 32; index++) spikes.push(Math.min(frames - 1, index * PAGE_FRAMES + 7));
  for (let bin = 1; bin < points; bin++) spikes.push(Math.ceil(bin * frames / points));
  for (let index = 0; index < spikes.length; index++) {
    const position = spikes[index], channel = index % 2, amplitude = (index % 99 + 1) / 100;
    input[position * 2 + channel] = index % 3 ? amplitude : -amplitude;
  }
  for (let frame = 0; frame < frames; frame++) {
    const bin = Math.floor(frame * points / frames);
    expected[bin] = Math.max(expected[bin], Math.abs(input[frame * 2]), Math.abs(input[frame * 2 + 1]));
  }
  const asset = await f.seed(input, { channels: 2 }), progress = [];
  const peaks = await summarizeAudioEditSource(f.storage, asset, { points, onProgress: value => progress.push(value) });
  assert.deepEqual(peaks, expected); assert.equal(peaks.length, points);
  assert.deepEqual(f.reads.map(read => read.index), Array.from({ length: 32 }, (_, i) => i));
  assert.equal(progress[0].frames, 0); assert.equal(progress.at(-1).frames, frames); assert.equal(progress.at(-1).ratio, 1);
  assert.deepEqual(f.writes, []); assert.deepEqual(f.deletes, []); assert.equal(f.assets.size, 1);
  assert.deepEqual(f.pcm(asset.id), input);
});

test('waveform bins cover small uneven sources without empty phantom bins', async () => {
  const f = storageFixture(), asset = await f.seed([1, -2, 3, -4, 5]);
  assert.deepEqual(await summarizeAudioEditSource(f.storage, asset, { points: 3 }), [2, 4, 5]);
  assert.deepEqual(await summarizeAudioEditSource(f.storage, asset), [1, 2, 3, 4, 5]);
  assert.deepEqual(await summarizeAudioEditSource(f.storage, asset, { points: 1 }), [5]);
});

test('waveform scan cancellation stops after the current page and never creates or deletes assets', async () => {
  const f = storageFixture(), asset = await f.seed(vector(PAGE_FRAMES * 3 + 9)), abort = new AbortController();
  await assert.rejects(summarizeAudioEditSource(f.storage, asset, {
    signal: abort.signal, onProgress: progress => { if (progress.frames) abort.abort(); },
  }), { name: 'AbortError' });
  assert.equal(f.reads.length, 1); assert.deepEqual(f.writes, []); assert.deepEqual(f.deletes, []); assert.equal(f.assets.size, 1);
  f.reads.length = 0;
  await assert.rejects(summarizeAudioEditSource(f.storage, asset, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(f.reads, []);
});

test('waveform rejects damaged source pages and invalid point counts instead of drawing fabricated silence', async () => {
  const f = storageFixture(), asset = await f.seed(vector(PAGE_FRAMES + 17));
  for (const points of [0, -1, 1.5, 4097, NaN, Infinity]) {
    await assert.rejects(summarizeAudioEditSource(f.storage, asset, { points }), { code: 'EDIT_WAVEFORM_INVALID' });
  }
  assert.deepEqual(f.reads, []);
  new Uint8Array(f.data.get('source:1'))[0] ^= 1;
  await assert.rejects(summarizeAudioEditSource(f.storage, asset), { code: 'CORRUPT_PAGE' });
  assert.deepEqual(f.writes, []); assert.deepEqual(f.deletes, []);
  const originalRead = f.storage.readPage;
  f.storage.readPage = async (...args) => ({ ...await originalRead(...args), frames: 1 });
  await assert.rejects(summarizeAudioEditSource(f.storage, asset), { code: 'EDIT_SOURCE_PAGE_INVALID' });
});

test('render builds the full edited waveform during its existing write pass with no output reread', async () => {
  const f = storageFixture(), input = vector(PAGE_FRAMES * 15 + 17), asset = await f.seed(input);
  const result = await render(f, asset, { type: 'resize', frames: PAGE_FRAMES * 21 + 9, extension: 'silence' });
  assert.equal(result.peaks.length, 400); assert.ok(f.reads.every(read => read.id === asset.id));
  assert.equal(f.reads.length, 16, 'each original page read once');
  const writes = f.writes.length;
  assert.deepEqual(result.peaks, await summarizeAudioEditSource(f.storage, result));
  assert.equal(f.writes.length, writes, 'independent waveform verification only reads');
});
