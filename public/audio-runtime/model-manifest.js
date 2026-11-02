/** Pins model and runtime versions so downloaded tensors remain compatible with persisted embeddings. */
// Model revision and approximate upstream decimal byte sizes. Exact sizes and
// SHA256 hashes are not published in the reviewed listing; null is intentional.
self.POCKET_MODEL_MANIFEST = {
  version: 'english_2026-04-d0c0c79',
  revision: 'd0c0c79b7712256a32d691c67f20b8ae2e020d00',
  baseUrl: 'https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/d0c0c79b7712256a32d691c67f20b8ae2e020d00',
  runtime: {
    name: 'onnxruntime-web',
    version: '1.18.0',
    backend: 'wasm',
    license: 'MIT'
  },
  license: 'CC-BY-4.0 (model card); see /licenses.html',
  files: [{
    file: 'bundle.json',
    approximateBytes: 24400,
    sha256: null
  }, {
    file: 'tokenizer.model',
    approximateBytes: 59300,
    sha256: null
  }, {
    file: 'bos_before_voice.npy',
    approximateBytes: 4220,
    sha256: null
  }, {
    file: 'text_conditioner_int8.onnx',
    approximateBytes: 16400000,
    sha256: null
  }, {
    file: 'flow_lm_main_int8.onnx',
    approximateBytes: 76300000,
    sha256: null
  }, {
    file: 'flow_lm_flow_int8.onnx',
    approximateBytes: 9960000,
    sha256: null
  }, {
    file: 'mimi_decoder_int8.onnx',
    approximateBytes: 22700000,
    sha256: null
  }, {
    file: 'mimi_encoder_int8.onnx',
    approximateBytes: 20800000,
    sha256: null,
    lazy: true
  }]
};
