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

## What the checks establish

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
