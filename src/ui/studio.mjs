import { LiveInputWaveform } from './live-input.mjs';
import { normalizedStorageCapacity } from '../storage-management.mjs';

const ICONS = {
  loop: '<path d="M12 8c-3-4-8-2-8 2s5 6 8 2l3-4c3-4 7-2 7 2s-5 6-8 2l-3-4"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M5 16v4h14v-4"/>',
  undo: '<path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12"/>',
  redo: '<path d="m16 4 5 5-5 5m5-5H10a6 6 0 0 0 0 12"/>',
  sliders: '<path d="M5 3v8m0 4v6M12 3v3m0 4v11m7-18v11m0 4v3M2 11h6m1-5h6m1 8h6"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  song: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
  headphones: '<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="5" height="9" rx="2"/><rect x="16" y="12" width="5" height="9" rx="2"/>',
  volume: '<path d="M11 4 6 8H3v8h3l5 4ZM15 8a5 5 0 0 1 0 8m3-11a9 9 0 0 1 0 14"/>',
  muted: '<path d="M11 4 6 8H3v8h3l5 4Zm5 5 6 6m0-6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 4h.01"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  storage: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 14h18M7 18h.01M11 18h.01"/>',
  folder: '<path d="M3 7V4h7l2 3h9v13H3Z"/>',
  spark: '<path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7ZM20 3v4m-2-2h4"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  rewind: '<path d="M5 5v14m15-14L7 12l13 7Z"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8"/>',
};
const ROLES = ['beat', 'bass', 'harmony', 'lead', 'texture'];
const ROLE_NAMES = {beat:'Beatbox',bass:'Bass',harmony:'Harmony',lead:'Lead',texture:'Atmosphere'};
const COLORS = ['#a5e5cf','#ffab91','#ccbcfa','#eacb80','#97caec'];
const LEAD_MIX = {volume:.8,pan:0,low:-1,mid:1.5,high:1.5,highpass:90,compression:.32,reverb:.13,delay:.04};
const html = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.loop}</svg>`;
const finite = (n, fallback=0) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const clamp = (n,a,b) => Math.max(a,Math.min(b,finite(n)));
const time = (frames,rate=48000) => {const s=Math.max(0,finite(frames)/Math.max(1,finite(rate,48000)));return `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}.${Math.floor(s%1*10)}`;};
const duration = (frames,rate=48000) => {const s=Math.max(0,finite(frames)/Math.max(1,finite(rate,48000))),rounded=Math.round(s);return s < 60 ? `${s.toFixed(s<10?2:1)}s` : `${Math.floor(rounded/60)}m ${rounded%60}s`;};
const bytes = (n) => n>1024**3 ? `${(n/1024**3).toFixed(1)} GB` : `${(Math.max(0,n)/1024**2).toFixed(1)} MB`;
const storageBytes = n => Number.isSafeInteger(n)&&n>=0 ? `${n.toLocaleString('en-US')} bytes` : 'Not available';
const storageSize = n => Number.isSafeInteger(n)&&n>=0 ? n>=1024**3?`${(n/1024**3).toFixed(2)} GiB`:n>=1024**2?`${(n/1024**2).toFixed(2)} MiB`:n>=1024?`${(n/1024).toFixed(2)} KiB`:`${n} B` : 'Not available';
const db = (n) => n<=0 ? '−∞ dB' : `${Math.round(20*Math.log10(n)) > 0 ? '+' : ''}${Math.round(20*Math.log10(n))} dB`;
const slider = ({label,key,value=0,min=0,max=1,step=.01,id='',scope='mix',suffix='',display=''}) => `<label class="slider-field"><span class="slider-label"><span>${html(label)}</span><output data-output="${html(scope)}:${html(key)}">${html(display||`${value}${suffix}`)}</output></span><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-control="${scope}" data-key="${html(key)}" data-id="${html(id)}" aria-label="${html(label)}"></label>`;

/** DOM-only presentation. Every operation is sent to the controller as an action. */
export class StudioUI extends EventTarget {
  constructor(rootElement) {
    super();
    if (!rootElement) throw new Error('StudioUI requires a root element.');
    this.root = rootElement;
    this.state = {};
    this.signatures = {};
    this.cycles = 1;
    this.customCycles = 3;
    this.toasts = [];
    this.abort = new AbortController();
    this.root.innerHTML = this.shell();
    this.refs = Object.fromEntries([...this.root.querySelectorAll('[data-ref]')].map(el => [el.dataset.ref,el]));
    this.liveInput = new LiveInputWaveform(this.refs['capture-waveform'], this.refs['capture-level']);
    this.bind();
  }

  shell() {return `
    <header class="app-header">
      <button class="brand" data-action="studio-home" aria-label="Feed the Music Loop, return to Build"><img src="./icon.svg" alt="" width="42" height="42"><span>FEED THE<br><strong>MUSIC LOOP</strong></span></button>
      <div class="project-heading"><div class="eyebrow">YOUR STUDIO</div><button class="project-title" data-action="rename-project" title="Rename project" aria-label="Rename project"><span data-ref="project-name">Untitled session</span><span class="edit-mark">↗</span></button><span class="save-state" data-ref="save-state" role="status">Ready when you are</span></div>
      <div class="header-actions"><button class="button icon-button help-button" data-action="help" aria-label="Studio guide">${icon('help')}</button><button class="button quiet" data-action="projects" aria-label="Projects" aria-haspopup="dialog">${icon('folder')}<span>Projects</span></button><button class="button quiet header-storage" data-action="manage-storage" data-testid="storage" aria-label="Storage" aria-haspopup="dialog" title="Storage: files, free space and permanent deletion">${icon('storage')}<span>Storage</span></button><button class="button quiet" data-action="export-menu" aria-label="Export music and project" aria-haspopup="dialog">${icon('download')}<span>Export</span></button></div>
    </header>
    <main id="workspace" tabindex="-1">
      <div class="update-notice" data-ref="update-notice" role="status" hidden></div>
      <div class="status-banner" data-ref="banner" role="status" hidden><span data-ref="banner-text"></span><button class="button quiet" data-action="retry-recovery" data-ref="banner-retry" hidden>Retry recovery</button><button class="button quiet" data-action="reload-studio" data-ref="banner-reload" hidden>Reopen studio</button><button class="button icon-button" data-action="dismiss-error" data-ref="banner-dismiss" aria-label="Dismiss error message" hidden>${icon('close')}</button></div>
      <section class="damaged-panel" data-ref="damaged" aria-label="Incomplete source recordings" hidden></section>
      <div class="workspace-top"><nav class="view-tabs" aria-label="Studio views"><button class="view-tab is-active" data-action="view" data-view="build" aria-current="page">${icon('layers')}<span>Build</span></button><button class="view-tab" data-action="view" data-view="song">${icon('song')}<span>Song</span></button><button class="view-tab" data-action="view" data-view="mix">${icon('sliders')}<span>Mix</span></button></nav><div class="studio-signals"><span class="local-badge" title="Recordings stay in this browser until you export them.">${icon('shield')}<span>Yours. On this device.</span></span><button class="mic-status" data-action="toggle-mic" data-testid="enable-mic"><span class="status-dot"></span><span data-ref="mic-label">Connect mic</span>${icon('mic')}</button></div></div>
      <section class="transport-panel" aria-label="Playback transport"><div class="transport-time"><span class="eyebrow" data-ref="transport-label">THE GROOVE</span><div class="time-display" data-ref="transport-time">0:00.0</div></div><div class="cycle-display"><div class="cycle-meta"><span data-ref="cycle-description">Your first loop sets the rhythm</span><span data-ref="cycle-position">FREE</span></div><div class="cycle-track"><div class="cycle-progress" data-ref="cycle-progress"></div><div class="cycle-ticks" aria-hidden="true"><i></i><i></i><i></i></div></div><div class="transport-caption"><span data-ref="track-count">No layers yet</span><span data-ref="sample-rate">LOCAL AUDIO STUDIO</span></div></div><div class="master-meter" aria-label="Master output level"><div class="meter-label">OUT</div><div class="meter-track"><div class="meter-fill" data-ref="output-meter"></div></div><span class="meter-value" data-ref="output-db">−∞</span></div><button class="button icon-button restart-button" data-action="seek-start" aria-label="Return to start" title="Return to start">${icon('rewind')}</button></section>
      <section class="capture-panel" data-ref="capture-panel" aria-label="Recording studio"><div class="capture-symbol" data-ref="capture-symbol">${icon('mic')}</div><div class="capture-copy"><strong data-ref="capture-title">Recording your first loop</strong><p data-ref="capture-hint">Make your sound. Finish whenever it feels right.</p><div class="capture-live" data-ref="capture-live" aria-label="Microphone input history"><div class="capture-live-label"><span data-ref="capture-live-label">LIVE MIC</span><span data-ref="capture-level">−∞ dB</span></div><svg data-ref="capture-waveform" aria-hidden="true"></svg></div><div class="capture-progress-track"><div data-ref="capture-progress"></div></div></div><span class="capture-clock" data-ref="capture-time" aria-label="Recording duration">0:00.0</span></section>
      <section class="recent-recording" data-ref="recent-recording" aria-label="Just recorded" hidden></section>
      <section class="preview-panel" data-ref="preview-panel" aria-label="Recording preview" hidden><div class="preview-description">${icon('headphones')}<span><small data-ref="preview-kind">LISTEN BACK</small><strong data-ref="preview-name">Your performance</strong></span></div><p class="preview-loading" data-ref="preview-loading" hidden>Preparing your recording. Stop cancels this.</p><audio id="performance-player" data-ref="preview-audio" controls preload="metadata"></audio><button class="button icon-button" data-action="close-preview" aria-label="Close recording preview">${icon('close')}</button></section>
      <section class="audition-panel" data-ref="audition-panel" aria-label="Live mix playback" hidden><div class="audition-symbol">${icon('headphones')}</div><div class="audition-copy"><span class="eyebrow">HEAR YOUR CHANGES</span><strong data-ref="audition-name">Live vocal mix</strong><div class="audition-progress-track"><div data-ref="audition-progress"></div></div></div><span class="audition-time" data-ref="audition-time">0:00.0</span><button class="button quiet" data-action="stop">${icon('stop')}Stop mix</button></section>
      <section class="export-progress-panel" data-ref="export-panel" aria-label="Export progress" hidden><div><strong data-ref="export-title">Preparing your audio…</strong><p data-ref="export-caption">Your recordings remain safe while this file is prepared.</p><div class="export-progress-track" role="progressbar" aria-label="Export completion" aria-valuemin="0" aria-valuemax="100" data-ref="export-progressbar"><div data-ref="export-progress"></div></div></div><button class="button quiet" data-action="cancel-export">${icon('close')}Cancel export</button></section>
      <div class="studio-body">
        <div class="main-column">
          <section data-view-panel="build" class="view-panel" aria-label="Build your loops">
            <div class="section-heading"><div><span class="eyebrow">ONE VOICE. ENDLESS POSSIBILITIES.</span><h1>Your loop canvas<span class="heading-dot">.</span></h1></div><button class="button quiet small" data-action="import-audio" aria-label="Import an audio file">${icon('upload')}<span>Import audio</span></button></div>
            <div class="empty-canvas" data-ref="empty"><div class="orbit-art" aria-hidden="true"><div class="orbit-ring ring-one"></div><div class="orbit-ring ring-two"></div><div class="orbit-ring ring-three"></div><div class="orbit-core">${icon('mic')}</div><span class="orbit-note note-one">BEAT</span><span class="orbit-note note-two">BASS</span><span class="orbit-note note-three">VOICE</span></div><span class="eyebrow">EVERY SONG STARTS SOMEWHERE</span><h2>What does your<br><em>world sound like?</em></h2><p>A beat. A hum. A little rhythm.<br>Record it, loop it, and see where your voice takes you.</p><button class="button primary" data-action="add-loop" data-testid="first-loop">${icon('plus')}Record your first loop</button><button class="text-button demo-button" data-action="demo" data-testid="demo">${icon('headphones')}Try a demo groove${icon('arrow')}</button><div class="empty-tip">Headphones help keep each layer clean.</div></div>
            <div class="loop-grid" data-ref="tracks" aria-label="Loop tracks"></div>
            <div class="add-layer-row" data-ref="add-layer-row" hidden><button class="add-layer" data-action="add-loop">${icon('plus')}<span>Add another layer</span><kbd>R</kbd></button></div>
            <section class="section-bank"><div class="section-heading compact"><div><span class="eyebrow">GIVE YOUR SONG A SHAPE</span><h2>Sections</h2></div><button class="button quiet small" data-action="save-section">${icon('plus')}Save section</button></div><div class="section-pads" data-ref="sections"></div><p class="help-copy">Save a combination of layers as an intro, verse or chorus. Switch sections on the next loop boundary.</p></section>
          </section>
          <section data-view-panel="song" class="view-panel" aria-label="Your song recordings" hidden><div class="section-heading"><div><span class="eyebrow">LET THE GROOVE CARRY YOU</span><h1>Make it a song<span class="heading-dot">.</span></h1></div></div><div class="song-hero"><div class="song-hero-icon">${icon('mic')}</div><div><h2>One continuous performance.</h2><p>Sing for as long as you need while your loops keep playing. Each take keeps your vocal and the complete song.</p></div><button class="button primary coral" data-action="sing">${icon('mic')}Sing over loops</button></div><section class="discarded-panel" data-ref="discarded" aria-label="Discarded recordings awaiting storage cleanup" hidden></section><div class="section-heading compact"><h2>Performances</h2><span class="quiet-label" data-ref="performance-count">0 recordings</span></div><div class="performance-list" data-ref="performances"></div><div class="section-heading compact takes-heading"><h2>Vocal takes</h2><span class="quiet-label">Your originals, kept separate</span></div><div class="take-list" data-ref="takes"></div><section class="saved-mixes" data-ref="saved-mixes" aria-label="Saved mixes" hidden></section></section>
          <section data-view-panel="mix" class="view-panel" aria-label="Mix your song" hidden><div class="section-heading"><div><span class="eyebrow">FIND YOUR SIGNATURE SOUND</span><h1>Shape the feeling<span class="heading-dot">.</span></h1></div></div><div class="mixer-channel-list" data-ref="mix-channels"></div><div class="mix-console" data-ref="mix-console"></div><section class="mix-guide"><h3>Make room for your voice.</h3><p>Start with the backing a little quieter than you expect. Place harmonies left and right, keep bass near the centre, and use a little shared space to bring the layers together.</p></section></section>
        </div>
        <aside class="side-column" aria-label="Input and session controls"><section class="input-card"><div class="card-heading"><span class="eyebrow">YOUR INSTRUMENT</span>${icon('mic')}</div><h2>The human voice.</h2><div class="input-meter-row"><span>Mic level</span><div class="input-meter-track"><div data-ref="input-meter"></div></div><span data-ref="input-db">−∞</span></div><div data-ref="input-controls"></div><label class="toggle-row"><span>${icon('headphones')}Hear my mic</span><input type="checkbox" data-control="monitor" role="switch" aria-label="Hear my microphone through headphones"><span class="toggle" aria-hidden="true"></span></label><p class="help-copy">Use headphones for monitoring. Add loop and Sing over loops record your voice even when monitoring is off. Record all the loops excludes your microphone.</p><div class="input-divider"></div><div class="loop-length"><label for="loop-length">New loop length</label><select id="loop-length" data-control="cycles"><option value="1">1 cycle · stay in sync</option><option value="2">2 cycles</option><option value="4">4 cycles</option><option value="custom">Custom cycles</option><option value="0">Free · finish when ready</option></select><label class="custom-cycles" data-ref="custom-cycles" hidden>Cycles<input type="number" min="1" max="64" value="3" data-control="custom-cycles" inputmode="numeric"></label><p class="help-copy" data-ref="length-help">Your first loop is free length. After that, new layers lock to your rhythm.</p></div></section><section class="master-card"><div class="card-heading"><span class="eyebrow">THE WHOLE PICTURE</span>${icon('sliders')}</div><div data-ref="master-controls"></div><button class="spotlight-button" data-action="spotlight" aria-pressed="false">${icon('spark')}<span>Spotlight<small>Hold to bring your voice forward</small></span></button></section><section class="session-card"><div class="card-heading"><span class="eyebrow">KEEP WHAT YOU CREATE</span>${icon('shield')}</div><p class="session-storage" data-ref="storage-label">Audio stays on this device.</p><div class="storage-bar"><div data-ref="storage-progress"></div></div><button class="text-button" data-action="export-project">Download project backup${icon('arrow')}</button><button class="text-button subtle" data-action="persist" data-ref="persist-button">Protect local storage${icon('arrow')}</button><button class="text-button subtle" data-action="manage-storage">Manage storage${icon('folder')}</button><details class="advanced-settings"><summary>Timing &amp; recording</summary><div class="microphone-picker" data-ref="microphone-picker"></div><p class="help-copy">If your new layers sound late, adjust recording compensation. This depends on your headphones and microphone.</p><label class="number-field">Recording compensation<span><input type="number" min="0" max="1000" step="1" value="0" data-control="compensation" aria-label="Recording compensation in milliseconds">ms</span></label><p class="help-copy">Try small changes. Wired headphones usually make timing easier. A new audio device may need a different setting.</p><div class="metronome-controls" data-ref="metronome-controls"></div><button class="button quiet full-width" data-action="mic-off">${icon('mic')}Disconnect microphone</button></details></section></aside>
      </div>
      <div class="footnote"><span>Made of breath, rhythm &amp; possibility. <small class="studio-version">Studio 2026.10.15.2</small></span><button class="text-button subtle" data-action="help">${icon('keyboard')}Studio guide &amp; shortcuts</button></div>
    </main>
    <div class="record-dock" aria-label="Recording controls"><div class="dock-status"><span class="dock-light" data-ref="dock-light"></span><div><strong data-ref="dock-label">Start with a sound.</strong><span data-ref="dock-caption">Your first loop is the beginning.</span></div></div><div class="dock-actions"><button class="button transport-button" data-action="play" data-testid="play" aria-label="Play loops">${icon('play')}</button><button class="button stop-button" data-action="stop" data-testid="stop" aria-label="Stop all audio" title="Stop all audio">${icon('stop')}</button><span class="dock-separator"></span><button class="button primary" data-action="add-loop" data-ref="dock-loop" data-testid="add-loop">${icon('plus')}<span>Add loop</span><kbd>R</kbd></button><button class="button primary coral" data-action="sing" data-ref="dock-sing" data-testid="sing">${icon('mic')}<span>Sing over loops</span><kbd>V</kbd></button><button class="button primary loop-record-button" data-action="record-all-loops" data-ref="dock-mix" data-testid="record-all-loops" title="Record every unmuted loop together, without microphone input">${icon('layers')}<span>Record all the loops</span></button><button class="button primary coral" data-action="finish" data-ref="dock-finish" data-testid="finish" hidden>${icon('check')}<span>Finish recording</span></button><button class="button quiet" data-action="cancel" data-ref="dock-cancel" data-testid="cancel" hidden>${icon('close')}<span>Cancel</span></button></div><div class="history-actions"><button class="button icon-button" data-action="undo" aria-label="Undo" title="Undo (Ctrl or ⌘ Z)">${icon('undo')}</button><button class="button icon-button" data-action="redo" aria-label="Redo" title="Redo (Ctrl or ⌘ Shift Z)">${icon('redo')}</button></div></div>
    <div class="toast-region" data-ref="toasts" aria-live="polite" aria-relevant="additions"></div>
    <dialog class="studio-dialog" data-ref="dialog" aria-labelledby="dialog-title"><form method="dialog"><div class="dialog-heading"><h2 id="dialog-title" data-ref="dialog-title" tabindex="-1"></h2><button type="button" class="button icon-button dialog-stop" data-action="stop" data-ref="dialog-stop" aria-label="Stop all audio" title="Stop all audio" hidden>${icon('stop')}</button><button type="button" class="button icon-button" data-dialog-close aria-label="Close dialog">${icon('close')}</button></div><div data-ref="dialog-body"></div><div class="dialog-actions" data-ref="dialog-actions"></div></form></dialog>
    <input type="file" data-ref="audio-file" accept="audio/*,.wav,.mp3,.ogg,.m4a,.webm,.flac" hidden><input type="file" data-ref="project-file" accept=".fml,application/octet-stream" hidden>
  `;}

  emit(type, details={}) {this.dispatchEvent(new CustomEvent('action',{detail:{type,...details}}));}

  bind() {
    const signal = this.abort.signal;
    this.root.addEventListener('click',e=>this.onClick(e),{signal});
    this.root.addEventListener('input',e=>this.onInput(e),{signal});
    this.root.addEventListener('change',e=>this.onChange(e),{signal});
    // Keep focus under the user's control after navigating away from an
    // automatically focused capture button, including a deliberate pointer choice.
    this.root.addEventListener('focusout',e=>{if(e.target===this.refs['dock-cancel'])this.autoCaptureFocus=false;},{signal});
    this.refs['dock-cancel'].addEventListener('pointerdown',()=>{this.autoCaptureFocus=false;},{signal});
    this.refs.dialog.addEventListener('submit',e=>{
      if(!e.submitter&&!this.dialogRequest){e.preventDefault();this.refs.dialog.querySelector('[data-action="export-mix"]:not(:disabled)')?.click();return;}
      this.settleDialog(e.submitter?.value||'confirm');
    },{signal});
    this.refs.dialog.addEventListener('cancel',()=>this.settleDialog('cancel'),{signal});
    this.refs.dialog.addEventListener('close',()=>{
      // A previous close event can arrive after this same dialog has reopened.
      if(this.refs.dialog.open)return;
      this.settleDialog(this.refs.dialog.returnValue);
      const opener=this.dialogOpener;
      if(opener?.isConnected&&!opener.disabled&&!opener.closest('[hidden]'))opener.focus({preventScroll:true});
    },{signal});
    this.refs['audio-file'].addEventListener('change',e=>{this.importFile(e.target.files?.[0],'import-audio');e.target.value='';},{signal});
    this.refs['project-file'].addEventListener('change',e=>{this.importFile(e.target.files?.[0],'import-project');e.target.value='';},{signal});
    for(const type of ['play','pause','ended'])this.refs['preview-audio'].addEventListener(type,()=>{this.previewPlaying=!this.refs['preview-audio'].paused&&!this.refs['preview-audio'].ended;this.renderDock(this.state.capture,this.state.project?.tracks||[],this.state.sampleRate||48000);this.refs['dialog-stop'].hidden=!(this.state.playing||this.state.capture||this.state.previewPreparing||this.previewPlaying);},{signal});
    document.addEventListener('keydown',e=>this.onKey(e),{signal});
    const spotlight = this.root.querySelector('[data-action="spotlight"]');
    const release=()=>{if(this.spotlight){this.spotlight=false;spotlight.setAttribute('aria-pressed','false');this.emit('spotlight',{active:false});}};
    spotlight.addEventListener('pointerdown',e=>{if(e.button!==0||spotlight.disabled)return;e.preventDefault();spotlight.setPointerCapture?.(e.pointerId);this.spotlight=true;spotlight.setAttribute('aria-pressed','true');this.emit('spotlight',{active:true});},{signal});
    spotlight.addEventListener('pointerup',release,{signal});
    spotlight.addEventListener('pointercancel',release,{signal});
    spotlight.addEventListener('lostpointercapture',release,{signal});
    spotlight.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat&&!spotlight.disabled){e.preventDefault();this.spotlight=true;spotlight.setAttribute('aria-pressed','true');this.emit('spotlight',{active:true});}},{signal});
    spotlight.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();release();}},{signal});
    window.addEventListener('blur',release,{signal});
    this.root.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();this.root.classList.add('is-dragging');}},{signal});
    this.root.addEventListener('dragleave',e=>{if(!this.root.contains(e.relatedTarget))this.root.classList.remove('is-dragging');},{signal});
    this.root.addEventListener('drop',e=>{e.preventDefault();this.root.classList.remove('is-dragging');const file=e.dataTransfer?.files?.[0];if(file)this.importFile(file,file.name.toLowerCase().endsWith('.fml')?'import-project':'import-audio');},{signal});
  }

  importFile(file,type) {
    if(!file||this.state.storageFailed)return;
    if(this.state.capture||this.state.busy||this.state.exporting){this.notify('Finish the current recording or file operation before importing.','warning');return;}
    if(type==='import-audio'&&this.state.readonly){this.notify(this.state.readonlyReason||'This project is open in another tab. Close that tab before adding audio here.','warning');return;}
    this.emit(type,{file});
  }

  async onClick(e) {
    if(e.target.closest('[data-dialog-close]')){this.settleDialog('cancel');this.refs.dialog.close('cancel');return;}
    const button = e.target.closest('[data-action]');
    if(!button||button.disabled)return;
    const type=button.dataset.action,id=button.dataset.id;
    if(this.state.storageFailed&&!['help','view','studio-home','reload-studio'].includes(type))return;
    if(type==='spotlight')return;
    if(type==='studio-home')return this.emit('view',{view:'build'});
    if(type==='view')return this.emit('view',{view:button.dataset.view});
    if(type==='projects')return this.showProjects();
    if(type==='export-menu')return this.showExport();
    if(type==='help')return this.showHelp();
    if(type==='dismiss-error'){this.refs.toasts.querySelectorAll('.toast-error').forEach(el=>el.remove());return this.emit(type);}
    if(type==='toggle-mic')return this.emit(this.state.micEnabled?'mic-off':'enable-mic');
    if(type==='import-audio')return this.refs['audio-file'].click();
    if(type==='import-project'){this.refs.dialog.close();return this.refs['project-file'].click();}
    if(type==='new-project'){
      this.refs.dialog.close();const name=await this.prompt({title:'A new beginning',message:'Give this project a name. You can change it later.',value:'Untitled session',label:'Project name',confirmLabel:'Create project'});if(name)this.emit(type,{name});return;
    }
    if(type==='rename-project') {const name=await this.prompt({title:'Name your session',value:this.state.project?.name||'Untitled session',label:'Project name',confirmLabel:'Save name'});if(name)this.emit(type,{name});return;}
    if(type==='rename-track'){const track=this.state.project?.tracks?.find(t=>t.id===id);const name=await this.prompt({title:'Name this layer',value:track?.name||'',label:'Layer name',confirmLabel:'Save name'});if(name)this.emit(type,{id,name});return;}
    if(type==='rename-take'){const take=this.state.project?.takes?.find(t=>t.id===id);const name=await this.prompt({title:'Name this vocal take',value:take?.name||'',label:'Take name',confirmLabel:'Save name'});if(name)this.emit(type,{id,name});return;}
    if(type==='save-section'){const name=await this.prompt({title:'Save this moment',message:'Keep the current combination of layers and their mix as a song section.',value:['Intro','Verse','Chorus','Bridge'][this.state.project?.sections?.length||0]||'New section',label:'Section name',confirmLabel:'Save section'});if(name)this.emit(type,{name});return;}
    if(type==='delete-section'||type==='delete-take'){const yes=await this.confirm({title:type==='delete-take'?'Remove this take?':'Remove this section?',message:type==='delete-take'?'This removes the take from your project. Your other performances remain.':'This removes the saved section. Your audio layers remain.',confirmLabel:'Remove',danger:true});if(yes)this.emit(type,{id});return;}
    if(type==='open-project'){this.refs.dialog.close();return this.emit(type,{id});}
    if(type==='delete-project'){this.refs.dialog.close('cancel');return this.emit(type,{id});}
    if(type==='delete-storage-file'||type==='download-storage-file')return this.emit(type,{fileKey:button.dataset.fileKey});
    if(type==='refresh-storage')return this.emit(type);
    if(type==='manage-storage'){this.refs.dialog.close('cancel');return this.emit(type);}
    if(type==='export-project'){this.refs.dialog.close();return this.emit(type);}
    if(type==='export-master'){this.refs.dialog.close();return this.emit(type,{performanceId:button.dataset.performanceId||id});}
    if(type==='preview-performance'||type==='delete-performance')return this.emit(type,{performanceId:button.dataset.performanceId||id});
    if(type==='export-mix'||type==='preview-mix'){
      const input=this.root.querySelector('[data-export-duration]'),details={};
      if(type==='export-mix'&&input&&!(input.dataset.useExact==='true'&&input.value===input.dataset.initial)){
        const seconds=Number(input.value);
        if(!Number.isFinite(seconds)||seconds<=0||seconds>86400){input.setCustomValidity('Choose a length greater than zero and no longer than 24 hours.');input.reportValidity();return;}
        details.durationSeconds=seconds;
      }
      this.refs.dialog.close();return this.emit(type,details);
    }
    if(type==='add-loop'){if(this.state.capture)return;return this.emit(type,{cycles:this.state.project?.baseFrames ? this.cycles : 0,customCycles:this.customCycles});}
    if(type==='preview-track'||type==='select-take'||type==='preview-take'||type==='select-track'||type==='mute'||type==='solo'||type==='remove-track'||type==='launch-section'||type==='export-track'||type==='layer-vocal'||type==='recover-asset'||type==='export-recovered'||type==='export-damaged-audio'||type==='delete-saved-mix'||type==='delete-discarded')return this.emit(type,{id});
    if(type==='nudge')return this.emit(type,{id,frames:Math.round(finite(button.dataset.ms)*finite(this.state.sampleRate||this.state.project?.sampleRate,48000)/1000)});
    this.emit(type);
  }

  onInput(e) {
    if(this.state.storageFailed)return;
    const el=e.target,control=el.dataset.control,key=el.dataset.key;
    if(el.hasAttribute('data-storage-search')){this.storageSearch=el.value;this.renderStorageFiles();return;}
    if(el.hasAttribute('data-export-duration'))el.setCustomValidity('');
    if(!control)return;
    const value=finite(el.value);
    if(control==='mix'){this.displayRange(el);this.emit('mix',{id:el.dataset.id,mix:{[key]:value}});}
    if(control==='master'){this.displayRange(el);this.emit('set-master',{volume:value});}
    if(control==='input'){this.displayRange(el);this.emit('set-input',{gain:value});}
    if(control==='metronome'){this.displayRange(el);this.emit('set-metronome',{[key]:value});}
  }

  onChange(e) {
    if(this.state.storageFailed)return;
    const el=e.target,c=el.dataset.control;
    if(el.hasAttribute('data-storage-filter')){this.storageFilter=el.value;this.renderStorageFiles();return;}
    if(c==='monitor')this.emit('monitor',{enabled:el.checked,monitor:el.checked});
    if(c==='cycles'){this.cycles=el.value==='custom'?'custom':Number(el.value);this.refs['custom-cycles'].hidden=this.cycles!=='custom';}
    if(c==='custom-cycles'){this.customCycles=Math.round(clamp(el.value,1,64));el.value=this.customCycles;}
    if(c==='compensation'){el.value=Math.round(clamp(el.value,0,1000));this.emit('set-input',{compensationMs:Number(el.value)});}
    if(c==='role')this.emit('role',{id:el.dataset.id,role:el.value});
    if(c==='selected-track')this.emit('select-track',{id:el.value});
    if(c==='selected-take')this.emit('select-take',{id:el.checked?el.dataset.id:null});
    if(c==='metronome-enabled')this.emit('set-metronome',{enabled:el.checked});
    if(c==='metronome-bpm'){el.value=clamp(el.value,40,240);this.emit('set-metronome',{bpm:Number(el.value)});}
    if(c==='metronome-beats')this.emit('set-metronome',{beatsPerCycle:Number(el.value)});
    if(c==='metronome-count')this.emit('set-metronome',{countInBeats:Number(el.value)});
    if(c==='microphone-device')this.emit('select-microphone',{deviceId:el.value});
  }

  onKey(e) {
    if(e.key==='Tab')this.autoCaptureFocus=false;
    if(this.state.storageFailed)return;
    if(this.refs.dialog.open||e.target.closest('audio,video'))return;
    const editable=e.target.closest('input,textarea,select,[contenteditable="true"]');
    const enabled=type=>!!this.root.querySelector(`[data-action="${type}"]:not(:disabled)`);
    if(e.key==='Escape'&&this.state.capture){e.preventDefault();if(!this.refs['dock-cancel'].disabled)this.emit('cancel');return;}
    if(editable||e.repeat||e.altKey)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();const type=e.shiftKey?'redo':'undo';if(enabled(type))this.emit(type);return;}
    if(e.ctrlKey||e.metaKey)return;
    if(e.target.closest('button,a,summary')&&(e.key===' '||e.key==='Enter'))return;
    if(e.key===' '){e.preventDefault();const type=this.state.playing||this.state.capture||this.previewPlaying||this.state.previewPreparing?'stop':'play';if(enabled(type))this.emit(type);}
    if(e.key.toLowerCase()==='r'&&enabled('add-loop'))this.emit('add-loop',{cycles:this.state.project?.baseFrames?this.cycles:0,customCycles:this.customCycles});
    if(e.key.toLowerCase()==='v'&&enabled('sing'))this.emit('sing');
    if(e.key==='Enter'&&this.state.capture?.status==='recording')this.emit('finish');
  }

  render(state) {
    this.state=state;
    const focusedBefore=document.activeElement;
    const p=state.project||{},tracks=p.tracks||[],rate=state.sampleRate||p.sampleRate||48000,capture=state.capture;
    if(this.liveProjectId!==p.id){this.liveInput.reset();this.liveCaptureId=null;this.liveProjectId=p.id;}
    const recording=!!capture,view=state.view||'build';
    const focusWasInOldView=this.renderedView&&this.renderedView!==view&&document.activeElement?.closest('[data-view-panel]');
    this.refs['project-name'].textContent=p.name||'Untitled session';
    this.root.dataset.captureState=capture?.status||'idle';
    this.root.dataset.playing=String(!!state.playing);
    const saveLabel=state.message||state.status||(state.busy?'Working…':'Ready');
    if(this.refs['save-state'].textContent!==saveLabel)this.refs['save-state'].textContent=saveLabel;
    this.refs['save-state'].classList.toggle('is-error',!!state.error);
    this.refs['mic-label'].textContent=state.micEnabled?'Mic connected':'Connect mic';
    const mic=this.root.querySelector('[data-action="toggle-mic"]');mic.classList.toggle('is-connected',!!state.micEnabled);mic.setAttribute('aria-label',state.micEnabled?'Disconnect microphone':'Connect microphone');
    this.root.querySelectorAll('[data-action="view"]').forEach(el=>{const active=el.dataset.view===view;el.classList.toggle('is-active',active);active?el.setAttribute('aria-current','page'):el.removeAttribute('aria-current');});
    this.root.querySelectorAll('[data-view-panel]').forEach(el=>el.hidden=el.dataset.viewPanel!==view);
    this.refs.empty.hidden=tracks.length>0||recording;
    this.refs['add-layer-row'].hidden=tracks.length===0;
    this.refs['track-count'].textContent=`${tracks.length} ${tracks.length===1?'layer':'layers'}${tracks.length?' · made by you':''}`;
    this.refs['sample-rate'].textContent=p.sampleRate?`${(p.sampleRate/1000).toFixed(1)} kHz`:'LOCAL AUDIO STUDIO';
    this.refs['cycle-description'].textContent=p.baseFrames?`${duration(p.baseFrames,rate)} per cycle`:'Your first loop sets the rhythm';
    this.refs['length-help'].textContent=p.baseFrames?'Synced layers finish automatically. Choose Free to decide your own length.':'Your first loop is free length. After that, new layers lock to your rhythm.';
    this.renderTracks(tracks,rate);
    this.renderSections(p.sections||[]);
    this.renderSong(p,rate);
    this.renderMixer(p,tracks);
    this.renderInput(p);
    this.renderMicrophonePicker();
    this.renderMetronome(p);
    this.renderPreview(state.preview);
    this.renderAudition(state.audition,state.transportFrame);
    this.renderDamaged(state.damagedAudio||[],rate);
    this.renderSavedMixes(state.recovered||[],rate);
    this.renderStorageRecordings();
    this.refs['export-panel'].hidden=!state.exporting;
    this.updateExportProgress(state.exportProgress||{});
    this.renderRecentRecording(rate);
    this.renderDock(capture,tracks,rate);
    this.updateMeters({inputLevel:state.inputLevel,outputLevel:state.outputLevel});
    this.updateTransport({transportFrame:state.transportFrame,sampleRate:rate,baseFrames:p.baseFrames});
    const storage=state.storage||{},capacity=normalizedStorageCapacity(storage);
    this.refs['storage-label'].textContent=capacity.known?`About ${storageSize(capacity.remaining)} available · browser estimate`:'Available recording space is not reported by this browser.';
    this.refs['storage-progress'].style.width=`${capacity.known?clamp(capacity.usage/capacity.quota*100,0,100):0}%`;
    this.refs['persist-button'].hidden=!!storage.persistent;
    this.refs['persist-button'].disabled=!!state.busy;
    let banner=state.error?(typeof state.error==='string'?state.error:state.error.message):state.readonly?state.readonlyReason||'This project is open in another tab. Close that tab to continue editing here.':'';
    if(state.storageFailed)banner=banner||'Local storage stopped responding. Reopen the studio to recover your saved recordings.';
    else if(state.capabilities?.secureContext===false)banner='Microphone recording needs HTTPS or localhost. Open the published studio to record.';
    else if(state.capabilities?.audio===false)banner='This browser cannot open the audio engine. Open the studio in a current browser with Web Audio support.';
    else if(state.capabilities?.microphone===false)banner='Microphone recording is unavailable here. Open the HTTPS studio in a current browser to connect your microphone.';
    this.refs.banner.hidden=!banner;if(this.refs['banner-text'].textContent!==banner)this.refs['banner-text'].textContent=banner;this.refs['banner-dismiss'].hidden=!state.error||!!state.storageFailed;this.refs['banner-reload'].hidden=!state.storageFailed;this.refs.banner.classList.toggle('is-error',!!state.error);
    this.refs['banner-retry'].hidden=!state.recoveryRequired||!!state.storageFailed;
    this.refs['banner-retry'].disabled=recording||!!state.busy||!!state.exporting||!!state.storageFailed||!!state.deletionPending;
    this.root.querySelectorAll('[data-action="undo"]').forEach(el=>el.disabled=!state.undoAvailable||recording||!!state.busy||!!state.readonly);
    this.root.querySelectorAll('[data-action="redo"]').forEach(el=>el.disabled=!state.redoAvailable||recording||!!state.busy||!!state.readonly);
    this.root.querySelectorAll('[data-action="add-loop"],[data-action="sing"],[data-action="demo"],[data-action="import-audio"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting||!!state.readonly||state.capabilities?.audio===false||(['add-loop','sing'].includes(el.dataset.action)&&state.capabilities?.microphone===false));
    const playableLoops=tracks.filter(track=>track.kind==='loop'&&track.frames>0&&!track.muted&&!this.damagedIds().has(track.assetId));
    this.refs['dock-mix'].disabled=recording||!!state.busy||!!state.exporting||!!state.readonly||state.capabilities?.audio===false||!playableLoops.length;
    this.refs['dock-mix'].title=playableLoops.length?'Record every unmuted loop together. Solo is ignored; microphone input is excluded.':'Add or unmute a loop to record your loops together.';
    this.root.querySelectorAll('[data-action="projects"],[data-action="rename-project"],[data-action="export-menu"],[data-action="manage-storage"],[data-action="delete-project"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="save-section"]').forEach(el=>el.disabled=!tracks.length||!!state.readonly||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="play"]').forEach(el=>{el.disabled=recording||!!state.playing||(!tracks.length&&!p.selectedTakeId&&!p.metronome?.enabled)||!!state.busy;});
    this.root.querySelectorAll('[data-action="seek-start"]').forEach(el=>el.disabled=recording||!!state.busy||!tracks.length);
    this.root.querySelectorAll('[data-action="stop"]').forEach(el=>el.disabled=false);
    this.root.querySelectorAll('[data-action="delete-storage-file"],[data-action="download-storage-file"],[data-action="refresh-storage"]').forEach(el=>el.disabled=el.dataset.unavailable==='true'||recording||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="export-project"]').forEach(el=>el.disabled=recording||!!state.exporting||!!state.busy);
    this.root.querySelectorAll('input[data-control="mix"],input[data-control="master"],input[data-control="input"],[data-control="role"],[data-control="compensation"],[data-control="selected-take"]').forEach(el=>el.disabled=!!state.readonly||!!state.busy);
    this.root.querySelectorAll('[data-action="layer-vocal"],[data-action="recover-asset"],[data-action="delete-performance"],[data-action="delete-saved-mix"],[data-action="delete-discarded"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting||!!state.readonly);
    this.root.querySelector('[data-control="compensation"]').disabled=recording||!!state.readonly||!!state.busy;
    this.root.querySelector('[data-control="monitor"]').disabled=!!state.readonly||state.capabilities?.microphone===false||!!capture?.waitingForMic;
    mic.disabled=!state.micEnabled&&(state.capabilities?.microphone===false||!!capture?.waitingForMic||!!state.readonly);
    this.root.querySelectorAll('[data-action="export-track"],[data-action="export-master"],[data-action="export-recovered"],[data-action="preview-track"],[data-action="preview-take"],[data-action="preview-performance"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="preview-track"],[data-action="preview-take"],[data-action="preview-performance"]').forEach(el=>{if(state.previewPreparing)el.disabled=true;});
    this.root.querySelectorAll('[data-action="export-recovered"]').forEach(el=>{if((state.recovered||[]).some(a=>a.id===el.dataset.id&&a.needsRecovery))el.disabled=true;});
    this.root.querySelector('[data-action="spotlight"]').disabled=!!state.readonly||!!state.busy;
    this.root.querySelectorAll('[data-action="mute"],[data-action="solo"],[data-action="remove-track"],[data-action="rename-track"],[data-action="rename-take"],[data-action="delete-take"],[data-action="delete-section"],[data-action="launch-section"],[data-action="nudge"]').forEach(el=>el.disabled=!!state.readonly||!!state.busy);
    if(state.readonly)this.root.querySelector('[data-action="rename-project"]').disabled=true;
    const damaged=this.damagedIds(),damagedBacking=tracks.some(t=>damaged.has(t.assetId));
    if(damagedBacking)this.root.querySelectorAll('[data-action="play"],[data-action="add-loop"],[data-action="sing"],[data-action="record-all-loops"]').forEach(el=>el.disabled=true);
    if(damaged.size)this.root.querySelectorAll('[data-action="export-project"]').forEach(el=>el.disabled=true);
    this.root.querySelectorAll('[data-action="export-damaged-audio"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="preview-track"],[data-action="export-track"],[data-action="layer-vocal"]').forEach(el=>{const track=[...tracks,...(p.takes||[])].find(t=>t.id===el.dataset.id);if(damaged.has(track?.assetId))el.disabled=true;});
    this.root.querySelectorAll('[data-action="export-master"],[data-action="preview-performance"]').forEach(el=>{const performance=(p.performances||[]).find(x=>x.id===el.dataset.performanceId);if(damaged.has(performance?.masterAssetId))el.disabled=true;});
    this.root.querySelectorAll('[data-action="preview-take"]').forEach(el=>{const take=(p.takes||[]).find(t=>t.id===el.dataset.id),performance=(p.performances||[]).find(x=>x.id===take?.performanceId);if(damaged.has(performance?.masterAssetId||take?.assetId))el.disabled=true;});
    if(state.deletionPending)this.root.querySelectorAll('[data-action="play"],[data-action="seek-start"],[data-action="preview-track"],[data-action="preview-take"],[data-action="preview-performance"],[data-action="preview-mix"],[data-action="export-menu"],[data-action="export-track"],[data-action="export-master"],[data-action="export-recovered"],[data-action="export-damaged-audio"],[data-action="export-mix"],[data-action="export-project"]').forEach(el=>el.disabled=true);
    if(state.storageFailed){
      this.root.querySelectorAll('[data-action]').forEach(el=>{if(!['help','view','studio-home','reload-studio'].includes(el.dataset.action))el.disabled=true;});
      this.root.querySelectorAll('input,select').forEach(el=>el.disabled=true);
      if(!this.storageFailedShown&&this.refs.dialog.open)this.refs.dialog.close('cancel');
    }
    this.storageFailedShown=!!state.storageFailed;
    this.refs['dialog-stop'].hidden=!(state.playing||capture||state.previewPreparing||(state.preview&&!this.refs['preview-audio'].paused));
    if(focusWasInOldView){const heading=this.root.querySelector(`[data-view-panel="${view}"] h1`);if(heading){heading.tabIndex=-1;heading.focus();}}
    else if(!this.refs.dialog.open&&focusedBefore?.isConnected&&this.root.contains(focusedBefore)&&focusedBefore.closest('[hidden]')){
      const target=capture?(capture.status==='recording'?this.refs['dock-finish']:this.refs['dock-cancel']):this.refs['dock-loop'];
      if(!target.disabled&&!target.hidden){
        target.focus({preventScroll:true});
        this.autoCaptureFocus=target===this.refs['dock-cancel']&&['add-loop','sing','record-all-loops'].includes(focusedBefore.dataset.action);
      }
    }
    this.renderedView=view;
  }

  region(key,signature,markup) {
    if(this.signatures[key]===signature)return;
    const target=this.refs[key];if(!target)return;
    // Regions have stable structural signatures: live sliders are patched separately.
    const focused=target.contains(document.activeElement)?document.activeElement:null;
    const identity=focused?['data-id','data-action','data-control','data-key','name','aria-label','href','download'].filter(name=>focused.hasAttribute(name)).map(name=>[name,focused.getAttribute(name)]):[];
    this.signatures[key]=signature;target.innerHTML=markup;
    if(identity.length){const replacement=[...target.querySelectorAll('button,input,select,a,[tabindex]')].find(el=>identity.every(([name,value])=>el.getAttribute(name)===value));replacement?.focus({preventScroll:true});}
  }

  renderTracks(tracks,rate) {
    const signature=JSON.stringify(tracks.map(t=>[t.id,t.name,t.frames,t.role,t.color,t.peaks?.length,t.kind]));
    this.region('tracks',signature,tracks.map((t,i)=>`<article class="loop-card" data-track-id="${html(t.id)}" style="--track-color:${COLORS[i%COLORS.length]}"><div class="loop-card-top"><button class="track-select" data-action="select-track" data-id="${html(t.id)}"><span class="track-number">${String(i+1).padStart(2,'0')}</span><span><strong>${html(t.name||`Layer ${i+1}`)}</strong><small>${html(ROLE_NAMES[t.role]||'Loop')} · ${duration(t.frames,rate)}</small></span></button><button class="button icon-button track-edit" data-action="rename-track" data-id="${html(t.id)}" aria-label="Rename ${html(t.name||'layer')}" title="Rename layer">${icon('more')}</button></div><button class="waveform-button" data-action="select-track" data-id="${html(t.id)}" aria-label="Select ${html(t.name||'layer')} for mixing"><div class="waveform" data-waveform="${html(t.id)}">${this.waveform(t.peaks,i)}</div><div class="waveform-position" data-position="${html(t.id)}"></div></button><div class="loop-card-bottom"><div class="track-buttons"><button class="track-mode" data-action="mute" data-id="${html(t.id)}" aria-label="Mute ${html(t.name||'layer')}" aria-pressed="false">M</button><button class="track-mode" data-action="solo" data-id="${html(t.id)}" aria-label="Solo ${html(t.name||'layer')}" aria-pressed="false">S</button></div><label class="track-volume"><span class="sr-only">${html(t.name||'Layer')} volume</span>${icon('volume')}<input type="range" min="0" max="2" step="0.01" value="${clamp(t.mix?.volume??.8,0,2)}" data-control="mix" data-key="volume" data-id="${html(t.id)}" aria-label="${html(t.name||'Layer')} volume"></label><button class="button icon-button remove-track" data-action="remove-track" data-id="${html(t.id)}" aria-label="Remove ${html(t.name||'layer')}" title="Remove layer (can be undone)">${icon('close')}</button></div></article>`).join(''));
    for(const t of tracks){const el=[...this.refs.tracks.children].find(e=>e.dataset.trackId===t.id);if(!el)continue;el.classList.toggle('is-selected',this.state.selectedTrackId===t.id);el.classList.toggle('is-muted',!!t.muted);el.querySelector('[data-action="mute"]').setAttribute('aria-pressed',String(!!t.muted));el.querySelector('[data-action="solo"]').setAttribute('aria-pressed',String(!!t.solo));const volume=el.querySelector('input');this.patchInput(volume,t.mix?.volume??.8);volume.setAttribute('aria-valuetext',db(t.mix?.volume??.8));volume.style.setProperty('--range-progress',`${clamp(t.mix?.volume??.8,0,2)/2*100}%`);}
  }

  waveform(peaks,index=0) {
    let values=Array.isArray(peaks)||ArrayBuffer.isView(peaks)?Array.from(peaks):[];
    if(!values.length)return `<svg viewBox="0 0 400 70" preserveAspectRatio="none" aria-hidden="true"><path d="M0 35H400" stroke="currentColor" stroke-opacity=".3" stroke-width="1"/><text x="200" y="39" text-anchor="middle" fill="currentColor" font-size="9" letter-spacing="2">AUDIO LAYER</text></svg>`;
    const count=Math.min(100,values.length),bars=[];
    for(let i=0;i<count;i++){const v=values[Math.floor(i*values.length/count)];const peak=Array.isArray(v)?Math.max(...v.map(Math.abs)):Math.abs(finite(v));const h=Math.max(2,Math.min(60,peak*60));bars.push(`<rect x="${i*400/count}" y="${(70-h)/2}" width="${Math.max(1,400/count-1.6)}" height="${h}" rx="1"/>`);}
    return `<svg viewBox="0 0 400 70" preserveAspectRatio="none" fill="currentColor" aria-hidden="true">${bars.join('')}</svg>`;
  }

  renderSections(sections) {
    const signature=JSON.stringify(sections.map(s=>[s.id,s.name,Object.keys(s.tracks||{}).length]));
    this.region('sections',signature,sections.length?sections.map((s,i)=>`<div class="section-pad-wrap"><button class="section-pad" data-action="launch-section" data-id="${html(s.id)}"><span class="section-index">${String(i+1).padStart(2,'0')}</span><strong>${html(s.name)}</strong><span>${Object.keys(s.tracks||{}).length} layers</span></button><button class="section-delete" data-action="delete-section" data-id="${html(s.id)}" aria-label="Remove section ${html(s.name)}">${icon('close')}</button></div>`).join(''):'<div class="section-placeholder"><span>INTRO</span><span>VERSE</span><span>CHORUS</span></div>');
    for(const b of this.refs.sections.querySelectorAll('[data-action="launch-section"]')){b.classList.toggle('is-active',b.dataset.id===this.state.activeSectionId);b.classList.toggle('is-queued',b.dataset.id===this.state.queuedSectionId);b.setAttribute('aria-pressed',String(b.dataset.id===this.state.activeSectionId));}
  }

  renderSong(p,rate) {
    const performances=(p.performances||[]).filter(item=>!item.removed),takes=p.takes||[],damaged=this.damagedIds();
    this.renderDiscarded(this.state.discarded||[],rate);
    this.refs['performance-count'].textContent=`${performances.length} ${performances.length===1?'recording':'recordings'}`;
    this.region('performances',JSON.stringify(performances.map(x=>[x.id,x.name,x.frames,x.status,x.arrangementIncomplete,x.editableFrames,x.source,damaged.has(x.masterAssetId)])),performances.length?performances.slice().reverse().map((x,i)=>`<article class="performance-card" data-performance-id="${html(x.id)}"><div class="performance-art" aria-hidden="true">${icon('song')}</div><div class="performance-copy"><h3>${html(x.name||`Performance ${performances.length-i}`)}</h3><p>${duration(x.frames,rate)} · ${damaged.has(x.masterAssetId)?'Original audio is incomplete':x.arrangementIncomplete?'Original audio saved':x.status==='interrupted'||x.status==='recovered'?'Recovered recording':x.source==='loops'?'Loops only · stereo':'Full stereo performance'}${x.createdAt?` · ${this.date(x.createdAt)}`:''}</p>${x.arrangementIncomplete?`<p class="arrangement-limit">${finite(x.editableFrames)>0?`Edited arrangement available through ${time(x.editableFrames,rate)}.`:'No editable arrangement interval was retained.'}${damaged.has(x.masterAssetId)?'':' Full stereo WAV available.'}</p>`:''}</div><div class="performance-actions"><button class="button icon-button" data-action="preview-performance" data-performance-id="${html(x.id)}" aria-label="Listen to ${html(x.name||'performance')}">${icon('play')}</button><button class="button quiet" data-action="export-master" data-performance-id="${html(x.id)}" aria-label="Download ${html(x.name||'performance')} as WAV">${icon('download')}<span>WAV</span></button><button class="button icon-button performance-remove" data-action="delete-performance" data-performance-id="${html(x.id)}" aria-label="Remove ${html(x.name||'performance')}" title="Remove performance">${icon('trash')}</button></div></article>`).join(''):'<div class="quiet-empty">'+icon('song')+'<h3>Your song lives here.</h3><p>Choose “Record all the loops” for a song made of loops, or “Sing over loops” to add your voice.</p></div>');
    this.region('takes',JSON.stringify(takes.map(x=>[x.id,x.name,x.frames,damaged.has(x.assetId)])),takes.length?takes.slice().reverse().map((t,i)=>`<article class="take-card" data-take-id="${html(t.id)}"><div class="take-main"><button class="button icon-button" data-action="preview-take" data-id="${html(t.id)}" aria-label="Listen to ${html(t.name||'vocal take')} with recorded backing" title="Listen with recorded backing">${icon('play')}</button><button class="take-name" data-action="select-track" data-id="${html(t.id)}" aria-label="Mix ${html(t.name||'vocal take')}"><strong>${html(t.name||`Vocal take ${takes.length-i}`)}</strong><span>${duration(t.frames,rate)} · ${damaged.has(t.assetId)?'vocal audio is incomplete':'original vocal'}</span></button><button class="button icon-button" data-action="rename-take" data-id="${html(t.id)}" aria-label="Rename ${html(t.name||'vocal take')}">${icon('more')}</button><button class="button icon-button" data-action="delete-take" data-id="${html(t.id)}" aria-label="Remove ${html(t.name||'vocal take')}">${icon('trash')}</button></div><div class="take-footer"><label class="take-selection"><input type="checkbox" data-control="selected-take" data-id="${html(t.id)}"><span>Use in edited song</span></label><button class="text-button" data-action="layer-vocal" data-id="${html(t.id)}" title="Make a separate looping layer from this vocal">${icon('loop')}Turn into a loop</button></div></article>`).join(''):'<p class="help-copy empty-takes">Each continuous vocal is kept as a separate take, ready for another version.</p>');
    for(const el of this.refs.takes.children){const selected=el.dataset.takeId===p.selectedTakeId;el.classList.toggle('is-selected',selected);const input=el.querySelector('[data-control="selected-take"]');if(input)input.checked=selected;}
  }

  renderMixer(p,tracks) {
    const vocals=(p.takes||[]).map(t=>({...t,kind:'vocal',role:t.role||'lead',mix:{...LEAD_MIX,...t.mix}}));
    const channels=[...tracks,...vocals];
    const selected=channels.find(t=>t.id===this.state.selectedTrackId)||channels[0];
    this.region('mix-channels',JSON.stringify(channels.map(t=>[t.id,t.name,t.kind])),channels.length?`<label class="channel-selector">Selected sound<select data-control="selected-track">${channels.map(t=>`<option value="${html(t.id)}">${t.kind==='vocal'?'Vocal · ':''}${html(t.name)}</option>`).join('')}</select></label><div class="channel-pills">${channels.map((t,i)=>`<button class="channel-pill" style="--track-color:${t.kind==='vocal'?'#ffab91':COLORS[i%COLORS.length]}" data-action="select-track" data-id="${html(t.id)}">${t.kind==='vocal'?icon('mic'):String(i+1).padStart(2,'0')}<span>${html(t.name)}</span></button>`).join('')}</div>`:'');
    if(!selected){this.region('mix-console','empty','<div class="quiet-empty">'+icon('sliders')+'<h3>A little shape. A lot of feeling.</h3><p>Add your first loop to start shaping its sound.</p></div>');return;}
    const id=selected.id,isVocal=selected.kind==='vocal',m={volume:.8,pan:0,low:0,mid:0,high:0,highpass:40,compression:.25,reverb:.08,delay:0,...selected.mix};
    this.region('mix-console',`${id}:${selected.name}:${isVocal}`,`<div class="mixer-header"><div><span class="eyebrow">${isVocal?'VOCAL TAKE':'LAYER SOUND'}</span><h2>${html(selected.name)}</h2></div><label class="preset-picker">Starting sound<select data-control="role" data-id="${html(id)}">${ROLES.map(r=>`<option value="${r}">${ROLE_NAMES[r]}</option>`).join('')}</select></label></div>${isVocal?`<div class="vocal-mix-strip"><label class="take-selection"><input type="checkbox" data-control="selected-take" data-id="${html(id)}"><span>Use this vocal in the edited song</span></label><button class="text-button" data-action="preview-take" data-id="${html(id)}">${icon('headphones')}Original performance</button></div><p class="vocal-mix-note">Shape this take, then preview or export the edited mix to hear your changes. Your original performance stays available.</p>`:''}<div class="mixer-grid"><section class="mixer-group"><h3>Balance<span>01</span></h3>${slider({label:'Volume',key:'volume',value:m.volume,max:2,id,display:db(m.volume)})}${slider({label:'Pan',key:'pan',value:m.pan,min:-1,max:1,id,display:this.pan(m.pan)})}${slider({label:'Low cut',key:'highpass',value:m.highpass,min:20,max:2000,step:1,id,suffix:' Hz'})}</section><section class="mixer-group"><h3>Colour<span>02</span></h3>${slider({label:'Warmth · low EQ',key:'low',value:m.low,min:-18,max:18,step:.5,id,suffix:' dB'})}${slider({label:'Body · mid EQ',key:'mid',value:m.mid,min:-18,max:18,step:.5,id,suffix:' dB'})}${slider({label:'Air · high EQ',key:'high',value:m.high,min:-18,max:18,step:.5,id,suffix:' dB'})}</section><section class="mixer-group"><h3>Feel<span>03</span></h3>${slider({label:'Punch · compression',key:'compression',value:m.compression,id,display:`${Math.round(m.compression*100)}%`})}${slider({label:'Space · reverb',key:'reverb',value:m.reverb,id,display:`${Math.round(m.reverb*100)}%`})}${slider({label:'Echo · delay',key:'delay',value:m.delay,max:.75,id,display:`${Math.round(m.delay*100)}%`})}</section><section class="mixer-group timing-group"><h3>${isVocal?'Your original':'Timing'}<span>04</span></h3>${isVocal?`<p class="help-copy">Your ${duration(selected.frames,p.sampleRate)} vocal stays separate from the backing. Choose another take whenever you want.</p><button class="button quiet full-width" data-action="export-menu">${icon('headphones')}Preview edited mix</button><button class="text-button" data-action="layer-vocal" data-id="${html(id)}">Turn this vocal into a loop${icon('loop')}</button>`:`<p class="help-copy">Nudge this layer into the pocket without changing your recording.</p><div class="nudge-buttons"><button class="button quiet" data-action="nudge" data-id="${html(id)}" data-ms="-5">−5 ms</button><button class="button quiet" data-action="nudge" data-id="${html(id)}" data-ms="5">+5 ms</button></div><p class="nudge-value" data-ref-offset>Offset: 0 ms</p>`}<button class="text-button" data-action="export-track" data-id="${html(id)}">Download original ${isVocal?'vocal':'layer'}${icon('download')}</button></section></div>`);
    for(const input of this.refs['mix-console'].querySelectorAll('input[data-control="mix"]')){this.patchInput(input,m[input.dataset.key]);this.displayRange(input);}
    const role=this.refs['mix-console'].querySelector('[data-control="role"]');this.patchInput(role,selected.role||'beat');
    const takeCheck=this.refs['mix-console'].querySelector('[data-control="selected-take"]');if(takeCheck)takeCheck.checked=id===p.selectedTakeId;
    const offset=this.refs['mix-console'].querySelector('[data-ref-offset]');if(offset)offset.textContent=`Offset: ${(finite(selected.offsetFrames)/(p.sampleRate||48000)*1000).toFixed(1)} ms`;
    this.patchInput(this.refs['mix-channels'].querySelector('select'),id);
    for(const pill of this.refs['mix-channels'].querySelectorAll('.channel-pill')){pill.classList.toggle('is-active',pill.dataset.id===id);pill.setAttribute('aria-pressed',String(pill.dataset.id===id));}
  }

  renderInput(p) {
    this.region('input-controls','input',slider({label:'Input gain',key:'gain',value:p.input?.gain??1,max:4,scope:'input',display:db(p.input?.gain??1)}));
    this.region('master-controls','master',slider({label:'Master volume',key:'volume',value:p.master?.volume??.8,max:2,scope:'master',display:db(p.master?.volume??.8)}));
    for(const [scope,value] of [['input',p.input?.gain??1],['master',p.master?.volume??.8]]){const input=this.root.querySelector(`input[data-control="${scope}"]`);this.patchInput(input,value);this.displayRange(input);}
    const monitor=this.root.querySelector('[data-control="monitor"]');monitor.checked=!!(this.state.monitor??p.input?.monitor);
    this.patchInput(this.root.querySelector('[data-control="compensation"]'),p.input?.compensationMs??0);
  }

  renderMetronome(p) {
    const settings={enabled:false,bpm:100,beatsPerCycle:4,countInBeats:0,volume:.25,...p.metronome};
    this.region('metronome-controls','metronome',`<h3>Click &amp; count-in</h3><label class="toggle-row"><span>Play a reference click</span><input type="checkbox" data-control="metronome-enabled" role="switch" aria-label="Play a reference click"><span class="toggle" aria-hidden="true"></span></label><label class="number-field metronome-tempo">Tempo<span><input type="number" min="40" max="240" step="0.1" value="100" data-control="metronome-bpm" aria-label="Metronome tempo in beats per minute">BPM</span></label><p class="help-copy" data-metronome-tempo-help></p><label class="metronome-select">Beats per cycle<select data-control="metronome-beats">${Array.from({length:16},(_,i)=>`<option value="${i+1}">${i+1} ${i?'beats':'beat'}</option>`).join('')}</select></label><label class="metronome-select">First-loop count-in<select data-control="metronome-count"><option value="0">Off · record immediately</option><option value="4">4 beats</option><option value="8">8 beats</option></select></label><p class="help-copy" data-metronome-count-help></p>${slider({label:'Click volume',key:'volume',scope:'metronome',value:.25,min:.025,max:1,step:.025,display:'−12 dB'})}<p class="help-copy metronome-note">Use headphones. The reference click stays out of your exported song.</p>`);
    const target=this.refs['metronome-controls'],locked=!!this.state.readonly||!!this.state.busy||!!this.state.capture||!!this.state.exporting,hasCycle=finite(p.baseFrames)>0;
    const enabled=target.querySelector('[data-control="metronome-enabled"]');enabled.checked=!!settings.enabled;enabled.disabled=locked||this.state.capabilities?.audio===false;
    const tempo=target.querySelector('[data-control="metronome-bpm"]');this.patchInput(tempo,hasCycle?Number((60*(p.sampleRate||48000)*settings.beatsPerCycle/p.baseFrames).toFixed(2)):settings.bpm);tempo.readOnly=hasCycle;tempo.disabled=locked;tempo.setAttribute('aria-readonly',String(hasCycle));
    const beats=target.querySelector('[data-control="metronome-beats"]');this.patchInput(beats,settings.beatsPerCycle);beats.disabled=locked;
    const count=target.querySelector('[data-control="metronome-count"]');this.patchInput(count,settings.countInBeats);count.disabled=locked||hasCycle||(p.tracks?.length||0)>0;
    const volume=target.querySelector('input[data-control="metronome"]');this.patchInput(volume,settings.volume);volume.disabled=locked;this.displayRange(volume);
    target.querySelector('[data-metronome-tempo-help]').textContent=hasCycle?'Calculated from your loop length and beats per cycle. This does not change the speed of your recording.':'Set a tempo for the click before recording your first loop.';
    target.querySelector('[data-metronome-count-help]').textContent=hasCycle?'Later layers start on the next cycle. Count-in is only for a project’s first free loop.':'Hear a short count-in before your first free loop starts. No count-in is added to the recording.';
  }

  renderMicrophonePicker() {
    const s=this.state,seen=new Set(['','default']),devices=(s.micDevices||[]).filter(device=>{if(!device?.id||seen.has(device.id))return false;seen.add(device.id);return true;});
    const preferred=s.preferredDeviceId||'',missing=preferred&&!devices.some(device=>device.id===preferred);
    this.region('microphone-picker',JSON.stringify([devices,missing?preferred:'']),`<label class="microphone-device-label">Microphone input<select data-control="microphone-device" aria-label="Microphone input"><option value="">System default</option>${devices.map((device,i)=>`<option value="${html(device.id)}">${html(device.label||`Microphone ${i+1}`)}</option>`).join('')}${missing?`<option value="${html(preferred)}">Previously selected input · unavailable</option>`:''}</select></label><p class="help-copy" data-microphone-hint></p>`);
    const target=this.refs['microphone-picker'],select=target.querySelector('select');
    // Restore the actual selection after a failed device switch, including focus.
    select.value=preferred;
    select.disabled=!!s.capture||!!s.busy||!!s.exporting||!!s.readonly||!!s.storageFailed||!!s.micChanging||!s.micEnabled&&!devices.length;
    target.querySelector('[data-microphone-hint]').textContent=s.micChanging?'Connecting the selected microphone…':missing?'This input is unavailable. Choose another microphone or the system default.':!s.micEnabled&&!devices.length?'Connect your microphone first to choose an input.':'Choose the microphone you want to record. Input choice is remembered only for this session.';
  }

  renderPreview(preview) {
    const panel=this.refs['preview-panel'],audio=this.refs['preview-audio'],preparing=this.state.previewPreparing;
    panel.hidden=!preview?.url&&!preparing;panel.setAttribute('aria-busy',String(!!preparing));
    this.refs['preview-kind'].textContent=preparing?'PREPARING AUDIO':'LISTEN BACK';
    this.refs['preview-loading'].hidden=!preparing;audio.hidden=!!preparing;
    this.refs['preview-name'].textContent=preparing?.name||preview?.name||'Your performance';
    if(!preview?.url){this.previewPlaying=false;if(audio.hasAttribute('src')){audio.pause();audio.removeAttribute('src');audio.load();}return;}
    if(audio.getAttribute('src')!==preview.url){audio.src=preview.url;audio.load();panel.scrollIntoView({block:'nearest'});}
  }

  renderAudition(audition,frame=0) {
    this.refs['audition-panel'].hidden=!audition||!!this.state.capture;
    if(!audition)return;
    const take=this.state.project?.takes?.find(t=>t.id===audition.id),rate=this.state.sampleRate||48000,elapsed=Math.max(0,finite(frame)-finite(audition.startFrame)),length=Math.max(1,finite(audition.endFrame)-finite(audition.startFrame));
    this.refs['audition-name'].textContent=audition.status==='loading'?'Preparing your vocal…':`${take?.name||'Selected vocal'} · live mix`;
    this.refs['audition-time'].textContent=audition.status==='loading'?'Loading':elapsed>=length?'Final echoes':`${time(elapsed,rate)} / ${time(length,rate)}`;
    this.refs['audition-progress'].style.width=`${clamp(elapsed/length*100,0,100)}%`;
  }

  isSavedMix(asset) {
    return asset.kind==='mix'&&!asset.needsRecovery&&['complete','interrupted','recovered'].includes(asset.status);
  }

  renderSavedMixes(assets,rate) {
    const mixes=assets.filter(asset=>this.isSavedMix(asset)).slice().reverse();
    this.refs['saved-mixes'].hidden=!mixes.length;
    this.region('saved-mixes',JSON.stringify(mixes.map(a=>[a.id,a.name,a.frames,a.channels,a.status])),mixes.length?`<div class="section-heading compact"><h2>Saved mixes</h2><span class="quiet-label">${mixes.length} ${mixes.length===1?'mix':'mixes'}</span></div><div class="performance-list">${mixes.map(a=>`<article class="performance-card saved-mix-card" data-asset-id="${html(a.id)}"><div class="performance-art" aria-hidden="true">${icon('sliders')}</div><div class="performance-copy"><h3>${html(a.name||'Saved mix')}</h3><p>${duration(a.frames,a.sampleRate||rate)} · Saved edited mix · ${a.channels===2?'stereo':'mono'}</p></div><div class="performance-actions"><button class="button quiet" data-action="export-recovered" data-id="${html(a.id)}" aria-label="Download ${html(a.name||'saved mix')}">${icon('download')}<span>WAV</span></button><button class="button icon-button performance-remove" data-action="delete-saved-mix" data-id="${html(a.id)}" aria-label="Delete ${html(a.name||'saved mix')}" title="Delete saved mix">${icon('trash')}</button></div></article>`).join('')}</div>`:'');
  }

  renderStorageRecordings() { this.renderStorageFiles(); }

  renderStorageFiles() {
    const target=this.refs.dialog.open&&this.refs.dialog.querySelector('[data-storage-file-list]');
    if(!target)return;
    const inventory=this.storageInventory||{},all=inventory.files||[],query=(this.storageSearch||'').trim().toLowerCase(),filter=this.storageFilter||'all';
    const retained=new Map((this.state.recovered||[]).filter(a=>!this.isSavedMix(a)).map(a=>[a.id,a]));
    const files=all.filter(f=>(filter==='all'||filter==='audio'&&f.kind!=='cache'||filter==='cache'&&f.kind==='cache'||filter==='orphan'&&(f.kind.startsWith('orphan')||f.kind==='asset'&&!f.referencedProjectIds?.length))&&(!query||`${f.name} ${f.projectName||''} ${f.id}`.toLowerCase().includes(query))).slice().sort((a,b)=>(b.bytes??-1)-(a.bytes??-1)||String(a.name).localeCompare(String(b.name)));
    const signature=JSON.stringify([files,query,filter,[...retained.keys()],this.state.readonly,this.state.storage?.locking]);
    if(target.dataset.signature===signature)return;
    const focused=target.contains(document.activeElement)?document.activeElement:null;
    const fileKey=focused?.dataset.fileKey,action=focused?.dataset.action;
    target.dataset.signature=signature;
    this.refs.dialog.querySelector('[data-storage-file-count]').textContent=`${files.length} of ${all.length} files`;
    target.innerHTML=files.length?files.map(file=>{
      const saved=retained.get(file.id),restorable=file.kind==='asset'&&saved;
      const source=file.kind==='cache'?'Offline app file':file.kind.startsWith('orphan')?'Unindexed audio':file.status==='recording'?'Unfinished recording':restorable?'Retained recording':file.assetKind==='mix'?'Saved edited mix':file.referencedProjectIds?.length?'Used by a project':'Saved audio';
      const unavailable=this.state.storage?.locking===false&&file.kind!=='cache';
      const download=file.kind==='asset'&&!file.missing&&file.status!=='recording';
      return `<article class="storage-file-row ${restorable?'recovery-card':''}" data-file-key="${html(file.key)}" data-asset-id="${html(file.id)}" data-file-bytes="${file.bytes??'unknown'}"><div class="storage-file-copy"><h3>${html(file.name||file.id)}</h3><p>${html(file.projectName||'No project')} · ${source}</p><small>${html(file.kind==='cache'?file.cacheName:`${file.backend||'stored audio'} · ${file.id}`)}</small>${file.missing?'<small class="storage-file-warning">Audio file is missing; metadata remains.</small>':''}</div><div class="storage-file-size"><strong>${storageSize(file.bytes)}</strong><span>${storageBytes(file.bytes)}</span></div><div class="storage-file-actions">${download?`<button type="button" class="button quiet" data-action="download-storage-file" data-file-key="${html(file.key)}" aria-label="Download ${html(file.name||file.id)}">${icon('download')}<span>WAV</span></button>`:''}${restorable&&(saved.needsRecovery||saved.channels!==2||saved.source==='loops')?`<button type="button" class="button quiet" data-action="recover-asset" data-id="${html(file.id)}">${icon('plus')}<span>${saved.needsRecovery?'Recover audio':'Keep in project'}</span></button>`:''}<button type="button" class="button icon-button storage-file-delete" data-action="delete-storage-file" data-file-key="${html(file.key)}" aria-label="Permanently delete ${html(file.name||file.id)}" title="${unavailable?'This browser cannot safely coordinate file deletion across tabs':'Permanently delete this file'}" data-unavailable="${unavailable}" ${unavailable?'disabled':''}>${icon('trash')}</button></div></article>`;
    }).join(''):'<p class="quiet-empty storage-no-files">No files match this view.</p>';
    if(focused&&!focused.isConnected){const replacement=[...target.querySelectorAll('button')].find(el=>el.dataset.fileKey===fileKey&&el.dataset.action===action);(replacement||this.refs['dialog-title']).focus({preventScroll:true});}
  }

  showDownloadParts(downloads,label) {
    if(!downloads.length)return;
    this.showDialog(`Download ${label||'recording'}`,`<p class="dialog-copy">This recording is split into numbered WAV files. Download every part to keep all the available audio.</p><div class="download-links" role="region" aria-label="Parts of this recording" tabindex="0">${downloads.map(d=>`<a class="ready-download" href="${html(d.url)}" download="${html(d.filename||'recording.wav')}">${icon('download')}<span>Part ${finite(d.part,1)}${finite(d.partCount)>0?` of ${finite(d.partCount)}`:''}<small>${html(d.filename||'')}</small></span></a>`).join('')}</div>`,`<button class="button primary" value="close">Done</button>`);
  }

  damagedIds() {return new Set((this.state.damagedAudio||[]).map(asset=>asset.assetId));}

  renderDamaged(assets,rate) {
    const target=this.refs.damaged;target.hidden=!assets.length;
    this.region('damaged',JSON.stringify(assets.map(a=>[a.assetId,a.name,a.reason,a.expectedFrames,a.availableFrames,a.sampleRate,a.prefixAvailable])),assets.length?`<div class="damaged-heading"><h2>Some source audio is incomplete.</h2><p>Your song’s timing has been kept. Download any available incomplete audio below, or restore a valid project backup. Intact original recordings remain available. A complete project backup cannot be made while source audio is missing or damaged.</p></div><div class="damaged-list">${assets.map(a=>`<article class="damaged-card"><div><h3>${html(a.name||'Source recording')}</h3><p>${a.reason==='missing'?'Audio is missing':a.reason==='unsealed'?'Audio recovery is unfinished':'Audio is incomplete or damaged'}${finite(a.expectedFrames)>0?` · expected ${duration(a.expectedFrames,a.sampleRate||rate)}`:''}</p><small>${a.prefixAvailable?`${duration(a.availableFrames,a.sampleRate||rate)} of audio is available. This download is incomplete.`:'No verified audio download is available for this source.'}</small></div>${a.prefixAvailable?`<button class="button quiet" data-action="export-damaged-audio" data-id="${html(a.assetId)}" aria-label="Download incomplete audio from ${html(a.name||'source recording')}">${icon('download')}<span>Download incomplete audio</span></button>`:''}</article>`).join('')}</div>`:'');
  }

  renderDiscarded(assets,rate) {
    const target=this.refs.discarded;target.hidden=!assets.length;
    const locked=!!this.state.capture||!!this.state.busy||!!this.state.exporting||!!this.state.readonly||!!this.state.storageFailed;
    this.region('discarded',JSON.stringify(assets.map(a=>[a.id,a.name,a.kind,a.frames,a.sampleRate])),assets.length?`<div class="discarded-heading"><h2>Finish storage cleanup</h2><p>You discarded these recordings. Delete their remaining audio files to free space on this device.</p></div><div class="discarded-list">${assets.map(a=>`<article class="discarded-card" data-discarded-id="${html(a.id)}"><div><h3>${html(a.name||'Discarded recording')}</h3><p>Discarded recording · storage cleanup pending</p>${finite(a.frames)>0?`<small>${duration(a.frames,a.sampleRate||rate)}</small>`:''}</div><button class="button quiet" data-action="delete-discarded" data-id="${html(a.id)}" aria-label="Delete discarded recording ${html(a.name||'')}" ${locked?'disabled':''}>${icon('trash')}<span>Delete discarded recording</span></button></article>`).join('')}</div>`:'');
    target.querySelectorAll('[data-action="delete-discarded"]').forEach(button=>button.disabled=locked);
  }

  updateExportProgress(progress={}) {
    const ratio=progress.totalFrames?finite(progress.completedFrames)/progress.totalFrames:progress.total?finite(progress.bytes)/progress.total:0;
    const percent=Math.round(clamp(ratio*100,0,100));
    const title=({warming:'Preparing the sound',rendering:'Rendering your edited song',tail:'Keeping the final echoes',hashing:'Preparing your project backup',validating:'Checking your project backup',importing:'Restoring your project',complete:'Your file is ready'})[progress.phase]||'Preparing your audio…';
    this.refs['export-title'].textContent=title;
    this.refs['export-caption'].textContent=progress.totalFrames||progress.total?`${percent}%${progress.assets?` · audio ${progress.asset||progress.assets} of ${progress.assets}`:''}`:'Your recordings remain safe while this file is prepared.';
    this.refs['export-progress'].style.width=`${percent}%`;
    if(progress.totalFrames||progress.total)this.refs['export-progressbar'].setAttribute('aria-valuenow',String(percent));else this.refs['export-progressbar'].removeAttribute('aria-valuenow');
  }

  renderDock(capture,tracks,rate) {
    const active=!!capture,status=capture?.status;
    this.refs['dock-loop'].hidden=active;this.refs['dock-sing'].hidden=active;this.refs['dock-mix'].hidden=active;this.root.classList.toggle('has-loop-record-control',!active);this.refs['dock-finish'].hidden=!active||status!=='recording';this.refs['dock-cancel'].hidden=!active;
    this.refs['dock-finish'].disabled=status==='finishing';
    this.refs['dock-cancel'].disabled=status==='finishing';
    this.refs['dock-light'].className=`dock-light${active?' is-recording':this.state.playing?' is-playing':''}`;
    this.root.classList.toggle('is-recording',status==='recording');
    let label='Start with a sound.',caption='Your first loop is the beginning.';
    if(tracks.length){label=this.state.playing?'Your world is playing.':'The groove is ready.';caption='Add a layer, or sing something new.';}
    if(!tracks.length&&this.state.playing&&this.state.project?.metronome?.enabled){label='Find your rhythm.';caption='The reference click is playing. Add a loop when you are ready.';}
    if(this.previewPlaying&&!capture){label='Listening to your performance.';caption='Your original recording, just as you made it.';}
    if(this.state.previewPreparing&&!capture){label='Preparing your recording.';caption='Your original performance will play shortly. Stop cancels this.';}
    if(this.state.audition&&!capture){label=this.state.audition.status==='loading'?'Preparing your live mix.':'Hear the feeling take shape.';caption='Selected vocal + current layers. Adjust the mixer as it plays.';}
    if(status==='arming'){label=capture.kind==='mix'?'Your loops are queued.':capture.kind==='vocal'?'Your vocal is queued.':'Your next layer is queued.';caption='Starting on the next loop boundary. Cancel anytime.';}
    if(status==='counting'){label=`Count in · ${Math.max(1,finite(capture.countInBeat,1))} of ${finite(capture.countInBeats,4)}`;caption='Get ready. Your first loop starts after the count.';}
    if(capture?.waitingForMic){label='Waiting for your microphone.';caption='Allow microphone access in your browser. Stop cancels this request.';}
    if(status==='recording'){label=capture.kind==='mix'?'Your loops are becoming a song.':capture.kind==='vocal'?'This is your moment.':'A new layer is taking shape.';caption=`Recording ${time(capture.elapsedFrames,rate)}${capture.targetFrames?` / ${time(capture.targetFrames,rate)}`:' · finish when you are ready'}`;}
    if(status==='finishing'){label='Keeping your recording safe.';caption='Finishing the audio and saving your take…';}
    if(this.state.busy&&!active){label=this.state.message||'Getting things ready…';caption='Stop remains available.';}
    this.refs['dock-label'].textContent=label;this.refs['dock-caption'].textContent=caption;
    const finishText=this.refs['dock-finish'].querySelector('span');finishText.textContent=capture?.targetFrames?'Finish at boundary':'Finish recording';
    const cancelText=this.refs['dock-cancel'].querySelector('span');cancelText.textContent=status==='recording'?'Discard':'Cancel';
    const recent=this.recentRecording(),loopMix=capture?.kind==='mix'||(!active&&recent?.source==='loops');
    const symbol=loopMix?'layers':'mic';
    if(this.captureSymbol!==symbol){this.refs['capture-symbol'].innerHTML=icon(symbol);this.captureSymbol=symbol;}
    this.refs['capture-panel'].hidden=false;
    this.refs['capture-panel'].dataset.status=status||'idle';
    this.refs['capture-title'].textContent=capture?.waitingForMic?'Let your browser hear you':status==='arming'?'Ready for the next cycle':status==='finishing'?'Saving your sound':capture?.kind==='mix'?'Recording all your loops':capture?.kind==='vocal'?'Recording your performance':tracks.length?'Recording a new layer':'Recording your first loop';
    this.refs['capture-hint'].textContent=capture?.waitingForMic?'Choose Allow in the microphone permission prompt. You can cancel here at any time.':status==='arming'?'Your groove keeps moving. Your recording starts at the next boundary.':status==='finishing'?'Keeping the original audio and your project together.':capture?.kind==='mix'?'Every unmuted loop, together. Change mutes or the mix as you play. No microphone audio is recorded.':capture?.kind==='vocal'?(tracks.length?'Keep singing. Your loops are carrying the song underneath.':'Let the vocal run. Finish whenever you are ready.'):capture?.targetFrames?'This layer finishes automatically at the end of its chosen cycles.':'Make your sound. Finish whenever it feels right.';
    this.refs['capture-time'].textContent=time(capture?.elapsedFrames,rate);
    this.refs['capture-time'].setAttribute('aria-label','Recording duration');
    this.refs['capture-progress'].style.width=capture?.targetFrames?`${clamp(capture.elapsedFrames/capture.targetFrames*100,0,100)}%`:'0%';
    if(status==='counting'){
      const beat=Math.max(1,finite(capture.countInBeat,1)),total=Math.max(1,finite(capture.countInBeats,4)),remaining=Math.max(0,finite(capture.remainingFrames)/rate);
      this.refs['capture-title'].textContent='Feel the rhythm. Then make it yours.';
      this.refs['capture-hint'].textContent=`Beat ${beat} of ${total} · recording starts in ${remaining.toFixed(1)} seconds. Cancel or Stop at any time.`;
      this.refs['capture-time'].textContent=`${beat} / ${total}`;
      this.refs['capture-time'].setAttribute('aria-label',`Count-in beat ${beat} of ${total}`);
      this.refs['capture-progress'].style.width=`${clamp(beat/total*100,0,100)}%`;
    }
    const captureId=capture?.id||capture?.captureId;
    if(status==='recording'&&captureId&&this.liveCaptureId!==captureId){this.liveInput.reset();this.liveCaptureId=captureId;}
    const showHistory=(status==='recording'&&captureId===this.liveCaptureId)||(status==='finishing'&&captureId===this.liveCaptureId)||(!active&&recent&&!!this.liveCaptureId&&this.liveCaptureId===this.state.recentRecording?.captureId);
    this.refs['capture-live'].hidden=false;
    if(!showHistory){this.liveInput.reset();this.liveCaptureId=null;}
    this.refs['capture-live-label'].textContent=status==='recording'?(loopMix?'LIVE LOOPS':'LIVE MIC'):showHistory?(loopMix?'RECORDED LOOPS':'RECORDED MIC'):recent?'LATEST RECORDING BELOW':'MIC INPUT';
    this.refs['capture-live'].setAttribute('aria-label',loopMix?'Loop recording level history':'Microphone input history');
    this.refs['capture-progress'].parentElement.hidden=!active||(!capture?.targetFrames&&status!=='counting');
    if(!active&&!recent){
      this.refs['capture-title'].textContent='Your recorder is ready';
      this.refs['capture-hint'].textContent='Record a loop, sing, or record all your loops together. Your recording will appear here when you finish.';
    }
    if(!active&&recent){
      this.refs['capture-panel'].dataset.status='saved';
      this.refs['capture-title'].textContent=recent.status==='interrupted'?'Saved recording · interrupted':recent.source==='loops'?'Loops recorded':this.state.recentRecording.kind==='performance'?'Performance recorded':'Loop recorded';
      this.refs['capture-hint'].textContent='Your sound is ready below. Listen here, or keep creating.';
      this.refs['capture-time'].textContent=time(recent.frames,rate);
      this.refs['capture-time'].setAttribute('aria-label','Saved recording duration');
    }
    if(!active)this.autoCaptureFocus=false;
    else if(status==='recording'&&this.autoCaptureFocus){
      this.autoCaptureFocus=false;
      if(document.activeElement===this.refs['dock-cancel']&&!this.refs.dialog.open&&!this.refs['dock-finish'].disabled)this.refs['dock-finish'].focus({preventScroll:true});
    }
  }

  recentRecording() {
    const recent=this.state.recentRecording,p=this.state.project;
    return recent?.kind==='performance'?p?.performances?.find(item=>item.id===recent.id&&!item.removed):recent?.kind==='loop'?p?.tracks?.find(item=>item.id===recent.id):null;
  }

  renderRecentRecording(rate) {
    const recording=this.recentRecording(),target=this.refs['recent-recording'];
    target.hidden=!recording;
    if(!recording)return;
    const performance=this.state.recentRecording.kind==='performance',name=html(recording.name),recordId=html(recording.id);
    this.region('recent-recording',JSON.stringify([recording.id,recording.name,recording.frames,recording.status,recording.source]),`<article class="recent-recording-card" data-recording-id="${recordId}"><div class="recent-recording-copy"><span class="eyebrow">LATEST RECORDING</span><h2>${name}</h2><p>${duration(recording.frames,rate)} · ${performance?(recording.source==='loops'?'Loops only · stereo':'Voice + backing · stereo'):'Original loop'}${recording.status==='interrupted'?' · saved portion':''}</p></div><div class="performance-actions"><button class="button primary" data-action="${performance?'preview-performance':'preview-track'}" ${performance?'data-performance-id':'data-id'}="${recordId}" aria-label="Listen to ${name}">${icon('play')}Listen</button><button class="button quiet" data-action="${performance?'export-master':'export-track'}" ${performance?'data-performance-id':'data-id'}="${recordId}" aria-label="Download ${name}">${icon('download')}WAV</button>${performance?`<button class="button icon-button performance-remove" data-action="delete-performance" data-performance-id="${recordId}" aria-label="Remove ${name}" title="Remove performance">${icon('trash')}</button>`:''}</div></article>`);
  }

  updateLiveInput(data={}) {
    if(data.capture?.status!=='recording')return;
    const captureId=data.capture.id||data.capture.captureId;
    if(this.liveCaptureId!==captureId){this.liveInput.reset();this.liveCaptureId=captureId;}
    this.liveInput.update(data.capture.kind==='mix'?{inputLevel:data.captureLevel,inputRms:data.captureRms}:data);
  }

  updateMeters(data={}) {
    for(const [name,raw] of [['input',data.inputLevel??data.input],['output',data.outputLevel??data.output]]){
      const v=clamp(typeof raw==='object'?raw.peak:raw,0,4),level=v>0?clamp((20*Math.log10(v)+60)/60,0,1):0;
      const meter=this.refs[`${name}-meter`];if(meter){meter.style.width=`${level*100}%`;meter.classList.toggle('is-hot',v>.94);}
      const label=this.refs[`${name}-db`];if(label)label.textContent=v>.0001?`${Math.round(20*Math.log10(v))}`:'−∞';
    }
  }

  updateTransport(data={}) {
    if(data.playing!==undefined)this.root.dataset.playing=String(!!data.playing);
    if(data.capture?.status)this.root.dataset.captureState=data.capture.status;
    const p=this.state.project||{},frame=finite(data.transportFrame??data.projectFrame??data.frame),rate=finite(data.sampleRate||this.state.sampleRate||p.sampleRate,48000),base=finite(data.baseFrames??p.baseFrames);
    this.refs['transport-label'].textContent=this.state.audition?'LIVE MIX':'THE GROOVE';
    this.renderAudition(this.state.audition,frame);
    this.refs['transport-time'].textContent=time(frame,rate);
    this.refs['cycle-progress'].style.width=base?`${(frame%base)/base*100}%`:'0%';
    this.refs['cycle-position'].textContent=base?`CYCLE ${Math.floor(frame/base)+1}`:'FREE';
    const markers=new Map([...this.refs.tracks.querySelectorAll('[data-position]')].map(el=>[el.dataset.position,el]));
    for(const t of p.tracks||[]){const marker=markers.get(t.id);if(marker)marker.style.left=`${t.frames?((frame-finite(t.offsetFrames))%t.frames+t.frames)%t.frames/t.frames*100:0}%`;}
    if(this.state.capture&&data.capture){this.state.capture={...this.state.capture,...data.capture};this.renderDock(this.state.capture,p.tracks||[],rate);}
  }

  patchInput(input,value) {if(input&&input!==document.activeElement)input.value=value;}
  pan(value) {const n=finite(value);return Math.abs(n)<.01?'Centre':`${Math.round(Math.abs(n)*100)}% ${n<0?'L':'R'}`;}
  displayRange(el) {const out=el.closest('.slider-field')?.querySelector('output');if(!out)return;const k=el.dataset.key,v=Number(el.value);out.textContent=k==='volume'||k==='gain'?db(v):k==='pan'?this.pan(v):k==='highpass'?`${Math.round(v)} Hz`:['low','mid','high'].includes(k)?`${v>0?'+':''}${v} dB`:`${Math.round(v*100)}%`;el.setAttribute('aria-valuetext',out.textContent);el.style.setProperty('--range-progress',`${(v-Number(el.min))/(Number(el.max)-Number(el.min))*100}%`);}
  date(value){try{return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(new Date(value));}catch{return '';}}

  notify(message,kind='info') {
    for(const prior of this.refs.toasts.children){if(prior.querySelector('span')?.textContent===String(message))return;}
    if(kind!=='error')this.refs.toasts.querySelectorAll('.toast:not(.toast-error)').forEach(el=>el.remove());
    const el=document.createElement('div');el.className=`toast toast-${['error','warning','success'].includes(kind)?kind:'info'}`;el.setAttribute('role',kind==='error'?'alert':'status');
    const text=document.createElement('span');text.textContent=String(message);const close=document.createElement('button');close.className='toast-close';close.setAttribute('aria-label','Dismiss notification');close.innerHTML=icon('close');close.addEventListener('click',()=>el.remove());el.append(text,close);this.refs.toasts.append(el);
    while(this.refs.toasts.children.length>2)this.refs.toasts.firstElementChild.remove();
    if(kind!=='error')setTimeout(()=>el.remove(),kind==='warning'?10000:6000);
  }

  showDialog(title,body,actions='') {
    const d=this.refs.dialog;d.classList.remove('storage-dialog');
    this.settleDialog('cancel');
    if(!d.contains(document.activeElement))this.dialogOpener=document.activeElement;
    if(d.open)d.close('cancel');
    d.returnValue='cancel';this.refs['dialog-title'].textContent=title;this.refs['dialog-body'].innerHTML=body;this.refs['dialog-actions'].innerHTML=actions;this.refs['dialog-stop'].hidden=!(this.state.playing||this.state.capture||this.state.previewPreparing||(this.state.preview&&!this.refs['preview-audio'].paused));d.showModal();d.scrollTop=0;this.refs['dialog-title'].focus();return d;
  }

  settleDialog(value) {const pending=this.dialogRequest;this.dialogRequest=null;pending?.(value);}

  confirm(options={}) {
    return new Promise(resolve=>{const d=this.showDialog(options.title||'Are you sure?',`<p class="dialog-copy">${html(options.message||'')}</p>`,`<button type="button" class="button quiet" data-dialog-close>Cancel</button><button class="button ${options.danger?'danger':'primary'}" value="confirm">${html(options.confirmLabel||'Continue')}</button>`);this.dialogRequest=value=>resolve(value==='confirm');d.querySelector('.dialog-actions [data-dialog-close]').focus();});
  }

  prompt(options={}) {
    return new Promise(resolve=>{const d=this.showDialog(options.title||'Give it a name',`${options.message?`<p class="dialog-copy">${html(options.message)}</p>`:''}<label class="dialog-field">${html(options.label||'Name')}<input type="text" name="prompt-value" maxlength="120" value="${html(options.value||'')}" autocomplete="off" required autofocus></label>`,`<button type="button" class="button quiet" data-dialog-close>Cancel</button><button class="button primary" value="confirm">${html(options.confirmLabel||'Save')}</button>`);const input=d.querySelector('input');input.focus();input.select();this.dialogRequest=value=>resolve(value==='confirm'?input.value.trim().slice(0,120)||null:null);});
  }

  showProjects() {
    const p=this.state.project,projects=(this.state.projects||[]).map(x=>x.id===p?.id?{...x,...p}:x);
    this.showDialog('Your projects',`<p class="dialog-copy">Projects are saved in this browser. Download a backup to keep a copy elsewhere.</p><div class="project-list">${projects.length?projects.map(x=>`<button type="button" class="project-row ${x.id===p?.id?'is-current':''}" data-action="open-project" data-id="${html(x.id)}">${icon('folder')}<span><strong>${html(x.name||'Untitled session')}</strong><small>${this.date(x.updatedAt||x.createdAt)}${x.id===p?.id?' · Current project':''}</small></span>${icon('arrow')}</button>`).join(''):'<p class="help-copy">Your current session is your first project.</p>'}</div>`,`<button type="button" class="button quiet" data-action="import-project">${icon('upload')}Restore backup</button><button type="button" class="button primary" data-action="new-project">${icon('plus')}New project</button>`);
  }

  showStorageManager(rows=[],storage={},inventory={}) {
    this.storageInventory=inventory;this.storageFilter||='all';this.storageSearch||='';
    const currentId=this.state.project?.id,capacity=normalizedStorageCapacity(storage),locked=!!this.state.capture||!!this.state.busy||!!this.state.exporting,backupBlocked=locked||!!this.state.damagedAudio?.length||!!this.state.deletionPending;
    const card=(label,value,note='')=>`<div class="storage-capacity-card"><span>${label}</span><strong>${storageSize(value)}</strong><small>${storageBytes(value)}</small>${note?`<p>${note}</p>`:''}</div>`;
    const rate=this.state.project?.sampleRate||48000,seconds=capacity.known?capacity.remaining/(rate*8):null;
    const timeLeft=seconds===null?'':seconds>=3600?`${Math.floor(seconds/3600)}h ${Math.floor(seconds%3600/60)}m`:seconds>=60?`${Math.floor(seconds/60)}m ${Math.floor(seconds%60)}s`:`${Math.floor(seconds)}s`;
    this.showDialog('Storage',`<div data-storage-manager><div class="storage-capacity-grid" data-storage-summary><div class="storage-capacity-card storage-capacity-primary"><span>Available recording space · estimate</span><strong data-testid="storage-remaining" data-bytes="${capacity.remaining??'unknown'}">${storageSize(capacity.remaining)}</strong><small>${storageBytes(capacity.remaining)}</small><p>${capacity.known?`About ${timeLeft} of loops-only stereo at ${(rate/1000).toFixed(1)} kHz, before storage overhead.`:'The browser did not provide usable capacity figures. Recording can still be attempted.'}</p></div>${card('Recorded audio · measured file bytes',inventory.audioBytes,inventory.audioBytes===null?`At least ${storageBytes(inventory.knownAudioBytes||0)} were measured.`:'')}${card('Offline app files · response bytes',inventory.cacheBytes,inventory.cacheBytes===null?`At least ${storageBytes(inventory.knownCacheBytes||0)} were measured.`:'')}</div><details class="storage-accounting"><summary>How storage is counted</summary><dl><div><dt>Browser-reported usage</dt><dd>${storageBytes(capacity.usage)}</dd></div><div><dt>Browser-reported limit</dt><dd>${storageBytes(capacity.quota)}</dd></div><div><dt>Project and audio metadata · encoded size</dt><dd>${storageBytes(inventory.metadataBytes)}</dd></div></dl><p>Available space is a browser estimate for this website origin, not a measurement of free device storage. It may include other apps on the same origin. Privacy settings, compression and database overhead can make it differ from the file totals below.</p><p>File sizes measure stored audio bytes and cached response bodies. Database metadata is shown as encoded data; the browser does not expose its exact disk allocation. Estimated recording time varies with recording mode, sample rate and available storage.</p></details>${capacity.low?'<p class="storage-advisory">The browser reports a low remaining allowance. You can free files below. This estimate alone does not block recording.</p>':''}${inventory.complete===false?`<div class="storage-scan-warning" role="status"><strong>Some storage could not be measured.</strong><p>Known files are listed below. Refresh to try again.</p><ul>${(inventory.errors||[]).slice(0,8).map(error=>`<li>${html(typeof error==='string'?error:error.message||JSON.stringify(error))}</li>`).join('')}</ul></div>`:''}<div class="storage-file-heading"><h3>All studio files</h3><span data-storage-file-count></span></div><div class="storage-file-toolbar"><label><span class="sr-only">Search files</span><input type="search" data-storage-search placeholder="Search files or projects" aria-label="Search files" value="${html(this.storageSearch)}"></label><label><span class="sr-only">Filter files</span><select data-storage-filter aria-label="Filter files"><option value="all">All files</option><option value="audio">Audio files</option><option value="cache">Offline app files</option><option value="orphan">Unlinked files</option></select></label></div><div class="storage-file-list" data-storage-file-list></div><details class="storage-projects" open><summary>Projects and settings</summary><p class="help-copy">Deleting a project removes its recordings and settings together. File deletion above removes only the selected audio and its dependent references.</p><div class="storage-project-list">${rows.map(row=>`<article class="storage-project ${row.id===currentId?'is-current':''}"><div class="storage-project-copy"><h3>${html(row.name||'Untitled session')}</h3><p>${storageSize(row.audioBytes)} audio · ${finite(row.assetCount)} files${row.id===currentId?' · Current project':''}</p><small>${row.purgePending?'Deletion was interrupted. Retry to finish.':row.deletedAt?'Previously removed project with retained data.':`Last saved ${this.date(row.updatedAt)||'recently'}`}</small></div><button type="button" class="button quiet storage-delete" data-action="delete-project" data-id="${html(row.id)}" aria-label="${row.purgePending?'Finish deleting':'Delete'} ${html(row.name||'Untitled session')}" ${locked?'disabled':''}>${icon('trash')}<span>${row.purgePending?'Finish deletion':'Delete project'}</span></button></article>`).join('')}</div></details><p class="storage-footnote">Permanent deletion cannot be undone. Download recordings or a project backup first if you want another copy. Files in your device’s Downloads folder and other apps are outside this studio’s access.</p></div>`,`<button type="button" class="button quiet" data-action="refresh-storage">${icon('undo')}Refresh</button><button type="button" class="button quiet" data-action="export-project" ${backupBlocked?'disabled':''}>${icon('download')}Backup current project</button><button class="button primary" value="close">Done</button>`);
    this.refs.dialog.classList.add('storage-dialog');
    this.refs.dialog.querySelector('[data-storage-filter]').value=this.storageFilter;
    this.renderStorageFiles();
  }

  showExport() {
    const p=this.state.project||{},performances=(p.performances||[]).filter(item=>!item.removed).slice().reverse(),take=(p.takes||[]).find(t=>t.id===p.selectedTakeId),performance=(p.performances||[]).find(x=>x.id===take?.performanceId);
    const frames=performance?(performance.status==='complete'?performance.frames:performance.editableFrames??Math.min(performance.frames,take?.frames||0)):take?.frames;
    const limited=!!take&&!!performance&&performance.status!=='complete',noArrangement=limited&&finite(frames)<=0;
    const seconds=noArrangement?0:take?Math.max(.01,Number((frames/(p.sampleRate||48000)).toFixed(2))):60;
    const canMix=(p.tracks||[]).length||take,damaged=this.damagedIds(),damagedBacking=(p.tracks||[]).some(t=>damaged.has(t.assetId));
    const selectedRaw=performance?.leadAssetId||take?.assetId;
    const canAudition=canMix&&!damagedBacking&&!damaged.has(take?.assetId),damagedRender=damagedBacking||damaged.has(selectedRaw),canRender=canMix&&!noArrangement&&!damagedRender;
    const auditionNote=canMix&&!canAudition?'Hear current mix is unavailable because a source recording is incomplete.':take?'Hear current mix plays the selected vocal with the layers as they are now.':'Hear current mix starts live playback.';
    const renderNote=noArrangement?'':damagedRender?' Render WAV is unavailable while a required recording is incomplete.':take?' Render WAV follows the recorded arrangement with your updated sound.':' Render WAV saves the length chosen above.';
    const limitNote=limited?`<p class="export-arrangement-note">${noArrangement?'No editable arrangement interval was retained, so Render WAV is unavailable for this take.':`Render WAV can remix only the first ${duration(frames,p.sampleRate)} of the saved arrangement.`} The complete ${duration(performance.frames,p.sampleRate)} recorded stereo performance ${damaged.has(performance.masterAssetId)?'also has missing or damaged audio.':performance.removed?'is retained with your vocal take. Undo removal to restore its download entry.':'remains downloadable above.'}${canAudition?' Hear current mix still plays the full vocal with your current backing.':''}</p>`:'';
    this.showDialog('Take your music with you',`<div class="export-options"><section><h3>Recorded performances</h3><p class="help-copy">Your loop songs and vocal performances, exactly as recorded.</p>${performances.length?performances.map(x=>`<button type="button" class="export-row" data-action="export-master" data-performance-id="${html(x.id)}" ${damaged.has(x.masterAssetId)?'disabled':''}><span>${html(x.name||'Performance')}<small>${duration(x.frames,p.sampleRate)} · ${damaged.has(x.masterAssetId)?'audio is incomplete':x.arrangementIncomplete?'full original stereo WAV':'stereo WAV'}</small></span>${icon('download')}</button>`).join(''):'<p class="dialog-hint">Record all the loops, or sing over them, to create a performance.</p>'}</section><section><h3>Current sound, recorded arrangement</h3><p class="help-copy">${take?`Use ${html(take.name)} with your current sound settings and its recorded arrangement.`:'Render the current loop layers and mix. Select a vocal take to include your voice.'}</p>${limitNote}<div class="export-mix-row"><label>Length <input data-export-duration data-initial="${seconds}" data-use-exact="${!!take}" type="number" min="0.01" max="86400" step="0.01" value="${seconds}" inputmode="decimal" ${noArrangement?'disabled':''}> seconds</label><div class="export-mix-buttons"><button type="button" class="button quiet" data-action="preview-mix" ${!canAudition?'disabled':''}>${icon('headphones')}Hear current mix</button><button type="button" class="button primary" data-action="export-mix" ${!canRender?'disabled':''}>${icon('download')}Render WAV</button></div></div><p class="export-mode-note">${auditionNote}${renderNote}</p></section><section class="backup-option"><div><h3>Whole project backup</h3><p class="help-copy">${damaged.size?'A complete backup is unavailable while source audio is missing or damaged. Restore a valid project backup to continue.':'Audio, takes, sections and settings in one .fml file.'}</p></div><button type="button" class="button primary" data-action="export-project" ${damaged.size?'disabled':''}>${icon('download')}Backup</button></section></div>`);
  }

  showHelp() {
    this.showDialog('A whole song. All you.',`<div class="guide-steps"><div><span>01</span><section><h3>Make a little rhythm.</h3><p>Connect your microphone and choose Add loop. Record a beat, hum or sound. Your first loop is free length; finish when it feels right.</p></section></div><div><span>02</span><section><h3>Let it grow.</h3><p>Add more layers. Synced loops start at the next boundary and finish after your chosen number of cycles. Free loops finish when you choose.</p></section></div><div><span>03</span><section><h3>Give it a voice.</h3><p>Choose Sing over loops. The backing keeps its place while you record a continuous vocal. Finishing keeps the groove going and saves a separate take and stereo performance.</p></section></div><div><span>04</span><section><h3>Find the feeling.</h3><p>Open Mix to shape each layer. Save different combinations as sections, then switch them while singing or recording all the loops to build your arrangement.</p></section></div></div><div class="guide-note">${icon('headphones')}<p>Use wired headphones for clean layers and easier timing. Keep this tab open and your device awake during recording. Download project backups for recordings you want to keep.</p></div><div class="guide-note">${icon('layers')}<p>Record all the loops makes a continuous stereo song from every unmuted loop. Solo is ignored in this mode. No microphone is needed or recorded. Change mutes, sections and mix settings as it records, then choose Finish recording.</p></div><h3 class="shortcut-heading">A few helpful shortcuts</h3><dl class="shortcut-list"><div><dt><kbd>Space</kbd></dt><dd>Play / stop everything</dd></div><div><dt><kbd>R</kbd></dt><dd>Add a loop</dd></div><div><dt><kbd>V</kbd></dt><dd>Sing over loops</dd></div><div><dt><kbd>Enter</kbd></dt><dd>Finish recording</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Cancel the current recording</dd></div><div><dt><kbd>⌘ / Ctrl Z</kbd></dt><dd>Undo · add Shift to redo</dd></div></dl><p class="help-copy">Your recordings stay in your browser. Nothing is uploaded by this studio. Browser storage can be cleared or evicted, so keep an exported backup.</p>`,`<button class="button primary" value="close">Let’s make something${icon('arrow')}</button>`);
  }

  destroy(){this.abort.abort();this.root.replaceChildren();}
}
