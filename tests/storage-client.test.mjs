import test from 'node:test';
import assert from 'node:assert/strict';
import { StorageClient } from '../src/storage/client.mjs';

class FakeWorker {
  constructor() { this.messages = []; this.terminated = false; }
  postMessage(message, transfer) { this.messages.push({ message, transfer }); }
  respond(index, result, error) { this.onmessage({ data: { type: 'rpc-result', id: this.messages[index].message.id, result, error } }); }
  terminate() { this.terminated = true; }
}
const fixture = () => { const worker = new FakeWorker(); return { worker, client: new StorageClient({ workerFactory: () => worker }) }; };

test('storage RPC replies resolve by id even when reads reply out of order', async () => {
  const { worker, client } = fixture();
  const first = client.getAsset('a'), second = client.getAsset('b');
  worker.respond(1, { id: 'b' }); worker.respond(0, { id: 'a' });
  assert.deepEqual(await Promise.all([first, second]), [{ id: 'a' }, { id: 'b' }]);
  assert.equal(client.pending.size, 0);
});
test('worker failures reject all outstanding and future requests without hanging', async () => {
  const { worker, client } = fixture();
  const errors = []; client.addEventListener('error', (event) => errors.push(event.detail));
  const pending = [client.getAsset('a'), client.saveProject({ id: 'p' })];
  worker.onerror({ message: 'Simulated worker crash' });
  await Promise.all(pending.map((promise) => assert.rejects(promise, /Simulated worker crash/)));
  await assert.rejects(client.getAsset('b'), /Simulated worker crash/);
  assert.equal(worker.terminated, true); assert.equal(errors[0].code, 'STORAGE_WORKER_FAILED');
  await client.dispose();
});
test('a structured worker storage error keeps its useful code', async () => {
  const { worker, client } = fixture(); const promise = client.saveProject({ id: 'a' });
  worker.respond(0, undefined, { name: 'StorageError', code: 'PROJECT_BUSY', message: 'Open in another tab' });
  await assert.rejects(promise, { name: 'StorageError', code: 'PROJECT_BUSY' });
});
test('audio ports and PCM use transferable messages', async () => {
  const { worker, client } = fixture();
  const port = { name: 'port' }, buffer = new ArrayBuffer(32);
  client.attachAudioPort(port); const promise = client.putPage('a', 0, buffer, 8, 1);
  assert.equal(worker.messages[0].transfer[0], port);
  assert.equal(worker.messages[1].transfer[0], buffer);
  worker.respond(1, { frames: 8 }); await promise;
});
test('checkpoint notifications remain distinct from sealing', () => {
  const { worker, client } = fixture(); client.start(); const observed = [];
  client.addEventListener('progress', (event) => observed.push(event.detail));
  worker.onmessage({ data: { type: 'event', event: 'progress', detail: { assetId: 'a', checkpointFrames: 100, saved: false } } });
  worker.onmessage({ data: { type: 'event', event: 'progress', detail: { assetId: 'a', checkpointFrames: 101, saved: true, sealed: true } } });
  assert.equal(observed[0].saved, false); assert.equal(observed[1].sealed, true);
});

test('bounded audio range RPC preserves frame units and returns the immutable Blob', async () => {
  const { worker, client } = fixture(), range = { startFrame: 16000, frames: 2048 };
  const requested = client.getAssetRange('long-audio', range);
  assert.deepEqual(worker.messages[0].message.args, ['long-audio', range]); assert.equal(worker.messages[0].message.method, 'getAssetRange');
  const blob = new Blob([new Uint8Array([1, 2, 3])]); worker.respond(0, blob);
  assert.equal(await requested, blob);
});
