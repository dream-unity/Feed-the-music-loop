import { AudioEngine } from './audio/client.mjs';
import { createProject, createTrack, validateProject, normalizeLoopRecording, roleMix, normalizeMix, sectionFromProject, applySection, ProjectHistory, CaptureMetadataBudget, MAX_AUTOMATION_EVENTS, referencedAssets, cleanName, id, clone, touch, PAGE_FRAMES, MAX_TRACKS, COLORS, DEFAULT_METRONOME } from './project.mjs';
import { exportWav, exportWavParts, exportProject, importProject } from './export/index.mjs';
import { inspectProjectAudio } from './audio-integrity.mjs';
import { normalizedStorageCapacity, removeAssetReferences } from './storage-management.mjs';
import { listStudioCacheFiles, deleteStudioCacheFile } from './storage/cache-files.mjs';
import { createAudioSelection, planAudioEdit, renderAudioEdit, summarizeAudioEditSource } from './audio/edit.mjs';
import { wavHeader } from './export/wav.mjs';
import { listRecordingSources, selectRecordingSource } from './recording-sources.mjs';
import { DEFAULT_MASTER_SETTINGS, normalizeMasterSettings } from './audio/master-settings.mjs';

const now = () => new Date().toISOString();
const nextLoopRecordingName = project => `Loop recording ${project.performances.filter(performance => performance.source === 'loops').length + 1}`;
// Reconstruct the latest saved recording from durable project records, including
// projects created before the recorder panel existed. No audio is copied.
function latestProjectRecording(project) {
  let latest = null;
  for (const [kind, recordings] of [['loop', project.tracks], ['performance', project.performances]]) {
    for (const recording of recordings || []) {
      if (recording.removed || !(recording.frames > 0)) continue;
      const createdAt = Date.parse(recording.createdAt) || 0;
      if (!latest || createdAt >= latest.createdAt) latest = { kind, id: recording.id, createdAt };
    }
  }
  return latest ? { kind: latest.kind, id: latest.id } : null;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAbort = error => error?.name === 'AbortError';
const jsonSafe = value => JSON.parse(JSON.stringify(value));
const isDiscardedCapture = asset => asset?.status === 'cancelled' && typeof asset.captureId === 'string' && asset.captureId.length > 0 && ['loop', 'vocal', 'master'].includes(asset.kind);

export class StudioController {
  constructor(storage, ui) {
    this.storage = storage; this.ui = ui; this.engine = null; this.history = new ProjectHistory(); this.generation = 0;
    this.pending = null; this.sealed = new Map(); this.saveTimer = null; this.saveChain = Promise.resolve(); this.saveSerial = 0;
    this.lastCheckpointAt = 0; this.lastUnderrunAt = 0; this.urls = new Set(); this.wakeLock = null; this.exportAbort = null;
    this.pausedMedia = []; this.pausedTransport = false; this.resetTransportOnInit = false;
    this.state = { project: null, projects: [], selectedTrackId: null, view: 'build', playing: false, paused: false, playbackOffsets: {}, playbackBaselines: {}, capture: null, status: 'Opening studio…', micEnabled: false, monitor: false,
      inputLevel: 0, outputLevel: 0, transportFrame: 0, sampleRate: 48000, storage: {}, busy: true, undoAvailable: false, redoAvailable: false, exporting: false,
      capabilities: { audio: !!(globalThis.AudioContext || globalThis.webkitAudioContext), microphone: !!globalThis.navigator?.mediaDevices?.getUserMedia }, error: null,
      recovered: [], discarded: [], damagedAudio: [], readonly: false, readonlyReason: null, recoveryRequired: false, deletionPending: false, downloads: [], preview: null, audition: null, exportProgress: null, activeSectionId: null, queuedSectionId: null,
      micDevices: [], preferredDeviceId: '', micChanging: false, recentRecording: null, trackEditor: null, mixMode: 'layers', recordingMix: null, recordingSources: [], recordingMixOutputs: [], remixPerformanceId: null };
    this.ui.addEventListener('action', e => { this.handle(e.detail).catch(error => this.handleError(error)); });
    this.storage.addEventListener('progress', e => this.storageProgress(e.detail));
    this.storage.addEventListener('error', e => {
      if (['STORAGE_WORKER_FAILED', 'STORAGE_MESSAGE_ERROR'].includes(e.detail.code)) this.storageFailed(e.detail.message).catch(error => this.handleError(error));
      else { this.state.status = 'Recording interrupted'; this.handleError(new Error(e.detail.message)); }
    });
  }
  render() {
    this.refreshAudioIntegrity(); this.state.undoAvailable = !!this.history.past.length; this.state.redoAvailable = !!this.history.future.length;
    this.refreshTrackEditor(); this.refreshRecordingMix(); this.ui.render(this.state); this.ui.updateTrackEditor?.(this.state.trackEditor);
    const editor = this.state.trackEditor;
    if (editor && !this.trackEditOperation && !editor.waveformLoading && !editor.waveformError && !this.editorWaveforms?.has(editor.assetId)) this.loadEditorWaveform(editor);
  }
  async init() {
    this.render(); this.state.storage = await this.storage.init();
    this.state.projects = await this.storage.listProjects();
    let previous = null; try { previous = localStorage.getItem('fml:last-project'); } catch {}
    const available = this.state.projects.filter(p => !p.purgePendingAt);
    const selected = available.find(p => p.id === previous) || available[0] || this.state.projects[0];
    await this.openProject(selected?.id || null);
    globalThis.addEventListener?.('beforeunload', e => { if (this.pending || this.trackEditOperation || this.state.status === 'Saving…') { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (this.state.playing || this.pending)) this.keepAwake(); });
    return this;
  }
  assertWritable() { if (this.trackEditOperation) throw new Error('Wait for the audio edit to finish before changing the project.'); if (this.fileDeletion?.committing) throw new Error('Wait for file deletion to finish before editing.'); if (this.state.storageFailed) throw new Error('Reopen the studio to recover saved recordings before continuing.'); if (this.state.readonly) throw new Error(this.state.readonlyReason || 'This project is open in another tab. Close that tab before editing here, or export a backup.'); if(this.pending?.budgetReached) throw new Error('This performance is finishing at its arrangement limit. Wait for it to save before editing.'); }
  assertIdle() { if (this.pending || this.state.capture) throw new Error('Finish or cancel the recording before changing projects or exporting.'); }
  async openProject(projectId = null, supplied = null) {
    this.assertIdle();
    if (this.trackEditOperation) throw new Error('Wait for the audio edit to finish before opening another project.');
    if (this.recordingMasterOperation?.kind === 'render') throw new Error('Finish or cancel the master before opening another project.');
    this.stopRecordingMasterPreview();
    if (this.projectDeletion?.committing || this.fileDeletion?.committing) throw new Error('Wait for deletion to finish before opening another project.');
    if (this.openingProject) throw new Error('A project is still opening. Wait for it to finish before switching again.');
    this.openingProject = true;
    try {
    this.closeTrackEditor(); this.audioClipboard = null; this.editorWaveforms?.clear(); this.state.recordingMix = null; this.state.remixPerformanceId = null; this.mixModeChosen = false;
    ++this.generation; this.state.busy = true; this.render();
    const previousId = this.state.project?.id;
    if (previousId && !this.state.readonly) await this.flushSave();
    const next = supplied ? validateProject(supplied) : projectId ? validateProject(await this.storage.loadProject(projectId)) : createProject('My first song');
    const deletionPending = !!next.purgePendingAt;
    if (this.engine) { await this.engine.close(); this.engine = null; }
    this.closePreview();
    if (previousId && previousId !== next.id) await this.storage.releaseProject(previousId).catch(() => {});
    let readonly = false, readonlyReason = null, recoveryRequired = false;
    try {
      if (deletionPending) {
        readonly = true; readonlyReason = 'Project deletion is unfinished. Playback and editing are paused. Open Manage storage and retry permanent deletion, or open another project.';
      } else {
        if (!projectId && !supplied) await this.storage.saveProject(next);
        await this.storage.recover(next.id);
      }
    } catch (error) {
      if (this.state.storageFailed || ['STORAGE_WORKER_FAILED', 'STORAGE_MESSAGE_ERROR', 'STORAGE_CLOSED'].includes(error.code)) throw error;
      if (error.code === 'PROJECT_BUSY') {
        readonly = true; readonlyReason = 'This project is open in another tab. Close that tab before editing here, or export a backup.';
      } else if ((projectId || supplied) && (['QUOTA_EXCEEDED', 'TRANSACTION_ABORTED'].includes(error.code) || ['QuotaExceededError', 'AbortError', 'UnknownError'].includes(error.name))) {
        readonly = true; recoveryRequired = true;
        readonlyReason = 'Recovery could not be saved. This project is read only; finished recordings can still be downloaded. Free space using Manage storage or browser settings, then Retry recovery.';
      } else throw error;
    }
    // Only expose a recovery-limited session if its existing metadata is still
    // readable. A dead worker or unreadable asset index remains a fatal open.
    const assets = await this.storage.listAssets(next.id); this.pruneRecordingMixSettings(next, assets); const used = new Set(referencedAssets({ ...next, pendingCapture: null }));
    this.state.readonly = readonly; this.state.readonlyReason = readonlyReason; this.state.recoveryRequired = recoveryRequired; this.state.deletionPending = deletionPending;
    this.state.project = next; this.state.sampleRate = next.sampleRate; this.state.selectedTrackId = next.tracks[0]?.id || null;
    this.state.capture = null; this.state.recentRecording = latestProjectRecording(next); this.state.audition = null; this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; next.input.monitor = false;
    this.state.transportFrame = 0; this.state.paused = false; this.state.playbackOffsets = {}; this.state.playbackBaselines = {}; this.pausedMedia = []; this.pausedTransport = false; this.resetTransportOnInit = false;
    this.state.activeSectionId = null; this.state.queuedSectionId = null; this.history.clear();
    this.state.recovered = assets.filter(a => a.frames > 0 && a.status !== 'cancelled' && !used.has(a.id)).map(a => ({ ...a, needsRecovery: a.status === 'recording' }));
    this.state.discarded = assets.filter(isDiscardedCapture);
    this.state.mixMode = next.performances.some(item => !item.removed) || assets.some(item => item.kind === 'recording' || item.kind === 'mix') ? 'recordings' : 'layers';
    this.updateAudioIntegrity(next, assets);
    this.state.status = deletionPending ? 'Deletion unfinished · retry in Manage storage' : recoveryRequired ? 'Recovery required · read only' : readonly ? 'Read only · another tab is editing' : this.state.damagedAudio.length ? 'Saved audio is incomplete · review Song' : this.state.recovered.length ? `${this.state.recovered.length} recording${this.state.recovered.length === 1 ? '' : 's'} available to recover` : 'Saved on this device';
    this.state.busy = false; this.state.error = recoveryRequired || deletionPending ? readonlyReason : null;
    this.state.projects = await this.storage.listProjects();
    try { localStorage.setItem('fml:last-project', next.id); } catch {}
    this.render();
    if (recoveryRequired || deletionPending) this.ui.notify(readonlyReason, 'error');
    else if (readonly) this.ui.notify('This project is open in another tab. Playback and backup are available here.', 'info');
    else if (next.pendingCapture && this.state.recovered.length) this.ui.notify('An unfinished recording was recovered. Its saved audio is available in Manage storage.', 'info');
    } finally { this.openingProject = false; this.state.busy = false; this.render(); }
  }
  async ensureAudio() {
    if (!this.state.project) throw new Error('The project is still opening.');
    this.assertAudioSources(this.state.project.tracks.map(track => track.assetId));
    if (!this.engine) {
      this.engine = new AudioEngine(this.storage);
      const engine = this.engine;
      for (const name of ['state', 'meter', 'count-in', 'capture-start', 'capture-end', 'capture-rejected', 'asset-sealed', 'section', 'command', 'automation', 'track-ready', 'mic', 'devices', 'error', 'interrupted', 'device-lost', 'context-state', 'audition-start', 'audition-end']) {
        engine.addEventListener(name, e => { if (this.engine === engine && !this.state.storageFailed) this.audioEvent(name, e.detail); });
      }
      engine.addEventListener('underrun', () => {
        if (this.engine !== engine || this.state.storageFailed) return;
        if (Date.now() - this.lastUnderrunAt > 5000) { this.lastUnderrunAt = Date.now(); this.ui.notify('Storage could not supply audio in time. Stop and reopen the project if you hear a gap.', 'error'); }
        if (this.pending) this.pending.hadUnderrun = true;
      });
    }
    const engine = this.engine;
    await engine.init(this.state.project);
    if (engine !== this.engine) throw Object.assign(new Error('Audio session changed.'), { name: 'AbortError' });
    await engine.waitUntilReady();
    if (this.resetTransportOnInit) { engine.stop(); this.resetTransportOnInit = false; }
    return engine;
  }
  audioEvent(type, data) {
    if (['audition-start', 'audition-end'].includes(type) && (data.transportGeneration ?? 0) < (this.engine?.transportGeneration ?? 0)) return;
    if (type === 'context-state') {
      const engine = this.engine;
      // Closing a project intentionally also closes its AudioContext. Those
      // lifecycle notifications must not look like an operating-system fault.
      if (!engine || engine.closed || engine.suppressedStateChange || this.openingProject || this.state.storageFailed) return;
      this.state.audioContextState = data.state;
      if (data.state === 'running') {
        if (this.state.audioPaused) { this.state.audioPaused = false; this.state.status = 'Audio ready'; this.render(); }
        return;
      }
      if (!['suspended', 'interrupted', 'closed'].includes(data.state)) return;
      const hadCapture = !!this.pending || !!this.state.capture;
      ++this.generation; engine.cancelPendingMic?.(); engine.cancelReadiness?.();
      this.state.playing = false; this.state.audition = null; this.state.monitor = false;
      this.state.inputLevel = 0; this.state.outputLevel = 0; this.state.audioPaused = true;
      if (this.state.project) this.state.project.input.monitor = false;
      this.releaseWake().catch(() => {});
      if (hadCapture || data.state === 'closed') {
        // A suspended capture can retain unwritten samples inside its worklet.
        // Seal its verified prefix and retire that graph before a fresh gesture,
        // so resuming cannot append stale samples to an already sealed asset.
        if (!this.pending) { this.state.capture = null; this.state.busy = false; }
        this.recoverAudioEngine(data.state === 'closed' ? 'The audio session closed unexpectedly.' : 'Audio was paused by your device.').catch(error => this.handleError(error));
      } else {
        engine.pause(); this.pausedTransport = true; this.state.paused = true;
        this.state.status = 'Audio paused · press Play or Record to resume'; this.render();
      }
      return;
    }
    if (type === 'count-in') { this.state.status = 'Count in · get ready'; return; }
    if (type === 'state' || type === 'meter') {
      // The audio port may already contain a meter from before Stop/Pause/Play.
      // Never let that old transport snapshot resurrect the old playhead.
      if ((data.transportGeneration ?? 0) < (this.engine?.transportGeneration ?? 0)) return;
      if (this.resetTransportOnInit) return;
      // A meter already queued before suspension must not re-disable Play by
      // advertising the audio thread's previous playing state.
      if (this.engine?.context && ['suspended', 'interrupted', 'closed'].includes(this.engine.context.state)) return;
      if (this.state.audioPaused) { this.state.audioPaused = false; this.state.status = 'Audio ready'; }
      this.state.playing = !!data.playing; this.state.transportFrame = data.transportFrame || 0;
      this.state.paused = !!data.paused || this.pausedMedia.length > 0;
      if (data.playbackOffsets) this.state.playbackOffsets = { ...data.playbackOffsets };
      if (data.playbackBaselines) this.state.playbackBaselines = { ...data.playbackBaselines };
      this.state.audition = data.audition || null;
      this.state.liveBaseFrames = data.baseFrames || this.state.project.baseFrames;
      if (this.pending) this.state.capture = { startMode: this.pending.startMode, lengthMode: this.pending.lengthMode, ...(data.capture || { id: this.pending.id, kind: this.pending.kind, status: this.pending.ended ? 'finishing' : 'arming', elapsedFrames: this.pending.end?.frames || 0 }) };
      else if (!this.state.busy) this.state.capture = data.capture;
      if (type === 'meter') {
        this.state.inputLevel = data.inputLevel || 0; this.state.outputLevel = data.outputLevel || 0;
        this.ui.updateMeters?.(data); this.ui.updateTransport?.({ ...data, sampleRate: this.state.sampleRate });
        this.ui.updateLiveInput?.(data);
        if (this.pending && Date.now() - this.lastCheckpointAt > 1100) { this.lastCheckpointAt = Date.now(); this.updateCaptureIntent(); this.scheduleSave(); }
      } else this.render();
      return;
    }
    if (type === 'mic') { this.state.micEnabled = data.enabled; if (!data.enabled) { this.state.monitor = false; this.state.inputLevel = 0; } else if (typeof data.selectedDeviceId === 'string') this.state.preferredDeviceId = data.selectedDeviceId; this.state.micSettings = data.settings; this.render(); return; }
    if (type === 'devices') { this.state.micDevices = data.devices || []; this.render(); return; }
    if (type === 'audition-start') {
      this.state.audition = { ...this.state.audition, id: data.id, startFrame: data.startFrame, endFrame: data.endFrame, status: 'playing' };
      this.state.playing = true;
      if (!this.pending && !this.state.capture) this.state.status = 'Live mix audition · current backing and selected vocal';
      this.render(); return;
    }
    if (type === 'audition-end') {
      this.state.audition = null; this.state.playing = false;
      if (!this.pending && !this.state.capture && !this.state.exporting) this.state.status = data.reason && data.reason !== 'finished' ? 'Live audition stopped' : 'Live audition finished';
      this.releaseWake(); this.render(); return;
    }
    if (type === 'capture-rejected') {
      const p = this.pending, project = this.state.project, token = this.generation;
      if (!p || p.id !== data.captureId || p.started || p.rejection || data.activeCaptureId === p.id || (p.projectId && p.projectId !== project.id)) return;
      this.state.capture = { kind: p.kind, status: 'finishing', elapsedFrames: 0 };
      this.state.busy = true; this.state.status = 'Clearing recording setup…'; this.render();
      const message = data.message || 'The audio engine could not start this recording. Try again.';
      p.rejection = (async () => {
        let cleanupError = null;
        try { await this.cancelPrepared(p); } catch (error) { cleanupError = error; }
        if (this.state.project !== project || token !== this.generation || this.state.storageFailed) return;
        this.state.status = cleanupError ? 'Discarded recording · storage cleanup needs attention' : 'Ready to record';
        this.handleError(new Error(cleanupError ? `${message} Recording setup could not be fully saved: ${cleanupError.message}. Retry cleanup in the Song view.` : message));
      })();
      return;
    }
    if (type === 'capture-start') {
      if (this.pending?.id !== data.captureId) return;
      const project = this.state.project;
      const initialState = data.initialState || { tracks: clone(project.tracks), baseFrames: project.baseFrames, master: clone(project.master), input: clone(project.input), inputMix: clone(project.input.mix || this.pending.track.mix), engineVersion: 1 };
      this.pending.initialState = { ...clone(initialState), frame: data.startFrame };
      if (initialState.inputMix) this.pending.track.mix = normalizeMix(initialState.inputMix);
      this.pending.startFrame = data.startFrame; this.pending.started = true;
      this.state.capture = { id: data.captureId, kind: data.kind, status: this.pending.stopRequested ? 'finishing' : 'recording', elapsedFrames: 0, startFrame: data.startFrame, targetFrames: this.pending.lengthFrames, startMode: this.pending.startMode, lengthMode: this.pending.lengthMode };
      this.state.status = 'Recording · saving audio continuously'; this.updateCaptureIntent(); this.scheduleSave(0); this.render(); return;
    }
    if (type === 'capture-end') {
      if (this.pending?.id !== data.captureId) return;
      this.pending.end = data; this.pending.ended = true; this.state.capture = { id: data.captureId, kind: data.kind, status: 'finishing', elapsedFrames: data.frames };
      this.state.status = 'Finishing and saving…'; this.render(); this.tryFinalize().catch(e => this.handleError(e)); return;
    }
    if (type === 'asset-sealed') { this.sealed.set(data.assetId, data); this.tryFinalize().catch(e => this.handleError(e)); return; }
    if (type === 'section') {
      // The editor stopped the graph and cancelled queued section launches.
      // Ignore acknowledgements already in flight; its save uses a fixed mix.
      if (this.trackEditOperation) return;
      const section = data.section || this.state.project.sections.find(s => s.id === data.id);
      if (section) { applySection(this.state.project, section); this.state.activeSectionId = section.id; this.state.queuedSectionId = null; this.recordEvent({ frame: data.projectFrame, type: 'section', section: clone(section) }); this.scheduleSave(); this.render(); }
      return;
    }
    if (type === 'command') {
      const command = typeof data.command === 'string' ? data.command : data.command?.type;
      if (command && !['play', 'pause', 'stop', 'seek', 'clear', 'arm', 'cancel', 'finish'].includes(command)) {
        const payload = data.payload || data.data || (typeof data.command === 'object' ? data.command : data);
        const clean = jsonSafe(payload); delete clean.requestId; delete clean.type; delete clean.command; delete clean.projectFrame; delete clean.transportFrame; delete clean.clockFrame;
        this.recordEvent({ ...clean, frame: data.frame ?? data.projectFrame, type: command });
      }
      return;
    }
    // command acknowledgements are authoritative; automation is an optional UI notification.
    if (type === 'automation') return;
    if (type === 'interrupted' || type === 'device-lost') {
      // These events describe microphone interruption. AudioContext/processor
      // failures have their own handlers and still seal a loop-only capture.
      if ((this.pending?.kind || this.state.capture?.kind) !== 'mix') this.interrupt(data.message).catch(e => this.handleError(e));
      return;
    }
    if (type === 'error') {
      if (data.fatal) { this.recoverAudioEngine(data.message).catch(error => this.handleError(error)); return; }
      this.handleError(new Error(data.message || 'The audio engine reported an error.')); return;
    }
  }
  recordEvent(event) {
    if (!Number.isSafeInteger(event.frame) || event.frame < 0) return;
    const p = this.pending;
    // Loop assets contain only clean microphone samples. Their mix edits remain
    // in the project; both stereo capture modes retain an arrangement log.
    if (p?.kind === 'loop') return;
    if (p?.started && !p.ended) {
      if (!p.metadataBudget) {
        this.updateCaptureIntent();
        try { p.metadataBudget = new CaptureMetadataBudget(this.state.project); }
        catch { this.finishAtMetadataLimit(event.frame); return; }
      }
      if (p.metadataBudget.append(event, p.events.length)) {
        p.events.push(event);
        if (!p.metadataBudget.hasRoom() || p.events.length >= MAX_AUTOMATION_EVENTS) this.finishAtMetadataLimit();
      } else this.finishAtMetadataLimit(event.frame);
    }
  }
  finishAtMetadataLimit(missingFrame = null) {
    const p = this.pending; if (!p || p.ended) return;
    const missing = Number.isSafeInteger(missingFrame) && missingFrame >= 0;
    const changed = missing && (!p.arrangementIncomplete || missingFrame < p.arrangementThroughFrame);
    if (missing) {
      p.arrangementIncomplete = true; p.interrupted = true;
      p.arrangementThroughFrame = Math.min(p.arrangementThroughFrame ?? missingFrame, missingFrame);
      // Persist the boundary without recursively reconciling an oversized project.
      const intent = this.state.project.pendingCapture;
      if (intent?.id === p.id) { intent.arrangementIncomplete = true; intent.arrangementThroughFrame = p.arrangementThroughFrame; }
    }
    if (p.budgetReached) { if (changed) this.scheduleSave(0); return; }
    p.budgetReached = true; this.state.busy = true; this.engine?.finish();
    this.scheduleSave(0);
    this.state.status = 'Finishing performance · arrangement limit reached';
    this.ui.notify('This performance reached its arrangement memory limit and is being saved. Its full original recordings are retained; start a new project to continue a larger arrangement.', 'info'); this.render();
  }
  updateCaptureIntent(force = false) {
    const p = this.pending; if (!p || (p.finalizing && !force)) return;
    // Stop resets the visible transport before an alignment tail is drained.
    // Keep the recovery checkpoint on the capture's original musical timeline.
    p.intentTransportFrame = Math.max(p.intentTransportFrame || 0, this.state.transportFrame, p.end ? (p.end.startFrame ?? p.startFrame ?? 0) + (p.end.frames || 0) : 0);
    this.state.project.pendingCapture = { id: p.id, kind: p.kind, assetId: p.assetId, masterAssetId: p.masterAssetId || null, performanceId: p.performanceId || null,
      takeId: p.takeId || null, track: p.track, startFrame: p.startFrame ?? 0, initialState: p.initialState, events: p.events,
      ...(p.arrangementIncomplete ? { arrangementIncomplete: true, arrangementThroughFrame: p.arrangementThroughFrame } : {}),
      sealedThroughFrame: Math.max(p.startFrame || 0, p.intentTransportFrame - (p.kind === 'mix' ? 0 : Math.round(this.state.project.input.compensationMs * this.state.sampleRate / 1000))), createdAt: p.createdAt };
    if (p.metadataBudget && !p.ended) {
      try { if (!p.metadataBudget.reconcile(this.state.project)) this.finishAtMetadataLimit(); }
      catch { this.finishAtMetadataLimit(this.state.transportFrame); }
    }
  }
  captureRecordingOptions(kind, legacyCycles) {
    const project = this.state.project, preferences = normalizeLoopRecording(project.loopRecording);
    let mode = preferences.mode, lengthFrames = 0;
    if (kind === 'loop' && legacyCycles !== undefined) {
      if (!Number.isSafeInteger(legacyCycles) || legacyCycles < 0) throw new Error('Choose a valid number of recording cycles.');
      mode = legacyCycles && project.baseFrames ? 'cycles' : 'free';
      if (mode === 'cycles') preferences.cycles = legacyCycles;
    }
    if (kind === 'loop') {
      if (mode === 'seconds') lengthFrames = Math.round(preferences.seconds * project.sampleRate);
      else if (mode === 'cycles') {
        if (!project.baseFrames) throw new Error('Record the first loop before choosing a number of cycles, or choose a duration in seconds.');
        lengthFrames = project.baseFrames * preferences.cycles;
      }
      if (!Number.isSafeInteger(lengthFrames) || lengthFrames < 0 || (mode !== 'free' && !lengthFrames)) throw new Error('Choose a valid recording length that fits this project’s sample rate.');
      const minimumFrames = Math.round(project.input.compensationMs * project.sampleRate / 1000) + 129;
      if (lengthFrames && lengthFrames < minimumFrames) throw new Error(`Choose a loop longer than ${Math.ceil(minimumFrames / project.sampleRate * 1000)} ms, or reduce Recording compensation before recording.`);
    }
    return { lengthFrames, lengthMode: kind === 'loop' ? mode : 'free', startMode: preferences.start === 'next-cycle' && project.baseFrames ? 'next-cycle' : 'immediate' };
  }
  refreshCaptureCapacity(token, projectId, captureId) {
    // Advisory storage estimates must never delay microphone capture. An old
    // request also cannot replace capacity information in a later session.
    return Promise.resolve().then(() => this.storage.estimate()).catch(() => ({ usage: null, quota: null })).then(capacity => {
      if (token !== this.generation || this.state.project?.id !== projectId || this.pending?.id !== captureId || this.state.storageFailed) return;
      this.state.storage = { ...this.state.storage, ...capacity }; this.render();
    }).catch(() => {});
  }
  async startCapture(kind, legacyCycles) {
    this.assertWritable(); if (this.pending || this.state.capture) throw new Error('A recording is already active.');
    if (this.state.busy) throw new Error('Finish the current operation before recording.');
    if (this.state.exporting) throw new Error('Finish or cancel the export before recording.');
    if (!['loop', 'vocal', 'mix'].includes(kind)) throw new Error('Choose a supported recording mode.');
    if (kind === 'mix' && !this.state.project.tracks.some(track => !track.muted && track.frames > 0)) throw new Error('Unmute at least one saved loop before recording all the loops.');
    if (kind === 'loop' && this.state.project.tracks.length >= MAX_TRACKS) throw new Error(`This project has reached ${MAX_TRACKS} layers. Start another project or remove unused layers.`);
    const recordingOptions = this.captureRecordingOptions(kind, legacyCycles);
    this.closePreview(); this.state.error = null;
    if (this.state.audition) { this.engine?.stop(); this.state.audition = null; this.state.playing = false; }
    const token = ++this.generation; this.state.capture = { kind, status: 'arming', preparing: true, waitingForMic: kind !== 'mix', elapsedFrames: 0, ...recordingOptions, targetFrames: recordingOptions.lengthFrames }; this.state.busy = true; this.state.status = 'Preparing recording…'; this.render();
    let pending = null;
    try {
      const engine = await this.ensureAudio(); if (token !== this.generation) return;
      if (kind !== 'mix') { await engine.enableMic(this.state.preferredDeviceId); if (token !== this.generation) return; }
      const available = normalizedStorageCapacity(this.state.storage);
      // An origin quota estimate is advisory, and can lag behind deletions.
      // The actual journal writes decide whether recording can continue.
      if (available.low) this.ui.notify(`The browser estimates ${available.remaining.toLocaleString('en-US')} bytes remaining for this site. Open Storage at the top right to review files and free space. Recording will continue while saving is possible.`, 'info');
      const project = this.state.project, captureId = id('capture-'), assetId = id('audio-'), masterAssetId = kind === 'vocal' ? id('master-') : null;
      const role = kind === 'vocal' ? 'lead' : project.tracks.length === 0 ? 'beat' : project.tracks.length === 1 ? 'bass' : 'harmony';
      const label = kind === 'mix' ? nextLoopRecordingName(project) : kind === 'vocal' ? `Vocal take ${project.takes.length + 1}` : `${role[0].toUpperCase()}${role.slice(1)} ${project.tracks.length + 1}`;
      const track = createTrack({ assetId, name: label, role });
      const { lengthFrames, lengthMode, startMode } = recordingOptions;
      let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
      pending = { id: captureId, projectId: project.id, kind, assetId, masterAssetId, track, lengthFrames, lengthMode, startMode, events: [], startFrame: 0, createdAt: now(),
        performanceId: kind !== 'loop' ? id('performance-') : null, takeId: kind === 'vocal' ? id('take-') : null,
        initialState: { tracks: clone(project.tracks), baseFrames: project.baseFrames, master: clone(project.master), input: clone(project.input), inputMix: clone(track.mix), frame: this.state.transportFrame, engineVersion: 1 }, done, resolveDone };
      this.pending = pending; this.updateCaptureIntent();
      pending.metadataBudget = new CaptureMetadataBudget(project);
      if (!pending.metadataBudget.hasRoom()) throw new Error('This project has reached its arrangement memory limit. Export a backup and start a new project before recording again.');
      await this.saveNow();
      await this.storage.beginAsset({ id: assetId, projectId: project.id, sampleRate: project.sampleRate, channels: kind === 'mix' ? 2 : 1, kind: kind === 'mix' ? 'master' : kind, ...(kind === 'mix' ? { source: 'loops' } : { track }), name: label, captureId, performanceId: pending.performanceId, createdAt: Date.now() });
      if (masterAssetId) await this.storage.beginAsset({ id: masterAssetId, projectId: project.id, sampleRate: project.sampleRate, channels: 2, kind: 'master', name: `Performance ${project.performances.length + 1}`, captureId, leadAssetId: assetId, performanceId: pending.performanceId });
      if (token !== this.generation) { await this.cancelPrepared(pending); return; }
      engine.configure(project); engine.arm({ id: captureId, kind, assetId, masterAssetId, track, lengthFrames, quantized: startMode === 'next-cycle' });
      this.state.busy = false; this.state.capture = { kind, status: 'arming', elapsedFrames: 0, targetFrames: lengthFrames, lengthMode, startMode }; this.state.status = startMode === 'next-cycle' && this.state.playing ? 'Ready at the next cycle' : 'Starting recording…';
      this.keepAwake(); this.render(); this.refreshCaptureCapacity(token, project.id, captureId);
    } catch (error) {
      if (pending && !pending.started) await this.cancelPrepared(pending).catch(() => {});
      if (token === this.generation) { this.state.capture = null; this.state.busy = false; this.render(); }
      throw error;
    }
  }
  async cancelPrepared(p) {
    if (p.finalizing) return p.done;
    p.finalizing = true;
    const project = this.state.project, intent = project.pendingCapture;
    try {
      for (const assetId of [p.assetId, p.masterAssetId].filter(Boolean)) await this.storage.finishAsset(assetId, { status: 'cancelled' }).catch(() => {});
      if (this.pending !== p || (p.projectId && p.projectId !== project.id) || this.state.project !== project || this.state.storageFailed) return;
      const assets = (await this.storage.listAssets(project.id)).filter(asset => [p.assetId, p.masterAssetId].includes(asset.id));
      this.retainRecoverable(assets);
      this.retainDiscarded(assets);
      // A failed seal keeps the recovery intent. A cancelled asset is reclaimed
      // only after a manifest without that intent has durably committed.
      if (assets.some(asset => asset.status !== 'cancelled')) this.updateCaptureIntent(true);
      else delete project.pendingCapture;
      await this.saveNow();
      await this.cleanupDiscardedCapture(p, project);
    } catch (error) {
      if (this.state.project === project && intent && !project.pendingCapture) project.pendingCapture = intent;
      throw error;
    } finally {
      if (this.pending === p) { this.pending = null; this.state.capture = null; this.state.busy = false; }
      for (const assetId of [p.assetId, p.masterAssetId].filter(Boolean)) this.sealed.delete(assetId);
      p.resolveDone?.(); this.render();
    }
  }
  storageProgress(data) {
    if (data.projectId !== this.state.project?.id) return;
    if (data.sealed) this.sealed.set(data.assetId, data);
    if (this.pending && [this.pending.assetId, this.pending.masterAssetId].includes(data.assetId)) {
      this.state.savedFrames = data.checkpointFrames || 0;
      if (data.sealed) this.tryFinalize().catch(error => this.handleError(error));
    }
  }
  retainRecoverable(assets) {
    const retained = new Map(this.state.recovered.map(asset => [asset.id, asset]));
    for (const asset of assets) if (asset?.frames > 0 && asset.status !== 'cancelled') retained.set(asset.id, { ...asset, needsRecovery: asset.status === 'recording' });
    this.state.recovered = [...retained.values()];
  }
  retainDiscarded(assets) {
    const discarded = new Map(this.state.discarded.map(asset => [asset.id, asset]));
    for (const asset of assets) if (isDiscardedCapture(asset)) discarded.set(asset.id, asset);
    this.state.discarded = [...discarded.values()];
  }
  discardedIsReferenced(assetId, project, durable = null) {
    // Undo/Redo explicitly strips pendingCapture; its stale recording intent is
    // not restorable audio. All actual tracks, takes and performance events are.
    return [project, durable, ...this.history.past.map(snapshot => ({ ...snapshot, pendingCapture: null })),
      ...this.history.future.map(snapshot => ({ ...snapshot, pendingCapture: null }))].filter(Boolean)
      .some(snapshot => referencedAssets(snapshot).includes(assetId));
  }
  async cleanupDiscardedCapture(p, project, current = () => this.state.project === project && this.pending === p) {
    const ids = [p.assetId, p.masterAssetId].filter(Boolean);
    try {
      const assets = (await this.storage.listAssets(project.id)).filter(asset => ids.includes(asset.id));
      if (!current() || this.state.storageFailed || this.state.readonly) return;
      this.retainDiscarded(assets); this.retainRecoverable(assets);
      const durable = await this.storage.loadProject(project.id);
      if (!durable || !current()) return;
      for (const candidate of assets) {
        if (!current() || this.state.storageFailed || this.state.readonly) return;
        if (candidate.status !== 'cancelled' || candidate.captureId !== p.id || candidate.projectId !== project.id || !['loop', 'vocal', 'master'].includes(candidate.kind)) continue;
        if (this.discardedIsReferenced(candidate.id, project, durable)) continue;
        try {
          const asset = await this.storage.getAsset(candidate.id);
          if (!current() || this.state.storageFailed || this.state.readonly) return;
          if (asset.id !== candidate.id || asset.status !== 'cancelled' || asset.captureId !== p.id || asset.projectId !== project.id || asset.kind !== candidate.kind || this.discardedIsReferenced(asset.id, project, durable)) continue;
          await this.storage.deleteAsset(asset.id);
          if (this.state.project === project) this.state.discarded = this.state.discarded.filter(item => item.id !== asset.id);
        } catch { /* The discarded card provides an explicit, safe retry. */ }
      }
      if (current() && this.state.discarded.some(asset => ids.includes(asset.id))) this.ui.notify('Recording discarded. Storage cleanup is pending; use Delete discarded recording in the Song view to retry.', 'info');
    } catch {
      if (current()) this.ui.notify('Recording discarded. Reopen this project to retry storage cleanup in the Song view.', 'info');
    }
  }
  async deleteDiscardedRecording(assetId) {
    this.assertWritable(); this.assertIdle();
    if (this.state.busy || this.state.exporting || this.discardedDeletion) throw new Error('Finish the current operation before deleting a discarded recording.');
    const project = this.state.project, token = this.generation, operation = {};
    const current = () => this.state.project === project && this.generation === token && this.discardedDeletion === operation;
    this.discardedDeletion = operation; this.state.busy = true; this.render();
    let removedIntent = null;
    try {
      const assets = await this.storage.listAssets(project.id); if (!current()) return;
      const asset = assets.find(item => item.id === assetId);
      if (!asset || asset.projectId !== project.id || !isDiscardedCapture(asset)) throw new Error('Choose a discarded recording belonging to this project.');
      this.retainDiscarded([asset]);
      const intent = project.pendingCapture;
      if (intent?.id === asset.captureId && [intent.assetId, intent.masterAssetId].includes(assetId)) {
        const members = [intent.assetId, intent.masterAssetId].filter(Boolean).map(id => assets.find(item => item.id === id)).filter(Boolean);
        if (members.some(item => item.status !== 'cancelled' || item.captureId !== intent.id)) throw new Error('This recording still contains recoverable audio. Recover it before removing its saved intent.');
        removedIntent = intent; delete project.pendingCapture;
      }
      if (this.discardedIsReferenced(assetId, project)) throw new Error('This recording is still used by this project or its undo history and cannot be deleted.');
      await this.saveNow();
      removedIntent = null;
      if (!current()) return;
      await this.cleanupDiscardedCapture({ id: asset.captureId, assetId }, project, current);
      if (current() && !this.state.discarded.some(item => item.id === assetId)) { this.state.status = 'Discarded recording deleted'; this.ui.notify('Discarded recording deleted.', 'success'); }
    } finally {
      if (removedIntent && this.state.project === project && !project.pendingCapture) project.pendingCapture = removedIntent;
      if (this.discardedDeletion === operation) this.discardedDeletion = null;
      if (this.state.project === project && token === this.generation) this.state.busy = false;
      this.render();
    }
  }
  async tryFinalize() {
    const p = this.pending; if (!p?.ended || p.finalizing) return;
    const ids = [p.assetId, p.masterAssetId].filter(Boolean); if (!ids.every(assetId => this.sealed.has(assetId))) return;
    p.finalizing = true;
    const project = this.state.project, originalIntent = project.pendingCapture;
    try {
      const assets = new Map(); let needsRecovery = false;
      for (const assetId of ids) {
        let asset = await this.storage.getAsset(assetId);
        if (asset.status === 'recording' || this.sealed.get(assetId)?.finalized === false) {
          p.interrupted = true;
          try { asset = await this.storage.finishAsset(assetId, { frames: asset.checkpointFrames ?? asset.frames, status: p.end.status === 'cancelled' ? 'cancelled' : 'interrupted' }); }
          catch { needsRecovery = true; }
        }
        assets.set(assetId, asset);
      }
      if (needsRecovery) {
        try { await this.storage.recover(this.state.project.id); } catch {}
        for (const assetId of ids) assets.set(assetId, await this.storage.getAsset(assetId));
        needsRecovery = [...assets.values()].some(asset => asset.status === 'recording');
      }
      const knownAssets = new Map((this.recordingAssets || []).map(asset => [asset.id, asset]));
      for (const asset of assets.values()) knownAssets.set(asset.id, asset);
      this.recordingAssets = [...knownAssets.values()];
      const raw = assets.get(p.assetId), master = p.masterAssetId ? assets.get(p.masterAssetId) : null;
      const cancelled = p.end.status === 'cancelled';
      const loopComplete = p.kind === 'loop' && !needsRecovery && p.end.status === 'complete' && raw.status === 'complete'
        && raw.frames > 0 && raw.frames === p.end.frames && !!p.end.track;
      if (p.kind === 'loop' && !loopComplete) {
        // A new loop may already be sounding while its final storage seal is
        // pending. Only durable complete audio may remain in the backing graph.
        this.engine?.send('remove-track', { id: p.track.id });
        this.engine?.configure(project);
      }
      let retainedIntent = needsRecovery, completedRecording = null;
      if (!cancelled && !needsRecovery && raw.frames > 0) {
        this.history.push(this.state.project);
        if (loopComplete) {
          const track = { ...p.end.track, frames: raw.frames, offsetFrames: (p.end.startFrame || 0) % raw.frames };
          this.state.project.tracks.push(track); if (!this.state.project.baseFrames) this.state.project.baseFrames = raw.frames;
          this.state.selectedTrackId = track.id;
          completedRecording = { kind: 'loop', id: track.id, captureId: p.id };
          this.engine?.adoptRecordedTrack?.(track);
          this.engine?.configure(project);
          this.summarize(raw).then(peaks => { const t = this.state.project.tracks.find(t => t.id === track.id); if (t) { t.peaks = peaks; this.scheduleSave(); this.render(); } }).catch(() => {});
        } else if (p.kind === 'mix') {
          const startFrame = p.end.startFrame ?? p.startFrame;
          const complete = p.end.status === 'complete' && raw.status === 'complete' && raw.frames === p.end.frames && !p.hadUnderrun && !p.interrupted && !p.arrangementIncomplete;
          const arrangementFrames = p.arrangementIncomplete ? Math.max(0, (Number.isSafeInteger(p.arrangementThroughFrame) ? p.arrangementThroughFrame : startFrame) - startFrame) : raw.frames;
          const perf = { id: p.performanceId, name: p.track.name, source: 'loops', masterAssetId: raw.id,
            frames: raw.frames, startFrame, endFrame: startFrame + raw.frames, tailFrames: 0, editableFrames: Math.min(raw.frames, arrangementFrames), ...(p.arrangementIncomplete ? { arrangementIncomplete: true } : {}),
            events: p.events.filter(e => e.frame >= startFrame && e.frame < startFrame + raw.frames), initialState: p.initialState, createdAt: p.createdAt, status: complete ? 'complete' : 'interrupted', compensationFrames: 0 };
          this.state.project.performances.push(perf);
          completedRecording = { kind: 'performance', id: perf.id, captureId: p.id };
        } else if (p.kind === 'vocal' && master?.frames > 0) {
          const startFrame = p.end.startFrame ?? p.startFrame;
          const complete = raw.status === 'complete' && master.status === 'complete' && raw.frames === master.frames && !p.hadUnderrun && !p.interrupted && !p.arrangementIncomplete;
          const arrangementFrames = p.arrangementIncomplete ? Math.max(0, (Number.isSafeInteger(p.arrangementThroughFrame) ? p.arrangementThroughFrame : startFrame) - startFrame) : Infinity;
          const perf = { id: p.performanceId, name: `Performance ${this.state.project.performances.length + 1}`, leadAssetId: raw.id, masterAssetId: master.id,
            frames: master.frames, startFrame, endFrame: startFrame + master.frames, tailFrames: 0, editableFrames: Math.min(raw.frames, master.frames, arrangementFrames), ...(p.arrangementIncomplete ? { arrangementIncomplete: true } : {}),
            events: p.events.filter(e => e.frame >= startFrame && e.frame < startFrame + master.frames), initialState: p.initialState, createdAt: p.createdAt, status: complete ? 'complete' : 'interrupted', compensationFrames: p.end.compensationFrames || 0 };
          this.state.project.performances.push(perf);
          const take = { id: p.takeId, name: p.track.name, assetId: raw.id, frames: raw.frames, startFrame, performanceId: perf.id, role: p.track.role || 'lead', mix: clone(p.track.mix), createdAt: p.createdAt };
          this.state.project.takes.push(take); this.state.project.selectedTakeId = take.id;
          completedRecording = { kind: 'performance', id: perf.id, captureId: p.id };
        } else { this.retainRecoverable([raw, master]); retainedIntent = p.kind !== 'loop'; }
      } else if (!cancelled) {
        this.retainRecoverable([raw, master]); retainedIntent ||= p.kind !== 'loop' && Boolean(raw.frames || master?.frames);
      } else {
        this.retainDiscarded([raw, master]); this.retainRecoverable([raw, master]);
        retainedIntent ||= [raw, master].some(asset => asset && asset.status !== 'cancelled');
      }
      if (retainedIntent) this.updateCaptureIntent(true); else delete this.state.project.pendingCapture;
      touch(this.state.project);
      for (const assetId of ids) this.sealed.delete(assetId);
      await this.saveNow();
      if (cancelled) await this.cleanupDiscardedCapture(p, project);
      if (this.pending !== p || this.state.project !== project || this.state.storageFailed) return;
      if (completedRecording) this.state.recentRecording = completedRecording;
      if (this.pending === p) this.pending = null; this.state.capture = null; this.state.busy = false;
      const interrupted = needsRecovery || p.interrupted || p.arrangementIncomplete || raw.status !== 'complete' || (master && (master.status !== 'complete' || master.frames !== raw.frames)) || p.hadUnderrun;
      this.state.status = needsRecovery ? 'Audio retained · recovery required' : cancelled ? 'Recording cancelled · backing continues' : interrupted ? 'Interrupted recording retained' : 'Saved on this device';
      // The persistent saved card confirms success without covering its Listen button.
      if (!completedRecording || cancelled || interrupted || needsRecovery) this.ui.notify(needsRecovery ? 'Your checkpointed audio is retained. Use Recover in Manage storage, or reopen this project, before previewing or exporting it.' : cancelled ? 'Recording cancelled.' : interrupted ? 'The saved portion was retained. Review the interrupted recording before exporting.' : p.kind === 'vocal' ? 'Vocal take and stereo performance saved. Your loops keep playing.' : 'Loop saved. Keep building your song.', cancelled || interrupted ? 'info' : 'success');
    } catch (error) {
      if (this.state.storageFailed || this.state.project !== project || this.pending !== p) return;
      if (p.end.status === 'cancelled' && originalIntent && !project.pendingCapture) project.pendingCapture = originalIntent;
      this.state.status = 'Audio retained · project save needs attention'; this.state.error = error.message; this.pending = null; this.state.capture = null; throw error;
    }
    finally { p.resolveDone?.(); if (this.state.project === project && !this.state.storageFailed && (!this.pending || this.pending === p)) this.state.busy = false; this.render(); }
  }
  async interrupt(message = 'Recording interrupted.', { notify = true } = {}) {
    const engine = this.engine;
    if (this.interruption?.engine === engine && (!this.pending || this.interruption.pending === this.pending)) return this.interruption.promise;
    const p = this.pending, project = this.state.project, preparing = p && !p.started && (this.state.capture?.preparing || this.state.capture?.waitingForMic);
    const operation = { engine, pending: p, promise: null };
    this.interruption = operation;
    operation.promise = (async () => {
      ++this.generation;
      if (p && !p.ended) p.interrupted = true;
      engine?.send('interrupt', { reason: message });
      if (preparing) {
        // startCapture owns assets that may still be inside beginAsset. Its
        // generation check will cancel and seal them once preparation settles.
        // Do not race that writer with a premature seal of a nonexistent asset.
        this.state.status = 'Cancelling interrupted recording setup…'; this.render();
        await p.done;
      } else if (p) {
        // Give an active worklet its chance to flush. A suspended/dead audio
        // thread can preserve only samples already verified by the worker.
        await sleep(100);
        if (this.pending === p && !p.ended && !this.state.storageFailed) {
          const raw = await this.storage.finishAsset(p.assetId, { status: 'interrupted' }).catch(() => this.storage.getAsset(p.assetId));
          if (this.pending !== p || this.state.storageFailed) return;
          this.sealed.set(p.assetId, raw);
          if (p.masterAssetId) {
            const master = await this.storage.finishAsset(p.masterAssetId, { status: 'interrupted' }).catch(() => this.storage.getAsset(p.masterAssetId));
            if (this.pending !== p || this.state.storageFailed) return;
            this.sealed.set(p.masterAssetId, master);
          }
          // A genuine capture-end arriving during a storage await is the
          // authoritative boundary; never overwrite it with a fallback end.
          if (!p.ended) {
            const startFrame = p.startFrame || 0;
            p.end = { captureId: p.id, kind: p.kind, status: 'interrupted', frames: raw.frames, startFrame, endFrame: startFrame + raw.frames, assetId: p.assetId, masterAssetId: p.masterAssetId };
            p.ended = true;
          }
          await this.tryFinalize();
        }
      } else { this.state.capture = null; this.state.busy = false; }
      if (this.engine === engine && this.state.project === project && !this.state.storageFailed) {
        if (notify) this.ui.notify(message, 'error'); this.render();
      }
    })();
    try { return await operation.promise; } finally { if (this.interruption === operation) this.interruption = null; }
  }
  async storageFailed(message) {
    if (this.state.storageFailed) return;
    ++this.generation; this.state.storageFailed = true;
    clearTimeout(this.saveTimer); this.saveTimer = null; this.exportAbort?.abort(); this.recordingMasterOperation?.abort.abort(); this.trackEditOperation?.abort.abort(); this.closeTrackEditor();
    // A dead worker cannot acknowledge seals. Its already committed checkpoints
    // and persisted capture intent are recovered by a fresh page/worker.
    const pending = this.pending; this.pending = null; pending?.resolveDone?.();
    const engine = this.engine; this.engine = null;
    this.closePreview();
    this.state.capture = null; this.state.audition = null; this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; this.state.busy = false;
    if (this.state.project) this.state.project.input.monitor = false;
    this.state.status = 'Saved audio needs recovery';
    this.state.error = `${message || 'Audio storage stopped unexpectedly.'} Reopen the studio to recover the last saved audio checkpoint.`;
    this.ui.notify(this.state.error, 'error'); this.render();
    await engine?.close().catch(() => {}); await this.releaseWake();
  }
  async recoverAudioEngine(message) {
    if (this.audioRecovery) return this.audioRecovery;
    const failedEngine = this.engine, failedProject = this.state.project;
    this.audioRecovery = (async () => {
      ++this.generation; failedEngine?.cancelPendingMic?.(); failedEngine?.cancelReadiness?.();
      let recoveryError = null;
      try {
        if (this.pending) await this.interrupt(message, { notify: false });
        else if (this.state.capture) { this.state.capture = null; this.state.busy = false; }
      }
      catch (error) {
        recoveryError = error;
        // Retain the persisted capture intent and audio checkpoints for reopening.
        // A failed seal must never leave a dead processor owning the record controls.
        const pending = this.pending; this.pending = null; pending?.resolveDone?.();
        this.state.capture = null; this.state.busy = false;
      }
      if (this.engine !== failedEngine) return;
      this.engine = null;
      this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; this.state.audition = null;
      this.state.status = 'Restarting audio session…'; this.render();
      await failedEngine?.close().catch(() => {});
      if (this.engine || this.state.project !== failedProject || this.state.storageFailed) return;
      this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; this.state.audition = null;
      this.state.audioPaused = false;
      if (this.state.project) this.state.project.input.monitor = false;
      this.state.status = recoveryError ? 'Saved audio needs recovery' : 'Audio stopped · ready to reopen';
      this.state.error = recoveryError
        ? `${message || 'The audio engine stopped.'} ${recoveryError.message} Reopen this project to recover its saved audio checkpoints.`
        : `${message || 'The audio engine stopped.'} Press Play or Record to open a fresh audio session.`;
      this.ui.notify(this.state.error, 'error'); await this.releaseWake(); this.render();
    })();
    try { return await this.audioRecovery; } finally { this.audioRecovery = null; }
  }
  scheduleSave(delay = 350) {
    if (this.state.readonly || this.state.storageFailed) return;
    clearTimeout(this.saveTimer);
    if (!this.pending && !this.state.capture) this.state.status = 'Saving…';
    this.saveTimer = setTimeout(() => this.saveNow().catch(error => this.handleError(error)), delay);
  }
  async saveNow() {
    if (!this.state.project || this.state.readonly) return;
    clearTimeout(this.saveTimer); this.saveTimer = null;
    this.updateCaptureIntent(); const savedProject = this.state.project, snapshot = validateProject(savedProject); snapshot.updatedAt = now();
    const serial = ++this.saveSerial; if (!this.pending) this.state.status = 'Saving…';
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.storage.saveProject(snapshot));
    await this.saveChain;
    if (serial === this.saveSerial && this.state.project === savedProject && !this.saveTimer) { savedProject.updatedAt = snapshot.updatedAt; if (!this.pending) this.state.status = 'Saved on this device'; }
    this.render();
  }
  async flushSave() { if (this.saveTimer) await this.saveNow(); else await this.saveChain; }
  edit(action, key = null) { this.assertWritable(); this.history.push(this.state.project, key); action(this.state.project); touch(this.state.project); this.scheduleSave(); this.render(); }
  refreshTrackEditor() {
    const editor = this.state.trackEditor;
    if (!editor) return;
    const track = this.state.project?.tracks.find(item => item.id === editor.trackId);
    if (!track) { this.closeTrackEditor(); return; }
    if (editor.assetId !== track.assetId || editor.frames !== track.frames) {
      this.stopEditorPreview();
      this.editorWaveformAbort?.abort(); this.editorWaveformAbort = null;
      Object.assign(editor, { startFrame: 0, endFrame: track.frames, cursorFrame: 0, error: null, waveformLoading: false, waveformError: null });
    }
    Object.assign(editor, { assetId: track.assetId, name: track.name, frames: track.frames, sampleRate: this.state.project.sampleRate,
      channels: track.channels, peaks: this.editorWaveforms?.get(track.assetId) || [], busy: !!this.trackEditOperation || !!editor.waveformLoading,
      undoAvailable: this.state.undoAvailable, redoAvailable: this.state.redoAvailable,
      tracks: this.state.project.tracks.map(item => ({ id: item.id, name: item.name, frames: item.frames })),
      clipboard: this.audioClipboard ? { name: this.audioClipboard.name, frames: this.audioClipboard.frames, sampleRate: this.audioClipboard.sampleRate, channels: this.audioClipboard.channels } : null });
  }
  async loadEditorWaveform(editor) {
    const abort = new AbortController(), assetId = editor.assetId, project = this.state.project;
    this.editorWaveformAbort?.abort(); this.editorWaveformAbort = abort;
    editor.waveformLoading = true; editor.busy = true; this.ui.updateTrackEditor?.(editor);
    try {
      const asset = await this.storage.getAsset(assetId); abort.signal.throwIfAborted();
      if (asset.projectId !== project.id || asset.frames !== editor.frames || asset.channels !== editor.channels || asset.sampleRate !== project.sampleRate) throw new Error('The saved audio does not match this loop. Reopen the project before editing.');
      const peaks = await summarizeAudioEditSource(this.storage, asset, { signal: abort.signal }); abort.signal.throwIfAborted();
      if (this.state.trackEditor === editor && editor.assetId === assetId && this.state.project === project) {
        (this.editorWaveforms ||= new Map()).set(assetId, peaks);
      }
    } catch (error) {
      if (!isAbort(error) && this.state.trackEditor === editor && editor.assetId === assetId) editor.waveformError = error.message;
    } finally {
      if (this.editorWaveformAbort === abort) {
        this.editorWaveformAbort = null;
        if (this.state.trackEditor === editor) editor.waveformLoading = false;
        this.render();
      }
    }
  }
  stopEditorPreview() {
    this.editorPreviewAbort?.abort(); this.editorPreviewAbort = null;
    globalThis.document?.querySelector('[data-editor-ref="audio"]')?.pause();
    const editor = this.state.trackEditor;
    if (editor?.previewUrl) { URL.revokeObjectURL(editor.previewUrl); this.urls.delete(editor.previewUrl); }
    if (editor) { editor.previewUrl = null; editor.previewBusy = false; }
  }
  closeTrackEditor() {
    // Closing during rendering cancels its uncommitted copy. Once metadata is
    // committing, let that atomic save settle even if the dialog is closed.
    if (this.trackEditOperation && !this.trackEditOperation.committing) this.trackEditOperation.abort.abort();
    this.editorWaveformAbort?.abort(); this.editorWaveformAbort = null;
    this.stopEditorPreview(); this.state.trackEditor = null; this.ui.closeTrackEditor?.();
  }
  openTrackEditor(trackId) {
    this.assertWritable(); this.assertIdle();
    if (this.state.busy || this.state.exporting || this.projectDeletion || this.fileDeletion) throw new Error('Finish the current operation before editing audio.');
    const track = this.state.project.tracks.find(item => item.id === trackId);
    if (!track) throw new Error('Choose a loop to edit.');
    this.assertAudioSources([track.assetId]);
    this.stopEditorPreview(); this.closePreview();
    this.engine?.stop(); this.engine?.send('cancel-section');
    this.state.playing = false; this.state.audition = null; this.state.queuedSectionId = null;
    this.state.project.input.monitor = false; this.state.monitor = false; this.engine?.configure(this.state.project);
    this.releaseWake();
    this.state.trackEditor = { trackId, startFrame: 0, endFrame: track.frames, cursorFrame: 0, previewUrl: null, previewBusy: false, progress: null, error: null, waveformLoading: false, waveformError: null };
    this.refreshTrackEditor(); this.ui.showTrackEditor?.(this.state.trackEditor); this.render();
  }
  editorSelection(action = {}) {
    const editor = this.state.trackEditor;
    if (!editor) throw new Error('Open a loop in the audio editor first.');
    if (this.trackEditOperation) throw new Error('Wait for the audio edit to finish.');
    const startFrame = action.startFrame ?? editor.startFrame, endFrame = action.endFrame ?? editor.endFrame;
    const cursorFrame = action.cursorFrame ?? editor.cursorFrame;
    if (![startFrame, endFrame, cursorFrame].every(Number.isSafeInteger) || startFrame < 0 || endFrame > editor.frames || startFrame >= endFrame || cursorFrame < 0 || cursorFrame > editor.frames) throw new Error('Choose a non-empty selection and a paste position within this loop.');
    this.stopEditorPreview(); Object.assign(editor, { startFrame, endFrame, cursorFrame, error: null }); this.render();
    return editor;
  }
  async copyEditorSelection() {
    const editor = this.editorSelection(), project = this.state.project;
    const copySerial = this.editorCopySerial = (this.editorCopySerial || 0) + 1;
    const selected = { assetId: editor.assetId, startFrame: editor.startFrame, endFrame: editor.endFrame, frames: editor.frames, channels: editor.channels, sampleRate: editor.sampleRate, name: editor.name };
    const asset = await this.storage.getAsset(selected.assetId);
    if (this.state.trackEditor !== editor || this.state.project !== project || this.editorCopySerial !== copySerial) return;
    if (asset.projectId !== project.id || asset.frames !== selected.frames || asset.channels !== selected.channels || asset.sampleRate !== selected.sampleRate) throw new Error('This loop changed. Reopen its audio editor before copying.');
    this.audioClipboard = Object.freeze({ ...createAudioSelection(asset, selected), name: selected.name });
    this.render(); this.ui.notify('Selected audio copied. Choose any loop and paste at its cursor or replace its selection.', 'success');
  }
  async previewEditorSelection() {
    const editor = this.editorSelection(), project = this.state.project, token = this.generation;
    const abort = new AbortController(); this.editorPreviewAbort = abort; editor.previewBusy = true; this.render();
    const current = () => { abort.signal.throwIfAborted(); if (this.state.trackEditor !== editor || this.state.project !== project || this.generation !== token) throw Object.assign(new Error('Preview cancelled.'), { name: 'AbortError' }); };
    try {
      const asset = await this.storage.getAsset(editor.assetId); current();
      if (asset.projectId !== project.id || asset.frames !== editor.frames || asset.channels !== editor.channels || asset.sampleRate !== editor.sampleRate) throw new Error('This loop changed. Reopen its audio editor before listening.');
      const selection = createAudioSelection(asset, editor), parts = [wavHeader({ ...asset, frames: selection.frames })];
      if (selection.frames * asset.channels * 4 > 32 * 1024 * 1024) throw new Error('Choose a shorter selection to listen here. Longer selections can still be copied and edited.');
      const chunkFrames = Math.floor(1024 * 1024 / (asset.channels * 4));
      for (let frame = selection.startFrame; frame < selection.endFrame; frame += chunkFrames) {
        const frames = Math.min(chunkFrames, selection.endFrame - frame);
        const part = await this.storage.getAssetRange(asset.id, { startFrame: frame, frames }); current();
        if (!(part instanceof Blob) || part.size !== frames * asset.channels * 4) throw new Error('The selected audio could not be read completely.');
        parts.push(part);
      }
      current(); const url = URL.createObjectURL(new Blob(parts, { type: 'audio/wav' })); this.urls.add(url); editor.previewUrl = url;
      this.render(); globalThis.document?.querySelector('[data-editor-ref="audio"]')?.play().catch(() => {});
    } catch (error) { if (!isAbort(error)) { if (this.state.trackEditor === editor) editor.error = error.message; throw error; } }
    finally { if (this.editorPreviewAbort === abort) { this.editorPreviewAbort = null; editor.previewBusy = false; this.render(); } }
  }
  async applyTrackAudioEdit(edit) {
    this.assertWritable(); this.assertIdle();
    if (this.state.busy || this.state.exporting || this.projectDeletion || this.fileDeletion) throw new Error('Finish the current operation before editing audio.');
    const editor = this.state.trackEditor;
    if (!editor) throw new Error('Open a loop in the audio editor first.');
    const project = this.state.project, sourceTrack = project.tracks.find(track => track.id === editor.trackId);
    if (!sourceTrack) throw new Error('This loop is no longer in the project.');
    this.assertAudioSources([sourceTrack.assetId]);
    const token = this.generation, operation = { abort: new AbortController(), committing: false };
    this.trackEditOperation = operation; this.state.busy = true; editor.error = null; editor.progress = { ratio: 0 };
    this.editorWaveformAbort?.abort(); this.editorWaveformAbort = null; editor.waveformLoading = false;
    this.stopEditorPreview(); this.closePreview(); this.engine?.stop(); this.engine?.send('cancel-section');
    this.state.playing = false; this.state.audition = null; this.state.queuedSectionId = null;
    this.state.status = 'Saving audio edit…'; this.render();
    let output = null, saved = false, saveAttempted = false, safeToDelete = true, candidateSave = null;
    const current = () => { operation.abort.signal.throwIfAborted(); if (this.trackEditOperation !== operation || this.state.project !== project || this.generation !== token || this.state.storageFailed) throw Object.assign(new Error('Audio edit cancelled.'), { name: 'AbortError' }); };
    try {
      await this.flushSave(); current();
      const baseline = JSON.stringify(project), asset = await this.storage.getAsset(sourceTrack.assetId); current();
      if (asset.projectId !== project.id || asset.frames !== sourceTrack.frames || asset.channels !== sourceTrack.channels || asset.sampleRate !== project.sampleRate) throw new Error('The saved audio does not match this loop. Reopen the project before editing.');
      const plan = planAudioEdit(asset, edit), next = clone(project), nextTrack = next.tracks.find(track => track.id === sourceTrack.id);
      if (plan.frames > project.sampleRate * 24 * 60 * 60) throw new Error('An edited loop can be at most 24 hours long. Choose a shorter length or selection.');
      const outputId = id('edit-');
      // Stable track IDs preserve section controls; historical performances and
      // Undo keep their original asset IDs. The groove grid is never resized.
      Object.assign(nextTrack, { assetId: outputId, frames: plan.frames, channels: plan.channels,
        offsetFrames: ((sourceTrack.offsetFrames % plan.frames) + plan.frames) % plan.frames });
      let lastProgressAt = 0;
      output = await renderAudioEdit(this.storage, { asset, edit, metadata: { id: outputId, projectId: project.id, name: sourceTrack.name, kind: 'edit', track: clone(nextTrack) },
        signal: operation.abort.signal, onProgress: progress => { if (this.state.trackEditor === editor) { editor.progress = progress; if (progress.ratio === 1 || Date.now() - lastProgressAt >= 100) { lastProgressAt = Date.now(); this.render(); } } } });
      current(); nextTrack.peaks = (output.peaks || await summarizeAudioEditSource(this.storage, output, { signal: operation.abort.signal })).map(peak => Math.min(128, peak)); current();
      if (JSON.stringify(project) !== baseline) throw new Error('The project changed while preparing this edit. Try again.');
      touch(next); const candidate = validateProject(next); current();
      operation.committing = true; saveAttempted = true; safeToDelete = false;
      candidateSave = this.saveChain = this.saveChain.catch(() => {}).then(() => this.storage.saveProject(candidate));
      try { await candidateSave; saved = true; }
      catch (error) {
        // A lost acknowledgement can follow a successful database transaction.
        // Never remove new PCM unless a fresh durable read proves it is unused.
        try { const durable = await this.storage.loadProject(project.id); saved = referencedAssets(durable).includes(output.id); safeToDelete = !saved; }
        catch { safeToDelete = false; }
        if (!saved) throw error;
      }
      if (this.state.project !== project || this.state.storageFailed) return;
      this.history.push(project); this.state.project = candidate; ++this.saveSerial;
      (this.editorWaveforms ||= new Map()).set(output.id, nextTrack.peaks);
      this.state.selectedTrackId = nextTrack.id; this.state.activeSectionId = null; this.state.queuedSectionId = null;
      this.engine?.configure(candidate); this.engine?.syncTracks(candidate.tracks);
      this.state.error = null; this.state.status = 'Saved on this device';
      if (this.state.trackEditor === editor) Object.assign(editor, { assetId: output.id, frames: output.frames, startFrame: 0, endFrame: output.frames, cursorFrame: output.frames, error: null });
      this.ui.notify('Audio edit saved. Undo restores the previous version.', 'success');
    } catch (error) {
      if (output && !saved && safeToDelete) {
        try { await this.storage.deleteAsset(output.id); }
        catch { this.retainRecoverable([output]); }
      } else if (output && !saved && saveAttempted) {
        this.retainRecoverable([output]);
        // With neither a commit acknowledgement nor a readable manifest, pause
        // further writes so autosave cannot overwrite a possibly saved edit.
        if (this.state.project === project) {
          this.state.readonly = true;
          this.state.readonlyReason = 'The audio edit could not be verified. Reopen this project to check its saved version before editing again. Your original and edited audio are retained.';
        }
      }
      if (this.state.trackEditor === editor && !isAbort(error)) editor.error = error.message;
      if (!isAbort(error)) {
        if (this.state.project === project) this.state.status = safeToDelete ? 'Audio edit not saved · original loop kept' : 'Audio edit needs verification · read only';
        throw error;
      }
      if (this.state.project === project) this.state.status = 'Audio edit cancelled · original loop kept';
    } finally {
      // This operation already surfaced and reconciled the save error. Do not
      // let a rejected acknowledgement poison every later flushSave call.
      if (candidateSave && this.saveChain === candidateSave) this.saveChain = candidateSave.catch(() => {});
      if (this.trackEditOperation === operation) { this.trackEditOperation = null; this.state.busy = false; }
      if (this.state.trackEditor === editor) editor.progress = null;
      this.render();
    }
  }
  async summarize(asset, points = 96) {
    const pages = Math.ceil(asset.frames / PAGE_FRAMES); if (!pages) return [];
    const peaks = [];
    for (let n = 0; n < Math.min(12, pages); n++) {
      const index = Math.floor(n * pages / Math.min(12, pages)), page = await this.storage.readPage(asset.id, index);
      if (!page.buffer) continue; const pcm = new Float32Array(page.buffer), bins = 8, stride = Math.max(1, Math.floor(page.frames / bins));
      for (let b = 0; b < bins; b++) { let peak = 0; for (let i = b * stride; i < Math.min(page.frames, (b + 1) * stride); i++) peak = Math.max(peak, Math.abs(pcm[i * asset.channels])); peaks.push(peak); }
    }
    return peaks.slice(0, points);
  }
  async keepAwake() {
    if (this.wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    try { this.wakeLock = await navigator.wakeLock.request('screen'); this.wakeLock.addEventListener('release', () => { this.wakeLock = null; }); } catch {}
  }
  async releaseWake() { await this.wakeLock?.release().catch(() => {}); this.wakeLock = null; }
  closePreview() {
    this.pausedMedia = []; this.pausedTransport = false; this.state.paused = false;
    this.stopRecordingMasterPreview();
    this.previewAbort?.abort(); this.previewAbort = null; this.state.previewPreparing = null;
    globalThis.document?.querySelector('#performance-player')?.pause();
    if (this.state.preview?.url) { URL.revokeObjectURL(this.state.preview.url); this.urls.delete(this.state.preview.url); }
    this.state.preview = null;
  }
  offerDownload(result, label = 'Download ready', { group = id('download-group-'), autoDownload = true, notify = true } = {}) {
    const url = URL.createObjectURL(result.blob); this.urls.add(url);
    this.state.downloads.push({ id: id('download-'), group, url, filename: result.filename, label, part: result.part, partCount: result.partCount, assetId: result.assetId });
    // Keep the latest eight exports, including every numbered part of each one.
    // A browser may block automatic multi-file downloads; no part may disappear.
    const groups = [...new Set(this.state.downloads.map(item => item.group || item.id))];
    const expired = new Set(groups.slice(0, Math.max(0, groups.length - 8)));
    this.state.downloads = this.state.downloads.filter(item => {
      if (!expired.has(item.group || item.id)) return true;
      URL.revokeObjectURL(item.url); this.urls.delete(item.url); return false;
    });
    this.render();
    if (autoDownload) { const a = document.createElement('a'); a.href = url; a.download = result.filename; document.body.append(a); a.click(); a.remove(); }
    if (notify) this.ui.notify('Your download is ready.', 'success');
  }
  removeDownloadAsset(assetId) {
    this.state.downloads = this.state.downloads.filter(item => {
      if (item.assetId !== assetId) return true;
      URL.revokeObjectURL(item.url); this.urls.delete(item.url); return false;
    });
    if (this.state.preview?.assetId === assetId) this.closePreview();
  }
  async withExport(fn) {
    this.assertIdle(); if (this.state.exporting) throw new Error('An export is already running.');
    if (this.state.deletionPending || this.projectDeletion?.committing || this.fileDeletion?.committing) throw new Error('Finish deleting files or open another project before exporting.');
    if (this.state.storageFailed) throw new Error('Reopen the studio to recover saved recordings before exporting.');
    this.closePreview();
    this.state.exporting = true; this.state.exportProgress = 0; this.exportAbort = new AbortController(); this.render();
    try {
      try { await this.flushSave(); }
      catch (error) {
        this.exportAbort.signal.throwIfAborted();
        if (this.state.storageFailed || isAbort(error)) throw error;
        // A metadata/quota failure must not trap already sealed recordings.
        // WAV exports verify the asset; backups validate and clone the current
        // in-memory project before reading it. Neither requires a successful
        // device save, and neither can publish an active or incomplete asset.
        this.state.status = 'Device save needs attention · export available';
        this.state.error = `Your latest edits could not be saved on this device. Download a backup or your recordings now. ${error.message || error}`;
        this.ui.notify(this.state.error, 'error'); this.render();
      }
      this.exportAbort.signal.throwIfAborted();
      if (this.state.storageFailed) throw new Error('Reopen the studio to recover saved recordings before exporting.');
      this.assertIdle();
      return await fn(this.exportAbort.signal);
    }
    finally { this.state.exporting = false; this.state.exportProgress = null; this.exportAbort = null; this.render(); }
  }
  async offerAudioDownload(assetId, label, signal, { filenameSuffix = '' } = {}) {
    const named = result => filenameSuffix ? { ...result, filename: result.filename.replace(/\.wav$/i, `-${filenameSuffix}.wav`) } : result;
    try { this.offerDownload({ ...named(await exportWav(this.storage, assetId, { signal })), assetId }, label); }
    catch (error) {
      if (!['WAV_SPLIT_REQUIRED', 'FALLBACK_EXPORT_LIMIT'].includes(error.code)) throw error;
      const group = id('download-group-'); let count = 0;
      try {
        for await (const part of exportWavParts(this.storage, assetId, { signal, maxDataBytes: 256 * 1024 * 1024 })) {
          this.offerDownload({ ...named(part), assetId }, `${label} · part ${part.part} of ${part.partCount}`, { group, autoDownload: false, notify: false }); count++;
        }
      } finally {
        // Keep this recording's numbered parts together, including any finished
        // parts if a later range fails, without displaying a download history.
        if (count) this.ui.showDownloadParts?.(this.state.downloads.filter(item => item.group === group), label);
      }
      this.ui.notify(`${filenameSuffix ? 'The available incomplete audio' : 'Your complete recording'} is ready in ${count} numbered WAV parts. Use each download link to save every part.`, 'success');
    }
  }
  async downloadAsset(assetId, label) {
    this.assertAudioSources([assetId]);
    return this.withExport(signal => this.offerAudioDownload(assetId, label, signal));
  }
  updateAudioIntegrity(project, assets) {
    if (this.state.project !== project) return;
    this.recordingAssets = assets;
    this.audioIntegrityIssues = inspectProjectAudio(project, assets);
    this.refreshAudioIntegrity();
  }
  refreshAudioIntegrity() {
    if (!this.audioIntegrityIssues) return;
    const used = this.audioIntegrityIssues.length && this.state.project ? new Set(referencedAssets({ ...this.state.project, pendingCapture: null })) : new Set();
    this.state.damagedAudio = this.audioIntegrityIssues.filter(asset => used.has(asset.assetId));
  }
  assertAudioSources(assetIds) {
    if (this.state.deletionPending) throw new Error('This project is being deleted. Open Manage storage and retry permanent deletion, or open another project.');
    const ids = new Set(assetIds), damaged = (this.audioIntegrityIssues || this.state.damagedAudio).find(asset => ids.has(asset.assetId));
    if (damaged) throw new Error(`${damaged.name}: ${damaged.message} Review the incomplete audio in Song, or restore a complete project backup. Original song timing has been preserved.`);
  }
  async downloadDamagedAudio(assetId) {
    const issue = this.state.damagedAudio.find(asset => asset.assetId === assetId);
    if (!issue?.prefixAvailable) throw new Error('This recording has no verified audio available to download. Restore a complete project backup.');
    const project = this.state.project;
    return this.withExport(async signal => {
      const asset = await this.storage.getAsset(assetId);
      if (this.state.project !== project || asset.projectId !== project.id || !['complete', 'interrupted', 'recovered'].includes(asset.status)) throw new Error('This recording is not ready for an incomplete-audio download.');
      await this.offerAudioDownload(assetId, 'Incomplete saved audio', signal, { filenameSuffix: 'incomplete' });
    });
  }
  async previewTake(takeId) {
    const take = this.state.project.takes.find(t => t.id === takeId); const perf = this.state.project.performances.find(p => p.id === take?.performanceId);
    if (take) return this.previewRecordedAsset(perf?.masterAssetId || take.assetId, perf?.name || take.name);
  }
  async previewRecordedAsset(assetId, name) {
    this.assertIdle();
    this.assertAudioSources([assetId]);
    if (this.state.exporting || this.state.busy) throw new Error('Finish or cancel the current file operation before listening.');
    const token = this.generation; this.closePreview(); this.engine?.stop(); this.state.audition = null; this.state.playing = false;
    const abort = new AbortController(); this.previewAbort = abort;
    this.state.previewPreparing = { name, assetId }; this.state.status = 'Preparing recorded performance…'; this.render();
    try {
      const exported = await exportWav(this.storage, assetId, { signal: abort.signal });
      if (token !== this.generation || this.previewAbort !== abort) return;
      abort.signal.throwIfAborted();
      const url = URL.createObjectURL(exported.blob); this.urls.add(url); this.state.preview = { url, name, kind: 'performance', assetId };
      this.state.status = 'Recorded performance ready'; this.render();
      globalThis.document?.querySelector('#performance-player')?.play().catch(() => this.ui.notify('Press Play in the performance player to listen.', 'info'));
    } catch (error) { if (!isAbort(error)) throw error; }
    finally { if (this.previewAbort === abort) { this.previewAbort = null; this.state.previewPreparing = null; this.render(); } }
  }
  async importAudio(file) {
    this.assertWritable(); this.assertIdle(); if (!file) return;
    if (this.state.exporting) throw new Error('Finish or cancel the export before importing audio.');
    if (this.importOperation || this.state.busy) throw new Error('Finish the current operation before importing another audio file.');
    if (file.size > 128 * 1024 * 1024) throw new Error('Audio import currently supports files up to 128 MB. Record long takes directly in the studio or import a smaller file.');
    if (this.state.project.tracks.length >= MAX_TRACKS) throw new Error('This project has reached its layer limit.');
    const token = ++this.generation, project = this.state.project, operation = {};
    this.importOperation = operation; this.state.busy = true; this.state.status = 'Importing audio…'; this.render();
    let assetId, attached = false;
    const current = () => { if (token !== this.generation || this.state.project !== project || this.state.storageFailed) throw Object.assign(new Error('Import cancelled.'), { name: 'AbortError' }); };
    try {
      const engine = await this.ensureAudio(); current();
      const bytes = await file.arrayBuffer(); current();
      const decoded = await engine.context.decodeAudioData(bytes); current();
      if (!decoded.length) throw new Error('This file contains no audio samples.');
      if (decoded.length > project.sampleRate * 60 * 20) throw new Error('Imported audio is limited to 20 minutes per file. Longer recordings can be made directly in the studio.');
      assetId = id('audio-'); const track = createTrack({ assetId, name: file.name.replace(/\.[^.]+$/, ''), role: 'harmony', frames: decoded.length });
      await this.storage.beginAsset({ id: assetId, projectId: project.id, sampleRate: project.sampleRate, channels: 1, kind: 'import', name: track.name, sourceName: file.name, track }); current();
      for (let offset = 0, index = 0; offset < decoded.length; offset += PAGE_FRAMES, index++) {
        current();
        const frames = Math.min(PAGE_FRAMES, decoded.length - offset), pcm = new Float32Array(frames);
        for (let c = 0; c < decoded.numberOfChannels; c++) { const channel = decoded.getChannelData(c); for (let i = 0; i < frames; i++) pcm[i] += channel[offset + i] / decoded.numberOfChannels; }
        await this.storage.putPage(assetId, index, pcm.buffer, frames, 1); current();
      }
      const asset = await this.storage.finishAsset(assetId, { frames: decoded.length }); current(); if (asset.status !== 'complete') throw new Error('The imported audio could not be saved completely.');
      track.peaks = await this.summarize(asset); current();
      if (project.tracks.length >= MAX_TRACKS) throw new Error('This project has reached its layer limit.');
      this.edit(p => { p.tracks.push(track); if (!p.baseFrames) p.baseFrames = track.frames; }); attached = true;
      this.state.selectedTrackId = track.id; engine.configure(project); engine.syncTracks(project.tracks); await this.saveNow(); current();
      this.ui.notify('Audio imported as an independent loop.', 'success');
    } catch (error) {
      if (assetId && !attached) { await this.storage.finishAsset(assetId, { status: 'cancelled' }).catch(() => {}); await this.storage.deleteAsset(assetId).catch(() => {}); }
      if (isAbort(error) || token !== this.generation || this.state.project !== project) {
        if (this.state.project === project && !this.pending && !this.state.capture && !this.state.busy) this.state.status = attached ? 'Audio imported · press Play' : 'Audio import cancelled';
        return;
      }
      throw error;
    } finally {
      if (this.importOperation === operation) this.importOperation = null;
      if (token === this.generation) this.state.busy = false;
      this.render();
    }
  }
  async demo() {
    this.assertWritable(); this.assertIdle(); if (this.state.project.tracks.length) { this.ui.notify('Start a new project to load the demo without changing your recordings.', 'info'); return; }
    const token = ++this.generation, project = this.state.project;
    this.state.busy = true; this.state.status = 'Opening the demo groove…'; this.render();
    const sr = this.state.sampleRate, frames = sr * 2, tracks = [], created = []; let attached = false;
    const current = () => { if (token !== this.generation || this.state.project !== project) throw Object.assign(new Error('Demo cancelled.'), { name: 'AbortError' }); };
    try {
      const engine = await this.ensureAudio(); current();
      for (const [kind, name, role, pan] of [['beat', 'Mouth rhythm', 'beat', 0], ['bass', 'Warm bass', 'bass', -.12], ['harmony', 'Air harmony', 'harmony', .25]]) {
        const assetId = id('demo-'), track = createTrack({ assetId, name, role, frames }); track.mix.pan = pan; track.mix.volume = kind === 'beat' ? .85 : kind === 'bass' ? .55 : .35;
        current(); created.push(assetId);
        await this.storage.beginAsset({ id: assetId, projectId: project.id, sampleRate: sr, channels: 1, kind: 'demo', name, track });
        for (let offset = 0, index = 0; offset < frames; offset += PAGE_FRAMES, index++) {
          current();
          const count = Math.min(PAGE_FRAMES, frames - offset), pcm = new Float32Array(count);
          for (let i = 0; i < count; i++) {
            const t = (offset + i) / sr, beat = t % .5;
            if (kind === 'beat') { const seed = Math.sin((offset + i) * 12.9898) * 43758.5453; const noise = (seed - Math.floor(seed)) * 2 - 1; pcm[i] = .75 * Math.sin(2 * Math.PI * (70 * beat + 7 * (1 - Math.exp(-beat * 40)))) * Math.exp(-beat * 35) + noise * .12 * Math.exp(-(t % .25) * 95); }
            else if (kind === 'bass') { const f = t < 1 ? 110 : 82.4069; pcm[i] = .32 * (Math.sin(2 * Math.PI * f * t) + .15 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.min(1, (t % 1) * 20, (1 - t % 1) * 20); }
            else pcm[i] = .2 * (Math.sin(2 * Math.PI * 220 * t) + .45 * Math.sin(2 * Math.PI * 330 * t)) * Math.sin(Math.PI * t / 2) ** 2;
          }
          await this.storage.putPage(assetId, index, pcm.buffer, count, 1);
        }
        const asset = await this.storage.finishAsset(assetId, { frames }); if (asset.status !== 'complete') throw new Error('The demo could not be saved completely.'); track.peaks = await this.summarize(asset); tracks.push(track);
      }
      current();
      this.edit(p => { p.name = p.name === 'My first song' ? 'First light · demo' : p.name; p.tracks = tracks; p.baseFrames = frames; });
      attached = true;
      const intro = sectionFromProject(this.state.project, 'Intro'); intro.tracks[tracks[2].id].muted = true;
      const chorus = sectionFromProject(this.state.project, 'Chorus'); this.state.project.sections.push(intro, chorus);
      this.state.selectedTrackId = tracks[0].id; engine.configure(this.state.project); engine.syncTracks(tracks); await engine.waitUntilReady(); current(); engine.play(); await this.saveNow();
      this.ui.notify('Demo loaded. These are generated sounds; record your own voice to make it yours.', 'success'); this.keepAwake();
    } catch (error) {
      if (!attached) for (const assetId of created) { await this.storage.finishAsset(assetId, { status: 'cancelled' }).catch(() => {}); await this.storage.deleteAsset(assetId).catch(() => {}); }
      if (isAbort(error)) { if (this.state.project === project && !this.pending && !this.state.capture && (token === this.generation || !this.state.busy)) this.state.status = attached ? 'Demo ready · press Play' : 'Demo cancelled'; return; }
      throw error;
    } finally { if (token === this.generation && this.state.project === project) this.state.busy = false; this.render(); }
  }
  async recoverAsset(assetId) {
    this.assertWritable(); this.assertIdle();
    if (this.state.exporting) throw new Error('Finish or cancel the export before recovering a recording.');
    if (this.recoveryOperation || this.state.busy) throw new Error('Finish the current operation before recovering another recording.');
    if (typeof assetId !== 'string' || !assetId) throw new Error('Choose a recording from this project to recover.');
    const token = ++this.generation, project = this.state.project, operation = {}, previousStatus = this.state.status;
    this.recoveryOperation = operation; this.state.busy = true; this.state.status = 'Recovering recording…'; this.render();
    let attached = false;
    const current = () => { if (token !== this.generation || this.state.project !== project || this.state.storageFailed) throw Object.assign(new Error('Recovery cancelled.'), { name: 'AbortError' }); };
    const validate = asset => {
      if (asset.id !== assetId || asset.projectId !== project.id) throw new Error('This recording belongs to a different project.');
      if (asset.sampleRate !== project.sampleRate || ![1, 2].includes(asset.channels) || !Number.isSafeInteger(asset.frames) || asset.frames < 0) throw new Error('This recording has incompatible audio metadata. Export it separately instead.');
      if (!['recording', 'complete', 'interrupted', 'recovered'].includes(asset.status)) throw new Error('This recording is not available to recover.');
    };
    const checkLayerLimit = asset => { if (asset.channels === 1 && asset.kind !== 'vocal' && project.tracks.length >= MAX_TRACKS) throw new Error('This project has reached its layer limit. Export the recovered recording or remove a layer before recovering it here.'); };
    try {
      let asset = await this.storage.getAsset(assetId); current(); validate(asset);
      if (new Set(referencedAssets({ ...project, pendingCapture: null })).has(assetId)) { this.state.status = previousStatus; return; }
      checkLayerLimit(asset);
      if (asset.status === 'recording') {
        this.engine?.stop(); this.state.playing = false;
        await this.storage.recover(project.id); current();
        asset = await this.storage.getAsset(assetId); current(); validate(asset);
        if (asset.status === 'recording') throw new Error('This recording still needs recovery. Free browser storage if necessary, then reopen this project.');
      }
      if (!asset.frames) { this.state.status = 'No saved audio samples are available in this recording'; return; }
      const loopRecording = asset.channels === 2 && asset.kind === 'master' && asset.source === 'loops';
      if (asset.channels === 2 && !loopRecording) { await this.downloadAsset(assetId, 'Recovered stereo recording'); current(); this.state.status = previousStatus; return; }
      const pending = project.pendingCapture?.assetId === assetId ? project.pendingCapture : null;
      let recoveredRecording = null;
      if (loopRecording) {
        const performanceId = id('performance-'), startFrame = pending?.startFrame || 0;
        const arrangementFrames = pending?.arrangementIncomplete ? Math.max(0, (Number.isSafeInteger(pending.arrangementThroughFrame) ? pending.arrangementThroughFrame : startFrame) - startFrame) : asset.frames;
        this.edit(p => {
          p.performances.push({ id: performanceId, name: `${asset.name || nextLoopRecordingName(p)} · recovered`, source: 'loops', masterAssetId: assetId, frames: asset.frames,
            startFrame, endFrame: startFrame + asset.frames, tailFrames: 0, editableFrames: Math.min(asset.frames, arrangementFrames), ...(pending?.arrangementIncomplete ? { arrangementIncomplete: true } : {}),
            events: clone(pending?.events || []).filter(event => event.frame >= startFrame && event.frame < startFrame + asset.frames),
            initialState: clone(pending?.initialState || { tracks: p.tracks, master: p.master, input: p.input, baseFrames: p.baseFrames, frame: startFrame }),
            createdAt: now(), status: pending?.arrangementIncomplete ? 'interrupted' : 'recovered', compensationFrames: 0 });
          if (pending) delete p.pendingCapture;
        });
        recoveredRecording = { kind: 'performance', id: performanceId };
      } else if (asset.kind === 'vocal') {
        const all = await this.storage.listAssets(project.id); current();
        const master = all.find(a => a.projectId === project.id && a.kind === 'master' && a.channels === 2 && a.sampleRate === project.sampleRate && Number.isSafeInteger(a.frames) && a.frames > 0 && (a.leadAssetId === asset.id || (asset.captureId && a.captureId === asset.captureId)) && ['complete', 'interrupted', 'recovered'].includes(a.status));
        this.edit(p => {
          const performanceId = master ? id('performance-') : null, startFrame = pending?.startFrame || 0;
          const arrangementFrames = pending?.arrangementIncomplete ? Math.max(0, (Number.isSafeInteger(pending.arrangementThroughFrame) ? pending.arrangementThroughFrame : startFrame) - startFrame) : Infinity;
          if (master) p.performances.push({ id: performanceId, name: 'Recovered performance', leadAssetId: asset.id, masterAssetId: master.id, frames: master.frames,
            startFrame, endFrame: startFrame + master.frames, tailFrames: 0, editableFrames: Math.min(asset.frames, master.frames, Math.max(0, (pending?.sealedThroughFrame || startFrame) - startFrame), arrangementFrames), ...(pending?.arrangementIncomplete ? { arrangementIncomplete: true } : {}),
            events: clone(pending?.events || []), initialState: clone(pending?.initialState || { tracks: p.tracks, master: p.master, input: p.input, baseFrames: p.baseFrames, frame: startFrame }), createdAt: now(), status: pending?.arrangementIncomplete ? 'interrupted' : 'recovered' });
          const take = { id: id('take-'), name: asset.name || 'Recovered vocal', assetId, frames: asset.frames, startFrame, performanceId, role: 'lead', mix: roleMix('lead'), createdAt: now() }; p.takes.push(take); p.selectedTakeId = take.id;
          if (pending) delete p.pendingCapture;
        });
      } else {
        const track = createTrack({ ...(asset.track || {}), id: id('track-'), assetId, name: `${asset.name || 'Loop'} · recovered`, frames: asset.frames, offsetFrames: 0 });
        track.peaks = await this.summarize(asset); current(); checkLayerLimit(asset);
        this.edit(p => { p.tracks.push(track); if (!p.baseFrames) p.baseFrames = track.frames; if (pending) delete p.pendingCapture; });
        this.state.selectedTrackId = track.id; this.engine?.configure(project); this.engine?.syncTracks(project.tracks);
      }
      attached = true;
      const used = new Set(referencedAssets({ ...project, pendingCapture: null })); this.state.recovered = this.state.recovered.filter(a => !used.has(a.id)); await this.saveNow(); current();
      if (recoveredRecording) this.state.recentRecording = recoveredRecording;
      this.ui.notify('Saved recording recovered into this project.', 'success');
    } catch (error) {
      if (isAbort(error) || token !== this.generation || this.state.project !== project) {
        if (this.state.project === project && !this.pending && !this.state.capture && !this.state.busy) this.state.status = attached ? 'Recording recovered · press Play' : 'Recovery cancelled · saved audio retained';
        return;
      }
      throw error;
    } finally {
      if (this.recoveryOperation === operation) this.recoveryOperation = null;
      if (token === this.generation) this.state.busy = false;
      this.render();
    }
  }
  async manageStorage() {
    this.assertIdle();
    if (this.state.exporting || this.fileDeletion?.committing) throw new Error('Finish the current operation before managing storage.');
    const token = this.generation, inventory = await this.getStorageInventory();
    if (token !== this.generation) return;
    const listed = await this.storage.listProjects(), visible = new Map(listed.map(project => [project.id, project]));
    // The normal picker omits soft-deleted projects. Their retained audio still
    // consumes space, so Storage uses the complete inventory instead.
    const projects = inventory.projects || listed;
    const rows = projects.map(project => {
      const files = inventory.files.filter(file => file.kind !== 'cache' && file.projectId === project.id), byKind = Object.create(null);
      const knownAudioBytes = files.reduce((sum, file) => sum + (Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? file.bytes : 0), 0);
      const unknown = inventory.audioComplete === false || files.some(file => !Number.isSafeInteger(file.bytes) || file.bytes < 0);
      for (const file of files) {
        const kind = file.assetKind || 'audio', group = byKind[kind] ||= { assets: 0, bytes: 0 };
        group.assets++; if (group.bytes !== null) group.bytes = Number.isSafeInteger(file.bytes) && file.bytes >= 0 ? group.bytes + file.bytes : null;
      }
      return { ...visible.get(project.id), ...project, purgePending: !!(project.purgePendingAt || visible.get(project.id)?.purgePendingAt),
        audioBytes: unknown ? null : knownAudioBytes, knownAudioBytes, assetCount: files.length,
        recordingAssets: files.filter(file => file.status === 'recording').length, byKind };
    });
    if (token !== this.generation) return;
    this.state.storageProjects = rows;
    this.ui.showStorageManager?.(rows, this.state.storage, inventory);
    this.render();
  }
  async getStorageInventory() {
    const [audio, caches] = await Promise.all([this.storage.getStorageInventory(), listStudioCacheFiles()]);
    const inventory = { ...audio, audioComplete: audio.complete !== false, files: [...(audio.files || []), ...(caches.files || [])], cacheBytes: caches.cacheBytes,
      knownCacheBytes: caches.knownCacheBytes, unknownFiles: (audio.unknownFiles || 0) + (caches.unknownFiles || 0),
      complete: audio.complete !== false && caches.complete !== false, errors: [...(audio.errors || []), ...(caches.errors || [])] };
    this.state.storage = { ...this.state.storage, usage: audio.usage ?? null, quota: audio.quota ?? null,
      ...(audio.persistent === undefined ? {} : { persistent: audio.persistent }) };
    this.state.storageInventory = inventory;
    return inventory;
  }
  async downloadStorageFile(fileKey) {
    this.assertIdle();
    const inventory = await this.getStorageInventory(), file = inventory.files.find(item => item.key === fileKey);
    if (!file || file.kind !== 'asset') throw new Error('Choose a saved recording to download. Refresh Storage if the file has changed.');
    if (file.status === 'recording') throw new Error('Recover this unfinished recording before downloading it.');
    // WAV export validates the actual saved pages, including assets belonging
    // to another project. No project selection or metadata mutation is needed.
    return this.withExport(signal => this.offerAudioDownload(file.id, file.name || 'Recording', signal));
  }
  async deleteStorageFile(fileKey) {
    const ready = () => {
      this.assertIdle();
      if (this.state.busy || this.state.exporting || this.projectDeletion || this.state.storageFailed) throw new Error('Finish the current operation before deleting a file.');
    };
    ready();
    if (this.fileDeletion) throw new Error('Finish the current operation before deleting another file.');
    if (typeof fileKey !== 'string' || !fileKey) throw new Error('Choose a file from Storage.');
    const project = this.state.project, token = this.generation, operation = { committing: false };
    this.fileDeletion = operation;
    let selected, sourceAssetId = null, currentAffected = false, committed = false, failure = null;
    const current = () => token === this.generation && project === this.state.project;
    try {
      let inventory = await this.getStorageInventory(); if (!current()) return;
      selected = inventory.files.find(file => file.key === fileKey);
      if (!selected) throw new Error('This file is no longer available. Refresh Storage.');
      sourceAssetId = selected.assetId || (selected.kind === 'asset' ? selected.id : null);
      currentAffected = !!sourceAssetId && (referencedAssets(project).includes(sourceAssetId) || selected.referencedProjectIds?.includes(project.id));
      if (currentAffected) {
        // A quota-limited recovery session can still delete files: the worker
        // commits its smaller detached manifest before removing any audio.
        if (!this.state.recoveryRequired) { this.assertWritable(); await this.flushSave(); }
        if (!current()) return;
        // A completed autosave changes the deletion revision, so confirmation
        // must describe the freshly durable file and its project references.
        inventory = await this.getStorageInventory(); if (!current()) return;
        selected = inventory.files.find(file => file.key === fileKey);
        if (!selected) throw new Error('This file is no longer available. Refresh Storage.');
      }
      const descriptions = [];
      if (sourceAssetId) for (const projectId of selected.referencedProjectIds || []) {
        const source = projectId === project.id ? project : await this.storage.loadProject(projectId);
        if (!current()) return;
        const { impacts } = removeAssetReferences(source, sourceAssetId), parts = [];
        for (const [key, label] of [['tracks', 'loop'], ['takes', 'vocal take'], ['performances', 'performance'], ['arrangements', 'saved arrangement']]) {
          if (impacts[key].length) parts.push(`${impacts[key].length} ${label}${impacts[key].length === 1 ? '' : 's'}`);
        }
        if (impacts.pendingCapture) parts.push('its unfinished recording recovery entry');
        if (parts.length) descriptions.push(`“${source.name}”: ${parts.join(', ')}`);
      }
      const confirmedProjectRevision = project.revision;
      const bytes = Number.isSafeInteger(selected.bytes) && selected.bytes >= 0 ? `${selected.bytes.toLocaleString('en-US')} bytes` : 'size unavailable';
      const consequence = selected.kind === 'cache'
        ? 'This removes an offline app file. A future studio update can restore its offline copy. Until then, reopening this part of the studio may require an internet connection.'
        : descriptions.length ? `It will be removed from ${descriptions.join('; ')}. Other audio files are kept.` : 'No saved project uses this file. Other recordings are kept.';
      const accepted = await this.ui.confirm({ title: `Delete ${selected.name || 'file'} permanently?`, message: `Permanently delete “${selected.name || 'file'}” (${bytes}) from this browser? ${consequence} This cannot be undone. Download a copy first if you want to keep it.`, danger: true, confirmLabel: 'Delete permanently' });
      if (!accepted || !current()) return;
      ready();
      if (project.revision !== confirmedProjectRevision) throw new Error('The project changed while confirmation was open. Review the file again before deleting.');
      if (currentAffected) { if (!this.state.recoveryRequired) { this.assertWritable(); await this.flushSave(); } if (!current()) return; }
      inventory = await this.getStorageInventory(); if (!current()) return;
      const fresh = inventory.files.find(file => file.key === fileKey);
      if (!fresh || fresh.revision !== selected.revision || fresh.bytes !== selected.bytes || fresh.status !== selected.status || fresh.name !== selected.name || JSON.stringify(fresh.referencedProjectIds || []) !== JSON.stringify(selected.referencedProjectIds || [])) throw new Error('This file or its project references changed while confirmation was open. Review it again before deleting.');
      if (project.revision !== confirmedProjectRevision) throw new Error('The project changed while confirmation was open. Review the file again before deleting.');
      ready(); operation.committing = true; this.state.busy = true; this.state.status = 'Permanently deleting file…';
      if (sourceAssetId) {
        // Retire all queued audio reads and prevent any in-flight project save
        // from restoring references after the worker has detached them.
        if (currentAffected) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        this.history.clear(); this.closeTrackEditor();
        if (this.audioClipboard?.assetId === sourceAssetId) this.audioClipboard = null;
        this.closePreview(); this.microphoneOperation = null; this.state.micChanging = false;
        const engine = this.engine; this.engine = null;
        this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; this.state.audition = null;
        project.input.monitor = false;
        await engine?.close(); await this.releaseWake();
        await this.saveChain.catch(() => {});
        if (currentAffected) ++this.saveSerial;
      }
      this.render();
      if (selected.kind === 'cache') await deleteStudioCacheFile(selected);
      else await this.storage.deleteStoredFile({ kind: selected.kind, id: selected.id, revision: selected.revision, discardUnfinished: selected.kind === 'asset' });
      committed = true;
      if (sourceAssetId) this.removeDownloadAsset(sourceAssetId);
      this.state.error = null; this.state.status = 'File permanently deleted';
      this.ui.notify(`${selected.name || 'File'} permanently deleted.`, 'success');
    } catch (error) { failure = error; }
    finally {
      if (operation.committing && current()) {
        try {
          // Physical deletion may fail after durable reference removal. Reload
          // even on error so Undo/autosave cannot resurrect detached sources.
          if (currentAffected) {
            this.state.project = validateProject(await this.storage.loadProject(project.id));
            this.state.selectedTrackId = this.state.project.tracks.find(track => track.id === this.state.selectedTrackId)?.id || this.state.project.tracks[0]?.id || null;
            this.state.recentRecording = latestProjectRecording(this.state.project);
            this.state.activeSectionId = null; this.state.queuedSectionId = null;
          }
          const active = this.state.project, assets = await this.storage.listAssets(active.id), used = new Set(referencedAssets({ ...active, pendingCapture: null }));
          this.state.recovered = assets.filter(asset => asset.frames > 0 && asset.status !== 'cancelled' && !used.has(asset.id)).map(asset => ({ ...asset, needsRecovery: asset.status === 'recording' }));
          this.state.discarded = assets.filter(isDiscardedCapture);
          this.pruneRecordingMixSettings(active, assets); this.updateAudioIntegrity(active, assets);
          this.state.projects = await this.storage.listProjects();
        } catch (error) {
          if (currentAffected) { this.state.readonly = true; this.state.readonlyReason = 'Reopen this project to refresh its saved file references before editing.'; }
          failure ||= error;
        }
      }
      if (this.fileDeletion === operation) this.fileDeletion = null;
      if (operation.committing) this.state.busy = false;
      this.render();
    }
    if (operation.committing) await this.manageStorage().catch(error => { if (!failure) failure = error; });
    if (failure) throw failure;
    return { deleted: committed };
  }
  async selectMicrophone(deviceId) {
    this.assertWritable(); this.assertIdle();
    if (this.state.busy || this.state.exporting) throw new Error('Finish the current operation before changing microphones.');
    if (typeof deviceId !== 'string' || (deviceId && !this.state.micDevices.some(device => device.id === deviceId))) throw new Error('Choose an available microphone from the input list.');
    if (this.state.micEnabled && deviceId === this.state.preferredDeviceId) return;
    const token = ++this.generation, operation = {};
    this.microphoneOperation = operation; this.state.busy = true; this.state.micChanging = true; this.state.status = 'Connecting your microphone…'; this.render();
    try {
      const engine = await this.ensureAudio(); if (token !== this.generation) return;
      await engine.enableMic(deviceId); if (token !== this.generation) return;
      this.state.preferredDeviceId = deviceId; this.state.status = 'Microphone connected · ready to record'; this.state.error = null;
    } finally {
      if (this.microphoneOperation === operation) { this.microphoneOperation = null; this.state.micChanging = false; }
      if (token === this.generation) this.state.busy = false;
      this.render();
    }
  }
  async removePerformance(performanceId) {
    const ready = () => {
      this.assertWritable(); this.assertIdle();
      if (this.state.busy || this.state.exporting) throw new Error('Finish the current operation before removing a performance.');
    };
    ready();
    if (this.performanceRemoval) throw new Error('Finish the current operation before removing another performance.');
    const project = this.state.project, token = this.generation;
    const performance = project.performances.find(item => item.id === performanceId && !item.removed);
    if (!performance) return;
    const operation = {}; this.performanceRemoval = operation;
    try {
      const accepted = await this.ui.confirm({ title: 'Remove performance?', message: `Remove “${performance.name}” from the performance list? ${performance.source === 'loops' ? 'Your recorded arrangement and loop layers are kept.' : 'Your vocal take, recorded arrangement and loop layers are kept.'} You can restore this with Undo. Audio is retained; this does not free device storage.`, confirmLabel: 'Remove performance', danger: true });
      if (!accepted || project !== this.state.project || token !== this.generation) return;
      ready();
      const current = project.performances.find(item => item.id === performanceId && !item.removed);
      if (!current) return;
      if (this.state.preview?.assetId === current.masterAssetId || this.state.previewPreparing?.assetId === current.masterAssetId) this.closePreview();
      // Keep the record and its assets: retained takes still use this original
      // arrangement, and Undo must restore a playable stereo performance.
      this.edit(() => { current.removed = true; });
      this.ui.notify('Performance removed. Use Undo to restore it.', 'success');
    } finally {
      if (this.performanceRemoval === operation) this.performanceRemoval = null;
    }
  }
  async deleteSavedMix(assetId) {
    this.assertWritable(); this.assertIdle();
    if (this.state.busy || this.savedMixDeletion) throw new Error('Finish the current operation before deleting a saved mix.');
    if (this.state.exporting) throw new Error('Finish or cancel the export before deleting a saved mix.');
    if (typeof assetId !== 'string' || !assetId) throw new Error('Choose a saved mix from this project.');
    const project = this.state.project, token = this.generation, operation = {};
    this.savedMixDeletion = operation;
    let deleting = false;
    const current = () => token === this.generation && project === this.state.project;
    const validate = asset => {
      this.assertWritable(); this.assertIdle();
      if (this.state.exporting || (!deleting && this.state.busy)) throw new Error('Finish the current operation before deleting a saved mix.');
      if (asset.id !== assetId || asset.projectId !== project.id || asset.kind !== 'mix') throw new Error('Only generated saved mixes belonging to this project can be deleted here.');
      if (!['complete', 'interrupted', 'recovered'].includes(asset.status)) throw new Error('This mix is still being written or is not available to delete.');
      if (!Number.isSafeInteger(asset.frames) || asset.frames < 0 || ![1, 2].includes(asset.channels) || !Number.isSafeInteger(asset.frames * asset.channels * 4)) throw new Error('This saved mix has invalid size information.');
      const references = [project, ...this.history.past, ...this.history.future, this.pending].filter(Boolean);
      if (references.some(snapshot => referencedAssets(snapshot).includes(assetId))) throw new Error('This mix is still used by this project or its undo history and cannot be deleted.');
    };
    try {
      const asset = await this.storage.getAsset(assetId); if (!current()) return; validate(asset);
      const bytes = asset.frames * asset.channels * 4, name = asset.name || 'Untitled saved mix';
      const accepted = await this.ui.confirm({ title: `Delete ${name}?`, message: `Permanently delete the saved mix “${name}” (${bytes.toLocaleString('en-US')} bytes of audio) from this device? Download its WAV or a project backup first if you want to keep this version. Your source loops and vocal recordings will be kept.`, danger: true, confirmLabel: 'Delete saved mix' });
      if (!accepted || !current()) return;
      // Re-read after the dialog: playback, exports, project selection, and
      // history may have changed while confirmation was open.
      const latest = await this.storage.getAsset(assetId); if (!current()) return; validate(latest);
      if (latest.name !== asset.name || latest.frames !== asset.frames || latest.channels !== asset.channels) throw new Error('This saved mix changed while confirmation was open. Review it again before deleting.');
      deleting = true; this.state.busy = true; this.state.status = 'Deleting saved mix…'; this.render();
      await this.storage.deleteAsset(assetId);
      this.removeDownloadAsset(assetId);
      this.state.recovered = this.state.recovered.filter(item => item.id !== assetId);
      if (project.recordingMixSettings && Object.hasOwn(project.recordingMixSettings, assetId)) { delete project.recordingMixSettings[assetId]; await this.saveNow(); }
      const estimate = await this.storage.estimate().catch(() => null);
      if (estimate) this.state.storage = { ...this.state.storage, ...estimate };
      if (current()) { this.state.status = 'Saved mix deleted'; this.ui.notify(`${name} deleted. Your source recordings are still saved.`, 'success'); }
    } finally {
      if (this.savedMixDeletion === operation) this.savedMixDeletion = null;
      if (deleting && current()) this.state.busy = false;
      this.render();
    }
  }
  async deleteProject(projectId) {
    this.assertIdle();
    if (this.state.busy || this.state.exporting || this.projectDeletion) throw new Error('Finish the current operation before deleting a project.');
    const operation = { committing: false }, token = this.generation;
    this.projectDeletion = operation;
    let project, deletingCurrent = false, purged = false, beforeDeletion = null;
    try {
      project = await this.storage.loadProject(projectId);
      if (!project || token !== this.generation) return;
      const accepted = await this.ui.confirm({ title: `Delete ${project.name}?`, message: 'This permanently removes this project, its recordings and its saved takes from this device. Download a project backup first if you want to keep it. Playback will pause.', danger: true, confirmLabel: 'Delete permanently' });
      if (!accepted || token !== this.generation) return;
      this.assertIdle();
      if (this.state.busy || this.state.exporting) throw new Error('Finish the current operation before deleting a project.');
      operation.committing = true; deletingCurrent = project.id === this.state.project?.id;
      this.state.busy = true; this.state.status = 'Freeing project storage…';
      if (deletingCurrent) {
        beforeDeletion = { readonly: this.state.readonly, readonlyReason: this.state.readonlyReason,
          recoveryRequired: this.state.recoveryRequired, deletionPending: this.state.deletionPending, savePending: !!this.saveTimer };
        // Quota may prevent even a tiny replacement project from being saved.
        // Freeze this manifest and retire every writer before freeing its data.
        // Retaining the manifest keeps Manage storage reachable after failure.
        ++this.generation; ++this.saveSerial;
        this.state.readonly = true; this.state.recoveryRequired = false; this.state.deletionPending = true;
        this.state.readonlyReason = 'Project deletion is unfinished. Open Manage storage and retry permanent deletion, or open another project.';
        clearTimeout(this.saveTimer); this.saveTimer = null; this.history.clear();
        this.closePreview(); this.microphoneOperation = null; this.state.micChanging = false;
        const engine = this.engine; this.engine = null;
        this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; this.state.audition = null;
        this.state.project.input.monitor = false; this.render();
        if (engine) await engine.close();
        await this.releaseWake();
        // A save already in flight must settle before deleting its manifest,
        // otherwise its late commit could recreate a project after purging it.
        await this.saveChain.catch(() => {});
      } else { await this.handle({ type: 'stop' }); this.state.busy = true; }
      this.render();
      await this.storage.purgeProject(project.id, deletingCurrent ? { discardUnfinished: true } : {});
      purged = true; operation.committing = false;
      this.state.projects = await this.storage.listProjects();
      if (deletingCurrent) {
        const other = this.state.projects.find(item => item.id !== project.id && !item.purgePendingAt);
        await this.openProject(other?.id || null);
      }
      this.state.storage = { ...this.state.storage, ...await this.storage.estimate().catch(() => ({})) };
      if (!deletingCurrent) this.state.status = this.state.readonly ? this.state.status : 'Saved on this device';
      this.ui.notify(`${project.name} deleted from this device.`, 'success');
    } catch (error) {
      if (deletingCurrent && this.state.project?.id === project.id) {
        const kept = !purged && error.code === 'PROJECT_AUDIO_SHARED' && beforeDeletion && !beforeDeletion.deletionPending
          ? await this.storage.loadProject(project.id).catch(() => null) : null;
        if (kept && !kept.purgePendingAt) {
          // Shared-audio rejection happens before the purge marker or any byte
          // deletion. Keep per-file cleanup reachable without treating this as
          // a partial purge; the stopped graph is still safely retired.
          for (const key of ['readonly', 'readonlyReason', 'recoveryRequired', 'deletionPending']) this.state[key] = beforeDeletion[key];
          this.state.status = beforeDeletion.readonly ? beforeDeletion.readonlyReason || 'Project kept · read only' : 'Project kept · choose individual files in Storage';
          this.state.error = error.message || String(error);
          if (beforeDeletion.savePending && !this.state.readonly) this.scheduleSave();
        } else {
          this.state.readonly = true; this.state.recoveryRequired = false; this.state.deletionPending = true;
          this.state.readonlyReason = purged ? 'This project was deleted. Open another project or create a new one to continue.'
            : 'Project deletion is unfinished. Playback and editing are paused. Open Manage storage and retry permanent deletion, or open another project.';
          this.state.status = purged ? 'Project deleted · choose another song' : 'Deletion unfinished · retry in Manage storage';
          this.state.error = `${this.state.readonlyReason} ${error.message || error}`;
        }
      }
      this.state.projects = await this.storage.listProjects().catch(() => this.state.projects);
      throw error;
    } finally {
      if (this.projectDeletion === operation) this.projectDeletion = null;
      if (operation.committing || deletingCurrent || purged) this.state.busy = false;
      this.render();
    }
  }
  playbackMedia() {
    return [...(this.ui.getPlaybackMedia?.() || [])];
  }
  mediaSource(media) { return media.getAttribute?.('src') || media.currentSrc || media.src || ''; }
  async pausePlayback() {
    if (this.pending || this.state.capture) throw new Error('Finish or stop the recording before pausing playback.');
    if (this.state.busy || this.state.previewPreparing || this.state.recordingMix?.previewBusy || this.state.trackEditor?.previewBusy) throw new Error('Wait for the audio to be ready before pausing.');
    const running = this.playbackMedia().filter(media => !media.paused && !media.ended);
    const transport = this.state.playing || !!this.engine?.playing;
    if (!running.length && !transport) return;
    this.pausedTransport = transport;
    this.pausedMedia = running.map(media => ({ media, source: this.mediaSource(media) }));
    for (const media of running) media.pause();
    if (transport) this.engine?.pause();
    this.state.playing = false; this.state.paused = true;
    this.state.outputLevel = 0; this.state.status = 'Paused · resume from the same position';
    this.render(); await this.releaseWake();
  }
  async playPlayback() {
    if (this.pending || this.state.capture) throw new Error('Finish saving the recording before starting playback.');
    if (this.state.busy || this.state.previewPreparing || this.state.recordingMix?.previewBusy || this.state.trackEditor?.previewBusy) throw new Error('Wait for the audio to be ready before starting playback.');
    const loaded = this.playbackMedia();
    if (this.state.playing || loaded.some(media => !media.paused && !media.ended)) return this.pausePlayback();
    const token = this.generation, resumeTransport = this.pausedTransport;
    let media = this.pausedMedia.filter(item => loaded.includes(item.media) && this.mediaSource(item.media) === item.source).map(item => item.media);
    // A retained preview remains the selected playback target after Stop, or
    // after the user pauses its native audio control. Do not start backing loops.
    if (!resumeTransport && !media.length) media = loaded.slice(-1);
    this.pausedMedia = []; this.pausedTransport = false; this.state.paused = false;
    if (media.length) {
      try { await Promise.all(media.map(item => item.play())); }
      catch (error) { if (token === this.generation && !isAbort(error)) throw error; }
      if (token !== this.generation) return;
    }
    if (resumeTransport || !media.length) {
      const engine = await this.ensureAudio(); if (token !== this.generation) return;
      engine.play(); this.keepAwake();
    }
    this.render();
  }
  async stopPlayback() {
    ++this.generation;
    this.pausedMedia = []; this.pausedTransport = false; this.state.paused = false;
    this.previewAbort?.abort(); this.previewAbort = null; this.state.previewPreparing = null;
    if (this.recordingMasterOperation?.kind === 'preview') this.recordingMasterOperation.abort.abort();
    this.editorPreviewAbort?.abort(); this.editorPreviewAbort = null;
    if (this.state.trackEditor) this.state.trackEditor.previewBusy = false;
    for (const media of this.playbackMedia()) { media.pause(); try { media.currentTime = 0; } catch {} }
    this.microphoneOperation = null; this.state.micChanging = false;
    const project = this.state.project;
    if (project) project.input.monitor = false;
    this.state.monitor = false;
    if (this.pending) { this.updateCaptureIntent(); this.pending.stopRequested = true; }
    this.engine?.configure(project);
    if (this.engine?.node || this.engine?.stop) this.engine.stop();
    // A Stop before the graph exists must still align saved loop starts when
    // the first Play or Record creates it. An initializing graph gets the same
    // reset after init; posting a command before its port exists is insufficient.
    this.resetTransportOnInit = !this.engine?.node;
    this.state.audition = null; this.state.queuedSectionId = null;
    this.state.transportFrame = 0; this.state.outputLevel = 0;
    this.state.playbackOffsets = Object.fromEntries((project?.tracks || []).map(track => [track.id, 0]));
    this.state.playbackBaselines = Object.fromEntries((project?.tracks || []).map(track => [track.id, track.offsetFrames || 0]));
    if (!this.pending) { this.state.capture = null; if (!this.projectDeletion?.committing && !this.trackEditOperation) this.state.busy = false; }
    else if (this.state.capture) this.state.capture = { ...this.state.capture, status: 'finishing' };
    this.state.playing = false; this.state.status = this.pending ? 'Stopped · finishing and saving recording…' : 'Stopped · back to the beginning';
    this.render(); await this.releaseWake();
  }
  currentPlaybackProject() {
    const project = this.state.project, offsets = this.state.playbackOffsets || {}, baselines = this.state.playbackBaselines || {};
    return { ...project, tracks: project.tracks.map(track => {
      let offsetFrames = Number.isSafeInteger(offsets[track.id]) ? offsets[track.id] : track.offsetFrames;
      if (Number.isSafeInteger(baselines[track.id])) {
        offsetFrames = track.offsetFrames - baselines[track.id];
        // Match the audio graph when two valid authored offsets have an unsafe
        // difference. Reduce each operand before subtracting to preserve phase.
        if (!Number.isSafeInteger(offsetFrames)) {
          const modulo = value => ((value % track.frames) + track.frames) % track.frames;
          offsetFrames = modulo(modulo(track.offsetFrames) - modulo(baselines[track.id]));
        }
      }
      return { ...track, offsetFrames };
    }) };
  }
  async handle(action = {}) {
    if (action.type === 'media-playback') { this.pausedMedia = []; this.pausedTransport = false; this.state.paused = false; this.render(); return; }
    if (this.recordingMasterOperation && !['cancel-recording-master', 'cancel-export', 'stop-recording-master-preview', 'dismiss-error', 'view', 'close-preview', ...(this.recordingMasterOperation.kind === 'preview' ? ['recording-master-setting', 'recording-master-reset', 'recording-master-name', 'set-recording-preview-start', 'select-recording', 'open-recording-mix', 'mix-mode', 'stop'] : [])].includes(action.type)) throw new Error('Finish or cancel the recording master before starting another operation.');
    if (this.trackEditOperation && !['editor-close', 'editor-stop-preview', 'stop', 'dismiss-error'].includes(action.type)) throw new Error('Wait for the audio edit to finish, or close the editor to cancel.');
    if (this.state.storageFailed && !['help', 'view', 'dismiss-error', 'reload-studio', 'close-preview'].includes(action.type)) throw new Error('Reopen the studio to recover saved recordings before continuing.');
    if (this.projectDeletion?.committing && !['help', 'view', 'dismiss-error', 'reload-studio', 'close-preview', 'stop', 'mic-off'].includes(action.type)) throw new Error('Wait for project deletion to finish before starting another operation.');
    if (this.fileDeletion?.committing && !['help', 'view', 'dismiss-error', 'close-preview'].includes(action.type)) throw new Error('Wait for file deletion to finish before starting another operation.');
    if (this.state.deletionPending && !['help', 'view', 'dismiss-error', 'reload-studio', 'close-preview', 'manage-storage', 'delete-project', 'projects', 'open-project', 'new-project', 'stop', 'mic-off', 'select-track'].includes(action.type)) throw new Error(this.state.readonlyReason || 'Retry permanent deletion in Manage storage, or open another project.');
    const p = this.state.project; if (!p && !['help', 'reload-studio', 'dismiss-error', 'view'].includes(action.type)) return;
    switch (action.type) {
      case 'mix-mode': this.stopRecordingMasterPreview(); this.state.mixMode = action.mode === 'recordings' ? 'recordings' : 'layers'; this.mixModeChosen = true; this.render(); return;
      case 'open-recording-mix': return this.selectRecordingMix(`asset:${action.assetId}`);
      case 'select-recording': return this.selectRecordingMix(action.sourceKey);
      case 'recording-master-setting': return this.setRecordingMasterSettings(action.settings);
      case 'recording-master-reset': return this.setRecordingMasterSettings(DEFAULT_MASTER_SETTINGS);
      case 'recording-master-name': this.stopRecordingMasterPreview(); this.refreshRecordingMix(); if (this.state.recordingMix) this.state.recordingMix.name = cleanName(action.name, 'New master'); this.render(); return;
      case 'set-recording-preview-start': return this.setRecordingPreviewStart(action.seconds);
      case 'preview-recording-master': return this.previewRecordingMaster(action);
      case 'stop-recording-master-preview': this.stopRecordingMasterPreview(); this.render(); return;
      case 'export-recording-master': return this.exportRecordingMaster();
      case 'cancel-recording-master': this.recordingMasterOperation?.abort.abort(); this.exportAbort?.abort(); return;
      case 'remix-recording': return this.remixRecording();
      case 'import-recording': return this.importRecording(action.file);
      case 'preview-recorded-asset': return this.previewRecordedAsset(action.id, this.state.recordingSources.find(item => item.assetId === action.id)?.name || 'Saved master');
      case 'edit-track': return this.openTrackEditor(action.id);
      case 'editor-select': return this.editorSelection(action);
      case 'editor-cursor': return this.editorSelection({ cursorFrame: action.frame });
      case 'editor-copy': return this.copyEditorSelection();
      case 'editor-preview': return this.previewEditorSelection();
      case 'editor-stop-preview': this.stopEditorPreview(); this.render(); return;
      case 'editor-close': this.closeTrackEditor(); this.render(); return;
      case 'editor-trim': { const editor = this.state.trackEditor; return this.applyTrackAudioEdit({ type: 'trim', startFrame: editor?.startFrame, endFrame: editor?.endFrame }); }
      case 'editor-resize': return this.applyTrackAudioEdit({ type: 'resize', frames: action.frames, extension: action.extension || action.mode });
      case 'editor-paste': { const editor = this.state.trackEditor; if (!this.audioClipboard) throw new Error('Copy a selection before pasting.'); return this.applyTrackAudioEdit({ type: 'paste', selection: this.audioClipboard, mode: action.mode, startFrame: action.mode === 'replace' ? editor?.startFrame : editor?.cursorFrame, endFrame: action.mode === 'replace' ? editor?.endFrame : editor?.cursorFrame }); }
      case 'editor-undo': return this.handle({ type: 'undo' });
      case 'editor-redo': return this.handle({ type: 'redo' });
      case 'enable-mic': { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; await engine.enableMic(this.state.preferredDeviceId); return; }
      case 'select-microphone': return this.selectMicrophone(action.deviceId);
      case 'mic-off': { const loopsOnly = (this.pending?.kind || this.state.capture?.kind) === 'mix'; if (!loopsOnly) ++this.generation; if (this.pending && !loopsOnly) { this.pending.interrupted = true; this.engine?.send('interrupt', { reason: 'Microphone switched off' }); } this.engine?.disableMic(); if (!this.pending && !loopsOnly) { this.state.capture = null; if (!this.projectDeletion?.committing) this.state.busy = false; } p.input.monitor = false; this.state.monitor = false; this.render(); return; }
      case 'monitor': { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; if (!this.state.micEnabled) await engine.enableMic(this.state.preferredDeviceId); if (token !== this.generation) return; p.input.monitor = action.enabled ?? !p.input.monitor; this.state.monitor = p.input.monitor; engine.configure(p); this.scheduleSave(); this.render(); return; }
      case 'play': return this.playPlayback();
      case 'pause': return this.pausePlayback();
      case 'stop': return this.stopPlayback();
      case 'set-loop-recording': { this.assertWritable(); this.assertIdle(); if (this.state.busy || this.state.exporting) throw new Error('Finish the current operation before changing recording options.'); const settings = normalizeLoopRecording({ ...normalizeLoopRecording(p.loopRecording), ...action.settings }); this.edit(project => { project.loopRecording = settings; }, 'loop-recording'); return; }
      case 'add-loop': return this.startCapture('loop', action.cycles === undefined ? undefined : Number(action.cycles === 'custom' ? action.customCycles : action.cycles));
      case 'sing': return this.startCapture('vocal');
      case 'record-all-loops': return this.startCapture('mix');
      case 'finish': this.engine?.finish(); return;
      case 'cancel': { ++this.generation; this.engine?.cancel(); if (!this.pending) { this.state.capture = null; this.state.busy = false; this.render(); } return; }
      case 'view': this.state.view = ['build', 'song', 'mix'].includes(action.view) ? action.view : 'build'; if (this.state.view === 'mix' && !this.mixModeChosen && listRecordingSources(p, this.state.recovered).some(item => ['performance', 'loop-song', 'mix', 'recovered'].includes(item.kind))) this.state.mixMode = 'recordings'; this.render(); return;
      case 'select-track': this.stopRecordingMasterPreview(); this.state.mixMode = 'layers'; this.mixModeChosen = true; this.state.selectedTrackId = action.id; this.state.view = 'mix'; this.render(); return;
      case 'mix': this.edit(project => { const t = project.tracks.find(t => t.id === action.id) || project.takes.find(t => t.id === action.id); if (t) { t.mix = normalizeMix({ ...t.mix, ...action.mix }); this.engine?.send('mix', { id: t.id, mix: t.mix }); } }, `mix:${action.id}`); return;
      case 'mute': case 'solo': this.edit(project => { const t = project.tracks.find(t => t.id === action.id); if (t) { const key = action.type === 'mute' ? 'muted' : 'solo'; t[key] = !t[key]; this.engine?.send('mix', { id: t.id, [key]: t[key] }); } }); return;
      case 'rename-track': this.edit(project => { const t = project.tracks.find(t => t.id === action.id); if (t) t.name = cleanName(action.name, t.name); }); return;
      case 'remove-track': this.edit(project => { project.tracks = project.tracks.filter(t => t.id !== action.id); this.engine?.send('remove-track', { id: action.id }); if (this.state.selectedTrackId === action.id) this.state.selectedTrackId = project.tracks[0]?.id || null; }); return;
      case 'role': { if (!Object.hasOwn(COLORS, action.role)) throw new Error('Choose one of the available sound presets.'); this.edit(project => { const t = project.tracks.find(t => t.id === action.id) || project.takes.find(t => t.id === action.id); if (t) { t.role = action.role; t.mix = roleMix(action.role, t.mix); t.color = COLORS[action.role]; this.engine?.send('mix', { id: t.id, mix: t.mix }); } }); return; }
      case 'nudge': this.edit(project => { const t = project.tracks.find(t => t.id === action.id); if (t) { t.offsetFrames += Math.round(Number(action.frames) || 0); this.engine?.send('track', { track: t }); } }); return;
      case 'undo': case 'redo': { this.assertWritable(); this.assertIdle(); this.stopEditorPreview(); const restored = this.history[action.type](p); if (restored) { delete restored.pendingCapture; this.state.project = restored; touch(restored); this.engine?.send('cancel-section'); this.state.queuedSectionId = null; this.state.activeSectionId = null; const damaged = new Set((this.audioIntegrityIssues || this.state.damagedAudio).map(asset => asset.assetId)); const playable = restored.tracks.filter(track => !damaged.has(track.assetId)); if (playable.length !== restored.tracks.length) { this.engine?.stop(); this.state.playing = false; this.releaseWake(); } this.engine?.configure(restored); this.engine?.syncTracks(playable); this.scheduleSave(); this.render(); } return; }
      case 'set-input': this.edit(project => { if (action.gain !== undefined) project.input.gain = Math.max(0, Math.min(4, Number(action.gain))); if (action.compensationMs !== undefined) { if (this.pending) throw new Error('Finish recording before changing timing compensation.'); project.input.compensationMs = Math.max(0, Math.min(1000, Number(action.compensationMs))); } this.engine?.configure(project); }, 'input'); return;
      case 'set-master': this.edit(project => { project.master.volume = Math.max(0, Math.min(2, Number(action.volume))); this.engine?.configure(project); }, 'master'); return;
      case 'set-metronome': {
        if (this.pending) throw new Error('Finish or cancel the recording before changing the click or count-in.');
        const next = { ...DEFAULT_METRONOME, ...p.metronome };
        if (action.enabled !== undefined) next.enabled = !!action.enabled;
        for (const [key, min, max] of [['bpm', 40, 240], ['beatsPerCycle', 1, 16], ['volume', 0, 1]]) {
          if (action[key] === undefined) continue;
          const value = Number(action[key]);
          if (!Number.isFinite(value) || value < min || value > max || (key === 'beatsPerCycle' && !Number.isInteger(value))) throw new Error('Choose a valid click setting.');
          next[key] = value;
        }
        if (action.countInBeats !== undefined) { const beats = Number(action.countInBeats); if (![0, 4, 8].includes(beats)) throw new Error('Choose no count-in, four beats or eight beats.'); next.countInBeats = beats; }
        this.edit(project => { project.metronome = next; this.engine?.configure(project); }, 'metronome');
        if (next.enabled && !this.state.playing) { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; engine.configure(this.state.project); engine.play(); this.keepAwake(); }
        return;
      }
      case 'new-project': { this.assertIdle(); const name = action.name || await this.ui.prompt({ title: 'New project', message: 'Give your next song a name.', value: `Song ${this.state.projects.length + 1}`, label: 'Project name' }); if (name) { const next = createProject(name); await this.storage.saveProject(next); await this.openProject(next.id, next); } return; }
      case 'rename-project': { const name = action.name || await this.ui.prompt({ title: 'Name this project', value: p.name, label: 'Project name' }); if (name) this.edit(project => { project.name = cleanName(name, project.name); }); return; }
      case 'open-project': return this.openProject(action.id);
      case 'retry-recovery': {
        this.assertIdle();
        if (this.state.deletionPending) throw new Error('Retry permanent deletion in Manage storage, or open another project.');
        if (this.state.busy || this.state.exporting) throw new Error('Finish the current operation before retrying recovery.');
        return this.openProject(p.id);
      }
      case 'save': this.assertWritable(); await this.saveNow(); this.ui.notify('Project saved on this device. Export a backup to keep an independent copy.', 'success'); return;
      case 'export-project': this.assertAudioSources(referencedAssets({ ...p, pendingCapture: null })); return this.withExport(async signal => this.offerDownload(await exportProject(this.storage, p, { signal }), 'Project backup'));
      case 'import-project': { this.assertIdle(); if (!action.file) return; await this.withExport(async signal => { const imported = await importProject(this.storage, action.file, { signal }); await this.openProject(imported.id, imported); this.ui.notify('Backup restored as a separate project.', 'success'); }); return; }
      case 'import-audio': return this.importAudio(action.file);
      case 'export-track': { const track = p.tracks.find(t => t.id === action.id) || p.takes.find(t => t.id === action.id); if (track) return this.downloadAsset(track.assetId, 'Clean recording'); return; }
      case 'export-master': { const available = p.performances.filter(perf => !perf.removed); const perf = action.performanceId ? available.find(perf => perf.id === action.performanceId) : available.at(-1); if (!perf) throw new Error('Record a performance or all your loops first, or export the current mix.'); return this.downloadAsset(perf.masterAssetId, 'Stereo performance'); }
      case 'save-section': { const name = action.name || await this.ui.prompt({ title: 'Save a song section', message: 'This remembers exactly which loops are present and their mix.', value: ['Intro', 'Verse', 'Chorus', 'Bridge'][p.sections.length] || `Section ${p.sections.length + 1}`, label: 'Section name' }); if (name) this.edit(project => { project.sections.push(sectionFromProject(project, name)); }); return; }
      case 'launch-section': { const section = p.sections.find(s => s.id === action.id); if (!section) return; this.assertWritable(); this.history.push(p); if (this.engine) { this.state.queuedSectionId = section.id; this.engine.send('section', { section: clone(section) }); } else { applySection(p, section); this.state.activeSectionId = section.id; this.scheduleSave(); } this.render(); return; }
      case 'delete-section': this.edit(project => { project.sections = project.sections.filter(s => s.id !== action.id); this.engine?.send('cancel-section', { id: action.id }); if (this.state.queuedSectionId === action.id) this.state.queuedSectionId = null; if (this.state.activeSectionId === action.id) this.state.activeSectionId = null; }); return;
      case 'select-take': this.state.remixPerformanceId = null; this.edit(project => { project.selectedTakeId = action.id; }); return;
      case 'rename-take': this.edit(project => { const t = project.takes.find(t => t.id === action.id); if (t) t.name = cleanName(action.name, t.name); }); return;
      case 'delete-take': this.edit(project => { project.takes = project.takes.filter(t => t.id !== action.id); if (project.selectedTakeId === action.id) project.selectedTakeId = project.takes.at(-1)?.id || null; }); return;
      case 'preview-take': return this.previewTake(action.id);
      case 'preview-performance': { const perf = p.performances.find(item => item.id === action.performanceId && !item.removed); if (perf) return this.previewRecordedAsset(perf.masterAssetId, perf.name); return; }
      case 'preview-track': { const track = p.tracks.find(item => item.id === action.id); if (track) return this.previewRecordedAsset(track.assetId, track.name); return; }
      case 'delete-performance': return this.removePerformance(action.performanceId || action.id);
      case 'layer-vocal': { const take = p.takes.find(t => t.id === action.id); if (!take) return; this.assertAudioSources([take.assetId]); if (p.tracks.length >= MAX_TRACKS) throw new Error('This project has reached its layer limit.'); this.edit(project => { const track = createTrack({ assetId: take.assetId, name: `${take.name} · layer`, role: 'lead', frames: take.frames, offsetFrames: take.startFrame % take.frames, mix: normalizeMix(take.mix || roleMix('lead')) }); project.tracks.push(track); this.state.selectedTrackId = track.id; if (!project.baseFrames) project.baseFrames = track.frames; }); this.engine?.configure(p); this.engine?.syncTracks(p.tracks); return; }
      case 'close-preview': this.closePreview(); this.render(); return;
      case 'spotlight': this.engine?.send('spotlight', { active: !!action.active }); return;
      case 'seek-start': this.assertIdle(); this.state.transportFrame = 0; this.state.queuedSectionId = null; this.state.playbackOffsets = Object.fromEntries(p.tracks.map(track => [track.id, 0])); this.state.playbackBaselines = Object.fromEntries(p.tracks.map(track => [track.id, track.offsetFrames || 0])); if (this.engine?.seek) this.engine.seek(); else this.engine?.send('seek', { frame: 0 }); if (!this.engine?.node) this.resetTransportOnInit = true; this.render(); return;
      case 'demo': return this.demo();
      case 'recover-asset': return this.recoverAsset(action.id);
      case 'export-recovered': return this.downloadAsset(action.id, 'Recovered recording');
      case 'export-damaged-audio': return this.downloadDamagedAudio(action.id);
      case 'persist': { this.state.storage = { ...this.state.storage, ...await this.storage.requestPersistence() }; this.ui.notify(this.state.storage.persistent ? 'Persistent storage granted. Keep backups as well.' : 'The browser did not grant persistent storage. Project backups are still available.', 'info'); this.render(); return; }
      case 'manage-storage': return this.manageStorage();
      case 'download-storage-file': return this.downloadStorageFile(action.fileKey);
      case 'delete-storage-file': return this.deleteStorageFile(action.fileKey);
      case 'delete-project': return this.deleteProject(action.id);
      case 'delete-saved-mix': return this.deleteSavedMix(action.id);
      case 'delete-discarded': return this.deleteDiscardedRecording(action.id);
      case 'cancel-export': this.exportAbort?.abort(); return;
      case 'export-mix': return this.exportMix(action);
      case 'preview-mix': return this.previewMix(action);
      case 'help': this.ui.showHelp?.(); return;
      case 'dismiss-error': if (!this.state.storageFailed) this.state.error = null; this.render(); return;
      case 'reload-studio': { if (this.pending) throw new Error('Finish or cancel the current recording before reopening.'); await this.engine?.close(); globalThis.location.reload(); return; }
    }
  }
  pruneRecordingMixSettings(project, assets) {
    if (!project.recordingMixSettings) return;
    const retained = new Set(assets.map(asset => asset.id));
    for (const assetId of Object.keys(project.recordingMixSettings)) if (!retained.has(assetId)) delete project.recordingMixSettings[assetId];
  }
  refreshRecordingMix() {
    const project = this.state.project;
    this.state.recordingSources = listRecordingSources(project, this.state.recovered, this.state.damagedAudio, this.recordingAssets);
    if (!project) { this.state.recordingMix = null; this.state.recordingMixOutputs = []; return; }
    let model = this.state.recordingMix;
    let source = this.state.recordingSources.find(item => item.key === model?.sourceKey);
    if (!source) {
      this.stopRecordingMasterPreview(); source = this.state.recordingSources[0];
      this.state.recordingMix = model = source ? { sourceKey: source.key, settings: normalizeMasterSettings(project.recordingMixSettings?.[source.assetId] || {}),
        name: `${source.name} · mastered`, previewStartSeconds: 0, previewUrl: null, previewBusy: false, busy: false, progress: null, error: null } : null;
    } else if (!model.busy) {
      const settings = normalizeMasterSettings(project.recordingMixSettings?.[source.assetId] || {});
      if (JSON.stringify(settings) !== JSON.stringify(model.settings)) { this.stopRecordingMasterPreview(); model.settings = settings; model.analysis = null; }
    }
    this.state.recordingMixOutputs = source ? this.state.recovered.filter(asset => asset.kind === 'mix' && asset.sourceAssetId === source.assetId && ['complete', 'interrupted', 'recovered'].includes(asset.status)) : [];
    this.state.remixPerformance = project.performances.find(item => item.id === this.state.remixPerformanceId && !item.removed) || null;
    if (!this.state.remixPerformance) this.state.remixPerformanceId = null;
  }
  selectRecordingMix(sourceKey) {
    this.assertIdle();
    if (this.recordingMasterOperation?.kind === 'render' || this.state.busy || this.state.exporting || this.projectDeletion || this.fileDeletion) throw new Error('Finish or cancel the current operation before selecting another recording.');
    const source = this.state.recordingSources.find(item => item.key === sourceKey) || listRecordingSources(this.state.project, this.state.recovered, this.state.damagedAudio, this.recordingAssets).find(item => item.key === sourceKey);
    if (!source) throw new Error('Choose a saved recording from this project.');
    this.closePreview(); this.closeTrackEditor();
    this.state.recordingMix = { sourceKey: source.key, settings: normalizeMasterSettings(this.state.project.recordingMixSettings?.[source.assetId] || {}), name: `${source.name} · mastered`, previewStartSeconds: 0,
      previewUrl: null, previewBusy: false, busy: false, progress: null, error: null };
    this.state.mixMode = 'recordings'; this.mixModeChosen = true; this.state.view = 'mix'; this.render();
  }
  setRecordingMasterSettings(patch = {}) {
    this.assertWritable(); this.assertIdle(); this.refreshRecordingMix();
    const model = this.state.recordingMix;
    if (!model) throw new Error('Choose a saved recording first.');
    if (this.recordingMasterOperation?.kind === 'render') throw new Error('Finish or cancel the master before changing its settings.');
    const source = selectRecordingSource(this.state.project, this.state.recovered, model.sourceKey, this.state.damagedAudio, this.recordingAssets);
    const settings = normalizeMasterSettings({ ...model.settings, ...patch });
    this.stopRecordingMasterPreview(); model.settings = settings; model.analysis = null; model.error = null;
    this.edit(project => { (project.recordingMixSettings ||= {})[source.assetId] = settings; }, `recording-master:${source.assetId}`);
  }
  setRecordingPreviewStart(seconds) {
    this.assertIdle(); this.refreshRecordingMix();
    if (this.recordingMasterOperation?.kind === 'render') throw new Error('Finish or cancel the master before changing the preview.');
    const model = this.state.recordingMix, source = selectRecordingSource(this.state.project, this.state.recovered, model?.sourceKey, this.state.damagedAudio, this.recordingAssets);
    const value = Number(seconds), frame = Math.round(value * source.sampleRate);
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(frame) || frame >= source.frames) throw new Error('Choose a preview start within this recording.');
    this.stopRecordingMasterPreview(); model.previewStartSeconds = frame / source.sampleRate; this.render();
  }
  stopRecordingMasterPreview() {
    if (this.recordingMasterOperation?.kind === 'preview') this.recordingMasterOperation.abort.abort();
    const model = this.state.recordingMix;
    globalThis.document?.querySelector('#recording-master-player')?.pause();
    if (model?.previewUrl) { URL.revokeObjectURL(model.previewUrl); this.urls.delete(model.previewUrl); }
    if (model) { model.previewUrl = null; model.previewBusy = false; model.previewKind = null; model.previewFrames = null; }
  }
  async assertRecordingSource(source, project) {
    const asset = await this.storage.getAsset(source.assetId);
    if (!asset || asset.id !== source.assetId || asset.projectId !== project.id || (source.allowLonger ? asset.frames < source.minimumFrames : asset.frames !== source.frames) || asset.channels !== source.channels || asset.sampleRate !== source.sampleRate || !['complete', 'interrupted', 'recovered'].includes(asset.status)) throw new Error('This saved recording changed or is incomplete. Reopen the project before mixing it.');
    if (source.allowLonger) source.frames = asset.frames;
    return asset;
  }
  silenceRecordingPreviewBacking() {
    const project = this.state.project;
    if (project) project.input.monitor = false;
    this.state.monitor = false; this.engine?.configure(project); this.engine?.stop();
    this.state.playing = false; this.state.audition = null;
  }
  async previewRecordingMaster({ original = false } = {}) {
    this.assertIdle();
    if (this.state.busy || this.state.exporting || this.recordingMasterOperation || this.state.deletionPending || this.state.storageFailed || this.trackEditOperation) throw new Error('Finish the current operation before previewing a master.');
    this.refreshRecordingMix(); const model = this.state.recordingMix, project = this.state.project;
    const source = selectRecordingSource(project, this.state.recovered, model?.sourceKey, this.state.damagedAudio, this.recordingAssets);
    this.closePreview(); this.stopEditorPreview(); this.silenceRecordingPreviewBacking();
    const operation = { kind: 'preview', abort: new AbortController() }, token = this.generation;
    this.recordingMasterOperation = operation; model.previewBusy = true; model.error = null; model.progress = 0;
    const settings = clone(model.settings), sourceKey = model.sourceKey, startFrame = Math.round((model.previewStartSeconds || 0) * source.sampleRate);
    const current = () => { operation.abort.signal.throwIfAborted(); if (this.state.project !== project || this.generation !== token || this.state.recordingMix !== model || model.sourceKey !== sourceKey) throw new DOMException('Preview cancelled.', 'AbortError'); };
    this.render();
    try {
      await this.releaseWake(); current(); await this.assertRecordingSource(source, project); current();
      const { previewMasteredRecording } = await import('./export/master.mjs'); current();
      const result = await previewMasteredRecording(this.storage, project, { assetId: source.assetId, settings, original: !!original, startFrame, signal: operation.abort.signal,
        onProgress: progress => { if (this.recordingMasterOperation === operation) { model.progress = progress; this.render(); } } });
      current();
      const url = URL.createObjectURL(result.blob); this.urls.add(url); model.previewUrl = url; model.previewKind = original ? 'original' : 'master'; model.previewFrames = result.frames;
      model.analysis = result.analysis; this.state.status = original ? 'Original recording preview ready' : 'Master preview ready'; this.render();
      globalThis.document?.querySelector('#recording-master-player')?.play().catch(() => this.ui.notify('Press Play to listen to the preview.', 'info'));
    } catch (error) { if (!isAbort(error)) { model.error = error.message; throw error; } }
    finally { if (this.recordingMasterOperation === operation) this.recordingMasterOperation = null; model.previewBusy = false; model.progress = null; this.render(); }
  }
  async exportRecordingMaster() {
    this.assertWritable(); this.assertIdle();
    if (this.state.busy || this.state.exporting || this.recordingMasterOperation || this.projectDeletion || this.fileDeletion) throw new Error('Finish the current operation before saving a master.');
    this.refreshRecordingMix(); const project = this.state.project, model = this.state.recordingMix;
    const source = selectRecordingSource(project, this.state.recovered, model?.sourceKey, this.state.damagedAudio, this.recordingAssets);
    const settings = clone(model.settings), name = cleanName(model.name, `${source.name} · mastered`), token = this.generation;
    this.closePreview(); this.closeTrackEditor(); this.silenceRecordingPreviewBacking();
    const operation = { kind: 'render', abort: new AbortController() };
    this.recordingMasterOperation = operation; model.busy = true; model.progress = 0; model.error = null; this.state.busy = true; this.render();
    const current = () => { operation.abort.signal.throwIfAborted(); if (project !== this.state.project || token !== this.generation || this.state.readonly || this.state.storageFailed) throw new DOMException('Master cancelled.', 'AbortError'); };
    try {
      // A master is a new durable file: an unsuccessful project/settings save
      // must stop before any output is created, unlike a read-only WAV export.
      await this.flushSave(); current(); await this.assertRecordingSource(source, project); current();
      await this.withExport(async signal => {
        const abort = () => operation.abort.abort(); signal.addEventListener('abort', abort, { once: true });
        try {
          const { renderMasteredRecording } = await import('./export/master.mjs'); current();
          const result = await renderMasteredRecording(this.storage, project, { assetId: source.assetId, name, settings, signal: operation.abort.signal,
            onProgress: progress => { model.progress = progress; this.state.exportProgress = progress; this.ui.updateExportProgress?.(progress); this.render(); } });
          // Register a successfully sealed result even if download preparation
          // is subsequently cancelled: it remains beside its source recording.
          const asset = await this.storage.getAsset(result.assetId);
          if (project === this.state.project && !this.state.recovered.some(item => item.id === asset.id)) this.state.recovered.push(asset);
          model.analysis = result.analysis; this.state.status = 'New master saved on this device'; this.render(); current();
          await this.offerAudioDownload(result.assetId, 'Mastered recording', operation.abort.signal);
        } finally { signal.removeEventListener('abort', abort); }
      });
    } catch (error) { if (!isAbort(error)) { model.error = error.message; throw error; } this.state.status = 'Master cancelled'; }
    finally {
      if (this.recordingMasterOperation === operation) this.recordingMasterOperation = null;
      model.busy = false; model.progress = null; if (project === this.state.project) this.state.busy = false;
      this.state.storage = { ...this.state.storage, ...await this.storage.estimate?.().catch(() => ({})) }; this.render();
    }
  }
  remixRecording() {
    this.assertIdle(); this.refreshRecordingMix();
    const source = selectRecordingSource(this.state.project, this.state.recovered, this.state.recordingMix?.sourceKey, this.state.damagedAudio, this.recordingAssets);
    if (!source.canRemix) throw new Error('This file has no saved layer arrangement. Use the recording master controls instead.');
    this.stopRecordingMasterPreview(); this.state.remixPerformanceId = source.performanceId; this.state.mixMode = 'layers'; this.mixModeChosen = true;
    this.state.selectedTrackId ||= this.state.project.tracks[0]?.id || null; this.state.view = 'mix'; this.render();
  }
  async importRecording(file) {
    this.assertWritable(); this.assertIdle(); if (!file) return;
    if (this.state.busy || this.state.exporting || this.importOperation || this.recordingMasterOperation) throw new Error('Finish the current operation before importing a recording.');
    if (file.size > 128 * 1024 * 1024) throw new Error('Audio import supports files up to 128 MB.');
    const project = this.state.project, token = this.generation, operation = {}; this.importOperation = operation;
    this.state.busy = true; this.state.status = 'Importing recording…'; this.closePreview(); this.render();
    let assetId, sealed = false, context;
    const current = () => { if (project !== this.state.project || token !== this.generation || this.state.storageFailed) throw new DOMException('Import cancelled.', 'AbortError'); };
    try {
      await this.flushSave(); current();
      // Importing a song must work even when unrelated loop audio is damaged.
      const AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContext) throw new Error('This browser cannot decode audio recordings.');
      context = new AudioContext({ sampleRate: project.sampleRate });
      const decoded = await context.decodeAudioData(await file.arrayBuffer()); current();
      if (!decoded.length || decoded.sampleRate !== project.sampleRate) throw new Error('The imported audio could not be decoded at this project’s sample rate.');
      if (![1, 2].includes(decoded.numberOfChannels)) throw new Error('Import a mono or stereo recording. Surround audio is not supported.');
      if (decoded.length > project.sampleRate * 60 * 20) throw new Error('Imported recordings are limited to 20 minutes per file.');
      const channels = decoded.numberOfChannels, name = cleanName(file.name.replace(/\.[^.]+$/, ''), 'Imported recording'); assetId = id('recording-');
      await this.storage.beginAsset({ id: assetId, projectId: project.id, sampleRate: project.sampleRate, channels, kind: 'recording', name, sourceName: file.name }); current();
      const planes = Array.from({ length: channels }, (_, channel) => decoded.getChannelData(channel));
      for (let offset = 0, index = 0; offset < decoded.length; offset += PAGE_FRAMES, index++) {
        current(); const frames = Math.min(PAGE_FRAMES, decoded.length - offset), pcm = new Float32Array(frames * channels);
        for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) pcm[frame * channels + channel] = planes[channel][offset + frame];
        await this.storage.putPage(assetId, index, pcm.buffer, frames, channels); current();
      }
      const asset = await this.storage.finishAsset(assetId, { frames: decoded.length });
      if (asset.status !== 'complete') throw new Error('The imported recording could not be saved completely.');
      sealed = true; current(); this.state.recovered.push(asset); this.state.busy = false; this.selectRecordingMix(`asset:${asset.id}`);
      this.state.status = 'Recording imported · ready to mix and master'; this.ui.notify('Recording imported with its original mono or stereo channels.', 'success');
    } catch (error) {
      if (assetId && !sealed) { await this.storage.finishAsset(assetId, { status: 'cancelled' }).catch(() => {}); await this.storage.deleteAsset(assetId).catch(() => {}); }
      if (!isAbort(error)) throw error;
    } finally { await context?.close().catch(() => {}); if (this.importOperation === operation) this.importOperation = null; if (project === this.state.project && token === this.generation) this.state.busy = false; this.render(); }
  }
  async exportMix(action) {
    return this.withExport(async signal => {
      const selected = this.state.project.takes.find(t => t.id === this.state.project.selectedTakeId);
      const performanceId = action.performanceId || this.state.remixPerformanceId || selected?.performanceId;
      const performance = this.state.project.performances.find(item => item.id === performanceId);
      if ((action.performanceId || this.state.remixPerformanceId) && !performance) throw new Error('The selected arrangement is no longer available.');
      const explicitDuration = action.durationSeconds !== undefined && action.durationSeconds !== null && action.durationSeconds !== '';
      const durationSeconds = explicitDuration ? Number(action.durationSeconds) : performance || selected ? undefined : this.state.project.baseFrames / this.state.sampleRate * 4;
      if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) throw new Error('Choose a positive export duration, or add a loop or vocal take.');
      const result = await this.renderMix(performanceId ? this.state.project : this.currentPlaybackProject(), { performanceId, ...(durationSeconds === undefined ? {} : { durationSeconds }), tailSeconds: 2, mode: 'current', signal,
        onProgress: progress => { this.state.exportProgress = progress; this.ui.updateExportProgress?.(progress); } });
      // The saved mix remains reachable even if preparing its download fails.
      const savedMix = await this.storage.getAsset(result.assetId);
      if (!this.state.recovered.some(asset => asset.id === savedMix.id)) this.state.recovered.push(savedMix);
      this.render();
      await this.offerAudioDownload(result.assetId, 'Edited stereo mix', signal);
    });
  }
  async renderMix(project, options) {
    const { renderEditedMix } = await import('./export/render.mjs');
    return renderEditedMix(this.storage, project, options);
  }
  async previewMix(action = {}) {
    if (this.state.remixPerformanceId) throw new Error('Render the recorded arrangement to hear this version.');
    this.assertIdle(); if (this.state.exporting) throw new Error('Finish or cancel the export before auditioning.'); this.closePreview();
    const token = this.generation;
    const take = this.state.project.takes.find(t => t.id === this.state.project.selectedTakeId);
    if (take) this.assertAudioSources([take.assetId]);
    if (!take) { const e = await this.ensureAudio(); if (token !== this.generation) return; e.play(); this.keepAwake(); this.ui.notify('Auditioning the current loop mix. Adjust the mixer while it plays.', 'info'); return; }
    const engine = await this.ensureAudio();
    if (token !== this.generation) return;
    this.state.audition = { id: take.id, status: 'loading', startFrame: take.startFrame, endFrame: take.startFrame + take.frames, tailFrames: this.state.sampleRate * 2 };
    engine.send('audition', { take: { ...take, mix: take.mix || roleMix('lead') }, startFrame: take.startFrame, tailFrames: this.state.sampleRate * 2 });
    this.state.status = 'Loading live mix audition…'; this.keepAwake(); this.render();
  }
  handleError(error) { if (isAbort(error)) return; console.error(error); if (this.state.storageFailed) return; this.state.error = error.message || String(error); if (!this.trackEditOperation && this.recordingMasterOperation?.kind !== 'render') this.state.busy = false; this.ui.notify(this.state.error, 'error'); this.render(); }
}
