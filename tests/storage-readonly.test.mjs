import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBackend } from '../src/storage/backend.mjs';

test('an immutable audio page remains readable while another tab holds its sync handle', async () => {
  const backend = new BrowserBackend();
  backend.openHandle = async () => { throw Object.assign(new Error('File locked'), { name: 'NoModificationAllowedError' }); };
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  let opened;
  backend.directory = { async getFileHandle(name) { opened = name; return { async getFile() { return new Blob([bytes]); } }; } };
  const buffer = await backend.readData({ id: 'saved-loop', backend: 'opfs', status: 'complete' }, { offset: 2, byteLength: 4 });
  assert.deepEqual([...new Uint8Array(buffer)], [3, 4, 5, 6]);
  assert.equal(opened, 'saved-loop.pcm');
});
test('read-only fallback does not bypass a concurrent recording file lock', async () => {
  const backend = new BrowserBackend();
  backend.openHandle = async () => { throw Object.assign(new Error('File locked'), { name: 'NoModificationAllowedError' }); };
  backend.directory = { getFileHandle() { assert.fail('Must not snapshot a concurrently changing recording'); } };
  await assert.rejects(backend.readData({ id: 'active', backend: 'opfs', status: 'recording' }, { offset: 0, byteLength: 4 }), { name: 'NoModificationAllowedError' });
});
