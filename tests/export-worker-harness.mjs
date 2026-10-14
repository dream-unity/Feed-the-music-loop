// Node-only bridge for exercising the actual browser worker message protocol.
import { parentPort, workerData } from 'node:worker_threads';
const queued = [];
let ready = false;
globalThis.self = globalThis;
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
parentPort.on('message', data => {
  if (ready) globalThis.onmessage({ data }); else queued.push(data);
});
await import(workerData.url);
ready = true;
for (const data of queued) globalThis.onmessage({ data });
