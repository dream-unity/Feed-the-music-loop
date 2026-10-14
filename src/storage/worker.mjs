import { BrowserBackend } from './backend.mjs';
import { AssetJournal, FairQueue, storageError, validId } from './core.mjs';

const backend = new BrowserBackend();
const journal = new AssetJournal(backend);
const queue = new FairQueue();
const ports = new Set();
const releasedProjects = new Set();
let initializing;
let disposed = false;
const initialize = () => initializing ||= backend.init();
const serializeError = (error) => error?.name === 'QuotaExceededError'
  ? { name: error.name, code: 'QUOTA_EXCEEDED', message: 'Browser storage is full. The checkpointed part of your recording is preserved. Export a backup and free space before recording again.' }
  : { name: error?.name || 'Error', code: error?.code || error?.name || 'STORAGE_ERROR', message: error?.message || String(error) };
const notify = (event, detail) => self.postMessage({ type: 'event', event, detail });
const progress = (asset, extra = {}) => notify('progress', { assetId: asset.id, projectId: asset.projectId, frames: asset.frames, checkpointFrames: asset.checkpointFrames, pageCount: asset.pageCount, status: asset.status, saved: asset.status !== 'recording', ...queue.stats, ...extra });
async function assertReadable(id) {
  const asset = await journal.get(id);
  if (releasedProjects.has(asset.projectId)) throw storageError('PROJECT_RELEASED', 'This project was closed. Reopen it before reading its audio.');
}

async function seal(id, options) {
  const asset = await journal.finish(id, options);
  progress(asset, { sealed: true, finalized: true, error: asset.error });
  return asset;
}

const methods = {
  init: () => initialize(),
  listProjects: () => backend.listProjects(),
  saveProject: ([project]) => {
    validId(project?.id, 'Project');
    if (project.schemaVersion !== 1 || !Array.isArray(project.tracks) || !Array.isArray(project.takes)) throw storageError('INVALID_PROJECT', 'Project metadata is invalid.');
    return backend.saveProject(project);
  },
  loadProject: ([id]) => { validId(id, 'Project'); return backend.loadProject(id); },
  deleteProject: ([id]) => { validId(id, 'Project'); return backend.deleteProject(id); },
  projectUsage: ([id]) => { validId(id, 'Project'); return backend.projectUsage(id); },
  purgeProject: async ([id]) => {
    validId(id, 'Project');
    try { return await backend.purgeProject(id); }
    finally {
      for (const [assetId, asset] of journal.assets) if (asset.projectId === id && asset.status !== 'recording') { journal.assets.delete(assetId); journal.failures.delete(assetId); }
    }
  },
  beginAsset: async ([metadata]) => { const asset = await journal.begin(metadata); releasedProjects.delete(asset.projectId); return asset; },
  finishAsset: ([id, options]) => seal(id, options),
  getAsset: async ([id]) => ({ ...await journal.get(id) }),
  listAssets: ([projectId]) => backend.listAssets(projectId),
  readPage: async ([id, index]) => { await assertReadable(id); return journal.read(id, index); },
  putPage: async ([id, index, buffer, frames, channels]) => {
    const result = await journal.write(id, index, buffer, frames, channels);
    progress(result.asset); return { ...result.page, checkpointFrames: result.asset.checkpointFrames };
  },
  getAssetFile: async ([id]) => backend.getAssetFile(await journal.get(id)),
  deleteAsset: async ([id]) => { validId(id); const result = await backend.deleteAsset(id); journal.assets.delete(id); journal.failures.delete(id); return result; },
  estimate: () => backend.estimate(),
  requestPersistence: async () => ({ persistent: await navigator.storage?.persist?.() || false, ...(await backend.estimate()) }),
  recover: async ([projectId, options = {}]) => {
    validId(projectId, 'Project');
    // A failed writer lock still permits opening this project read only.
    releasedProjects.delete(projectId);
    await backend.lockProject(projectId);
    const assets = await backend.listAssets(projectId), recovered = [];
    for (const asset of assets) {
      journal.assets.set(asset.id, asset);
      const size = await backend.inspectAssetSize(asset);
      const needsRecovery = options.verify === true || asset.status === 'recording'
        || (asset.status === 'interrupted' && !asset.recoveredAt)
        || !size.available || size.byteLength < asset.byteLength;
      if (!needsRecovery) continue;
      const result = await journal.recover(asset.id);
      if (result.recovered) recovered.push(result);
    }
    return recovered;
  },
  releaseProject: async ([projectId]) => {
    validId(projectId, 'Project');
    const assets = [...journal.assets.values()].filter(asset => asset.projectId === projectId);
    if (assets.some(asset => asset.status === 'recording')) throw storageError('RECORDING_ACTIVE', 'Finish recording before closing this project.');
    // Fair scheduling may leave old worklet read messages behind this command.
    // Fence them before closing handles so they cannot reopen an old file after
    // another tab is allowed to acquire this project's writer lock.
    releasedProjects.add(projectId);
    for (const asset of assets) {
      backend.closeHandle(asset.id); journal.assets.delete(asset.id);
    }
    return backend.releaseProject(projectId);
  },
  dispose: async () => {
    disposed = true;
    for (const port of ports) port.close();
    ports.clear(); await backend.dispose(); return { disposed: true };
  },
};

function attachPort(port) {
  ports.add(port); port.start();
  port.onmessage = ({ data }) => {
    if (disposed) return;
    const type = data?.type;
    if (!['write', 'read', 'end'].includes(type)) return;
    const run = async () => {
      await initialize();
      if (type === 'write') {
        const result = await journal.write(data.assetId, data.index, data.buffer, data.frames, data.channels);
        port.postMessage({ type: 'written', assetId: data.assetId, index: data.index, frames: data.frames, checkpointFrames: result.asset.checkpointFrames });
        progress(result.asset);
      } else if (type === 'read') {
        await assertReadable(data.assetId);
        const result = await journal.read(data.assetId, data.index);
        if (result.missing) port.postMessage({ type: 'page-missing', assetId: data.assetId, index: data.index, retryable: result.retryable });
        else port.postMessage({ type: 'page', assetId: data.assetId, ...result }, [result.buffer]);
      } else {
        const asset = await seal(data.assetId, { frames: data.frames, status: data.status });
        port.postMessage({ type: 'sealed', assetId: asset.id, frames: asset.frames, status: asset.status, finalized: true, error: asset.error });
      }
    };
    queue.add(run, { read: type === 'read', bytes: type === 'write' ? data.buffer?.byteLength || 0 : 0 })
      .catch(async (error) => {
        if (type === 'read' && error.code === 'PROJECT_RELEASED') { port.postMessage({ type: 'page-missing', assetId: data.assetId, index: data.index, retryable: false }); return; }
        if (type !== 'read') journal.fail(data.assetId, error);
        const detail = { assetId: data.assetId, index: data.index, ...serializeError(error), operation: type };
        port.postMessage({ type: 'storage-error', ...detail });
        notify('error', detail);
        if (type === 'end') {
          // The checkpoint remains authoritative when even final metadata cannot
          // be written. Unblock the transport while explicitly reporting this
          // unfinished finalization; reopening will recover the saved prefix.
          const asset = journal.assets.get(data.assetId);
          const checkpointFrames = asset?.checkpointFrames || 0;
          port.postMessage({ type: 'sealed', assetId: data.assetId, frames: checkpointFrames, status: 'interrupted', finalized: false, error: detail.message });
          notify('progress', { assetId: data.assetId, projectId: asset?.projectId, frames: checkpointFrames, checkpointFrames, status: 'interrupted', saved: false, sealed: true, finalized: false, error: detail.message });
        }
      }).finally(() => {
        if (type === 'write' && data.buffer instanceof ArrayBuffer && data.buffer.byteLength) port.postMessage({ type: 'recycle', buffer: data.buffer }, [data.buffer]);
      });
  };
}

self.onmessage = ({ data }) => {
  if (data?.type === 'attach-audio') { attachPort(data.port); return; }
  if (data?.type !== 'rpc') return;
  const { id, method, args = [] } = data;
  if (!Object.hasOwn(methods, method)) { self.postMessage({ type: 'rpc-result', id, error: serializeError(storageError('UNKNOWN_METHOD', 'Unknown storage operation.')) }); return; }
  const read = ['getAsset', 'listAssets', 'readPage', 'estimate', 'loadProject', 'listProjects', 'projectUsage'].includes(method);
  const bytes = method === 'putPage' ? args[2]?.byteLength || 0 : 0;
  queue.add(async () => {
    if (disposed && method !== 'dispose') throw storageError('STORAGE_CLOSED', 'Audio storage is closed.');
    await initialize();
    return methods[method](args);
  }, { read, bytes }).then((result) => {
    const transfer = result?.buffer instanceof ArrayBuffer ? [result.buffer] : [];
    self.postMessage({ type: 'rpc-result', id, result }, transfer);
  }).catch((error) => self.postMessage({ type: 'rpc-result', id, error: serializeError(error) }));
};
