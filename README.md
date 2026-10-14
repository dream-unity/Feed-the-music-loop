# Feed the Music Loop

A vocal looper and song studio that runs entirely in your browser. Record a beat with your voice, loop it, add layers, sing a full lead over the groove, and shape the result into a song.

**Website:** [dream-unity.github.io/Feed-the-music-loop](https://dream-unity.github.io/Feed-the-music-loop/)

## Make your first song

1. Open the studio over HTTPS and use headphones. Wired headphones avoid the extra delay common with Bluetooth.
2. Choose **Add loop**. Allow microphone access, perform your first beat, then finish the loop. Its length becomes your song's base cycle.
3. Add another loop. Choose a cycle length to keep layers aligned, or an independent length for evolving patterns. Your existing layers keep playing.
4. Choose **Sing over loops** and sing for as long as you need. Finish when you are done. The studio keeps the separate vocal and a stereo recording of the complete performance.
5. Open **Mix** to adjust level, pan, low/mid/high EQ, low cut, compression, room reverb and echo. Try the Beat, Bass, Harmony, Lead and Texture starting points, then fine-tune them.
6. Save sections such as an intro and chorus, and launch them at cycle boundaries while performing. Use the Song view to audition takes, export the original performance, or render an edited mix.
7. Download a **project backup** regularly. It contains your project and original audio and can be restored on another supported browser or device.

The built-in demo creates a few synthetic layers locally, so you can try the studio without granting microphone access.

## What is included

- Free-length first loop; additional synchronized or independent loops.
- Optional click and four- or eight-beat first-loop count-in. The click follows your loop's subdivisions and stays out of the recorded mix.
- Microphone input selection for built-in, USB and headset inputs after permission is granted. Switching is blocked during recording and keeps the previous input if the replacement fails.
- Separate continuous lead recordings while loops play.
- An original stereo master for each vocal performance, alongside editable vocal audio and timestamped arrangement events.
- Sample-frame transport, loop boundaries and queued section changes in an `AudioWorklet`.
- Live audition of a selected lead with the current mixer, plus the original performance player.
- Individual layer mute, solo, naming, color, timing adjustment and reversible role presets.
- Per-layer and vocal processing, shared room/echo effects and a master safety soft ceiling.
- Project undo/redo, saved sections, audio import, local projects and autosave.
- Per-project storage usage, deletion of saved edited mixes, and explicit permanent project deletion to free device space.
- Chunked audio storage, crash recovery, incomplete-take recovery and protection against two tabs editing the same project.
- Lossless 32-bit float WAV exports and portable checksummed `.fml` project archives.
- Edited-song rendering in a worker, with progress and cancellation.
- Desktop and touch layouts, keyboard shortcuts, reduced-motion support and accessible native dialogs.
- Installable app shell and offline reopening after the published app has been cached. Updates wait until existing studio tabs close.

## Audio and recording behavior

Audio runs on the browser's audio rendering thread. Interface redraws do not set loop timing. The engine uses actual render-block lengths rather than assuming every block contains 128 frames.

Microphone input is recorded separately from the loop mix. Playback is not captured through the microphone intentionally: headphones prevent speaker bleed. Monitoring is off by default because software monitoring adds device latency and speakers can feed back.

The manual recording-offset control compensates input/output delay by aligning captured audio with the backing transport. It does not remove physical headphone latency. Device latency varies; test a short beat and adjust the offset before an important session. Changing Bluetooth devices or audio routes can change timing.

The original stereo performance is the authoritative record of what the engine rendered during that take. An edited mix reconstructs the stored arrangement with the chosen sound settings. Its finite effect warm-up and tail mean it is not promised to be bit-identical to a long-running live effects state.

The soft ceiling prevents uncontrolled output peaks, but is not a certified true-peak mastering limiter. There is no pitch correction, independent pitch/time stretching, LUFS mastering or cloud collaboration hidden behind the controls.

## Storage, privacy and recovery

There is no audio-upload endpoint, account, analytics SDK or external font. The published static application is delivered by GitHub Pages; your recordings are processed and saved in your browser's storage for that site.

On supported browsers, audio pages are written into the Origin Private File System (OPFS); IndexedDB holds project metadata and page checkpoints. An IndexedDB audio fallback is available when synchronous OPFS access is unavailable. Data is not considered committed until both its bytes and checkpoint have been written. An interrupted recording exposes the intact saved prefix for recovery.

Browser storage is not a substitute for a backup. Clearing site data, removing a browser profile, private browsing, operating-system pressure or quota exhaustion can remove or interrupt local projects. Request persistent storage in the app and download `.fml` backups. Backup import validates the archive and audio checksums before publishing a new project; it does not overwrite the current project.

**Manage storage** shows each project's audio footprint. Deleting a project requires confirmation, pauses playback, refuses another tab's active project lock and removes only that project's recordings. A partial deletion can be retried. Back up a song before permanently deleting it.

Saved edited mixes can also be deleted individually after confirmation. The app refuses to remove audio still referenced by the project or undo history; the original loops, vocal takes and captured performances remain available.

Recording duration is limited by device storage, CPU and browser behavior, rather than an arbitrary short timer. The live engine reads bounded page windows rather than loading an entire recording into an `AudioBuffer`. More simultaneous layers still require more memory and processing. The project format guards against excessive metadata and permits up to 512 loop tracks; that is a format ceiling, not a claim that every device can play 512 effects-heavy tracks.

Ordinary audio-file import is limited to 128 MiB and 20 minutes because browser decoding needs a full buffer. Direct microphone recording uses the streaming path. Standard RIFF WAV has a 4 GiB size limit; exceptionally long exports are split into numbered WAV parts. Every part remains available as a separate download link; save each one to retain the complete recording. The latest eight export groups remain linked until the page closes. The IndexedDB fallback cannot assemble a single export asset over 128 MiB and reports that limit rather than exhausting memory.

Keep the app foregrounded for reliable recording on phones. Mobile operating systems can suspend audio when the screen locks or another app takes the microphone. A wake lock is requested where supported; it cannot override operating-system suspension. Interrupted takes are marked accordingly.

## Browser support

Use a recent Chromium-based desktop browser for the primary workflow. The application requires a secure context, microphone permission and `AudioWorklet`. The code includes feature detection and an IndexedDB storage fallback; platform behavior still differs. Safari/iOS, Bluetooth routing, background recording and physical-device latency need hands-on testing on your specific device.

Automated browser checks use Chromium with a deterministic synthetic microphone. Firefox and WebKit checks run the generated demo through native playback, mixer export, reload and exact backup restoration. These verify application behavior and exported audio, not the quality or latency of a real microphone or an untested phone.

## Publish on GitHub Pages

1. In this repository, open **Settings → Pages**.
2. Under **Build and deployment**, choose **GitHub Actions** as the source.
3. The **Audio and browser checks** workflow runs on `main`. After it succeeds, **Publish studio to GitHub Pages** packages and deploys that exact commit.
4. For an already verified commit, the publishing workflow can also be run manually from Actions.

The build preserves the repository subpath, packages only public app assets, and generates an atomic, revisioned offline cache. Repository documentation, tests and development scripts are not included in the Pages artifact.

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

The archive layout and validation rules are documented in [`src/export/FORMAT.md`](src/export/FORMAT.md).

A reproducible [audio benchmark](docs/audio-benchmark.md) covers independently phased long loops, delayed page delivery and simultaneous vocal/master recording, with measured results and their limits.

Implementation references include the [Web Audio specification](https://webaudio.github.io/web-audio-api/), [AudioWorklet processing rules](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process), the [File System standard](https://fs.spec.whatwg.org/), [output latency semantics](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/outputLatency), [microphone enumeration](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/enumerateDevices) and [GitHub Pages deployment documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
