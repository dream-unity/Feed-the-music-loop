# Make a song with your voice

Start with a short groove, then build around it. Your loop layers, continuous vocal takes and recorded stereo performances stay separate, so you can change the sound without singing everything again.

1. **Get a clean input.**

   Open the studio, connect wired headphones and choose **Connect mic**. Allow microphone access. Under **Timing & recording**, **Microphone input** lets you choose an available input after permission is granted.

   Perform your loudest intended sound while watching **Mic level**. Adjust **Input gain** so ordinary peaks leave room below 0 dB; around −12 to −6 dB is a useful starting point. If the sound is already distorted, sing farther from the microphone or reduce its input level; lowering a recorded layer afterwards cannot repair distortion captured at the microphone.

   Leave **Hear my mic** off initially. Your voice still records, and you hear the backing through your headphones. Enable it only if you want software monitoring and its delay feels comfortable. Headphones help keep the backing out of each new recording.

2. **Make your first loop.**

   Choose **Add loop**, perform a beat, hum or phrase, then choose **Finish recording** where the phrase should repeat. The first loop is always free length: your finish sets the base cycle. Listen through several repetitions before adding more.

   For preparation time, open **Timing & recording → Click & count-in**, set **Tempo**, and choose **4 beats** or **8 beats** under **First-loop count-in** before recording. **Play a reference click** adds a guide through your headphones; it stays out of the internal recording. The count-in does not set the first loop’s ending. Once a loop exists, the click follows its length and **Beats per cycle**; changing that setting does not stretch the recording.

3. **Add layers that fit.**

   Under **New loop length**, choose **1 cycle · stay in sync**, **2 cycles**, **4 cycles**, or **Custom cycles**. Choose **Add loop**, wait for the next cycle, and perform. These recordings finish automatically after the chosen length. **Finish at boundary** retains that scheduled ending. **Cancel** discards the current attempt while your existing groove continues.

   Choose **Free · finish when ready** for an independent length. Different lengths gradually change their relationship, which can be interesting for textures but less predictable for a tight beat. For a first song, keep percussion aligned and try longer cycles for bass or harmony.

4. **Check timing before a long session.**

   With wired headphones and **Hear my mic** off, record a short, sharp syllable along with a clear existing beat. Listen to whether the new syllable repeatedly lands late or early. Repeat the experiment: your own performance timing varies, so one hit is not a measurement.

   If several attempts are consistently late, increase **Recording compensation** under **Timing & recording** by a small amount, such as 5–10 ms, then undo the test layer and record another. If the result becomes early, reduce the value. This is a practical adjustment by ear, not automatic calibration. It affects newly captured audio and does not remove headphone latency or retime old recordings. Existing loop layers have **−5 ms** and **+5 ms** adjustments in **Mix**. Recheck after changing the microphone, headphones or audio route.

5. **Sing a continuous vocal.**

   Choose **Sing over loops**. With an established groove, recording starts at the next cycle while the backing keeps its place. Sing through as many cycles as you need, then choose **Finish recording**. The loops continue while the studio finishes saving.

   **Song** keeps both a **Vocal take** and its full stereo **Performance**. Another take preserves earlier takes without automatically playing them into the new backing. Select **Use in edited song** for the vocal you want to remix. **Turn into a loop** deliberately creates another repeating layer from a take.

   Use the trash button beside a performance to remove it from the list. Confirm **Remove performance**, or cancel to keep it. **Undo** restores it during the current session. The separate vocal take, its recorded arrangement and audio stay available for remixing; removal is saved across reloads and does not free device storage.

6. **Perform sections.**

   In **Build**, arrange the layers and their mix, choose **Save section**, and name it Intro, Verse or Chorus. Save another combination for the next part. A section recalls its saved layers and sound settings; a layer added afterwards is absent from the older section.

   While singing, tap section pads to queue changes at the next cycle boundary. These changes become part of that performance’s recorded arrangement. Saving section names alone does not create a song sequence: launch them during the performance you want to preserve.

7. **Shape the mix.**

   Open **Mix** and choose a layer or vocal at the top; narrow screens use the **Selected sound** menu. Start with **Volume**: lower backing that hides the lead. Keep bass and lead near the centre; use **Pan** to give harmonies some separation. **Starting sound** offers Beatbox, Bass, Harmony, Lead and Atmosphere presets as editable starting points.

   Raise **Low cut** gently to remove unwanted rumble, stopping before the voice loses body. Make small changes to **Warmth · low EQ**, **Body · mid EQ** and **Air · high EQ**, listening with the whole song. Add modest **Punch · compression** for uneven levels, then a little **Space · reverb** or **Echo · delay**. Too much can blur consonants and rhythm. Leave room at **Master volume**. The output soft ceiling is protection, not certified mastering.

8. **Hear and export the version you mean.**

   **Export → Hear current mix** auditions the selected vocal with the layers as they are now; it does not replay the section sequence. **Render WAV**, under **Current sound, recorded arrangement**, follows the selected take’s recorded entrances, mutes, solos and section changes using your current sound settings. It adds a short effect tail. Download and listen to that render when checking the complete revised arrangement.

   **Recorded performances** downloads the original stereo capture, preserving the performed sound and changes. Later mixer or loop edits do not rewrite it. In **Mix**, **Download original vocal** keeps the separate vocal, while **Download layer WAV** keeps the current layer, including any audio edits. These downloads exclude playback effects; captured input gain remains part of the audio.

9. **Keep a copy outside the browser.**

   Wait for saving to finish, then choose **Download project backup** regularly. The `.fml` file keeps the working project and audio; use **Projects → Restore backup** to reopen it as a separate project. **Protect local storage** requests extra browser protection, but is not a backup. The top-right **Storage** button opens every studio recording and offline app file, with measured file sizes, an estimate of remaining recording space, downloads and permanent deletion.

   Long recordings depend on available storage and device performance. If an export produces numbered WAV parts, download every part before closing the page. Some browser storage fallbacks cannot preview or bundle very large individual recordings; keep their numbered original WAVs when prompted.

   On a phone, keep the studio visible and the screen awake. Calls, screen locking or another app taking the microphone can interrupt a take. Test a short complete recording and export on your device first. If an interruption occurs, follow the recovery notice and listen to the retained audio before relying on it.

## Mix and master a saved song or recording

Open **Mix → Songs & recordings**. You can also choose **Mix & master** beside a saved performance, vocal take, latest recording or saved mix. Choose the recording you want: loop-only songs and vocal performances use their saved stereo audio, so their complete recorded sound is available even when their arrangement cannot be reconstructed.

Use **Input gain**, **Balance**, the three EQ bands, **Low cut** and **Compression** to shape the whole recording. Stereo channels remain separate; compression uses a linked response to retain their relationship. These controls do not change the source file or the separate loop mixer.

Set a **Sample peak ceiling** for the new version. The studio reduces the overall level if the processed audio would exceed that ceiling. Enable **Normalize peak** if you also want quieter material raised to the ceiling. This measures sample peaks; it does not target a streaming service's LUFS value or measure reconstructed true peaks.

Set **Preview from** to the moment you want to check, then compare the original with the processed preview. Each preview covers up to 20 seconds and does not create a saved recording. The processed preview scans the whole recording first so normalization matches the full export; long songs can take time, and you can cancel preparation. After changing a control, prepare another preview to hear the new settings.

Give the version a name and render its new WAV. The complete result keeps the original duration and channels. Its own Listen and WAV controls appear with that recording's versions, and it also remains available in **Song → Saved mixes** after reopening. Each new render is independent, so you can keep several versions and compare them. Downloads remain beside the specific recording.

If the performance has a retained editable arrangement, **Remix individual layers** opens its loops and vocal controls. The arrangement target stays identified above the mixer; rendering follows that performance's recorded entrances, mutes and section changes with the current sound settings. This also works for recordings made with **Record all the loops**. Use whole-recording processing when you want to shape the saved sound directly.

**Import recording** brings an external song into this area without turning it into a loop. It preserves mono or stereo audio and converts its sample rate to the project's rate. The import limit is 128 MiB and 20 minutes because decoding uses a full audio buffer. A previously imported file that was converted to mono cannot regain its original stereo channels; import the original stereo file here for a stereo master.

## Edit a loop or reuse a selected moment

Choose **Edit** on a loop card, or **Edit audio** for a loop in **Mix**. The studio stops playback and reads the whole track to display its waveform; longer recordings can take a moment. Finish or discard an active recording before opening the editor.

- **Keep only a moment:** drag across the waveform, or enter **Selection start** and **Selection end** in seconds. **Listen to selection** checks the chosen audio. **Trim to selection** makes that interval the whole loop.
- **Shorten or lengthen:** enter **New length**, then choose **Set length**. A shorter length removes audio from the end. For a longer length, **Repeat this track** repeats its existing audio up to the requested ending; **Add silence** preserves the audio and adds a silent ending. Playback speed and pitch stay the same.
- **Copy part of a loop:** select the desired interval and choose **Copy selection**. Use **Track to edit** to choose the destination, including the original loop. The copied interval stays fixed even if you subsequently edit the source.
- **Insert copied audio:** choose **Insert at cursor**, tap the waveform or enter **Paste position**, then choose **Paste**. Audio after the cursor moves later, so the loop becomes longer. A cursor at the track ending appends the copied audio.
- **Replace a moment:** select the destination interval, choose **Replace selection**, then **Paste**. The copied audio replaces that interval; later audio follows it. The resulting length depends on the difference between the selected interval and the copied interval.

The editor shows the resulting paste length before you apply it. Times are rounded to the nearest audio sample; a selection includes its starting sample and stops just before its ending sample. You can also focus either waveform selection handle and use the arrow keys to move it one sample at a time.

Each edit saves immediately. **Undo** and **Redo** restore earlier versions during the current session; **Done** closes the editor. Copying does not change the source. The clipboard is available within the current project and clears when you change projects or reload the studio.

Editing keeps the loop's mix, section membership and starting alignment. Its new duration does not resize the shared groove cycle or other loops. The chosen interval starts at the loop's existing entrance, so trimming the beginning can change which sound lands there. Existing vocal takes and recorded stereo performances stay intact. To edit a separate vocal take as a repeating layer, choose **Turn into a loop** first.

Previous audio stays in **Storage**, so shortening a loop does not automatically reclaim recording space. Only permanent deletion removes those saved bytes. Edited loops are limited to 24 hours per operation and available storage. Selection listening has a 32 MiB audio limit to keep memory use bounded; a longer selection can still be copied and edited.

## Make a full song using only your loops

Choose **Record all the loops** in the bottom recording bar. This is a separate capture mode from **Add loop** and **Sing over loops**. It records every unmuted loop together into one continuous stereo recording, with their current effects and master volume. Solo does not exclude other unmuted loops in this mode; use Mute to choose what is included.

No microphone permission is needed. A connected microphone, microphone monitoring, a selected vocal take and the metronome are excluded from the recording. A vocal that you previously turned into a loop is included like any other unmuted loop.

If your groove is playing, recording starts on the next cycle. Change mutes, launch sections and adjust the mix while recording to build the song. Choose **Finish recording** when ready; your groove keeps playing. **Stop** saves the recording and stops playback. **Discard** removes the current attempt. The finished **Loop recording** appears immediately below the recorder with Listen, WAV and trash controls, and remains in **Song → Performances**. No separate vocal take is created.

During microphone recording, the live microphone history rises and falls with your actual input, including quiet or silent moments. During **Record all the loops**, the same display shows the captured stereo loop levels instead of microphone input.

After finishing a loop or performance, the recording bar remains with a saved status. A **Latest recording** card appears immediately underneath in the current view. Choose **Listen** to hear it there, or download its WAV. Listening stops the backing loops so you hear the recording clearly. The recorder is always visible directly beneath **The Groove**, even before recording or after cancelling. Reopening a project restores its latest saved recording here. Performances and vocal takes also remain in Song.

When **Studio update ready** appears, finish and save your recording, close every studio tab and installed app window, then reopen the site. A normal refresh can keep the older offline version while another studio tab is open. Do not clear browser storage: your recordings are stored there. The footer displays the studio version so you can confirm which interface is running.

### Downloading and retained recordings

Use the WAV control beside the recording you want. Saved edited mixes are in **Song → Saved mixes**, with their own WAV and delete controls. The studio does not display a running download history.

Audio retained separately from your current loops and takes is available through **Storage → All studio files**. Download a recording there, or choose **Keep in project** to restore it. Removing the workspace file list does not delete any saved audio. Exceptionally long WAV exports open a dialog containing only that recording’s numbered parts.
