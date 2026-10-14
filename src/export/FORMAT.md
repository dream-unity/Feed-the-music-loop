# Portable project format, version 1

`.fml` is an uncompressed binary archive. It contains no executable code, extracted
filesystem paths, remote audio URLs or credentials. Original Float32 recordings,
stereo performances, project metadata and sealed recovery recordings are included.

The 64-byte little-endian header is:

| Offset | Bytes | Meaning |
| --- | --- | --- |
| 0 | 8 | ASCII `FMLPACK` followed by LF |
| 8 | 4 | Format version, currently 1 |
| 12 | 4 | Header length, currently 64 |
| 16 | 8 | Unsigned manifest byte length |
| 24 | 8 | Unsigned total PCM payload byte length |
| 32 | 32 | SHA-256 of the UTF-8 manifest bytes |

The manifest follows immediately, then contiguous audio payloads. Each manifest
asset declares `id`, `sampleRate`, `channels`, `frames`, `encoding: "f32le"`,
`pageFrames: 16384`, `offset`, `bytes`, `sha256`, `status`, `name` and `kind`.
Optional `captureId`, `leadAssetId`, `performanceId` and `track` retain recovery
pairing and sound settings. Audio references in these fields are validated and
remapped together with project references during import.
Offsets are relative to the beginning of the PCM payload region. They must be
contiguous in manifest order, with no holes, overlaps or trailing data. Asset
length is exactly `frames × channels × 4`; mono and stereo are supported.

Checksums detect corruption; they do not authenticate the archive's author.
Before exporting a WAV or backup, production storage verifies journal checksums
in ranges of at most 4 MiB and compares those bytes with the exact File snapshot
included in the download. A same-size changed snapshot, short read or damaged
page rejects the export. Verification is cancellable between reads, does not
cache results across exports, and never allocates a whole-song audio buffer.
File-backed numbered WAVs verify each part immediately before offering it;
range-backed fallback parts already verify their journal pages while reading.
Only trusted in-memory test adapters may omit the `getAssetRange` verification
interface; both production storage backends provide it.
Import rejects unsupported versions, oversized/deep metadata, duplicate or unsafe
IDs, missing references, invalid lengths, mismatched sample rates, NaN/Infinity
samples, and damaged checksums before creating any recordings. It reads PCM in
bounded chunks. Import allocates fresh project/audio IDs, preserves project-local
track/take/section/performance IDs, and commits project metadata only after every
new audio asset seals successfully. Failed writes remove only the new import.
Interrupted performances retain every intact dry and stereo stream even when
their lengths differ. `editableFrames` records the shared editable interval;
the original recording assets are never shortened to that interval.

WAV export uses IEEE Float32 format 3 with an 18-byte `fmt ` chunk, `fact` sample
count, and original interleaved audio. It does not destructively normalise or
quantise samples. File-backed Blob parts avoid a second full audio buffer where
the browser storage backend supports them. `exportWavParts` splits recordings
larger than classic RIFF's limit at complete sample frames. Devices using the
IndexedDB fallback enforce the storage module's explicit per-file export limit.

## Edited song rendering

`renderEditedMix` creates a new stereo recording with the same `LoopEngine` and
DSP used during live playback. A dedicated module worker reads source pages and
writes 16,384-frame output pages. Effect state continues between pages; output
never passes through a whole-song `AudioBuffer`. Cancellation waits for pending
storage writes before removing the new render.

The default `current` mode applies the present track/vocal sound settings while
retaining the selected performance's entrances, removals, mute/solo changes,
sections and Spotlight movement. Recorded fader/EQ movements are overridden by
the current sound settings. `performance` mode instead reconstructs the original
mixer snapshot and replays its recorded sound changes. A selected dry vocal is
fed once, with capture gain and timing compensation already baked into its audio.

Both modes preserve original loop phase and place events at their exact saved
sample frames. Default effect warm-up is five seconds; a two-second natural tail
ends with a 20 ms taper. These durations can be set from zero to ten seconds.
Warm-up reconstructs loop effect history but cannot recover earlier, unrecorded
microphone history. The captured stereo master remains the exact live recording.
Interrupted performances render only their verified shared editable interval;
their longer intact source recordings remain available in the archive and WAV
exports. An individual rendering job supports up to 24 hours and can be cancelled.
