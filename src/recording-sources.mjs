/** One entry per immutable audio file, preferring the saved song's identity. */
export function listRecordingSources(project, recovered = [], damagedAudio = [], storedAssets = []) {
  if (!project) return [];
  const stored = new Map([...storedAssets, ...recovered].map(asset => [asset.id, asset]));
  const entries = new Map(), damaged = new Set(damagedAudio.map(item => item.assetId));
  const add = (assetId, item) => {
    if (typeof assetId !== 'string' || !assetId || entries.has(assetId) || !Number.isSafeInteger(item.frames) || item.frames <= 0) return;
    entries.set(assetId, { key: `asset:${assetId}`, assetId, sampleRate: project.sampleRate, canRemix: false, ...item, damaged: damaged.has(assetId) });
  };
  for (const performance of project.performances || []) {
    if (performance.removed) continue;
    const asset = stored.get(performance.masterAssetId), minimumFrames = performance.frames + (performance.tailFrames || 0);
    const availableFrames = performance.status !== 'complete' && asset?.projectId === project.id && asset.channels === 2 && asset.sampleRate === project.sampleRate && ['complete', 'interrupted', 'recovered'].includes(asset.status) && asset.frames >= minimumFrames ? asset.frames : minimumFrames;
    add(performance.masterAssetId, { name: performance.name || 'Performance', kind: performance.source === 'loops' ? 'loop-song' : 'performance',
      frames: availableFrames, minimumFrames, allowLonger: performance.status !== 'complete', channels: 2, performanceId: performance.id, createdAt: performance.createdAt,
      canRemix: !!performance.initialState?.tracks && (performance.status === 'complete' || performance.editableFrames > 0) });
  }
  for (const take of project.takes || []) add(take.assetId, { name: take.name || 'Vocal recording', kind: 'vocal', frames: take.frames, channels: 1, createdAt: take.createdAt });
  for (const track of project.tracks || []) add(track.assetId, { name: track.name || 'Loop', kind: 'loop', frames: track.frames, channels: track.channels || 1, createdAt: track.createdAt });
  for (const asset of recovered || []) {
    if (asset.projectId !== project.id || asset.needsRecovery || !['complete', 'interrupted', 'recovered'].includes(asset.status) || ![1, 2].includes(asset.channels) || asset.sampleRate !== project.sampleRate) continue;
    add(asset.id, { name: asset.name || 'Saved recording', kind: asset.kind === 'mix' ? 'mix' : 'recovered', frames: asset.frames, channels: asset.channels,
      sourceAssetId: asset.sourceAssetId || null, createdAt: asset.createdAt, masterSettings: asset.masterSettings || null, analysis: asset.analysis || null });
  }
  return [...entries.values()];
}
export function selectRecordingSource(project, recovered, sourceKey, damagedAudio = [], storedAssets = []) {
  const source = listRecordingSources(project, recovered, damagedAudio, storedAssets).find(item => item.key === sourceKey);
  if (!source) throw new Error('Choose a saved recording from this project.');
  if (source.damaged) throw new Error('This recording is incomplete or unavailable. Recover its audio before mixing it.');
  return source;
}
