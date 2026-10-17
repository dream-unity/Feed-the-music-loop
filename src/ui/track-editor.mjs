const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const seconds = (frames, rate) => (frames / rate).toFixed(6).replace(/\.?0+$/, '') || '0';

/** Small, DOM-only editor. Audio and saved edits are owned by the controller. */
export class TrackEditor {
  constructor(root, emit) {
    this.root = root;
    this.emit = emit;
    this.abort = new AbortController();
    this.model = null;
    root.innerHTML = this.markup();
    this.refs = Object.fromEntries([...root.querySelectorAll('[data-editor-ref]')].map(el => [el.dataset.editorRef, el]));
    const options = {signal: this.abort.signal};
    root.addEventListener('click', event => this.click(event), options);
    root.addEventListener('change', event => this.change(event), options);
    root.addEventListener('input', event => {
      if (event.target.matches('input[type="number"]')) {
        event.target.setCustomValidity('');
        this.refs.error.textContent = '';
      }
    }, options);
    this.refs.wave.addEventListener('pointerdown', event => this.pointerDown(event), options);
    this.refs.wave.addEventListener('pointermove', event => this.pointerMove(event), options);
    this.refs.wave.addEventListener('pointerup', event => this.pointerUp(event), options);
    this.refs.wave.addEventListener('pointercancel', () => this.cancelPointer(), options);
    this.refs.wave.addEventListener('lostpointercapture', () => this.cancelPointer(), options);
    this.refs.wave.addEventListener('keydown', event => this.key(event), options);
  }

  markup() {
    const input = (name, label, ref) => `<label class="editor-field"><span>${label}</span><span class="editor-number"><input type="number" min="0" step="any" inputmode="decimal" aria-label="${name}" data-editor-ref="${ref}"><span>s</span></span></label>`;
    return `<div class="track-editor" data-testid="track-editor">
      <div class="editor-intro"><label class="editor-track-picker">Track to edit<select data-editor-ref="track" aria-label="Track to edit"></select></label><div class="editor-track-info"><span>TRACK LENGTH</span><strong data-editor-ref="duration"></strong></div></div>
      <p class="editor-instructions" id="editor-wave-help">Drag across the waveform to select a moment. Tap to place the paste cursor, or enter exact times below.</p>
      <div class="editor-wave" data-editor-ref="wave" data-testid="editor-waveform" role="group" aria-label="Audio selection" aria-describedby="editor-wave-help">
        <svg data-editor-ref="waveform" viewBox="0 0 800 120" preserveAspectRatio="none" aria-hidden="true"></svg>
        <div class="editor-wave-loading" data-editor-ref="waveLoading" hidden>Reading waveform…</div>
        <div class="editor-selection" data-editor-ref="selection" aria-hidden="true"></div>
        <button type="button" class="editor-handle editor-start" data-editor-ref="startHandle" data-editor-handle="start" role="slider" aria-label="Selection start" aria-orientation="horizontal"><span></span></button>
        <button type="button" class="editor-handle editor-end" data-editor-ref="endHandle" data-editor-handle="end" role="slider" aria-label="Selection end" aria-orientation="horizontal"><span></span></button>
        <button type="button" class="editor-cursor" data-editor-ref="cursorHandle" data-editor-handle="cursor" role="slider" aria-label="Paste position" aria-orientation="horizontal"><span></span></button>
      </div>
      <div class="editor-ruler" aria-hidden="true"><span>0 s</span><span data-editor-ref="midpoint"></span><span data-editor-ref="endpoint"></span></div>
      <div class="editor-selection-fields">${input('Selection start in seconds', 'Selection start', 'start')}${input('Selection end in seconds', 'Selection end', 'end')}<div class="editor-selected-time"><span>SELECTED</span><output data-editor-ref="selected"></output></div></div>
      <div class="editor-selection-actions"><button type="button" class="button quiet" data-editor-action="select-all">Select all</button><button type="button" class="button quiet" data-editor-action="preview">Listen to selection</button><button type="button" class="button quiet" data-editor-action="copy">Copy selection</button><button type="button" class="button primary" data-editor-action="trim">Trim to selection</button></div>
      <div class="editor-preview" data-editor-ref="previewWrap" hidden><audio controls preload="metadata" data-editor-ref="audio" data-testid="editor-preview" data-editor-preview aria-label="Selected audio preview"></audio><button type="button" class="button quiet" data-editor-action="stop-preview">Stop preview</button></div>
      <div class="editor-tools">
        <section class="editor-tool"><h3>Change length</h3><p>Shorten from the end, or extend with repeated audio or silence. Playback speed stays the same. This track repeats at its new length; the groove cycle stays unchanged.</p><div class="editor-length-fields">${input('Track length in seconds', 'New length', 'length')}<label class="editor-field"><span>When lengthening</span><select data-editor-ref="extension" aria-label="When lengthening"><option value="repeat">Repeat this track</option><option value="silence">Add silence</option></select></label></div><button type="button" class="button quiet" data-editor-action="resize">Set length</button></section>
        <section class="editor-tool"><h3>Paste copied audio</h3><p class="editor-clipboard" data-editor-ref="clipboard" role="status">Copy a selection from any track to paste it here.</p><div class="editor-paste-fields">${input('Paste position in seconds', 'Paste position', 'cursor')}<label class="editor-field"><span>Paste mode</span><select data-editor-ref="pasteMode" aria-label="Paste mode"><option value="insert">Insert at cursor</option><option value="replace">Replace selection</option></select></label></div><p class="editor-paste-result" data-editor-ref="pasteResult"></p><button type="button" class="button quiet" data-editor-action="paste">Paste</button></section>
      </div>
      <p class="editor-error" data-editor-ref="error" role="alert"></p>
      <div class="editor-status" role="status" data-editor-ref="status"></div>
      <p class="editor-save-note">Each edit saves immediately. Use Undo to restore an earlier version. Copying keeps the original track unchanged.</p>
    </div>`;
  }

  update(model) {
    if (!model) return;
    const previous = this.model;
    const changedAudio = !previous || previous.trackId !== model.trackId || previous.assetId !== model.assetId || previous.frames !== model.frames;
    this.model = {...model};
    if (!this.drag) {
      this.startFrame = clamp(model.startFrame ?? 0, 0, Math.max(0, model.frames - 1));
      this.endFrame = clamp(model.endFrame ?? model.frames, this.startFrame + 1, model.frames);
      this.cursorFrame = clamp(model.cursorFrame ?? 0, 0, model.frames);
    }
    this.root.setAttribute('aria-busy', String(!!model.busy));
    this.refs.wave.classList.toggle('is-loading', !!model.waveformLoading || !!model.waveformError);
    this.refs.wave.setAttribute('aria-busy', String(!!model.waveformLoading));
    this.refs.waveLoading.hidden = !model.waveformLoading;
    const tracks = model.tracks || [{id: model.trackId, name: model.name}];
    const signature = JSON.stringify(tracks.map(track => [track.id, track.name]));
    if (this.trackSignature !== signature) {
      this.refs.track.innerHTML = tracks.map(track => `<option value="${escape(track.id)}">${escape(track.name)}</option>`).join('');
      this.trackSignature = signature;
    }
    this.refs.track.value = model.trackId;
    this.refs.duration.textContent = `${seconds(model.frames, model.sampleRate)} s`;
    this.refs.midpoint.textContent = `${seconds(Math.round(model.frames / 2), model.sampleRate)} s`;
    this.refs.endpoint.textContent = `${seconds(model.frames, model.sampleRate)} s`;
    if (changedAudio || this.peaks !== model.peaks) {
      this.drawWaveform(model.peaks);
      this.peaks = model.peaks;
    }
    if (changedAudio) {
      this.refs.length.value = seconds(model.frames, model.sampleRate);
      for (const name of ['start', 'end', 'cursor', 'length']) this.refs[name].setCustomValidity('');
    }
    this.refs.length.min = '0';
    this.refs.length.max = '86400';
    // Visible seconds are rounded for reading. Leave one microsecond of native
    // input tolerance; readFrame still enforces the exact integer sample bound.
    this.refs.start.max = this.refs.end.max = this.refs.cursor.max = String(model.frames / model.sampleRate + .000001);
    this.refs.end.min = '0';
    this.refs.clipboard.textContent = model.clipboard ? `${model.clipboard.name || 'Copied audio'} · ${seconds(model.clipboard.frames, model.clipboard.sampleRate || model.sampleRate)} s copied. Choose any track above to paste into it.` : 'Copy a selection from any track to paste it here.';
    this.refs.status.textContent = model.waveformLoading ? 'Reading the whole track waveform…' : model.busy ? (model.progress?.ratio !== undefined ? `Saving edit… ${Math.round(model.progress.ratio * 100)}%` : 'Preparing audio…') : (model.previewBusy ? 'Preparing your selection to listen…' : model.message || 'Edits are saved in this project.');
    this.refs.error.textContent = model.error || model.waveformError || '';
    if (model.waveformError) { this.refs.waveLoading.hidden = false; this.refs.waveLoading.textContent = 'Waveform unavailable'; }
    else this.refs.waveLoading.textContent = 'Reading waveform…';
    this.root.querySelectorAll('button,input,select').forEach(el => el.disabled = !!model.busy);
    this.root.querySelector('[data-editor-action="preview"]').disabled = !!model.busy || !!model.previewBusy;
    this.root.querySelector('[data-editor-action="paste"]').disabled = !!model.busy || !model.clipboard;
    this.root.querySelector('[data-editor-action="trim"]').disabled = !!model.busy || (this.startFrame === 0 && this.endFrame === model.frames);
    this.syncRange();
    const previewUrl = model.previewUrl || '';
    if (this.previewUrl !== previewUrl) {
      this.refs.audio.pause();
      this.refs.audio.removeAttribute('src');
      this.refs.audio.load();
      this.previewUrl = previewUrl;
      this.refs.previewWrap.hidden = !previewUrl;
      if (previewUrl) {
        this.refs.audio.src = previewUrl;
        this.refs.audio.play().catch(() => { this.refs.status.textContent = 'Selection ready. Press play to listen.'; });
      }
    }
  }

  drawWaveform(peaks) {
    const values = Array.isArray(peaks) || ArrayBuffer.isView(peaks) ? peaks : [];
    const count = Math.min(400, values.length), bars = [];
    for (let i = 0; i < count; i++) {
      const first = Math.floor(i * values.length / count), end = Math.ceil((i + 1) * values.length / count);
      let peak = 0;
      for (let j = first; j < end; j++) {
        const value = values[j];
        if (Array.isArray(value) || ArrayBuffer.isView(value)) for (const n of value) peak = Math.max(peak, Number.isFinite(n) ? Math.abs(n) : 0);
        else peak = Math.max(peak, Number.isFinite(value) ? Math.abs(value) : 0);
      }
      const height = Math.max(1, Math.min(1, peak) * 100);
      bars.push(`<rect x="${i * 800 / count}" y="${(120 - height) / 2}" width="${Math.max(1, 800 / count - 1)}" height="${height}" rx=".8"/>`);
    }
    this.refs.waveform.innerHTML = `<path d="M0 60H800" stroke="currentColor" stroke-opacity=".2"/>${bars.join('')}`;
  }

  syncRange() {
    if (!this.model) return;
    const {frames, sampleRate} = this.model;
    const start = this.startFrame / frames * 100, end = this.endFrame / frames * 100, cursor = this.cursorFrame / frames * 100;
    this.refs.selection.style.left = `${start}%`;
    this.refs.selection.style.width = `${end - start}%`;
    for (const [name, frame, position] of [['start', this.startFrame, start], ['end', this.endFrame, end], ['cursor', this.cursorFrame, cursor]]) {
      const handle = this.refs[`${name}Handle`], input = this.refs[name];
      handle.style.left = `${position}%`;
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', String(frames));
      handle.setAttribute('aria-valuenow', String(frame));
      handle.setAttribute('aria-valuetext', `${seconds(frame, sampleRate)} seconds`);
      if (document.activeElement !== input || this.drag) input.value = seconds(frame, sampleRate);
    }
    this.refs.selected.textContent = `${seconds(this.endFrame - this.startFrame, sampleRate)} s`;
    this.root.querySelector('[data-editor-action="trim"]').disabled = !!this.model.busy || (this.startFrame === 0 && this.endFrame === frames);
    const replace = this.refs.pasteMode.value === 'replace';
    this.refs.cursor.disabled = !!this.model.busy || replace;
    const clip = this.model.clipboard;
    this.refs.pasteResult.textContent = clip ? `${replace ? 'Replaces the selected audio' : 'Inserts audio and moves later sound forward'}. New length: ${seconds(frames + clip.frames - (replace ? this.endFrame - this.startFrame : 0), sampleRate)} s.` : '';
  }

  frameAt(event) {
    const rect = this.refs.wave.getBoundingClientRect();
    return Math.round(clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * this.model.frames);
  }

  pointerDown(event) {
    if (!this.model || this.model.busy || this.model.waveformLoading || this.model.waveformError || event.button !== 0) return;
    event.preventDefault();
    const handle = event.target.closest('[data-editor-handle]')?.dataset.editorHandle;
    this.refs.wave.setPointerCapture(event.pointerId);
    this.drag = {id: event.pointerId, handle, anchor: this.frameAt(event), x: event.clientX, original: [this.startFrame, this.endFrame, this.cursorFrame]};
    if (handle) this.moveHandle(handle, this.frameAt(event));
    this.refs.audio.pause();
  }

  pointerMove(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const frame = this.frameAt(event);
    if (this.drag.handle) this.moveHandle(this.drag.handle, frame);
    else if (Math.abs(event.clientX - this.drag.x) >= 3) {
      this.drag.moved = true;
      this.startFrame = Math.min(this.drag.anchor, frame, this.model.frames - 1);
      this.endFrame = Math.max(this.startFrame + 1, this.drag.anchor, frame);
      this.cursorFrame = this.startFrame;
    }
    this.syncRange();
  }

  pointerUp(event) {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    this.pointerMove(event);
    const drag = this.drag;
    this.clearRangeValidity();
    if (!drag.handle && !drag.moved) this.cursorFrame = this.frameAt(event);
    this.drag = null;
    this.refs.wave.releasePointerCapture?.(event.pointerId);
    this.syncRange();
    if (drag.handle === 'cursor' || (!drag.handle && !drag.moved)) this.emit('editor-cursor', {frame: this.cursorFrame});
    else this.emit('editor-select', {startFrame: this.startFrame, endFrame: this.endFrame, cursorFrame: this.cursorFrame});
  }

  cancelPointer() {
    if (!this.drag) return;
    [this.startFrame, this.endFrame, this.cursorFrame] = this.drag.original;
    this.drag = null;
    this.syncRange();
  }

  moveHandle(handle, frame) {
    if (handle === 'start') this.startFrame = clamp(frame, 0, this.endFrame - 1);
    if (handle === 'end') this.endFrame = clamp(frame, this.startFrame + 1, this.model.frames);
    if (handle === 'cursor') this.cursorFrame = clamp(frame, 0, this.model.frames);
    this.syncRange();
  }

  key(event) {
    const handle = event.target.dataset.editorHandle;
    if (!handle || this.model?.busy || !['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    event.preventDefault();
    const value = this[`${handle === 'cursor' ? 'cursor' : handle}Frame`];
    const step = event.key.startsWith('Page') ? Math.max(1, Math.round(this.model.sampleRate / 10)) : event.shiftKey ? Math.max(1, Math.round(this.model.sampleRate / 100)) : 1;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.model.frames : value + (['ArrowRight', 'ArrowUp', 'PageUp'].includes(event.key) ? step : -step);
    this.moveHandle(handle, next);
    this.clearRangeValidity();
    this.refs.audio.pause();
    if (handle === 'cursor') this.emit('editor-cursor', {frame: this.cursorFrame});
    else this.emit('editor-select', {startFrame: this.startFrame, endFrame: this.endFrame});
  }

  clearRangeValidity() {
    for (const name of ['start', 'end', 'cursor']) this.refs[name].setCustomValidity('');
    this.refs.error.textContent = '';
  }

  readFrame(input, label, max = this.model.frames) {
    const value = Number(input.value);
    const frame = Math.round(value * this.model.sampleRate);
    if (!input.value.trim() || !Number.isFinite(value) || !Number.isSafeInteger(frame) || frame < 0 || frame > max) {
      const message = `${label} must be between 0 and ${seconds(max, this.model.sampleRate)} seconds.`;
      input.setCustomValidity(message);
      this.refs.error.textContent = message;
      input.reportValidity();
      return null;
    }
    input.setCustomValidity('');
    return frame;
  }

  change(event) {
    if (!this.model || this.model.busy) return;
    const el = event.target;
    if (el === this.refs.track) return this.emit('edit-track', {id: el.value});
    if (el === this.refs.pasteMode) return this.syncRange();
    if (el === this.refs.cursor) {
      const frame = this.readFrame(el, 'Paste position');
      if (frame === null) return;
      this.cursorFrame = frame;
      el.value = seconds(frame, this.model.sampleRate);
      this.syncRange();
      return this.emit('editor-cursor', {frame});
    }
    if (el === this.refs.start || el === this.refs.end) {
      const startFrame = this.readFrame(this.refs.start, 'Selection start'), endFrame = this.readFrame(this.refs.end, 'Selection end');
      if (startFrame === null || endFrame === null) return;
      if (endFrame <= startFrame) {
        const message = 'Selection end must be later than selection start.';
        el.setCustomValidity(message); this.refs.error.textContent = message; el.reportValidity(); return;
      }
      this.startFrame = startFrame;
      this.endFrame = endFrame;
      this.refs.start.value = seconds(startFrame, this.model.sampleRate);
      this.refs.end.value = seconds(endFrame, this.model.sampleRate);
      this.refs.audio.pause();
      this.syncRange();
      this.emit('editor-select', {startFrame, endFrame});
    }
  }

  click(event) {
    const button = event.target.closest('[data-editor-action]');
    if (!button || button.disabled || !this.model || this.model.busy) return;
    const action = button.dataset.editorAction;
    if (action === 'select-all') {
      this.startFrame = 0; this.endFrame = this.model.frames;
      this.refs.start.setCustomValidity(''); this.refs.end.setCustomValidity('');
      this.refs.start.value = '0'; this.refs.end.value = seconds(this.model.frames, this.model.sampleRate);
      this.syncRange(); return this.emit('editor-select', {startFrame: 0, endFrame: this.model.frames});
    }
    if (action === 'stop-preview') {
      this.refs.audio.pause();
      this.refs.audio.currentTime = 0;
      return this.emit('editor-stop-preview');
    }
    if (action === 'resize') {
      const frames = this.readFrame(this.refs.length, 'New length', 86400 * this.model.sampleRate);
      if (frames === null) return;
      if (frames < 1) { this.refs.error.textContent = 'Choose a length greater than zero.'; return; }
      return this.emit('editor-resize', {frames, extension: this.refs.extension.value});
    }
    if (['trim', 'copy', 'preview', 'paste'].includes(action)) {
      if (!this.refs.start.reportValidity() || !this.refs.end.reportValidity()) return;
      if (action === 'paste' && !this.refs.cursor.reportValidity()) return;
      this.emit(`editor-${action}`, action === 'paste' ? {mode: this.refs.pasteMode.value} : {});
    }
  }

  destroy() {
    this.refs.audio.pause();
    this.refs.audio.removeAttribute('src');
    this.refs.audio.load();
    this.abort.abort();
  }
}
