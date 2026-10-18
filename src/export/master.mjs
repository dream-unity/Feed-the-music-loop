import { ExportError, validateAudioMetadata, wavHeader, WAV_HEADER_BYTES } from './wav.mjs';
import { MASTER_PAGE_FRAMES, normalizeMasterSettings, renderMasterFrames } from './master-core.mjs';
export { DEFAULT_MASTER_SETTINGS, normalizeMasterSettings } from './master-core.mjs';

export const MAX_MASTER_PREVIEW_BYTES = 32 * 1024 * 1024;

export async function prepareMasterPlan(storage, project, options = {}) {
  options.signal?.throwIfAborted();
  if (!project?.id || typeof options.assetId !== 'string' || !options.assetId) throw new ExportError('INVALID_MASTER', 'Choose a saved recording to mix and master.');
  const settings = normalizeMasterSettings(options.settings);
  const source = await storage.getAsset(options.assetId);
  options.signal?.throwIfAborted();
  validateAudioMetadata(source);
  if (source.id !== options.assetId || source.projectId !== project.id || source.sampleRate !== project.sampleRate || !['complete', 'recovered', 'interrupted'].includes(source.status)) throw new ExportError('RECORDING_NOT_READY', 'Choose a finished recording from this project.');
  if (!source.frames || source.frames > source.sampleRate * 86400) throw new ExportError('INVALID_MASTER', 'Choose a saved recording of up to 24 hours.');
  return { projectId: project.id, sourceAssetId: source.id, frames: source.frames, channels: source.channels, sampleRate: source.sampleRate,
    name: String(options.name || `${source.name || 'Recording'} — mastered`).slice(0, 160), settings };
}

async function checkSourceUnchanged(storage, plan, signal) {
  signal?.throwIfAborted();
  const source = await storage.getAsset(plan.sourceAssetId);
  signal?.throwIfAborted();
  if (!source || source.projectId !== plan.projectId || source.frames !== plan.frames || source.channels !== plan.channels || source.sampleRate !== plan.sampleRate || !['complete', 'recovered', 'interrupted'].includes(source.status)) throw new ExportError('AUDIO_SNAPSHOT_MISMATCH', 'The source recording changed while it was being processed. Please try again.');
}

function runWorker(storage, plan, writePage, { signal, onProgress, workerIdleTimeoutMs = 60000 } = {}) {
  const worker = new Worker(new URL('./master-worker.mjs', import.meta.url), { type: 'module', name: 'fml-recording-master' });
  const outputFrames = plan.outputFrames ?? plan.frames, writes = new Set();
  const timeoutMs = Number.isFinite(workerIdleTimeoutMs) && workerIdleTimeoutMs > 0 ? workerIdleTimeoutMs : 60000;
  let closed = false, watchdog = null, lastRequestId = 0, nextOutputPage = 0, writtenFrames = 0;
  return new Promise((resolve, reject) => {
    const finish = async (error, result) => {
      if (closed) return;
      closed = true; clearTimeout(watchdog); signal?.removeEventListener('abort', aborted);
      try { worker.terminate(); } catch { /* already unavailable */ }
      await Promise.allSettled([...writes]);
      if (error) reject(error instanceof Error ? error : new Error(String(error))); else resolve(result);
    };
    const protocolError = message => new ExportError('MASTER_PROTOCOL', message);
    const resetWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(new ExportError('MASTER_TIMEOUT', 'The recording processor stopped responding. Your original recording is unchanged.')), timeoutMs); };
    const send = (message, transfer = []) => {
      if (closed) return;
      try { worker.postMessage(message, transfer); } catch (error) { finish(error); }
    };
    const aborted = () => finish(signal.reason instanceof Error ? signal.reason : new DOMException('Processing was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', aborted, { once: true });
    worker.onerror = event => finish(new Error(event.message || 'The recording processor stopped unexpectedly.'));
    worker.onmessageerror = () => finish(new Error('The recording processor could not transfer audio data.'));
    worker.onmessage = ({ data: message }) => {
      if (closed) return;
      if (!message || typeof message !== 'object') { finish(protocolError('The recording processor sent an invalid message.')); return; }
      resetWatchdog();
      if (message.type === 'progress') { try { onProgress?.(message.progress); } catch (error) { finish(error); } return; }
      if (message.type === 'error') { finish(new ExportError(message.code || 'MASTER_FAILED', message.message || 'Recording processing failed.')); return; }
      if (message.type === 'complete') {
        const result = message.result;
        const analysis = result?.analysis;
        const validAnalysis = analysis?.peakType === 'sample' && analysis.ceilingDb === plan.settings.ceilingDb && Number.isFinite(analysis.outputGainDb)
          && ['inputPeakDb', 'processedPeakDb', 'outputPeakDb', 'inputRmsDb', 'outputRmsDb'].every(key => analysis[key] === null || Number.isFinite(analysis[key]))
          && (plan.original || analysis.outputPeakDb === null || analysis.outputPeakDb <= plan.settings.ceilingDb + 1e-6);
        if (!result || result.frames !== outputFrames || result.sourceFrames !== plan.frames || result.startFrame !== (plan.startFrame ?? 0) || result.channels !== plan.channels || result.sampleRate !== plan.sampleRate || writtenFrames !== outputFrames || writes.size || !validAnalysis || JSON.stringify(result.settings) !== JSON.stringify(plan.settings)) finish(protocolError('The recording processor returned an incomplete recording.'));
        else finish(null, result);
        return;
      }
      if (message.type !== 'rpc' || !Number.isSafeInteger(message.requestId) || message.requestId <= lastRequestId || !Array.isArray(message.args)) { finish(protocolError('The recording processor sent an invalid storage request.')); return; }
      lastRequestId = message.requestId;
      const args = message.args, write = message.method === 'putPage';
      if (message.method === 'readPage') {
        if (args.length !== 2 || args[0] !== plan.sourceAssetId || !Number.isSafeInteger(args[1]) || args[1] < 0 || args[1] >= Math.ceil(plan.frames / MASTER_PAGE_FRAMES)) { finish(protocolError('The recording processor requested audio outside the selected recording.')); return; }
      } else if (write) {
        const [index, buffer, frames, channels] = args, expected = Math.min(MASTER_PAGE_FRAMES, outputFrames - nextOutputPage * MASTER_PAGE_FRAMES);
        if (args.length !== 4 || index !== nextOutputPage || expected < 1 || frames !== expected || channels !== plan.channels || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== MASTER_PAGE_FRAMES * plan.channels * 4) { finish(protocolError('The recording processor returned an invalid output page.')); return; }
        nextOutputPage++;
      } else { finish(protocolError('The recording processor requested an unsupported storage operation.')); return; }
      const task = Promise.resolve().then(async () => {
        if (closed) return;
        try {
          let result = null, transfer = [];
          if (write) { await writePage(...args); writtenFrames += args[2]; }
          else {
            result = await storage.readPage(...args);
            if (!result || !(result.buffer instanceof ArrayBuffer)) throw new Error('A saved audio page could not be read.');
            transfer = [result.buffer];
          }
          send({ type: 'rpc-result', requestId: message.requestId, result }, transfer);
        } catch (error) { send({ type: 'rpc-result', requestId: message.requestId, error: { message: error.message || String(error), code: error.code } }); }
      });
      if (write) { writes.add(task); task.then(() => writes.delete(task), error => { writes.delete(task); finish(error); }); }
      else task.catch(error => finish(error));
    };
    if (signal?.aborted) aborted(); else { resetWatchdog(); send({ type: 'master', plan }); }
  });
}

function processRecording(storage, plan, writePage, options) {
  return options.useWorker !== false && typeof Worker !== 'undefined' ? runWorker(storage, plan, writePage, options)
    : renderMasterFrames(plan, { readPage: (id, index) => storage.readPage(id, index), writePage, signal: options.signal, onProgress: options.onProgress });
}

/** Persist a new mix asset. Source bytes and project arrangement are immutable. */
export async function renderMasteredRecording(storage, project, options = {}) {
  const plan = await prepareMasterPlan(storage, project, options);
  if (typeof storage.estimate === 'function') {
    let estimate;
    try { estimate = await storage.estimate(); } catch { /* checked writes remain authoritative */ }
    const bytes = plan.frames * plan.channels * 4;
    if (Number.isFinite(estimate?.quota) && estimate.quota > 0 && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < bytes + Math.max(1024 * 1024, Math.ceil(bytes * .01))) throw new ExportError('INSUFFICIENT_STORAGE', 'There is not enough device storage to safely save this mastered recording.');
  }
  options.signal?.throwIfAborted();
  const assetId = `master-${crypto.randomUUID()}`;
  try {
    await storage.beginAsset({ id: assetId, projectId: plan.projectId, sampleRate: plan.sampleRate, channels: plan.channels, kind: 'mix', name: plan.name, sourceAssetId: plan.sourceAssetId, masterSettings: plan.settings });
    options.signal?.throwIfAborted();
    const result = await processRecording(storage, plan, (index, buffer, frames, channels) => storage.putPage(assetId, index, buffer, frames, channels), options);
    await checkSourceUnchanged(storage, plan, options.signal);
    const saved = await storage.finishAsset(assetId, { frames: result.frames, status: 'complete', sourceAssetId: plan.sourceAssetId, masterSettings: result.settings, analysis: result.analysis });
    options.signal?.throwIfAborted();
    if (saved?.status !== 'complete' || saved.id !== assetId || saved.frames !== result.frames || saved.channels !== result.channels || saved.sampleRate !== result.sampleRate) throw new ExportError('MASTER_WRITE_INCOMPLETE', 'The complete mastered recording could not be saved.');
    return { ...result, assetId, sourceAssetId: plan.sourceAssetId, name: plan.name };
  } catch (error) {
    try { await storage.deleteAsset(assetId); } catch { error.cleanupIds = [assetId]; }
    throw error;
  }
}

/** A bounded WAV audition with the exact gain of the complete render, without
 * creating an asset or consuming durable recording storage. */
export async function previewMasteredRecording(storage, project, options = {}) {
  const plan = await prepareMasterPlan(storage, project, options), seconds = options.previewSeconds ?? 20;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 60) throw new ExportError('INVALID_MASTER', 'Choose a preview duration up to 60 seconds.');
  plan.startFrame = options.startFrame ?? 0;
  if (!Number.isSafeInteger(plan.startFrame) || plan.startFrame < 0 || plan.startFrame >= plan.frames) throw new ExportError('INVALID_MASTER', 'Choose a preview position within the recording.');
  plan.original = options.original === true;
  plan.outputFrames = Math.min(plan.frames - plan.startFrame, Math.max(1, Math.round(seconds * plan.sampleRate)), Math.floor((MAX_MASTER_PREVIEW_BYTES - WAV_HEADER_BYTES) / (plan.channels * 4)));
  const parts = [];
  const result = await processRecording(storage, plan, async (_index, buffer, frames, channels) => { options.signal?.throwIfAborted(); parts.push(buffer.slice(0, frames * channels * 4)); }, options);
  await checkSourceUnchanged(storage, plan, options.signal);
  const blob = new Blob([wavHeader(result), ...parts], { type: 'audio/wav' });
  if (blob.size > MAX_MASTER_PREVIEW_BYTES) throw new ExportError('MASTER_PREVIEW_LIMIT', 'The recording preview is too large.');
  return { ...result, blob, sourceAssetId: plan.sourceAssetId, name: plan.name };
}
