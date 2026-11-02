# Native Pocket TTS architecture

```text
React VoiceStudio
  → TypeScript BrowserPocketEngine
  → classic dedicated Browser Worker
  → ONNX Runtime Web / WASM
  → versioned model downloads / Cache Storage
  → streamed Float32 PCM → AudioWorklet → speakers
                         → WAV encoding → local download
```

`src/App.tsx` retains dictation and device TTS. `src/voices/VoiceStudio.tsx` supplies native cloning, microphone capture, profile selection and library management using the existing CSS design system. It owns the engine and playback lifecycle. No model startup work occurs on application load.

`src/voices/voice-engine.ts` exposes `PocketTTSEngine` from `types.ts`. A bundle can be selected in the concrete adapter constructor. One operation runs at a time. Audio is decoded locally, validated and rendered through a mono 24 kHz OfflineAudioContext. The worker encodes reference audio and returns its Float32 embedding/shape. Profile storage uses structured cloning in IndexedDB (`voice-storage.ts`), committing before the UI reports a saved voice. The adapter restores embeddings for generation and reuses the currently conditioned voice. Errors reach React without replacing the entire app. Cancellation terminates the worker; this also interrupts pending downloads and reclaims its WASM resources.

`public/audio-runtime/speech-inference.worker.js` preserves upstream tensor names, shape manifests, conditioning, chunked text, autoregressive state, flow matching and Mimi streaming. It stays JavaScript because a speculative low-level TypeScript rewrite would add risk. The TypeScript adapter is its typed public boundary. Upstream pages, CSS, controller, demo speakers, imagery and main-thread shim are excluded. `sentencepiece-tokenizer.js` embeds its own WASM binary; no separate tokenizer WASM asset is required. `src/voices/playback/pcm-stream-player.js` imports its companion `event-emitter.js`. These imported modules live in source so Vite transforms them in development and bundles them for production; only the classic worker and its importScripts dependencies remain in public. The worklet has an explicit disposal method and starts a final short stream even below the normal buffering threshold.

`model-manifest.js` pins a Hugging Face distribution commit and ORT runtime version. English approximate sizes are known from its listing; other bundle sizes require inspection. File hashes are explicitly unknown. `model-cache.js` reports bytes, caches only fully downloaded responses and evicts a model after failed session creation to allow recovery. Cache failure does not prevent inference if sufficient memory remains. There is no cross-origin isolation requirement for the default single-thread path; isolated hosts may enable worker threads on desktop. CDN model/runtime access is required on first use.

Generation output is bounded by UI text/output limits. Worklet buffering supports backpressure internally. Model sessions are loaded sequentially to reduce peak memory. Completed sessions stay in the worker for reuse until stop, unmount or error. Long-run native browser memory behavior has not yet been measured.

Existing embedded-app IndexedDB databases are untouched. No automatic migration is provided; new profiles use the Voice Studio database.

For a file-by-file reading order and function naming conventions, see [the code guide](code-guide.md).

## Storage ownership and cleanup

`src/voices/model-storage.ts` inventories only caches named with the existing `voice-studio-pocket-` ownership prefix, including older versions. `ModelStoragePanel.tsx` groups cached files by bundle and cache version, shows their sizes and profile usage, and offers file, bundle, unused-bundle and full model-cache cleanup. Destructive actions require an explicit in-panel confirmation and release the worker before deleting. Profile IndexedDB stores and unrelated origin caches are not touched. Origin quota is labeled as an estimate covering the entire origin, rather than app-only or per-model RAM.

New downloads record their actual byte count in a cache-response header. Legacy entries are measured by reading chunks without collecting a model-sized buffer. The storage panel never downloads assets merely to inspect them. The adapter's `getResourceState()` exposes loading/ready/not-loaded ownership; the browser's actual WASM heap size remains unmeasured. Controls are locked during inference, recording and storage operations to prevent this tab from writing new cache entries during deletion. Other tabs remain browser-isolated and may repopulate caches; the UI explains this limitation.

`VoiceSettings.tsx` provides a global header gear and native `<dialog>` modal with focus containment, backdrop/Escape dismissal, scroll locking and trigger-focus restoration. The voice screen reports its live runtime state through context while retaining engine ownership, so opening settings does not stop playback or lose the reference/text. On dictation, settings can inspect saved profiles and model downloads without mounting the voice engine. Cache inspection runs only when settings is open. Storage-operation locks are shared with voice controls, and unmounting the voice screen clears its runtime snapshot.

## Preview sound processing

`PreviewSettings.tsx` places per-voice sound controls alongside the synthesis preview. `preview-audio.ts` validates settings and builds a shared Web Audio graph (high-pass, low shelf, high shelf and gain) for live streaming and OfflineAudioContext WAV rendering. The player accepts an optional output destination so it can feed that graph without duplicating inference logic. Voice profiles have optional `previewSettings`; absent fields retain neutral defaults without a schema migration. The screen retains at most one bounded raw generated clip. `LiveAudioPreview.tsx` creates one MediaElementAudioSource per replay element on its first user play gesture. Slider changes update the existing filter AudioParams with short ramps, leaving the raw WAV URL, media source and playback position intact. Streamed inference output receives the same live settings. Offline rendering runs only on explicit WAV export, using a settings snapshot. Replaying a completed clip stops its original stream to avoid overlapping audio. Stop/release remounts the lazy replay element to close its separate context as well. Old output URLs are revoked on replacement and unmount. Preview/export parameter changes do not rerun ONNX or alter conditioning embeddings.

Advanced preview DSP adds peaking EQ, parallel split-band high-frequency compression, optional broadband compression, deterministic convolution reverb and a bounded WaveShaper peak clamp. New fields are normalized to neutral defaults for older profiles. `audio-time-stretch.ts` performs bounded WSOLA/resampling in `audio-edit.worker.ts`; only speed/pitch replace completed PCM. Worker replacement, Stop and unmount terminate editing. Exports use the already time/pitch-edited PCM and apply the same fixed DSP settings, including room tail. `generation-settings.ts` normalizes per-profile temperature and flow-step defaults; the adapter forwards them with each generation command, and the inference worker bounds them again and rebuilds its flow integration tensors. These controls never modify stored speaker embeddings.
