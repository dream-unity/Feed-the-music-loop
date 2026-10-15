import { PAGE_FRAMES, MAX_FALLBACK_FILE_BYTES, MAX_ASSET_RANGE_BYTES, crc32, storageError, validId } from './core.mjs';
import { removeAssetReferences } from '../storage-management.mjs';
import { referencedAssets, touch } from '../project.mjs';

const DB_NAME = 'feed-the-music-loop-v1';
const DIRECTORY_NAME = 'feed-the-music-loop-v1';
const request = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
function completion(tx) {
  const promise = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || storageError('TRANSACTION_ABORTED', 'Audio storage transaction was interrupted.'));
    tx.onerror = () => {}; // Abort delivers the final transaction result.
  });
  // A request may reject before the caller reaches `await promise`.
  promise.catch(() => {});
  return promise;
}
function transaction(db, names, mode = 'readonly') {
  if (mode === 'readwrite') {
    try { return db.transaction(names, mode, { durability: 'strict' }); } catch {}
  }
  return db.transaction(names, mode);
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('projects', { keyPath: 'id' });
      const assets = db.createObjectStore('assets', { keyPath: 'id' });
      assets.createIndex('projectId', 'projectId', { unique: false });
      const pages = db.createObjectStore('pages', { keyPath: ['assetId', 'index'] });
      pages.createIndex('assetId', 'assetId', { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(storageError('STORAGE_BLOCKED', 'Close older Feed the Music Loop tabs and try again.'));
  });
}

export class BrowserBackend {
  constructor() { this.backend = 'indexeddb'; this.db = null; this.directory = null; this.handles = new Map(); this.projectLocks = new Map(); this.disposed = false; }
  async init() {
    this.db = await openDatabase();
    this.db.onversionchange = () => this.db.close();
    // Probe the actual worker-only sync handle, rather than assuming API support.
    try {
      const root = await navigator.storage.getDirectory();
      this.directory = await root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
      const probe = await this.directory.getFileHandle(`probe-${crypto.randomUUID()}`, { create: true });
      const handle = await probe.createSyncAccessHandle();
      handle.flush(); handle.close();
      await this.directory.removeEntry(probe.name);
      this.backend = 'opfs';
    } catch { this.backend = 'indexeddb'; }
    return { backend: this.backend, ...(await this.estimate()), persistenceSupported: Boolean(navigator.storage?.persist), locking: Boolean(navigator.locks) };
  }
  async estimate() {
    // Estimates are optional and may be rounded or temporarily unavailable.
    // In particular, a failed estimate must not prevent opening saved music.
    let estimate = {}, persistent = false;
    try { estimate = await navigator.storage?.estimate?.() || {}; } catch {}
    try { persistent = await navigator.storage?.persisted?.() || false; } catch {}
    const bytes = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
    return { usage: bytes(estimate.usage), quota: bytes(estimate.quota), persistent };
  }
  async withMaintenance(operation, { required = false } = {}) {
    if (!navigator.locks) {
      if (required) throw storageError('LOCKING_UNAVAILABLE', 'This browser cannot safely coordinate permanent file deletion across tabs. Open the studio in a browser with Web Locks support.');
      return operation();
    }
    return navigator.locks.request('feed-the-music-loop:storage-maintenance', { mode: 'exclusive' }, operation);
  }
  async lockProject(projectId) {
    if (!navigator.locks) return; // The UI exposes this capability limitation.
    if (this.projectLocks.has(projectId)) return this.projectLocks.get(projectId).ready;
    let readyResolve, readyReject, release;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const held = new Promise((resolve) => { release = resolve; });
    const entry = { ready, release };
    this.projectLocks.set(projectId, entry);
    navigator.locks.request(`feed-the-music-loop:project:${projectId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        this.projectLocks.delete(projectId);
        readyReject(storageError('PROJECT_BUSY', 'This project is already open for editing in another tab. Close that tab before recording here.'));
        return;
      }
      readyResolve();
      await held;
    }).catch((error) => { this.projectLocks.delete(projectId); readyReject(error); });
    return ready;
  }
  async get(store, key) {
    const tx = transaction(this.db, store), done = completion(tx);
    const value = await request(tx.objectStore(store).get(key));
    await done; return value;
  }
  async all(store, index, key) {
    const tx = transaction(this.db, store), done = completion(tx);
    const source = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
    const values = await request(source.getAll(key));
    await done; return values;
  }
  async put(store, value) {
    const tx = transaction(this.db, store, 'readwrite'), done = completion(tx);
    await request(tx.objectStore(store).put(value)); await done;
  }
  async getAsset(id) { return this.get('assets', id); }
  async getPage(id, index) { return this.get('pages', [id, index]); }
  async listPages(id) {
    // getAll would materialize every fallback PCM page at once. A cursor keeps
    // recovery bounded to one binary page plus its small metadata register.
    const tx = transaction(this.db, 'pages'), done = completion(tx), pages = [];
    await new Promise((resolve, reject) => {
      const req = tx.objectStore('pages').index('assetId').openCursor(IDBKeyRange.only(id));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        const { buffer, ...metadata } = cursor.value;
        pages.push(metadata); cursor.continue();
      };
    });
    await done; return pages.sort((a, b) => a.index - b.index);
  }
  async listAssets(projectId) { return this.all('assets', 'projectId', projectId); }
  async listProjects() {
    const timestamp = (value) => typeof value === 'number' && Number.isFinite(value) ? value : Date.parse(value) || 0;
    return (await this.all('projects')).filter((p) => !p.deletedAt).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
  }
  async loadProject(id) { return this.get('projects', id); }
  async saveProject(project) {
    await this.lockProject(project.id);
    await this.withMaintenance(() => this.put('projects', structuredClone(project)));
    return { id: project.id, updatedAt: project.updatedAt, saved: true };
  }
  async deleteProject(id) {
    await this.lockProject(id);
    const project = await this.loadProject(id);
    if (project) await this.put('projects', { ...project, deletedAt: Date.now() });
    return { id, deleted: true, audioRetained: true };
  }
  async createAsset(asset) {
    await this.lockProject(asset.projectId);
    return this.withMaintenance(async () => {
      // Keep the new physical file and its index together relative to orphan
      // cleanup in other tabs. Recheck IDs after entering that same lock.
      if (await this.getAsset(asset.id)) throw storageError('ASSET_EXISTS', 'An audio recording with this identifier already exists.');
      if (asset.backend === 'opfs') {
        const handle = await this.openHandle(asset);
        handle.truncate(0); handle.flush();
      }
      const tx = transaction(this.db, 'assets', 'readwrite'), done = completion(tx);
      try { await request(tx.objectStore('assets').add(asset)); await done; }
      catch (error) { this.closeHandle(asset.id); throw error; }
    });
  }
  async openHandle(asset) {
    if (this.handles.has(asset.id)) return this.handles.get(asset.id);
    if (!this.directory) throw storageError('OPFS_UNAVAILABLE', 'The browser cannot currently open this recording’s file storage. Try reopening it in the browser where it was recorded.');
    if (this.handles.size >= 24) this.closeHandle(this.handles.keys().next().value);
    const file = await this.directory.getFileHandle(`${asset.id}.pcm`, { create: asset.status === 'recording' });
    const handle = await file.createSyncAccessHandle();
    this.handles.set(asset.id, handle); return handle;
  }
  closeHandle(id) {
    const handle = this.handles.get(id);
    if (handle) { try { handle.close(); } finally { this.handles.delete(id); } }
  }
  async writeData(asset, page, buffer) {
    if (asset.backend !== 'opfs') return;
    const handle = await this.openHandle(asset);
    const bytes = new Uint8Array(buffer, 0, page.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = handle.write(bytes.subarray(offset), { at: page.offset + offset });
      if (!written) throw storageError('SHORT_WRITE', 'The browser could not write the full audio page.');
      offset += written;
    }
  }
  async flush(asset) {
    if (asset.backend === 'opfs') {
      const handle = this.handles.get(asset.id);
      if (handle) handle.flush();
    }
  }
  async commitPage(asset, page, buffer) {
    const record = asset.backend === 'indexeddb' ? { ...page, buffer: buffer.slice(0, page.byteLength) } : page;
    const tx = transaction(this.db, ['assets', 'pages'], 'readwrite'), done = completion(tx);
    tx.objectStore('pages').put(record);
    tx.objectStore('assets').put(asset);
    await done;
  }
  async finishAsset(asset) {
    await this.put('assets', asset);
    this.closeHandle(asset.id);
  }
  async recoverAsset(asset) { await this.put('assets', asset); this.closeHandle(asset.id); }
  async readData(asset, page) {
    if (asset.backend === 'indexeddb') {
      const stored = page.buffer ? page : await this.getPage(asset.id, page.index);
      if (!(stored?.buffer instanceof ArrayBuffer)) throw storageError('MISSING_PAGE', 'A stored audio page is missing.');
      return stored.buffer.slice(0);
    }
    let handle;
    try { handle = await this.openHandle(asset); }
    catch (error) {
      // Another tab may hold an exclusive sync handle while playing this
      // immutable file. A bounded File snapshot lets read-only playback work
      // without acquiring or modifying that tab's writer lock.
      if (asset.status === 'recording' || !['NoModificationAllowedError', 'InvalidStateError'].includes(error.name)) throw error;
      const fileHandle = await this.directory.getFileHandle(`${asset.id}.pcm`);
      const file = await fileHandle.getFile();
      return file.slice(page.offset, page.offset + page.byteLength).arrayBuffer();
    }
    const buffer = new ArrayBuffer(page.byteLength);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = handle.read(bytes.subarray(offset), { at: page.offset + offset });
      if (!read) return buffer.slice(0, offset);
      offset += read;
    }
    return buffer;
  }
  async getAssetFile(asset) {
    if (asset.status === 'recording') throw storageError('RECORDING_ACTIVE', 'Finish this recording before exporting it.');
    if (asset.backend === 'opfs') {
      this.closeHandle(asset.id);
      const file = await this.directory.getFileHandle(`${asset.id}.pcm`);
      const blob = await file.getFile();
      if (blob.size < asset.byteLength) throw storageError('SHORT_FILE', 'The stored audio file is incomplete. Recover this project before exporting.');
      return blob.slice(0, asset.byteLength, 'application/octet-stream');
    }
    if (asset.byteLength > MAX_FALLBACK_FILE_BYTES) throw storageError('FALLBACK_EXPORT_LIMIT', 'This browser uses fallback storage. A single audio export is limited to 128 MiB here; use a shorter recording or an OPFS-capable browser for longer sessions.');
    const parts = [];
    for (let index = 0; index < asset.pageCount; index++) {
      const page = await this.getPage(asset.id, index);
      if (!page?.buffer) throw storageError('MISSING_PAGE', 'A stored audio page is missing. Recover this project before exporting.');
      if (page.buffer.byteLength !== page.byteLength || crc32(new Uint8Array(page.buffer)) !== page.crc32) throw storageError('CORRUPT_PAGE', 'A stored audio page failed its integrity check. The recording has been retained for recovery.');
      parts.push(page.buffer);
    }
    return new Blob(parts, { type: 'application/octet-stream' });
  }
  async getAssetRange(asset, range = {}) {
    if (asset.status === 'recording') throw storageError('RECORDING_ACTIVE', 'Finish this recording before exporting it.');
    const { startFrame, frames } = range || {};
    const stride = asset.channels * 4, endFrame = startFrame + frames;
    if (![1, 2].includes(asset.channels) || !Number.isSafeInteger(asset.frames) || asset.frames < 0 || !Number.isSafeInteger(asset.frames * stride)
      || !Number.isSafeInteger(startFrame) || startFrame < 0 || !Number.isSafeInteger(frames) || frames < 0
      || !Number.isSafeInteger(endFrame) || endFrame > asset.frames || !Number.isSafeInteger(endFrame * stride)) {
      throw storageError('INVALID_ASSET_RANGE', 'Choose a valid frame range within this saved recording.');
    }
    const byteLength = frames * stride;
    if (byteLength > MAX_ASSET_RANGE_BYTES) throw storageError('ASSET_RANGE_LIMIT', 'An audio range may contain at most 64 MiB. Request smaller numbered parts.');
    if (!byteLength) return new Blob([], { type: 'application/octet-stream' });
    const startByte = startFrame * stride, endByte = endFrame * stride;
    let file;
    if (asset.backend === 'opfs') {
      if (!this.directory) throw storageError('OPFS_UNAVAILABLE', 'Audio file storage is currently unavailable.');
      this.closeHandle(asset.id);
      file = await (await this.directory.getFileHandle(`${asset.id}.pcm`)).getFile();
      if (file.size < asset.frames * stride) throw storageError('SHORT_FILE', 'The stored audio file is incomplete. Recover this project before exporting.');
    }
    const parts = [], firstPage = Math.floor(startFrame / PAGE_FRAMES), lastPage = Math.floor((endFrame - 1) / PAGE_FRAMES);
    for (let index = firstPage; index <= lastPage; index++) {
      const page = await this.getPage(asset.id, index), expectedFrames = Math.min(PAGE_FRAMES, asset.frames - index * PAGE_FRAMES);
      if (!page) throw storageError('MISSING_PAGE', 'A stored audio page is missing. Recover this project before exporting.');
      if (page.assetId !== asset.id || page.index !== index || page.channels !== asset.channels || page.frames !== expectedFrames
        || page.offset !== index * PAGE_FRAMES * stride || page.byteLength !== expectedFrames * stride) {
        throw storageError('CORRUPT_PAGE', 'A stored audio page has inconsistent dimensions. The recording has been retained for recovery.');
      }
      const buffer = file ? await file.slice(page.offset, page.offset + page.byteLength).arrayBuffer() : page.buffer;
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== page.byteLength || crc32(new Uint8Array(buffer)) !== page.crc32) {
        throw storageError('CORRUPT_PAGE', 'A stored audio page failed its integrity check. The recording has been retained for recovery.');
      }
      if (!file) {
        const from = Math.max(startByte, page.offset) - page.offset, to = Math.min(endByte, page.offset + page.byteLength) - page.offset;
        parts.push(new Uint8Array(buffer, from, to - from));
      }
    }
    return file ? file.slice(startByte, endByte, 'application/octet-stream') : new Blob(parts, { type: 'application/octet-stream' });
  }
  async inspectAssetSize(asset) {
    if (asset.backend !== 'opfs') return { available: true, byteLength: asset.byteLength, metadataOnly: true };
    if (!this.directory) throw storageError('OPFS_UNAVAILABLE', 'The browser cannot currently open this recording’s file storage.');
    try {
      const fileHandle = await this.directory.getFileHandle(`${asset.id}.pcm`);
      const file = await fileHandle.getFile();
      return { available: true, byteLength: file.size };
    } catch (error) {
      if (error.name === 'NotFoundError') return { available: false, byteLength: 0 };
      throw error;
    }
  }
  async removeAssetMetadata(id) {
    const tx = transaction(this.db, ['assets', 'pages'], 'readwrite'), done = completion(tx);
    tx.objectStore('assets').delete(id);
    tx.objectStore('pages').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    await done;
  }
  async removeProjectMetadata(id) {
    const tx = transaction(this.db, 'projects', 'readwrite'), done = completion(tx);
    tx.objectStore('projects').delete(id); await done;
  }
  async deleteAsset(id, expectedProjectId = null) {
    const asset = await this.getAsset(id);
    if (!asset) return { id, deleted: true };
    if (expectedProjectId !== null && asset.projectId !== expectedProjectId) throw storageError('ASSET_OWNER_MISMATCH', 'This audio belongs to another project and was not deleted.');
    await this.lockProject(asset.projectId);
    // This API is intentionally explicit; deleting a project never calls it.
    this.closeHandle(id);
    // Remove the file first: a failed file deletion leaves its metadata visible
    // for retry. If the later metadata transaction fails, retry tolerates the
    // already absent file. The reverse order could strand unreclaimable audio.
    if (asset.backend === 'opfs') {
      if (!this.directory) throw storageError('OPFS_UNAVAILABLE', 'Audio storage is unavailable. Reopen this browser before deleting the project.');
      try { await this.directory.removeEntry(`${id}.pcm`); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
    await this.removeAssetMetadata(id);
    return { id, deleted: true };
  }
  async inventoryPages() {
    // Only one page's PCM exists in JS at a time. The result contains small
    // aggregates, never a second copy of every recording in memory.
    const tx = transaction(this.db, 'pages'), done = completion(tx), groups = new Map();
    await new Promise((resolve, reject) => {
      const req = tx.objectStore('pages').openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        try {
          const cursor = req.result;
          if (!cursor) { resolve(); return; }
          const { buffer, ...metadata } = cursor.value;
          const group = groups.get(metadata.assetId) || { bytes: 0, metadataBytes: 0, pages: 0, unknown: false };
          if (buffer instanceof ArrayBuffer) group.bytes += buffer.byteLength;
          else if (buffer !== undefined) group.unknown = true;
          group.metadataBytes += new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
          group.pages++; groups.set(metadata.assetId, group); cursor.continue();
        } catch (error) { reject(error); }
      };
    });
    await done; return groups;
  }
  async inventoryOpfs() {
    const files = new Map(), errors = [];
    if (!this.directory) return { files, complete: false, errors: ['Audio file storage could not be inspected.'] };
    try {
      for await (const [name, handle] of this.directory.entries()) {
        if (handle.kind !== 'file') { errors.push(`The folder ${name} could not be measured.`); continue; }
        try {
          const file = await handle.getFile();
          files.set(name, { bytes: file.size, lastModified: file.lastModified });
        } catch (error) { files.set(name, { bytes: null }); errors.push(`${name}: ${error.message || 'File size unavailable.'}`); }
      }
    } catch (error) { errors.push(error.message || 'The audio file listing is unavailable.'); }
    return { files, complete: !errors.length, errors };
  }
  async getStorageInventory() {
    const errors = [], logicalBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
    const inspect = async (label, operation, fallback) => {
      try { return await operation(); } catch (error) { errors.push(`${label}: ${error.message || 'Unavailable.'}`); return fallback; }
    };
    // Include tombstoned projects and assets with no project; neither is visible
    // through the normal project picker, but both still occupy browser storage.
    const assets = await inspect('Recording index', () => this.all('assets'), null);
    const storedProjects = await inspect('Project metadata', () => this.all('projects'), null);
    const pages = await inspect('Audio pages', () => this.inventoryPages(), null);
    const opfs = await this.inventoryOpfs(); errors.push(...opfs.errors);
    const projects = [];
    for (const project of storedProjects || []) {
      const bytes = new TextEncoder().encode(JSON.stringify(project));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      projects.push({ id: project.id, name: project.name || 'Untitled project', deletedAt: project.deletedAt || null,
        revision: project.revision ?? null, updatedAt: project.updatedAt ?? null, purgePendingAt: project.purgePendingAt || null,
        metadataRevision: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
        logicalMetadataBytes: bytes.byteLength, assetIds: referencedAssets(project) });
    }
    const files = [], assetIds = new Set((assets || []).map(asset => asset.id)), assetById = new Map((assets || []).map(asset => [asset.id, asset]));
    let metadataBytes = projects.reduce((sum, project) => sum + project.logicalMetadataBytes, 0);
    for (const group of pages?.values() || []) metadataBytes += group.metadataBytes;
    const decorate = (entry, asset = null) => {
      const referenceId = entry.kind === 'orphan-opfs' && /^[A-Za-z0-9_-]{1,120}\.pcm$/.test(entry.id) ? entry.id.slice(0, -4) : entry.id;
      // An unused OPFS twin of an IndexedDB asset is only a stray physical
      // file. Deleting that twin must not detach the retained fallback audio.
      const retainedAsset = entry.kind === 'orphan-opfs' ? assetById.get(referenceId) : null;
      entry.assetId = retainedAsset ? null : referenceId;
      if (retainedAsset) entry.retainedAssetId = retainedAsset.id;
      const refs = retainedAsset ? [] : projects.filter(project => project.assetIds.includes(referenceId));
      const owner = projects.find(project => project.id === (asset || retainedAsset)?.projectId);
      entry.projectId = (asset || retainedAsset)?.projectId || null; entry.projectName = owner?.name || null;
      entry.referencedProjectIds = refs.map(project => project.id);
      entry.referenced = refs.length > 0;
      entry.orphaned = asset ? !refs.length : true;
      entry.revision = JSON.stringify([entry.kind, entry.id, asset?.updatedAt ?? null, asset?.status ?? null, asset?.frames ?? null,
        asset?.byteLength ?? null, entry.bytes, entry.lastModified ?? null, entry.pageCount ?? null,
        refs.map(project => [project.id, project.metadataRevision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
      files.push(entry);
    };
    for (const asset of assets || []) {
      const pageGroup = pages?.get(asset.id), opfsName = `${asset.id}.pcm`, physical = opfs.files.get(opfsName);
      let bytes = pageGroup && !pageGroup.unknown ? pageGroup.bytes : pages ? 0 : null, missing = false;
      if (asset.backend === 'opfs') {
        const fileBytes = physical ? physical.bytes : opfs.complete ? 0 : null;
        bytes = bytes !== null && fileBytes !== null ? bytes + fileBytes : null;
        missing = !physical && opfs.complete;
        opfs.files.delete(opfsName);
      }
      if (asset.backend !== 'opfs' && bytes === 0 && asset.byteLength > 0) missing = true;
      const assetMetadataBytes = logicalBytes(asset); metadataBytes += assetMetadataBytes;
      decorate({ key: `asset:${asset.id}`, kind: 'asset', id: asset.id, name: asset.name || 'Untitled recording',
        backend: asset.backend, status: asset.status, channels: asset.channels, frames: asset.frames, sampleRate: asset.sampleRate,
        bytes, metadataBytes: assetMetadataBytes + (pageGroup?.metadataBytes || 0), missing,
        lastModified: physical?.lastModified ?? null, pageCount: pageGroup?.pages ?? null,
        deletedProject: Boolean(ownerDeleted(asset.projectId)), assetKind: asset.kind || 'audio', source: asset.source || null,
      }, asset);
    }
    function ownerDeleted(projectId) { return projects.find(project => project.id === projectId)?.deletedAt; }
    // If the asset index could not be read, do not guess that physical files are
    // orphans. Their ownership is unknown and permanent deletion must be refused.
    if (assets) {
      for (const [name, physical] of opfs.files) decorate({ key: `orphan-opfs:${name}`, kind: 'orphan-opfs', id: name,
        name, backend: 'opfs', status: 'unindexed', bytes: physical.bytes, metadataBytes: 0, lastModified: physical.lastModified ?? null });
      for (const [id, group] of pages || []) if (!assetIds.has(id)) decorate({ key: `orphan-pages:${id}`, kind: 'orphan-pages', id,
        name: `Unindexed audio ${id}`, backend: 'indexeddb', status: 'unindexed', bytes: group.unknown ? null : group.bytes,
        metadataBytes: group.metadataBytes, pageCount: group.pages });
    }
    for (const file of files) if (file.bytes === null && !errors.length) errors.push('Some audio bytes could not be measured.');
    const knownAudioBytes = files.reduce((sum, file) => sum + (file.bytes || 0), 0);
    const complete = errors.length === 0, unknownFiles = files.filter(file => file.bytes === null).length;
    return { files, projects, knownAudioBytes, audioBytes: complete ? knownAudioBytes : null,
      metadataBytes: storedProjects && assets && pages ? metadataBytes : null,
      unknownFiles, complete, errors, includesMetadataOverhead: false,
      locking: Boolean(navigator.locks), ...(await this.estimate()) };
  }
  async saveDetachedProjects(projects) {
    if (!projects.length) return;
    // All manifests detach atomically. If quota or a transaction abort prevents
    // saving any of them, physical bytes have not been touched.
    const tx = transaction(this.db, 'projects', 'readwrite'), done = completion(tx);
    try {
      for (const project of projects) tx.objectStore('projects').put(project);
      await done;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  async deleteStoredFile(file = {}, { onDetached = () => {} } = {}) {
    const { kind, id, revision, discardUnfinished = false } = file;
    if (!['asset', 'orphan-opfs', 'orphan-pages'].includes(kind)) throw storageError('INVALID_STORAGE_FILE', 'Choose a recording from the storage file list.');
    if (kind === 'orphan-opfs') {
      if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[/\\\0]/.test(id)) throw storageError('INVALID_STORAGE_FILE', 'The audio filename is invalid.');
    } else validId(id);
    return this.withMaintenance(async () => {
      const acquired = [];
      try {
        const inventory = await this.getStorageInventory();
        const entry = inventory.files.find(item => item.kind === kind && item.id === id);
        if (!entry) throw storageError('FILE_CHANGED', 'This file is no longer in the storage list. Refresh storage and try again.');
        if (revision !== undefined && revision !== entry.revision) throw storageError('FILE_CHANGED', 'This file or a project using it changed. Review the refreshed storage list before deleting it.');
        // Ownership and references must be known even when physical measurement
        // is unavailable. Unknown sizes do not imply an empty/deletable file.
        if (inventory.errors.some(message => /^(Recording index|Project metadata):/.test(message))) throw storageError('STORAGE_INVENTORY_INCOMPLETE', 'Project ownership could not be inspected. No audio was deleted.');
        const asset = kind === 'asset' ? await this.getAsset(id) : null;
        if (kind === 'asset' && !asset) throw storageError('FILE_CHANGED', 'This recording changed. Refresh storage and try again.');
        const projectIds = new Set([...entry.referencedProjectIds, ...(entry.projectId ? [entry.projectId] : [])]);
        for (const projectId of [...projectIds].sort()) {
          const wasHeld = this.projectLocks.has(projectId);
          await this.lockProject(projectId);
          if (!wasHeld) acquired.push(projectId);
        }
        if (asset?.status === 'recording' && discardUnfinished !== true) throw storageError('RECORDING_ACTIVE', 'This recording is unfinished. Close its recording session before permanently deleting it.');
        // saveProject and createAsset use the maintenance lock too. Nothing can
        // attach a new reference or create an unindexed file during this operation.
        const changes = [];
        for (const projectId of entry.referencedProjectIds) {
          const project = await this.loadProject(projectId);
          if (!project) throw storageError('FILE_CHANGED', 'A project using this recording changed. Refresh storage and try again.');
          const result = removeAssetReferences(project, entry.assetId);
          if (result.changed) changes.push(touch(result.project));
        }
        await this.saveDetachedProjects(changes);
        onDetached(entry.assetId);
        // A known physical deletion failure leaves the asset/page index (or the
        // still-enumerable orphan file) for a retry, after durable detachment.
        if (kind === 'asset') await this.deleteAsset(id, asset.projectId);
        else if (kind === 'orphan-pages') await this.removeAssetMetadata(id);
        else {
          if (!this.directory) throw storageError('OPFS_UNAVAILABLE', 'Audio file storage is unavailable.');
          const possibleAssetId = id.endsWith('.pcm') ? id.slice(0, -4) : null;
          if (possibleAssetId) {
            if ((await this.getAsset(possibleAssetId))?.backend === 'opfs') throw storageError('FILE_CHANGED', 'This file is now indexed as a recording. Refresh storage before deleting it.');
            this.closeHandle(possibleAssetId);
          }
          try { await this.directory.removeEntry(id); } catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
        return { kind, id, assetId: entry.assetId, deleted: true, affectedProjectIds: changes.map(project => project.id), freedAudioBytes: entry.bytes };
      } finally {
        for (const projectId of acquired) await this.releaseProject(projectId);
      }
    }, { required: true });
  }
  async projectUsage(projectId) {
    const assets = await this.listAssets(projectId), byKind = Object.create(null);
    let audioBytes = 0, recordingAssets = 0;
    for (const asset of assets) {
      const bytes = Number.isSafeInteger(asset.byteLength) && asset.byteLength >= 0 ? asset.byteLength
        : Math.max(0, Number(asset.frames) || 0) * Math.max(0, Number(asset.channels) || 0) * 4;
      audioBytes += bytes; if (asset.status === 'recording') recordingAssets++;
      const kind = typeof asset.kind === 'string' ? asset.kind : 'audio';
      const group = byKind[kind] ||= { assets: 0, bytes: 0 }; group.assets++; group.bytes += bytes;
    }
    return { projectId, audioBytes, bytes: audioBytes, assetCount: assets.length, recordingAssets, byKind, includesMetadataOverhead: false };
  }
  async purgeProject(projectId, options = {}, { onDelete = () => {} } = {}) {
    await this.lockProject(projectId);
    return this.withMaintenance(() => this.purgeProjectLocked(projectId, options, onDelete));
  }
  async purgeProjectLocked(projectId, { discardUnfinished = false } = {}, onDelete = () => {}) {
    const assets = await this.listAssets(projectId);
    if (assets.some(asset => asset.projectId !== projectId)) throw storageError('ASSET_OWNER_MISMATCH', 'Project deletion found an inconsistent audio owner and stopped without deleting audio.');
    if (discardUnfinished !== true && assets.some(asset => asset.status === 'recording')) throw storageError('RECORDING_ACTIVE', 'Finish recording or recover this project before permanently deleting it.');
    const owned = new Set(assets.map(asset => asset.id));
    const shared = (await this.all('projects')).filter(project => project.id !== projectId && referencedAssets(project).some(id => owned.has(id)));
    if (shared.length) throw storageError('PROJECT_AUDIO_SHARED', `This project's audio is also used by ${shared.map(project => `“${project.name || 'Untitled project'}”`).join(', ')}. Delete shared files individually in Storage first so their project references can be removed safely.`);
    const project = await this.loadProject(projectId);
    let markerSaved = false;
    // Keep an interrupted purge discoverable, with its metadata, until every
    // owned file and page transaction has succeeded.
    if (project) {
      try { await this.put('projects', { ...project, purgePendingAt: project.purgePendingAt || Date.now() }); markerSaved = true; }
      catch (error) {
        // Deletion must still free space when there is not even enough quota
        // for this optional marker. Existing metadata remains the retry index.
        if (error.name !== 'QuotaExceededError') throw error;
      }
    }
    let deletedAssets = 0, freedAudioBytes = 0;
    try {
      onDelete(assets);
      for (const asset of assets) {
        await this.deleteAsset(asset.id, projectId);
        deletedAssets++; freedAudioBytes += asset.byteLength || asset.frames * asset.channels * 4 || 0;
      }
      await this.removeProjectMetadata(projectId);
      await this.releaseProject(projectId);
      return { projectId, purged: true, deletedAssets, freedAudioBytes };
    } catch (error) {
      // A first deletion may have freed the quota needed for this marker.
      // Preserve the original deletion failure if the best-effort retry fails.
      if (project && !markerSaved) try { await this.put('projects', { ...project, purgePendingAt: project.purgePendingAt || Date.now() }); } catch {}
      throw Object.assign(storageError('PROJECT_PURGE_INCOMPLETE', `Project deletion stopped after ${deletedAssets} audio file${deletedAssets === 1 ? '' : 's'}. Remaining project data was retained. Retry permanent deletion to finish. ${error.message || ''}`), { projectId, deletedAssets, freedAudioBytes, cause: error });
    }
  }
  async releaseProject(projectId) {
    const entry = this.projectLocks.get(projectId);
    if (entry) { await entry.ready; entry.release(); this.projectLocks.delete(projectId); }
    return { projectId, released: true };
  }
  async dispose() {
    this.disposed = true;
    for (const id of [...this.handles.keys()]) this.closeHandle(id);
    for (const entry of this.projectLocks.values()) entry.release();
    this.projectLocks.clear(); this.db?.close();
  }
}
