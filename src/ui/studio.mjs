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
const duration = (frames,rate=48000) => {const s=Math.max(0,finite(frames)/Math.max(1,finite(rate,48000)));return s < 60 ? `${s.toFixed(s<10?2:1)}s` : `${Math.floor(s/60)}m ${Math.round(s%60)}s`;};
const bytes = (n) => n>1024**3 ? `${(n/1024**3).toFixed(1)} GB` : `${(Math.max(0,n)/1024**2).toFixed(1)} MB`;
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
    this.bind();
  }

  shell() {return `
    <header class="app-header">
      <button class="brand" data-action="studio-home" aria-label="Feed the Music Loop, return to Build"><img src="./icon.svg" alt="" width="42" height="42"><span>FEED THE<br><strong>MUSIC LOOP</strong></span></button>
      <div class="project-heading"><div class="eyebrow">YOUR STUDIO</div><button class="project-title" data-action="rename-project" title="Rename project"><span data-ref="project-name">Untitled session</span><span class="edit-mark">↗</span></button><span class="save-state" data-ref="save-state" role="status">Ready when you are</span></div>
      <div class="header-actions"><button class="button icon-button help-button" data-action="help" aria-label="Studio guide">${icon('help')}</button><button class="button quiet" data-action="projects" aria-haspopup="dialog">${icon('folder')}<span>Projects</span></button><button class="button quiet" data-action="export-menu" aria-haspopup="dialog">${icon('download')}<span>Export</span></button></div>
    </header>
    <main id="workspace" tabindex="-1">
      <div class="status-banner" data-ref="banner" role="status" hidden></div>
      <section class="recovery-panel" data-ref="recovery" aria-label="Recovered recordings" hidden></section>
      <div class="workspace-top"><nav class="view-tabs" aria-label="Studio views"><button class="view-tab is-active" data-action="view" data-view="build" aria-current="page">${icon('layers')}<span>Build</span></button><button class="view-tab" data-action="view" data-view="song">${icon('song')}<span>Song</span></button><button class="view-tab" data-action="view" data-view="mix">${icon('sliders')}<span>Mix</span></button></nav><div class="studio-signals"><span class="local-badge" title="Recordings stay in this browser until you export them.">${icon('shield')}<span>Yours. On this device.</span></span><button class="mic-status" data-action="toggle-mic" data-testid="enable-mic"><span class="status-dot"></span><span data-ref="mic-label">Connect mic</span>${icon('mic')}</button></div></div>
      <section class="transport-panel" aria-label="Playback transport"><div class="transport-time"><span class="eyebrow" data-ref="transport-label">THE GROOVE</span><div class="time-display" data-ref="transport-time">0:00.0</div></div><div class="cycle-display"><div class="cycle-meta"><span data-ref="cycle-description">Your first loop sets the rhythm</span><span data-ref="cycle-position">FREE</span></div><div class="cycle-track"><div class="cycle-progress" data-ref="cycle-progress"></div><div class="cycle-ticks" aria-hidden="true"><i></i><i></i><i></i></div></div><div class="transport-caption"><span data-ref="track-count">No layers yet</span><span data-ref="sample-rate">LOCAL AUDIO STUDIO</span></div></div><div class="master-meter" aria-label="Master output level"><div class="meter-label">OUT</div><div class="meter-track"><div class="meter-fill" data-ref="output-meter"></div></div><span class="meter-value" data-ref="output-db">−∞</span></div><button class="button icon-button restart-button" data-action="seek-start" aria-label="Return to start" title="Return to start">${icon('rewind')}</button></section>
      <section class="preview-panel" data-ref="preview-panel" aria-label="Recording preview" hidden><div class="preview-description">${icon('headphones')}<span><small>LISTEN BACK</small><strong data-ref="preview-name">Your performance</strong></span></div><audio id="performance-player" data-ref="preview-audio" controls preload="metadata"></audio><button class="button icon-button" data-action="close-preview" aria-label="Close recording preview">${icon('close')}</button></section>
      <section class="downloads-panel" data-ref="downloads" aria-label="Ready downloads" hidden></section>
      <section class="export-progress-panel" data-ref="export-panel" aria-label="Export progress" hidden><div><strong data-ref="export-title">Preparing your audio…</strong><p data-ref="export-caption">Your recordings remain safe while this file is prepared.</p><div class="export-progress-track" role="progressbar" aria-label="Export completion" aria-valuemin="0" aria-valuemax="100" data-ref="export-progressbar"><div data-ref="export-progress"></div></div></div><button class="button quiet" data-action="cancel-export">${icon('close')}Cancel export</button></section>
      <section class="capture-panel" data-ref="capture-panel" aria-label="Current recording" hidden><div class="capture-symbol">${icon('mic')}</div><div class="capture-copy"><strong data-ref="capture-title">Recording your first loop</strong><p data-ref="capture-hint">Make your sound. Finish whenever it feels right.</p><div class="capture-progress-track"><div data-ref="capture-progress"></div></div></div><span class="capture-clock" data-ref="capture-time" aria-label="Recording duration">0:00.0</span></section>
      <div class="studio-body">
        <div class="main-column">
          <section data-view-panel="build" class="view-panel" aria-label="Build your loops">
            <div class="section-heading"><div><span class="eyebrow">ONE VOICE. ENDLESS POSSIBILITIES.</span><h1>Your loop canvas<span class="heading-dot">.</span></h1></div><button class="button quiet small" data-action="import-audio" aria-label="Import an audio file">${icon('upload')}<span>Import audio</span></button></div>
            <div class="empty-canvas" data-ref="empty"><div class="orbit-art" aria-hidden="true"><div class="orbit-ring ring-one"></div><div class="orbit-ring ring-two"></div><div class="orbit-ring ring-three"></div><div class="orbit-core">${icon('mic')}</div><span class="orbit-note note-one">BEAT</span><span class="orbit-note note-two">BASS</span><span class="orbit-note note-three">VOICE</span></div><span class="eyebrow">EVERY SONG STARTS SOMEWHERE</span><h2>What does your<br><em>world sound like?</em></h2><p>A beat. A hum. A little rhythm.<br>Record it, loop it, and see where your voice takes you.</p><button class="button primary" data-action="add-loop" data-testid="first-loop">${icon('plus')}Record your first loop</button><button class="text-button demo-button" data-action="demo" data-testid="demo">${icon('headphones')}Try a demo groove${icon('arrow')}</button><div class="empty-tip">Headphones help keep each layer clean.</div></div>
            <div class="loop-grid" data-ref="tracks" aria-label="Loop tracks"></div>
            <div class="add-layer-row" data-ref="add-layer-row" hidden><button class="add-layer" data-action="add-loop">${icon('plus')}<span>Add another layer</span><kbd>R</kbd></button></div>
            <section class="section-bank"><div class="section-heading compact"><div><span class="eyebrow">GIVE YOUR SONG A SHAPE</span><h2>Sections</h2></div><button class="button quiet small" data-action="save-section">${icon('plus')}Save section</button></div><div class="section-pads" data-ref="sections"></div><p class="help-copy">Save a combination of layers as an intro, verse or chorus. Switch sections on the next loop boundary.</p></section>
          </section>
          <section data-view-panel="song" class="view-panel" aria-label="Your song recordings" hidden><div class="section-heading"><div><span class="eyebrow">LET THE GROOVE CARRY YOU</span><h1>Make it a song<span class="heading-dot">.</span></h1></div></div><div class="song-hero"><div class="song-hero-icon">${icon('mic')}</div><div><h2>One continuous performance.</h2><p>Sing for as long as you need while your loops keep playing. Each take keeps your vocal and the complete song.</p></div><button class="button primary coral" data-action="sing">${icon('mic')}Sing over loops</button></div><div class="section-heading compact"><h2>Performances</h2><span class="quiet-label" data-ref="performance-count">0 recordings</span></div><div class="performance-list" data-ref="performances"></div><div class="section-heading compact takes-heading"><h2>Vocal takes</h2><span class="quiet-label">Your originals, kept separate</span></div><div class="take-list" data-ref="takes"></div></section>
          <section data-view-panel="mix" class="view-panel" aria-label="Mix your song" hidden><div class="section-heading"><div><span class="eyebrow">FIND YOUR SIGNATURE SOUND</span><h1>Shape the feeling<span class="heading-dot">.</span></h1></div></div><div class="mixer-channel-list" data-ref="mix-channels"></div><div class="mix-console" data-ref="mix-console"></div><section class="mix-guide"><h3>Make room for your voice.</h3><p>Start with the backing a little quieter than you expect. Place harmonies left and right, keep bass near the centre, and use a little shared space to bring the layers together.</p></section></section>
        </div>
        <aside class="side-column" aria-label="Input and session controls"><section class="input-card"><div class="card-heading"><span class="eyebrow">YOUR INSTRUMENT</span>${icon('mic')}</div><h2>The human voice.</h2><div class="input-meter-row"><span>Mic level</span><div class="input-meter-track"><div data-ref="input-meter"></div></div><span data-ref="input-db">−∞</span></div><div data-ref="input-controls"></div><label class="toggle-row"><span>${icon('headphones')}Hear my mic</span><input type="checkbox" data-control="monitor" role="switch" aria-label="Hear my microphone through headphones"><span class="toggle" aria-hidden="true"></span></label><p class="help-copy">Use headphones for monitoring. Your voice is recorded even when monitoring is off.</p><div class="input-divider"></div><div class="loop-length"><label for="loop-length">New loop length</label><select id="loop-length" data-control="cycles"><option value="1">1 cycle · stay in sync</option><option value="2">2 cycles</option><option value="4">4 cycles</option><option value="custom">Custom cycles</option><option value="0">Free · finish when ready</option></select><label class="custom-cycles" data-ref="custom-cycles" hidden>Cycles<input type="number" min="1" max="64" value="3" data-control="custom-cycles" inputmode="numeric"></label><p class="help-copy" data-ref="length-help">Your first loop is free length. After that, new layers lock to your rhythm.</p></div></section><section class="master-card"><div class="card-heading"><span class="eyebrow">THE WHOLE PICTURE</span>${icon('sliders')}</div><div data-ref="master-controls"></div><button class="spotlight-button" data-action="spotlight" aria-pressed="false">${icon('spark')}<span>Spotlight<small>Hold to bring your voice forward</small></span></button></section><section class="session-card"><div class="card-heading"><span class="eyebrow">KEEP WHAT YOU CREATE</span>${icon('shield')}</div><p class="session-storage" data-ref="storage-label">Audio stays on this device.</p><div class="storage-bar"><div data-ref="storage-progress"></div></div><button class="text-button" data-action="export-project">Download project backup${icon('arrow')}</button><button class="text-button subtle" data-action="persist" data-ref="persist-button">Protect local storage${icon('arrow')}</button><details class="advanced-settings"><summary>Timing &amp; recording</summary><p class="help-copy">If your new layers sound late, adjust recording compensation. This depends on your headphones and microphone.</p><label class="number-field">Recording compensation<span><input type="number" min="0" max="1000" step="1" value="0" data-control="compensation" aria-label="Recording compensation in milliseconds">ms</span></label><p class="help-copy">Try small changes. Wired headphones usually make timing easier. A new audio device may need a different setting.</p><button class="button quiet full-width" data-action="mic-off">${icon('mic')}Disconnect microphone</button></details></section></aside>
      </div>
      <div class="footnote"><span>Made of breath, rhythm &amp; possibility.</span><button class="text-button subtle" data-action="help">${icon('keyboard')}Studio guide &amp; shortcuts</button></div>
    </main>
    <div class="record-dock" aria-label="Recording controls"><div class="dock-status"><span class="dock-light" data-ref="dock-light"></span><div><strong data-ref="dock-label">Start with a sound.</strong><span data-ref="dock-caption">Your first loop is the beginning.</span></div></div><div class="dock-actions"><button class="button transport-button" data-action="play" data-testid="play" aria-label="Play loops">${icon('play')}</button><button class="button stop-button" data-action="stop" data-testid="stop" aria-label="Stop all audio" title="Stop all audio">${icon('stop')}</button><span class="dock-separator"></span><button class="button primary" data-action="add-loop" data-ref="dock-loop" data-testid="add-loop">${icon('plus')}<span>Add loop</span><kbd>R</kbd></button><button class="button primary coral" data-action="sing" data-ref="dock-sing" data-testid="sing">${icon('mic')}<span>Sing over loops</span><kbd>V</kbd></button><button class="button primary coral" data-action="finish" data-ref="dock-finish" data-testid="finish" hidden>${icon('check')}<span>Finish recording</span></button><button class="button quiet" data-action="cancel" data-ref="dock-cancel" data-testid="cancel" hidden>${icon('close')}<span>Cancel</span></button></div><div class="history-actions"><button class="button icon-button" data-action="undo" aria-label="Undo" title="Undo (Ctrl or ⌘ Z)">${icon('undo')}</button><button class="button icon-button" data-action="redo" aria-label="Redo" title="Redo (Ctrl or ⌘ Shift Z)">${icon('redo')}</button></div></div>
    <div class="toast-region" data-ref="toasts" aria-live="polite" aria-relevant="additions"></div>
    <dialog class="studio-dialog" data-ref="dialog" aria-labelledby="dialog-title"><form method="dialog"><div class="dialog-heading"><h2 id="dialog-title" data-ref="dialog-title"></h2><button type="button" class="button icon-button dialog-stop" data-action="stop" data-ref="dialog-stop" aria-label="Stop all audio" title="Stop all audio" hidden>${icon('stop')}</button><button class="button icon-button" value="cancel" formnovalidate aria-label="Close dialog">${icon('close')}</button></div><div data-ref="dialog-body"></div><div class="dialog-actions" data-ref="dialog-actions"></div></form></dialog>
    <input type="file" data-ref="audio-file" accept="audio/*,.wav,.mp3,.ogg,.m4a,.webm,.flac" hidden><input type="file" data-ref="project-file" accept=".fml,application/octet-stream" hidden>
  `;}

  emit(type, details={}) {this.dispatchEvent(new CustomEvent('action',{detail:{type,...details}}));}

  bind() {
    const signal = this.abort.signal;
    this.root.addEventListener('click',e=>this.onClick(e),{signal});
    this.root.addEventListener('input',e=>this.onInput(e),{signal});
    this.root.addEventListener('change',e=>this.onChange(e),{signal});
    this.refs['audio-file'].addEventListener('change',e=>{if(e.target.files?.[0])this.emit('import-audio',{file:e.target.files[0]});e.target.value='';},{signal});
    this.refs['project-file'].addEventListener('change',e=>{if(e.target.files?.[0])this.emit('import-project',{file:e.target.files[0]});e.target.value='';},{signal});
    document.addEventListener('keydown',e=>this.onKey(e),{signal});
    const spotlight = this.root.querySelector('[data-action="spotlight"]');
    const release=()=>{if(this.spotlight){this.spotlight=false;spotlight.setAttribute('aria-pressed','false');this.emit('spotlight',{active:false});}};
    spotlight.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();spotlight.setPointerCapture?.(e.pointerId);this.spotlight=true;spotlight.setAttribute('aria-pressed','true');this.emit('spotlight',{active:true});},{signal});
    spotlight.addEventListener('pointerup',release,{signal});
    spotlight.addEventListener('pointercancel',release,{signal});
    spotlight.addEventListener('lostpointercapture',release,{signal});
    spotlight.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat){e.preventDefault();this.spotlight=true;spotlight.setAttribute('aria-pressed','true');this.emit('spotlight',{active:true});}},{signal});
    spotlight.addEventListener('keyup',e=>{if(e.key===' '||e.key==='Enter'){e.preventDefault();release();}},{signal});
    window.addEventListener('blur',release,{signal});
    this.root.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();this.root.classList.add('is-dragging');}},{signal});
    this.root.addEventListener('dragleave',e=>{if(!this.root.contains(e.relatedTarget))this.root.classList.remove('is-dragging');},{signal});
    this.root.addEventListener('drop',e=>{e.preventDefault();this.root.classList.remove('is-dragging');const file=e.dataTransfer?.files?.[0];if(!file)return;if(this.state.capture||this.state.busy||this.state.exporting){this.notify('Finish the current recording or file operation before importing.','warning');return;}this.emit(file.name.toLowerCase().endsWith('.fml')?'import-project':'import-audio',{file});},{signal});
  }

  async onClick(e) {
    const button = e.target.closest('[data-action]');
    if(!button||button.disabled)return;
    const type=button.dataset.action,id=button.dataset.id;
    if(type==='spotlight')return;
    if(type==='studio-home')return this.emit('view',{view:'build'});
    if(type==='view')return this.emit('view',{view:button.dataset.view});
    if(type==='projects')return this.showProjects();
    if(type==='export-menu')return this.showExport();
    if(type==='help')return this.showHelp();
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
    if(type==='export-project'){this.refs.dialog.close();return this.emit(type);}
    if(type==='export-master'){this.refs.dialog.close();return this.emit(type,{performanceId:button.dataset.performanceId||id});}
    if(type==='preview-performance')return this.emit(type,{performanceId:button.dataset.performanceId||id});
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
    if(type==='select-take'||type==='preview-take'||type==='select-track'||type==='mute'||type==='solo'||type==='remove-track'||type==='launch-section'||type==='export-track'||type==='layer-vocal'||type==='recover-asset'||type==='export-recovered')return this.emit(type,{id});
    if(type==='nudge')return this.emit(type,{id,frames:Math.round(finite(button.dataset.ms)*finite(this.state.sampleRate||this.state.project?.sampleRate,48000)/1000)});
    this.emit(type);
  }

  onInput(e) {
    const el=e.target,control=el.dataset.control,key=el.dataset.key;
    if(el.hasAttribute('data-export-duration'))el.setCustomValidity('');
    if(!control)return;
    const value=finite(el.value);
    if(control==='mix'){this.displayRange(el);this.emit('mix',{id:el.dataset.id,mix:{[key]:value}});}
    if(control==='master'){this.displayRange(el);this.emit('set-master',{volume:value});}
    if(control==='input'){this.displayRange(el);this.emit('set-input',{gain:value});}
  }

  onChange(e) {
    const el=e.target,c=el.dataset.control;
    if(c==='monitor')this.emit('monitor',{enabled:el.checked,monitor:el.checked});
    if(c==='cycles'){this.cycles=el.value==='custom'?'custom':Number(el.value);this.refs['custom-cycles'].hidden=this.cycles!=='custom';}
    if(c==='custom-cycles'){this.customCycles=Math.round(clamp(el.value,1,64));el.value=this.customCycles;}
    if(c==='compensation'){el.value=Math.round(clamp(el.value,0,1000));this.emit('set-input',{compensationMs:Number(el.value)});}
    if(c==='role')this.emit('role',{id:el.dataset.id,role:el.value});
    if(c==='selected-track')this.emit('select-track',{id:el.value});
    if(c==='selected-take')this.emit('select-take',{id:el.checked?el.dataset.id:null});
  }

  onKey(e) {
    if(this.refs.dialog.open||e.target.closest('audio,video'))return;
    const editable=e.target.closest('input,textarea,select,[contenteditable="true"]');
    if(e.key==='Escape'&&this.state.capture){e.preventDefault();this.emit('cancel');return;}
    if(editable||e.repeat||e.altKey)return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();this.emit(e.shiftKey?'redo':'undo');return;}
    if(e.ctrlKey||e.metaKey)return;
    if(e.target.closest('button,a,summary')&&(e.key===' '||e.key==='Enter'))return;
    if(e.key===' '){e.preventDefault();this.emit(this.state.playing||this.state.capture?'stop':'play');}
    if(e.key.toLowerCase()==='r'&&!this.state.capture&&!this.state.busy&&!this.state.exporting)this.emit('add-loop',{cycles:this.state.project?.baseFrames?this.cycles:0,customCycles:this.customCycles});
    if(e.key.toLowerCase()==='v'&&!this.state.capture&&!this.state.busy&&!this.state.exporting)this.emit('sing');
    if(e.key==='Enter'&&this.state.capture?.status==='recording')this.emit('finish');
  }

  render(state) {
    this.state=state;
    const p=state.project||{},tracks=p.tracks||[],rate=state.sampleRate||p.sampleRate||48000,capture=state.capture;
    const recording=!!capture,view=state.view||'build';
    const focusWasInOldView=this.renderedView&&this.renderedView!==view&&document.activeElement?.closest('[data-view-panel]');
    this.refs['project-name'].textContent=p.name||'Untitled session';
    this.root.dataset.captureState=capture?.status||'idle';
    this.root.dataset.playing=String(!!state.playing);
    this.refs['save-state'].textContent=state.message||state.status||(state.busy?'Working…':'Ready');
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
    this.renderPreview(state.preview);
    this.renderDownloads(state.downloads||[]);
    this.renderRecovery(state.recovered||[],rate);
    this.refs['export-panel'].hidden=!state.exporting;
    this.updateExportProgress(state.exportProgress||{});
    this.renderDock(capture,tracks,rate);
    this.updateMeters({inputLevel:state.inputLevel,outputLevel:state.outputLevel});
    this.updateTransport({transportFrame:state.transportFrame,sampleRate:rate,baseFrames:p.baseFrames});
    const storage=state.storage||{};
    this.refs['storage-label'].textContent=storage.quota?`${bytes(storage.usage||0)} used · ${bytes(Math.max(0,storage.quota-(storage.usage||0)))} available`:'Audio stays on this device.';
    this.refs['storage-progress'].style.width=`${storage.quota?clamp(storage.usage/storage.quota*100,0,100):0}%`;
    this.refs['persist-button'].hidden=!!storage.persistent;
    this.refs['persist-button'].disabled=!!state.busy;
    let banner=state.error?(typeof state.error==='string'?state.error:state.error.message):state.readonly?'This project is open in another tab. Close that tab to continue editing here.':'';
    if(state.capabilities?.secureContext===false)banner='Microphone recording needs HTTPS or localhost. Open the published studio to record.';
    else if(state.capabilities?.audio===false)banner='This browser cannot open the audio engine. Open the studio in a current browser with Web Audio support.';
    else if(state.capabilities?.microphone===false)banner='Microphone recording is unavailable here. Open the HTTPS studio in a current browser to connect your microphone.';
    this.refs.banner.hidden=!banner;this.refs.banner.textContent=banner;this.refs.banner.classList.toggle('is-error',!!state.error);
    this.root.querySelectorAll('[data-action="undo"]').forEach(el=>el.disabled=!state.undoAvailable||recording||!!state.busy);
    this.root.querySelectorAll('[data-action="redo"]').forEach(el=>el.disabled=!state.redoAvailable||recording||!!state.busy);
    this.root.querySelectorAll('[data-action="add-loop"],[data-action="sing"],[data-action="demo"],[data-action="import-audio"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting||!!state.readonly||state.capabilities?.audio===false||(['add-loop','sing'].includes(el.dataset.action)&&state.capabilities?.microphone===false));
    this.root.querySelectorAll('[data-action="projects"],[data-action="rename-project"],[data-action="export-menu"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="save-section"]').forEach(el=>el.disabled=!tracks.length||!!state.readonly||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="play"]').forEach(el=>{el.disabled=recording||!!state.playing||(!tracks.length&&!p.selectedTakeId)||!!state.busy;});
    this.root.querySelectorAll('[data-action="seek-start"]').forEach(el=>el.disabled=recording||!!state.busy||!tracks.length);
    this.root.querySelectorAll('[data-action="stop"]').forEach(el=>el.disabled=false);
    this.root.querySelectorAll('[data-action="export-project"]').forEach(el=>el.disabled=recording||!!state.exporting||!!state.busy);
    this.root.querySelectorAll('input[data-control="mix"],input[data-control="master"],input[data-control="input"],[data-control="role"],[data-control="compensation"],[data-control="selected-take"]').forEach(el=>el.disabled=!!state.readonly||!!state.busy);
    this.root.querySelectorAll('[data-action="layer-vocal"],[data-action="recover-asset"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting||!!state.readonly);
    this.root.querySelector('[data-control="compensation"]').disabled=recording||!!state.readonly||!!state.busy;
    this.root.querySelector('[data-control="monitor"]').disabled=!!state.readonly||state.capabilities?.microphone===false||!!capture?.waitingForMic;
    mic.disabled=!state.micEnabled&&(state.capabilities?.microphone===false||!!capture?.waitingForMic||!!state.readonly);
    this.root.querySelectorAll('[data-action="export-track"],[data-action="export-master"],[data-action="export-recovered"],[data-action="preview-take"],[data-action="preview-performance"]').forEach(el=>el.disabled=recording||!!state.busy||!!state.exporting);
    this.root.querySelectorAll('[data-action="mute"],[data-action="solo"],[data-action="remove-track"],[data-action="rename-track"],[data-action="rename-take"],[data-action="delete-take"],[data-action="delete-section"],[data-action="launch-section"],[data-action="nudge"]').forEach(el=>el.disabled=!!state.readonly||!!state.busy);
    if(state.readonly)this.root.querySelector('[data-action="rename-project"]').disabled=true;
    this.refs['dialog-stop'].hidden=!(state.playing||capture||(state.preview&&!this.refs['preview-audio'].paused));
    if(focusWasInOldView){const heading=this.root.querySelector(`[data-view-panel="${view}"] h1`);if(heading){heading.tabIndex=-1;heading.focus();}}
    this.renderedView=view;
  }

  region(key,signature,markup) {
    if(this.signatures[key]===signature)return;
    const target=this.refs[key];if(!target)return;
    // Regions have stable structural signatures: live sliders are patched separately.
    const focused=target.contains(document.activeElement)?document.activeElement:null;
    const identity=focused?['data-id','data-action','data-control','data-key','name','aria-label'].filter(name=>focused.hasAttribute(name)).map(name=>[name,focused.getAttribute(name)]):[];
    this.signatures[key]=signature;target.innerHTML=markup;
    if(identity.length){const replacement=[...target.querySelectorAll('button,input,select,a')].find(el=>identity.every(([name,value])=>el.getAttribute(name)===value));replacement?.focus({preventScroll:true});}
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
    const performances=p.performances||[],takes=p.takes||[];
    this.refs['performance-count'].textContent=`${performances.length} ${performances.length===1?'recording':'recordings'}`;
    this.region('performances',JSON.stringify(performances.map(x=>[x.id,x.name,x.frames,x.status])),performances.length?performances.slice().reverse().map((x,i)=>`<article class="performance-card"><div class="performance-art" aria-hidden="true">${icon('song')}</div><div class="performance-copy"><h3>${html(x.name||`Performance ${performances.length-i}`)}</h3><p>${duration(x.frames,rate)} · ${x.status==='interrupted'||x.status==='recovered'?'Recovered recording':'Full stereo performance'}${x.createdAt?` · ${this.date(x.createdAt)}`:''}</p></div><button class="button icon-button" data-action="preview-performance" data-performance-id="${html(x.id)}" aria-label="Listen to ${html(x.name||'performance')}">${icon('play')}</button><button class="button quiet" data-action="export-master" data-performance-id="${html(x.id)}" aria-label="Download ${html(x.name||'performance')} as WAV">${icon('download')}<span>WAV</span></button></article>`).join(''):'<div class="quiet-empty">'+icon('song')+'<h3>Your song lives here.</h3><p>Choose “Sing over loops” to capture your voice and backing together.</p></div>');
    this.region('takes',JSON.stringify(takes.map(x=>[x.id,x.name,x.frames])),takes.length?takes.slice().reverse().map((t,i)=>`<article class="take-card" data-take-id="${html(t.id)}"><div class="take-main"><button class="button icon-button" data-action="preview-take" data-id="${html(t.id)}" aria-label="Listen to ${html(t.name||'vocal take')} with recorded backing" title="Listen with recorded backing">${icon('play')}</button><button class="take-name" data-action="select-track" data-id="${html(t.id)}" aria-label="Mix ${html(t.name||'vocal take')}"><strong>${html(t.name||`Vocal take ${takes.length-i}`)}</strong><span>${duration(t.frames,rate)} · original vocal</span></button><button class="button icon-button" data-action="rename-take" data-id="${html(t.id)}" aria-label="Rename ${html(t.name||'vocal take')}">${icon('more')}</button><button class="button icon-button" data-action="delete-take" data-id="${html(t.id)}" aria-label="Remove ${html(t.name||'vocal take')}">${icon('trash')}</button></div><div class="take-footer"><label class="take-selection"><input type="checkbox" data-control="selected-take" data-id="${html(t.id)}"><span>Use in edited song</span></label><button class="text-button" data-action="layer-vocal" data-id="${html(t.id)}" title="Make a separate looping layer from this vocal">${icon('loop')}Turn into a loop</button></div></article>`).join(''):'<p class="help-copy empty-takes">Each continuous vocal is kept as a separate take, ready for another version.</p>');
    for(const el of this.refs.takes.children){const selected=el.dataset.takeId===p.selectedTakeId;el.classList.toggle('is-selected',selected);const input=el.querySelector('[data-control="selected-take"]');if(input&&input!==document.activeElement)input.checked=selected;}
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
    const takeCheck=this.refs['mix-console'].querySelector('[data-control="selected-take"]');if(takeCheck&&takeCheck!==document.activeElement)takeCheck.checked=id===p.selectedTakeId;
    const offset=this.refs['mix-console'].querySelector('[data-ref-offset]');if(offset)offset.textContent=`Offset: ${(finite(selected.offsetFrames)/(p.sampleRate||48000)*1000).toFixed(1)} ms`;
    this.patchInput(this.refs['mix-channels'].querySelector('select'),id);
    for(const pill of this.refs['mix-channels'].querySelectorAll('.channel-pill')){pill.classList.toggle('is-active',pill.dataset.id===id);pill.setAttribute('aria-pressed',String(pill.dataset.id===id));}
  }

  renderInput(p) {
    this.region('input-controls','input',slider({label:'Input gain',key:'gain',value:p.input?.gain??1,max:4,scope:'input',display:db(p.input?.gain??1)}));
    this.region('master-controls','master',slider({label:'Master volume',key:'volume',value:p.master?.volume??.8,max:2,scope:'master',display:db(p.master?.volume??.8)}));
    for(const [scope,value] of [['input',p.input?.gain??1],['master',p.master?.volume??.8]]){const input=this.root.querySelector(`input[data-control="${scope}"]`);this.patchInput(input,value);this.displayRange(input);}
    const monitor=this.root.querySelector('[data-control="monitor"]');if(monitor!==document.activeElement)monitor.checked=!!(this.state.monitor??p.input?.monitor);
    this.patchInput(this.root.querySelector('[data-control="compensation"]'),p.input?.compensationMs??0);
  }

  renderPreview(preview) {
    const panel=this.refs['preview-panel'],audio=this.refs['preview-audio'];
    panel.hidden=!preview?.url;
    if(!preview?.url){if(audio.hasAttribute('src')){audio.pause();audio.removeAttribute('src');audio.load();}return;}
    this.refs['preview-name'].textContent=preview.name||'Your performance';
    if(audio.getAttribute('src')!==preview.url){audio.src=preview.url;audio.load();}
  }

  renderDownloads(downloads) {
    const target=this.refs.downloads;target.hidden=!downloads.length;
    this.region('downloads',JSON.stringify(downloads.map(d=>[d.id,d.url,d.filename,d.label])),downloads.length?`<div class="downloads-heading">${icon('check')}<span>Your files are ready</span></div><div class="download-links">${downloads.map(d=>`<a class="ready-download" href="${html(d.url)}" download="${html(d.filename||'recording.wav')}">${icon('download')}<span>${html(d.label||d.filename||'Download recording')}<small>${html(d.filename||'')}</small></span></a>`).join('')}</div>`:'');
  }

  renderRecovery(assets,rate) {
    this.refs.recovery.hidden=!assets.length;
    this.region('recovery',JSON.stringify(assets.map(a=>[a.id,a.name,a.kind,a.frames,a.status])),assets.length?`<div class="recovery-heading">${icon('shield')}<div><h2>There’s still music here.</h2><p>These saved recordings are available to bring back into your project or download.</p></div></div><div class="recovery-list">${assets.map(a=>`<article class="recovery-card"><div><strong>${html(a.name||'Recovered recording')}</strong><span>${duration(a.frames,rate)} · ${a.channels===2?'stereo':'mono'} · ${html(a.kind||'audio')}</span></div><button class="button quiet" data-action="export-recovered" data-id="${html(a.id)}" aria-label="Download recovered ${html(a.name||'recording')}">${icon('download')}<span>WAV</span></button><button class="button primary" data-action="recover-asset" data-id="${html(a.id)}">${icon('plus')}<span>Keep in project</span></button></article>`).join('')}</div>`:'');
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
    this.refs['dock-loop'].hidden=active;this.refs['dock-sing'].hidden=active;this.refs['dock-finish'].hidden=!active||status!=='recording';this.refs['dock-cancel'].hidden=!active;
    this.refs['dock-finish'].disabled=status==='finishing';
    this.refs['dock-cancel'].disabled=status==='finishing';
    this.refs['dock-light'].className=`dock-light${active?' is-recording':this.state.playing?' is-playing':''}`;
    this.root.classList.toggle('is-recording',status==='recording');
    let label='Start with a sound.',caption='Your first loop is the beginning.';
    if(tracks.length){label=this.state.playing?'Your world is playing.':'The groove is ready.';caption='Add a layer, or sing something new.';}
    if(status==='arming'){label=capture.kind==='vocal'?'Your vocal is queued.':'Your next layer is queued.';caption='Starting on the next loop boundary. Cancel anytime.';}
    if(capture?.waitingForMic){label='Waiting for your microphone.';caption='Allow microphone access in your browser. Stop cancels this request.';}
    if(status==='recording'){label=capture.kind==='vocal'?'This is your moment.':'A new layer is taking shape.';caption=`Recording ${time(capture.elapsedFrames,rate)}${capture.targetFrames?` / ${time(capture.targetFrames,rate)}`:' · finish when you are ready'}`;}
    if(status==='finishing'){label='Keeping your recording safe.';caption='Finishing the audio and saving your take…';}
    if(this.state.busy&&!active){label=this.state.message||'Getting things ready…';caption='Stop remains available.';}
    this.refs['dock-label'].textContent=label;this.refs['dock-caption'].textContent=caption;
    const finishText=this.refs['dock-finish'].querySelector('span');finishText.textContent=capture?.targetFrames?'Finish at boundary':'Finish recording';
    const cancelText=this.refs['dock-cancel'].querySelector('span');cancelText.textContent=status==='recording'?'Discard':'Cancel';
    this.refs['capture-panel'].hidden=!active;
    this.refs['capture-panel'].dataset.status=status||'idle';
    this.refs['capture-title'].textContent=capture?.waitingForMic?'Let your browser hear you':status==='arming'?'Ready for the next cycle':status==='finishing'?'Saving your sound':capture?.kind==='vocal'?'Recording your performance':tracks.length?'Recording a new layer':'Recording your first loop';
    this.refs['capture-hint'].textContent=capture?.waitingForMic?'Choose Allow in the microphone permission prompt. You can cancel here at any time.':status==='arming'?'Your groove keeps moving. Your recording starts at the next boundary.':status==='finishing'?'Keeping the original audio and your project together.':capture?.kind==='vocal'?(tracks.length?'Keep singing. Your loops are carrying the song underneath.':'Let the vocal run. Finish whenever you are ready.'):capture?.targetFrames?'This layer finishes automatically at the end of its chosen cycles.':'Make your sound. Finish whenever it feels right.';
    this.refs['capture-time'].textContent=time(capture?.elapsedFrames,rate);
    this.refs['capture-progress'].style.width=capture?.targetFrames?`${clamp(capture.elapsedFrames/capture.targetFrames*100,0,100)}%`:'0%';
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
    this.refs['transport-time'].textContent=time(frame,rate);
    this.refs['cycle-progress'].style.width=base?`${(frame%base)/base*100}%`:'0%';
    this.refs['cycle-position'].textContent=base?`CYCLE ${Math.floor(frame/base)+1}`:'FREE';
    const markers=new Map([...this.refs.tracks.querySelectorAll('[data-position]')].map(el=>[el.dataset.position,el]));
    for(const t of p.tracks||[]){const marker=markers.get(t.id);if(marker)marker.style.left=`${t.frames?((frame-finite(t.offsetFrames))%t.frames+t.frames)%t.frames/t.frames*100:0}%`;}
    if(this.state.capture?.status==='recording'&&data.capture){this.state.capture={...this.state.capture,...data.capture};this.renderDock(this.state.capture,p.tracks||[],rate);}
  }

  patchInput(input,value) {if(input&&input!==document.activeElement)input.value=value;}
  pan(value) {const n=finite(value);return Math.abs(n)<.01?'Centre':`${Math.round(Math.abs(n)*100)}% ${n<0?'L':'R'}`;}
  displayRange(el) {const out=el.closest('.slider-field')?.querySelector('output');if(!out)return;const k=el.dataset.key,v=Number(el.value);out.textContent=k==='volume'||k==='gain'?db(v):k==='pan'?this.pan(v):k==='highpass'?`${Math.round(v)} Hz`:['low','mid','high'].includes(k)?`${v>0?'+':''}${v} dB`:`${Math.round(v*100)}%`;el.setAttribute('aria-valuetext',out.textContent);el.style.setProperty('--range-progress',`${(v-Number(el.min))/(Number(el.max)-Number(el.min))*100}%`);}
  date(value){try{return new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(new Date(value));}catch{return '';}}

  notify(message,kind='info') {
    const el=document.createElement('div');el.className=`toast toast-${['error','warning','success'].includes(kind)?kind:'info'}`;el.setAttribute('role',kind==='error'?'alert':'status');
    const text=document.createElement('span');text.textContent=String(message);const close=document.createElement('button');close.className='toast-close';close.setAttribute('aria-label','Dismiss notification');close.innerHTML=icon('close');close.addEventListener('click',()=>el.remove());el.append(text,close);this.refs.toasts.append(el);
    while(this.refs.toasts.children.length>3)this.refs.toasts.firstElementChild.remove();
    if(kind!=='error')setTimeout(()=>el.remove(),kind==='warning'?10000:6000);
  }

  showDialog(title,body,actions='') {
    const d=this.refs.dialog;if(d.open)d.close('cancel');d.returnValue='cancel';this.refs['dialog-title'].textContent=title;this.refs['dialog-body'].innerHTML=body;this.refs['dialog-actions'].innerHTML=actions;this.refs['dialog-stop'].hidden=!(this.state.playing||this.state.capture||(this.state.preview&&!this.refs['preview-audio'].paused));d.showModal();return d;
  }

  confirm(options={}) {
    return new Promise(resolve=>{const d=this.showDialog(options.title||'Are you sure?',`<p class="dialog-copy">${html(options.message||'')}</p>`,`<button class="button quiet" value="cancel">Cancel</button><button class="button ${options.danger?'danger':'primary'}" value="confirm">${html(options.confirmLabel||'Continue')}</button>`);d.addEventListener('close',()=>resolve(d.returnValue==='confirm'),{once:true});});
  }

  prompt(options={}) {
    return new Promise(resolve=>{const d=this.showDialog(options.title||'Give it a name',`${options.message?`<p class="dialog-copy">${html(options.message)}</p>`:''}<label class="dialog-field">${html(options.label||'Name')}<input type="text" name="prompt-value" maxlength="120" value="${html(options.value||'')}" autocomplete="off" required autofocus></label>`,`<button class="button quiet" value="cancel" formnovalidate>Cancel</button><button class="button primary" value="confirm">${html(options.confirmLabel||'Save')}</button>`);const input=d.querySelector('input');input.focus();input.select();d.addEventListener('close',()=>resolve(d.returnValue==='confirm'?input.value.trim().slice(0,120)||null:null),{once:true});});
  }

  showProjects() {
    const p=this.state.project,projects=this.state.projects||[];
    this.showDialog('Your projects',`<p class="dialog-copy">Projects are saved in this browser. Download a backup to keep a copy elsewhere.</p><div class="project-list">${projects.length?projects.map(x=>`<button type="button" class="project-row ${x.id===p?.id?'is-current':''}" data-action="open-project" data-id="${html(x.id)}">${icon('folder')}<span><strong>${html(x.name||'Untitled session')}</strong><small>${this.date(x.updatedAt||x.createdAt)}${x.id===p?.id?' · Current project':''}</small></span>${icon('arrow')}</button>`).join(''):'<p class="help-copy">Your current session is your first project.</p>'}</div>`,`<button type="button" class="button quiet" data-action="import-project">${icon('upload')}Restore backup</button><button type="button" class="button primary" data-action="new-project">${icon('plus')}New project</button>`);
  }

  showExport() {
    const p=this.state.project||{},performances=(p.performances||[]).slice().reverse(),take=(p.takes||[]).find(t=>t.id===p.selectedTakeId),performance=performances.find(x=>x.id===take?.performanceId);
    const frames=performance?(performance.status==='complete'?performance.frames:performance.editableFrames??Math.min(performance.frames,take?.frames||0)):take?.frames;
    const seconds=take?Math.max(.01,Number((frames/(p.sampleRate||48000)).toFixed(2))):60;
    const canMix=(p.tracks||[]).length||take;
    this.showDialog('Take your music with you',`<div class="export-options"><section><h3>Recorded performances</h3><p class="help-copy">Your voice and backing, exactly as recorded.</p>${performances.length?performances.map(x=>`<button type="button" class="export-row" data-action="export-master" data-performance-id="${html(x.id)}"><span>${html(x.name||'Performance')}<small>${duration(x.frames,p.sampleRate)} · stereo WAV</small></span>${icon('download')}</button>`).join(''):'<p class="dialog-hint">Sing over your loops to create a performance.</p>'}</section><section><h3>Current sound, recorded arrangement</h3><p class="help-copy">${take?`Use ${html(take.name)} with your current sound settings and its recorded arrangement.`:'Render the current loop layers and mix. Select a vocal take to include your voice.'}</p><div class="export-mix-row"><label>Length <input data-export-duration data-initial="${seconds}" data-use-exact="${!!take}" type="number" min="0.01" max="86400" step="0.01" value="${seconds}" inputmode="decimal"> seconds</label><div class="export-mix-buttons"><button type="button" class="button quiet" data-action="preview-mix" ${!canMix?'disabled':''}>${icon('headphones')}Hear current mix</button><button type="button" class="button primary" data-action="export-mix" ${!canMix?'disabled':''}>${icon('download')}Render WAV</button></div></div><p class="export-mode-note">${take?'Hear current mix plays the selected vocal with the layers as they are now. Render WAV follows the recorded arrangement with your updated sound.':'Hear current mix starts live playback. Render WAV saves the length chosen above.'}</p></section><section class="backup-option"><div><h3>Whole project backup</h3><p class="help-copy">Audio, takes, sections and settings in one .fml file.</p></div><button type="button" class="button primary" data-action="export-project">${icon('download')}Backup</button></section></div>`);
  }

  showHelp() {
    this.showDialog('A whole song. All you.',`<div class="guide-steps"><div><span>01</span><section><h3>Make a little rhythm.</h3><p>Connect your microphone and choose Add loop. Record a beat, hum or sound. Your first loop is free length; finish when it feels right.</p></section></div><div><span>02</span><section><h3>Let it grow.</h3><p>Add more layers. Synced loops start at the next boundary and finish after your chosen number of cycles. Free loops finish when you choose.</p></section></div><div><span>03</span><section><h3>Give it a voice.</h3><p>Choose Sing over loops. The backing keeps its place while you record a continuous vocal. Finishing keeps the groove going and saves a separate take and stereo performance.</p></section></div><div><span>04</span><section><h3>Find the feeling.</h3><p>Open Mix to shape each layer. Save different combinations as sections, then switch them while singing to build your arrangement.</p></section></div></div><div class="guide-note">${icon('headphones')}<p>Use wired headphones for clean layers and easier timing. Keep this tab open and your device awake during recording. Download project backups for recordings you want to keep.</p></div><h3 class="shortcut-heading">A few helpful shortcuts</h3><dl class="shortcut-list"><div><dt><kbd>Space</kbd></dt><dd>Play / stop everything</dd></div><div><dt><kbd>R</kbd></dt><dd>Add a loop</dd></div><div><dt><kbd>V</kbd></dt><dd>Sing over loops</dd></div><div><dt><kbd>Enter</kbd></dt><dd>Finish recording</dd></div><div><dt><kbd>Esc</kbd></dt><dd>Cancel the current recording</dd></div><div><dt><kbd>⌘ / Ctrl Z</kbd></dt><dd>Undo · add Shift to redo</dd></div></dl><p class="help-copy">Your recordings stay in your browser. Nothing is uploaded by this studio. Browser storage can be cleared or evicted, so keep an exported backup.</p>`,`<button class="button primary" value="close">Let’s make something${icon('arrow')}</button>`);
  }

  destroy(){this.abort.abort();this.root.replaceChildren();}
}
