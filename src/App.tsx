/** Application shell for dictation, native voice cloning and device speech synthesis. */
import VoiceStudio from './voices/VoiceStudio';
import {VoiceSettingsProvider, VoiceSettingsButton} from './voices/VoiceSettings';
import React, { useEffect, useRef, useState } from 'react';
import { Mic, AudioLines, Volume2, Settings, Square, Play, Download, Copy, AlertTriangle, ExternalLink, Globe2, Check, Trash2 } from 'lucide-react';
type Mode = 'dictation' | 'clone' | 'tts';
type Transcript = {
  id: number;
  text: string;
  lang: string;
  at: number;
};
type RecResult = {
  isFinal: boolean;
  [index: number]: {
    transcript: string;
  };
};
type RecEvent = {
  resultIndex: number;
  results: ArrayLike<RecResult>;
};
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: {
    error: string;
  }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionCtor = new () => Recognition;
/** Finds the browser-specific speech-recognition constructor so unsupported browsers can fail clearly. */
const getSpeechCtor = (): SpeechRecognitionCtor | undefined => {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
};
const languageOptions = [{
  code: 'hi-IN',
  label: 'Hindi'
}, {
  code: 'en-IN',
  label: 'Indian English'
}, {
  code: 'en-US',
  label: 'English (US)'
}];
const initialText = 'नमस्ते! मैं हिंदी और English दोनों में बोल सकता हूँ।';
/** Coordinates workspace tabs and the existing browser dictation and device-TTS adapters. */
export default function App() {
  const [mode, setMode] = useState<Mode>('dictation');
  const [language, setLanguage] = useState('hi-IN');
  const [text, setText] = useState(initialText);
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [history, setHistory] = useState<Transcript[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('vs-history') || '[]');
    } catch {
      return [];
    }
  });
  const recRef = useRef<Recognition | null>(null);
  const accumulatedRef = useRef('');
  // Keep only recent finalized dictation segments across normal page refreshes.
  useEffect(() => {
    localStorage.setItem('vs-history', JSON.stringify(history.slice(-30)));
  }, [history]);
  useEffect(() => {
    const load = () => setVoices(window.speechSynthesis?.getVoices() || []);
    load();
    window.speechSynthesis?.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis?.removeEventListener('voiceschanged', load);
  }, []);
  useEffect(() => () => {
    recRef.current?.stop();
    window.speechSynthesis?.cancel();
  }, []);
  /** Ends dictation and clears interim text without discarding the editable transcript. */
  function stopRecording() {
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
    setInterim('');
  }
  /** Appends final recognition segments to the transcript and history while showing interim speech separately. */
  function startRecording() {
    const C = getSpeechCtor();
    if (!C) {
      setError('This browser does not expose SpeechRecognition. Install a local Whisper adapter to support this browser offline.');
      return;
    }
    setError('');
    const rec = new C();
    rec.lang = language;
    rec.continuous = true;
    rec.interimResults = true;
    accumulatedRef.current = '';
    rec.onresult = e => {
      let final = '',
        temp = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript + ' ';else temp += r[0].transcript;
      }
      if (final.trim()) {
        accumulatedRef.current += final;
        setText(prev => prev + (prev.trim() ? ' ' : '') + final.trim());
        setHistory(prev => [...prev, {
          id: Date.now() + Math.random(),
          text: final.trim(),
          lang: language,
          at: Date.now()
        }]);
      }
      setInterim(temp);
    };
    rec.onerror = e => {
      setError('Recognition error: ' + e.error + '. Some browsers use an online speech service.');
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') stopRecording();
    };
    rec.onend = () => {
      setListening(false);
      setInterim('');
      recRef.current = null;
    };
    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
    } catch (e) {
      setError(String(e));
    }
  }
  /** Speaks the editor text with the selected device voice; cloned speech uses VoiceStudio instead. */
  function synthesize() {
    if (!text.trim()) return;
    const engine = window.speechSynthesis;
    if (!engine) {
      setError('Speech synthesis is unavailable in this browser.');
      return;
    }
    engine.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const chosen = voices.find(x => x.voiceURI === voiceId);
    if (chosen) u.voice = chosen;
    u.lang = chosen?.lang || language;
    u.rate = 1;
    u.pitch = 1;
    u.onend = () => setSpeaking(false);
    u.onerror = e => {
      setSpeaking(false);
      setError('Playback failed: ' + e.error);
    };
    setSpeaking(true);
    engine.speak(u);
  }
  /** Exports the editable transcript as a local text file and releases its temporary download URL. */
  const downloadText = () => {
    const url = URL.createObjectURL(new Blob([text], {
      type: 'text/plain;charset=utf-8'
    }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'voice-studio-transcript.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  };
  return <VoiceSettingsProvider><div className="app"><aside className="sidebar"><div className="brand"><span className="brandicon"><AudioLines size={22} /></span><div><strong>Voice Studio</strong><small>Local-first workspace</small></div></div><div className="navlabel">WORKSPACE</div><button className={'nav ' + (mode === 'dictation' ? 'selected' : '')} onClick={() => setMode('dictation')}><Mic size={18} />Dictation</button><button className={'nav ' + (mode === 'clone' ? 'selected' : '')} onClick={() => setMode('clone')}><AudioLines size={18} />Clone Voice</button><button className={'nav ' + (mode === 'tts' ? 'selected' : '')} onClick={() => setMode('tts')}><Volume2 size={18} />Text to Speech</button><div className="sidebarBottom"><span className="pill"><span className="dot" /> No paid APIs</span><p>Models run in your browser where supported. Browser speech APIs may use provider servers.</p></div></aside><main><header><div className="crumb">WORKSPACE <span>/</span> {mode === 'dictation' ? 'DICTATION' : mode === 'clone' ? 'VOICE CLONING' : 'TEXT TO SPEECH'}</div><div className="headright"><Globe2 size={16} /> Browser-first <span className="status">MVP 0.1</span><VoiceSettingsButton/></div></header><div className="content"><div className="headline"><h1>{mode === 'dictation' ? 'Speak naturally. Capture every word.' : mode === 'clone' ? 'Your voice, recreated.' : 'Give your words a voice.'}</h1><p>{mode === 'dictation' ? 'Dictate in Hindi or English. Edit, save, and export text.' : mode === 'clone' ? 'Create a reusable voice profile from an authorized recording, entirely on your device.' : 'Speak typed text using the voices available in your browser.'}</p></div>
 {mode === 'dictation' ? <><div className="panel"><div className="panelhead"><h2>Live dictation</h2><span className="pill">Web Speech adapter</span></div><div className="controls"><label>Recognition language<select value={language} onChange={e => setLanguage(e.target.value)} disabled={listening}>{languageOptions.map(l => <option value={l.code} key={l.code}>{l.label}</option>)}</select></label><button className={'primary ' + (listening ? 'stop' : '')} onClick={listening ? stopRecording : startRecording}>{listening ? <Square size={16} /> : <Mic size={16} />} {listening ? 'Stop recording' : 'Start dictation'}</button></div><div className="editorWrap"><textarea aria-label="Transcript editor" value={text} onChange={e => setText(e.target.value)} placeholder="Your transcript will appear here…" rows={9} />{interim && <div className="interim">Listening: {interim}</div>}</div><div className="actions"><button onClick={() => navigator.clipboard.writeText(text)}><Copy size={15} /> Copy</button><button onClick={downloadText}><Download size={15} /> Export .txt</button><button onClick={() => setText('')}><Trash2 size={15} /> Clear</button></div></div><div className="notice"><AlertTriangle size={18} /><div><b>Multilingual limitation in this MVP</b><p>Language selection works when the browser supports that language. Hinglish auto code-switching and guaranteed offline transcription require a local multilingual Whisper engine, which is not bundled yet.</p></div></div><div className="panel secondary"><h3>Recent segments <span className="muted">({history.length})</span></h3>{history.length ? history.slice(-5).reverse().map(h => <div key={h.id} className="segment">{h.text}<span>{new Date(h.at).toLocaleTimeString()}</span></div>) : <p className="muted">Recorded segments will appear here.</p>}</div></> : mode === 'clone' ? <VoiceStudio mode="clone" /> : <><VoiceStudio mode="tts" /><div className="panel"><div className="panelhead"><h2>Browser text to speech</h2><span className="pill">SpeechSynthesis</span></div><label>Text to speak<textarea value={text} onChange={e => setText(e.target.value)} rows={8} /></label><div className="controls"><label>Voice<select value={voiceId} onChange={e => setVoiceId(e.target.value)}><option value="">System default ({language})</option>{voices.map(v => <option key={v.voiceURI} value={v.voiceURI}>{v.name} · {v.lang}{v.localService ? ' · local' : ''}</option>)}</select></label><button className="primary" onClick={speaking ? () => {
                window.speechSynthesis.cancel();
                setSpeaking(false);
              } : synthesize}>{speaking ? <Square size={16} /> : <Play size={16} />} {speaking ? 'Stop' : 'Speak text'}</button></div><div className="actions"><button onClick={() => setMode('clone')}><AudioLines size={15} /> Open cloned voice studio</button></div></div><div className="notice"><AlertTriangle size={18} /><div><b>Separate voice engines</b><p>This panel uses browser/device TTS, not a cloned speaker. Select a saved cloned voice in the local synthesis panel above. Hindi neural cloning is unsupported.</p></div></div></>}{error && <div className="error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}<footer>VOICE STUDIO · 0.1 MVP <span>Static web application · no required backend · <a href={`${import.meta.env.BASE_URL}licenses.html`}>Licenses</a></span></footer></div></main></div></VoiceSettingsProvider>;
}
