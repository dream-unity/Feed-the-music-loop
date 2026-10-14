import { PAGE_FRAMES, clone, roleMix } from '../project.mjs';

const abortError = () => Object.assign(new Error('Recording request cancelled.'), { name: 'AbortError' });
const event = (type, detail) => new CustomEvent(type, { detail });

/** Main-thread device lifecycle. Sample scheduling and mixing belong to the worklet. */
export class AudioEngine extends EventTarget {
  constructor(storage) {
    super(); this.storage = storage; this.context = null; this.node = null; this.stream = null; this.source = null;
    this.micGeneration = 0; this.initPromise = null; this.tracks = new Map(); this.playing = false; this.frame = 0;
    this.capture = null; this.closed = false; this.requestId = 0; this.micPromise = null; this.projectId = null;
    this.suppressedStateChange = false;
    this.readyTracks = new Set(); this.readyWaiters = new Set(); this.trackAssets = new Map(); this.readinessGeneration = 0;
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
    const resumed = this.context.resume();
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
  async resume() { if (this.context && this.context.state !== 'running') await this.context.resume(); }
  onMessage(message) {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'meter' || message.type === 'state') {
      this.playing = !!message.playing; this.frame = message.transportFrame ?? this.frame; this.capture = message.capture ?? null;
    }
    if (message.type === 'capture-end') this.capture = null;
    if (message.type === 'track-ready' && (!message.assetId || this.trackAssets.get(message.id) === message.assetId)) { this.readyTracks.add(message.id); for (const check of this.readyWaiters) check(); }
    this.dispatchEvent(event(message.type, message));
  }
  send(type, detail = {}, transfer = []) {
    if (!this.node) return false;
    this.node.port.postMessage({ type, requestId: ++this.requestId, ...detail }, transfer); return true;
  }
  configure(project) {
    this.send('configure', { baseFrames: project.baseFrames, compensationFrames: Math.round(project.input.compensationMs * project.sampleRate / 1000), inputGain: project.input.gain,
      monitor: project.input.monitor, masterVolume: project.master.volume, inputMix: project.input.mix || roleMix('lead') });
  }
  syncTracks(tracks) {
    const ids = new Set(tracks.map(t => t.id));
    for (const id of this.tracks.keys()) if (!ids.has(id)) { this.send('remove-track', { id }); this.tracks.delete(id); this.readyTracks.delete(id); this.trackAssets.delete(id); }
    for (const track of tracks) {
      const serialized = JSON.stringify(track);
      if (this.trackAssets.get(track.id) !== track.assetId) this.readyTracks.delete(track.id);
      this.trackAssets.set(track.id, track.assetId);
      if (this.tracks.get(track.id) !== serialized) { this.send('track', { track: clone(track) }); this.tracks.set(track.id, serialized); }
    }
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
  async enableMic() {
    if (!this.node) throw new Error('Enable the audio engine first.');
    if (this.stream?.getAudioTracks().some(t => t.readyState === 'live')) return this.stream;
    if (this.micPromise) return this.micPromise;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires the HTTPS site and a supported browser.');
    const token = ++this.micGeneration;
    this.micPromise = (async () => {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: { ideal: 0.01 } }, video: false });
        if (token !== this.micGeneration || this.closed) { for (const track of stream.getTracks()) track.stop(); throw abortError(); }
        this.stream = stream; this.source = this.context.createMediaStreamSource(stream); this.source.connect(this.node);
        for (const track of stream.getAudioTracks()) {
          track.addEventListener('ended', () => { if (this.stream === stream) { this.send('interrupt', { reason: 'Microphone disconnected' }); this.dispatchEvent(event('device-lost', { message: 'The microphone disconnected. The recorded portion is retained.' })); this.disableMic(); } });
          track.addEventListener('mute', () => { if (this.stream === stream && this.capture) { this.send('interrupt', { reason: 'Microphone muted by device' }); this.dispatchEvent(event('interrupted', { message: 'Microphone input was interrupted. The take was stopped to preserve its timing.' })); } });
        }
        this.dispatchEvent(event('mic', { enabled: true, settings: stream.getAudioTracks()[0]?.getSettings?.() || {} }));
        return stream;
      } catch (error) {
        if (stream) {
          if (this.stream === stream) { this.source?.disconnect(); this.source = null; this.stream = null; }
          for (const track of stream.getTracks()) track.stop();
        }
        if (token !== this.micGeneration) throw abortError();
        if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') throw new Error('Microphone access was denied. Allow the microphone in this site’s browser settings, then try again.');
        if (error.name === 'NotFoundError') throw new Error('No microphone was found. Connect a microphone and try again.');
        if (error.name === 'NotReadableError') throw new Error('The microphone is busy or unavailable. Close another app using it and try again.');
        throw error;
      } finally { if (token === this.micGeneration) this.micPromise = null; }
    })();
    return this.micPromise;
  }
  cancelPendingMic() { ++this.micGeneration; this.micPromise = null; }
  disableMic() {
    this.cancelPendingMic(); this.source?.disconnect(); this.source = null;
    const stream = this.stream; this.stream = null; for (const track of stream?.getTracks() || []) track.stop();
    this.send('configure', { monitor: false }); this.dispatchEvent(event('mic', { enabled: false }));
  }
  play() { this.send('play'); }
  cancelReadiness() { ++this.readinessGeneration; for (const check of this.readyWaiters) check(); }
  stop() { this.cancelPendingMic(); this.cancelReadiness(); this.send('stop'); }
  finish() { this.send('finish'); }
  cancel() { this.cancelPendingMic(); this.cancelReadiness(); this.send('cancel'); }
  arm(capture) { this.send('arm', { capture }); }
  clear() { this.cancelPendingMic(); this.cancelReadiness(); this.send('clear'); this.tracks.clear(); this.readyTracks.clear(); this.trackAssets.clear(); }
  async close() {
    if (this.closed) return; this.closed = true; this.disableMic(); this.suppressedStateChange = true;
    for (const check of this.readyWaiters) check();
    this.send('stop'); this.node?.disconnect(); this.node?.port.close();
    await this.context?.close().catch(() => {}); this.node = null; this.context = null; this.initPromise = null;
  }
}
