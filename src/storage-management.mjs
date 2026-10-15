import { clone, referencedAssets, validateProject } from './project.mjs';

export const LOW_STORAGE_BYTES = 8 * 1024 * 1024;

/** Browser quota estimates describe this origin, never the device's free disk. */
export function normalizedStorageCapacity(storage = {}) {
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
  const usage = valid(storage?.usage) ? Math.ceil(storage.usage) : null;
  const quota = valid(storage?.quota) && storage.quota > 0 ? Math.floor(storage.quota) : null;
  const known = usage !== null && quota !== null;
  const remaining = known ? Math.max(0, quota - usage) : null;
  return { known, usage, quota, remaining, low: known && remaining < LOW_STORAGE_BYTES };
}

/**
 * Remove references before physical audio deletion. Other audio is retained.
 * Unknown reference shapes fail closed, rather than silently corrupt a project.
 */
export function removeAssetReferences(input, assetId) {
  if (typeof assetId !== 'string' || !assetId) throw new TypeError('Choose an audio file to delete.');
  const project = clone(input), impacts = { tracks: [], takes: [], performances: [], arrangements: [], pendingCapture: false };
  if (!referencedAssets(project).includes(assetId)) return { project, changed: false, impacts };
  const removedTrackIds = new Set();
  const matches = item => item?.assetId === assetId;
  const gatherTracks = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) gatherTracks(item); return; }
    if (value.assetId === assetId && typeof value.id === 'string') removedTrackIds.add(value.id);
    for (const child of Object.values(value)) if (child && typeof child === 'object') gatherTracks(child);
  };
  gatherTracks(project);
  project.tracks = (project.tracks || []).filter(track => { if (!matches(track)) return true; impacts.tracks.push(track.name || track.id); return false; });
  project.takes = (project.takes || []).filter(take => { if (!matches(take)) return true; impacts.takes.push(take.name || take.id); return false; });
  const removedPerformanceIds = new Set();
  project.performances = (project.performances || []).filter(performance => {
    if (performance.masterAssetId !== assetId && performance.leadAssetId !== assetId) return true;
    impacts.performances.push(performance.name || performance.id); removedPerformanceIds.add(performance.id); return false;
  });
  for (const take of project.takes) if (removedPerformanceIds.has(take.performanceId)) take.performanceId = null;
  if (!project.takes.some(take => take.id === project.selectedTakeId)) project.selectedTakeId = project.takes.at(-1)?.id || null;
  const pruneSection = section => {
    if (!section?.tracks || Array.isArray(section.tracks)) return;
    for (const trackId of removedTrackIds) delete section.tracks[trackId];
  };
  const pruneEvents = events => (events || []).filter(event => {
    if (event.track?.assetId === assetId || event.assetId === assetId) return false;
    if (['mix', 'remove-track', 'track'].includes(event.type) && removedTrackIds.has(event.id)) return false;
    if (event.section) pruneSection(event.section);
    if (Array.isArray(event.tracks)) event.tracks = event.tracks.filter(track => !matches(track));
    return true;
  });
  const pruneArrangement = arrangement => {
    if (Array.isArray(arrangement.initialState?.tracks)) arrangement.initialState.tracks = arrangement.initialState.tracks.filter(track => !matches(track));
    if (Array.isArray(arrangement.events)) arrangement.events = pruneEvents(arrangement.events);
  };
  for (const section of project.sections || []) pruneSection(section);
  project.events = pruneEvents(project.events);
  for (const performance of project.performances) {
    if (referencedAssets(performance).includes(assetId)) impacts.arrangements.push(performance.name || performance.id);
    pruneArrangement(performance);
  }
  if (project.pendingCapture) {
    const capture = project.pendingCapture;
    if (capture.assetId === assetId || capture.masterAssetId === assetId || capture.track?.assetId === assetId) {
      delete project.pendingCapture; impacts.pendingCapture = true;
    } else pruneArrangement(capture);
  }
  if (referencedAssets(project).includes(assetId)) throw Object.assign(new Error('This file has an unsupported project reference. Its audio has been kept.'), { code: 'UNSUPPORTED_ASSET_REFERENCE' });
  return { project: validateProject(project), changed: true, impacts };
}
