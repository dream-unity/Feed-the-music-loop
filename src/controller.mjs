import { AudioEngine } from './audio/client.mjs';
import { createProject, createTrack, validateProject, roleMix, normalizeMix, sectionFromProject, applySection, ProjectHistory, referencedAssets, cleanName, id, clone, touch, PAGE_FRAMES, MAX_TRACKS, COLORS } from './project.mjs';
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
      recovered: [], readonly: false, downloads: [], preview: null, audition: null, exportProgress: null, activeSectionId: null, queuedSectionId: null };
    this.ui.addEventListener('action', e => { this.handle(e.detail).catch(error => this.handleError(error)); });
    this.storage.addEventListener('progress', e => this.storageProgress(e.detail));
    this.storage.addEventListener('error', e => { this.state.status = 'Recording interrupted'; this.handleError(new Error(e.detail.message)); });
  }
  render() { this.state.undoAvailable = !!this.history.past.length; this.state.redoAvailable = !!this.history.future.length; this.ui.render(this.state); }
  async init() {
    this.render(); this.state.storage = await this.storage.init();
    this.state.projects = await this.storage.listProjects();
    let previous = null; try { previous = localStorage.getItem('fml:last-project'); } catch {}
    const selected = this.state.projects.find(p => p.id === previous) || this.state.projects[0];
    await this.openProject(selected?.id || null);
    globalThis.addEventListener?.('beforeunload', e => { if (this.pending || this.state.status === 'Saving…') { e.preventDefault(); e.returnValue = ''; } });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && (this.state.playing || this.pending)) this.keepAwake(); });
    return this;
  }
  assertWritable() { if (this.state.readonly) throw new Error('This project is open in another tab. Close that tab before editing here, or export a backup.'); }
  assertIdle() { if (this.pending || this.state.capture) throw new Error('Finish or cancel the recording before changing projects or exporting.'); }
  async openProject(projectId = null, supplied = null) {
    this.assertIdle(); ++this.generation; this.state.busy = true; this.render();
    const previousId = this.state.project?.id;
    if (previousId && !this.state.readonly) await this.flushSave();
    const next = supplied ? validateProject(supplied) : projectId ? validateProject(await this.storage.loadProject(projectId)) : createProject('My first song');
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
    const assets = await this.storage.listAssets(next.id); const used = new Set(referencedAssets(next));
    this.state.recovered = assets.filter(a => a.frames > 0 && a.status !== 'cancelled' && !used.has(a.id));
    this.state.status = this.state.readonly ? 'Read only · another tab is editing' : this.state.recovered.length ? `${this.state.recovered.length} recording${this.state.recovered.length === 1 ? '' : 's'} available to recover` : 'Saved on this device';
    this.state.busy = false; this.state.error = null;
    this.state.projects = await this.storage.listProjects();
    try { localStorage.setItem('fml:last-project', next.id); } catch {}
    this.render();
    if (next.pendingCapture && this.state.recovered.length) this.ui.notify('An unfinished recording was recovered. Its saved audio is available in the Song view.', 'info');
  }
  async ensureAudio() {
    if (!this.state.project) throw new Error('The project is still opening.');
    if (!this.engine) {
      this.engine = new AudioEngine(this.storage);
      for (const name of ['state', 'meter', 'capture-start', 'capture-end', 'asset-sealed', 'section', 'command', 'automation', 'track-ready', 'mic', 'error', 'interrupted', 'device-lost', 'context-state', 'audition-start', 'audition-end']) {
        this.engine.addEventListener(name, e => this.audioEvent(name, e.detail));
      }
      this.engine.addEventListener('underrun', () => {
        if (Date.now() - this.lastUnderrunAt > 5000) { this.lastUnderrunAt = Date.now(); this.ui.notify('Storage could not supply audio in time. Stop and reopen the project if you hear a gap.', 'error'); }
        if (this.pending) this.pending.hadUnderrun = true;
      });
    }
    await this.engine.init(this.state.project); await this.engine.waitUntilReady(); return this.engine;
  }
  audioEvent(type, data) {
    if (type === 'state' || type === 'meter') {
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
    if (type === 'mic') { this.state.micEnabled = data.enabled; if (!data.enabled) { this.state.monitor = false; this.state.inputLevel = 0; } this.state.micSettings = data.settings; this.render(); return; }
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
      if (this.pending && data.fatal) this.interrupt(data.message).catch(() => {});
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
    if (this.state.exporting) throw new Error('Finish or cancel the export before recording.');
    if (kind === 'loop' && this.state.project.tracks.length >= MAX_TRACKS) throw new Error(`This project has reached ${MAX_TRACKS} layers. Start another project or remove unused layers.`);
    this.closePreview();
    if (this.state.audition) { this.engine?.stop(); this.state.audition = null; this.state.playing = false; }
    const token = ++this.generation; this.state.capture = { kind, status: 'arming', waitingForMic: true, elapsedFrames: 0 }; this.state.busy = true; this.render();
    let pending = null;
    try {
      const engine = await this.ensureAudio(); if (token !== this.generation) return;
      await engine.enableMic(); if (token !== this.generation) return;
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
  async interrupt(message = 'Recording interrupted.') {
    ++this.generation; const p = this.pending; this.engine?.send('interrupt', { reason: message });
    if (p) {
      p.interrupted = true;
      // A suspended/dead audio thread cannot drain its final page. Seal only worker-verified samples.
      await sleep(100);
      if (this.pending === p && !p.ended) {
        const raw = await this.storage.finishAsset(p.assetId, { status: 'interrupted' }).catch(() => this.storage.getAsset(p.assetId));
        this.sealed.set(p.assetId, raw);
        if (p.masterAssetId) { const master = await this.storage.finishAsset(p.masterAssetId, { status: 'interrupted' }).catch(() => this.storage.getAsset(p.masterAssetId)); this.sealed.set(p.masterAssetId, master); }
        p.end = { captureId: p.id, kind: p.kind, status: 'interrupted', frames: raw.frames, startFrame: p.startFrame, endFrame: p.startFrame + raw.frames, assetId: p.assetId, masterAssetId: p.masterAssetId };
        p.ended = true; await this.tryFinalize();
      }
    } else { this.state.capture = null; this.state.busy = false; }
    this.ui.notify(message, 'error'); this.render();
  }
  scheduleSave(delay = 350) { if (this.state.readonly) return; clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.saveNow().catch(error => this.handleError(error)), delay); }
  async saveNow() {
    if (!this.state.project || this.state.readonly) return;
    clearTimeout(this.saveTimer); this.saveTimer = null;
    this.updateCaptureIntent(); const snapshot = clone(this.state.project); snapshot.updatedAt = now();
    const serial = ++this.saveSerial; if (!this.pending) this.state.status = 'Saving…';
    this.saveChain = this.saveChain.catch(() => {}).then(() => this.storage.saveProject(snapshot));
    await this.saveChain;
    if (serial === this.saveSerial) { this.state.project.updatedAt = snapshot.updatedAt; if (!this.pending) this.state.status = 'Saved on this device'; }
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
    globalThis.document?.querySelector('#performance-player')?.pause();
    if (this.state.preview?.url) { URL.revokeObjectURL(this.state.preview.url); this.urls.delete(this.state.preview.url); }
    this.state.preview = null;
  }
  offerDownload(result, label = 'Download ready') {
    const url = URL.createObjectURL(result.blob); this.urls.add(url);
    this.state.downloads.push({ id: id('download-'), url, filename: result.filename, label });
    if (this.state.downloads.length > 8) { const old = this.state.downloads.shift(); URL.revokeObjectURL(old.url); this.urls.delete(old.url); }
    this.render(); const a = document.createElement('a'); a.href = url; a.download = result.filename; document.body.append(a); a.click(); a.remove();
    this.ui.notify('Your download is ready. The download link stays available in the studio.', 'success');
  }
  async withExport(fn) {
    this.assertIdle(); if (this.state.exporting) throw new Error('An export is already running.');
    this.state.exporting = true; this.state.exportProgress = 0; this.exportAbort = new AbortController(); this.render();
    try { await this.flushSave(); this.exportAbort.signal.throwIfAborted(); return await fn(this.exportAbort.signal); }
    finally { this.state.exporting = false; this.state.exportProgress = null; this.exportAbort = null; this.render(); }
  }
  async offerAudioDownload(assetId, label, signal) {
    try { this.offerDownload(await exportWav(this.storage, assetId, { signal }), label); }
    catch (error) {
      if (error.code !== 'WAV_SPLIT_REQUIRED') throw error;
      for await (const part of exportWavParts(this.storage, assetId, { signal, maxDataBytes: 256 * 1024 * 1024 })) this.offerDownload(part, `${label} · part ${part.part}`);
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
    this.assertIdle(); const token = this.generation; this.closePreview(); this.engine?.stop(); this.state.audition = null; this.state.playing = false;
    const exported = await exportWav(this.storage, assetId);
    if (token !== this.generation) return;
    const url = URL.createObjectURL(exported.blob); this.urls.add(url); this.state.preview = { url, name, kind: 'performance' }; this.render();
    document.querySelector('#performance-player')?.play().catch(() => this.ui.notify('Press Play in the performance player to listen.', 'info'));
  }
  async importAudio(file) {
    this.assertWritable(); this.assertIdle(); if (!file) return;
    if (file.size > 128 * 1024 * 1024) throw new Error('Audio import currently supports files up to 128 MB. Record long takes directly in the studio or import a smaller file.');
    if (this.state.project.tracks.length >= MAX_TRACKS) throw new Error('This project has reached its layer limit.');
    const engine = await this.ensureAudio(); this.state.busy = true; this.state.status = 'Importing audio…'; this.render();
    const token = ++this.generation, projectId = this.state.project.id; let assetId;
    try {
      const decoded = await engine.context.decodeAudioData(await file.arrayBuffer());
      if (decoded.length > this.state.sampleRate * 60 * 20) throw new Error('Imported audio is limited to 20 minutes per file. Longer recordings can be made directly in the studio.');
      if (token !== this.generation) return;
      assetId = id('audio-'); const track = createTrack({ assetId, name: file.name.replace(/\.[^.]+$/, ''), role: 'harmony', frames: decoded.length });
      await this.storage.beginAsset({ id: assetId, projectId, sampleRate: this.state.sampleRate, channels: 1, kind: 'import', name: track.name, sourceName: file.name, track });
      for (let offset = 0, index = 0; offset < decoded.length; offset += PAGE_FRAMES, index++) {
        if (token !== this.generation) throw Object.assign(new Error('Import cancelled.'), { name: 'AbortError' });
        const frames = Math.min(PAGE_FRAMES, decoded.length - offset), pcm = new Float32Array(frames);
        for (let c = 0; c < decoded.numberOfChannels; c++) { const channel = decoded.getChannelData(c); for (let i = 0; i < frames; i++) pcm[i] += channel[offset + i] / decoded.numberOfChannels; }
        await this.storage.putPage(assetId, index, pcm.buffer, frames, 1);
      }
      const asset = await this.storage.finishAsset(assetId, { frames: decoded.length }); if (asset.status !== 'complete') throw new Error('The imported audio could not be saved completely.');
      track.peaks = await this.summarize(asset); this.edit(p => { p.tracks.push(track); if (!p.baseFrames) p.baseFrames = track.frames; });
      this.state.selectedTrackId = track.id; engine.configure(this.state.project); engine.syncTracks(this.state.project.tracks); await this.saveNow();
      this.ui.notify('Audio imported as an independent loop.', 'success');
    } catch (error) { if (assetId) await this.storage.finishAsset(assetId, { status: 'interrupted' }).catch(() => {}); throw error; }
    finally { this.state.busy = false; this.render(); }
  }
  async demo() {
    this.assertWritable(); this.assertIdle(); if (this.state.project.tracks.length) { this.ui.notify('Start a new project to load the demo without changing your recordings.', 'info'); return; }
    const engine = await this.ensureAudio(); this.state.busy = true; this.render();
    const sr = this.state.sampleRate, frames = sr * 2, tracks = [];
    try {
      for (const [kind, name, role, pan] of [['beat', 'Mouth rhythm', 'beat', 0], ['bass', 'Warm bass', 'bass', -.12], ['harmony', 'Air harmony', 'harmony', .25]]) {
        const assetId = id('demo-'), track = createTrack({ assetId, name, role, frames }); track.mix.pan = pan; track.mix.volume = kind === 'beat' ? .85 : kind === 'bass' ? .55 : .35;
        await this.storage.beginAsset({ id: assetId, projectId: this.state.project.id, sampleRate: sr, channels: 1, kind: 'demo', name, track });
        for (let offset = 0, index = 0; offset < frames; offset += PAGE_FRAMES, index++) {
          const count = Math.min(PAGE_FRAMES, frames - offset), pcm = new Float32Array(count);
          for (let i = 0; i < count; i++) {
            const t = (offset + i) / sr, beat = t % .5;
            if (kind === 'beat') { const seed = Math.sin((offset + i) * 12.9898) * 43758.5453; const noise = (seed - Math.floor(seed)) * 2 - 1; pcm[i] = .75 * Math.sin(2 * Math.PI * (70 * beat + 7 * (1 - Math.exp(-beat * 40)))) * Math.exp(-beat * 35) + noise * .12 * Math.exp(-(t % .25) * 95); }
            else if (kind === 'bass') { const f = t < 1 ? 110 : 82.4069; pcm[i] = .32 * (Math.sin(2 * Math.PI * f * t) + .15 * Math.sin(2 * Math.PI * f * 2 * t)) * Math.min(1, (t % 1) * 20, (1 - t % 1) * 20); }
            else pcm[i] = .2 * (Math.sin(2 * Math.PI * 220 * t) + .45 * Math.sin(2 * Math.PI * 330 * t)) * Math.sin(Math.PI * t / 2) ** 2;
          }
          await this.storage.putPage(assetId, index, pcm.buffer, count, 1);
        }
        const asset = await this.storage.finishAsset(assetId, { frames }); track.peaks = await this.summarize(asset); tracks.push(track);
      }
      this.edit(p => { p.name = p.name === 'My first song' ? 'First light · demo' : p.name; p.tracks = tracks; p.baseFrames = frames; });
      const intro = sectionFromProject(this.state.project, 'Intro'); intro.tracks[tracks[2].id].muted = true;
      const chorus = sectionFromProject(this.state.project, 'Chorus'); this.state.project.sections.push(intro, chorus);
      this.state.selectedTrackId = tracks[0].id; engine.configure(this.state.project); engine.syncTracks(tracks); await engine.waitUntilReady(); engine.play(); await this.saveNow();
      this.ui.notify('Demo loaded. These are generated sounds; record your own voice to make it yours.', 'success'); this.keepAwake();
    } finally { this.state.busy = false; this.render(); }
  }
  async recoverAsset(assetId) {
    this.assertWritable(); this.assertIdle(); let asset = await this.storage.getAsset(assetId); if (!asset.frames) return;
    if (asset.status === 'recording') {
      this.engine?.stop(); this.state.playing = false;
      await this.storage.recover(this.state.project.id); asset = await this.storage.getAsset(assetId);
      if (asset.status === 'recording') throw new Error('This recording still needs recovery. Free browser storage if necessary, then reopen this project.');
    }
    if (asset.channels === 2) { await this.downloadAsset(assetId, 'Recovered stereo recording'); return; }
    if (asset.kind === 'vocal') {
      const pending = this.state.project.pendingCapture;
      const all = await this.storage.listAssets(this.state.project.id); const master = all.find(a => a.kind === 'master' && a.frames > 0 && (a.leadAssetId === asset.id || (asset.captureId && a.captureId === asset.captureId)) && ['complete', 'interrupted', 'recovered'].includes(a.status));
      this.edit(p => {
        const performanceId = master ? id('performance-') : null, startFrame = pending?.assetId === assetId ? pending.startFrame || 0 : 0;
        if (master) p.performances.push({ id: performanceId, name: 'Recovered performance', leadAssetId: asset.id, masterAssetId: master.id, frames: master.frames,
          startFrame, endFrame: startFrame + master.frames, tailFrames: 0, editableFrames: Math.min(asset.frames, master.frames, Math.max(0, (pending?.sealedThroughFrame || startFrame) - startFrame)),
          events: pending?.events || [], initialState: pending?.initialState || { tracks: clone(p.tracks), master: clone(p.master), input: clone(p.input), baseFrames: p.baseFrames, frame: startFrame }, createdAt: now(), status: 'recovered' });
        const take = { id: id('take-'), name: asset.name || 'Recovered vocal', assetId, frames: asset.frames, startFrame, performanceId, mix: roleMix('lead'), createdAt: now() }; p.takes.push(take); p.selectedTakeId = take.id; delete p.pendingCapture;
      });
    } else {
      const track = createTrack({ ...(asset.track || {}), id: id('track-'), assetId, name: `${asset.name || 'Loop'} · recovered`, frames: asset.frames, offsetFrames: 0 });
      track.peaks = await this.summarize(asset); this.edit(p => { p.tracks.push(track); if (!p.baseFrames) p.baseFrames = track.frames; delete p.pendingCapture; }); this.engine?.configure(this.state.project); this.engine?.syncTracks(this.state.project.tracks);
    }
    const used = new Set(referencedAssets(this.state.project)); this.state.recovered = this.state.recovered.filter(a => !used.has(a.id)); await this.saveNow(); this.render();
  }
  async handle(action = {}) {
    const p = this.state.project; if (!p && !['help'].includes(action.type)) return;
    switch (action.type) {
      case 'enable-mic': { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; await engine.enableMic(); return; }
      case 'mic-off': { ++this.generation; if (this.pending) { this.pending.interrupted = true; this.engine?.send('interrupt', { reason: 'Microphone switched off' }); } this.engine?.disableMic(); if (!this.pending) { this.state.capture = null; this.state.busy = false; } p.input.monitor = false; this.state.monitor = false; this.render(); return; }
      case 'monitor': { const token = this.generation, engine = await this.ensureAudio(); if (token !== this.generation) return; if (!this.state.micEnabled) await engine.enableMic(); if (token !== this.generation) return; p.input.monitor = action.enabled ?? !p.input.monitor; this.state.monitor = p.input.monitor; engine.configure(p); this.scheduleSave(); this.render(); return; }
      case 'play': { if (this.state.playing) return this.handle({ type: 'stop' }); this.closePreview(); const token = this.generation, e = await this.ensureAudio(); if (token !== this.generation) return; e.play(); this.keepAwake(); return; }
      case 'stop': { ++this.generation; this.closePreview(); p.input.monitor = false; this.state.monitor = false; this.engine?.configure(p); this.engine?.stop(); this.state.audition = null; if (!this.pending) { this.state.capture = null; this.state.busy = false; } this.state.playing = false; await this.releaseWake(); this.render(); return; }
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
      case 'layer-vocal': { const take = p.takes.find(t => t.id === action.id); if (!take) return; this.edit(project => { const track = createTrack({ assetId: take.assetId, name: `${take.name} · layer`, role: 'lead', frames: take.frames, offsetFrames: take.startFrame % take.frames, mix: normalizeMix(take.mix || roleMix('lead')) }); project.tracks.push(track); this.state.selectedTrackId = track.id; if (!project.baseFrames) project.baseFrames = track.frames; }); this.engine?.configure(p); this.engine?.syncTracks(p.tracks); return; }
      case 'close-preview': this.closePreview(); this.render(); return;
      case 'spotlight': this.engine?.send('spotlight', { active: !!action.active }); return;
      case 'seek-start': this.assertIdle(); this.engine?.send('seek', { frame: 0 }); return;
      case 'demo': return this.demo();
      case 'recover-asset': return this.recoverAsset(action.id);
      case 'export-recovered': return this.downloadAsset(action.id, 'Recovered recording');
      case 'persist': { this.state.storage = { ...this.state.storage, ...await this.storage.requestPersistence() }; this.ui.notify(this.state.storage.persistent ? 'Persistent storage granted. Keep backups as well.' : 'The browser did not grant persistent storage. Project backups are still available.', 'info'); this.render(); return; }
      case 'cancel-export': this.exportAbort?.abort(); return;
      case 'export-mix': return this.exportMix(action);
      case 'preview-mix': return this.previewMix(action);
      case 'help': this.ui.showHelp?.(); return;
      case 'dismiss-error': this.state.error = null; this.render(); return;
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
