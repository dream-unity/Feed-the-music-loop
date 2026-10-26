import { PAGE_FRAMES, clone, roleMix } from '../project.mjs';

const abortError = () => Object.assign(new Error('Recording request cancelled.'), { name: 'AbortError' });
const event = (type, detail) => new CustomEvent(type, { detail });

/** Main-thread device lifecycle. Sample scheduling and mixing belong to the worklet. */
export class AudioEngine extends EventTarget {
  constructor(storage, { resumeTimeoutMs = 10000 } = {}) {
    super(); this.storage = storage; this.context = null; this.node = null; this.stream = null; this.source = null;
    this.micGeneration = 0; this.initPromise = null; this.tracks = new Map(); this.playing = false; this.frame = 0;
    this.capture = null; this.armingCapture = null; this.paused = false; this.playbackOffsets = {}; this.playbackBaselines = {}; this.transportGeneration = 0; this.closed = false; this.requestId = 0; this.micPromise = null; this.projectId = null;
    this.selectedDeviceId = ''; this.pendingDeviceId = null; this.deviceTarget = null; this.deviceListener = null; this.deviceListGeneration = 0;
    this.suppressedStateChange = false;
    this.readyTracks = new Set(); this.readyWaiters = new Set(); this.trackAssets = new Map(); this.readinessGeneration = 0;
    this.resumeTimeoutMs = resumeTimeoutMs;
  }
  async init(project) {
    if (this.closed) throw new Error('This audio session has closed. Reopen the project.');
    if (this.initPromise) { await this.initPromise; await this.resume(); return this; }
    if (this.node) { await this.resume(); return this; }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass) throw new Error('This browser does not support Web Audio. Open the studio in a current Chrome, Edge, Firefox or Safari browser.');
    // Create/resume directly inside the initiating gesture, before worker/module awaits.
    this.context = new AudioContextClass({ sampleRate: project.sampleRate, latencyHint: 'interactive' });
    if (this.context.sampleRate !== project.sampleRate) {
      await this.context.close(); this.context = null;
      throw new Error(`This device could not open the project's ${project.sampleRate} Hz audio rate. Your saved audio is unchanged.`);
    }
    if (!this.context.audioWorklet) { await this.context.close(); this.context = null; throw new Error('AudioWorklet is unavailable. Use the HTTPS website in a supported browser.'); }
    const resumed = this.resume();
    this.initPromise = (async () => {
      await resumed;
      await this.context.audioWorklet.addModule(new URL('./loop-worklet.mjs', import.meta.url));
      if (this.closed) throw abortError();
      this.node = new AudioWorkletNode(this.context, 'fml-engine', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 1, channelCountMode: 'explicit', processorOptions: { sampleRate: project.sampleRate, pageFrames: PAGE_FRAMES } });
      this.node.port.onmessage = e => this.onMessage(e.data);
      this.node.onprocessorerror = () => this.dispatchEvent(event('error', { fatal: true, message: 'The audio engine was interrupted. Stop the session and reopen the project to recover saved recordings.' }));
      const channel = new MessageChannel();
      await this.storage.attachAudioPort(channel.port1);
      if (this.closed || !this.node) { channel.port1.close(); channel.port2.close(); throw abortError(); }
      this.node.port.postMessage({ type: 'storage-port', port: channel.port2 }, [channel.port2]);
      const buffers = Array.from({ length: 24 }, () => new ArrayBuffer(PAGE_FRAMES * 2 * 4));
      this.node.port.postMessage({ type: 'pool', buffers }, buffers);
      this.node.connect(this.context.destination);
      this.projectId = project.id;
      this.configure(project); this.syncTracks(project.tracks);
      this.context.onstatechange = () => {
        const state = this.context?.state;
        this.dispatchEvent(event('context-state', { state }));
        if (!this.suppressedStateChange && ['suspended', 'interrupted', 'closed'].includes(state) && this.capture) {
          this.send('interrupt', { reason: 'Audio context interrupted' });
          this.dispatchEvent(event('interrupted', { message: 'Audio was interrupted. The saved portion is retained; resume deliberately when you are ready.' }));
        }
      };
      return this;
    })();
    try { return await this.initPromise; }
    catch (error) { this.initPromise = null; this.node?.disconnect(); this.node = null; await this.context?.close().catch(() => {}); this.context = null; throw this.closed ? abortError() : error; }
  }
  async resume() {
    if (this.closed) throw abortError();
    if (!this.context || this.context.state === 'running') return;
    let timer;
    // Some devices and browser audio policies leave resume pending indefinitely.
    // Start it inside the user gesture, but keep the interface recoverable.
    const starting = this.context.resume();
    try {
      await Promise.race([starting, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Audio could not start. Check your audio output and browser sound permission, then press Play or Record to retry.')), this.resumeTimeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  onMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    if ((message.type === 'meter' || message.type === 'state') && (!Number.isSafeInteger(message.transportGeneration) || message.transportGeneration >= this.transportGeneration)) {
      this.paused = !!message.paused; this.playbackOffsets = message.playbackOffsets || this.playbackOffsets; this.playbackBaselines = message.playbackBaselines || this.playbackBaselines;
      this.playing = !!message.playing; this.frame = message.transportFrame ?? this.frame; this.capture = message.capture ?? null;
    }
    if (message.type === 'capture-end') this.capture = null;
    if (this.armingCapture && (message.capture?.id === this.armingCapture.id || (['capture-end', 'capture-rejected'].includes(message.type) && message.captureId === this.armingCapture.id))) this.armingCapture = null;
    if (message.type === 'track-ready' && (!message.assetId || this.trackAssets.get(message.id) === message.assetId)) { this.readyTracks.add(message.id); for (const check of this.readyWaiters) check(); }
    this.dispatchEvent(event(message.type, message));
  }
  send(type, detail = {}, transfer = []) {
    if (!this.node) return false;
    if (['play', 'pause', 'stop', 'seek'].includes(type)) detail = { ...detail, transportGeneration: ++this.transportGeneration };
    this.node.port.postMessage({ type, requestId: ++this.requestId, ...detail }, transfer); return true;
  }
  configure(project) {
    this.send('configure', { baseFrames: project.baseFrames, compensationFrames: Math.round(project.input.compensationMs * project.sampleRate / 1000), inputGain: project.input.gain,
      monitor: project.input.monitor, masterVolume: project.master.volume, inputMix: project.input.mix || roleMix('lead'), metronome: project.metronome });
  }
  syncTracks(tracks) {
    const ids = new Set(tracks.map(t => t.id));
    for (const id of this.tracks.keys()) if (!ids.has(id)) { this.send('remove-track', { id }); this.tracks.delete(id); this.readyTracks.delete(id); this.trackAssets.delete(id); }
    for (const track of tracks) {
      const serialized = JSON.stringify(track);
      if (this.trackAssets.get(track.id) !== track.assetId) this.readyTracks.delete(track.id);
      this.trackAssets.set(track.id, track.assetId);
      // Mixer, timing and section commands also change the running worklet.
      // A previous project snapshot is not proof that its live state still
      // matches. Reconcile every desired track; same-asset updates retain DSP,
      // page caches and playback phase inside the audio engine.
      this.send('track', { track: clone(track) }); this.tracks.set(track.id, serialized);
    }
    for (const check of this.readyWaiters) check();
  }
  adoptRecordedTrack(track) {
    // The worklet starts a completed loop at its exact musical boundary before
    // durable finalization returns. Register that already-playing track without
    // adding it again or waiting for a second readiness acknowledgement.
    if (this.closed || !track?.id || !track.assetId) return;
    this.tracks.set(track.id, JSON.stringify(track));
    this.trackAssets.set(track.id, track.assetId); this.readyTracks.add(track.id);
    for (const check of this.readyWaiters) check();
  }
  waitUntilReady(timeout = 15000) {
    if (this.closed) return Promise.reject(abortError());
    if ([...this.tracks.keys()].every(id => this.readyTracks.has(id))) return Promise.resolve();
    const generation = this.readinessGeneration;
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); this.readyWaiters.delete(check); };
      const check = () => {
        if (this.closed || generation !== this.readinessGeneration) { cleanup(); reject(abortError()); }
        else if ([...this.tracks.keys()].every(id => this.readyTracks.has(id))) { cleanup(); resolve(); }
      };
      this.readyWaiters.add(check);
      timer = setTimeout(() => { cleanup(); reject(new Error('The loop audio is taking too long to load. Stop and reopen the project to check its recordings.')); }, timeout);
      check();
    });
  }
  async listMicrophones() {
    const devices = globalThis.navigator?.mediaDevices;
    if (this.closed || typeof devices?.enumerateDevices !== 'function') return [];
    try {
      const available = await devices.enumerateDevices();
      return available.filter(device => device.kind === 'audioinput').map(device => ({ id: String(device.deviceId || ''), label: String(device.label || '') }));
    } catch { return []; }
  }
  async refreshMicrophones() {
    const generation = ++this.deviceListGeneration, devices = await this.listMicrophones();
    if (!this.closed && generation === this.deviceListGeneration) this.dispatchEvent(event('devices', { devices }));
    return devices;
  }
  watchMicrophones() {
    // Device enumeration never opens the microphone. Observe changes only after
    // an explicit successful access request, and retain no preference on disk.
    const target = globalThis.navigator?.mediaDevices;
    if (!this.deviceTarget && typeof target?.addEventListener === 'function') {
      this.deviceTarget = target; this.deviceListener = () => { void this.refreshMicrophones(); };
      target.addEventListener('devicechange', this.deviceListener);
    }
    void this.refreshMicrophones();
  }
  async enableMic(deviceId = '') {
    if (this.closed) throw abortError();
    if (!this.node) throw new Error('Enable the audio engine first.');
    const requestedDeviceId = typeof deviceId === 'string' ? deviceId : '';
    const currentIsLive = this.stream?.getAudioTracks().some(track => track.readyState === 'live');
    if (currentIsLive && this.selectedDeviceId === requestedDeviceId) {
      if (this.micPromise && this.pendingDeviceId !== requestedDeviceId) this.cancelPendingMic();
      return this.stream;
    }
    if (this.capture) throw new Error('Finish or cancel the recording before changing microphones.');
    if (this.micPromise && this.pendingDeviceId === requestedDeviceId) return this.micPromise;
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('Microphone access requires the HTTPS site and a supported browser.');
    if (this.micPromise) this.cancelPendingMic();
    const token = ++this.micGeneration;
    this.pendingDeviceId = requestedDeviceId;
    this.micPromise = (async () => {
      let stream, source;
      try {
        const audio = { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0.01 } };
        if (requestedDeviceId) audio.deviceId = { exact: requestedDeviceId };
        stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
        if (token !== this.micGeneration || this.closed) throw abortError();
        // A recording may have begun while a device request was pending.
        if (this.capture) throw new Error('Finish or cancel the recording before changing microphones.');
        if (!stream.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('The selected microphone did not provide a live audio input. Choose another microphone and try again.');
        source = this.context.createMediaStreamSource(stream); source.connect(this.node);
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => { if (this.stream === stream) {
            // A backing-only capture is independent of microphone availability.
            if (!this.loopMixCapture()) { this.send('interrupt', { reason: 'Microphone disconnected' }); this.dispatchEvent(event('device-lost', { message: 'The microphone disconnected. The recorded portion is retained.' })); }
            this.disableMic(); void this.refreshMicrophones();
          } });
          track.addEventListener('mute', () => { if (this.stream === stream && this.capture && !this.loopMixCapture()) { this.send('interrupt', { reason: 'Microphone muted by device' }); this.dispatchEvent(event('interrupted', { message: 'Microphone input was interrupted. The take was stopped to preserve its timing.' })); } });
        }
        const { groupId, ...settings } = stream.getAudioTracks()[0]?.getSettings?.() || {};
        // Keep the old graph alive until acquiring and connecting the replacement
        // has succeeded. A denied or unavailable choice must not destroy it.
        const previousStream = this.stream, previousSource = this.source;
        this.stream = stream; this.source = source; this.selectedDeviceId = requestedDeviceId;
        previousSource?.disconnect(); for (const track of previousStream?.getTracks() || []) track.stop();
        this.dispatchEvent(event('mic', { enabled: true, selectedDeviceId: requestedDeviceId, settings }));
        this.watchMicrophones();
        return stream;
      } catch (error) {
        source?.disconnect();
        if (stream) {
          for (const track of stream.getTracks()) track.stop();
        }
        if (token !== this.micGeneration || this.closed) throw abortError();
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') throw new Error('Microphone access was denied. Allow the microphone in this site’s browser settings, then try again.');
        if (error.name === 'NotFoundError') throw new Error('No microphone was found. Connect a microphone and try again.');
        if (error.name === 'NotReadableError') throw new Error('The microphone is busy or unavailable. Close another app using it and try again.');
        if (error.name === 'OverconstrainedError') throw new Error('The selected microphone is unavailable. Choose another microphone or System default, then try again.');
        throw error;
      } finally { if (token === this.micGeneration) { this.micPromise = null; this.pendingDeviceId = null; } }
    })();
    return this.micPromise;
  }
  cancelPendingMic() { ++this.micGeneration; this.micPromise = null; this.pendingDeviceId = null; }
  disableMic() {
    this.cancelPendingMic(); this.source?.disconnect(); this.source = null;
    const stream = this.stream; this.stream = null; for (const track of stream?.getTracks() || []) track.stop();
    this.send('configure', { monitor: false }); this.dispatchEvent(event('mic', { enabled: false, selectedDeviceId: this.selectedDeviceId, settings: {} }));
  }
  play() { this.send('play'); }
  pause() { this.send('pause'); }
  seek() { this.send('seek'); }
  cancelReadiness() { ++this.readinessGeneration; for (const check of this.readyWaiters) check(); }
  stop() { this.cancelPendingMic(); this.cancelReadiness(); this.send('stop'); }
  finish() { this.send('finish'); }
  cancel() { this.cancelPendingMic(); this.cancelReadiness(); this.send('cancel'); }
  loopMixCapture() { return this.capture?.kind === 'mix' || this.armingCapture?.kind === 'mix'; }
  arm(capture) { if (this.send('arm', { capture }) && !this.capture && !this.armingCapture) this.armingCapture = { id: capture.id, kind: capture.kind }; }
  clear() { this.cancelPendingMic(); this.cancelReadiness(); this.send('clear'); this.tracks.clear(); this.readyTracks.clear(); this.trackAssets.clear(); }
  async close() {
    if (this.closed) return; this.closed = true; this.disableMic(); this.suppressedStateChange = true;
    ++this.deviceListGeneration; this.deviceTarget?.removeEventListener?.('devicechange', this.deviceListener); this.deviceTarget = null; this.deviceListener = null;
    for (const check of this.readyWaiters) check();
    this.send('stop'); this.node?.disconnect(); this.node?.port.close();
    await this.context?.close().catch(() => {}); this.node = null; this.context = null; this.initPromise = null;
  }
}
