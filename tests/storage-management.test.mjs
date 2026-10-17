import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, createProject, createTrack, referencedAssets, sectionFromProject, validateProject } from '../src/project.mjs';
import { LOW_STORAGE_BYTES, normalizedStorageCapacity, removeAssetReferences } from '../src/storage-management.mjs';

test('capacity distinguishes a valid browser estimate from missing, malformed, or privacy-limited information', () => {
  for (const estimate of [{}, null, { quota: 0, usage: 0 }, { quota: -1, usage: 0 }, { quota: Infinity, usage: 0 }, { quota: 100, usage: null }, { quota: 100, usage: undefined }, { quota: 100, usage: -1 }, { quota: 100, usage: NaN }, { quota: '100', usage: 0 }, { quota: 100, usage: '0' }]) {
    const result = normalizedStorageCapacity(estimate); assert.equal(result.known, false); assert.equal(result.remaining, null); assert.equal(result.low, false);
  }
  assert.deepEqual(normalizedStorageCapacity({ quota: 100, usage: 30 }), { known: true, quota: 100, usage: 30, remaining: 70, low: true });
  assert.equal(normalizedStorageCapacity({ quota: 100, usage: 110 }).remaining, 0);
  assert.equal(normalizedStorageCapacity({ quota: LOW_STORAGE_BYTES, usage: 0 }).low, false);
  assert.equal(normalizedStorageCapacity({ quota: LOW_STORAGE_BYTES, usage: 1 }).low, true);
});

function populated() {
  const project = createProject('Song'), track = createTrack({ id: 'loop-track', assetId: 'loop-audio', frames: 100, name: 'Bass' }), kept = createTrack({ id: 'kept-track', assetId: 'kept-audio', frames: 100, name: 'Beat' });
  project.tracks = [track, kept]; project.baseFrames = 100; project.sections = [sectionFromProject(project, 'Chorus')];
  project.takes = [{ id: 'voice', name: 'Voice', assetId: 'vocal-audio', frames: 100, startFrame: 0, performanceId: 'performance' }]; project.selectedTakeId = 'voice';
  project.performances = [{ id: 'performance', name: 'Full song', leadAssetId: 'vocal-audio', masterAssetId: 'master-audio', frames: 100, startFrame: 0, endFrame: 100, status: 'complete', initialState: { tracks: clone(project.tracks) }, events: [
    { type: 'track', frame: 1, track: clone(track) }, { type: 'mix', frame: 2, id: track.id, muted: true }, { type: 'remove-track', frame: 3, id: track.id }, { type: 'section', frame: 4, section: clone(project.sections[0]) }, { type: 'mix', frame: 5, id: kept.id, muted: true },
  ] }];
  project.events = clone(project.performances[0].events); return project;
}
test('permanent loop deletion prunes historical tracks, arrangement events, and section membership without changing other recordings', () => {
  const before = populated(), original = clone(before), { project, changed, impacts } = removeAssetReferences(before, 'loop-audio');
  assert.equal(changed, true); assert.deepEqual(before, original); validateProject(project);
  assert.equal(project.tracks.length, 1); assert.equal(project.tracks[0].assetId, 'kept-audio');
  assert.deepEqual(referencedAssets(project).sort(), ['kept-audio', 'master-audio', 'vocal-audio']);
  assert.deepEqual(impacts.tracks, ['Bass']); assert.deepEqual(impacts.arrangements, ['Full song']);
  assert.equal(project.sections[0].tracks['loop-track'], undefined);
  assert.deepEqual(project.performances[0].events.map(event => event.type), ['section', 'mix']);
  assert.equal(project.performances[0].events[0].section.tracks['loop-track'], undefined);
  assert.equal(project.performances[0].events[1].id, 'kept-track'); assert.equal(project.baseFrames, 100);
});
test('deleting a stereo master keeps its vocal as an independent selected take', () => {
  const { project, impacts } = removeAssetReferences(populated(), 'master-audio'); validateProject(project);
  assert.equal(project.performances.length, 0); assert.equal(project.takes.length, 1); assert.equal(project.takes[0].performanceId, null);
  assert.equal(project.selectedTakeId, 'voice'); assert.deepEqual(impacts.performances, ['Full song']);
  assert.deepEqual(referencedAssets(project).sort(), ['kept-audio', 'loop-audio', 'vocal-audio']);
});
test('deleting a vocal removes its layer and performance references but never requests deletion of its other audio assets', () => {
  const source = populated(); source.tracks.push(createTrack({ assetId: 'vocal-audio', name: 'Vocal layer', frames: 100 }));
  const { project, impacts } = removeAssetReferences(source, 'vocal-audio'); validateProject(project);
  assert.equal(project.takes.length, 0); assert.equal(project.selectedTakeId, null); assert.equal(project.performances.length, 0);
  assert.equal(project.tracks.length, 2); assert.deepEqual(impacts.takes, ['Voice']); assert.deepEqual(impacts.tracks, ['Vocal layer']);
});
test('pending captures are removed only when their own recording is deleted and otherwise have backing snapshots pruned', () => {
  const source = populated(); source.pendingCapture = { assetId: 'unfinished-audio', initialState: { tracks: clone(source.tracks) }, events: clone(source.events) };
  const backing = removeAssetReferences(source, 'loop-audio'); assert.equal(backing.project.pendingCapture.assetId, 'unfinished-audio'); assert.equal(referencedAssets(backing.project).includes('loop-audio'), false);
  const unfinished = removeAssetReferences(source, 'unfinished-audio'); assert.equal(unfinished.project.pendingCapture, undefined); assert.equal(unfinished.impacts.pendingCapture, true);
});
test('unknown reference shapes fail closed and an unused file leaves project metadata unchanged', () => {
  const source = populated(), before = clone(source);
  assert.deepEqual(removeAssetReferences(source, 'unused').project, source); assert.equal(removeAssetReferences(source, 'unused').changed, false);
  source.futureFeature = { assetId: 'future-audio' };
  assert.throws(() => removeAssetReferences(source, 'future-audio'), { code: 'UNSUPPORTED_ASSET_REFERENCE' });
  assert.equal(source.futureFeature.assetId, 'future-audio'); assert.deepEqual(source.tracks, before.tracks);
});

test('permanent deletion removes only that recording sound preference without retaining its audio', () => {
  const source = populated(); source.recordingMixSettings = { 'master-audio': { gainDb: -4 }, 'saved-mix': { gainDb: 2 }, 'kept-audio': { low: 3 } };
  const before = clone(source), removed = removeAssetReferences(source, 'saved-mix');
  assert.equal(removed.changed, true);
  assert.equal(removed.project.recordingMixSettings['saved-mix'], undefined);
  assert.equal(removed.project.recordingMixSettings['master-audio'].gainDb, -4);
  assert.deepEqual(referencedAssets(removed.project), referencedAssets(source));
  assert.deepEqual(removed.impacts, { tracks: [], takes: [], performances: [], arrangements: [], pendingCapture: false });
  const master = removeAssetReferences(source, 'master-audio');
  assert.equal(master.project.recordingMixSettings['master-audio'], undefined);
  assert.equal(master.project.recordingMixSettings['saved-mix'].gainDb, 2);
  assert.equal(master.project.performances.length, 0);
  assert.deepEqual(source, before);
});
