/** Native voice workflow: reference capture, profile storage, synthesis playback and download. */
import React, { useEffect, useRef, useState } from 'react';
import PreviewSettings from './PreviewSettings';
import {DEFAULT_GENERATION_SETTINGS, normalizeGenerationSettings, type GenerationSettings} from './generation-settings';
import LiveAudioPreview from './LiveAudioPreview';
import {DEFAULT_PREVIEW_SETTINGS, normalizePreviewSettings, createPreviewAudioGraph, renderPreviewAudio, type PreviewAudioSettings} from './preview-audio';
import {useVoiceSettings} from './VoiceSettings';
import { BrowserPocketEngine } from './voice-engine';
import { loadSavedVoiceProfiles, persistVoiceProfile, deleteVoiceProfile } from './voice-storage';
import type { VoiceProfile, PocketBundle } from './types';
import { createStreamingAudioPlayer, encodePcmChunksAsWav, type Player } from './audio-output';
/** Owns native cloning, synthesis and library controls, sharing one lazy worker per selected model bundle. */
export default function VoiceStudio({
  mode
}: {
  mode: 'clone' | 'tts';
}) {
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [selected, setSelected] = useState('');
  const [bundle, setBundle] = useState<PocketBundle>('english_2026-04');
  const engineBundle = useRef<PocketBundle>();
  const [name, setName] = useState('My voice');
  const [sample, setSample] = useState<Blob>();
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const {storageBusy, setRuntime} = useVoiceSettings();
  const [status, setStatus] = useState('Models download on first use. Select the language used in the reference.');
  const [error, setError] = useState('');
  const [text, setText] = useState('Hello! This is my voice, running entirely in this browser.');
  const [audio, setAudio] = useState('');
  const [previewSettings, setPreviewSettings] = useState<PreviewAudioSettings>({...DEFAULT_PREVIEW_SETTINGS});
  const [generatedClip, setGeneratedClip] = useState<{chunks: Float32Array[]; voiceId: string; generation: GenerationSettings}>();
  const [generationSettings,setGenerationSettings]=useState<GenerationSettings>({...DEFAULT_GENERATION_SETTINGS});
  const [processedClip,setProcessedClip]=useState<Float32Array[]>();
  const [editingAudio,setEditingAudio]=useState(false);
  const audioEditWorker=useRef<Worker>();
  const audioEditVersion=useRef(0);
  const [exportingAudio, setExportingAudio] = useState(false);
  const [previewPlaybackId, setPreviewPlaybackId] = useState(0);
  const previewSettingsRef = useRef(previewSettings); previewSettingsRef.current = previewSettings;
  const downloadUrl = useRef('');
  const engine = useRef<BrowserPocketEngine>();
  const recorder = useRef<MediaRecorder>();
  const media = useRef<MediaStream>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const playback = useRef<{
    context: AudioContext;
    player?: Player;
    outputGraph?: ReturnType<typeof createPreviewAudioGraph>;
  }>();
  // Each operation owns a run ID; cancelled results must not update a newer screen state.
  const run = useRef(0);
  const audioUrl = useRef('');
  const mounted = useRef(true);
  // Settings belong to the selected profile; existing profiles default to neutral sound.
  const selectedDefaults = voices.find(voice => voice.id === selected)?.previewSettings;
  const selectedGenerationDefaults=voices.find(voice=>voice.id===selected)?.generationSettings;
  useEffect(()=>{setGenerationSettings(normalizeGenerationSettings(selectedGenerationDefaults));},[selected,selectedGenerationDefaults]);
  useEffect(() => {setPreviewSettings(normalizePreviewSettings(selectedDefaults));}, [selected, selectedDefaults]);
  // Only speed/pitch replace completed PCM. Tone sliders leave the stable source and playback position untouched.
  useEffect(() => {
    URL.revokeObjectURL(audioUrl.current);audioUrl.current='';setAudio('');setProcessedClip(undefined);
    if(!generatedClip||generatedClip.voiceId!==selected){setEditingAudio(false);return;}
    let current=true;let worker:Worker|undefined;const editVersion=++audioEditVersion.current;setEditingAudio(true);
    const finish=(chunks:Float32Array[])=>{if(!current||editVersion!==audioEditVersion.current)return;const url=URL.createObjectURL(encodePcmChunksAsWav(chunks));audioUrl.current=url;setAudio(url);setProcessedClip(chunks);setEditingAudio(false);};
    const timer=setTimeout(()=>{
      if(!current||editVersion!==audioEditVersion.current)return;
      if(previewSettings.speed===1&&previewSettings.pitchSemitones===0){finish(generatedClip.chunks);return;}
      try {
        worker=new Worker(new URL('./audio-edit.worker.ts',import.meta.url),{type:'module'});
        audioEditWorker.current=worker;
        worker.onmessage=({data})=>{if(data.error){if(current){setError(data.error);setEditingAudio(false);}}else finish([data.pcm]);worker?.terminate();};
        worker.onerror=event=>{if(current){setError(event.message||'Audio editing failed.');setEditingAudio(false);}worker?.terminate();};
        const length=generatedClip.chunks.reduce((n,c)=>n+c.length,0),pcm=new Float32Array(length);let offset=0;
        for(const chunk of generatedClip.chunks){pcm.set(chunk,offset);offset+=chunk.length;}
        worker.postMessage({pcm,speed:previewSettings.speed,pitchSemitones:previewSettings.pitchSemitones},[pcm.buffer]);
      }catch(reason){if(current){setError(String(reason));setEditingAudio(false);}worker?.terminate();}
    },200);
    return()=>{current=false;clearTimeout(timer);worker?.terminate();if(audioEditWorker.current===worker)audioEditWorker.current=undefined;};
  }, [generatedClip,selected,previewSettings.speed,previewSettings.pitchSemitones]);
  // Selecting another voice also stops buffered output from the previous speaker.
  useEffect(() => {stopStreamingPlayback();}, [selected]);
  // Keep sound sliders active while inference streams, without requesting new PCM or restarting playback.
  useEffect(() => {playback.current?.outputGraph?.applySettings(previewSettings, true);}, [previewSettings]);
  // Restore lightweight profiles on mount; loading the library must not download models.
  useEffect(() => {
    mounted.current = true;
    loadSavedVoiceProfiles().then(v => {
      if (mounted.current) {
        setVoices(v);
        setSelected(v[0]?.id || '');
      }
    }).catch(e => setError(String(e)));
    // Unmounting must close microphone tracks, audio nodes, worker memory and object URLs.
    return () => {
      mounted.current = false;
      run.current++;
      void engine.current?.dispose();
      recorder.current?.stop();
      media.current?.getTracks().forEach(t => t.stop());
      clearTimeout(timer.current);
      playback.current?.player?.releasePlaybackResources();
      void playback.current?.context.close();
      URL.revokeObjectURL(audioUrl.current);
      URL.revokeObjectURL(downloadUrl.current);
    };
  }, []);
  // Publish current ownership to global settings; the engine stays mounted while its modal is open.
  const releaseRuntimeRef = useRef(cancelActiveVoiceOperation);
  releaseRuntimeRef.current = cancelActiveVoiceOperation;
  useEffect(() => {
    const runtimeState = engine.current?.getResourceState() || 'not-loaded';
    setRuntime({voices, selectedBundle: mode === 'clone' ? bundle : voices.find(voice => voice.id === selected)?.bundle || bundle,
      activeBundle: runtimeState !== 'not-loaded' ? engineBundle.current : undefined,
      runtimeState, operationBusy: busy || recording || exportingAudio, releaseRuntime: () => releaseRuntimeRef.current()});
  }, [voices, bundle, selected, mode, busy, recording, exportingAudio, status, setRuntime]);
  // Leaving the voice screen already disposes its worker; clear the matching settings snapshot as well.
  useEffect(() => () => setRuntime(null), [setRuntime]);
  /** Reuses the selected bundle worker and releases it before switching model languages. */
  function getOrCreateVoiceEngine(language: PocketBundle = bundle) {
    if (engineBundle.current !== language) {
      void engine.current?.dispose();
      engine.current = undefined;
    }
    engineBundle.current = language;
    return engine.current ||= new BrowserPocketEngine(s => {
      if (mounted.current) setStatus(s);
    }, language);
  }
  /** Invalidates pending UI updates, stops inference and releases the playback audio context. */
  async function cancelActiveVoiceOperation() {
    run.current++;
    audioEditVersion.current++;audioEditWorker.current?.terminate();audioEditWorker.current=undefined;setEditingAudio(false);
    // Remount the replay element so its separate Web Audio context is also released.
    setPreviewPlaybackId(value => value + 1);
    await engine.current?.dispose();
    engine.current = undefined;
    playback.current?.player?.releasePlaybackResources();
    await playback.current?.context.close();
    playback.current = undefined;
    setBusy(false);
    setStatus('Stopped. Ready to retry.');
  }
  /** Encodes an authorized reference and commits its reusable profile before adding it to the library. */
  async function cloneAndSaveVoiceProfile() {
    if (!sample || !consent) return;
    const id = ++run.current;
    setBusy(true);
    setError('');
    try {
      const voice = await getOrCreateVoiceEngine().cloneVoice(sample, {
        name
      });
      if (id !== run.current) return;
      await persistVoiceProfile(voice);
      setVoices(v => [...v, voice]);
      setSelected(voice.id);
      setStatus('Voice saved. Generate a preview below.');
    } catch (e) {
      if (id === run.current) {
        setError(String(e));
        await engine.current?.dispose();
        engine.current = undefined;
      }
    } finally {
      if (id === run.current) setBusy(false);
    }
  }
  /** Captures a short microphone sample and closes microphone tracks when recording finishes. */
  async function startReferenceRecording() {
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw Error('Microphone recording is unavailable. Upload WAV or MP3 instead.');
      media.current = await navigator.mediaDevices.getUserMedia({
        audio: true
      });
      const r = new MediaRecorder(media.current);
      recorder.current = r;
      const parts: Blob[] = [];
      // MediaRecorder can emit multiple fragments; combine them when recording stops.
      r.ondataavailable = e => {
        if (e.data.size) parts.push(e.data);
      };
      // The reference Blob stays local; stop tracks immediately so the mic indicator clears.
      r.onstop = () => {
        clearTimeout(timer.current);
        media.current?.getTracks().forEach(t => t.stop());
        if (mounted.current) {
          setSample(new Blob(parts, {
            type: r.mimeType
          }));
          setRecording(false);
        }
      };
      // Keep capture failures within this panel rather than crashing the workspace.
      r.onerror = () => {
        r.stop();
        setError('Recording failed. Try uploading a reference.');
      };
      r.start();
      setRecording(true);
      timer.current = setTimeout(() => r.stop(), 10000);
    } catch (e) {
      media.current?.getTracks().forEach(t => t.stop());
      setError(String(e));
    }
  }
  /** Streams a saved voice into playback while retaining PCM chunks for a downloadable WAV. */
  async function generateAndPlaySpeech() {
    const voice = voices.find(v => v.id === selected);
    if (!voice) return;
    const id = ++run.current;
    setBusy(true);
    setError('');
    setGeneratedClip(undefined);
    URL.revokeObjectURL(audioUrl.current);
    setAudio('');
    audioUrl.current = '';
    playback.current?.player?.releasePlaybackResources();
    void playback.current?.context.close();
    let context: AudioContext | undefined;
    try {
      context = new AudioContext({
        sampleRate: 24000
      });
      playback.current = {
        context
      };
      await context.resume();
      const outputGraph = createPreviewAudioGraph(context, previewSettingsRef.current);
      const player = await createStreamingAudioPlayer(context, outputGraph.input);
      if (id !== run.current) {
        player.releasePlaybackResources();
        return;
      }
      outputGraph.applySettings(previewSettingsRef.current);
      playback.current = {context, player, outputGraph};
      // Retain a bounded copy for WAV export while the same samples stream to the worklet.
      const chunks: Float32Array[] = [];
      let samples = 0;
      for await (const chunk of getOrCreateVoiceEngine(voice.bundle).synthesize(text, {...voice,generationSettings})) {
        if (id !== run.current) return;
        samples += chunk.length;
        if (samples > 24000 * 180) throw Error('Three-minute output limit reached. Generate shorter passages.');
        chunks.push(chunk);
        if(previewSettingsRef.current.speed===1&&previewSettingsRef.current.pitchSemitones===0)player.enqueueAudioChunk(chunk);
      }
      player.finishAudioStream();
      if (id !== run.current) return;
      setGeneratedClip({chunks, voiceId:voice.id,generation:{...generationSettings}});
      setStatus('Generated locally. Adjust Preview settings, replay, or download WAV.');
    } catch (e) {
      if (id === run.current) {
        setError(String(e));
        await engine.current?.dispose();
        engine.current = undefined;
        playback.current?.player?.releasePlaybackResources();
        await context?.close();
        playback.current = undefined;
      }
    } finally {
      if (id === run.current) setBusy(false);
    }
  }
  /** Stops the original streamed output before replaying the completed clip, avoiding two simultaneous voices. */
  function stopStreamingPlayback() {
    playback.current?.player?.releasePlaybackResources();
    void playback.current?.context.close();
    playback.current = undefined;
  }
  /** Bakes a snapshot of current sound controls only on export, keeping live slider changes lightweight. */
  async function downloadProcessedAudio() {
    if (!generatedClip || !processedClip || generatedClip.voiceId !== selected || exportingAudio) return;
    const operation = run.current;
    const settings = normalizePreviewSettings(previewSettingsRef.current);
    setExportingAudio(true); setError('');
    try {
      const chunks = await renderPreviewAudio(processedClip, settings);
      if (!mounted.current || operation !== run.current) return;
      URL.revokeObjectURL(downloadUrl.current);
      const url = URL.createObjectURL(encodePcmChunksAsWav(chunks)); downloadUrl.current = url;
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'voice-studio.wav'; anchor.click();
    } catch (reason) {if (mounted.current) setError(String(reason));}
    finally {if (mounted.current) setExportingAudio(false);}
  }
  /** Saves only sound defaults; the speaker embedding and profile identity are unchanged. */
  async function saveVoicePreviewDefaults() {
    const voice = voices.find(item => item.id === selected); if (!voice) return;
    setBusy(true);
    try {
      const updated = {...voice, previewSettings:normalizePreviewSettings(previewSettings),generationSettings:normalizeGenerationSettings(generationSettings)};
      await persistVoiceProfile(updated);
      setVoices(items => items.map(item => item.id === selected ? updated : item));
      setStatus('Preview defaults saved for this voice.');
    } catch (reason) {setError(String(reason));}
    finally {setBusy(false);}
  }
  /** Persists a new display name while preserving the existing voice identity and embedding. */
  async function renameSavedVoiceProfile(voice: VoiceProfile) {
    const next = prompt('Voice name', voice.name)?.trim();
    if (!next) return;
    try {
      const updated = {
        ...voice,
        name: next
      };
      await persistVoiceProfile(updated);
      setVoices(v => v.map(x => x.id === voice.id ? updated : x));
    } catch (e) {
      setError(String(e));
    }
  }
  /** Removes a stored profile and selects another voice when the active one is deleted. */
  async function deleteSavedVoiceProfile(voice: VoiceProfile) {
    try {
      await deleteVoiceProfile(voice.id);
      setVoices(v => v.filter(x => x.id !== voice.id));
      if (selected === voice.id) setSelected(voices.find(v => v.id !== voice.id)?.id || '');
    } catch (e) {
      setError(String(e));
    }
  }
  return <>
    {mode === 'clone' && <div className="panel"><div className="panelhead"><h2>Clone a voice</h2><span className="pill">Local ONNX / WASM</span></div>
      <p className="muted">Use a clean 3–30 second reference (first 10 seconds used). Models can require substantial memory and several hundred MB of downloads.</p>
      <label className="consent"><input type="checkbox" checked={consent} disabled={busy || storageBusy || exportingAudio} onChange={e => setConsent(e.target.checked)} /> I own this voice or have permission to clone it.</label>
      <label>Model language<select value={bundle} disabled={busy || storageBusy || exportingAudio || recording} onChange={e => setBundle(e.target.value as PocketBundle)}>{['english_2026-04', 'german', 'italian', 'portuguese', 'spanish'].map(b => <option key={b}>{b}</option>)}</select></label><div className="controls"><label>Voice name<input value={name} disabled={busy || storageBusy || exportingAudio} onChange={e => setName(e.target.value)} /></label><label>Reference WAV / MP3<input type="file" accept="audio/*,.wav,.mp3" disabled={busy || storageBusy || exportingAudio || recording} onChange={e => setSample(e.target.files?.[0])} /></label></div>
      <div className="actions"><button disabled={busy || storageBusy || exportingAudio} onClick={recording ? () => recorder.current?.stop() : startReferenceRecording}>{recording ? 'Stop recording' : 'Record up to 10 seconds'}</button><button disabled={!sample || !consent || busy || storageBusy || exportingAudio || recording} onClick={cloneAndSaveVoiceProfile}>Clone and save</button></div>
      {sample && <p className="muted">Reference ready · {(sample.size / 1024).toFixed(0)} KB</p>}
    </div>}
    <div className="panel"><div className="panelhead"><h2>{mode === 'clone' ? 'Preview a saved voice' : 'Cloned voice text to speech'}</h2><span className="pill">Local models · no Hindi</span></div>
      <label>Saved voice<select value={selected} disabled={busy || storageBusy || exportingAudio} onChange={e => setSelected(e.target.value)}><option value="">Choose a voice</option>{voices.map(v => <option key={v.id} value={v.id}>{v.name} · {v.bundle}</option>)}</select></label>
      <label>Text<textarea value={text} disabled={busy || storageBusy || exportingAudio} onChange={e => setText(e.target.value)} rows={4} maxLength={4000} /></label>
      <PreviewSettings value={previewSettings} generation={generationSettings} generating={busy} onGenerationChange={setGenerationSettings} disabled={storageBusy || exportingAudio || recording} canSave={!!selected && !busy} onChange={setPreviewSettings} onSave={() => void saveVoicePreviewDefaults()}/>
      <div className="actions"><button disabled={!selected || busy || storageBusy || exportingAudio || editingAudio || recording || !text.trim()} onClick={generateAndPlaySpeech}>Generate speech</button><button onClick={() => void cancelActiveVoiceOperation()}>Stop / release engine</button></div>
      <p role="status" className="muted">{status}</p>{busy && <progress aria-label="Inference in progress" />}
      {(previewSettings.speed!==1||previewSettings.pitchSemitones!==0) && <p className="muted">Speed/pitch editing applies after generation; live streaming playback is paused for these settings.</p>}
      {editingAudio && <p className="muted" role="status">Processing speed / pitch…</p>}
      {generatedClip && (generatedClip.generation.temperature!==generationSettings.temperature||generatedClip.generation.samplingSteps!==generationSettings.samplingSteps) && <p className="muted">Generation settings changed. Generate speech again to apply them.</p>}
      {exportingAudio && <p role="status" className="muted">Preparing WAV download…</p>}
      {audio && <div className="actions"><LiveAudioPreview key={`${audio}:${previewPlaybackId}`} src={audio} settings={previewSettings} onPlaybackStart={stopStreamingPlayback} onError={setError}/><button disabled={exportingAudio || busy || storageBusy} onClick={() => void downloadProcessedAudio()}>Download WAV</button></div>}
    </div>
    <div className="panel"><h3>Saved Voices</h3>{!voices.length && <p className="muted">Clone a voice to save it on this device.</p>}{voices.map(v => <div className="voice-library-row" key={v.id}>
      <strong className="voice-library-name">{v.name}</strong>
      <div className="actions voice-library-actions" role="group" aria-label={`Actions for ${v.name}`}>
        <button disabled={busy || storageBusy || exportingAudio} aria-pressed={selected === v.id} onClick={() => setSelected(v.id)}>{selected === v.id ? 'Selected' : 'Select'}</button>
        <button disabled={busy || storageBusy || exportingAudio} onClick={() => void renameSavedVoiceProfile(v)}>Rename</button>
        <button disabled={busy || storageBusy || exportingAudio} onClick={() => void deleteSavedVoiceProfile(v)}>Delete</button>
      </div>
    </div>)}</div>
    <div className="notice">Hindi / Hinglish cloning is unsupported. Safari uses reduced-memory settings; devices that cannot load WASM models will show an error. No remote inference fallback. <a href={`${import.meta.env.BASE_URL}licenses.html`} target="_blank" rel="noreferrer">Third-party licenses</a></div>
    {error && <div className="notice" role="alert">{error}</div>}
  </>;
}
