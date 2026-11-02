/** Inventories only Voice Studio model caches; saved profiles and unrelated site caches are never removed. */
const MODEL_CACHE_PREFIX = 'voice-studio-pocket-';
export type CachedModelAsset = {
  cacheName: string;
  url: string;
  filename: string;
  bundle: string;
  bytes: number;
};
export type ModelStorageInventory = {
  assets: CachedModelAsset[];
  modelBytes: number;
  originUsage?: number;
  originQuota?: number;
};

/** Counts legacy cached responses incrementally rather than materializing entire model buffers in the UI heap. */
async function measureCachedResponse(response: Response): Promise<number> {
  const recorded = response.headers.get('x-voice-studio-bytes');
  if (recorded !== null && Number.isFinite(Number(recorded)) && Number(recorded) >= 0) return Number(recorded);
  const reader = response.body?.getReader();
  if (!reader) return 0;
  let bytes = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return bytes;
      bytes += value.byteLength;
    }
  } finally { reader.releaseLock(); }
}

/** Lists installed model files and origin-wide quota estimates without downloading any assets. */
export async function inspectModelStorage(): Promise<ModelStorageInventory> {
  if (!globalThis.caches) throw Error('This browser does not expose model cache storage.');
  const assets: CachedModelAsset[] = [];
  for (const cacheName of await caches.keys()) {
    if (!cacheName.startsWith(MODEL_CACHE_PREFIX)) continue;
    const cache = await caches.open(cacheName);
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      if (!response) continue;
      const pathname = new URL(request.url).pathname;
      const bundle = pathname.match(/\/onnx\/([^/]+)\//)?.[1] || 'Other model assets';
      assets.push({cacheName, url: request.url, filename: pathname.split('/').pop() || request.url,
        bundle, bytes: await measureCachedResponse(response)});
    }
  }
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  return {assets, modelBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    originUsage: estimate?.usage, originQuota: estimate?.quota};
}

/** Removes selected Voice Studio assets; empty cache containers are removed as well. */
export async function removeCachedModelAssets(assets: CachedModelAsset[]): Promise<void> {
  // Validate the full request before deleting anything; callers cannot target unrelated caches.
  if (assets.some(asset => !asset.cacheName.startsWith(MODEL_CACHE_PREFIX))) throw Error('Only Voice Studio model caches can be cleared.');
  const existing = new Set(await caches.keys());
  for (const cacheName of new Set(assets.map(asset => asset.cacheName))) {
    if (!existing.has(cacheName)) continue;
    const cache = await caches.open(cacheName);
    for (const asset of assets.filter(item => item.cacheName === cacheName)) await cache.delete(asset.url);
    if (!(await cache.keys()).length) await caches.delete(cacheName);
  }
}

/** Clears every current or older Voice Studio model-cache version while preserving voice profiles. */
export async function clearAllModelCaches(): Promise<void> {
  for (const name of await caches.keys()) if (name.startsWith(MODEL_CACHE_PREFIX)) await caches.delete(name);
}

/** Formats model sizes consistently without implying that an origin estimate is app-only usage. */
export function formatStorageBytes(bytes?: number): string {
  if (bytes === undefined) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
