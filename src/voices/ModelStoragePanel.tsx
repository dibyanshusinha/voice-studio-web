/** User-controlled model inventory and cleanup; destructive actions target model downloads only. */
import React, {useEffect, useState} from 'react';
import type {VoiceProfile} from './types';
import {inspectModelStorage, removeCachedModelAssets, clearAllModelCaches, formatStorageBytes,
  type CachedModelAsset, type ModelStorageInventory} from './model-storage';

type Props = {
  voices: VoiceProfile[];
  selectedBundle: string;
  activeBundle?: string;
  runtimeState: string;
  operationBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  releaseRuntime: () => Promise<void>;
};

/** Refreshes on operation completion; scanning existing files never starts inference or downloads. */
export default function ModelStoragePanel({voices, selectedBundle, activeBundle, runtimeState, operationBusy, onBusyChange, releaseRuntime}: Props) {
  const [inventory, setInventory] = useState<ModelStorageInventory>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<{label: string; assets?: CachedModelAsset[]}>();

  // Lock clone/generate controls while inventory or deletion is running in this tab.
  useEffect(() => { onBusyChange(working); return () => onBusyChange(false); }, [working, onBusyChange]);

  useEffect(() => {
    if (operationBusy) return;
    let current = true;
    setWorking(true);
    inspectModelStorage().then(value => {if (current) {setInventory(value); setError('');}})
      .catch(reason => {if (current) setError(String(reason));})
      .finally(() => {if (current) setWorking(false);});
    return () => {current = false;};
  }, [operationBusy]);

  /** Allows an explicit rescan after another tab or browser storage cleanup changes cached files. */
  async function refreshInventory() {
    setWorking(true); setError('');
    try {setInventory(await inspectModelStorage());} catch (reason) {setError(String(reason));}
    finally {setWorking(false);}
  }

  /** Stops the worker before deletion so this tab cannot recreate a cache during cleanup. */
  async function confirmModelRemoval() {
    if (!pendingRemoval) return;
    setWorking(true); setError('');
    try {
      await releaseRuntime();
      if (pendingRemoval.assets) await removeCachedModelAssets(pendingRemoval.assets);
      else await clearAllModelCaches();
      setPendingRemoval(undefined);
      setInventory(await inspectModelStorage());
      setNotice('Model downloads removed. Saved voices are unchanged. Missing files will download when needed.');
    } catch (reason) {setError(String(reason));}
    finally {setWorking(false);}
  }

  /** Frees this tab's WASM heap and audio nodes without removing reusable disk-cached downloads. */
  async function releaseLoadedModels() {
    setWorking(true); setError('');
    try {await releaseRuntime(); setNotice('Inference worker and playback resources released. Cached downloads are still available.');}
    catch (reason) {setError(String(reason));}
    finally {setWorking(false);}
  }

  const groups = new Map<string, CachedModelAsset[]>();
  for (const asset of inventory?.assets || []) {
    const key = `${asset.cacheName}/${asset.bundle}`;
    groups.set(key, [...(groups.get(key) || []), asset]);
  }
  // A bundle is considered in use if selected, loaded, or required by any saved profile.
  const unusedAssets = (inventory?.assets || []).filter(asset =>
    asset.bundle !== selectedBundle && asset.bundle !== activeBundle && !voices.some(voice => voice.bundle === asset.bundle));
  const disabled = working || operationBusy;
  return <section className="panel model-storage" aria-label="Model storage">
    <div className="panelhead"><h2>Models &amp; storage</h2><span className="pill">This browser</span></div>
    <div className="storage-summary">
      <div><span className="muted">Cached model downloads</span><strong>{inventory ? formatStorageBytes(inventory.modelBytes) : 'Not yet measured'}</strong></div>
      <div><span className="muted">Inference memory · this tab</span><strong>{runtimeState === 'not-loaded' ? 'Released' : `${activeBundle} · ${runtimeState}`}</strong></div>
    </div>
    <p className="muted">Cache storage keeps downloaded files on disk. Loaded models use memory until you release the engine or close this tab. Browsers do not expose a reliable per-model RAM measurement.</p>
    <p className="muted">Whole-site storage estimate: {formatStorageBytes(inventory?.originUsage)} used / {formatStorageBytes(inventory?.originQuota)} quota. This includes profiles and other origin data, not just models.</p>
    <div className="actions">
      <button disabled={disabled} onClick={() => void refreshInventory()}>Refresh inventory</button>
      <button disabled={disabled || runtimeState === 'not-loaded'} onClick={() => void releaseLoadedModels()}>Release model memory</button>
      <button disabled={disabled || !unusedAssets.length} onClick={() => setPendingRemoval({label:'downloads not used by saved voices or the current selection', assets:unusedAssets})}>Remove unused bundles</button>
      <button disabled={disabled || !inventory?.assets.length} onClick={() => setPendingRemoval({label:'all downloaded models'})}>Clear all model downloads</button>
    </div>
    {operationBusy && <p className="muted">Close Settings and stop the active recording or generation before managing storage.</p>}
    {working && <p role="status" className="muted">Checking storage…</p>}
    {!working && inventory && !inventory.assets.length && <p className="muted">No cached model downloads. Models download automatically when you clone or generate speech.</p>}
    {[...groups].map(([key, assets]) => {
      const bundle = assets[0].bundle;
      const count = voices.filter(voice => voice.bundle === bundle).length;
      const used = count > 0 || bundle === selectedBundle || bundle === activeBundle;
      return <details className="cached-model-group" key={key}>
        <summary><strong>{bundle}</strong><span>{formatStorageBytes(assets.reduce((n, asset) => n + asset.bytes, 0))} · {assets.length} files</span></summary>
        <p className="muted">{count ? `Used by ${count} saved voice${count === 1 ? '' : 's'}.` : used ? 'Selected for the current workflow.' : 'Not used by saved voices or the current selection.'} Removing downloads keeps voices saved; their model files will need downloading again.</p>
        <p className="muted">Cache version: {assets[0].cacheName.replace('voice-studio-pocket-', '')}</p>
        <div className="actions"><button disabled={disabled} onClick={() => setPendingRemoval({label:`${bundle} downloads`, assets})}>Remove this bundle</button></div>
        <ul className="cached-model-files">{assets.map(asset => <li key={asset.url}>
          <div><span className="cached-model-name">{asset.filename}</span><small>{asset.filename.includes('encoder') ? 'Reference cloning only' : 'Speech generation / shared metadata'} · {formatStorageBytes(asset.bytes)}</small></div>
          <button disabled={disabled} onClick={() => setPendingRemoval({label:asset.filename, assets:[asset]})}>Remove file</button>
        </li>)}</ul>
      </details>;
    })}
    {pendingRemoval && <div className="storage-confirmation" role="group" aria-label="Confirm model removal">
      <p>Remove {pendingRemoval.label}? Saved voices remain. Removed files must download again before use. The loaded engine will be released first.</p>
      <div className="actions"><button disabled={disabled} onClick={() => void confirmModelRemoval()}>Remove downloads</button><button disabled={working} onClick={() => setPendingRemoval(undefined)}>Cancel</button></div>
    </div>}
    {notice && <p role="status" className="muted">{notice}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="muted">Only Voice Studio model caches are managed here. Runtime CDN HTTP cache is browser-managed. Saved voices are managed in the library above. Close other Voice Studio tabs before clearing downloads; another active tab can cache files again.</p>
  </section>;
}
