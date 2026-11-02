/** Worker-side model downloads and complete-response caching; no custom model server is required. */
/* Model assets only. Cache writes happen after complete downloads, so interruption
   never leaves a partial model. Terminating the owning worker cancels downloads. */
const MODEL_CACHE = 'voice-studio-pocket-' + self.POCKET_MODEL_MANIFEST.version;
/** Reports download bytes and caches only complete model assets, allowing interrupted downloads to retry safely. */
async function cachedFetch(url) {
  let cache;
  try {
    cache = await caches.open(MODEL_CACHE);
  } catch {/* private browsing */}
  let hit;
  try {
    hit = cache && (await cache.match(url));
  } catch {
    cache = undefined;
  }
  if (hit) {
    postMessage({
      type: 'status',
      status: `Cached: ${url.split('/').pop()}`
    });
    return hit;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model download failed (${response.status}): ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body?.getReader();
  if (!reader) return response;
  const parts = [];
  let loaded = 0;
  for (;;) {
    const {
      done,
      value
    } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    postMessage({
      type: 'status',
      status: `Downloading ${url.split('/').pop()}: ${(loaded / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
    });
  }
  // Record actual decoded bytes so the storage inventory never needs to read large models into memory.
  const headers = new Headers(response.headers);
  headers.set('x-voice-studio-bytes', String(loaded));
  const complete = new Response(new Blob(parts), {headers});
  if (cache) {
    try {
      await cache.put(url, complete.clone());
    } catch {
      postMessage({
        type: 'status',
        status: 'Storage full: continuing without persistent model cache.'
      });
    }
  }
  return complete;
}
/** Creates an ONNX session from cached bytes and evicts failed assets so retries can recover. */
async function createCachedSession(url, options) {
  const response = await cachedFetch(url);
  try {
    return await ort.InferenceSession.create(await response.arrayBuffer(), options);
  } catch (error) {
    // Invalid/truncated upstream assets must not trap retries in a bad cache.
    try {
      const cache = await caches.open(MODEL_CACHE);
      await cache.delete(url);
    } catch {}
    throw new Error(`Cannot initialize ${url.split('/').pop()}. This device may lack WASM support or memory. Stop and retry. ${error.message}`);
  }
}
