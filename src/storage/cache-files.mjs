// Only this studio's offline shell belongs in its file manager. Other apps
// hosted on the same origin can have their own caches and recordings.
const studioScope = () => new URL('../../', import.meta.url);
const cachePrefix = scope => `fml-shell-${encodeURIComponent(scope.pathname)}-`;
const readablePath = pathname => { try { return decodeURI(pathname); } catch { return pathname; } };
const ownsRequest = (requestUrl, scope) => {
  try { const url = new URL(requestUrl); return url.origin === scope.origin && url.pathname.startsWith(scope.pathname); }
  catch { return false; }
};

export async function listStudioCacheFiles({ cacheStorage = globalThis.caches, scope = studioScope() } = {}) {
  const result = { files: [], cacheBytes: 0, knownCacheBytes: 0, unknownFiles: 0, complete: true, errors: [] };
  if (!cacheStorage) return { ...result, cacheBytes: null, complete: false, errors: ['Offline cache storage is unavailable in this browser.'] };
  try {
    const names = (await cacheStorage.keys()).filter(name => name.startsWith(cachePrefix(scope)));
    for (const cacheName of names) {
      try {
        const cache = await cacheStorage.open(cacheName);
        for (const request of await cache.keys()) {
          if (!ownsRequest(request.url, scope)) continue;
          const file = { key: `cache:${cacheName}:${request.url}`, kind: 'cache', id: request.url, requestUrl: request.url, cacheName,
            name: readablePath(new URL(request.url).pathname.slice(scope.pathname.length)) || 'index.html', projectName: 'Offline app files',
            backend: 'cache', status: 'cached', sizeBasis: 'response-body', bytes: null };
          try {
            const response = await cache.match(request);
            if (!response || response.type === 'opaque') throw new Error('This cache entry cannot be measured.');
            file.bytes = (await response.blob()).size;
            file.revision = JSON.stringify([file.bytes, response.status, response.headers.get('etag'), response.headers.get('last-modified')]);
            result.knownCacheBytes += file.bytes;
          } catch (error) { result.unknownFiles++; result.complete = false; result.errors.push(`${file.name}: ${error.message || error}`); }
          result.files.push(file);
        }
      } catch (error) { result.complete = false; result.errors.push(`${cacheName}: ${error.message || error}`); }
    }
  } catch (error) { result.complete = false; result.errors.push(`Offline cache inventory: ${error.message || error}`); }
  result.cacheBytes = result.complete ? result.knownCacheBytes : null;
  return result;
}

export async function deleteStudioCacheFile(file, { cacheStorage = globalThis.caches, scope = studioScope() } = {}) {
  if (!cacheStorage || file?.kind !== 'cache' || typeof file.cacheName !== 'string'
    || !file.cacheName.startsWith(cachePrefix(scope)) || !ownsRequest(file.requestUrl, scope)
    || file.key !== `cache:${file.cacheName}:${file.requestUrl}`) throw new Error('This is not an offline file owned by this studio.');
  if (!(await cacheStorage.keys()).includes(file.cacheName)) return { deleted: true, freedBytes: 0 };
  const cache = await cacheStorage.open(file.cacheName);
  const request = (await cache.keys()).find(item => item.url === file.requestUrl && item.method === 'GET');
  if (!request) return { deleted: true, freedBytes: 0 };
  const response = await cache.match(request);
  let bytes = null;
  if (response && response.type !== 'opaque') {
    bytes = (await response.blob()).size;
    const revision = JSON.stringify([bytes, response.status, response.headers.get('etag'), response.headers.get('last-modified')]);
    if (file.revision && revision !== file.revision) throw new Error('This offline file changed. Refresh Storage and review it again.');
  }
  if (!(await cache.delete(request))) throw new Error('The offline file could not be deleted. Refresh Storage and try again.');
  return { deleted: true, freedBytes: bytes };
}
