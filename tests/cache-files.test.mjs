import test from 'node:test';
import assert from 'node:assert/strict';
import { listStudioCacheFiles, deleteStudioCacheFile } from '../src/storage/cache-files.mjs';

const scope = new URL('https://example.test/studio/');
const name = 'fml-shell-%2Fstudio%2F-build1';
function fixture() {
  const caches = new Map();
  const add = (cacheName, path, body) => {
    const records = caches.get(cacheName) || new Map(); caches.set(cacheName, records);
    records.set(new URL(path, scope).href, new Response(body, { headers: { etag: body } }));
  };
  const cacheStorage = {
    keys: async () => [...caches.keys()],
    open: async cacheName => {
      const records = caches.get(cacheName) || new Map(); caches.set(cacheName, records);
      return { keys: async () => [...records.keys()].map(url => new Request(url)), match: async req => records.get(req.url)?.clone(), delete: async req => records.delete(req.url) };
    },
  };
  return { caches, add, cacheStorage, options: { cacheStorage, scope } };
}

test('cache inventory measures only studio-owned responses across versions without clearing other apps', async () => {
  const f=fixture(); f.add(name,'index.html','one'); f.add(name+'old','src/main.mjs','four');
  f.add('fml-shell-%2Fother%2F-v1','/other/index.html','foreign'); f.add(name,'/unrelated/data','secret');
  const result=await listStudioCacheFiles(f.options);
  assert.equal(result.complete,true); assert.equal(result.cacheBytes,7); assert.equal(result.files.length,2);
  assert.equal(result.files[0].sizeBasis,'response-body');
  const selected=result.files[0]; await deleteStudioCacheFile(selected,f.options);
  assert.equal(f.caches.get(name).has(selected.requestUrl),false);
  assert.equal(f.caches.get(name).has('https://example.test/unrelated/data'),true);
  assert.equal(f.caches.get('fml-shell-%2Fother%2F-v1').size,1);
  assert.equal((await listStudioCacheFiles(f.options)).cacheBytes,4);
});

test('cache deletion rejects foreign scopes and stale entries, then permits an explicit refreshed retry', async () => {
  const f=fixture(); f.add(name,'index.html','one');
  const file=(await listStudioCacheFiles(f.options)).files[0];
  await assert.rejects(deleteStudioCacheFile({...file,requestUrl:'https://example.test/other/data'},f.options),/not an offline file/);
  await assert.rejects(deleteStudioCacheFile({...file,cacheName:'another-app'},f.options),/not an offline file/);
  f.add(name,'index.html','changed');
  await assert.rejects(deleteStudioCacheFile(file,f.options),/changed/);
  assert.equal(f.caches.get(name).size,1);
  const refreshed=(await listStudioCacheFiles(f.options)).files[0];
  assert.equal((await deleteStudioCacheFile(refreshed,f.options)).freedBytes,7);
  assert.equal((await deleteStudioCacheFile(refreshed,f.options)).freedBytes,0);
});

test('unavailable or failed cache inventory reports unknown capacity, not zero usage', async () => {
  const unsupported=await listStudioCacheFiles({cacheStorage:null,scope});
  assert.equal(unsupported.complete,false);assert.equal(unsupported.cacheBytes,null);
  const failed=await listStudioCacheFiles({cacheStorage:{keys:async()=>{throw new Error('blocked');}},scope});
  assert.equal(failed.complete,false);assert.equal(failed.cacheBytes,null);assert.match(failed.errors[0],/blocked/);
});

test('unreadable individual responses remain visible with unknown sizes', async () => {
  const cacheStorage={keys:async()=>[name],open:async()=>({keys:async()=>[new Request(new URL('index.html',scope))],match:async()=>null})};
  const result=await listStudioCacheFiles({cacheStorage,scope});
  assert.equal(result.files.length,1);assert.equal(result.files[0].bytes,null);assert.equal(result.unknownFiles,1);
  assert.equal(result.cacheBytes,null);assert.equal(result.knownCacheBytes,0);assert.equal(result.complete,false);
});
