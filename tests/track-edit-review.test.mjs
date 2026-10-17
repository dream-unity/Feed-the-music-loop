import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioSelection, renderAudioEdit } from '../src/audio/edit.mjs';
import { PAGE_FRAMES } from '../src/storage/core.mjs';

// An independent, direct sample-array oracle checks the paged implementation.
// The seed is fixed so every failure is reproducible without random retries.
test('edited PCM matches an independent oracle across seeded ranges, channels and page boundaries', async () => {
  let seed = 0x72616e67;
  const choose = max => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; };
  const lengths = [1, 2, 19, PAGE_FRAMES - 1, PAGE_FRAMES, PAGE_FRAMES + 1, PAGE_FRAMES * 2 + 37];
  let assertions = 0;
  for (let scenario = 0; scenario < 120; scenario++) {
    const leftFrames = lengths[choose(lengths.length)], rightFrames = lengths[choose(lengths.length)];
    const leftChannels = 1 + choose(2), rightChannels = 1 + choose(2);
    const assets = new Map(), originals = new Map(), outputPages = [];
    const add = (id, frames, channels, phase) => {
      const asset = { id, projectId: 'edit-review', sampleRate: 48000, channels, frames, status: 'complete' };
      assets.set(id, asset);
      originals.set(id, Float32Array.from({ length: frames * channels }, (_, i) => (((i * 19 + phase) % 1024) - 512) / 1024));
      return asset;
    };
    const asset = add('destination', leftFrames, leftChannels, 11);
    const source = scenario % 3 === 0 ? asset : add('source', rightFrames, rightChannels, 83);
    const originalMetadata = structuredClone(asset);
    const start = choose(source.frames), end = start + 1 + choose(source.frames - start);
    const selection = createAudioSelection(source, { startFrame: start, endFrame: end });
    let edit;
    const operation = scenario % 5;
    if (operation === 0) {
      const startFrame = choose(asset.frames);
      edit = { type: 'trim', startFrame, endFrame: startFrame + 1 + choose(asset.frames - startFrame) };
    } else if (operation <= 2) {
      edit = { type: 'resize', frames: 1 + choose(asset.frames * 3 + 7), extension: operation === 1 ? 'repeat' : 'silence' };
    } else if (operation === 3) {
      edit = { type: 'paste', mode: 'insert', startFrame: choose(asset.frames + 1), selection };
    } else {
      const startFrame = choose(asset.frames);
      edit = { type: 'paste', mode: 'replace', startFrame, endFrame: startFrame + 1 + choose(asset.frames - startFrame), selection };
    }
    const channels = edit.type === 'paste' ? Math.max(asset.channels, source.channels) : asset.channels;
    const readFrames = (from, startFrame, endFrame) => {
      const samples = originals.get(from.id), result = [];
      for (let f = startFrame; f < endFrame; f++) for (let c = 0; c < channels; c++) result.push(samples[f * from.channels + (from.channels === 1 ? 0 : c)]);
      return result;
    };
    let expected;
    if (edit.type === 'trim') expected = readFrames(asset, edit.startFrame, edit.endFrame);
    else if (edit.type === 'resize') {
      expected = readFrames(asset, 0, Math.min(asset.frames, edit.frames));
      for (let f = asset.frames; f < edit.frames; f++) {
        expected.push(...(edit.extension === 'repeat' ? readFrames(asset, f % asset.frames, f % asset.frames + 1) : Array(channels).fill(0)));
      }
    } else {
      expected = readFrames(asset, 0, edit.startFrame)
        .concat(readFrames(source, start, end), readFrames(asset, edit.mode === 'replace' ? edit.endFrame : edit.startFrame, asset.frames));
    }
    const storage = {
      async getAsset(id) { return structuredClone(assets.get(id)); },
      async beginAsset(input) { assert.ok(!assets.has(input.id)); assets.set(input.id, { ...input, frames: 0, status: 'recording' }); },
      async readPage(id, index) {
        const from = assets.get(id), first = index * PAGE_FRAMES, frames = Math.min(PAGE_FRAMES, from.frames - first);
        return { index, frames, channels: from.channels, buffer: originals.get(id).slice(first * from.channels, (first + frames) * from.channels).buffer };
      },
      async putPage(id, index, buffer, frames, pageChannels) {
        assert.equal(id, 'output'); assert.equal(index, outputPages.length); assert.ok(frames <= PAGE_FRAMES);
        assert.equal(pageChannels, channels); assert.equal(buffer.byteLength, frames * channels * 4);
        outputPages.push(new Float32Array(structuredClone(buffer, { transfer: [buffer] })));
        assets.get(id).frames += frames;
      },
      async finishAsset(id, { frames }) { const output = assets.get(id); assert.equal(output.frames, frames); output.status = 'complete'; return structuredClone(output); },
      async deleteAsset(id) { assert.equal(id, 'output'); assets.delete(id); },
    };
    const result = await renderAudioEdit(storage, { asset, edit, metadata: { id: 'output', projectId: asset.projectId } });
    assert.equal(result.frames * channels, expected.length, `scenario ${scenario} length`);
    assert.deepEqual(outputPages.flatMap(page => [...page]), expected, `scenario ${scenario}: ${edit.type}/${edit.mode || edit.extension || ''}`);
    assert.deepEqual(assets.get(asset.id), originalMetadata, 'The source metadata cannot change');
    assertions++;
  }
  assert.equal(assertions, 120);
});
