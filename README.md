# Voice Studio

**[Open the live demo →](https://dibyanshusinha.github.io/voice-studio-web/)**

React + TypeScript speech workspace with native browser-worker Pocket TTS inference. No second application, iframe, repository download, backend, API key, or paid inference service is required.

```bash
npm install
npm run dev
npm run build
```

Node.js 20+ recommended. Serve `dist/` on a static HTTPS host. Microphone and AudioWorklet require HTTPS or localhost. `npm test` runs protocol/cache/audio regression tests; `npm run check` checks required files.

## Using cloned voices

1. Open **Clone Voice**, confirm speaker permission and select the reference language.
2. Upload WAV/MP3 (or another browser-decodable audio format), or record up to ten seconds.
3. Name the voice and choose **Clone and save**. References must be 3–30 seconds and under 25 MB; the first ten seconds are downmixed and resampled to 24 kHz.
4. Preview new text or open **Text to Speech** and select a saved voice.
5. Generate, stop, replay or download the output as WAV. Rename/delete profiles in the Saved Voices.

Profiles contain reusable encoder embeddings in IndexedDB, not uploaded recordings. They stay on this origin/device and survive normal refreshes. Clearing browser site data removes them. Previous embedded-app databases are not deleted or automatically migrated.

## Models and storage

Only clone/generate initializes Pocket TTS. The worker uses ONNX Runtime Web 1.18.0 WASM, the upstream SentencePiece tokenizer, Flow LM and Mimi encoder/decoder. The encoder loads only for cloning. Five upstream language bundles remain selectable: English, German, Italian, Portuguese and Spanish. **Hindi/Hinglish cloning and synthesis are unsupported**, including romanized Hinglish quality.

Versioned model URLs and approximate sizes are recorded in [the model manifest](public/audio-runtime/model-manifest.js). The English bundle requires about 146 MB including its encoder, plus runtime/tokenizer and inference memory. Other bundle sizes may differ. Models are not committed to this repository. Downloads show received bytes and totals when available, and completed assets enter Cache Storage. Interrupted assets are never cached; retry re-downloads that file while reusing completed files. Quota failures permit uncached execution with a visible status message. Browser eviction and private mode can prevent persistence. Runtime CDN files also depend on browser HTTP caching; a completely offline application install is not provided.

**Stop / release engine** terminates the worker, cancels its downloads/inference and releases its WASM heap. It also closes the playback context. A later operation creates a new worker and reuses cached weights. There is no remote inference fallback.

## Existing speech adapters

Hindi/English Web Speech Recognition dictation and device SpeechSynthesis are retained. These browser services may use remote processing. Therefore **the full application is not guaranteed offline or entirely local**: only the Pocket cloning/synthesis pipeline is local. Local multilingual Whisper STT is not implemented.

## Verification status

TypeScript/production build and automated unit/regression tests pass. These exercise the actual cache and worklet logic and an adapter with a simulated worker protocol; they do **not** establish successful ONNX inference or voice quality.

In this development sandbox, local server bindings are denied (`EPERM` on both all-interface and loopback hosts) and shell DNS access to model hosts fails. Chrome, a second browser, real upload-to-clone inference, audible output, browser refresh persistence and sustained memory measurements remain **unverified**. Do not treat this revision as having passed the end-to-end acceptance criteria. See [validation details](build/docs/validation.md).

Safari/iOS reduced-memory settings are retained (single-thread, SIMD disabled, no ORT proxy, arena/pattern/graph optimizations disabled). Model sessions load sequentially and SentencePiece initializes after model loading. The upstream main-thread shim is intentionally excluded: inference always stays in a Worker. Safari versions/devices unable to execute this worker path show an error rather than falling back to main-thread or remote inference. Physical iOS testing remains required.

See [architecture](build/docs/architecture.md) and [license page](public/licenses.html).

For source responsibilities and function naming, start with the [code guide](build/docs/code-guide.md).

## License

Copyright (c) 2026 Dibyanshu Sinha.

Voice Studio application code is licensed under the [GNU General Public License v3.0 only](LICENSE) (`GPL-3.0-only`). You may redistribute and modify it under those terms. It is provided without warranty.

Third-party components retain their original licenses and copyright notices. Downloaded model weights retain their separate model licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) and the [license page](public/licenses.html).

## Manage model storage

Open the **Settings gear in the top-right header** from any workspace tab. The **Models & storage** panel in its modal lists downloaded files by language bundle and cache version, including file sizes and which bundles are used by saved voices. Expand a bundle to remove an individual file, such as the reference encoder used only for cloning. You can also remove a whole bundle, remove bundles unused by saved voices/current selection, or clear all Voice Studio model downloads. Removal asks for confirmation and releases this tab's worker first; missing files download again when needed. Saved voice profiles are retained.

**Release model memory** terminates the loaded inference worker and playback resources while keeping downloaded models on disk. The panel reports loading/ready/released state; browsers do not expose reliable per-model RAM measurements. The whole-site usage/quota estimate includes IndexedDB and other origin data. Browser-managed HTTP cache for runtime CDN files is outside these controls. Close other active Voice Studio tabs before cleanup so they cannot recreate a removed cache.

## Preview sound settings

The cloned-voice preview includes volume, bass/warmth, treble/brightness and optional low-frequency cleanup. Generate once, play the preview and adjust the sound live without restarting playback or another model call. Sound controls also work during streamed generation. The WAV download renders a snapshot of the current settings through the same filter chain only when you click Download WAV. **Save defaults for this voice** stores those settings with the profile without changing its speaker embedding; **Reset sound** restores neutral controls (save again to make that reset persistent). Older profiles use neutral defaults. EQ boosts reserve output headroom to reduce distortion. These controls shape sound and do not provide model-level emotion, identity changes or full noise removal.

Advanced preview controls now include midrange/presence EQ, compression, split-band de-essing, synthetic room reverb and a final peak limiter. Tone/dynamics apply live; speed and pitch run a cancellable completed-clip worker and restart the completed preview. The modest speed/pitch ranges use WSOLA plus resampling and can introduce artifacts. Variation and flow sampling steps alter the next model generation. Each control has a hover/focus/tap info tooltip specifying whether it applies live, requires audio reprocessing, or **will require regeneration**. Defaults for both sound and sampling can be saved with the voice.

Creating a genuinely new speaker from gender/accent descriptions is not currently implemented. See the [voice-design assessment](build/docs/voice-design-research.md) for the separate browser-runtime requirements; choosing an existing preset is not equivalent to generating a new identity.

## GitHub Pages deployment

The repository uses one **Build and deploy** job in `.github/workflows/deploy-pages.yml` to test, build and publish the static app on pushes to `main`, or manually from the Actions tab. GitHub repository **Settings → Pages → Source** must be **GitHub Actions**. The Pages site URL is `https://dibyanshusinha.github.io/voice-studio-web/` after a successful deployment.

Vite emits relative asset URLs so the same build works at a repository subpath or a domain root. The web manifest also uses a relative start URL and scope. `node scripts/check-pages-build.mjs` checks the built entry assets, static inference worker, bundled audio editor, manifest and license links before CI uploads `dist/`. Only the static app is published; model weights still load directly from upstream on demand. GitHub Pages HTTPS supports microphone/AudioWorklet secure contexts; no custom server is required. This deployment does not provide cross-origin-isolation headers, so the existing ONNX runtime normally uses its single-thread path.
