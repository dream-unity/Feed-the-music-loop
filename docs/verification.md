# Verification and real-device checks

The studio is tested at three levels: deterministic audio/storage tests, automated browsers, and a recording/export check against the deployed GitHub Pages website. These checks complement a short test on the microphone and headphones you plan to use.

## Earlier verified release

Application commit: [`4db2fd8d53f31e300663d16904b4330b74d5340c`](https://github.com/dream-unity/Feed-the-music-loop/commit/4db2fd8d53f31e300663d16904b4330b74d5340c).

On 14 October 2026, **374 Node tests and 19 browser scenarios passed on their first attempt**:

- [Audio and browser checks](https://github.com/dream-unity/Feed-the-music-loop/actions/runs/38498768475): 374 Node tests, 14 Chromium scenarios, two HTTPS/offline scenarios and two Firefox/WebKit scenarios.
- [Pages deployment and public-site verification](https://github.com/dream-unity/Feed-the-music-loop/actions/runs/38498987666): packaged and published the checked application, then recorded, looped, saved and exported audio from the public HTTPS site.

The deployment check compared the exact packaged service-worker SHA-256 before and after the live recording:

```text
658cc36e5705beb8298662ddcbb7239571c532b7b9d9caee455b619c610e0cb2
```

Browser reports, screenshots and failure traces are uploaded by the workflows with 14-day retention. The tests themselves remain in the repository and can be run again after those artifacts expire.

## Storage manager verification

Studio 2026.10.15.2 adds a top-right Storage dialog and removes the estimate-only recording block. Its regression suite measures native audio and cache payload bytes, deletes confirmed files, reloads saved manifests, verifies surviving audio, and keeps failed measurements unknown. Chromium scenarios include cancelled confirmations, active previews, another tab’s writer lock, unindexed OPFS files and IndexedDB pages, cache ownership, phone/tablet controls, and low or unavailable quota estimates. Firefox and WebKit additionally delete a restored loop and verify the original project’s PCM hash is unchanged.

The WebKit test environment uses IndexedDB and cannot inspect OPFS. The test requires the specific inspection limitation, an unknown overall audio total, and exact known-file byte reclamation; it never treats an unknown total as zero. Node tests cover changed confirmations, failed manifest writes, failed physical deletion, shared references, pending writes, Undo/Redo, incomplete scans and preflight refusals. The public deployment check opens Storage and verifies the captured audio row and offline app files after recording and downloading real WAVs.

Browser usage, quota and remaining recording time are estimates. File rows report measured PCM or cached-response bytes; metadata reports encoded size. These are intentionally not described as exact physical disk allocation. The app cannot inspect downloaded files or other apps’ private storage.

## Track editor verification

The editor checks selected intervals as integer, half-open sample ranges. Deterministic tests compare trimmed, repeated, silence-extended, inserted and replaced audio against exact expected PCM, including page boundaries, single-sample ranges, self-paste and mono/stereo combinations. An independent seeded oracle checks 120 additional combinations against a direct sample-array implementation. The renderer keeps bounded source and output pages rather than allocating an entire edited recording. Waveform tests place transients across the whole source, verify time-proportional bins and ensure cancellation stops the scan without modifying audio.

Controller tests verify immediate durable saves, stable track IDs and groove timing, Undo/Redo, unchanged source audio, clipboard selection races, cancelled edits, capture/read-only exclusions and interrupted work. A failed save must leave the original working track and history intact. A lost acknowledgement is reconciled against the saved manifest; if neither the acknowledgement nor manifest can establish what was saved, further writes pause and both audio versions are retained. The suite also verifies that a handled save failure does not prevent a later retry.

The portable browser scenario runs in Chromium, Firefox and WebKit. It edits deterministic stored audio through the interface, compares PCM hashes, previews a selection, pastes within the source and into another track, changes lengths, reloads the project, checks its backup and preserves original audio. Responsive checks cover editor controls on narrow screens. The public-site scenario additionally trims and pastes a real recorded source, downloads the result and compares its exact samples with the expected concatenation.

Original recorded performances remain independent of later loop edits. Export tests verify that current-sound rendering uses edited audio while original-performance rendering retains its historical sources. These checks establish sample selection and persistence; they do not promise click-free creative splice points or a particular musical result. Playback retains the studio's existing loop-edge taper, while saved PCM keeps the selected samples unchanged. Selection preview is limited to 32 MiB; full edits stream up to 24 hours subject to available storage.

## Saved-recording mix and master verification

The recording master processes saved mono or stereo assets independently of loop playback. Tests compare neutral, gain-only and balance-only output sample by sample, including anti-phase stereo and page boundaries. Linked dynamics, EQ, measured sample ceilings, normalization, silence and non-finite source rejection have deterministic checks. Full renders preserve duration and channels and never modify the source. Processing uses bounded audio pages in a worker.

Preview tests compare a chosen interval against the same interval of a full render, including the compression/filter history before that interval and peak analysis over the whole recording. Original comparison bypasses processing. Preparing and cancelling previews must create no stored audio assets; output failure or cancellation must remove only the unfinished new master. Tests also cover changed source bytes between processing passes and worker/direct-render agreement.

Controller and archive tests cover separate source settings, capture/read-only guards, selection races, save failures, recording imports, settings and provenance after backup restoration, and keeping finished versions reachable if a download fails. Browser scenarios select performances, loop-only songs and other saved audio, compare stereo exports, change source, reopen saved settings, restore backups and exercise narrow-screen controls. The public-site check applies a known gain to an actual captured loop song, verifies every exported sample in both channels and confirms the original download is unchanged.

The final-level controls measure sample peaks. They do not measure LUFS or reconstructed true peaks, and test success is not a judgement of a recording's artistic balance. Preview is limited to 20 seconds from a chosen position; full mastering streams recordings up to 24 hours, subject to storage and processing time.

## What the checks establish

Studio 2026.10.26.1 separates Pause from Stop. Deterministic transport checks compare paused/resumed PCM with uninterrupted playback, including effects and metronome state. Stop checks cover unequal loop lengths and nonzero saved offsets, compensation tails, queued commands, preview positions and recording endpoints. Runtime reset offsets must not alter saved source timing; export checks compare the captured arrangement and subsequent timing edits against expected samples.

The portable browser transport scenario checks held and reset playheads, keyboard Pause/Resume, native recording previews and simultaneous stereo loop openings after Stop. It also verifies that stopping an active capture preserves its duration and that phone transport controls remain accessible. Different-length loops still repeat at their own lengths; resetting makes their first samples start together.

Studio 2026.10.18.2 adds free, custom-second and cycle-based loop durations with independent immediate or next-cycle starts. Deterministic tests verify the first captured sample, exact timed lengths across render-block sizes, timed first-loop count-in, early Finish with compensation, and provisional playback before a durable seal. Controller tests cover invalid durations before microphone access, saved preferences and delayed storage estimates that must not delay recording.

The Chromium scenario records a 3.25-second first loop, verifies its exact saved frame count, starts another recording away from a cycle boundary with an already connected microphone, continues free recording beyond two seconds, and ends an eight-second preset early. It measures click-to-recording-state time against a 500 ms regression threshold and retains that measurement in the report. This detects the former deliberate cycle wait; it is not a hardware-latency guarantee. The public-site check also records an exact 3.25-second first loop and verifies the immediate/free defaults before selecting its duration.

| Area | Evidence | Boundary of the result |
| --- | --- | --- |
| Looping and capture | Sample-boundary tests and Chromium microphone capture, synchronized layers, continuous vocals and separate stereo recordings | The automated microphone supplies deterministic audio; it does not measure an actual microphone's sound or delay |
| Audible editing | Controller, client and worklet integration tests; a browser test measures the actual output when Undo/Redo restores a recording, mute or removal | This establishes changes in the audio graph, not a listener's preference for the mix |
| Saved audio | Native OPFS recording/reload tests, IndexedDB fallback checks, journal/checksum tests and exact backup restoration | Available space and eviction behavior remain device dependent |
| Interrupted or damaged audio | Failed-write, recovery and partial-deletion tests; a browser deliberately truncates a saved source, preserves its original timing and downloads only its verified surviving prefix | Recovery cannot recreate audio that was never saved or whose bytes are gone |
| Exports | WAV headers and sample data, original masters, arrangement rendering, bounded reads, cancellation, multipart output and archive corruption tests | Very large exports are tested with bounded fixtures and arithmetic; this is not a physical multi-day recording |
| Other browsers | Firefox and WebKit play the generated demo, render a mix, play exported WAV, reload and restore exact backup audio | This does not establish Safari/iOS microphone behavior or permission handling on a phone |
| Touch layout | Chromium screenshots and checks for narrow layouts and usable recording controls | Responsive emulation does not reproduce phone audio routing, heat or operating-system suspension |
| Offline updates | HTTPS tests reopen the cached studio with saved audio and reject incomplete or mixed-version updates | The first complete app load requires a connection; browser storage can still be cleared or evicted |
| Public deployment | Exact packaged worker fingerprint, secure context, live capture/loop/save/WAV export and checks for unexpected requests | This is a deployment check at a point in time, not an availability guarantee |

Long-loop performance measurements and their limits are recorded separately in [audio-benchmark.md](audio-benchmark.md). Accelerated Node measurements are not browser deadline or phone-capacity guarantees.

## A short check on your recording setup

Before an important session:

1. Use your intended browser, microphone and headphones. Connect the microphone and confirm that the input meter responds. Record and download a short test before investing time in a song.
2. Record a simple, steady beat. Add a second matching layer and listen for unwanted doubling. Adjust **Recording compensation** in small steps for subsequent recordings if the new layer sounds late. **Mix → Timing** can nudge an existing layer. A new audio route may require a different setting.
3. Sing over two or three loops. Finish the take, then compare its original stereo performance with its separate vocal. The vocal should not intentionally include the backing; loudspeakers can still leak into any microphone.
4. Try the effects and layer count you expect to use. Listen for gaps, distortion or missed starts. Reduce the workload if your particular device cannot sustain it.
5. Download a project backup, reopen the studio and verify the saved song. Restore the backup as a separate project once so you know the complete save/restore workflow.

For phone use, also check what happens when another app takes audio focus or the screen locks. Keep the studio foregrounded while recording. A wake lock cannot prevent every operating-system interruption. Test Bluetooth devices separately: changing the route can change delay even when the app settings stay the same.

## Repeating the automated checks

With Node.js 22 or newer:

```sh
npm run check
npm test
npm run build
```

The GitHub Actions workflows install pinned Playwright tooling and browser binaries, provide the test microphone and audio output device, and run the browser suites. Their YAML files are the reproducible instructions for those environments. A failed check should be investigated using its report and trace; a passing retry alone does not explain a failure.

Select **Settings → Pages → Build and deployment → Source → GitHub Actions** for publication to follow the verification workflow. Branch publishing can run independently before the checked package is ready. The current website has already passed the custom deployment and live verification workflow.
