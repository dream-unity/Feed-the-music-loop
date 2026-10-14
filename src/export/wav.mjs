export class ExportError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ExportError'; this.code = code; Object.assign(this, details); }
}

export function safeFilename(name, extension) {
  const stem = String(name || 'Recording').normalize('NFC').replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 100) || 'Recording';
  return `${stem}.${extension}`;
}

export function validateAudioMetadata(asset) {
  if (!asset || !Number.isSafeInteger(asset.frames) || asset.frames < 0 || ![1, 2].includes(asset.channels) || !Number.isInteger(asset.sampleRate) || asset.sampleRate < 8000 || asset.sampleRate > 384000) {
    throw new ExportError('INVALID_AUDIO', 'The recording has invalid audio metadata.');
  }
  const bytes = asset.frames * asset.channels * 4;
  if (!Number.isSafeInteger(bytes)) throw new ExportError('INVALID_AUDIO', 'The recording is too large to address safely.');
  return bytes;
}

export const WAV_HEADER_BYTES = 58;
export const MAX_RIFF_DATA_BYTES = 0xffffffff - (WAV_HEADER_BYTES - 8);
export const MAX_RANGE_DATA_BYTES = 64 * 1024 * 1024;

// IEEE float WAVE includes the extended fmt size and required non-PCM fact
// chunk. Data comes directly from immutable PCM File/Blob slices, without
// creating another full-length ArrayBuffer or quantising to 16-bit samples.
export function wavHeader({ frames, channels, sampleRate }) {
  const bytes = validateAudioMetadata({ frames, channels, sampleRate });
  if (bytes > MAX_RIFF_DATA_BYTES || frames > 0xffffffff) throw new ExportError('WAV_SPLIT_REQUIRED', 'This recording exceeds the WAV size limit. Export numbered WAV parts.');
  const header = new ArrayBuffer(WAV_HEADER_BYTES);
  const view = new DataView(header);
  const writeString = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  writeString(0, 'RIFF'); view.setUint32(4, bytes + WAV_HEADER_BYTES - 8, true); writeString(8, 'WAVE');
  writeString(12, 'fmt '); view.setUint32(16, 18, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 4, true); view.setUint16(32, channels * 4, true);
  view.setUint16(34, 32, true); view.setUint16(36, 0, true);
  writeString(38, 'fact'); view.setUint32(42, 4, true); view.setUint32(46, frames, true);
  writeString(50, 'data'); view.setUint32(54, bytes, true);
  return header;
}

async function source(storage, assetId, signal, allowRanges = false) {
  signal?.throwIfAborted();
  const asset = await storage.getAsset(assetId);
  signal?.throwIfAborted();
  const bytes = validateAudioMetadata(asset);
  if (!['complete', 'interrupted', 'recovered'].includes(asset.status)) throw new ExportError('RECORDING_NOT_READY', 'Finish and save this recording before exporting it.');
  let file;
  try { file = await storage.getAssetFile(assetId); }
  catch (error) {
    // Fallback storage can hold a long recording without materialising it as
    // one giant Blob. Numbered exports read only bounded ranges of its pages.
    if (!allowRanges || error.code !== 'FALLBACK_EXPORT_LIMIT' || typeof storage.getAssetRange !== 'function') throw error;
    signal?.throwIfAborted();
    return { asset, file: null };
  }
  signal?.throwIfAborted();
  if (!(file instanceof Blob) || file.size !== bytes) throw new ExportError('AUDIO_SIZE_MISMATCH', 'The saved audio length does not match its metadata.');
  return { asset, file };
}

export async function exportWav(storage, assetId, options = {}) {
  const { asset, file } = await source(storage, assetId, options.signal);
  const maxFrames = Math.floor(MAX_RIFF_DATA_BYTES / (asset.channels * 4));
  if (asset.frames > maxFrames) throw new ExportError('WAV_SPLIT_REQUIRED', 'This recording exceeds the WAV size limit. Export numbered WAV parts.', { partCount: Math.ceil(asset.frames / maxFrames), maxFrames });
  options.signal?.throwIfAborted();
  return { blob: new Blob([wavHeader(asset), file], { type: 'audio/wav' }), filename: safeFilename(options.name || asset.name, 'wav'), frames: asset.frames, channels: asset.channels, sampleRate: asset.sampleRate };
}

export async function* exportWavParts(storage, assetId, { signal, maxDataBytes = MAX_RIFF_DATA_BYTES, name } = {}) {
  const { asset, file } = await source(storage, assetId, signal, true);
  if (!Number.isSafeInteger(maxDataBytes) || maxDataBytes < asset.channels * 4 || maxDataBytes > MAX_RIFF_DATA_BYTES) throw new RangeError('Invalid WAV part size.');
  if (!file) maxDataBytes = Math.min(maxDataBytes, MAX_RANGE_DATA_BYTES);
  const maxFrames = Math.floor(maxDataBytes / (asset.channels * 4));
  const count = Math.max(1, Math.ceil(asset.frames / maxFrames));
  for (let part = 0; part < count; part++) {
    signal?.throwIfAborted();
    const startFrame = part * maxFrames;
    const frames = Math.min(maxFrames, asset.frames - startFrame);
    const pcm = file ? file.slice(startFrame * asset.channels * 4, (startFrame + frames) * asset.channels * 4)
      : await storage.getAssetRange(assetId, { startFrame, frames });
    signal?.throwIfAborted();
    if (!(pcm instanceof Blob) || pcm.size !== frames * asset.channels * 4) throw new ExportError('AUDIO_SIZE_MISMATCH', 'A saved audio part does not match its expected length.');
    yield { blob: new Blob([wavHeader({ ...asset, frames }), pcm], { type: 'audio/wav' }), filename: safeFilename(`${name || asset.name || 'Recording'}-part-${String(part + 1).padStart(String(count).length, '0')}`, 'wav'), part: part + 1, partCount: count, startFrame, frames, channels: asset.channels, sampleRate: asset.sampleRate };
  }
}
