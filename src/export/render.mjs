import { validateProject, normalizeMix, roleMix } from '../project.mjs';
import { ExportError, validateAudioMetadata } from './wav.mjs';
import { renderMixFrames } from './render-core.mjs';

const MAX_RENDER_SECONDS = 24 * 60 * 60;
const int = (value, label, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new ExportError('INVALID_RENDER', `Invalid ${label}.`);
  return value;
};
const eventType = event => event.type === 'command' ? event.command : event.type === 'automation' ? event.action : event.type;

function checkTracks(project, tracks) {
  return validateProject({ ...project, tracks, sections: [], takes: [], performances: [], selectedTakeId: null, events: [] }, { strict: true }).tracks.filter(track => track.kind === 'loop');
}

/** Build a fixed, inspectable rendering snapshot before creating any output.
 * Current mode uses today's sound settings and the selected performance's
 * recorded entrances, mute/solo changes, sections and Spotlight movement. */
export async function prepareRenderPlan(storage, inputProject, options = {}) {
  options.signal?.throwIfAborted();
  const project = validateProject(inputProject, { strict: true });
  const mode = options.mode || 'current';
  if (!['current', 'performance'].includes(mode)) throw new ExportError('INVALID_RENDER', 'Choose current sound or original performance sound.');
  const selectedTake = project.takes.find(take => take.id === (options.takeId || project.selectedTakeId));
  if (options.takeId && !selectedTake) throw new ExportError('INVALID_RENDER', 'The selected vocal take is unavailable.');
  const performanceId = options.performanceId || selectedTake?.performanceId;
  const performance = performanceId ? project.performances.find(item => item.id === performanceId) : null;
  if (performanceId && !performance) throw new ExportError('INVALID_RENDER', 'The selected performance is unavailable.');
  const initial = performance?.initialState;
  if (mode === 'performance' && (!performance || !initial?.tracks)) throw new ExportError('INVALID_RENDER', 'The original mixer snapshot is unavailable. Use the current sound settings.');
  const currentTracks = project.tracks.filter(track => track.kind === 'loop');
  const initialTracks = initial?.tracks ? checkTracks(project, initial.tracks) : currentTracks;
  const currentById = new Map(currentTracks.map(track => [track.id, track]));
  const originalById = new Map(initialTracks.map(track => [track.id, track]));
  const rawEvents = performance?.events || [];
  const additions = new Set(rawEvents.filter(event => eventType(event) === 'track' && event.track?.id && !originalById.has(event.track.id)).map(event => event.track.id));
  const tracks = mode === 'performance' ? initialTracks : currentTracks.filter(track => !additions.has(track.id)).map(track => {
    const original = originalById.get(track.id);
    return { ...track, muted: original ? original.muted : track.muted, solo: original ? original.solo : track.solo };
  });
  const sampleRate = project.sampleRate;
  const startFrame = int(performance?.startFrame ?? selectedTake?.startFrame ?? 0, 'song start');
  const vocalAssetId = performance?.leadAssetId || selectedTake?.assetId;
  let vocal = null;
  if (vocalAssetId) {
    const asset = await storage.getAsset(vocalAssetId);
    validateAudioMetadata(asset);
    if (asset.projectId !== project.id || asset.sampleRate !== sampleRate || asset.channels !== 1 || !['complete', 'interrupted', 'recovered'].includes(asset.status)) throw new ExportError('INVALID_RENDER', 'The selected dry vocal is unavailable or incompatible.');
    const savedTake = project.takes.find(take => take.assetId === vocalAssetId);
    if ((savedTake && savedTake.frames !== asset.frames) || (performance?.status === 'complete' && performance.frames !== asset.frames) || (performance?.editableFrames || 0) > asset.frames) throw new ExportError('DAMAGED_AUDIO', 'The saved vocal is incomplete or no longer matches this performance. Download its verified incomplete audio from Song, or restore a complete project backup. The original song timing was preserved.');
    vocal = { assetId: asset.id, frames: asset.frames };
  }
  let bodyFrames;
  if (options.durationSeconds !== undefined) {
    if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0 || options.durationSeconds > MAX_RENDER_SECONDS) throw new ExportError('INVALID_RENDER', 'Choose an export duration between zero and 24 hours.');
    bodyFrames = Math.round(options.durationSeconds * sampleRate);
  } else if (performance) bodyFrames = performance.status === 'complete' ? performance.frames : (performance.editableFrames ?? Math.min(performance.frames, vocal?.frames || 0));
  else if (vocal) bodyFrames = vocal.frames;
  else bodyFrames = project.baseFrames || Math.max(0, ...currentTracks.map(track => track.frames));
  int(bodyFrames, 'song duration', 1);
  if (bodyFrames > MAX_RENDER_SECONDS * sampleRate) throw new ExportError('INVALID_RENDER', 'Render up to 24 hours at a time.');
  if (performance && performance.status !== 'complete') {
    const available = performance.editableFrames ?? Math.min(performance.frames, vocal?.frames || 0);
    if (bodyFrames > available) throw new ExportError('INCOMPLETE_PERFORMANCE', 'Only the shared recovered vocal and arrangement interval can be remixed. Download the intact stereo performance to retain its complete recording.');
  }
  const tailSeconds = options.tailSeconds ?? 2, prerollSeconds = options.prerollSeconds ?? 5;
  if (!Number.isFinite(tailSeconds) || tailSeconds < 0 || tailSeconds > 10 || !Number.isFinite(prerollSeconds) || prerollSeconds < 0 || prerollSeconds > 10) throw new ExportError('INVALID_RENDER', 'Effect tail and warm-up must each be between zero and ten seconds.');
  const tailFrames = Math.round(tailSeconds * sampleRate), prerollFrames = Math.round(prerollSeconds * sampleRate);
  int(startFrame + bodyFrames + tailFrames, 'song end');
  const events = rawEvents.filter(event => event.frame >= startFrame && event.frame < startFrame + bodyFrames).map((event, order) => ({ ...structuredClone(event), _order: order })).sort((a, b) => a.frame - b.frame || a._order - b._order);
  const requiredTracks = [...tracks];
  for (const event of events) {
    if (eventType(event) === 'track' && event.track) {
      const track = mode === 'current' ? currentById.get(event.track.id) : checkTracks(project, [event.track])[0];
      if (track) { requiredTracks.push(track); if (mode === 'performance') event.track = track; }
    } else if (eventType(event) === 'section' && event.section) {
      event.section = validateProject({ ...project, sections: [event.section] }, { strict: true }).sections[0];
    }
  }
  const assets = new Map();
  for (const track of requiredTracks) {
    options.signal?.throwIfAborted();
    if (!assets.has(track.assetId)) assets.set(track.assetId, await storage.getAsset(track.assetId));
    const asset = assets.get(track.assetId); validateAudioMetadata(asset);
    if (asset.projectId !== project.id || asset.sampleRate !== sampleRate || asset.frames !== track.frames || asset.channels !== track.channels || !['complete', 'interrupted', 'recovered'].includes(asset.status)) throw new ExportError('INVALID_RENDER', `The recording for “${track.name}” is unavailable or inconsistent.`);
  }
  if (vocal) assets.set(vocal.assetId, await storage.getAsset(vocal.assetId));
  const matchingTake = selectedTake?.assetId === vocalAssetId ? selectedTake : project.takes.find(take => take.assetId === vocalAssetId);
  const vocalTrack = project.tracks.find(track => track.kind === 'vocal' && track.assetId === vocalAssetId);
  const vocalMix = normalizeMix(mode === 'performance' ? initial.inputMix || roleMix('lead') : matchingTake?.mix || project.vocalMix || vocalTrack?.mix || initial?.inputMix || roleMix('lead'));
  return {
    projectId: project.id, sampleRate, mode, sourcePerformanceId: performance?.id || null,
    name: `${performance?.name || project.name} — ${mode === 'current' ? 'remix' : 'render'}`,
    startFrame, bodyFrames, tailFrames, prerollFrames, tracks, currentTracks, events, vocal,
    baseFrames: initial?.baseFrames || project.baseFrames,
    masterVolume: mode === 'performance' ? initial.master?.volume ?? project.master.volume : project.master.volume,
    spotlight: !!initial?.spotlight, vocalMix, assetIds: [...assets.keys()],
    sourceAssets: [...assets.values()].map(({ id, frames, channels }) => ({ id, frames, channels })),
  };
}

function runWorker(storage, plan, outputId, { signal, onProgress, workerIdleTimeoutMs = 60000 } = {}) {
  const worker = new Worker(new URL('./render-worker.mjs', import.meta.url), { type: 'module', name: 'fml-song-render' });
  const allowed = new Map(plan.sourceAssets.map(asset => [asset.id, asset])), writes = new Set();
  const totalFrames = plan.bodyFrames + plan.tailFrames;
  const timeoutMs = Number.isFinite(workerIdleTimeoutMs) && workerIdleTimeoutMs > 0 ? workerIdleTimeoutMs : 60000;
  let closed = false, watchdog = null, lastRequestId = 0, nextOutputPage = 0, writtenFrames = 0;
  return new Promise((resolve, reject) => {
    const finish = async (error, result) => {
      if (closed) return;
      closed = true; clearTimeout(watchdog); signal?.removeEventListener('abort', aborted);
      try { worker.terminate(); } catch { /* transport is already unavailable */ }
      // Writes must settle before cleanup can delete the new output asset.
      // Source reads do not modify it and must not prevent cancellation.
      await Promise.allSettled([...writes]);
      if (error) reject(error instanceof Error ? error : new Error(String(error))); else resolve(result);
    };
    const protocolError = message => new ExportError('RENDER_PROTOCOL', message);
    const resetWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish(new ExportError('RENDER_TIMEOUT', 'The song renderer stopped responding. Your original recordings are unchanged; try exporting again.')), timeoutMs);
    };
    const send = (message, transfer = []) => {
      if (closed) return false;
      try { worker.postMessage(message, transfer); return true; }
      catch (error) { finish(error); return false; }
    };
    const aborted = () => finish(signal.reason instanceof Error ? signal.reason : new DOMException('Rendering was cancelled.', 'AbortError'));
    signal?.addEventListener('abort', aborted, { once: true });
    worker.onerror = event => finish(new Error(event.message || 'The song renderer stopped unexpectedly.'));
    worker.onmessageerror = () => finish(new Error('The song renderer could not transfer its audio data.'));
    worker.onmessage = ({ data: message }) => {
      if (closed) return;
      if (!message || typeof message !== 'object') { finish(protocolError('The song renderer sent an invalid message.')); return; }
      resetWatchdog();
      if (message.type === 'progress') { try { onProgress?.(message.progress); } catch (error) { finish(error); } return; }
      if (message.type === 'error') { finish(new Error(message.message || 'The song renderer failed.')); return; }
      if (message.type === 'complete') {
        const result = message.result;
        if (!result || result.frames !== totalFrames || result.bodyFrames !== plan.bodyFrames || result.tailFrames !== plan.tailFrames || result.sampleRate !== plan.sampleRate || result.channels !== 2 || writtenFrames !== totalFrames || writes.size) finish(protocolError('The song renderer returned an incomplete recording.'));
        else finish(null, result);
        return;
      }
      if (message.type !== 'rpc' || !Number.isSafeInteger(message.requestId) || message.requestId <= lastRequestId || !Array.isArray(message.args)) { finish(protocolError('The song renderer sent an invalid storage request.')); return; }
      lastRequestId = message.requestId;
      const args = message.args, write = message.method === 'putPage';
      if (message.method === 'readPage') {
        const asset = allowed.get(args[0]), index = args[1];
        if (args.length !== 2 || !asset || !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(asset.frames / 16384)) { finish(protocolError('The song renderer requested audio outside the current song.')); return; }
      } else if (write) {
        const [index, buffer, frames, channels] = args, expected = Math.min(16384, totalFrames - nextOutputPage * 16384);
        if (args.length !== 4 || index !== nextOutputPage || expected < 1 || frames !== expected || channels !== 2 || !(buffer instanceof ArrayBuffer) || buffer.byteLength !== 16384 * 8) { finish(protocolError('The song renderer returned an invalid output page.')); return; }
        nextOutputPage++;
      } else { finish(protocolError('The song renderer requested an unsupported storage operation.')); return; }
      // Register writes before starting IO. Even an abort raised synchronously
      // inside a storage adapter cannot race deletion against an active write.
      const task = Promise.resolve().then(async () => {
        if (closed) return;
        try {
          let result, transfer = [];
          if (write) {
            await storage.putPage(outputId, ...args); writtenFrames += args[2]; result = null;
          } else {
            result = await storage.readPage(...args);
            if (!result || !(result.buffer instanceof ArrayBuffer)) throw new Error('A saved audio page could not be read.');
            transfer = [result.buffer];
          }
          send({ type: 'rpc-result', requestId: message.requestId, result }, transfer);
        } catch (error) { send({ type: 'rpc-result', requestId: message.requestId, error: error.message || String(error) }); }
      });
      if (write) { writes.add(task); task.then(() => writes.delete(task), error => { writes.delete(task); finish(error); }); }
      else task.catch(error => finish(error));
    };
    if (signal?.aborted) aborted(); else { resetWatchdog(); send({ type: 'render', plan }); }
  });
}

/** Produces a new saved stereo asset; use exportWav to download it. The original
 * captured stereo master remains the authority for the exact live performance.
 * Warm-up reconstructs effect history; it cannot recover unrecorded mic history. */
export async function renderEditedMix(storage, project, options = {}) {
  options.signal?.throwIfAborted();
  const plan = await prepareRenderPlan(storage, project, options);
  options.signal?.throwIfAborted();
  if (typeof storage.estimate === 'function') {
    let estimate;
    try { estimate = await storage.estimate(); } catch { /* checked writes remain authoritative */ }
    const bytes = (plan.bodyFrames + plan.tailFrames) * 8;
    if (Number.isFinite(estimate?.quota) && estimate.quota > 0 && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < bytes + Math.max(1024 * 1024, Math.ceil(bytes * .01))) throw new ExportError('INSUFFICIENT_STORAGE', 'There is not enough device storage to safely save this rendered song.');
  }
  options.signal?.throwIfAborted();
  const assetId = `render-${crypto.randomUUID()}`;
  try {
    await storage.beginAsset({ id: assetId, projectId: project.id, sampleRate: plan.sampleRate, channels: 2, kind: 'mix', name: plan.name, sourcePerformanceId: plan.sourcePerformanceId, renderMode: plan.mode });
    options.signal?.throwIfAborted();
    const result = options.useWorker !== false && typeof Worker !== 'undefined'
      ? await runWorker(storage, plan, assetId, options)
      : await renderMixFrames(plan, { readPage: (id, index) => storage.readPage(id, index), writePage: (index, buffer, frames, channels) => storage.putPage(assetId, index, buffer, frames, channels), onProgress: options.onProgress, signal: options.signal });
    options.signal?.throwIfAborted();
    const saved = await storage.finishAsset(assetId, { frames: result.frames, status: 'complete', bodyFrames: result.bodyFrames, tailFrames: result.tailFrames });
    options.signal?.throwIfAborted();
    if (saved?.status !== 'complete' || saved.frames !== result.frames) throw new ExportError('RENDER_WRITE_INCOMPLETE', 'The complete rendered song could not be saved.');
    return { ...result, assetId, name: plan.name, mode: plan.mode, sourcePerformanceId: plan.sourcePerformanceId, startFrame: plan.startFrame };
  } catch (error) {
    try { await storage.deleteAsset(assetId); } catch { error.cleanupIds = [assetId]; }
    throw error;
  }
}
