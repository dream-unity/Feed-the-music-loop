import { validateProject } from '../project.mjs';
import { SHA256, hashBlob, bytesToHex } from './sha256.mjs';
import { ExportError, safeFilename, validateAudioMetadata } from './wav.mjs';

export const ARCHIVE_MAGIC = 'FMLPACK\n';
export const ARCHIVE_HEADER_BYTES = 64;
export const ARCHIVE_VERSION = 1;
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_ASSETS = 10000;
const PAGE_FRAMES = 16384;
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const HASH = /^[a-f0-9]{64}$/;
const ASSET_KEYS = new Set(['assetId', 'leadAssetId', 'masterAssetId']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const fail = (message, code = 'INVALID_ARCHIVE') => { throw new ExportError(code, message); };

function integer(value, min, max, description) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${description} in project backup.`);
  return value;
}

// Bound JSON work independently of JSON byte length. No archive field is ever
// interpreted as a filename or extracted path.
export function validateJsonTree(value) {
  const stack = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { value: item, depth } = stack.pop();
    if (++count > 250000 || depth > 32) fail('Project metadata is too complex.');
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Project metadata contains an invalid number.'); continue; }
    if (typeof item === 'string') { if (item.length > 262144) fail('Project metadata contains an oversized text field.'); continue; }
    if (typeof item !== 'object') fail('Project metadata has an unsupported value.');
    if (Array.isArray(item)) {
      if (item.length > 100000) fail('Project metadata contains an oversized list.');
      for (const child of item) stack.push({ value: child, depth: depth + 1 });
    } else {
      const keys = Object.keys(item);
      if (keys.length > 10000) fail('Project metadata contains too many properties.');
      for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key) || key.length > 256) fail('Project metadata contains an unsafe property.');
        stack.push({ value: item[key], depth: depth + 1 });
      }
    }
  }
}

export function collectAssetIds(project) {
  const ids = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (ASSET_KEYS.has(key) && item !== null && item !== undefined && item !== '') {
        if (typeof item !== 'string' || !ID.test(item)) fail('Project contains an invalid recording reference.');
        ids.add(item);
      } else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(project);
  return ids;
}

function checkedProject(project) {
  validateJsonTree(project);
  if (!project || project.schemaVersion !== 1 || !ID.test(project.id || '')) fail('This backup uses an unsupported project schema.');
  if (!Array.isArray(project.tracks) || project.tracks.length > 512) fail('The backup contains too many tracks.');
  return validateProject(project, { strict: true });
}

function putUint64(view, offset, value) {
  integer(value, 0, Number.MAX_SAFE_INTEGER, 'archive size');
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 0x100000000), true);
}

function getUint64(view, offset) {
  const value = view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
  return integer(value, 0, Number.MAX_SAFE_INTEGER, 'archive size');
}

function archiveHeader(manifestBytes, payloadBytes) {
  const header = new ArrayBuffer(ARCHIVE_HEADER_BYTES);
  const view = new DataView(header);
  new Uint8Array(header, 0, 8).set(encoder.encode(ARCHIVE_MAGIC));
  view.setUint32(8, ARCHIVE_VERSION, true);
  view.setUint32(12, ARCHIVE_HEADER_BYTES, true);
  putUint64(view, 16, manifestBytes.byteLength);
  putUint64(view, 24, payloadBytes);
  new Uint8Array(header, 32, 32).set(new SHA256().update(manifestBytes).digest());
  return header;
}

function assetMetadata(asset, offset, sha256) {
  if (typeof asset.id !== 'string' || !ID.test(asset.id)) fail('A recording has an invalid id.');
  if (!['complete', 'interrupted', 'recovered'].includes(asset.status)) fail('Finish saving all recordings before creating a backup.', 'RECORDING_NOT_READY');
  const bytes = validateAudioMetadata(asset);
  const metadata = {
    id: asset.id, name: String(asset.name || 'Recording').slice(0, 1000), kind: String(asset.kind || 'audio').slice(0, 100),
    sampleRate: asset.sampleRate, channels: asset.channels, frames: asset.frames,
    pageFrames: PAGE_FRAMES, encoding: 'f32le', bytes, offset, sha256,
    status: asset.status === 'recovered' ? 'interrupted' : asset.status,
    createdAt: asset.createdAt ?? null, updatedAt: asset.updatedAt ?? null,
  };
  // Sealed recordings not yet attached to a track still need their pairing
  // and role metadata after a backup is restored. They are recovery material,
  // not disposable leftovers.
  for (const key of ['captureId', 'leadAssetId', 'performanceId']) if (asset[key] != null) metadata[key] = asset[key];
  if (asset.track && asset.frames > 0) metadata.track = { ...structuredClone(asset.track), assetId: asset.id, frames: asset.frames, channels: asset.channels };
  return metadata;
}

/** Create a portable binary backup. All archived recordings are immutable and
 * checksummed; PCM data remains in File-backed Blob parts wherever supported. */
export async function exportProject(storage, project, { signal, onProgress, includeUnreferenced = true } = {}) {
  const snapshot = checkedProject(project);
  const ids = collectAssetIds(snapshot);
  if (includeUnreferenced && typeof storage.listAssets === 'function') {
    for (const asset of await storage.listAssets(snapshot.id)) {
      if (asset.frames > 0 && ['complete', 'interrupted', 'recovered'].includes(asset.status)) ids.add(asset.id);
    }
  }
  if (ids.size > MAX_ARCHIVE_ASSETS) fail('This project has too many recordings for one backup.');
  const files = [], assets = [];
  let payloadBytes = 0, index = 0;
  for (const id of ids) {
    signal?.throwIfAborted();
    const asset = await storage.getAsset(id);
    if (!asset || asset.projectId !== snapshot.id) fail('A project recording is missing or belongs to another project.');
    const metadata = assetMetadata(asset, payloadBytes, '');
    if (metadata.sampleRate !== snapshot.sampleRate) fail('A recording sample rate does not match the project.');
    const file = await storage.getAssetFile(id);
    if (!(file instanceof Blob) || file.size !== metadata.bytes) fail('A recording has an inconsistent saved length.');
    metadata.sha256 = await hashBlob(file, { signal, validateFloat32: true, onProgress: (bytes, total) => onProgress?.({ phase: 'hashing', assetId: id, asset: index + 1, assets: ids.size, bytes, total }) });
    assets.push(metadata); files.push(file); index++;
    payloadBytes += metadata.bytes;
    integer(payloadBytes, 0, Number.MAX_SAFE_INTEGER - ARCHIVE_HEADER_BYTES - MAX_MANIFEST_BYTES, 'total audio size');
  }
  validateAssetReferences(snapshot, new Map(assets.map(asset => [asset.id, asset])));
  const manifest = { format: 'feed-the-music-loop', version: ARCHIVE_VERSION, createdAt: new Date().toISOString(), project: snapshot, assets };
  validateJsonTree(manifest);
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) fail('Project metadata is too large for one backup.');
  signal?.throwIfAborted();
  const blob = new Blob([archiveHeader(manifestBytes, payloadBytes), manifestBytes, ...files], { type: 'application/vnd.feed-the-music-loop.project' });
  onProgress?.({ phase: 'complete', assets: assets.length, bytes: blob.size, total: blob.size });
  return { blob, filename: safeFilename(snapshot.name || 'Music project', 'fml'), assets: assets.length, audioBytes: payloadBytes };
}

async function readManifest(file, signal) {
  if (!(file instanceof Blob) || file.size < ARCHIVE_HEADER_BYTES) fail('Choose a valid .fml project backup.');
  signal?.throwIfAborted();
  const bytes = await file.slice(0, ARCHIVE_HEADER_BYTES).arrayBuffer();
  const view = new DataView(bytes);
  if (decoder.decode(new Uint8Array(bytes, 0, 8)) !== ARCHIVE_MAGIC) fail('This file is not a Feed the Music Loop backup.');
  if (view.getUint32(8, true) !== ARCHIVE_VERSION || view.getUint32(12, true) !== ARCHIVE_HEADER_BYTES) fail('This backup version is not supported.');
  const manifestLength = getUint64(view, 16), payloadLength = getUint64(view, 24);
  if (!manifestLength || manifestLength > MAX_MANIFEST_BYTES) fail('The backup metadata size is invalid.');
  if (ARCHIVE_HEADER_BYTES + manifestLength + payloadLength !== file.size) fail('The backup is incomplete or has unexpected trailing data.');
  const manifestBuffer = await file.slice(ARCHIVE_HEADER_BYTES, ARCHIVE_HEADER_BYTES + manifestLength).arrayBuffer();
  const actualHash = new SHA256().update(manifestBuffer).hex();
  const expectedHash = bytesToHex(new Uint8Array(bytes, 32, 32));
  if (actualHash !== expectedHash) fail('The project metadata checksum does not match. The backup may be damaged.', 'CHECKSUM_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(decoder.decode(manifestBuffer)); } catch { fail('The backup metadata cannot be read.'); }
  validateJsonTree(manifest);
  if (manifest?.format !== 'feed-the-music-loop' || manifest.version !== ARCHIVE_VERSION || !Array.isArray(manifest.assets) || manifest.assets.length > MAX_ARCHIVE_ASSETS) fail('The project backup format is invalid.');
  const project = checkedProject(manifest.project);
  const ids = new Set();
  let nextOffset = 0;
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || !ID.test(asset.id) || ids.has(asset.id)) fail('The backup has invalid or duplicate recording ids.');
    ids.add(asset.id);
    if (typeof asset.name !== 'string' || asset.name.length > 1000 || typeof asset.kind !== 'string' || asset.kind.length > 100) fail('A recording has invalid descriptive metadata.');
    if (asset.encoding !== 'f32le' || asset.pageFrames !== PAGE_FRAMES || !['complete', 'interrupted'].includes(asset.status)) fail('A recording uses an unsupported audio format.');
    if (typeof asset.sha256 !== 'string' || !HASH.test(asset.sha256)) fail('A recording checksum is invalid.');
    const bytes = validateAudioMetadata(asset);
    if (asset.sampleRate !== project.sampleRate) fail('A recording sample rate does not match the project.');
    integer(asset.offset, 0, payloadLength, 'recording offset');
    integer(asset.bytes, 0, payloadLength, 'recording size');
    if (asset.bytes !== bytes || asset.offset !== nextOffset || asset.offset + bytes > payloadLength) fail('The backup has overlapping, missing or mis-sized audio payloads.');
    nextOffset += bytes;
  }
  if (nextOffset !== payloadLength) fail('The backup contains unaccounted audio data.');
  for (const id of collectAssetIds(project)) if (!ids.has(id)) fail('The backup is missing a recording referenced by the project.');
  validateAssetReferences(project, new Map(manifest.assets.map(asset => [asset.id, asset])));
  return { manifest, project, payloadStart: ARCHIVE_HEADER_BYTES + manifestLength, payloadLength };
}

function validateAssetReferences(project, assets) {
  const checkTrack = track => {
    const asset = assets.get(track.assetId);
    if (!asset || track.frames !== asset.frames || track.channels !== asset.channels) fail('A track does not match its recording.');
  };
  const checkHistoricTracks = tracks => {
    const checked = validateProject({ ...project, tracks, sections: [], takes: [], performances: [], selectedTakeId: null, events: [] }, { strict: true });
    for (const track of checked.tracks) checkTrack(track);
  };
  for (const asset of assets.values()) {
    for (const key of ['captureId', 'leadAssetId', 'performanceId']) if (asset[key] != null && (typeof asset[key] !== 'string' || !ID.test(asset[key]))) fail('A recording has an invalid recovery reference.');
    if (asset.leadAssetId != null) {
      const lead = assets.get(asset.leadAssetId);
      if (!lead || lead.channels !== 1 || asset.channels !== 2) fail('A recovered stereo recording has an invalid vocal reference.');
    }
    if (asset.track != null) {
      if (!asset.track || asset.track.assetId !== asset.id) fail('A recording has invalid recovery track metadata.');
      checkHistoricTracks([asset.track]);
    }
  }
  for (const track of project.tracks || []) checkTrack(track);
  for (const event of project.events || []) if (event.track != null) checkHistoricTracks([event.track]);
  for (const take of project.takes || []) {
    const asset = assets.get(take.assetId);
    if (!asset || take.frames !== asset.frames || asset.channels !== 1) fail('A vocal take does not match its recording.');
  }
  for (const performance of project.performances || []) {
    if (performance.initialState?.tracks != null) checkHistoricTracks(performance.initialState.tracks);
    for (const event of performance.events || []) if (event.track != null) checkHistoricTracks([event.track]);
    const lead = performance.leadAssetId ? assets.get(performance.leadAssetId) : null;
    const master = performance.masterAssetId ? assets.get(performance.masterAssetId) : null;
    const complete = performance.status === 'complete';
    const masterFrames = performance.frames + (performance.tailFrames || 0);
    if (lead && (lead.channels !== 1 || (complete && lead.frames !== performance.frames))) fail('A performance does not match its lead recording.');
    if (master && (master.channels !== 2 || (complete ? master.frames !== masterFrames : master.frames < masterFrames))) fail('A performance does not match its stereo recording.');
    // Interrupted capture streams may have different intact lengths. The stereo
    // performance can outlast the recoverable dry vocal (or vice versa); preserve
    // both rather than truncating either to their shared editable interval.
    if (performance.editableFrames !== undefined) {
      integer(performance.editableFrames, 0, performance.frames, 'editable performance length');
      if (!lead || !master || performance.editableFrames > lead.frames || performance.editableFrames > master.frames) fail('A performance promises more editable audio than its recordings contain.');
    }
  }
}

function remapReferences(value, assetIds, oldProjectId, projectId) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => remapReferences(item, assetIds, oldProjectId, projectId));
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    if (ASSET_KEYS.has(key) && typeof item === 'string' && assetIds.has(item)) next[key] = assetIds.get(item);
    else if (key === 'projectId' && item === oldProjectId) next[key] = projectId;
    else next[key] = remapReferences(item, assetIds, oldProjectId, projectId);
  }
  return next;
}

/** Validate the whole immutable archive before creating anything. A successful
 * import commits a new project last; a failed import only cleans its own assets.
 * This never overwrites an existing project or recording. */
export async function importProject(storage, file, { signal, onProgress } = {}) {
  const { manifest, project: original, payloadStart, payloadLength } = await readManifest(file, signal);
  let index = 0;
  for (const asset of manifest.assets) {
    const payload = file.slice(payloadStart + asset.offset, payloadStart + asset.offset + asset.bytes);
    const digest = await hashBlob(payload, { signal, validateFloat32: true, onProgress: (bytes, total) => onProgress?.({ phase: 'validating', asset: index + 1, assets: manifest.assets.length, bytes, total }) });
    if (digest !== asset.sha256) fail(`The recording “${String(asset.name || 'Recording').slice(0, 100)}” failed its checksum. Nothing has been imported.`, 'CHECKSUM_MISMATCH');
    index++;
  }
  signal?.throwIfAborted();
  // Estimates can be unavailable; they are a useful early warning, while every
  // actual write remains checked and recoverable if storage runs out later.
  if (typeof storage.estimate === 'function') {
    let estimate;
    try { estimate = await storage.estimate(); } catch { /* write errors remain authoritative */ }
    if (Number.isFinite(estimate?.quota) && estimate.quota > 0 && Number.isFinite(estimate?.usage) && estimate.quota - estimate.usage < payloadLength + Math.max(1024 * 1024, Math.ceil(payloadLength * .01))) fail('There is not enough device storage to safely import this backup.', 'INSUFFICIENT_STORAGE');
  }
  const projectId = `project-${crypto.randomUUID()}`;
  const ids = new Map(manifest.assets.map(asset => [asset.id, `asset-${crypto.randomUUID()}`]));
  let project = remapReferences(original, ids, original.id, projectId);
  project.id = projectId;
  project.name = `${String(project.name || 'Music project').slice(0, 100)} (imported)`;
  project.updatedAt = new Date().toISOString();
  project = checkedProject(project);
  const started = [];
  try {
    index = 0;
    for (const asset of manifest.assets) {
      signal?.throwIfAborted();
      const id = ids.get(asset.id);
      // Register before beginAsset so a partial backend create can be cleaned.
      started.push(id);
      const recovery = {};
      for (const key of ['captureId', 'leadAssetId', 'performanceId', 'track']) if (asset[key] != null) recovery[key] = asset[key];
      await storage.beginAsset({ id, projectId, name: asset.name, kind: asset.kind, sampleRate: asset.sampleRate, channels: asset.channels, createdAt: asset.createdAt,
        ...remapReferences(recovery, ids, original.id, projectId) });
      const pageBytes = PAGE_FRAMES * asset.channels * 4;
      for (let offset = 0, pageIndex = 0; offset < asset.bytes; offset += pageBytes, pageIndex++) {
        signal?.throwIfAborted();
        const count = Math.min(pageBytes, asset.bytes - offset);
        const buffer = await file.slice(payloadStart + asset.offset + offset, payloadStart + asset.offset + offset + count).arrayBuffer();
        await storage.putPage(id, pageIndex, buffer, count / (asset.channels * 4), asset.channels);
        onProgress?.({ phase: 'importing', asset: index + 1, assets: manifest.assets.length, bytes: offset + count, total: asset.bytes });
      }
      const sealed = await storage.finishAsset(id, { frames: asset.frames, status: asset.status });
      if (!sealed || sealed.frames !== asset.frames || sealed.status !== asset.status) fail('A recording could not be saved completely. The imported project has been cancelled.', 'IMPORT_WRITE_INCOMPLETE');
      index++;
    }
    signal?.throwIfAborted();
    await storage.saveProject(project);
    signal?.throwIfAborted();
    onProgress?.({ phase: 'complete', assets: manifest.assets.length, bytes: payloadLength, total: payloadLength });
    return project;
  } catch (error) {
    const cleanupFailures = [];
    if (typeof storage.deleteProject === 'function') {
      try { await storage.deleteProject(projectId); } catch { cleanupFailures.push(projectId); }
    }
    for (const id of started) {
      try { await storage.deleteAsset(id); } catch { cleanupFailures.push(id); }
    }
    if (cleanupFailures.length) error.cleanupIds = cleanupFailures;
    throw error;
  }
}

export async function inspectProjectArchive(file, { signal } = {}) {
  const { manifest, project, payloadLength } = await readManifest(file, signal);
  return { name: project.name, assetCount: manifest.assets.length, audioBytes: payloadLength, sampleRate: project.sampleRate, tracks: project.tracks.length, takes: project.takes?.length || 0, performances: project.performances?.length || 0 };
}
