/** Main-thread facade. Binary recording traffic travels directly worker↔worklet. */
export class StorageClient extends EventTarget {
  constructor({ workerFactory } = {}) {
    super(); this.workerFactory = workerFactory; this.worker = null; this.pending = new Map(); this.nextId = 1; this.closed = false; this.ready = null; this.failure = null;
  }
  start() {
    if (this.closed) throw new Error('Audio storage is closed.');
    if (this.failure) throw this.failure;
    if (this.worker) return;
    this.worker = this.workerFactory ? this.workerFactory() : new Worker(new URL('./worker.mjs', import.meta.url), { type: 'module', name: 'fml-audio-storage' });
    this.worker.onmessage = ({ data }) => {
      if (data?.type === 'event') { this.dispatchEvent(new CustomEvent(data.event, { detail: data.detail })); return; }
      if (data?.type !== 'rpc-result') return;
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.error) pending.reject(Object.assign(new Error(data.error.message), { name: data.error.name, code: data.error.code }));
      else pending.resolve(data.result);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'Audio storage stopped unexpectedly. Reopen the project to recover checkpointed recordings.');
      this.fail(error, 'STORAGE_WORKER_FAILED');
    };
    this.worker.onmessageerror = () => this.fail(new Error('An audio storage message could not be read. Reopen the project to recover checkpointed recordings.'), 'STORAGE_MESSAGE_ERROR');
  }
  fail(error, code) {
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.worker?.terminate(); this.worker = null;
    this.dispatchEvent(new CustomEvent('error', { detail: { code, message: error.message } }));
  }
  rpc(method, args = [], transfer = []) {
    return new Promise((resolve, reject) => {
      try { this.start(); } catch (error) { reject(error); return; }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ type: 'rpc', id, method, args }, transfer); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  init() { return this.ready ||= this.rpc('init'); }
  listProjects() { return this.rpc('listProjects'); }
  saveProject(project) { return this.rpc('saveProject', [project]); }
  loadProject(id) { return this.rpc('loadProject', [id]); }
  deleteProject(id) { return this.rpc('deleteProject', [id]); }
  purgeProject(id) { return this.rpc('purgeProject', [id]); }
  projectUsage(id) { return this.rpc('projectUsage', [id]); }
  beginAsset(metadata) { return this.rpc('beginAsset', [metadata]); }
  finishAsset(id, options = {}) { return this.rpc('finishAsset', [id, options]); }
  getAsset(id) { return this.rpc('getAsset', [id]); }
  listAssets(projectId) { return this.rpc('listAssets', [projectId]); }
  readPage(id, index) { return this.rpc('readPage', [id, index]); }
  putPage(id, index, buffer, frames, channels) { return this.rpc('putPage', [id, index, buffer, frames, channels], [buffer]); }
  getAssetFile(id) { return this.rpc('getAssetFile', [id]); }
  getAssetRange(id, range) { return this.rpc('getAssetRange', [id, range]); }
  deleteAsset(id) { return this.rpc('deleteAsset', [id]); }
  estimate() { return this.rpc('estimate'); }
  async requestPersistence() {
    // Request on the main thread so browsers can associate it with the user's action.
    if (globalThis.navigator?.storage?.persist) {
      const persistent = await navigator.storage.persist();
      return { ...(await this.estimate()), persistent };
    }
    return this.rpc('requestPersistence');
  }
  recover(projectId, options = {}) { return this.rpc('recover', [projectId, options]); }
  releaseProject(projectId) { return this.rpc('releaseProject', [projectId]); }
  attachAudioPort(port) { this.start(); this.worker.postMessage({ type: 'attach-audio', port }, [port]); }
  async dispose() {
    if (this.closed) return;
    if (this.worker) { try { await this.rpc('dispose'); } finally { this.worker?.terminate(); this.worker = null; } }
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new Error('Audio storage was closed.'));
    this.pending.clear();
  }
}
