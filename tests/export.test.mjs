import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { createProject, createTrack, DEFAULT_MIX } from '../src/project.mjs';
import { SHA256, hashBlob } from '../src/export/sha256.mjs';
import { exportWav, exportWavParts, wavHeader, WAV_HEADER_BYTES, MAX_RIFF_DATA_BYTES, safeFilename } from '../src/export/wav.mjs';
import { exportProject, importProject, inspectProjectArchive, ARCHIVE_HEADER_BYTES, MAX_MANIFEST_BYTES, validateJsonTree } from '../src/export/archive.mjs';

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

class MemoryStorage {
  constructor() { this.assets = new Map(); this.projects = new Map(); this.calls = []; this.writeCount = 0; this.failWrite = 0; this.failSave = false; }
  async beginAsset(asset) { this.calls.push(['begin', asset.id]); this.assets.set(asset.id, { ...asset, status: 'recording', frames: 0, pages: [], pageFrames: 16384 }); }
  async putPage(id, index, buffer, frames, channels) {
    this.calls.push(['write', id, index]);
    if (++this.writeCount === this.failWrite) throw new Error('Simulated disk full');
    const asset = this.assets.get(id); assert.equal(asset.pages.length, index); assert.equal(asset.channels, channels);
    asset.pages.push(new Blob([buffer.slice(0, frames * channels * 4)])); asset.frames += frames;
  }
  async finishAsset(id, metadata) { const asset = this.assets.get(id); assert.equal(asset.frames, metadata.frames); Object.assign(asset, metadata); return this.getAsset(id); }
  async getAsset(id) { const asset = this.assets.get(id); if (!asset) throw new Error('Missing audio'); const { pages, ...metadata } = asset; return structuredClone(metadata); }
  async getAssetFile(id) { return new Blob(this.assets.get(id).pages); }
  async listAssets(projectId) { return [...this.assets.values()].filter(a => a.projectId === projectId).map(({ pages, ...a }) => structuredClone(a)); }
  async saveProject(project) { this.calls.push(['save', project.id]); if (this.failSave) throw new Error('Simulated project commit failure'); this.projects.set(project.id, structuredClone(project)); }
  async deleteProject(id) { this.calls.push(['deleteProject', id]); this.projects.delete(id); }
  async deleteAsset(id) { this.calls.push(['deleteAsset', id]); this.assets.delete(id); }
  async estimate() { return { usage: 0, quota: 1024 ** 3 }; }
}

async function addAsset(storage, projectId, id, samples, channels = 1, extra = {}) {
  await storage.beginAsset({ id, projectId, sampleRate: 48000, channels, name: id, kind: channels === 2 ? 'master' : 'loop', ...extra });
  for (let start = 0, page = 0; start < samples.length; start += 16384 * channels, page++) {
    const sub = samples.slice(start, start + 16384 * channels);
    await storage.putPage(id, page, sub.buffer, sub.length / channels, channels);
  }
  await storage.finishAsset(id, { frames: samples.length / channels, status: 'complete' });
}

async function fixture() {
  const storage = new MemoryStorage();
  const project = createProject('A song / with layers');
  const beat = new Float32Array(17301).map((_, i) => Math.sin(i * .1) * .5);
  const lead = new Float32Array(24001).map((_, i) => Math.cos(i * .05) * .25);
  const master = new Float32Array(lead.length * 2).map((_, i) => lead[i >> 1]);
  await addAsset(storage, project.id, 'beat-audio', beat);
  await addAsset(storage, project.id, 'lead-audio', lead);
  await addAsset(storage, project.id, 'master-audio', master, 2);
  await addAsset(storage, project.id, 'old-recovery', new Float32Array([.1, .2, .3]));
  const track = createTrack({ id: 'beat-track', assetId: 'beat-audio', name: 'Beat', frames: beat.length });
  project.tracks.push(track); project.baseFrames = beat.length;
  project.sections.push({ id: 'section-verse', name: 'Verse', tracks: { [track.id]: { muted: false, solo: false, mix: { ...DEFAULT_MIX, volume: .6 } } } });
  project.takes.push({ id: 'take-one', name: 'First vocal', assetId: 'lead-audio', frames: lead.length, startFrame: 17301, performanceId: 'song-one' });
  project.performances.push({ id: 'song-one', name: 'First song', leadAssetId: 'lead-audio', masterAssetId: 'master-audio', frames: lead.length, startFrame: 17301, endFrame: 41302, tailFrames: 0, status: 'complete', events: [{ type: 'mix', frame: 19000, id: track.id, mix: { volume: .6 } }], initialState: { tracks: [structuredClone(track)] } });
  project.events.push({ type: 'track', frame: 0, track: structuredClone(track) });
  project.selectedTakeId = 'take-one';
  await storage.saveProject(project); storage.calls = []; storage.writeCount = 0;
  return { storage, project, beat, lead, master };
}

async function mutateManifest(blob, change) {
  const header = await blob.slice(0, 64).arrayBuffer();
  const view = new DataView(header);
  const length = view.getUint32(16, true);
  const manifest = JSON.parse(await blob.slice(64, 64 + length).text());
  change(manifest);
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  view.setUint32(16, metadata.length, true); view.setUint32(20, 0, true);
  new Uint8Array(header, 32, 32).set(new SHA256().update(metadata).digest());
  return new Blob([header, metadata, blob.slice(64 + length)]);
}

test('SHA-256 matches independent crypto vectors across padding and arbitrary chunk boundaries', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('abc'), Buffer.alloc(1000000, 97), ...[1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1025].map(n => randomBytes(n))]) {
    const stream = new SHA256();
    for (let i = 0; i < bytes.length; i += 17) stream.update(bytes.subarray(i, i + 17));
    assert.equal(stream.hex(), hash(bytes)); assert.equal(stream.hex(), hash(bytes));
    assert.throws(() => stream.update(new Uint8Array(1)), /finished/);
  }
});

test('Blob hashing reads bounded slices and rejects non-finite audio', async () => {
  const buffer = randomBytes(2 * 1024 * 1024 + 12);
  class BoundedBlob extends Blob {
    async arrayBuffer() { assert.ok(this.size <= 1024 * 1024); return super.arrayBuffer(); }
    slice(...args) { return new BoundedBlob([super.slice(...args)]); }
  }
  assert.equal(await hashBlob(new BoundedBlob([buffer])), hash(buffer));
  await assert.rejects(hashBlob(new Blob([new Float32Array([0, NaN]).buffer]), { validateFloat32: true }), /non-finite/);
});

test('float32 WAV preserves every sample with correct fmt/fact/data metadata', async () => {
  const { storage, master } = await fixture();
  const { blob, filename } = await exportWav(storage, 'master-audio');
  const bytes = await blob.arrayBuffer(); const view = new DataView(bytes);
  assert.equal(filename, 'master-audio.wav'); assert.equal(blob.type, 'audio/wav');
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF'); assert.equal(view.getUint32(4, true), blob.size - 8);
  assert.equal(view.getUint32(16, true), 18); assert.equal(view.getUint16(20, true), 3); assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000); assert.equal(view.getUint32(28, true), 48000 * 8);
  assert.equal(view.getUint32(46, true), master.length / 2); assert.equal(view.getUint32(54, true), master.byteLength);
  assert.deepEqual(new Uint8Array(bytes, WAV_HEADER_BYTES), new Uint8Array(master.buffer));
});

test('numbered WAV parts split on complete frames and reconstruct the original stereo PCM', async () => {
  const { storage, master } = await fixture(); const parts = [];
  for await (const part of exportWavParts(storage, 'master-audio', { maxDataBytes: 16385 })) parts.push(part);
  assert.equal(parts.length, Math.ceil(master.byteLength / 16384));
  for (const part of parts) { assert.equal(part.blob.size % 8, WAV_HEADER_BYTES % 8); assert.equal(part.partCount, parts.length); }
  const joined = await new Blob(parts.map(part => part.blob.slice(WAV_HEADER_BYTES))).arrayBuffer();
  assert.deepEqual(new Uint8Array(joined), new Uint8Array(master.buffer));
  assert.throws(() => wavHeader({ frames: Math.ceil(MAX_RIFF_DATA_BYTES / 4), channels: 1, sampleRate: 48000 }), { code: 'WAV_SPLIT_REQUIRED' });
});

test('WAV refuses unsaved audio and misleading byte lengths; filenames cannot create paths', async () => {
  const { storage } = await fixture();
  storage.assets.get('beat-audio').status = 'recording'; await assert.rejects(exportWav(storage, 'beat-audio'), { code: 'RECORDING_NOT_READY' });
  storage.assets.get('beat-audio').status = 'complete'; storage.assets.get('beat-audio').frames++;
  await assert.rejects(exportWav(storage, 'beat-audio'), { code: 'AUDIO_SIZE_MISMATCH' });
  assert.equal(safeFilename('../../song\\name:bad', 'wav'), '..-..-song-name-bad.wav');
});

test('archive round trip preserves audio, sections, all takes, master, history and recovery assets with independent ids', async () => {
  const { storage, project } = await fixture(); const before = structuredClone(project);
  const { blob, assets, filename } = await exportProject(storage, project);
  assert.equal(assets, 4); assert.ok(filename.endsWith('.fml')); assert.deepEqual(project, before);
  const summary = await inspectProjectArchive(blob); assert.equal(summary.tracks, 1); assert.equal(summary.performances, 1); assert.equal(summary.assetCount, 4);
  const imported = await importProject(storage, blob);
  assert.notEqual(imported.id, project.id); assert.equal(storage.projects.size, 2); assert.equal(storage.assets.size, 8);
  assert.equal(imported.selectedTakeId, project.selectedTakeId); assert.deepEqual(imported.sections, project.sections);
  assert.deepEqual(imported.performances[0].events, project.performances[0].events);
  const oldIds = [project.tracks[0].assetId, project.takes[0].assetId, project.performances[0].masterAssetId];
  const newIds = [imported.tracks[0].assetId, imported.takes[0].assetId, imported.performances[0].masterAssetId];
  for (let i = 0; i < oldIds.length; i++) {
    assert.notEqual(oldIds[i], newIds[i]);
    assert.deepEqual(await (await storage.getAssetFile(newIds[i])).arrayBuffer(), await (await storage.getAssetFile(oldIds[i])).arrayBuffer());
  }
  assert.equal(imported.performances[0].initialState.tracks[0].assetId, imported.tracks[0].assetId);
  assert.equal(imported.events[0].track.assetId, imported.tracks[0].assetId);
  assert.deepEqual(storage.projects.get(project.id), before);
  assert.equal(storage.calls.at(-1)[0], 'save', 'project metadata must commit after every audio asset');
});

test('damaged, truncated, appended or malformed archives cause no storage writes', async () => {
  const { storage, project } = await fixture(); const { blob } = await exportProject(storage, project);
  const bytes = new Uint8Array(await blob.arrayBuffer()); const damaged = bytes.slice(); damaged[damaged.length - 2] ^= 1;
  const badHeader = bytes.slice(); new DataView(badHeader.buffer).setUint32(16, MAX_MANIFEST_BYTES + 1, true);
  const badArchives = [
    new Blob([damaged]), blob.slice(0, blob.size - 1), new Blob([blob, new Uint8Array(1)]), new Blob([badHeader]),
    await mutateManifest(blob, m => { m.assets[1].offset = m.assets[0].offset; }),
    await mutateManifest(blob, m => { m.assets[0].id = '../../escape'; }),
    await mutateManifest(blob, m => { m.assets[3].id = 123; }),
    await mutateManifest(blob, m => { m.assets[1].id = m.assets[0].id; }),
    await mutateManifest(blob, m => { m.project.tracks[0].assetId = 'missing'; }),
    await mutateManifest(blob, m => { m.assets[0].frames++; }),
    await mutateManifest(blob, m => { m.project.sections = [null]; }),
    await mutateManifest(blob, m => { m.project.schemaVersion = 999; }),
    await mutateManifest(blob, m => { m.project.tracks[0].frames--; }),
    await mutateManifest(blob, m => { m.assets[0].sampleRate = 44100; }),
  ];
  for (const bad of badArchives) {
    storage.calls = []; await assert.rejects(importProject(storage, bad));
    assert.deepEqual(storage.calls, []); assert.equal(storage.projects.size, 1); assert.equal(storage.assets.size, 4);
  }
});

test('late disk failure and project commit failure remove only newly imported assets', async () => {
  for (const failure of ['write', 'save']) {
    const { storage, project } = await fixture(); const { blob } = await exportProject(storage, project);
    const oldIds = [...storage.assets.keys()]; const before = structuredClone(storage.projects.get(project.id));
    if (failure === 'write') storage.failWrite = 3; else storage.failSave = true;
    await assert.rejects(importProject(storage, blob), /Simulated/);
    assert.deepEqual([...storage.assets.keys()], oldIds); assert.equal(storage.projects.size, 1); assert.deepEqual(storage.projects.get(project.id), before);
    assert.ok(storage.calls.some(call => call[0] === 'deleteAsset'));
  }
});

test('interrupted performances preserve unequal intact dry and stereo streams with their editable interval', async () => {
  for (const dryLonger of [false, true]) {
    const { storage, project } = await fixture();
    const lead = new Float32Array(dryLonger ? 27000 : 13000).fill(.25);
    await addAsset(storage, project.id, 'lead-audio', lead);
    const performance = project.performances[0]; performance.status = 'interrupted';
    performance.editableFrames = Math.min(lead.length, performance.frames);
    project.takes[0].frames = lead.length;
    const { blob } = await exportProject(storage, project);
    const imported = await importProject(storage, blob);
    assert.equal(imported.performances[0].editableFrames, performance.editableFrames);
    assert.equal((await storage.getAsset(imported.performances[0].leadAssetId)).frames, lead.length);
    assert.equal((await storage.getAsset(imported.performances[0].masterAssetId)).frames, performance.frames);
    const invalid = await mutateManifest(blob, m => { m.project.performances[0].editableFrames = performance.frames + 1; });
    await assert.rejects(importProject(storage, invalid), /editable performance length/);
  }
});

test('empty abandoned recovery assets are not included in portable backups', async () => {
  const { storage, project } = await fixture();
  await addAsset(storage, project.id, 'empty-capture', new Float32Array(0));
  const { assets } = await exportProject(storage, project); assert.equal(assets, 4);
});

test('cancel and quota preflight leave the active project untouched', async () => {
  const { storage, project } = await fixture(); const { blob } = await exportProject(storage, project);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(importProject(storage, blob, { signal: controller.signal }), { name: 'AbortError' });
  assert.deepEqual(storage.calls, []);
  storage.estimate = async () => ({ usage: 10, quota: 20 });
  await assert.rejects(importProject(storage, blob), { code: 'INSUFFICIENT_STORAGE' }); assert.deepEqual(storage.calls, []);
});

test('an interrupted seal cannot silently commit a successful imported project', async () => {
  const { storage, project } = await fixture(); const { blob } = await exportProject(storage, project);
  storage.finishAsset = async (id, meta) => ({ ...meta, status: 'interrupted' });
  await assert.rejects(importProject(storage, blob), { code: 'IMPORT_WRITE_INCOMPLETE' });
  assert.equal(storage.projects.size, 1); assert.equal(storage.assets.size, 4);
});

test('cancellation during writes rolls back the new import and retains the original', async () => {
  const { storage, project } = await fixture(); const { blob } = await exportProject(storage, project);
  const controller = new AbortController();
  await assert.rejects(importProject(storage, blob, { signal: controller.signal, onProgress: status => { if (status.phase === 'importing') controller.abort(); } }), { name: 'AbortError' });
  assert.equal(storage.projects.size, 1); assert.equal(storage.assets.size, 4); assert.ok(storage.projects.has(project.id));
});

test('JSON rejects reserved keys, non-finite values and excessively nested structures', () => {
  assert.throws(() => validateJsonTree(JSON.parse('{"__proto__":{"polluted":true}}')), /unsafe/);
  assert.throws(() => validateJsonTree({ value: Infinity }), /invalid number/);
  let deep = {}; for (let i = 0; i < 40; i++) deep = { child: deep };
  assert.throws(() => validateJsonTree(deep), /complex/);
  assert.equal({}.polluted, undefined);
});

test('import never reads a long audio payload into a full-length ArrayBuffer', async () => {
  const storage = new MemoryStorage(), project = createProject('Bounded import');
  const pcm = new Float32Array(600000).fill(.125);
  await addAsset(storage, project.id, 'long', pcm);
  project.tracks.push(createTrack({ assetId: 'long', frames: pcm.length, name: 'Long loop' }));
  project.baseFrames = pcm.length; await storage.saveProject(project);
  const { blob } = await exportProject(storage, project);
  let largestRead = 0;
  class AuditBlob extends Blob {
    slice(...args) { return new AuditBlob([super.slice(...args)]); }
    async arrayBuffer() { largestRead = Math.max(largestRead, this.size); assert.ok(this.size <= 1024 * 1024); return super.arrayBuffer(); }
  }
  await importProject(storage, new AuditBlob([blob]));
  assert.equal(largestRead, 1024 * 1024);
});

test('backup restoration preserves recovery pairing and remaps every recovery audio reference', async () => {
  const { storage, project } = await fixture();
  const track = createTrack({ id: 'orphan-track', assetId: 'orphan-vocal', role: 'lead', name: 'Lost take' });
  track.mix.reverb = .36;
  await addAsset(storage, project.id, 'orphan-vocal', new Float32Array(999).fill(.1), 1, { kind: 'vocal', captureId: 'capture-orphan', performanceId: 'performance-orphan', track });
  await addAsset(storage, project.id, 'orphan-master', new Float32Array(1998).fill(.1), 2, { kind: 'master', captureId: 'capture-orphan', leadAssetId: 'orphan-vocal', performanceId: 'performance-orphan' });
  const { blob } = await exportProject(storage, project);
  const imported = await importProject(storage, blob), recovered = await storage.listAssets(imported.id);
  const voice = recovered.find(asset => asset.kind === 'vocal' && asset.captureId === 'capture-orphan');
  const master = recovered.find(asset => asset.kind === 'master' && asset.captureId === voice.captureId);
  assert.ok(voice && master); assert.equal(master.leadAssetId, voice.id); assert.notEqual(voice.id, 'orphan-vocal');
  assert.equal(voice.track.assetId, voice.id); assert.equal(voice.track.frames, voice.frames); assert.equal(voice.track.mix.reverb, .36);
  assert.equal(voice.performanceId, 'performance-orphan');
});

test('a stereo-only recovery backup does not depend on an empty abandoned vocal', async () => {
  const { storage, project } = await fixture();
  await addAsset(storage, project.id, 'orphan-master', new Float32Array(200).fill(.1), 2, { kind: 'master', captureId: 'capture-orphan', leadAssetId: 'empty-abandoned' });
  const { blob } = await exportProject(storage, project), imported = await importProject(storage, blob);
  const master = (await storage.listAssets(imported.id)).find(asset => asset.captureId === 'capture-orphan');
  assert.equal(master.channels, 2); assert.equal(master.frames, 100); assert.equal(master.leadAssetId, undefined);
});

test('malformed historic arrangement and recovery metadata are rejected before import writes', async () => {
  const { storage, project } = await fixture(), { blob } = await exportProject(storage, project);
  const badArchives = [
    await mutateManifest(blob, m => { m.project.performances[0].initialState.tracks[0].frames--; }),
    await mutateManifest(blob, m => { m.project.performances[0].initialState.tracks[0].mix.volume = 1e10; }),
    await mutateManifest(blob, m => { m.project.performances[0].initialState.tracks = {}; }),
    await mutateManifest(blob, m => { m.project.events[0].track.channels = 2; }),
    await mutateManifest(blob, m => { m.assets[0].captureId = '../../bad'; }),
    await mutateManifest(blob, m => { m.assets[0].leadAssetId = 'missing'; }),
    await mutateManifest(blob, m => { m.assets[0].track = m.project.tracks[0]; m.assets[0].track.assetId = 'other-audio'; }),
  ];
  for (const archive of badArchives) {
    storage.calls = [];
    await assert.rejects(importProject(storage, archive));
    assert.deepEqual(storage.calls, []); assert.equal(storage.projects.size, 1); assert.equal(storage.assets.size, 4);
  }
});

test('cancelling while the new project commits waits for the commit then removes only the new import', async () => {
  const { storage, project } = await fixture(), { blob } = await exportProject(storage, project);
  const controller = new AbortController(), save = storage.saveProject.bind(storage);
  storage.saveProject = async value => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 5)); return save(value); };
  await assert.rejects(importProject(storage, blob, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(storage.projects.size, 1); assert.equal(storage.assets.size, 4); assert.ok(storage.projects.has(project.id));
});
