# Validation — 2026-11-01

## Executed

- `npm install --offline`: passed using the local npm cache; no repository download or install hook.
- `npm run build`: passed, including strict TypeScript checking and Vite production output.
- `npm run check`: passed.
- `npm test`: 10 passing tests in the regression suite for adapter stream/reuse/disposal, explicit Hindi rejection, actual worker boot/early errors, complete cache reuse, interrupted download exclusion, WAV format and short-stream AudioWorklet completion, removal of embedded-app integration, consumer cancellation and actual embedded tokenizer WASM initialization. Adapter tests simulate messages; no fake inference is shipped.

## Environment blockers

`npm run dev` could not bind `0.0.0.0:5173` (`EPERM`). Retrying with `--host 127.0.0.1` also failed with `EPERM`. Shell requests to GitHub/Hugging Face failed DNS resolution. Browser tooling inventory exposed Chrome but no connected browser sessions; without a reachable application server, browser execution was not possible. Public upstream metadata was inspected through the web research tool.

## Acceptance items still requiring browser/device testing

| Item | Status |
| --- | --- |
| Chrome native UI and actual ONNX sessions | Unverified |
| Safari or Firefox UI and actual ONNX sessions | Unverified |
| Authorized WAV/MP3 upload → reusable embedding | Implemented; live inference unverified |
| Microphone capture and codec decoding | Implemented; hardware unverified |
| Audible cloned speech and downloadable WAV | Implemented; audibility/inference unverified |
| IndexedDB persistence after refresh, rename/delete | Implemented; browser persistence unverified |
| Cancellation during download/encoding/generation | Logic tested in part; browser unverified |
| Repeated generation and memory plateau | Unverified |
| Network outage, quota exhaustion, memory failure | Recovery implemented; browser fault injection unverified |
| Hindi/Hinglish cloned synthesis | Unsupported |
| Fully local Hindi/English STT | Unsupported; existing Web Speech adapter retained |

## Manual release procedure

On an unrestricted machine, install, start the app and open Chrome and Safari/Firefox on localhost. Confirm no iframe or second-app requests. Confirm that opening dictation/cloning without starting a task downloads no weights. Use an authorized 5–10 second recording, clone it and synthesize different text. Listen, replay and download WAV; inspect the downloaded duration/sample rate. Refresh and select, rename and delete a disposable profile. Repeat ten generations and measure worker/WASM heap plus AudioContext count. Stop during model download and generation, then retry; ensure completed cache entries survive while partial files do not. Repeat offline with cached weights, noting runtime HTTP cache requirements. Test quota denial and invalid/silent references.

On a physical iPhone/iPad, verify AudioContext unlock from the Generate user gesture, MediaRecorder codec decoding, worker-only ORT loading, sequential low-memory session creation, resampling and short-stream playback. If model execution fails, ensure an error appears and Stop/retry remains usable. Do not claim iOS support based only on user-agent settings.

## Model-storage controls

The regression suite now has 15 passing tests. Storage tests cover legacy/new byte accounting, discovery of old model-cache versions, per-file removal retaining sibling files, clearing only owned model caches, rejecting unrelated-cache requests before mutations, and unavailable Cache Storage. Cache tests verify the recorded actual byte count. TypeScript and production builds pass. Physical-browser UI interaction, quota behavior and observed RAM reclamation remain unverified in this sandbox; releasing memory here means terminating the owning worker, not a measured RAM total.

## Preview sound settings

The suite now has 18 passing tests. New sound tests cover legacy-profile neutral defaults, bounded/invalid settings, allocation-free neutral output, filter routing and EQ boost headroom. Production/TypeScript builds pass. Browser listening checks for the shaped preview and exported WAV remain to be performed; automated node tests verify configuration and graph wiring, not subjective audio quality.

## Live preview controls

The suite now has 19 passing tests. The live-preview component regression verifies a stable original source URL and playback position across slider updates, a single media-source connection across repeat playback, live EQ automation and audio-context cleanup. This uses a controlled React/Web Audio harness rather than a physical browser. Production/TypeScript builds pass. Browser listening/gesture verification, including iOS Safari, remains unverified in this sandbox.

Advanced settings: 21 tests pass, including actual time-stretch/resampling numerical checks on a sine signal, generation-setting bounds, advanced filter/dynamics/limiter configuration and live-source reuse. Production/TypeScript builds pass. New audio effects, speed/pitch speech naturalness and variable-flow-step inference still require browser/listening validation. Voice-by-description remains research-only; no synthesis capability is claimed for it.
