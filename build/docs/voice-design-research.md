# Reference-free voice design assessment

Requested behavior: create a genuinely new speaker from gender/accent/style descriptions, randomize candidates, preview and save a reusable local voice. This is distinct from randomly choosing existing preset speakers.

The current Pocket adapter requires a reference embedding or an upstream predefined speaker state. Sampling temperature changes delivery, not the speaker identity. Randomizing its speaker tensors or using pitch as a gender/accent substitute would not implement the requested feature.

Candidate: Qwen3-TTS VoiceDesign supports voice descriptions. Primary sources:

- https://github.com/QwenLM/Qwen3-TTS
- https://huggingface.co/wavekat/Qwen3-TTS-1.7B-VoiceDesign-ONNX
- https://huggingface.co/onnx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign

The reviewed exports identify Apache-2.0 licensing. Their published examples use Python/native ONNX runtimes, not a validated browser adapter. Export availability does not establish ONNX Runtime Web operator support, WebGPU suitability, working memory bounds or Safari execution. The model has separate embedding construction, talker LM, code predictor and codec stages. A single file cannot replace the Pocket worker. Repository-wide sizes include multiple precision/provider variants and must not be presented as the browser download requirement.

Before enabling a Voice Design UI, select and pin a browser-executable variant, implement the tokenizer and autoregressive cache protocol in a separate lazy worker, verify export licenses and exact assets, benchmark download/runtime memory and cancellation, and test actual gender/accent instruction adherence. Unsupported browsers must fail explicitly. No Python backend, paid endpoint or remote inference fallback is authorized by this architecture.

A successful design sample could then be passed through the existing Mimi reference encoder to save a Pocket-compatible profile for later use. Its identity consistency and accent transfer would require actual listening tests. Built-in speaker presets are a separate possible no-upload feature; they must not be labeled newly generated identities.

Status: researched; not implemented or browser-verified. No model download or placeholder voice-design controls were added. A preference question is pending about existing presets versus pursuing a separate voice-design model.

## Compact browser requirement — 2026-11-02

The multi-gigabyte Qwen export is excluded from the current feature scope after the user's size constraint. No Qwen assets, dependencies or runtime code have been added to the app.

A smaller practical no-upload alternative is Kokoro-82M, with an existing browser JavaScript interface. The reviewed ONNX listing reports 92.4 MB for `model_quantized.onnx` and 86 MB for `model_q8f16.onnx`; these are individual weight files, not total installation or runtime memory figures. WASM/JS, phonemization and selected speaker assets are additional. Source: https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx . Code/weights identify Apache-2.0. Its voice catalog includes male/female speakers and language/accent variants: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md . Model-level language assets do not establish language support in a particular JavaScript phonemization integration; each selected language requires actual browser testing.

Kokoro is a preset/style-conditioned speech model, not a gender/accent-description-to-new-identity model. A compact voice builder can select existing speakers, optionally blend compatible speaker styles where supported, and save its configuration or encode a generated sample through Pocket. It must not be advertised as genuine arbitrary voice design. Browser quality/performance and any speaker blending remain unverified here. The compact-preset versus genuine-design requirement needs resolution before replacing the requested capability with this alternative.
