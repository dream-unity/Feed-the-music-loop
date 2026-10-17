import { PAGE_FRAMES, validId } from '../storage/core.mjs';

/** Audio edits use integer, half-open frame ranges. Source PCM is never changed. */
const sealedStatuses = new Set(['complete', 'interrupted', 'recovered']);
export const MAX_AUDIO_EDIT_SECONDS = 24 * 60 * 60;
const error = (code, message) => Object.assign(new Error(message), { name: 'AudioEditError', code });
const frame = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message) => { throw error(code, message); };

function assertAsset(asset) {
  if (!asset) fail('EDIT_SOURCE_MISSING', 'The original audio is no longer available.');
  validId(asset.id); validId(asset.projectId, 'Project');
  if (!sealedStatuses.has(asset.status)) fail('EDIT_SOURCE_ACTIVE', 'Finish or recover this recording before editing its audio.');
  if (!frame(asset.frames) || asset.frames < 1 || ![1, 2].includes(asset.channels)
    || !Number.isInteger(asset.sampleRate) || asset.sampleRate < 8000 || asset.sampleRate > 192000
    || !Number.isSafeInteger(asset.frames * asset.channels * 4)
    || (asset.pageFrames !== undefined && asset.pageFrames !== PAGE_FRAMES)) {
    fail('EDIT_SOURCE_INVALID', 'The original audio has invalid length or format information.');
  }
}

function assertRange(startFrame, endFrame, frames, { empty = false } = {}) {
  if (!frame(startFrame) || !frame(endFrame) || startFrame > endFrame || endFrame > frames || (!empty && startFrame === endFrame)) {
    fail('EDIT_RANGE_INVALID', 'Choose a valid audio range containing at least one sample.');
  }
}

/** The clipboard holds an immutable source reference, never a full PCM buffer. */
export function createAudioSelection(asset, { startFrame = 0, endFrame = asset?.frames } = {}) {
  assertAsset(asset); assertRange(startFrame, endFrame, asset.frames);
  return Object.freeze({ assetId: asset.id, projectId: asset.projectId, sampleRate: asset.sampleRate,
    channels: asset.channels, assetFrames: asset.frames, startFrame, endFrame, frames: endFrame - startFrame,
    ...(asset.createdAt !== undefined ? { createdAt: asset.createdAt } : {}),
    ...(asset.finishedAt !== undefined ? { finishedAt: asset.finishedAt } : {}) });
}

function copySelection(selection) {
  if (!selection || typeof selection !== 'object') fail('EDIT_CLIPBOARD_EMPTY', 'Copy an audio selection before pasting.');
  const result = createAudioSelection({ id: selection.assetId, projectId: selection.projectId,
    sampleRate: selection.sampleRate, channels: selection.channels, frames: selection.assetFrames, status: 'complete',
    createdAt: selection.createdAt, finishedAt: selection.finishedAt }, selection);
  if (result.frames !== selection.frames) fail('EDIT_RANGE_INVALID', 'The copied audio selection has inconsistent length information.');
  return result;
}

/** A repeat remains one segment, even for hours of audio or a one-frame source. */
export function planAudioEdit(asset, edit) {
  assertAsset(asset);
  if (!edit || typeof edit !== 'object') fail('EDIT_OPERATION_INVALID', 'Choose an audio edit.');
  const segments = [], source = createAudioSelection(asset);
  let channels = asset.channels;
  const audio = (selection, frames = selection.frames) => { if (frames) segments.push(Object.freeze({ type: 'audio', source: selection, frames })); };
  const slice = (startFrame, endFrame) => { if (endFrame > startFrame) audio(createAudioSelection(asset, { startFrame, endFrame })); };
  if (edit.type === 'trim') {
    assertRange(edit.startFrame, edit.endFrame, asset.frames);
    slice(edit.startFrame, edit.endFrame);
  } else if (edit.type === 'resize') {
    if (!frame(edit.frames) || edit.frames < 1 || !['repeat', 'silence'].includes(edit.extension)) {
      fail('EDIT_LENGTH_INVALID', 'Choose a positive length and either repeat the audio or add silence.');
    }
    if (edit.frames <= asset.frames) slice(0, edit.frames);
    else if (edit.extension === 'repeat') audio(source, edit.frames);
    else { audio(source); segments.push(Object.freeze({ type: 'silence', frames: edit.frames - asset.frames })); }
  } else if (edit.type === 'paste') {
    const selection = copySelection(edit.selection), mode = edit.mode ?? 'insert';
    if (!['insert', 'replace'].includes(mode)) fail('EDIT_OPERATION_INVALID', 'Choose insert or replace for pasted audio.');
    const endFrame = mode === 'insert' ? edit.startFrame : edit.endFrame;
    assertRange(edit.startFrame, endFrame, asset.frames, { empty: mode === 'insert' });
    if (mode === 'insert' && edit.endFrame !== undefined && edit.endFrame !== edit.startFrame) {
      fail('EDIT_RANGE_INVALID', 'An insert uses one position. Choose replace to remove a selected range.');
    }
    if (selection.projectId !== asset.projectId) fail('EDIT_PROJECT_MISMATCH', 'Copy audio from the current project before pasting.');
    if (selection.sampleRate !== asset.sampleRate) fail('EDIT_RATE_MISMATCH', 'The copied audio has a different sample rate. Import it into this project before pasting.');
    // Preserve both stereo channels. A mono destination is promoted to stereo.
    channels = Math.max(channels, selection.channels);
    slice(0, edit.startFrame); audio(selection); slice(endFrame, asset.frames);
  } else fail('EDIT_OPERATION_INVALID', 'This audio edit is not supported.');
  const frames = segments.reduce((sum, segment) => sum + segment.frames, 0);
  if (!frame(frames) || frames < 1 || !Number.isSafeInteger(frames * channels * 4)) {
    fail('EDIT_LENGTH_INVALID', 'The edited audio length is too large.');
  }
  if (frames > asset.sampleRate * MAX_AUDIO_EDIT_SECONDS) {
    fail('EDIT_LENGTH_LIMIT', 'One edited audio file can be up to 24 hours long. Choose a shorter length.');
  }
  return Object.freeze({ projectId: asset.projectId, sampleRate: asset.sampleRate, channels, frames,
    byteLength: frames * channels * 4, segments: Object.freeze(segments) });
}

function checkAbort(signal) {
  if (signal?.aborted) throw Object.assign(new Error('Audio edit cancelled.'), { name: 'AbortError' });
}

function assertSameSource(asset, source) {
  assertAsset(asset);
  if (asset.id !== source.assetId || asset.projectId !== source.projectId || asset.frames !== source.assetFrames
    || asset.channels !== source.channels || asset.sampleRate !== source.sampleRate
    || (source.createdAt !== undefined && asset.createdAt !== source.createdAt)
    || (source.finishedAt !== undefined && asset.finishedAt !== source.finishedAt)) {
    fail('EDIT_SOURCE_CHANGED', 'The original audio changed. Reopen the editor and copy the selection again.');
  }
}

function readVerifiedPage(page, source, pageIndex) {
  const frames = Math.min(PAGE_FRAMES, source.assetFrames - pageIndex * PAGE_FRAMES);
  if (page?.missing || !(page?.buffer instanceof ArrayBuffer) || page.index !== pageIndex || page.frames !== frames
    || page.channels !== source.channels || page.buffer.byteLength !== frames * source.channels * 4) {
    fail('EDIT_SOURCE_PAGE_INVALID', 'Part of the original audio is missing or incomplete. The original has been preserved.');
  }
  const samples = new Float32Array(page.buffer);
  for (const sample of samples) if (!Number.isFinite(sample)) fail('EDIT_SOURCE_SAMPLE_INVALID', 'The original audio contains an invalid sample.');
  return { samples, frames };
}

function peakAccumulator(frames, channels, points) {
  if (!Number.isInteger(points) || points < 1 || points > 4096) fail('EDIT_WAVEFORM_INVALID', 'Choose between 1 and 4096 waveform points.');
  const count = Math.min(frames, points), peaks = Array(count).fill(0), quotient = Math.floor(frames / count), remainder = frames % count;
  // Exact ceil(bin * frames / count), without an unsafe bin * frames product.
  const boundary = bin => bin * quotient + Math.ceil(bin * remainder / count);
  let bin = 0, nextBoundary = boundary(1);
  return {
    peaks,
    add(samples, startFrame, length) {
      for (let local = 0; local < length; local++) {
        const absoluteFrame = startFrame + local;
        while (absoluteFrame >= nextBoundary && bin < count - 1) { bin++; nextBoundary = boundary(bin + 1); }
        for (let channel = 0; channel < channels; channel++) peaks[bin] = Math.max(peaks[bin], Math.abs(samples[local * channels + channel]));
      }
    },
  };
}

/** Read the whole source into time-proportional peaks, retaining only one page. */
export async function summarizeAudioEditSource(storage, asset, { points = 400, signal, onProgress } = {}) {
  const source = createAudioSelection(asset), envelope = peakAccumulator(source.frames, source.channels, points);
  checkAbort(signal); assertSameSource(await storage.getAsset(source.assetId), source); checkAbort(signal);
  onProgress?.({ frames: 0, totalFrames: source.frames, ratio: 0 });
  let readFrames = 0;
  for (let index = 0; readFrames < source.frames; index++) {
    checkAbort(signal);
    const page = await storage.readPage(source.assetId, index); checkAbort(signal);
    const { samples, frames } = readVerifiedPage(page, source, index);
    envelope.add(samples, readFrames, frames); readFrames += frames;
    onProgress?.({ frames: readFrames, totalFrames: source.frames, ratio: readFrames / source.frames });
  }
  checkAbort(signal);
  return envelope.peaks;
}

/**
 * Render a new immutable asset with at most one source page and one output page
 * retained. Storage readPage verifies each source page's CRC before returning it.
 * The controller attaches this asset only after this operation succeeds.
 */
export async function renderAudioEdit(storage, { asset, edit, metadata, signal, onProgress } = {}) {
  const plan = planAudioEdit(asset, edit);
  // Capture the destination before the first await. Caller/UI mutations must
  // never redirect a later write or failure cleanup onto an original asset.
  const outputMetadata = { ...metadata }, outputId = outputMetadata.id;
  validId(outputId); validId(outputMetadata.projectId, 'Project');
  if (outputMetadata.projectId !== plan.projectId) fail('EDIT_PROJECT_MISMATCH', 'The edited audio must stay in its original project.');
  const sources = new Map([[asset.id, createAudioSelection(asset)]]);
  for (const segment of plan.segments) if (segment.source) {
    const previous = sources.get(segment.source.assetId);
    if (previous) assertSameSource({ id: previous.assetId, projectId: previous.projectId, frames: previous.assetFrames,
      channels: previous.channels, sampleRate: previous.sampleRate, createdAt: previous.createdAt, finishedAt: previous.finishedAt, status: 'complete' }, segment.source);
    sources.set(segment.source.assetId, segment.source);
  }
  if (outputId === asset.id || sources.has(outputId)) fail('EDIT_SOURCE_OVERWRITE', 'An edit must create a new audio file.');
  checkAbort(signal);
  for (const source of sources.values()) { assertSameSource(await storage.getAsset(source.assetId), source); checkAbort(signal); }
  let created = false, cache = null;
  const envelope = peakAccumulator(plan.frames, plan.channels, 400);
  try {
    await storage.beginAsset({ ...outputMetadata, sampleRate: plan.sampleRate, channels: plan.channels, kind: outputMetadata.kind || 'edit' });
    created = true; checkAbort(signal);
    let segmentIndex = 0, segmentOffset = 0, writtenFrames = 0;
    onProgress?.({ frames: 0, totalFrames: plan.frames, ratio: 0 });
    for (let index = 0; writtenFrames < plan.frames; index++) {
      checkAbort(signal);
      const frames = Math.min(PAGE_FRAMES, plan.frames - writtenFrames), output = new Float32Array(frames * plan.channels);
      let outputFrame = 0;
      while (outputFrame < frames) {
        const segment = plan.segments[segmentIndex];
        let count = Math.min(frames - outputFrame, segment.frames - segmentOffset);
        if (segment.type === 'audio') {
          const source = segment.source, position = source.startFrame + segmentOffset % source.frames;
          const pageIndex = Math.floor(position / PAGE_FRAMES), pageOffset = position % PAGE_FRAMES;
          if (cache?.id !== source.assetId || cache.index !== pageIndex) {
            // Drop the previous page before fetching another one.
            cache = null;
            const page = await storage.readPage(source.assetId, pageIndex); checkAbort(signal);
            cache = { id: source.assetId, index: pageIndex, ...readVerifiedPage(page, source, pageIndex) };
          }
          count = Math.min(count, cache.frames - pageOffset, source.endFrame - position);
          if (source.channels === plan.channels) {
            output.set(cache.samples.subarray(pageOffset * source.channels, (pageOffset + count) * source.channels), outputFrame * plan.channels);
          } else {
            for (let f = 0; f < count; f++) {
              const sample = cache.samples[pageOffset + f], out = (outputFrame + f) * 2;
              output[out] = sample; output[out + 1] = sample;
            }
          }
        }
        outputFrame += count; segmentOffset += count;
        if (segmentOffset === segment.frames) { segmentIndex++; segmentOffset = 0; }
      }
      envelope.add(output, writtenFrames, frames);
      await storage.putPage(outputId, index, output.buffer, frames, plan.channels); checkAbort(signal);
      writtenFrames += frames;
      onProgress?.({ frames: writtenFrames, totalFrames: plan.frames, ratio: writtenFrames / plan.frames });
    }
    checkAbort(signal);
    const result = await storage.finishAsset(outputId, { frames: plan.frames }); checkAbort(signal);
    if (!result || result.status !== 'complete' || result.id !== outputId || result.projectId !== plan.projectId
      || result.frames !== plan.frames || result.channels !== plan.channels || result.sampleRate !== plan.sampleRate) {
      fail('EDIT_INCOMPLETE', 'The edited audio could not be saved completely. The original has been preserved.');
    }
    return { ...result, peaks: envelope.peaks };
  } catch (cause) {
    if (created) {
      // Only this operation's new, unattached asset may be removed on failure.
      // A failed begin (including an identifier collision) never deletes a file.
      await storage.finishAsset(outputId, { status: 'cancelled' }).catch(() => {});
      try { await storage.deleteAsset(outputId); }
      catch { if (cause && typeof cause === 'object') cause.cleanupAssetId = outputId; }
    }
    throw cause;
  }
}
