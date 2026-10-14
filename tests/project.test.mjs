import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, createTrack, validateProject, sectionFromProject, applySection, ProjectHistory, referencedAssets } from '../src/project.mjs';

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
test('unsafe audio positions, duplicated tracks and future versions are rejected', () => {
  const p=createProject();p.tracks.push(createTrack({assetId:'a',frames:100})); p.tracks[0].offsetFrames=Infinity;assert.throws(()=>validateProject(p),/non-finite/);
  p.tracks[0].offsetFrames=0;p.tracks.push(structuredClone(p.tracks[0]));assert.throws(()=>validateProject(p),/duplicate/);
  p.schemaVersion=99;assert.throws(()=>validateProject(p),/Unsupported/);
});
test('asset collection includes historical takes and performance snapshots', () => {
  const p=createProject();p.tracks=[{assetId:'a'}];p.performances=[{leadAssetId:'b',masterAssetId:'c',initialState:{tracks:[{assetId:'old'}]}}];
  assert.deepEqual(referencedAssets(p).sort(),['a','b','c','old']);
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
