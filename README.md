# Feed the Music Loop

A vocal looper and song studio that runs entirely in your browser. Record a beat with your voice, loop it, add layers, sing a full lead over the groove, and shape the result into a song.

**Website:** [dream-unity.github.io/Feed-the-music-loop](https://dream-unity.github.io/Feed-the-music-loop/)

## Make your first song

1. Open the studio over HTTPS and use headphones. Wired headphones avoid the extra delay common with Bluetooth.
2. Under **New loop length**, keep **Free** to finish when ready, or choose **Custom duration** and enter seconds. Choose **Add loop** and allow microphone access. The finished first loop sets your song's base cycle.
3. Add another loop using free length, custom seconds or a chosen number of cycles. Recording starts immediately by default; choose **Next cycle** explicitly when you want to enter on the groove's boundary. Your existing layers keep playing.
4. Choose **Sing over loops** and sing for as long as you need. Finish when you are done. The studio keeps the separate vocal and a stereo recording of the complete performance.
5. Open **Mix → Layers & vocals** to adjust individual sounds. Use **Songs & recordings**, or a recording's **Mix & master** button, to select a saved performance, loop-only song, vocal, loop or imported recording and render a separate mastered WAV.
6. Save sections such as an intro and chorus, and launch them at cycle boundaries while performing. Use the Song view to audition takes, export the original performance, or render an edited mix.
7. Download a **project backup** regularly. It contains your project and original audio and can be restored on another supported browser or device.

The built-in demo creates a few synthetic layers locally, so you can try the studio without granting microphone access.

The [recording guide](docs/recording-guide.md) walks through timing, clean input, sections, mixing and choosing the right export. [Verification notes](docs/verification.md) describe the automated checks and a short test for your own microphone and headphones.

## What is included

- Free-length or custom timed loops, including the first recording; optional cycle multiples for synchronized lengths. Duration and start preferences are saved with the project.
- Optional click and four- or eight-beat first-loop count-in. The click follows your loop's subdivisions and stays out of the recorded mix.
- Microphone input selection for built-in, USB and headset inputs after permission is granted. Switching is blocked during recording and keeps the previous input if the replacement fails.
- Separate continuous lead recordings while loops play.
- An original stereo master for each vocal performance, alongside editable vocal audio and timestamped arrangement events.
- Sample-frame transport, loop boundaries and queued section changes in an `AudioWorklet`.
- Separate Play, Pause and Stop controls. Pause holds the current position; Stop returns the transport and every loop to the beginning so they restart together.
- Live audition of a selected lead with the current mixer, plus the original performance player.
- Individual layer mute, solo, naming, color, timing adjustment and reversible role presets.
- Waveform editing for every loop: select precise moments, trim, shorten or extend with repeats/silence, and copy a selection into the same or another track. Each edit saves a separate audio version and supports session Undo/Redo.
- Per-layer and vocal processing, shared room/echo effects and a master safety soft ceiling.
- Whole-recording mix/master controls for saved songs, performances and imported audio: gain, stereo balance, EQ, low cut, linked compression, sample-peak normalization and output ceiling. Preview any moment against the original and save separately named WAV versions beside their source.
- Project undo/redo, saved sections, audio import, local projects and autosave.
- Discarded takes release their audio storage after the project is safely saved; failed cleanup remains visible with a retry action.
- Top-right Storage file manager: measured audio/cache file sizes across all projects, estimated remaining recording space, per-file downloads and confirmed permanent deletion.
- Chunked audio storage, crash recovery, incomplete-take recovery and protection against two tabs editing the same project.
- Lossless 32-bit float WAV exports and portable checksummed `.fml` project archives.
- Edited-song rendering in a worker, with progress and cancellation.
- Desktop and touch layouts, keyboard shortcuts, reduced-motion support and accessible native dialogs.
- Installable app shell and offline reopening after the published app has been cached. Updates wait until existing studio tabs close.

## Audio and recording behavior

Audio runs on the browser's audio rendering thread. Interface redraws do not set loop timing. The engine uses actual render-block lengths rather than assuming every block contains 128 frames.

**Pause** holds the current playback position, including a recording preview; **Play/Resume** continues from there. **Stop** silences playback, rewinds loaded players and resets each live loop to its first sample. The next Play starts those loop beginnings together. Saved audio and the timing inside earlier recorded performances stay intact. Each loop retains its own duration, so different-length loops still complete their repeats at different times. While recording, Pause is unavailable; Stop saves the captured portion and returns playback to zero, while **Finish recording** saves it and lets the groove continue.

New projects and older projects without recording preferences default to free length and an immediate start. A two-second demo cycle does not limit new recordings. Custom seconds are rounded to the nearest audio sample; choosing a cycle count makes the duration that many times the existing base cycle. **Finish recording** can end either kind early. **Next cycle** controls only when recording starts, and the optional first-loop count-in works for both free and timed loops. With a ready microphone, immediate capture starts on the next audio render block after preparation; first-use permission, hardware startup and deliberate recording compensation remain separate from that setting.

Microphone input is recorded separately from the loop mix. Playback is not captured through the microphone intentionally: headphones prevent speaker bleed. Monitoring is off by default because software monitoring adds device latency and speakers can feed back.

The manual recording-offset control compensates input/output delay by aligning captured audio with the backing transport. It does not remove physical headphone latency. Device latency varies; test a short beat and adjust the offset before an important session. Changing Bluetooth devices or audio routes can change timing.

The original stereo performance is the authoritative record of what the engine rendered during that take. An edited mix reconstructs the stored arrangement with the chosen sound settings. Its finite effect warm-up and tail mean it is not promised to be bit-identical to a long-running live effects state.

Whole-recording mastering processes the saved audio once through its original duration, preserving its mono/stereo channels. The controls affect the complete recording; **Remix individual layers** uses an available recorded arrangement to change its separate parts. Mastered versions never replace the source. Preview uses the same whole-recording peak analysis as the full export, retaining at most 20 seconds of preview audio from the chosen position.

The live soft ceiling prevents uncontrolled output peaks. The separate recording master applies a constant gain after processing to keep its measured sample peak within the chosen ceiling; optional peak normalization also raises quiet material to that ceiling. This is sample-peak processing, not LUFS normalization or a true-peak limiter. There is no pitch correction, independent pitch/time stretching or cloud collaboration hidden behind the controls.

## Storage, privacy and recovery

There is no audio-upload endpoint, account, analytics SDK or external font. The published static application is delivered by GitHub Pages; your recordings are processed and saved in your browser's storage for that site.

On supported browsers, audio pages are written into the Origin Private File System (OPFS); IndexedDB holds project metadata and page checkpoints. An IndexedDB audio fallback is available when synchronous OPFS access is unavailable. Data is not considered committed until both its bytes and checkpoint have been written. An interrupted recording exposes the intact saved prefix for recovery.

If recovery cannot save its checkpoint because storage is full or a metadata transaction fails, the existing project opens read only with a persistent recovery warning. Finished recordings remain available to download, and Manage storage remains accessible. Free space, then choose **Retry recovery**. Recording, edits and autosave stay blocked until recovery succeeds. A failed storage worker or unreadable project metadata still requires reopening the studio; this mode does not claim that unfinished audio has been finalized.

If a published recording is missing or only a shorter verified portion survives, the studio preserves the original loop lengths, take timing and performance history. Song shows a persistent incomplete-audio notice and offers any sealed surviving portion as an explicitly `-incomplete.wav` download. Playback and reconstruction that require the damaged source are blocked; unaffected original stereo recordings remain available. A complete `.fml` backup cannot be created from missing audio. Restore an earlier valid backup to recover the complete song.

Browser storage is not a substitute for a backup. Clearing site data, removing a browser profile, private browsing, operating-system pressure or quota exhaustion can remove or interrupt local projects. Request persistent storage in the app and download `.fml` backups. Backup import validates the archive and audio checksums before publishing a new project; it does not overwrite the current project.

**Storage**, at the top right, lists recordings from every project, retained and unfinished audio, unindexed audio files, and this studio’s offline app cache. Search or filter the list, download a recording from its row, or permanently delete an individual file after confirmation. Deleting referenced audio removes its dependent loop/take/performance references and clears current Undo/Redo so deleted audio cannot be resurrected; unrelated source files stay intact. A project used in another tab must be closed there first. Per-file audio deletion requires Web Locks for safe coordination.

The summary distinguishes measured audio payload bytes, cached response-body bytes, encoded metadata size, and browser-reported origin usage/limit. Browser capacity is an estimate, not an exact free-disk measurement: it can include other apps on the same origin, and privacy protections, compression and overhead affect it. Unavailable measurements stay unknown. A low estimate is advisory and no longer blocks recording by itself; actual write failures still stop capture safely.

The Projects and settings section shows each project’s measured audio footprint, including retained data from removed projects. Deleting a project requires confirmation, closes its audio session, refuses another tab's active project lock and removes only that project's recordings. Confirmed deletion can free full storage without first creating another project. If deletion stops partway, the affected project stays read only with playback disabled; Manage storage lets you retry, including after reopening. Deleting the current closed session also discards its unfinished recordings. Back up a song before permanently deleting it.

Saved edited mixes can also be deleted individually after confirmation. The app refuses to remove audio still referenced by the project or undo history; the original loops, vocal takes and captured performances remain available.

If saving project metadata fails, downloads of already sealed recordings remain available. The save error stays visible; an exported file does not mean the device save succeeded. Discarding a take removes its audio only after the capture intent has been removed from the saved project. If that cleanup fails, the Song view offers a clearly labeled retry.

Recording duration is limited by device storage, CPU and browser behavior, rather than an arbitrary short timer. The live engine reads bounded page windows rather than loading an entire recording into an `AudioBuffer`. More simultaneous layers still require more memory and processing. The project format guards against excessive metadata and permits up to 512 loop tracks; that is a format ceiling, not a claim that every device can play 512 effects-heavy tracks.

Very large arrangements also have a metadata budget. If extensive mixer automation approaches that budget, the studio finishes the performance before the project becomes too large to reopen. Original recorded audio remains available; if an arrangement event could not be retained, the editable render is limited to its verified prefix and labeled accordingly. Undo keeps up to 40 steps within a 16 MiB metadata budget, so large projects can have fewer undo steps. Live capture checkpoints are never duplicated into undo history.

Ordinary audio-file import is limited to 128 MiB and 20 minutes because browser decoding needs a full buffer. Direct microphone recording uses the streaming path. Standard RIFF WAV has a 4 GiB size limit; exceptionally long exports are split into numbered WAV parts. A dialog for that recording provides every numbered part; save each one to retain the complete recording. Ordinary WAV downloads stay with the corresponding loop, take, performance or saved mix. Retained recordings are available on demand in Storage, without a running file list in the workspace. The IndexedDB fallback exports recordings larger than 128 MiB as numbered WAV parts, reading at most 64 MiB per part. Full `.fml` backups and original-performance previews still require each fallback audio asset to fit within 128 MiB; save the numbered original WAVs if a long fallback recording exceeds that limit.

Keep the app foregrounded for reliable recording on phones. Mobile operating systems can suspend audio when the screen locks or another app takes the microphone. A wake lock is requested where supported; it cannot override operating-system suspension. Interrupted takes are marked accordingly.

## Browser support

Use a recent Chromium-based desktop browser for the primary workflow. The application requires a secure context, microphone permission and `AudioWorklet`. The code includes feature detection and an IndexedDB storage fallback; platform behavior still differs. Safari/iOS, Bluetooth routing, background recording and physical-device latency need hands-on testing on your specific device.

Automated browser checks use Chromium with a deterministic synthetic microphone, including sustained recording beyond the initial transfer-buffer pool. Firefox and WebKit checks run the generated demo through worklet playback, mixer export, native Float32 WAV playback, reload and exact backup restoration. These verify application behavior and exported audio, not the quality or latency of a real microphone or an untested phone.

## Publish on GitHub Pages

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.
3. The **Audio and browser checks** workflow runs on `main`. After it succeeds, **Publish studio to GitHub Pages** packages and deploys that exact commit.
4. For an already verified commit, the publishing workflow can also be run manually from Actions.

The build preserves the repository subpath, packages only public app assets, and generates an atomic, revisioned offline cache. Each cached file must match its packaged SHA-256 integrity value, so incomplete or mixed-version updates leave the prior working studio available. Repository documentation, tests and development scripts are not included in the Pages artifact.

Use the GitHub Actions source setting to make publication follow the browser checks. GitHub's alternative branch publishing can publish repository files immediately on a push, before those checks or the packaged offline build finish. The publishing workflow also checks the exact deployed service-worker fingerprint and exercises recording and WAV export against the live HTTPS site.

## Development and verification

The app has no runtime package dependencies and uses native ES modules. Node.js 22 or newer is used for checks and packaging.

```sh
npm run check
npm test
npm run build
```

The output is `_site/`. Serve that directory from a secure origin or localhost for development; opening `index.html` as a `file:` URL cannot provide microphone and worker behavior correctly.

`npm test` exercises audio boundaries and compensation, page caches, DSP state, capture lifecycle, storage journals and recovery, project validation, checksummed backup import/export, WAV output, worker rendering and controller races. GitHub Actions additionally runs pinned Playwright Chromium tests at the `/Feed-the-music-loop/` path, covering microphone capture, layering, vocals, export, project reopening, backups, storage locks and touch layout. CI uploads its browser report and screenshots.

Core modules:

| Path | Responsibility |
| --- | --- |
| `src/audio/` | Audio-thread loop engine, DSP and microphone lifecycle |
| `src/storage/` | Worker-backed audio pages, checkpoints, locks and recovery |
| `src/export/` | WAV, `.fml` archives and edited-mix rendering |
| `src/project.mjs` | Validated project model, sections and history |
| `src/controller.mjs` | Recording, project and UI integration |
| `src/ui/` | Responsive studio interface |

The [audio architecture notes](docs/audio-architecture.md) explain the engine clock, capture lifecycle and invariants to preserve when changing the studio.

The archive layout and validation rules are documented in [`src/export/FORMAT.md`](src/export/FORMAT.md).

A reproducible [audio benchmark](docs/audio-benchmark.md) covers independently phased long loops, delayed page delivery and simultaneous vocal/master recording, with measured results and their limits.

Implementation references include the [Web Audio specification](https://webaudio.github.io/web-audio-api/), [AudioWorklet processing rules](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process), the [File System standard](https://fs.spec.whatwg.org/), [output latency semantics](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency), [microphone enumeration](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices) and [GitHub Pages deployment documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
