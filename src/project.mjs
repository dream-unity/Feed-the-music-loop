/** Immutable project metadata and validation. Audio bytes live in the storage worker. */
import { normalizeMasterSettings } from './audio/master-settings.mjs';
export const SCHEMA_VERSION = 1;
export const PAGE_FRAMES = 16384;
export const MAX_TRACKS = 512;
export const MAX_PROJECT_NODES = 1000000;
export const MAX_PROJECT_BYTES = 12 * 1024 * 1024;
export const MAX_AUTOMATION_EVENTS = 200000;
export const CAPTURE_RESERVE_NODES = 20000;
export const CAPTURE_RESERVE_BYTES = 256 * 1024;
const metadataEncoder = new TextEncoder();
export const DEFAULT_METRONOME = Object.freeze({ enabled: false, bpm: 100, beatsPerCycle: 4, countInBeats: 0, volume: 0.25 });
export const DEFAULT_LOOP_RECORDING = Object.freeze({ mode: 'free', seconds: 8, cycles: 1, start: 'immediate' });
export const ROLES = ['beat', 'bass', 'harmony', 'lead', 'texture'];
export const COLORS = { beat: '#fa987e', bass: '#dfbc6e', harmony: '#94cbb7', lead: '#d5a2d9', texture: '#85b7df' };
export const DEFAULT_MIX = Object.freeze({ volume: 0.8, pan: 0, low: 0, mid: 0, high: 0, highpass: 40, compression: 0.25, reverb: 0.08, delay: 0 });
export const MIX_RANGES = Object.freeze({ volume: [0, 2], pan: [-1, 1], low: [-18, 18], mid: [-18, 18], high: [-18, 18], highpass: [20, 2000], compression: [0, 1], reverb: [0, 1], delay: [0, 0.75] });
const PRESETS = Object.freeze({
  beat: { low: 2, mid: -1, high: 2, highpass: 35, compression: 0.34, reverb: 0.025, delay: 0 },
  bass: { low: 3, mid: -1.5, high: -5, highpass: 30, compression: 0.35, reverb: 0.015, delay: 0 },
  harmony: { low: -2, mid: -1, high: 1.5, highpass: 140, compression: 0.2, reverb: 0.22, delay: 0.06 },
  lead: { low: -1, mid: 1.5, high: 1.5, highpass: 90, compression: 0.32, reverb: 0.13, delay: 0.04 },
  texture: { low: -3, mid: -1, high: -2, highpass: 180, compression: 0.15, reverb: 0.42, delay: 0.2 },
});

export function id(prefix = '') { return `${prefix}${crypto.randomUUID()}`; }
export function clone(value) { return structuredClone(value); }
export function clamp(value, min, max) { return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : min)); }
export function roleMix(role = 'beat', current = {}) {
  return { ...DEFAULT_MIX, ...PRESETS[ROLES.includes(role) ? role : 'beat'], volume: current.volume ?? DEFAULT_MIX.volume, pan: current.pan ?? 0 };
}
export function normalizeMix(mix = {}) {
  const out = { ...DEFAULT_MIX };
  for (const [key, [min, max]] of Object.entries(MIX_RANGES)) if (key in mix) out[key] = clamp(mix[key], min, max);
  return out;
}
/** Recording length is independent of the playback cycle. Old projects begin
 * with the same free-length, immediate recording choice as new projects. */
export function normalizeLoopRecording(input = {}) {
  object(input, 'loop recording settings');
  const settings = { ...DEFAULT_LOOP_RECORDING, ...input };
  if (!['free', 'seconds', 'cycles'].includes(settings.mode)) fail('Unknown loop recording length mode.');
  if (!['immediate', 'next-cycle'].includes(settings.start)) fail('Unknown loop recording start mode.');
  number(settings.seconds, 'loop recording seconds', Number.MIN_VALUE, Number.MAX_VALUE);
  number(settings.cycles, 'loop recording cycles', 1, Number.MAX_SAFE_INTEGER, true);
  // The controller checks conversion to frames using the current sample rate
  // and cycle. Preferences carry no arbitrary duration or cycle-count ceiling.
  return { mode: settings.mode, seconds: settings.seconds, cycles: settings.cycles, start: settings.start };
}
export function createProject(name = 'Untitled session', sampleRate = 48000) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION, id: id('project-'), name: cleanName(name, 'Untitled session'),
    createdAt: now, updatedAt: now, sampleRate, baseFrames: 0, tracks: [], takes: [], sections: [], performances: [],
    selectedTakeId: null, master: { volume: 0.8 }, input: { gain: 1, monitor: false, compensationMs: 0 }, metronome: { ...DEFAULT_METRONOME }, loopRecording: { ...DEFAULT_LOOP_RECORDING }, events: [], revision: 0,
  };
}
export function createTrack({ assetId, name, role = 'beat', frames = 0, offsetFrames = 0, ...rest } = {}) {
  if (!ROLES.includes(role)) role = 'beat';
  return { id: id('track-'), assetId, name: cleanName(name, `${role[0].toUpperCase()}${role.slice(1)} layer`), role, kind: 'loop', frames,
    channels: 1, offsetFrames, muted: false, solo: false, mix: roleMix(role), color: COLORS[role], createdAt: new Date().toISOString(), ...rest };
}
export function cleanName(value, fallback = 'Untitled') { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 120) : fallback; }
export function touch(project) { project.updatedAt = new Date().toISOString(); project.revision = (project.revision || 0) + 1; return project; }
export function sectionFromProject(project, name) {
  return { id: id('section-'), name: cleanName(name, `Section ${project.sections.length + 1}`), createdAt: new Date().toISOString(),
    tracks: Object.fromEntries(project.tracks.filter(t => t.kind === 'loop').map(t => [t.id, { muted: t.muted, solo: t.solo, mix: clone(t.mix) }])) };
}
export function applySection(project, section) {
  for (const track of project.tracks) {
    if (track.kind !== 'loop') continue;
    const saved = Object.hasOwn(section.tracks, track.id) ? section.tracks[track.id] : undefined;
    track.muted = saved ? !!saved.muted : true;
    track.solo = saved ? !!saved.solo : false;
    if (saved) track.mix = normalizeMix(saved.mix);
  }
  return project;
}
export function formatTime(seconds) {
  seconds = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds / 60) % 60, s = Math.floor(seconds % 60);
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}`;
}

class ValidationError extends Error { constructor(message) { super(`Invalid project: ${message}`); this.name = 'ValidationError'; this.code = 'INVALID_PROJECT'; } }
function fail(message) { throw new ValidationError(message); }
function object(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`); return value; }
function string(value, label, max = 120) { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must be text of 1–${max} characters.`); return value; }
function validId(value, label) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(`${label} has an invalid identifier.`); return value; }
function number(value, label, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false) { if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail(`${label} is out of range.`); return value; }
function array(value, label, max = 10000) { if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array with at most ${max} entries.`); return value; }
function bool(value, label, fallback = false) { if (value === undefined) return fallback; if (typeof value !== 'boolean') fail(`${label} must be true or false.`); return value; }
function date(value, label) { if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail(`${label} must be a date.`); return value; }
function checkTree(value, depth = 0, count = { n: 0 }) {
  if (++count.n > MAX_PROJECT_NODES || depth > 30) fail('Metadata is too large or deeply nested.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Metadata contains a non-finite number.'); return; }
  if (typeof value === 'string') { if (value.length > 100000) fail('A metadata value is too long.'); return; }
  if (typeof value !== 'object') fail('Metadata contains an unsupported value.');
  if (Array.isArray(value)) {
    if (value.length > MAX_AUTOMATION_EVENTS) fail('Metadata contains an oversized list.');
    for (const child of value) checkTree(child, depth + 1, count);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > 10000) fail('Metadata contains too many properties.');
  for (const key of keys) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Metadata contains a reserved key.');
    if (key.length > 256) fail('Metadata contains an oversized key.');
    checkTree(value[key], depth + 1, count);
  }
}
export function measureMetadata(value) {
  const count = { n: 0 }; checkTree(value, 0, count);
  const bytes = metadataEncoder.encode(JSON.stringify(value)).byteLength;
  if (bytes > MAX_PROJECT_BYTES) fail('Metadata exceeds the 12 MiB project limit.');
  return { nodes: count.n, bytes };
}

/** Conservative running cost of the project, including its live capture intent. */
export class CaptureMetadataBudget {
  constructor(project) { this.reconcile(project); }
  reconcile(project) { Object.assign(this, measureMetadata(project)); return this.hasRoom(); }
  hasRoom() { return this.nodes < MAX_PROJECT_NODES - CAPTURE_RESERVE_NODES && this.bytes < MAX_PROJECT_BYTES - CAPTURE_RESERVE_BYTES; }
  append(event, eventCount) {
    let cost;
    try { cost = measureMetadata(event); } catch { return false; }
    const nodes = this.nodes + cost.nodes, bytes = this.bytes + cost.bytes + 1;
    if (eventCount >= MAX_AUTOMATION_EVENTS || nodes > MAX_PROJECT_NODES - CAPTURE_RESERVE_NODES || bytes > MAX_PROJECT_BYTES - CAPTURE_RESERVE_BYTES) return false;
    this.nodes = nodes; this.bytes = bytes; return true;
  }
}
function checkMix(value, label, strict) {
  object(value, label);
  const out = { ...DEFAULT_MIX };
  for (const [key, [min, max]] of Object.entries(MIX_RANGES)) {
    if (value[key] !== undefined) out[key] = strict ? number(value[key], `${label}.${key}`, min, max) : clamp(value[key], min, max);
  }
  return out;
}
function unique(items, label) { const seen = new Set(); for (const item of items) { if (seen.has(item.id)) fail(`${label} contains a duplicate identifier.`); seen.add(item.id); } return seen; }
function checkSourceOffset(track) {
  if (track?.sourceOffsetFrames !== undefined) number(track.sourceOffsetFrames, 'source track offset', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
}
function checkSnapshotOffsets(snapshot) {
  if (Array.isArray(snapshot?.tracks)) for (const track of snapshot.tracks) checkSourceOffset(track);
}

/** Validate the complete metadata before a load/import can replace the active project. */
export function validateProject(input, { strict = true } = {}) {
  object(input, 'project'); measureMetadata(input);
  if (input.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported schema version ${input.schemaVersion}. This app supports version ${SCHEMA_VERSION}.`);
  const p = clone(input);
  validId(p.id, 'project'); string(p.name, 'name');
  date(p.createdAt, 'createdAt'); date(p.updatedAt, 'updatedAt');
  number(p.sampleRate, 'sampleRate', 8000, 192000, true); number(p.baseFrames, 'baseFrames', 0, Number.MAX_SAFE_INTEGER, true);
  number(p.revision ?? 0, 'revision', 0, Number.MAX_SAFE_INTEGER, true); p.revision ??= 0;
  p.loopRecording = normalizeLoopRecording(p.loopRecording);
  if (p.recordingMixSettings !== undefined) {
    object(p.recordingMixSettings, 'recording mix settings');
    if (Object.keys(p.recordingMixSettings).length > 10000) fail('Too many recording sound settings.');
    for (const [assetId, settings] of Object.entries(p.recordingMixSettings)) {
      validId(assetId, 'recording sound settings');
      try { p.recordingMixSettings[assetId] = normalizeMasterSettings(settings); }
      catch (error) { fail(error.message); }
    }
  }
  const tracks = array(p.tracks, 'tracks', MAX_TRACKS);
  for (const t of tracks) {
    object(t, 'track'); validId(t.id, 'track'); validId(t.assetId, 'track audio'); string(t.name, 'track name');
    if (!ROLES.includes(t.role)) fail('Unknown vocal role.');
    if (!['loop', 'vocal'].includes(t.kind)) fail('Unknown track type.');
    number(t.frames, 'track frames', 1, Number.MAX_SAFE_INTEGER, true); number(t.channels, 'track channels', 1, 2, true);
    number(t.offsetFrames ?? 0, 'track offset', -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true); t.offsetFrames ??= 0;
    checkSourceOffset(t);
    t.muted = bool(t.muted, 'track mute'); t.solo = bool(t.solo, 'track solo'); t.mix = checkMix(t.mix, 'track mix', strict);
    if (t.color !== undefined && !/^#[0-9a-f]{6}$/i.test(t.color)) fail('Invalid track colour.');
    if (t.peaks !== undefined) { array(t.peaks, 'waveform', 4096); for (const v of t.peaks) number(v, 'waveform peak', 0, 128); }
  }
  unique(tracks, 'tracks');
  const sections = array(p.sections, 'sections', 1024);
  for (const s of sections) {
    object(s, 'section'); validId(s.id, 'section'); string(s.name, 'section name'); object(s.tracks, 'section tracks');
    if (Object.keys(s.tracks).length > MAX_TRACKS) fail('Section contains too many tracks.');
    for (const [trackId, settings] of Object.entries(s.tracks)) {
      validId(trackId, 'section track'); object(settings, 'section track settings'); settings.muted = bool(settings.muted, 'section mute'); settings.solo = bool(settings.solo, 'section solo');
      settings.mix = checkMix(settings.mix, 'section mix', strict);
    }
  }
  unique(sections, 'sections');
  const takes = array(p.takes, 'takes');
  for (const t of takes) {
    object(t, 'take'); validId(t.id, 'take'); validId(t.assetId, 'take audio'); string(t.name, 'take name');
    number(t.frames, 'take frames', 0, Number.MAX_SAFE_INTEGER, true); number(t.startFrame, 'take start', 0, Number.MAX_SAFE_INTEGER, true);
    if (t.performanceId != null) validId(t.performanceId, 'take performance');
    if (t.mix !== undefined) t.mix = checkMix(t.mix, 'vocal mix', strict);
  }
  const takeIds = unique(takes, 'takes');
  if (p.selectedTakeId != null && !takeIds.has(p.selectedTakeId)) fail('Selected take does not exist.'); p.selectedTakeId ??= null;
  const performances = array(p.performances, 'performances');
  for (const perf of performances) {
    object(perf, 'performance'); validId(perf.id, 'performance'); string(perf.name, 'performance name');
    if (perf.source !== undefined && perf.source !== 'loops') fail('Unknown performance source.');
    if (perf.source === 'loops') {
      if (Object.hasOwn(perf, 'leadAssetId')) fail('A loops-only performance cannot reference a vocal recording.');
    } else validId(perf.leadAssetId, 'performance vocal');
    validId(perf.masterAssetId, 'performance mix');
    number(perf.frames, 'performance frames', 0, Number.MAX_SAFE_INTEGER, true); number(perf.startFrame, 'performance start', 0, Number.MAX_SAFE_INTEGER, true);
    number(perf.endFrame, 'performance end', perf.startFrame, Number.MAX_SAFE_INTEGER, true);
    if (!['complete', 'interrupted', 'recovered'].includes(perf.status)) fail('Unknown performance status.');
    if (perf.tailFrames !== undefined) number(perf.tailFrames, 'performance tail', 0, Number.MAX_SAFE_INTEGER, true);
    if (perf.arrangementIncomplete !== undefined) bool(perf.arrangementIncomplete, 'incomplete arrangement');
    if (perf.removed !== undefined) bool(perf.removed, 'removed performance');
    if (perf.arrangementThroughFrame !== undefined) number(perf.arrangementThroughFrame, 'arrangement boundary', 0, Number.MAX_SAFE_INTEGER, true);
    if (perf.editableFrames !== undefined) number(perf.editableFrames, 'editable performance length', 0, perf.frames, true);
    if (perf.arrangementIncomplete && (perf.status === 'complete' || perf.editableFrames === undefined)) fail('An incomplete arrangement needs an interrupted status and a verified editable interval.');
    checkEvents(perf.events ?? [], 'performance events');
    checkSnapshotOffsets(perf.initialState);
  }
  checkSnapshotOffsets(p.pendingCapture?.initialState);
  if (Array.isArray(p.pendingCapture?.events)) for (const event of p.pendingCapture.events) checkSourceOffset(event?.track);
  if (p.pendingCapture?.arrangementIncomplete !== undefined) bool(p.pendingCapture.arrangementIncomplete, 'incomplete capture arrangement');
  if (p.pendingCapture?.arrangementThroughFrame !== undefined) number(p.pendingCapture.arrangementThroughFrame, 'capture arrangement boundary', 0, Number.MAX_SAFE_INTEGER, true);
  const perfIds = unique(performances, 'performances');
  for (const t of takes) if (t.performanceId && !perfIds.has(t.performanceId)) fail('A vocal take references a missing performance.');
  object(p.master, 'master'); p.master.volume = number(p.master.volume, 'master volume', 0, 2);
  object(p.input, 'input'); p.input.gain = number(p.input.gain, 'input gain', 0, 4); p.input.monitor = bool(p.input.monitor, 'monitor');
  p.input.compensationMs = number(p.input.compensationMs, 'latency compensation', 0, 1000);
  if (p.input.mix !== undefined) p.input.mix = checkMix(p.input.mix, 'input mix', strict);
  if (p.metronome !== undefined) {
    object(p.metronome, 'metronome');
    p.metronome.enabled = bool(p.metronome.enabled, 'click enabled');
    number(p.metronome.bpm, 'click tempo', 40, 240);
    number(p.metronome.beatsPerCycle, 'beats per cycle', 1, 16, true);
    if (![0, 4, 8].includes(p.metronome.countInBeats)) fail('Count-in must be off, four beats or eight beats.');
    number(p.metronome.volume, 'click volume', 0, 1);
  }
  checkEvents(p.events ?? [], 'events'); p.events ??= [];
  return p;
}
function checkEvents(events, label) {
  array(events, label, MAX_AUTOMATION_EVENTS);
  for (const event of events) { object(event, 'event'); number(event.frame, 'event frame', 0, Number.MAX_SAFE_INTEGER, true); string(event.type, 'event type', 64); checkSourceOffset(event.track); }
}
export function referencedAssets(project) {
  const found = new Set();
  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 30) return;
    for (const [key, value] of Object.entries(obj)) {
      if (['assetId', 'leadAssetId', 'masterAssetId'].includes(key) && typeof value === 'string') found.add(value);
      else if (value && typeof value === 'object') walk(value, depth + 1);
    }
  }
  walk(project); return [...found];
}

export class ProjectHistory {
  constructor(limit = 40, byteLimit = 16 * 1024 * 1024) {
    this.limit = limit; this.byteLimit = byteLimit; this.past = []; this.future = [];
    this.lastKey = null; this.lastAt = 0; this.costs = new WeakMap();
  }
  snapshot(project) {
    // A live recovery checkpoint is not an editable project version. Exclude
    // its growing event log before cloning; Undo already discards checkpoints.
    const snapshot = { ...project }; delete snapshot.pendingCapture;
    const copy = clone(snapshot);
    this.costs.set(copy, metadataEncoder.encode(JSON.stringify(copy)).byteLength);
    return copy;
  }
  trim(preferred = 'past') {
    while (this.past.length > this.limit) this.past.shift();
    while (this.future.length > this.limit) this.future.shift();
    let bytes = [...this.past, ...this.future].reduce((total, item) => total + (this.costs.get(item) || 0), 0);
    while (bytes > this.byteLimit && this.past.length + this.future.length > 1) {
      const list = preferred === 'future' ? (this.past.length ? this.past : this.future) : (this.future.length ? this.future : this.past);
      const removed = list.shift(); bytes -= this.costs.get(removed) || 0;
    }
  }
  push(project, key = null, now = performance.now()) {
    if (key && this.lastKey === key && now - this.lastAt < 600) { this.lastAt = now; return; }
    this.past.push(this.snapshot(project)); this.future.length = 0; this.trim(); this.lastKey = key; this.lastAt = now;
  }
  undo(current) {
    if (!this.past.length) return null;
    const restored = this.past.pop(); this.future.push(this.snapshot(current)); this.trim('future'); this.lastKey = null; return restored;
  }
  redo(current) {
    if (!this.future.length) return null;
    const restored = this.future.pop(); this.past.push(this.snapshot(current)); this.trim(); this.lastKey = null; return restored;
  }
  clear() { this.past.length = 0; this.future.length = 0; this.lastKey = null; }
}
