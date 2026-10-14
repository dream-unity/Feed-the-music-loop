#!/usr/bin/env node
/** Focused accelerated Node benchmark; no audio device, storage or network. */
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as current from '../src/audio/dsp.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/benchmark-dsp.mjs [--baseline=/path/to/old-dsp.mjs]');
  process.exit(0);
}
if (args.length > 1 || args.some(arg => !arg.startsWith('--baseline=') || !arg.slice('--baseline='.length))) {
  throw new Error('Use an optional --baseline=/path/to/old-dsp.mjs.');
}
const baselinePath = args[0] ? resolve(args[0].slice('--baseline='.length)) : null;
const modules = baselinePath
  ? [['baseline', await import(pathToFileURL(baselinePath).href)], ['current', current]]
  : [['current', current]];
for (const [name, module] of modules) if (typeof module.TrackDSP !== 'function') throw new Error(`${name} module does not export TrackDSP.`);

const SAMPLE_RATE = 48000, MEASURED_FRAMES = 480000, ROUNDS = 9, DECAY_SECONDS = 120;
const samples = Float32Array.from({ length: MEASURED_FRAMES }, (_, i) => .65 * Math.sin(i * .037) + .13 * Math.sin(i * .113));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const workload of ['active', 'silent tail', 'muted tail']) {
  const runners = [];
  for (const [version, module] of modules) {
    const dsp = new module.TrackDSP(SAMPLE_RATE);
    // Independent call sites keep an optional second module from changing this
    // benchmark into a polymorphic-dispatch test. No DSP code is duplicated.
    const run = new Function('dsp', 'samples', 'count', 'audible', `
      /* ${version}: ${workload} */
      let output = 0;
      for (let i = 0; i < count; i++) output = dsp.process(samples ? samples[i % samples.length] : 0, audible);
      return output;
    `);
    run(dsp, samples, MEASURED_FRAMES, true);
    if (workload !== 'active') run(dsp, null, SAMPLE_RATE * DECAY_SECONDS, workload !== 'muted tail');
    for (let warmup = 0; warmup < 3; warmup++) run(dsp, workload === 'active' ? samples : null, MEASURED_FRAMES, workload !== 'muted tail');
    runners.push({ version, dsp, run, times: [] });
  }
  for (let round = 0; round < ROUNDS; round++) {
    for (const runner of round % 2 ? [...runners].reverse() : runners) {
      const started = performance.now();
      runner.run(runner.dsp, workload === 'active' ? samples : null, MEASURED_FRAMES, workload !== 'muted tail');
      runner.times.push(performance.now() - started);
    }
  }
  const measurements = Object.fromEntries(runners.map(({ version, dsp, times }) => [version, {
    medianMs: median(times), roundsMs: times, finalOutput: { left: dsp.left, right: dsp.right },
    finalState: { envelope: dsp.envelope, gainL: dsp.gainL, gainR: dsp.gainR, filters: dsp.filters.map(filter => [filter.z1, filter.z2]) },
  }]));
  results.push({ workload, measurements, ...(baselinePath ? {
    currentToBaselineRatio: measurements.current.medianMs / measurements.baseline.medianMs,
    speedup: measurements.baseline.medianMs / measurements.current.medianMs,
    finalOutputDifference: Math.max(Math.abs(measurements.current.finalOutput.left - measurements.baseline.finalOutput.left), Math.abs(measurements.current.finalOutput.right - measurements.baseline.finalOutput.right)),
  } : {}) });
}
console.log(JSON.stringify({
  benchmark: 'TrackDSP active signal and decayed silent state', node: process.version, v8: process.versions.v8,
  platform: process.platform, architecture: process.arch, cpuModel: cpus()[0]?.model, baselinePath,
  sampleRate: SAMPLE_RATE, measuredFramesPerRound: MEASURED_FRAMES, rounds: ROUNDS, decaySeconds: DECAY_SECONDS,
  warmup: '10 seconds active, then 120 seconds decay for tail cases, then three unmeasured 10-second rounds.',
  limitations: 'Accelerated Node timings only; no browser deadline or supported-device guarantee. Shared host load and JIT affect results. No timing pass/fail threshold.',
  results,
}, null, 2));
