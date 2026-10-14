#!/usr/bin/env node
/**
 * Deterministic Node audio benchmark; no browser, microphone, disk or network.
 * Usage: node --expose-gc scripts/benchmark-audio.mjs --seconds=60 --tracks=16,32
 * Virtual storage delays are measured in AUDIO time, so the run is accelerated.
 * This measures the engine and bounded transfer protocol, not real-device latency.
 */
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { LoopEngine } from '../src/audio/loop-worklet.mjs';

const argumentsByName = Object.fromEntries(process.argv.slice(2).map(value => {
  const [key, ...rest] = value.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const seconds = Number(argumentsByName.seconds || 60);
const trackCounts = String(argumentsByName.tracks || '16,32').split(',').map(Number);
if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600 || trackCounts.some(value => !Number.isInteger(value) || value < 1 || value > 128)) {
  throw new Error('Use --seconds=1..600 and --tracks=1..128, separated by commas.');
}

const SAMPLE_RATE = 48000, PAGE_FRAMES = 16384, BLOCK_FRAMES = 128;
const rounded = number => Math.round(number * 1000) / 1000;
const megabytes = bytes => rounded(bytes / 1048576);

function cacheBytes(engine) {
  let bytes = 0;
  for (const group of engine.cacheGroups.values()) {
    for (const cache of group) for (const slot of cache.slots) bytes += slot.byteLength;
  }
  return bytes;
}

async function benchmark(trackCount) {
  let dspMs = 0, ioMs = 0, reads = 0, writes = 0, writeBytes = 0, copiedReadBytes = 0;
  let maxPending = 0, underruns = 0, errors = 0, sealed = 0, peakRss = 0, peakBuffers = 0;
  const queue = [], ready = new Set(), assets = new Map(), writers = new Map(), underrunExamples = [];
  const engine = new LoopEngine({ sampleRate: SAMPLE_RATE, pageFrames: PAGE_FRAMES, post(message) {
    if (message.type === 'track-ready') ready.add(message.id);
    else if (message.type === 'underrun') {
      underruns++;
      if (underrunExamples.length < 8) {
        const track = engine.tracks.get(message.id), slot = track?.cache.slot(message.index);
        underrunExamples.push({ id: message.id, frame: message.frame, page: message.index,
          totalPages: Math.ceil((track?.track.frames || 0) / PAGE_FRAMES), slot, slotContains: track?.cache.tags[slot] });
      }
    }
    else if (message.type === 'error') { errors++; process.stderr.write(`${message.message}\n`); }
    else if (message.type === 'asset-sealed') sealed++;
  } });
  const storage = {
    postMessage(message) {
      const t0 = performance.now();
      const ordinal = Number(message.assetId?.split('-').at(-1)) || 0;
      const latency = Math.round(SAMPLE_RATE * (5 + (ordinal * 7 + (message.index || 0) * 3) % 19) / 1000);
      let due = engine.clock + latency;
      if (message.type === 'write') {
        const writer = writers.get(message.assetId) || { frames: 0, pages: 0, lastDue: 0 };
        due = Math.max(due, writer.lastDue + 1); writer.lastDue = due;
        writers.set(message.assetId, writer);
        // Transfer, rather than copy, exactly as the real worklet MessagePort does.
        message = { ...message, buffer: structuredClone(message.buffer, { transfer: [message.buffer] }) };
      } else if (message.type === 'end') due = Math.max(due, (writers.get(message.assetId)?.lastDue || 0) + 1);
      queue.push({ due, message }); maxPending = Math.max(maxPending, queue.length);
      ioMs += performance.now() - t0;
    },
  };
  engine.command({ type: 'storage-port', port: storage });
  engine.command({ type: 'pool', buffers: Array.from({ length: 24 }, () => new ArrayBuffer(PAGE_FRAMES * 8)) });
  engine.command({ type: 'configure', baseFrames: SAMPLE_RATE * 4, masterVolume: .75, compensationFrames: 480 });

  for (let index = 0; index < trackCount; index++) {
    const frames = SAMPLE_RATE * (17 + index * 7 % 31) + 37 * index + 19;
    const assetId = `loop-${index}`;
    assets.set(assetId, { ordinal: index, frames });
    engine.command({ type: 'track', track: {
      id: `track-${index}`, assetId, frames, channels: 1,
      offsetFrames: (index * 17983) % frames, muted: false, solo: false,
      mix: { volume: .12, pan: ((index % 9) - 4) / 5, low: index % 5 - 2, mid: index % 3 - 1,
        high: index % 7 - 3, highpass: 55 + index % 4 * 15, compression: .6, reverb: .12, delay: .08 },
    } });
  }

  function serviceStorage() {
    const t0 = performance.now();
    // Ready messages are delivered in due order, preserving each writer's order.
    queue.sort((a, b) => a.due - b.due);
    while (queue.length && queue[0].due <= engine.clock) {
      const { message } = queue.shift();
      if (message.type === 'read') {
        const asset = assets.get(message.assetId);
        const frames = Math.min(PAGE_FRAMES, asset.frames - message.index * PAGE_FRAMES);
        if (frames <= 0) throw new Error('Benchmark requested audio outside its asset.');
        const pcm = new Float32Array(frames), start = message.index * PAGE_FRAMES;
        const frequency = 85 + asset.ordinal * 17, phaseStep = 2 * Math.PI * frequency / SAMPLE_RATE;
        for (let index = 0; index < frames; index++) {
          const position = start + index;
          const envelope = .35 + .65 * Math.exp(-(position % 12000) / 2300);
          // Peaks cross the compressor threshold; this exercises gain reduction,
          // EQ, pan and both sends instead of benchmarking mostly quiet bypasses.
          pcm[index] = envelope * (.3 * Math.sin(position * phaseStep) + .08 * Math.sin(position * phaseStep * 2.013));
        }
        reads++; copiedReadBytes += pcm.byteLength;
        engine.storageMessage({ type: 'page', assetId: message.assetId, index: message.index, frames, channels: 1, buffer: pcm.buffer });
      } else if (message.type === 'write') {
        const writer = writers.get(message.assetId);
        if (message.index !== writer.pages) throw new Error('Recording pages arrived out of order.');
        const pcm = new Float32Array(message.buffer, 0, message.frames * message.channels);
        for (const position of [0, Math.floor(pcm.length / 2), pcm.length - 1]) if (!Number.isFinite(pcm[position])) throw new Error('Non-finite recorded audio.');
        writer.pages++; writer.frames += message.frames; writes++; writeBytes += message.frames * message.channels * 4;
        engine.storageMessage({ type: 'written', assetId: message.assetId, index: message.index, frames: message.frames });
        engine.storageMessage({ type: 'recycle', buffer: structuredClone(message.buffer, { transfer: [message.buffer] }) });
      } else if (message.type === 'end') {
        const writer = writers.get(message.assetId);
        if (writer.frames !== message.frames) throw new Error('Final capture length does not match its pages.');
        engine.storageMessage({ type: 'sealed', assetId: message.assetId, frames: message.frames, status: message.status, finalized: true });
      }
    }
    ioMs += performance.now() - t0;
  }

  const input = new Float32Array(BLOCK_FRAMES), left = new Float32Array(BLOCK_FRAMES), right = new Float32Array(BLOCK_FRAMES);
  function block(count = BLOCK_FRAMES, measure = false) {
    serviceStorage();
    if (measure) for (let index = 0; index < count; index++) input[index] = Math.sin((engine.clock + index) * .019) * .025;
    else input.fill(0);
    const t0 = performance.now();
    engine.process(input.subarray(0, count), left.subarray(0, count), right.subarray(0, count));
    if (measure) dspMs += performance.now() - t0;
  }
  while (ready.size < trackCount) {
    block();
    if (engine.clock > SAMPLE_RATE * 2) throw new Error('Benchmark tracks did not become ready.');
  }
  engine.command({ type: 'play' });
  // A brief unmeasured warm-up permits JIT compilation and fills signal history.
  for (let count = 0; count < SAMPLE_RATE * 2; count += BLOCK_FRAMES) block(BLOCK_FRAMES, true);
  engine.command({ type: 'arm', capture: {
    id: 'benchmark-vocal', kind: 'vocal', assetId: 'vocal', masterAssetId: 'master', quantized: false, lengthFrames: 0,
    track: { id: 'benchmark-vocal', mix: { volume: .8, highpass: 75, compression: .3, reverb: .1, delay: .04 } },
  } });
  globalThis.gc?.();
  const before = process.memoryUsage();
  dspMs = 0; ioMs = 0; reads = 0; writes = 0; writeBytes = 0; copiedReadBytes = 0;
  peakRss = before.rss; peakBuffers = before.arrayBuffers;
  const started = performance.now(), totalFrames = Math.round(seconds * SAMPLE_RATE);
  for (let processed = 0; processed < totalFrames; processed += BLOCK_FRAMES) {
    block(Math.min(BLOCK_FRAMES, totalFrames - processed), true);
    if (processed % (SAMPLE_RATE * 5) < BLOCK_FRAMES) {
      const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakBuffers = Math.max(peakBuffers, memory.arrayBuffers);
      // Yield only to the Node microtask queue; no sleep and no real-time pacing.
      await Promise.resolve();
    }
  }
  const elapsedMs = performance.now() - started;
  engine.command({ type: 'stop' });
  const endDeadline = engine.clock + SAMPLE_RATE * 2;
  while ((engine.capture || queue.length || sealed < 2) && engine.clock < endDeadline) block();
  if (engine.capture || queue.length || sealed !== 2) throw new Error('Benchmark capture did not finalize.');
  const afterRun = process.memoryUsage(); peakRss = Math.max(peakRss, afterRun.rss); peakBuffers = Math.max(peakBuffers, afterRun.arrayBuffers);
  globalThis.gc?.();
  const retained = process.memoryUsage();
  return {
    tracks: trackCount, sampleRate: SAMPLE_RATE, audioSeconds: seconds, capture: 'mono vocal + stereo master',
    wallMs: rounded(elapsedMs), dspMs: rounded(dspMs), generatedIoMs: rounded(ioMs),
    dspFractionOfRealtime: rounded(dspMs / (seconds * 1000)), wallFractionOfRealtime: rounded(elapsedMs / (seconds * 1000)),
    cacheMiB: megabytes(cacheBytes(engine)), cacheConsumers: [...engine.cacheGroups.values()].reduce((sum, group) => sum + group.size, 0),
    peakRssMiB: megabytes(peakRss), initialRssMiB: megabytes(before.rss), retainedRssMiB: megabytes(retained.rss),
    peakArrayBuffersMiB: megabytes(peakBuffers), retainedArrayBuffersMiB: megabytes(retained.arrayBuffers),
    readPages: reads, readMiB: megabytes(copiedReadBytes), writePages: writes, writtenMiB: megabytes(writeBytes),
    maxPendingIo: maxPending, underruns, underrunExamples, errors, sealedAssets: sealed,
    vocalFrames: writers.get('vocal').frames, masterFrames: writers.get('master').frames,
  };
}

const results = [];
for (const count of trackCounts) results.push(await benchmark(count));
process.stdout.write(JSON.stringify({
  benchmark: 'Feed the Music Loop — accelerated Node DSP and bounded transfer benchmark',
  node: process.version, platform: process.platform, architecture: process.arch, cpuModel: cpus()[0]?.model,
  forcedGcAvailable: typeof globalThis.gc === 'function',
  storageModel: 'Generated PCM pages; deterministic asynchronous 5–23 ms audio-time latency; real buffer transfers; no disk persistence.',
  timingScope: 'Wall/DSP time covers the body after a 2-second warm-up. I/O and page counters include the final compensated drain. Dispatch time overlaps DSP and I/O; do not sum them.',
  limitation: 'These are local Node measurements, not browser, physical microphone, mobile, or OPFS performance guarantees.',
  results,
}, null, 2) + '\n');
