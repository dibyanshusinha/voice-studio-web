/** Global settings shell; the voice workflow reports live resources without moving engine ownership out of its UI. */
import React, {createContext, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction} from 'react';
import {Settings, X} from 'lucide-react';
import ModelStoragePanel from './ModelStoragePanel';
import {loadSavedVoiceProfiles} from './voice-storage';
import type {VoiceProfile} from './types';

export type VoiceRuntimeSettings = {
  voices: VoiceProfile[];
  selectedBundle: string;
  activeBundle?: string;
  runtimeState: string;
  operationBusy: boolean;
  releaseRuntime: () => Promise<void>;
};
type SettingsContextValue = {
  openSettings: () => void;
  setRuntime: Dispatch<SetStateAction<VoiceRuntimeSettings | null>>;
  storageBusy: boolean;
};
const SettingsContext = createContext<SettingsContextValue | null>(null);

/** Shares the storage lock and current voice runtime between the header and voice workflow. */
export function useVoiceSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw Error('Voice settings require the settings provider.');
  return context;
}

/** Supplies one settings modal to every workspace tab, including dictation. */
export function VoiceSettingsProvider({children}: {children: ReactNode}) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<VoiceRuntimeSettings | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  return <SettingsContext.Provider value={{openSettings: () => setOpen(true), setRuntime, storageBusy}}>
    {children}
    {open && <VoiceSettingsModal runtime={runtime} storageBusy={storageBusy} onBusyChange={setStorageBusy} onClose={() => setOpen(false)}/>}
  </SettingsContext.Provider>;
}

/** Opens storage management from the same top-right header location on every tab. */
export function VoiceSettingsButton() {
  const {openSettings} = useVoiceSettings();
  return <button className="settings-button" aria-label="Settings" title="Settings" aria-haspopup="dialog" onClick={openSettings}><Settings size={19}/></button>;
}

/** Native modal provides focus containment and an inert background; Escape and backdrop dismiss when idle. */
function VoiceSettingsModal({runtime, storageBusy, onBusyChange, onClose}: {
  runtime: VoiceRuntimeSettings | null;
  storageBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [savedVoices, setSavedVoices] = useState<VoiceProfile[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = dialog.current!;
    const trigger = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = 'hidden';
    return () => {element.close(); document.body.style.overflow = previousOverflow; trigger?.focus();};
  }, []);
  useEffect(() => {
    let current = true;
    loadSavedVoiceProfiles().then(voices => {if (current) setSavedVoices(voices);})
      .catch(reason => {if (current) setError(String(reason));});
    return () => {current = false;};
  }, []);
  return <dialog ref={dialog} className="settings-modal" aria-labelledby="settings-title"
    onCancel={event => {event.preventDefault(); if (!storageBusy) onClose();}}
    onClick={event => {if (event.target === event.currentTarget && !storageBusy) onClose();}}>
    <div className="settings-modal-body">
      <div className="settings-heading"><div><h1 id="settings-title">Settings</h1><p className="muted">Manage local models and browser storage.</p></div>
        <button className="settings-button" aria-label="Close settings" disabled={storageBusy} onClick={onClose}><X size={20}/></button>
      </div>
      {error && <p role="alert">{error}</p>}
      <ModelStoragePanel voices={runtime?.voices || savedVoices} selectedBundle={runtime?.selectedBundle || ''}
        activeBundle={runtime?.activeBundle} runtimeState={runtime?.runtimeState || 'not-loaded'}
        operationBusy={runtime?.operationBusy || false} onBusyChange={onBusyChange}
        releaseRuntime={runtime?.releaseRuntime || releaseInactiveRuntime}/>
    </div>
  </dialog>;
}

/** Dictation has no inference worker to release; cached-model deletion still works from settings. */
async function releaseInactiveRuntime() {}
