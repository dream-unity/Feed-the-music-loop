import { Biquad } from '../audio/dsp.mjs';
import { ExportError, validateAudioMetadata } from './wav.mjs';
import { SHA256 } from './sha256.mjs';

export const MASTER_PAGE_FRAMES = 16384;
import { normalizeMasterSettings } from '../audio/master-settings.mjs';
export { normalizeMasterSettings, DEFAULT_MASTER_SETTINGS } from '../audio/master-settings.mjs';

class RecordingDSP {
  constructor(sampleRate, channels, settings) {
    this.channels = channels; this.settings = settings; this.envelope = 0;
    this.inputGain = 10 ** (settings.gainDb / 20);
    this.attack = Math.exp(-1 / (.006 * sampleRate)); this.release = Math.exp(-1 / (.13 * sampleRate));
    this.threshold = 10 ** (-24 * settings.compression / 20); this.ratio = 1 + 5 * settings.compression;
    this.makeup = 10 ** (3 * settings.compression / 20);
    this.values = new Float64Array(channels);
    this.filters = Array.from({ length: channels }, () => {
      const filters = [];
      for (const [type, frequency, gain] of [['highpass', settings.highpass, 0], ['low', 180, settings.low], ['peak', 1500, settings.mid], ['high', 5500, settings.high]]) {
        if ((type === 'highpass' && frequency === 0) || (type !== 'highpass' && gain === 0)) continue;
        const filter = new Biquad(sampleRate); filter.set(type, frequency, gain);
        // Fixed offline settings are active from frame zero; live coefficient
        // ramps would otherwise change the beginning of every rendered file.
        [filter.b0, filter.b1, filter.b2, filter.a1, filter.a2] = filter.target;
        filter.remaining = 0; filters.push(filter);
      }
      return filters;
    });
  }
  process(samples, offset) {
    let peak = 0;
    for (let channel = 0; channel < this.channels; channel++) {
      const raw = samples[offset + channel];
      if (!Number.isFinite(raw)) throw new ExportError('DAMAGED_AUDIO', 'The recording contains an invalid audio sample. The original has not been changed.');
      let value = raw * this.inputGain;
      for (const filter of this.filters[channel]) value = filter.process(value);
      this.values[channel] = value; peak = Math.max(peak, Math.abs(value));
    }
    let gain = 1;
    if (this.settings.compression > 0) {
      const coefficient = peak > this.envelope ? this.attack : this.release;
      this.envelope = coefficient * this.envelope + (1 - coefficient) * peak;
      if (this.envelope < 1e-30) this.envelope = 0;
      gain = this.makeup * (this.envelope > this.threshold ? (this.envelope / this.threshold) ** (1 / this.ratio - 1) : 1);
    }
    for (let channel = 0; channel < this.channels; channel++) {
      // A stereo balance control attenuates the opposite channel. Mono remains
      // mono, so balance has no effect on a mono file.
      const balance = this.channels === 2 ? 1 - Math.max(0, channel === 0 ? this.settings.balance : -this.settings.balance) : 1;
      this.values[channel] *= gain * balance;
      if (!Number.isFinite(this.values[channel])) throw new ExportError('INVALID_MASTER', 'These sound settings produced invalid audio.');
    }
    return this.values;
  }
}

const decibels = amplitude => amplitude > 0 ? 20 * Math.log10(amplitude) : null;
function floatCeiling(value) {
  const buffer = new ArrayBuffer(4), float = new Float32Array(buffer), integer = new Uint32Array(buffer);
  float[0] = value;
  if (float[0] > value) integer[0]--;
  return float[0];
}

/** Two deterministic passes: analyse the processed peak, then replay identical
 * DSP with one common gain. No full-file buffers, looping, resampling, channel
 * folding, or hidden tails. Ceiling is sample peak, not certified true peak or
 * LUFS normalization. Storage reads provide the journal's CRC verification. */
export async function renderMasterFrames(plan, { readPage, writePage, onProgress, signal } = {}) {
  validateAudioMetadata(plan);
  if (!plan.frames || plan.frames > plan.sampleRate * 86400 || typeof plan.sourceAssetId !== 'string' || !plan.sourceAssetId) throw new ExportError('INVALID_MASTER', 'Choose a saved recording of up to 24 hours.');
  const startFrame = plan.startFrame ?? 0, outputFrames = plan.outputFrames ?? plan.frames, endFrame = startFrame + outputFrames;
  if (!Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(outputFrames) || outputFrames < 1 || endFrame > plan.frames) throw new ExportError('INVALID_MASTER', 'The preview duration is invalid.');
  const settings = normalizeMasterSettings(plan.settings), bypass = plan.original === true;
  const sourceHash = new SHA256(), outputSourceHash = new SHA256();
  let processedPeak = 0, inputPeak = 0, outputPeak = 0, inputSquares = 0, outputSquares = 0, outputGain = 1;
  let output = new Float32Array(MASTER_PAGE_FRAMES * plan.channels), outputOffset = 0, outputPage = 0, writtenFrames = 0;
  const ceiling = floatCeiling(10 ** (settings.ceilingDb / 20));
  const flush = async () => {
    if (!outputOffset) return;
    signal?.throwIfAborted();
    await writePage(outputPage++, output.buffer, outputOffset, plan.channels);
    signal?.throwIfAborted();
    writtenFrames += outputOffset; outputOffset = 0; output = new Float32Array(MASTER_PAGE_FRAMES * plan.channels);
  };
  for (let pass = 0; pass < 2; pass++) {
    const dsp = new RecordingDSP(plan.sampleRate, plan.channels, bypass ? normalizeMasterSettings() : settings);
    const passFrames = pass === 0 ? plan.frames : endFrame, pages = Math.ceil(passFrames / MASTER_PAGE_FRAMES);
    if (pass === 1 && processedPeak > 0 && !bypass) outputGain = settings.normalize ? ceiling / processedPeak : Math.min(1, ceiling / processedPeak);
    for (let index = 0; index < pages; index++) {
      signal?.throwIfAborted();
      const sourceFrames = Math.min(MASTER_PAGE_FRAMES, plan.frames - index * MASTER_PAGE_FRAMES);
      const frames = Math.min(MASTER_PAGE_FRAMES, passFrames - index * MASTER_PAGE_FRAMES);
      const page = await readPage(plan.sourceAssetId, index);
      signal?.throwIfAborted();
      if (!page || page.frames !== sourceFrames || page.channels !== plan.channels || !(page.buffer instanceof ArrayBuffer) || page.buffer.byteLength !== sourceFrames * plan.channels * 4) throw new ExportError('DAMAGED_AUDIO', 'A recording page has an inconsistent saved length or channel count.');
      const hashedFrames = Math.max(0, Math.min(sourceFrames, endFrame - index * MASTER_PAGE_FRAMES));
      if (hashedFrames) (pass === 0 ? sourceHash : outputSourceHash).update(new Uint8Array(page.buffer, 0, hashedFrames * plan.channels * 4));
      const samples = new Float32Array(page.buffer);
      for (let frame = 0; frame < frames; frame++) {
        const offset = frame * plan.channels, values = dsp.process(samples, offset);
        const audible = pass === 1 && index * MASTER_PAGE_FRAMES + frame >= startFrame;
        for (let channel = 0; channel < plan.channels; channel++) {
          const position = offset + channel;
          if (pass === 0) {
            processedPeak = Math.max(processedPeak, Math.abs(values[channel]));
            inputPeak = Math.max(inputPeak, Math.abs(samples[position])); inputSquares += samples[position] ** 2;
          } else if (audible) {
            const destination = outputOffset * plan.channels + channel;
            output[destination] = bypass ? samples[position] : Math.max(-ceiling, Math.min(ceiling, values[channel] * outputGain));
            outputPeak = Math.max(outputPeak, Math.abs(output[destination])); outputSquares += output[destination] ** 2;
          }
        }
        if (audible && ++outputOffset === MASTER_PAGE_FRAMES) await flush();
      }
      const completedFrames = pass * plan.frames + index * MASTER_PAGE_FRAMES + frames;
      onProgress?.({ phase: pass === 0 ? 'analysing' : 'mastering', completedFrames, totalFrames: plan.frames + endFrame, outputFrames: writtenFrames + outputOffset, ratio: completedFrames / (plan.frames + endFrame) });
      signal?.throwIfAborted();
      if (typeof window !== 'undefined' && index % 16 === 15) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if (sourceHash.hex() !== outputSourceHash.hex()) throw new ExportError('AUDIO_SNAPSHOT_MISMATCH', 'The source recording changed while it was being processed. Please try again.');
  await flush();
  return { frames: outputFrames, sourceFrames: plan.frames, startFrame, channels: plan.channels, sampleRate: plan.sampleRate, settings,
    analysis: { inputPeakDb: decibels(inputPeak), processedPeakDb: decibels(processedPeak), outputPeakDb: decibels(outputPeak), inputRmsDb: decibels(Math.sqrt(inputSquares / (plan.frames * plan.channels))), outputRmsDb: decibels(Math.sqrt(outputSquares / (outputFrames * plan.channels))), outputGainDb: decibels(outputGain), ceilingDb: settings.ceilingDb, peakType: 'sample' } };
}
