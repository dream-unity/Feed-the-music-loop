import { LoopEngine } from '../audio/loop-worklet.mjs';

const BLOCK_FRAMES = 128;
const PAGE_FRAMES = 16384;
const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

/** Render with the live DSP implementation, preserving its state across pages.
 * All IO is injected so this runs in a dedicated Worker and deterministic tests.
 * No complete recording, offline AudioBuffer or full output is held in memory. */
export async function renderMixFrames(plan, { readPage, writePage, onProgress, signal } = {}) {
  const reads = new Map();
  let failure = null;
  const engine = new LoopEngine({ sampleRate: plan.sampleRate, pageFrames: PAGE_FRAMES, post: message => {
    if (message.type === 'error' || message.type === 'underrun') failure ??= new Error(message.message || `A recording page was unavailable at frame ${message.frame}.`);
  } });
  engine.storage = { postMessage: message => {
    if (message.type !== 'read') return;
    const key = `${message.assetId}:${message.index}`;
    if (reads.has(key)) return;
    const pending = Promise.resolve().then(() => readPage(message.assetId, message.index)).then(page => {
      if (!page || !(page.buffer instanceof ArrayBuffer)) throw new Error('A recording page could not be read.');
      engine.receivePage({ ...page, type: 'page', assetId: message.assetId, index: message.index });
    }).catch(error => { failure ??= error; }).finally(() => reads.delete(key));
    reads.set(key, pending);
  } };
  const drainReads = async () => {
    while (reads.size) await Promise.all([...reads.values()]);
    if (failure) throw failure;
  };
  const check = () => { signal?.throwIfAborted(); if (failure) throw failure; };
  const currentTracks = new Map(plan.currentTracks.map(track => [track.id, track]));
  const configure = {
    type: 'configure', baseFrames: plan.baseFrames, masterVolume: plan.masterVolume,
    compensationFrames: 0, inputGain: 1, monitor: true, inputMix: plan.vocalMix,
  };
  engine.command(configure);
  engine.command({ type: 'spotlight', active: plan.spotlight });
  engine.frame = plan.startFrame - plan.prerollFrames;
  engine.sourceEndFrame = plan.startFrame + plan.bodyFrames;
  for (const track of plan.tracks) engine.command({ type: 'track', track });
  engine.command({ type: 'play' });
  await drainReads();
  check();
  const input = new Float32Array(BLOCK_FRAMES), left = new Float32Array(BLOCK_FRAMES), right = new Float32Array(BLOCK_FRAMES);
  let output = new Float32Array(PAGE_FRAMES * 2), outputOffset = 0, outputIndex = 0, writtenFrames = 0;
  let voicePage = null, voicePageIndex = -1, eventIndex = 0, processed = 0, lastProgress = 0;
  const totalFrames = plan.prerollFrames + plan.bodyFrames + plan.tailFrames;
  const events = plan.events;

  function apply(event) {
    const type = event.type === 'command' ? event.command : event.type === 'automation' ? event.action : event.type;
    if (type === 'section' && event.section) {
      const section = structuredClone(event.section);
      if (plan.mode === 'current') {
        for (const [id, state] of Object.entries(section.tracks || {})) {
          const track = currentTracks.get(id) || engine.tracks.get(id)?.track;
          if (track) state.mix = { ...track.mix };
        }
      }
      engine.applySection(section);
    } else if (type === 'mix') {
      engine.command({ type: 'mix', id: event.id, ...(plan.mode === 'performance' && event.mix ? { mix: event.mix } : {}), ...(typeof event.muted === 'boolean' ? { muted: event.muted } : {}), ...(typeof event.solo === 'boolean' ? { solo: event.solo } : {}) });
    } else if (type === 'track' && event.track) {
      // The current mix overrides sound controls, not the performed entrance.
      // A later edit to the track's mute/solo state must not rewrite the state
      // it had when it entered the recorded arrangement.
      const current = currentTracks.get(event.track.id);
      const track = plan.mode === 'current' && current
        ? { ...current, muted: !!event.track.muted, solo: !!event.track.solo }
        : plan.mode === 'performance' ? event.track : null;
      if (track) {
        if (!engine.tracks.has(track.id) && engine.tracks.size >= 512) throw new Error('The recorded arrangement has too many simultaneous tracks.');
        engine.command({ type: 'track', track });
      }
    } else if (type === 'remove-track') engine.command({ type: 'remove-track', id: event.id });
    else if (type === 'spotlight') engine.command({ type: 'spotlight', active: !!event.active });
    else if (type === 'configure' && plan.mode === 'performance') {
      // Capture already includes input gain and timing compensation. Reapplying
      // those would amplify and shift the dry vocal a second time.
      const command = { type: 'configure' };
      if (Number.isFinite(event.masterVolume)) command.masterVolume = event.masterVolume;
      if (Number.isFinite(event.baseFrames)) command.baseFrames = event.baseFrames;
      if (event.inputMix) command.inputMix = event.inputMix;
      engine.command(command);
    }
  }

  const flush = async () => {
    if (!outputOffset) return;
    await writePage(outputIndex++, output.buffer, outputOffset, 2);
    writtenFrames += outputOffset;
    output = new Float32Array(PAGE_FRAMES * 2); outputOffset = 0;
  };

  while (processed < totalFrames) {
    check();
    while (eventIndex < events.length && events[eventIndex].frame <= engine.frame) apply(events[eventIndex++]);
    engine.prefetch();
    await drainReads();
    check();
    const relative = engine.frame - plan.startFrame;
    let count = Math.min(BLOCK_FRAMES, totalFrames - processed);
    if (relative < 0) count = Math.min(count, -relative);
    else if (relative < plan.bodyFrames) count = Math.min(count, plan.bodyFrames - relative);
    if (eventIndex < events.length && events[eventIndex].frame > engine.frame) count = Math.min(count, events[eventIndex].frame - engine.frame);
    input.fill(0);
    if (plan.vocal && relative >= 0 && relative < Math.min(plan.vocal.frames, plan.bodyFrames)) {
      const index = Math.floor(relative / PAGE_FRAMES), offset = modulo(relative, PAGE_FRAMES);
      if (voicePageIndex !== index) {
        const page = await readPage(plan.vocal.assetId, index);
        if (!page || page.channels !== 1 || !(page.buffer instanceof ArrayBuffer)) throw new Error('The dry vocal recording page is invalid.');
        voicePage = new Float32Array(page.buffer, 0, page.frames); voicePageIndex = index;
      }
      count = Math.min(count, voicePage.length - offset, plan.vocal.frames - relative);
      if (count <= 0) throw new Error('The dry vocal recording ends before its declared length.');
      input.set(voicePage.subarray(offset, offset + count));
    }
    engine.process(input.subarray(0, count), left.subarray(0, count), right.subarray(0, count));
    check();
    if (relative >= 0) {
      for (let i = 0; i < count; i++) {
        // The optional natural tail ends with a 20 ms taper so cutting a long
        // delay/reverb feedback tail cannot create an abrupt final click.
        const remaining = plan.bodyFrames + plan.tailFrames - (relative + i);
        const fadeFrames = Math.min(plan.tailFrames, Math.round(plan.sampleRate * .02));
        const gain = fadeFrames ? Math.min(1, Math.max(0, (remaining - 1) / fadeFrames)) : 1;
        output[outputOffset * 2] = left[i] * gain; output[outputOffset * 2 + 1] = right[i] * gain;
        if (++outputOffset === PAGE_FRAMES) await flush();
      }
    }
    processed += count;
    const now = globalThis.performance?.now() || Date.now();
    if (now - lastProgress > 150 || processed === totalFrames) {
      lastProgress = now;
      onProgress?.({ phase: relative < 0 ? 'warming' : relative < plan.bodyFrames ? 'rendering' : 'tail', completedFrames: processed, totalFrames, outputFrames: writtenFrames + outputOffset });
    }
  }
  await flush();
  await drainReads();
  check();
  if (writtenFrames !== plan.bodyFrames + plan.tailFrames) throw new Error('The rendered song length is inconsistent.');
  return { frames: writtenFrames, bodyFrames: plan.bodyFrames, tailFrames: plan.tailFrames, prerollFrames: plan.prerollFrames, sampleRate: plan.sampleRate, channels: 2 };
}
