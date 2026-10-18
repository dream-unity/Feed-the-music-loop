import { renderMasterFrames } from './master-core.mjs';

const pending = new Map();
let nextId = 1, running = false;
function rpc(method, args, transfer = []) {
  return new Promise((resolve, reject) => {
    const requestId = nextId++; pending.set(requestId, { resolve, reject });
    postMessage({ type: 'rpc', requestId, method, args }, transfer);
  });
}
self.onmessage = async ({ data: message }) => {
  if (message.type === 'rpc-result') {
    const task = pending.get(message.requestId); if (!task) return;
    pending.delete(message.requestId);
    if (message.error) task.reject(Object.assign(new Error(message.error.message || String(message.error)), { code: message.error.code })); else task.resolve(message.result);
    return;
  }
  if (message.type !== 'master' || running) return;
  running = true;
  try {
    const result = await renderMasterFrames(message.plan, {
      readPage: (id, index) => rpc('readPage', [id, index]),
      writePage: (index, buffer, frames, channels) => rpc('putPage', [index, buffer, frames, channels], [buffer]),
      onProgress: progress => postMessage({ type: 'progress', progress }),
    });
    postMessage({ type: 'complete', result });
  } catch (error) { postMessage({ type: 'error', message: error.message || String(error), code: error.code }); }
};
