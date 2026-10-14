import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectProjectAudio } from '../src/audio-integrity.mjs';
import { createProject, createTrack, clone } from '../src/project.mjs';

const asset = (project, id, frames, channels = 1, extra = {}) => ({ id, projectId: project.id, frames, channels, sampleRate: project.sampleRate, status: 'complete', ...extra });

test('published truncated audio is reported without rewriting current or historical timing', () => {
  const project = createProject(), track = createTrack({ assetId: 'loop', name: 'Beat', frames: 32768, offsetFrames: 147 });
  project.tracks.push(track); project.baseFrames = track.frames;
  project.performances.push({ id: 'performance', frames: 40000, status: 'complete', leadAssetId: 'voice', masterAssetId: 'master', initialState: { tracks: [clone(track)] }, events: [] });
  const original = clone(project), issues = inspectProjectAudio(project, [asset(project, 'loop', 16384), asset(project, 'voice', 40000), asset(project, 'master', 40000, 2)]);
  assert.deepEqual(project, original); assert.equal(issues.length, 1); assert.equal(issues[0].assetId, 'loop');
  assert.equal(issues[0].reason, 'truncated'); assert.equal(issues[0].expectedFrames, 32768); assert.equal(issues[0].availableFrames, 16384); assert.equal(issues[0].prefixAvailable, true);
});

test('missing historical and event sources remain visible even after their live tracks were removed', () => {
  const project = createProject(), historic = createTrack({ assetId: 'old-loop', frames: 900 }), later = createTrack({ assetId: 'later-loop', frames: 1000 });
  project.performances.push({ frames: 2000, status: 'complete', initialState: { tracks: [historic] }, events: [{ type: 'track', track: later, frame: 1 }] });
  project.pendingCapture = { assetId: 'not-yet-created', track: createTrack({ assetId: 'pending', frames: 0 }) };
  const issues = inspectProjectAudio(project, []);
  assert.deepEqual(new Set(issues.map(issue => issue.assetId)), new Set(['old-loop', 'later-loop']));
  assert.ok(issues.every(issue => issue.reason === 'missing' && !issue.prefixAvailable));
});

test('dimension and seal mismatches cannot masquerade as playable verified prefixes', () => {
  for (const mutation of [{ channels: 2 }, { sampleRate: 44100 }, { projectId: 'another-project' }, { frames: NaN }, { status: 'recording' }]) {
    const project = createProject(); project.tracks.push(createTrack({ assetId: 'loop', frames: 100 }));
    const [issue] = inspectProjectAudio(project, [asset(project, 'loop', 100, 1, mutation)]);
    assert.ok(issue); assert.equal(issue.prefixAvailable, false);
  }
});

test('intact unequal interrupted streams are valid while a promised editable prefix is enforced', () => {
  const project = createProject(); project.performances.push({ leadAssetId: 'lead', masterAssetId: 'master', frames: 200, editableFrames: 100, status: 'interrupted' });
  const assets = [asset(project, 'lead', 100), asset(project, 'master', 200, 2)];
  assert.deepEqual(inspectProjectAudio(project, assets), []);
  project.performances[0].editableFrames = 101;
  assert.equal(inspectProjectAudio(project, assets)[0].assetId, 'lead');
});
