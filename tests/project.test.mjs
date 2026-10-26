import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createTrack, validateProject, sectionFromProject, applySection, ProjectHistory, referencedAssets, DEFAULT_LOOP_RECORDING, normalizeLoopRecording } from '../src/project.mjs';
import { DEFAULT_MASTER_SETTINGS, MASTER_RANGES } from '../src/audio/master-settings.mjs';

test('project validation is complete and non-destructive', () => {
  const p = createProject('First song', 44100); p.tracks.push(createTrack({assetId:'audio-1',frames:44100})); p.baseFrames=44100;
  const valid=validateProject(p); assert.notEqual(valid,p); assert.deepEqual(valid,p);
  const broken=structuredClone(p); broken.sections=[null]; assert.throws(()=>validateProject(broken),/section/); assert.equal(p.sections.length,0);
  const dangerous=JSON.parse(JSON.stringify(p)); dangerous.extra=JSON.parse('{"__proto__":{"polluted":true}}'); assert.throws(()=>validateProject(dangerous),/reserved/); assert.equal({}.polluted,undefined);
});
test('old sections exclude newly created layers and restore the complete mix', () => {
  const p=createProject(); const a=createTrack({assetId:'a',frames:1000});p.tracks.push(a);const intro=sectionFromProject(p,'Intro');
  a.mix.volume=.2; const b=createTrack({assetId:'b',frames:2000});p.tracks.push(b);applySection(p,intro);
  assert.equal(a.mix.volume,.8);assert.equal(b.muted,true);assert.equal(b.solo,false);
});
test('history groups a slider gesture and keeps redo independent', () => {
  const h=new ProjectHistory(3),p=createProject();h.push(p,'volume',0);p.master.volume=.4;h.push(p,'volume',100);p.master.volume=.2;
  const prev=h.undo(p);assert.equal(prev.master.volume,.8);assert.equal(h.redo(prev).master.volume,.2);
});
test('history omits growing recovery checkpoints before cloning while preserving edits and recorded arrangements', () => {
  const h=new ProjectHistory(),p=createProject(),events=Array.from({length:2000},(_,frame)=>({frame,type:'mix',id:'loop',mix:{volume:.5}}));
  p.pendingCapture={events,initialState:{tracks:[]}};
  p.performances=[{id:'finished',events:[{frame:123,type:'mix',mix:{volume:.2}}]}];
  h.push(p);p.master.volume=.4;events.push({frame:2000,type:'mix',mix:{volume:.7}});h.push(p);p.master.volume=.2;
  assert.equal(h.past.length,2);assert(h.past.every(snapshot=>!Object.hasOwn(snapshot,'pendingCapture')));
  assert.equal(p.pendingCapture.events,events);assert.equal(events.length,2001);
  const restored=h.undo(p);assert.equal(restored.master.volume,.4);assert(!Object.hasOwn(restored,'pendingCapture'));assert(!Object.hasOwn(h.future[0],'pendingCapture'));
  assert.deepEqual(restored.performances,p.performances);assert.notEqual(restored.performances[0].events,p.performances[0].events);
  restored.pendingCapture={uncloneable:()=>{throw new Error('A transient checkpoint must never be cloned');}};
  const redone=h.redo(restored);assert.equal(redone.master.volume,.2);assert(h.past.every(snapshot=>!Object.hasOwn(snapshot,'pendingCapture')));
  h.push(restored);assert(!Object.hasOwn(h.past.at(-1),'pendingCapture'));
});
test('unsafe audio positions, duplicated tracks and future versions are rejected', () => {
  const p=createProject();p.tracks.push(createTrack({assetId:'a',frames:100})); p.tracks[0].offsetFrames=Infinity;assert.throws(()=>validateProject(p),/non-finite/);
  p.tracks[0].offsetFrames=0;p.tracks.push(structuredClone(p.tracks[0]));assert.throws(()=>validateProject(p),/duplicate/);
  p.schemaVersion=99;assert.throws(()=>validateProject(p),/Unsupported/);
});
test('recorded restart phase and source timing survive validation without changing live track offsets', () => {
  const p = createProject(), track = createTrack({ assetId: 'loop-audio', frames: 48000, offsetFrames: 12000 });
  p.tracks.push(track);
  p.performances.push({ id: 'aligned-song', name: 'Aligned song', source: 'loops', masterAssetId: 'aligned-master', frames: 48000, startFrame: 0, endFrame: 48000, status: 'complete', initialState: { tracks: [{ ...track, offsetFrames: 0, sourceOffsetFrames: 12000 }] }, events: [{ type: 'command', command: 'track', frame: 24000, track: { ...track, offsetFrames: 240, sourceOffsetFrames: 12240 } }] });
  const restored = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored, p);
  assert.equal(restored.tracks[0].offsetFrames, 12000);
  assert.equal(restored.performances[0].initialState.tracks[0].offsetFrames, 0);
  assert.equal(restored.performances[0].events[0].track.sourceOffsetFrames, 12240);
});
test('unsafe recorded source offsets reject before a project can be loaded or imported', () => {
  const placements = [
    (p, track) => p.tracks.push(track),
    (p, track) => p.performances.push({ id: 'song', name: 'Song', source: 'loops', masterAssetId: 'master', frames: 100, startFrame: 0, endFrame: 100, status: 'complete', initialState: { tracks: [track] } }),
    (p, track) => { p.pendingCapture = { initialState: { tracks: [track] } }; },
    (p, track) => p.events.push({ type: 'command', command: 'track', frame: 0, track }),
    (p, track) => { p.pendingCapture = { events: [{ type: 'command', command: 'track', frame: 0, track }] }; },
  ];
  for (const place of placements) for (const value of [.5, Number.MAX_SAFE_INTEGER + 1, -Number.MAX_SAFE_INTEGER - 1, '100', null]) {
    const p = createProject(); place(p, createTrack({ assetId: 'audio', frames: 100, sourceOffsetFrames: value }));
    assert.throws(() => validateProject(p), /source track offset/);
  }
});
test('asset collection includes historical takes and performance snapshots', () => {
  const p=createProject();p.tracks=[{assetId:'a'}];p.performances=[{leadAssetId:'b',masterAssetId:'c',initialState:{tracks:[{assetId:'old'}]}}];
  assert.deepEqual(referencedAssets(p).sort(),['a','b','c','old']);
});
test('loops-only performances round trip with only their stereo master and source loops', () => {
  const p = createProject();
  p.performances.push({ id: 'loops-song', name: 'Loops song', source: 'loops', masterAssetId: 'stereo-loops', frames: 48000, startFrame: 96000, endFrame: 144000, status: 'complete', initialState: { tracks: [{ assetId: 'original-loop' }] } });
  const restored = validateProject(JSON.parse(JSON.stringify(p)));
  assert.deepEqual(restored, p);
  assert.equal(Object.hasOwn(restored.performances[0], 'leadAssetId'), false);
  assert.deepEqual(referencedAssets(restored).sort(), ['original-loop', 'stereo-loops']);
});
test('only an explicit loops source may omit the vocal and cannot retain a phantom vocal reference', () => {
  const p = createProject();
  const perf = { id: 'performance', name: 'Performance', masterAssetId: 'master', frames: 48000, startFrame: 0, endFrame: 48000, status: 'complete' };
  p.performances.push(perf);
  assert.throws(() => validateProject(p), /performance vocal/);
  perf.leadAssetId = 'lead';
  assert.deepEqual(validateProject(p).performances[0], perf, 'legacy vocal metadata remains valid');
  for (const source of ['microphone', 'vocal', null, 1]) {
    perf.source = source;
    assert.throws(() => validateProject(p), /Unknown performance source/);
  }
  perf.source = 'loops';
  for (const lead of ['lead', null, '']) {
    perf.leadAssetId = lead;
    assert.throws(() => validateProject(p), /cannot reference a vocal/);
  }
  delete perf.leadAssetId;
  assert.equal(validateProject(p).performances[0].source, 'loops');
});
test('section membership cannot be inherited from an object prototype', () => {
  const p=createProject();
  p.tracks.push(createTrack({id:'constructor',assetId:'safe-audio',frames:100}));
  applySection(p,{tracks:{}});
  assert.equal(p.tracks[0].muted,true);
  assert.throws(()=>validateProject(p),/identifier/);
  p.tracks[0].id='safe-track'; p.tracks[0].assetId='__proto__';
  assert.throws(()=>validateProject(p),/identifier/);
});
test('optional click settings preserve older backups and reject unsafe timing', () => {
  const p=createProject();
  assert.deepEqual(validateProject(p).metronome,p.metronome);
  for (const [key,value] of [['bpm',0],['beatsPerCycle',1.5],['countInBeats',999],['volume',Infinity]]) {
    const broken=structuredClone(p);broken.metronome[key]=value;
    assert.throws(()=>validateProject(broken),/Invalid project/);
  }
  delete p.metronome;
  assert.equal(validateProject(p).metronome,undefined);
});

test('new and legacy projects default to free-length loops starting immediately, independently of cycle length', () => {
  const fresh = createProject(), legacy = createProject(); delete legacy.loopRecording;
  legacy.baseFrames = 96000;
  legacy.tracks.push(createTrack({ assetId: 'two-second-loop', frames: 96000 }));
  assert.deepEqual(fresh.loopRecording, { mode: 'free', seconds: 8, cycles: 1, start: 'immediate' });
  assert.deepEqual(validateProject(legacy).loopRecording, fresh.loopRecording);
  assert.equal(legacy.loopRecording, undefined, 'migration does not mutate the input project');
  assert.equal(validateProject(legacy).baseFrames, 96000, 'recording preference migration does not change existing song timing');
  fresh.loopRecording.seconds = 13.25;
  assert.equal(createProject().loopRecording.seconds, 8, 'each project owns its preferences');
  assert.equal(DEFAULT_LOOP_RECORDING.seconds, 8);
});

test('custom duration and cycle recording preferences round trip without a two-second or 64-cycle cap', () => {
  const project = createProject(), history = new ProjectHistory();
  for (const settings of [
    { mode: 'seconds', seconds: 13.275, cycles: 1, start: 'immediate' },
    { mode: 'cycles', seconds: .25, cycles: 257, start: 'next-cycle' },
    { mode: 'free', seconds: 86400.125, cycles: Number.MAX_SAFE_INTEGER, start: 'immediate' },
  ]) {
    project.loopRecording = settings;
    const restored = validateProject(JSON.parse(JSON.stringify(project)));
    assert.deepEqual(restored.loopRecording, settings);
    assert.notEqual(restored.loopRecording, settings);
  }
  history.push(project); project.loopRecording = normalizeLoopRecording({ mode: 'seconds', seconds: 7.5 });
  const original = history.undo(project);
  assert.equal(original.loopRecording.mode, 'free');
  assert.equal(history.redo(original).loopRecording.seconds, 7.5);
  assert.deepEqual(normalizeLoopRecording(), DEFAULT_LOOP_RECORDING);
});

test('loop recording settings reject invalid numeric values, choices and shapes', () => {
  const project = createProject();
  for (const settings of [null, [], 'free', 1, { mode: 'fixed' }, { mode: null }, { start: 'delayed' }, { start: null },
    ...[0, -1, NaN, Infinity, '8', null].map(seconds => ({ seconds })),
    ...[0, -1, .5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '2', null].map(cycles => ({ cycles })),
  ]) {
    project.loopRecording = settings;
    assert.throws(() => validateProject(project), /Invalid project/);
  }
  assert.equal(normalizeLoopRecording({ seconds: Number.MIN_VALUE }).seconds, Number.MIN_VALUE, 'controller validates conversion to at least one frame');
  assert.equal(normalizeLoopRecording({ seconds: Number.MAX_VALUE }).seconds, Number.MAX_VALUE, 'controller validates safe frame addressing');
});

test('recording sound settings round trip per source without creating audio dependencies', () => {
  const project = createProject();
  assert.equal(validateProject(project).recordingMixSettings, undefined, 'older projects do not acquire new metadata');
  project.recordingMixSettings = { 'stereo-performance': { gainDb: -3, normalize: true }, 'retained-mix': { balance: .4, highpass: 90 } };
  const before = structuredClone(project), validated = validateProject(project);
  assert.deepEqual(project, before);
  assert.deepEqual(validated.recordingMixSettings['stereo-performance'], { ...DEFAULT_MASTER_SETTINGS, gainDb: -3, normalize: true });
  assert.deepEqual(validated.recordingMixSettings['retained-mix'], { ...DEFAULT_MASTER_SETTINGS, balance: .4, highpass: 90 });
  assert.deepEqual(validateProject(JSON.parse(JSON.stringify(validated))), validated);
  assert.deepEqual(referencedAssets(validated), [], 'sound preferences cannot retain an otherwise deletable audio file');
  const history = new ProjectHistory(); history.push(validated);
  validated.recordingMixSettings['stereo-performance'].gainDb = 2;
  assert.equal(history.undo(validated).recordingMixSettings['stereo-performance'].gainDb, -3);
});

test('saved recording sound controls reject unsafe shapes, identifiers, booleans and numeric ranges', () => {
  const project = createProject();
  for (const value of [null, [], 'invalid', 4]) {
    project.recordingMixSettings = value;
    assert.throws(() => validateProject(project), /recording mix settings/);
  }
  project.recordingMixSettings = { 'not/a/recording': {} };
  assert.throws(() => validateProject(project), /identifier/);
  project.recordingMixSettings = { audio: {} };
  for (const [key, [minimum, maximum]] of Object.entries(MASTER_RANGES)) {
    for (const value of [minimum - .01, maximum + .01, null, String(minimum), NaN, Infinity]) {
      project.recordingMixSettings.audio = { [key]: value };
      assert.throws(() => validateProject(project), /Invalid project/);
    }
    for (const value of [minimum, maximum]) {
      project.recordingMixSettings.audio = { [key]: value };
      assert.equal(validateProject(project).recordingMixSettings.audio[key], value);
    }
  }
  for (const normalize of [null, 0, 1, 'false']) {
    project.recordingMixSettings.audio = { normalize };
    assert.throws(() => validateProject(project), /normalization/);
  }
  project.recordingMixSettings = Object.fromEntries(Array.from({ length: 10001 }, (_, index) => [`asset-${index}`, {}]));
  assert.throws(() => validateProject(project), /too many properties|Too many recording/);
});
