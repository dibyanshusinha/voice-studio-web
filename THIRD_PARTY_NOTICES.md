# Third-party licenses

Voice Studio application code is licensed under [GNU GPLv3 only](LICENSE). The component licenses below remain in effect for their respective upstream works and model assets.

Voice Studio integrates the following open-source components. Their licenses apply to those components independently of the application.

| Component | Author / source | License |
| --- | --- | --- |
| ONNX export and web inference pipeline | [KevinAHM](https://huggingface.co/KevinAHM/pocket-tts-onnx) | [Apache-2.0](public/licenses/Apache-2.0.txt) |
| Pocket TTS model weights | [Kyutai](https://huggingface.co/kyutai/pocket-tts) · [ONNX distribution](https://huggingface.co/spaces/KevinAHM/pocket-tts-web) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| SentencePiece and browser wrapper | [Google](https://github.com/google/sentencepiece) · [sctg-development](https://github.com/sctg-development/sentencepiece-js) · [JanKaul](https://github.com/JanKaul/sentencepiece) · [devilyouwei](https://github.com/devilyouwei/sentencepiece) | [Apache-2.0](public/licenses/Apache-2.0.txt) |
| ONNX Runtime Web 1.18.0 | [Microsoft](https://github.com/microsoft/onnxruntime) | [MIT](public/licenses/onnxruntime-MIT.txt) |


Model weights are downloaded unchanged from the revision pinned in `model-manifest.js`; no weights or built-in speaker assets are included in Git. Model licenses are separate from source-code licenses. Use authorized reference recordings and follow the upstream model terms.

React, React DOM, Vite and its React plugin: MIT. TypeScript: Apache-2.0. Lucide: ISC. Full notices accompany their npm packages.
