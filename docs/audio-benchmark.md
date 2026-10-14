# Audio engine benchmark

Run from the repository root with Node 24:

```sh
node --expose-gc scripts/benchmark-audio.mjs --seconds=60 --tracks=16,32
```

The script prints JSON. `--seconds` accepts 1–600; `--tracks` accepts a comma-separated list of 1–128 track counts. It has no performance pass/fail threshold. Functional tests remain the correctness gate.

## Workload

Each run plays 16 or 32 independently phased mono loops at 48 kHz in 128-frame render blocks. Sources last 17–47 seconds, cross storage-page boundaries, and wrap repeatedly. Every track uses high-pass filtering, three-band EQ, compression, pan, reverb and echo sends. Source peaks exceed the compressor threshold. A continuous vocal and stereo performance master are recorded together with 480-frame input compensation. Both captures must finish with exactly the requested frame count.

Storage is simulated with deterministic asynchronous page replies after 5–23 milliseconds of **audio time**. Pages are generated on demand; complete source recordings are never loaded. Writes transfer and recycle actual ArrayBuffers, verify order and sample validity, then discard the PCM. Playback caches and message queues remain bounded independently of song duration. The script measures the process, audio processing calls, generated I/O, resident cache bytes, sampled peak memory, reads, writes and reported underruns.

The two-second warm-up is excluded from body timing. Read/write counters include the compensated ending and storage finalization. Small dispatch costs are included in both DSP and generated-I/O timing, so those figures should not be summed. Peak memory is sampled every five audio seconds and after finalization; a shorter transient peak could be missed. RSS includes Node and allocator overhead; `--expose-gc` allows an additional retained-memory measurement.

## Local measurement, 2026-10-14

Measured in the development Linux container, Node v24.19.0, with the command above. These are accelerated Node results, not browser AudioWorklet deadlines, disk/OPFS throughput, physical microphone latency, phone performance, or supported maximum track-count guarantees. Shared host load and Node's JIT affect the timings. The exact cache allocation is a stronger invariant than RSS.

| 60-second workload | 16 tracks | 32 tracks |
| --- | ---: | ---: |
| Body wall time | 9.069 s | 20.195 s |
| Audio processing time | 6.770 s | 15.409 s |
| Processing time / audio duration | 11.3% | 25.7% |
| Generated I/O time | 2.257 s | 4.760 s |
| Playback cache allocation | 16 MiB | 32 MiB |
| Sampled peak RSS | 74.8 MiB | 109.5 MiB |
| Retained ArrayBuffers | 20.1 MiB | 36.1 MiB |
| Read pages | 2,697 | 5,376 |
| Read PCM | 167.7 MiB | 334.1 MiB |
| Written pages | 352 | 352 |
| Written PCM | 33.0 MiB | 33.0 MiB |
| Maximum pending simulated I/O | 146 | 306 |
| Underruns / engine errors | 0 / 0 | 0 / 0 |
| Frames per completed recording | 2,880,000 | 2,880,000 |

The benchmark exposed a real correctness defect before these measurements: page-number modulo slots allowed a wrapped read-ahead page to replace the currently playing final page for some loop lengths. A bounded least-recently-used rolling cache now retains the active reader; the four opening pages remain pinned, and twelve rolling pages remain preallocated. A deterministic asynchronous regression covers 53-page and 65-page loops through three complete wraps. The post-fix audio and renderer suites passed all 56 tests. No speculative DSP optimization or flaky timing gate was added.

## Long-session arithmetic

Additional deterministic engine tests start the transport and audio clock near 2³¹ and 2³² frames instead of allocating or playing hours of PCM. At 48 kHz these boundaries occur after approximately 12.4 and 24.9 hours. Continuous captures cross both boundaries with raw vocal and stereo master samples identical to a short-session reference at the same loop phase. Quantized section launches, multi-cycle recording endpoints, compensation, event timestamps and new loop offsets retain their exact frame values. A count-in crosses the 2³² audio-clock boundary while still establishing musical frame zero.

Separate seeded writer and page-cache tests verify capture totals beyond 2³² frames, writer page-index rollover across 2³², and distinct page tags beyond 2³² page indexes. Transport, clock, writer totals, page indexes and cache tags use JavaScript Numbers or Float64 storage, without bitwise 32-bit conversions. Uint32 cache lengths contain only a single page's frame count. All 49 engine tests pass after this addition.

These tests establish arithmetic behavior, not a day-long browser endurance result. Recording still depends on available device storage, continuing microphone permission, and the browser keeping its audio context running. Playback buffers, history rings, pending-page maps and queued vocal-control changes have fixed bounds; a further accelerated run was not needed to resolve a remaining memory-growth risk identified by inspection.

## Silent-tail DSP state

A focused follow-up measured an actual slow path after sound had become inaudible. On Node v24.19.0 / V8 13.6.233.17-node.51, Intel Xeon Platinum 8573C, recursive high-pass state settled near ±3.3 × 10⁻³²² and the compressor envelope near 1.54 × 10⁻³²⁰. These subnormal doubles persisted instead of becoming zero. Smoothed gains had the same problem after muting. Float32 reverb buffers also retained tiny values, but their benchmark showed no processing slowdown, so SharedFX was left unchanged.

The fix clears states below 10⁻³⁰, which is ten orders of magnitude below the existing 10⁻²⁰ filter-output floor. Filter state checks run only when the output is already below that floor; gain checks apply only when the target gain is exactly zero. Raw captured PCM does not pass through these state changes. Eight focused regressions cover natural decay, zero crossings, mute/volume/pan ramps, and a pre-change active EQ/compression reference trace.

The comparison used a default TrackDSP at 48 kHz. Each variant received ten seconds of a deterministic two-tone signal, then 120 seconds of silence for the tail cases. Three further ten-second rounds warmed the measured path. Nine timed rounds of 480,000 samples alternated baseline/current execution order. The table reports medians; setup and decay time are excluded.

| Workload | Before | After | Observation |
| --- | ---: | ---: | --- |
| Active signal | 29.30 ms | 27.40 ms | No measured regression |
| Decayed silent tail | 99.71 ms | 15.18 ms | 6.57× faster |
| Decayed muted tail | 158.34 ms | 20.89 ms | 7.58× faster |

Final outputs agreed in all three comparisons. The active reference test agrees within 10⁻¹². These local Node results establish a measured reason for the small change; they do not predict browser AudioWorklet scheduling, every CPU’s handling of subnormals, or a supported layer count. Host contention and JIT variation affect timings, so there is no performance test threshold.

Reproduce the workload with the current implementation alone:

```sh
node scripts/benchmark-dsp.mjs
```

To compare against the pre-flush DSP at commit `0e03767edc46330550778cc10844d8f1689b9b27`, extract that single module into a temporary `.mjs` file. The script imports it directly instead of containing a duplicate DSP implementation:

```sh
baseline_dsp="$(mktemp --suffix=.mjs)"
git show 0e03767edc46330550778cc10844d8f1689b9b27:src/audio/dsp.mjs > "$baseline_dsp"
node scripts/benchmark-dsp.mjs --baseline="$baseline_dsp"
rm "$baseline_dsp"
```

The script prints runtime/CPU details, every round, medians, and final recursive states as JSON. It preserves the measured workload; it was added after the measurements above, without another benchmark run.
