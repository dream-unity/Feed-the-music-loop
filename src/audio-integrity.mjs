/** Compare immutable audio with every published reference without changing song timing. */
export function inspectProjectAudio(project, assets) {
  const stored = new Map(assets.map(asset => [asset.id, asset])), references = new Map();
  const add = (assetId, name, frames = 0, channels = null, exact = false) => {
    if (typeof assetId !== 'string' || !assetId) return;
    let reference = references.get(assetId);
    if (!reference) references.set(assetId, reference = { assetId, name, constraints: new Map() });
    if (Number.isSafeInteger(frames) && frames >= 0) reference.constraints.set(`${frames}:${channels}:${exact}`, { frames, channels, exact });
  };
  const stack = [project];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { for (const child of item) stack.push(child); continue; }
    if (item.assetId) add(item.assetId, item.name, item.frames || 0, item.channels || (Number.isSafeInteger(item.frames) && item.frames > 0 ? 1 : null), Number.isSafeInteger(item.frames) && item.frames > 0);
    if (item.leadAssetId) add(item.leadAssetId, item.name, item.status === 'complete' ? item.frames : item.editableFrames || 0, 1, item.status === 'complete');
    if (item.masterAssetId) add(item.masterAssetId, item.name, (item.frames || 0) + (item.tailFrames || 0), 2, item.status === 'complete');
    for (const [key, value] of Object.entries(item)) if (!(item === project && key === 'pendingCapture') && value && typeof value === 'object') stack.push(value);
  }
  const issues = [];
  for (const reference of references.values()) {
    const asset = stored.get(reference.assetId), constraints = [...reference.constraints.values()];
    const expectedFrames = constraints.reduce((maximum, constraint) => Math.max(maximum, constraint.frames), 0);
    let reason = null;
    const validFormat = asset && asset.projectId === project.id && asset.sampleRate === project.sampleRate && [1, 2].includes(asset.channels) && Number.isSafeInteger(asset.frames) && asset.frames >= 0;
    const sealed = asset && ['complete', 'interrupted', 'recovered'].includes(asset.status);
    if (!asset) reason = 'missing';
    else if (!validFormat || constraints.some(constraint => constraint.channels && constraint.channels !== asset.channels)) reason = 'format-mismatch';
    else if (!sealed) reason = 'unsealed';
    else if (constraints.some(constraint => asset.frames < constraint.frames)) reason = 'truncated';
    else if (constraints.some(constraint => constraint.exact && asset.frames !== constraint.frames)) reason = 'length-mismatch';
    if (!reason) continue;
    const message = reason === 'missing' ? 'The saved audio is missing.' : reason === 'truncated' ? 'Only a shorter verified portion of the saved audio remains.'
      : reason === 'unsealed' ? 'The saved audio still needs recovery before it can be used.' : reason === 'length-mismatch' ? 'The audio length no longer matches the saved song.' : 'The audio format no longer matches the saved song.';
    issues.push({ assetId: reference.assetId, name: reference.name || asset?.name || 'Saved recording', reason, message, expectedFrames,
      availableFrames: validFormat ? asset.frames : 0, channels: asset?.channels || 1, sampleRate: project.sampleRate,
      prefixAvailable: Boolean(validFormat && sealed && asset.frames > 0 && reason !== 'format-mismatch') });
  }
  return issues;
}
