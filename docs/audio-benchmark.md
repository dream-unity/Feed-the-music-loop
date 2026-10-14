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
