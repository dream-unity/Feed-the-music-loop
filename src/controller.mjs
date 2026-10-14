import { AudioEngine } from './audio/client.mjs';
import { createProject, createTrack, validateProject, roleMix, normalizeMix, sectionFromProject, applySection, ProjectHistory, referencedAssets, cleanName, id, clone, touch, PAGE_FRAMES, MAX_TRACKS, COLORS, DEFAULT_METRONOME } from './project.mjs';
import { exportWav, exportWavParts, exportProject, importProject } from './export/index.mjs';

const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const isAbort = error => error?.name === 'AbortError';
const jsonSafe = value => JSON.parse(JSON.stringify(value));

export class StudioController {
  constructor(storage, ui) {
    this.storage = storage; this.ui = ui; this.engine = null; this.history = new ProjectHistory(); this.generation = 0;
    this.pending = null; this.sealed = new Map(); this.saveTimer = null; this.saveChain = Promise.resolve(); this.saveSerial = 0;
    this.lastCheckpointAt = 0; this.lastUnderrunAt = 0; this.urls = new Set(); this.wakeLock = null; this.exportAbort = null;
    this.state = { project: null, projects: [], selectedTrackId: null, view: 'build', playing: false, capture: null, status: 'Opening studio…', micEnabled: false, monitor: false,
      inputLevel: 0, outputLevel: 0, transportFrame: 0, sampleRate: 48000, storage: {}, busy: true, undoAvailable: false, redoAvailable: false, exporting: false,
      capabilities: { audio: !!(globalThis.AudioContext || globalThis.webkitAudioContext), microphone: !!globalThis.navigator?.mediaDevices?.getUserMedia }, error: null,
      recovered: [], readonly: false, downloads: [], preview: null, audition: null, exportProgress: null, activeSectionId: null, queuedSectionId: null,
      micDevices: [], preferredDeviceId: '', micChanging: false };
    this.ui.addEventListener('action', e => { this.handle(e.detail).catch(error => this.handleError(error)); });
    this.storage.addEventListener('progress', e => this.storageProgress(e.detail));
    this.storage.addEventListener('error', e => {
      if (['STORAGE_WORKER_FAILED', 'STORAGE_MESSAGE_ERROR'].includes(e.detail.code)) this.storageFailed(e.detail.message).catch(error => this.handleError(error));
      else { this.state.status = 'Recording interrupted'; this.handleError(new Error(e.detail.message)); }
    });
  }
  render() { this.state.undoAvailable = !!this.history.past.length; this.state.redoAvailable = !!this.history.future.length; this.ui.render(this.state); }
  async init() {
    this.render(); this.state.storage = await this.storage.init();
    this.state.projects = await this.storage.listProjects();
    let previous = null; try { previous = localStorage.getItem('fml:last-project'); } catch {}
    const available = this.state.projects.filter(p => !p.purgePendingAt);
    const selected = available.find(p => p.id === previous) || available[0];
    await this.openProject(selected?.id || null);
    globalThis.addEventListener?.('beforeunload', e => { if (this.pending || this.state.status === 'Saving…') { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (this.state.playing || this.pending)) this.keepAwake(); });
    return this;
  }
  assertWritable() { if (this.state.storageFailed) throw new Error('Reopen the studio to recover saved recordings before continuing.'); if (this.state.readonly) throw new Error('This project is open in another tab. Close that tab before editing here, or export a backup.'); }
  assertIdle() { if (this.pending || this.state.capture) throw new Error('Finish or cancel the recording before changing projects or exporting.'); }
  async openProject(projectId = null, supplied = null) {
    this.assertIdle();
    if (this.openingProject) throw new Error('A project is still opening. Wait for it to finish before switching again.');
    this.openingProject = true;
    try {
    ++this.generation; this.state.busy = true; this.render();
    const previousId = this.state.project?.id;
    if (previousId && !this.state.readonly) await this.flushSave();
    const next = supplied ? validateProject(supplied) : projectId ? validateProject(await this.storage.loadProject(projectId)) : createProject('My first song');
    if (next.purgePendingAt) throw new Error('This project was partly deleted. Open Manage storage to finish deleting it.');
    if (this.engine) { await this.engine.close(); this.engine = null; }
    this.closePreview();
    if (previousId && previousId !== next.id) await this.storage.releaseProject(previousId).catch(() => {});
    this.state.readonly = false;
    try {
      if (!projectId && !supplied) await this.storage.saveProject(next);
      await this.storage.recover(next.id);
    } catch (error) {
      if (error.code === 'PROJECT_BUSY') { this.state.readonly = true; this.ui.notify('This project is open in another tab. Playback and backup are available here.', 'info'); }
      else throw error;
    }
    this.state.project = next; this.state.sampleRate = next.sampleRate; this.state.selectedTrackId = next.tracks[0]?.id || null;
    this.state.capture = null; this.state.audition = null; this.state.playing = false; this.state.micEnabled = false; this.state.monitor = false; next.input.monitor = false;
    this.state.transportFrame = 0; this.state.activeSectionId = null; this.state.queuedSectionId = null; this.history.clear();
    const assets = await this.storage.listAssets(next.id); const used = new Set(referencedAssets({ ...next, pendingCapture: null }));
    this.state.recovered = assets.filter(a => a.frames > 0 && a.status !== 'cancelled' && !used.has(a.id));
    this.state.status = this.state.readonly ? 'Read only · another tab is editing' : this.state.recovered.length ? `${this.state.recovered.length} recording${this.state.recovered.length === 1 ? '' : 's'} available to recover` : 'Saved on this device';
    this.state.busy = false; this.state.error = null;
    this.state.projects = await this.storage.listProjects();
    try { localStorage.setItem('fml:last-project', next.id); } catch {}
    this.render();
    if (next.pendingCapture && this.state.recovered.length) this.ui.notify('An unfinished recording was recovered. Its saved audio is available in the Song view.', 'info');
    } finally { this.openingProject = false; this.state.busy = false; this.render(); }
  }
  async ensureAudio() {
    if (!this.state.project) throw new Error('The project is still opening.');
    if (!this.engine) {
      this.engine = new AudioEngine(this.storage);
      const engine = this.engine;
      for (const name of ['state', 'meter', 'count-in', 'capture-start', 'capture-end', 'asset-sealed', 'section', 'command', 'automation', 'track-ready', 'mic', 'devices', 'error', 'interrupted', 'device-lost', 'context-state', 'audition-start', 'audition-end']) {
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
    await engine.waitUntilReady(); return engine;
  }
  audioEvent(type, data) {
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
        engine.stop();
        this.state.status = 'Audio paused · press Play or Record to resume'; this.render();
      }
      return;
    }
    if (type === 'count-in') { this.state.status = 'Count in · get ready'; return; }
    if (type === 'state' || type === 'meter') {
      // A meter already queued before suspension must not re-disable Play by
      // advertising the audio thread's previous playing state.
      if (this.engine?.context && ['suspended', 'interrupted', 'closed'].includes(this.engine.context.state)) return;
      if (this.state.audioPaused) { this.state.audioPaused = false; this.state.status = 'Audio ready'; }
      this.state.playing = !!data.playing; this.state.transportFrame = data.transportFrame || 0;
      this.state.audition = data.audition || null;
      this.state.liveBaseFrames = data.baseFrames || this.state.project.baseFrames;
      if (this.pending) this.state.capture = data.capture || { kind: this.pending.kind, status: this.pending.ended ? 'finishing' : 'arming', elapsedFrames: this.pending.end?.frames || 0 };
      else if (!this.state.busy) this.state.capture = data.capture;
      if (type === 'meter') {
        this.state.inputLevel = data.inputLevel || 0; this.state.outputLevel = data.outputLevel || 0;
        this.ui.updateMeters?.(data); this.ui.updateTransport?.({ ...data, sampleRate: this.state.sampleRate });
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
    if (type === 'capture-start') {
      if (this.pending?.id !== data.captureId) return;
      const project = this.state.project;
      const initialState = data.initialState || { tracks: clone(project.tracks), baseFrames: project.baseFrames, master: clone(project.master), input: clone(project.input), inputMix: clone(project.input.mix || this.pending.track.mix), engineVersion: 1 };
      this.pending.initialState = { ...clone(initialState), frame: data.startFrame };
      if (initialState.inputMix) this.pending.track.mix = normalizeMix(initialState.inputMix);
      this.pending.startFrame = data.startFrame; this.pending.started = true;
      this.state.capture = { kind: data.kind, status: 'recording', elapsedFrames: 0, startFrame: data.startFrame, targetFrames: this.pending.lengthFrames };
      this.state.status = 'Recording · saving audio continuously'; this.updateCaptureIntent(); this.scheduleSave(0); this.render(); return;
    }
    if (type === 'capture-end') {
      if (this.pending?.id !== data.captureId) return;
      this.pending.end = data; this.pending.ended = true; this.state.capture = { kind: data.kind, status: 'finishing', elapsedFrames: data.frames };
      this.state.status = 'Finishing and saving…'; this.render(); this.tryFinalize().catch(e => this.handleError(e)); return;
    }
    if (type === 'asset-sealed') { this.sealed.set(data.assetId, data); this.tryFinalize().catch(e => this.handleError(e)); return; }
    if (type === 'section') {
      const section = data.section || this.state.project.sections.find(s => s.id === data.id);
      if (section) { applySection(this.state.project, section); this.state.activeSectionId = section.id; this.state.queuedSectionId = null; this.recordEvent({ frame: data.projectFrame, type: 'section', section: clone(section) }); this.scheduleSave(); this.render(); }
      return;
    }
    if (type === 'command') {
      const command = typeof data.command === 'string' ? data.command : data.command?.type;
      if (command && !['play', 'stop', 'clear', 'arm', 'cancel', 'finish'].includes(command)) {
        const payload = data.payload || data.data || (typeof data.command === 'object' ? data.command : data);
        const clean = jsonSafe(payload); delete clean.requestId; delete clean.type; delete clean.command; delete clean.projectFrame; delete clean.transportFrame; delete clean.clockFrame;
        this.recordEvent({ ...clean, frame: data.frame ?? data.projectFrame, type: command });
      }
      return;
    }
    // command acknowledgements are authoritative; automation is an optional UI notification.
    if (type === 'automation') return;
    if (type === 'interrupted' || type === 'device-lost') { this.interrupt(data.message).catch(e => this.handleError(e)); return; }
    if (type === 'error') {
      if (data.fatal) { this.recoverAudioEngine(data.message).catch(error => this.handleError(error)); return; }
      this.handleError(new Error(data.message || 'The audio engine reported an error.')); return;
    }
  }
  recordEvent(event) {
    if (!Number.isSafeInteger(event.frame) || event.frame < 0) return;
    if (this.pending?.started && !this.pending.ended) {
      if (this.pending.events.length < 200000) this.pending.events.push(event);
      else { this.engine?.finish(); this.ui.notify('This performance reached the arrangement-event limit and is being saved.', 'info'); }
    }
  }
  updateCaptureIntent(force = false) {
    const p = this.pending; if (!p || (p.finalizing && !force)) return;
    this.state.project.pendingCapture = { id: p.id, kind: p.kind, assetId: p.assetId, masterAssetId: p.masterAssetId || null, performanceId: p.performanceId || null,
      takeId: p.takeId || null, track: p.track, startFrame: p.startFrame ?? 0, initialState: p.initialState, events: p.events,
      sealedThroughFrame: Math.max(p.startFrame || 0, this.state.transportFrame - Math.round(this.state.project.input.compensationMs * this.state.sampleRate / 1000)), createdAt: p.createdAt };
  }
  async startCapture(kind, cycles = 1) {
    this.assertWritable(); if (this.pending || this.state.capture) throw new Error('A recording is already active.');
    if (this.state.busy) throw new Error('Finish the current operation before recording.');
    if (this.state.exporting) throw new Error('Finish or cancel the export before recording.');
    if (kind === 'loop' && this.state.project.tracks.length >= MAX_TRACKS) throw new Error(`This project has reached ${MAX_TRACKS} layers. Start another project or remove unused layers.`);
    this.closePreview(); this.state.error = null;
    if (this.state.audition) { this.engine?.stop(); this.state.audition = null; this.state.playing = false; }
    const token = ++this.generation; this.state.capture = { kind, status: 'arming', waitingForMic: true, elapsedFrames: 0 }; this.state.busy = true; this.render();
    let pending = null;
    try {
      const engine = await this.ensureAudio(); if (token !== this.generation) return;
      await engine.enableMic(this.state.preferredDeviceId); if (token !== this.generation) return;
      const capacity = await this.storage.estimate(); if (token !== this.generation) return;
      this.state.storage = { ...this.state.storage, ...capacity };
      if (capacity.quota && capacity.quota - capacity.usage < 8 * 1024 * 1024) throw new Error('There is very little recording space left. Export a project backup and free device storage before recording.');
      const project = this.state.project, captureId = id('capture-'), assetId = id('audio-'), masterAssetId = kind === 'vocal' ? id('master-') : null;
      const role = kind === 'vocal' ? 'lead' : project.tracks.length === 0 ? 'beat' : project.tracks.length === 1 ? 'bass' : 'harmony';
      const label = kind === 'vocal' ? `Vocal take ${project.takes.length + 1}` : `${role[0].toUpperCase()}${role.slice(1)} ${project.tracks.length + 1}`;
      const track = createTrack({ assetId, name: label, role });
      const lengthFrames = kind === 'loop' && project.baseFrames && cycles ? Math.round(project.baseFrames * cycles) : 0;
      if (!Number.isSafeInteger(lengthFrames) || lengthFrames < 0) throw new Error('Choose a valid recording length.');
      let resolveDone; const done = new Promise(resolve => { resolveDone = resolve; });
      pending = { id: captureId, kind, assetId, masterAssetId, track, lengthFrames, events: [], startFrame: 0, createdAt: now(),
        performanceId: kind === 'vocal' ? id('performance-') : null, takeId: kind === 'vocal' ? id('take-') : null,
        initialState: { tracks: clone(project.tracks), baseFrames: project.baseFrames, master: clone(project.master), input: clone(project.input), inputMix: clone(track.mix), frame: this.state.transportFrame, engineVersion: 1 }, done, resolveDone };
      this.pending = pending; this.updateCaptureIntent(); await this.saveNow();
      await this.storage.beginAsset({ id: assetId, projectId: project.id, sampleRate: project.sampleRate, channels: 1, kind: kind === 'loop' ? 'loop' : 'vocal', name: label, captureId, track, performanceId: pending.performanceId, createdAt: Date.now() });
      if (masterAssetId) await this.storage.beginAsset({ id: masterAssetId, projectId: project.id, sampleRate: project.sampleRate, channels: 2, kind: 'master', name: `Performance ${project.performances.length + 1}`, captureId, leadAssetId: assetId, performanceId: pending.performanceId });
      if (token !== this.generation) { await this.cancelPrepared(pending); return; }
      engine.configure(project); engine.arm({ id: captureId, kind, assetId, masterAssetId, track, lengthFrames, quantized: !!project.baseFrames && (kind === 'vocal' || !!cycles) });
      this.state.busy = false; this.state.capture = { kind, status: 'arming', elapsedFrames: 0, targetFrames: lengthFrames }; this.state.status = project.baseFrames ? 'Ready at the next cycle' : 'Recording…';
      this.keepAwake(); this.render();
    } catch (error) {
      if (pending && !pending.started) await this.cancelPrepared(pending).catch(() => {});
      if (token === this.generation) { this.state.capture = null; this.state.busy = false; this.render(); }
      throw error;
    }
  }
  async cancelPrepared(p) {
    for (const assetId of [p.assetId, p.masterAssetId].filter(Boolean)) await this.storage.finishAsset(assetId, { status: 'cancelled' }).catch(() => {});
    if (this.pending === p) { this.pending = null; delete this.state.project.pendingCapture; this.state.capture = null; this.state.busy = false; p.resolveDone?.(); await this.saveNow(); this.render(); }
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
  async tryFinalize() {
    const p = this.pending; if (!p?.ended || p.finalizing) return;
    const ids = [p.assetId, p.masterAssetId].filter(Boolean); if (!ids.every(assetId => this.sealed.has(assetId))) return;
    p.finalizing = true;
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
      const raw = assets.get(p.assetId), master = p.masterAssetId ? assets.get(p.masterAssetId) : null;
      const cancelled = p.end.status === 'cancelled';
      let retainedIntent = needsRecovery;
      if (!cancelled && !needsRecovery && raw.frames > 0) {
        this.history.push(this.state.project);
        if (p.kind === 'loop' && raw.status === 'complete' && p.end.track) {
          const track = { ...p.end.track, frames: raw.frames, offsetFrames: (p.end.startFrame || 0) % raw.frames };
          this.state.project.tracks.push(track); if (!this.state.project.baseFrames) this.state.project.baseFrames = raw.frames;
          this.state.selectedTrackId = track.id;
          this.summarize(raw).then(peaks => { const t = this.state.project.tracks.find(t => t.id === track.id); if (t) { t.peaks = peaks; this.scheduleSave(); this.render(); } }).catch(() => {});
        } else if (p.kind === 'vocal' && master?.frames > 0) {
          const startFrame = p.end.startFrame ?? p.startFrame;
          const complete = raw.status === 'complete' && master.status === 'complete' && raw.frames === master.frames && !p.hadUnderrun && !p.interrupted;
          const perf = { id: p.performanceId, name: `Performance ${this.state.project.performances.length + 1}`, leadAssetId: raw.id, masterAssetId: master.id,
            frames: master.frames, startFrame, endFrame: startFrame + master.frames, tailFrames: 0, editableFrames: Math.min(raw.frames, master.frames),
            events: p.events.filter(e => e.frame >= startFrame && e.frame < startFrame + master.frames), initialState: p.initialState, createdAt: p.createdAt, status: complete ? 'complete' : 'interrupted', compensationFrames: p.end.compensationFrames || 0 };
          this.state.project.performances.push(perf);
          const take = { id: p.takeId, name: p.track.name, assetId: raw.id, frames: raw.frames, startFrame, performanceId: perf.id, role: p.track.role || 'lead', mix: clone(p.track.mix), createdAt: p.createdAt };
          this.state.project.takes.push(take); this.state.project.selectedTakeId = take.id;
        } else { this.retainRecoverable([raw, master]); retainedIntent = p.kind === 'vocal'; }
      } else if (!cancelled) {
        this.retainRecoverable([raw, master]); retainedIntent ||= p.kind === 'vocal' && Boolean(raw.frames || master?.frames);
      }
      if (retainedIntent) this.updateCaptureIntent(true); else delete this.state.project.pendingCapture;
      touch(this.state.project);
      for (const assetId of ids) this.sealed.delete(assetId);
      await this.saveNow();
      if (this.pending === p) this.pending = null; this.state.capture = null; this.state.busy = false;
      const interrupted = needsRecovery || p.interrupted || raw.status !== 'complete' || (master && (master.status !== 'complete' || master.frames !== raw.frames)) || p.hadUnderrun;
      this.state.status = needsRecovery ? 'Audio retained · recovery required' : cancelled ? 'Recording cancelled · backing continues' : interrupted ? 'Interrupted recording retained' : 'Saved on this device';
      this.ui.notify(needsRecovery ? 'Your checkpointed audio is retained. Use Recover in the Song view, or reopen this project, before previewing or exporting it.' : cancelled ? 'Recording cancelled.' : interrupted ? 'The saved portion was retained. Review the interrupted recording before exporting.' : p.kind === 'vocal' ? 'Vocal take and stereo performance saved. Your loops keep playing.' : 'Loop saved. Keep building your song.', cancelled || interrupted ? 'info' : 'success');
    } catch (error) { this.state.status = 'Audio retained · project save needs attention'; this.state.error = error.message; this.pending = null; this.state.capture = null; throw error; }
    finally { p.resolveDone?.(); this.state.busy = false; this.render(); }
  }
  async interrupt(message = 'Recording interrupted.', { notify = true } = {}) {
    const engine = this.engine;
    if (this.interruption?.engine === engine && (!this.pending || this.interruption.pending === this.pending)) return this.interruption.promise;
    const p = this.pending, project = this.state.project, preparing = p && !p.started && this.state.capture?.waitingForMic;
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
    clearTimeout(this.saveTimer); this.saveTimer = null; this.exportAbort?.abort();
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
    this.updateCaptureIntent(); const savedProject = this.state.project, snapshot = clone(savedProject); snapshot.updatedAt = now();
    const serial = ++this.saveSerial; if (!this.pending) this.state.status = 'Saving…';
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.storage.saveProject(snapshot));
    await this.saveChain;
    if (serial === this.saveSerial && this.state.project === savedProject && !this.saveTimer) { savedProject.updatedAt = snapshot.updatedAt; if (!this.pending) this.state.status = 'Saved on this device'; }
    this.render();
  }
  async flushSave() { if (this.saveTimer) await this.saveNow(); else await this.saveChain; }
  edit(action, key = null) { this.assertWritable(); this.history.push(this.state.project, key); action(this.state.project); touch(this.state.project); this.scheduleSave(); this.render(); }
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
    if (notify) this.ui.notify('Your download is ready. The download link stays available in the studio.', 'success');
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
    this.closePreview();
    this.state.exporting = true; this.state.exportProgress = 0; this.exportAbort = new AbortController(); this.render();
    try { await this.flushSave(); this.exportAbort.signal.throwIfAborted(); return await fn(this.exportAbort.signal); }
    finally { this.state.exporting = false; this.state.exportProgress = null; this.exportAbort = null; this.render(); }
  }
  async offerAudioDownload(assetId, label, signal) {
    try { this.offerDownload({ ...await exportWav(this.storage, assetId, { signal }), assetId }, label); }
    catch (error) {
      if (error.code !== 'WAV_SPLIT_REQUIRED') throw error;
      const group = id('download-group-'); let count = 0;
      for await (const part of exportWavParts(this.storage, assetId, { signal, maxDataBytes: 256 * 1024 * 1024 })) {
        this.offerDownload({ ...part, assetId }, `${label} · part ${part.part} of ${part.partCount}`, { group, autoDownload: false, notify: false }); count++;
      }
      this.ui.notify(`Your complete recording is ready in ${count} numbered WAV parts. Use each download link to save every part.`, 'success');
    }
  }
  async downloadAsset(assetId, label) {
    return this.withExport(signal => this.offerAudioDownload(assetId, label, signal));
  }
  async previewTake(takeId) {
    const take = this.state.project.takes.find(t => t.id === takeId); const perf = this.state.project.performances.find(p => p.id === take?.performanceId);
    if (take) return this.previewRecordedAsset(perf?.masterAssetId || take.assetId, perf?.name || take.name);
  }
  async previewRecordedAsset(assetId, name) {
    this.assertIdle();
    if (this.state.exporting || this.state.busy) throw new Error('Finish or cancel the current file operation before listening.');
    const token = this.generation; this.closePreview(); this.engine?.stop(); this.state.audition = null; this.state.playing = false;
    const abort = new AbortController(); this.previewAbort = abort;
    this.state.previewPreparing = { name }; this.state.status = 'Preparing recorded performance…'; this.render();
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
      if (asset.channels === 2) { await this.downloadAsset(assetId, 'Recovered stereo recording'); current(); this.state.status = previousStatus; return; }
      const pending = project.pendingCapture?.assetId === assetId ? project.pendingCapture : null;
      if (asset.kind === 'vocal') {
        const all = await this.storage.listAssets(project.id); current();
        const master = all.find(a => a.projectId === project.id && a.kind === 'master' && a.channels === 2 && a.sampleRate === project.sampleRate && Number.isSafeInteger(a.frames) && a.frames > 0 && (a.leadAssetId === asset.id || (asset.captureId && a.captureId === asset.captureId)) && ['complete', 'interrupted', 'recovered'].includes(a.status));
        this.edit(p => {
          const performanceId = master ? id('performance-') : null, startFrame = pending?.startFrame || 0;
          if (master) p.performances.push({ id: performanceId, name: 'Recovered performance', leadAssetId: asset.id, masterAssetId: master.id, frames: master.frames,
            startFrame, endFrame: startFrame + master.frames, tailFrames: 0, editableFrames: Math.min(asset.frames, master.frames, Math.max(0, (pending?.sealedThroughFrame || startFrame) - startFrame)),
            events: clone(pending?.events || []), initialState: clone(pending?.initialState || { tracks: p.tracks, master: p.master, input: p.input, baseFrames: p.baseFrames, frame: startFrame }), createdAt: now(), status: 'recovered' });
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
    if (this.state.exporting) throw new Error('Finish or cancel the export before managing storage.');
    const projects = await this.storage.listProjects();
    const rows = [];
    for (const project of projects) rows.push({ id: project.id, name: project.name, updatedAt: project.updatedAt, purgePending: !!project.purgePendingAt, ...(await this.storage.projectUsage(project.id)) });
    this.state.storage = { ...this.state.storage, ...await this.storage.estimate() };
    this.state.storageProjects = rows;
    this.ui.showStorageManager?.(rows, this.state.storage);
    this.render();
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
    if (this.state.exporting) throw new Error('Finish or cancel the export before deleting a project.');
    const project = (await this.storage.listProjects()).find(item => item.id === projectId);
    if (!project) return;
    const accepted = await this.ui.confirm({ title: `Delete ${project.name}?`, message: 'This permanently removes this project, its recordings and its saved takes from this device. Download a project backup first if you want to keep it. Playback will pause.', danger: true, confirmLabel: 'Delete permanently' });
    if (!accepted) return;
    this.assertIdle();
    if (this.state.exporting) throw new Error('Finish or cancel the export before deleting a project.');
    await this.handle({ type: 'stop' });
    if (project.id === this.state.project.id) {
      // Leave the project before deleting it so a partial disk failure cannot
      // leave the current studio pointing at a partly deleted song.
      const other = (await this.storage.listProjects()).find(item => item.id !== project.id && !item.purgePendingAt);
      await this.openProject(other?.id || null);
    }
    this.state.busy = true; this.state.status = 'Freeing project storage…'; this.render();
    try {
      await this.storage.purgeProject(project.id);
      this.state.projects = await this.storage.listProjects();
      this.state.storage = { ...this.state.storage, ...await this.storage.estimate() };
      this.state.status = 'Saved on this device'; this.state.error = null;
      this.ui.notify(`${project.name} deleted from this device.`, 'success');
    } finally { this.state.busy = false; this.render(); }
  }
  async handle(action = {}) {
    if (this.state.storageFailed && !['help', 'view', 'dismiss-error', 'reload-studio', 'close-preview'].includes(action.type)) throw new Error('Reopen the studio to recover saved recordings before continuing.');
    const p = this.state.project; if (!p && !['help', 'reload-studio', 'dismiss-error', 'view'].includes(action.type)) return;
    switch (action.type) {
      case 'enable-mic': { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; await engine.enableMic(this.state.preferredDeviceId); return; }
      case 'select-microphone': return this.selectMicrophone(action.deviceId);
      case 'mic-off': { ++this.generation; if (this.pending) { this.pending.interrupted = true; this.engine?.send('interrupt', { reason: 'Microphone switched off' }); } this.engine?.disableMic(); if (!this.pending) { this.state.capture = null; this.state.busy = false; } p.input.monitor = false; this.state.monitor = false; this.render(); return; }
      case 'monitor': { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; if (!this.state.micEnabled) await engine.enableMic(this.state.preferredDeviceId); if (token !== this.generation) return; p.input.monitor = action.enabled ?? !p.input.monitor; this.state.monitor = p.input.monitor; engine.configure(p); this.scheduleSave(); this.render(); return; }
      case 'play': { if (this.state.playing) return this.handle({ type: 'stop' }); this.closePreview(); const token = this.generation, e = await this.ensureAudio(); if (token !== this.generation) return; e.play(); this.keepAwake(); return; }
      case 'stop': { ++this.generation; this.closePreview(); this.microphoneOperation = null; this.state.micChanging = false; p.input.monitor = false; this.state.monitor = false; this.engine?.configure(p); this.engine?.stop(); this.state.audition = null; if (!this.pending) { this.state.capture = null; this.state.busy = false; } this.state.playing = false; await this.releaseWake(); this.render(); return; }
      case 'add-loop': { const cycles = action.cycles === 'custom' ? Math.max(1, Math.min(64, Number(action.customCycles) || 1)) : action.cycles === 0 ? 0 : Number(action.cycles) || 1; return this.startCapture('loop', cycles); }
      case 'sing': return this.startCapture('vocal', 0);
      case 'finish': this.engine?.finish(); return;
      case 'cancel': { ++this.generation; this.engine?.cancel(); if (!this.pending) { this.state.capture = null; this.state.busy = false; this.render(); } return; }
      case 'view': this.state.view = ['build', 'song', 'mix'].includes(action.view) ? action.view : 'build'; this.render(); return;
      case 'select-track': this.state.selectedTrackId = action.id; this.state.view = 'mix'; this.render(); return;
      case 'mix': this.edit(project => { const t = project.tracks.find(t => t.id === action.id) || project.takes.find(t => t.id === action.id); if (t) { t.mix = normalizeMix({ ...t.mix, ...action.mix }); this.engine?.send('mix', { id: t.id, mix: t.mix }); } }, `mix:${action.id}`); return;
      case 'mute': case 'solo': this.edit(project => { const t = project.tracks.find(t => t.id === action.id); if (t) { const key = action.type === 'mute' ? 'muted' : 'solo'; t[key] = !t[key]; this.engine?.send('mix', { id: t.id, [key]: t[key] }); } }); return;
      case 'rename-track': this.edit(project => { const t = project.tracks.find(t => t.id === action.id); if (t) t.name = cleanName(action.name, t.name); }); return;
      case 'remove-track': this.edit(project => { project.tracks = project.tracks.filter(t => t.id !== action.id); this.engine?.send('remove-track', { id: action.id }); if (this.state.selectedTrackId === action.id) this.state.selectedTrackId = project.tracks[0]?.id || null; }); return;
      case 'role': { if (!Object.hasOwn(COLORS, action.role)) throw new Error('Choose one of the available sound presets.'); this.edit(project => { const t = project.tracks.find(t => t.id === action.id) || project.takes.find(t => t.id === action.id); if (t) { t.role = action.role; t.mix = roleMix(action.role, t.mix); t.color = COLORS[action.role]; this.engine?.send('mix', { id: t.id, mix: t.mix }); } }); return; }
      case 'nudge': this.edit(project => { const t = project.tracks.find(t => t.id === action.id); if (t) { t.offsetFrames += Math.round(Number(action.frames) || 0); this.engine?.send('track', { track: t }); } }); return;
      case 'undo': case 'redo': { this.assertWritable(); this.assertIdle(); const restored = this.history[action.type](p); if (restored) { delete restored.pendingCapture; this.state.project = restored; touch(restored); this.engine?.configure(restored); this.engine?.syncTracks(restored.tracks); this.scheduleSave(); this.render(); } return; }
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
      case 'save': await this.saveNow(); this.ui.notify('Project saved on this device. Export a backup to keep an independent copy.', 'success'); return;
      case 'export-project': return this.withExport(async signal => this.offerDownload(await exportProject(this.storage, p, { signal }), 'Project backup'));
      case 'import-project': { this.assertIdle(); if (!action.file) return; await this.withExport(async signal => { const imported = await importProject(this.storage, action.file, { signal }); await this.openProject(imported.id, imported); this.ui.notify('Backup restored as a separate project.', 'success'); }); return; }
      case 'import-audio': return this.importAudio(action.file);
      case 'export-track': { const track = p.tracks.find(t => t.id === action.id) || p.takes.find(t => t.id === action.id); if (track) return this.downloadAsset(track.assetId, 'Clean recording'); return; }
      case 'export-master': { const perf = p.performances.find(perf => perf.id === action.performanceId) || p.performances.at(-1); if (!perf) throw new Error('Record a vocal performance first, or export the current mix.'); return this.downloadAsset(perf.masterAssetId, 'Stereo performance'); }
      case 'save-section': { const name = action.name || await this.ui.prompt({ title: 'Save a song section', message: 'This remembers exactly which loops are present and their mix.', value: ['Intro', 'Verse', 'Chorus', 'Bridge'][p.sections.length] || `Section ${p.sections.length + 1}`, label: 'Section name' }); if (name) this.edit(project => { project.sections.push(sectionFromProject(project, name)); }); return; }
      case 'launch-section': { const section = p.sections.find(s => s.id === action.id); if (!section) return; this.assertWritable(); this.history.push(p); if (this.engine) { this.state.queuedSectionId = section.id; this.engine.send('section', { section: clone(section) }); } else { applySection(p, section); this.state.activeSectionId = section.id; this.scheduleSave(); } this.render(); return; }
      case 'delete-section': this.edit(project => { project.sections = project.sections.filter(s => s.id !== action.id); }); return;
      case 'select-take': this.edit(project => { project.selectedTakeId = action.id; }); return;
      case 'rename-take': this.edit(project => { const t = project.takes.find(t => t.id === action.id); if (t) t.name = cleanName(action.name, t.name); }); return;
      case 'delete-take': this.edit(project => { project.takes = project.takes.filter(t => t.id !== action.id); if (project.selectedTakeId === action.id) project.selectedTakeId = project.takes.at(-1)?.id || null; }); return;
      case 'preview-take': return this.previewTake(action.id);
      case 'preview-performance': { const perf = p.performances.find(item => item.id === action.performanceId); if (perf) return this.previewRecordedAsset(perf.masterAssetId, perf.name); return; }
      case 'layer-vocal': { const take = p.takes.find(t => t.id === action.id); if (!take) return; if (p.tracks.length >= MAX_TRACKS) throw new Error('This project has reached its layer limit.'); this.edit(project => { const track = createTrack({ assetId: take.assetId, name: `${take.name} · layer`, role: 'lead', frames: take.frames, offsetFrames: take.startFrame % take.frames, mix: normalizeMix(take.mix || roleMix('lead')) }); project.tracks.push(track); this.state.selectedTrackId = track.id; if (!project.baseFrames) project.baseFrames = track.frames; }); this.engine?.configure(p); this.engine?.syncTracks(p.tracks); return; }
      case 'close-preview': this.closePreview(); this.render(); return;
      case 'spotlight': this.engine?.send('spotlight', { active: !!action.active }); return;
      case 'seek-start': this.assertIdle(); this.engine?.send('seek', { frame: 0 }); return;
      case 'demo': return this.demo();
      case 'recover-asset': return this.recoverAsset(action.id);
      case 'export-recovered': return this.downloadAsset(action.id, 'Recovered recording');
      case 'persist': { this.state.storage = { ...this.state.storage, ...await this.storage.requestPersistence() }; this.ui.notify(this.state.storage.persistent ? 'Persistent storage granted. Keep backups as well.' : 'The browser did not grant persistent storage. Project backups are still available.', 'info'); this.render(); return; }
      case 'manage-storage': return this.manageStorage();
      case 'delete-project': return this.deleteProject(action.id);
      case 'delete-saved-mix': return this.deleteSavedMix(action.id);
      case 'cancel-export': this.exportAbort?.abort(); return;
      case 'export-mix': return this.exportMix(action);
      case 'preview-mix': return this.previewMix(action);
      case 'help': this.ui.showHelp?.(); return;
      case 'dismiss-error': if (!this.state.storageFailed) this.state.error = null; this.render(); return;
      case 'reload-studio': { if (this.pending) throw new Error('Finish or cancel the current recording before reopening.'); await this.engine?.close(); globalThis.location.reload(); return; }
    }
  }
  async exportMix(action) {
    return this.withExport(async signal => {
      const selected = this.state.project.takes.find(t => t.id === this.state.project.selectedTakeId);
      const explicitDuration = action.durationSeconds !== undefined && action.durationSeconds !== null && action.durationSeconds !== '';
      const durationSeconds = explicitDuration ? Number(action.durationSeconds) : selected ? undefined : this.state.project.baseFrames / this.state.sampleRate * 4;
      if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) throw new Error('Choose a positive export duration, or add a loop or vocal take.');
      const result = await this.renderMix(this.state.project, { performanceId: selected?.performanceId, ...(durationSeconds === undefined ? {} : { durationSeconds }), tailSeconds: 2, mode: 'current', signal,
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
    this.assertIdle(); if (this.state.exporting) throw new Error('Finish or cancel the export before auditioning.'); this.closePreview();
    const token = this.generation;
    const take = this.state.project.takes.find(t => t.id === this.state.project.selectedTakeId);
    if (!take) { const e = await this.ensureAudio(); if (token !== this.generation) return; e.play(); this.keepAwake(); this.ui.notify('Auditioning the current loop mix. Adjust the mixer while it plays.', 'info'); return; }
    const engine = await this.ensureAudio();
    if (token !== this.generation) return;
    this.state.audition = { id: take.id, status: 'loading', startFrame: take.startFrame, endFrame: take.startFrame + take.frames, tailFrames: this.state.sampleRate * 2 };
    engine.send('audition', { take: { ...take, mix: take.mix || roleMix('lead') }, startFrame: take.startFrame, tailFrames: this.state.sampleRate * 2 });
    this.state.status = 'Loading live mix audition…'; this.keepAwake(); this.render();
  }
  handleError(error) { if (isAbort(error)) return; console.error(error); this.state.error = error.message || String(error); this.state.busy = false; this.ui.notify(this.state.error, 'error'); this.render(); }
}
