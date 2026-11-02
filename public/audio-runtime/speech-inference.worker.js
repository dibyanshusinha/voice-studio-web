/** Dedicated WASM inference runtime. Preserves upstream model tensors and streaming math outside the React thread. */
importScripts("./model-manifest.js", "./model-cache.js");
// Pocket TTS ONNX Web Worker
console.log("Pocket TTS Worker Starting...");
const ORT_VERSION = "1.18.0";
const ORT_CDN_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
// sentencepiece-tokenizer.js is loaded lazily via ensureSentencepieceLoaded() to reduce
// peak memory during ORT WASM compilation (critical for iOS memory limits).
let sentencepieceLoaded = false;
/** Defers tokenizer WASM loading until model initialization to reduce peak compilation memory. */
function ensureSentencepieceLoaded() {
  if (sentencepieceLoaded) return;
  console.log("Loading sentencepiece tokenizer library...");
  importScripts("./sentencepiece-tokenizer.js?v=2.0.5");
  sentencepieceLoaded = true;
}
self.postMessage({
  type: "status",
  status: "Worker Thread Started",
  state: "idle"
});
// ort is declared by the ONNX Runtime library when loaded via importScripts in loadOrt()
const DEFAULT_LANGUAGE = "english_2026-04";
const LANGUAGE_BUNDLES = [DEFAULT_LANGUAGE, "german", "italian", "portuguese", "spanish"];
const MODEL_STEMS = {
  mimi_encoder: "mimi_encoder_int8.onnx",
  text_conditioner: "text_conditioner_int8.onnx",
  flow_lm_main: "flow_lm_main_int8.onnx",
  flow_lm_flow: "flow_lm_flow_int8.onnx",
  mimi_decoder: "mimi_decoder_int8.onnx"
};
const DEBUG_LOGS = false;
const CHUNK_GAP_SEC = 0.25;
const MAX_FRAMES = 500;
/** Detects iPhones and iPads, including desktop-mode iPads, for the reduced-memory inference path. */
function checkIsIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}
/** Selects Safari-specific runtime options where aggressive WASM settings can exhaust memory. */
function checkIsSafari() {
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
}
let LSD_STEPS = 1;
const RESET_FLOW_STATE_EACH_CHUNK = true;
const RESET_MIMI_STATE_EACH_CHUNK = true;
let currentLanguage = DEFAULT_LANGUAGE;
let currentBundleDir = null;
let bundleMetadata = null;
let tokenizerProcessor = null;
let bosBeforeVoice = null;
let mimiEncoderSession = null;
let textConditionerSession = null;
let flowLmMainSession = null;
let flowLmFlowSession = null;
let mimiDecoderSession = null;
let currentSampleRate = 24000;
let currentSamplesPerFrame = 1920;
let currentLatentDim = 32;
let currentConditioningDim = 1024;
let currentMaxTokenPerChunk = 50;
let predefinedVoiceRecords = {};
let customVoiceEmbedding = null;
let currentVoiceName = null;
let voiceConditioningCache = new Map();
let stTensors = [];
let isGenerating = false;
let isReady = false;
const HF_CDN_BASE = self.POCKET_MODEL_MANIFEST.baseUrl;
/** Builds the pinned model directory for a selected language bundle. */
function bundleDir(language) {
  return `${HF_CDN_BASE}/onnx/${language}`;
}
/** Resolves one model or metadata file within its language bundle. */
function bundlePath(language, filename) {
  return `${bundleDir(language)}/${filename}`;
}
/** Keeps detailed inference metrics available without allocating routine console output in normal use. */
function debugLog(...args) {
  if (DEBUG_LOGS) {
    console.log(...args);
  }
}
/** Allocates state storage using the dtype, shape and initial fill specified by upstream metadata. */
function makeFilledArray(shape, dtype, fill) {
  const size = shape.reduce((a, b) => a * b, 1);
  let data;
  if (dtype === "int64") {
    data = new BigInt64Array(size);
  } else if (dtype === "bool") {
    data = new Uint8Array(size);
    // Boolean first-frame flags must honor the upstream bundle manifest.
    if (fill === "ones") data.fill(1);
  } else {
    data = new Float32Array(size);
    if (fill === "nan") {
      data.fill(NaN);
    } else if (fill === "ones") {
      data.fill(1);
    }
  }
  return data;
}
/** Constructs an ONNX tensor without changing the upstream tensor names or dimensions. */
function createTensor(dtype, data, dims) {
  return new ort.Tensor(dtype, data, dims);
}
/** Creates all autoregressive state inputs from the bundle manifest rather than hardcoding model shapes. */
function initStateFromManifest(manifest) {
  const state = {};
  for (const entry of manifest) {
    state[entry.input_name] = createTensor(entry.dtype, makeFilledArray(entry.shape, entry.dtype, entry.fill), entry.shape);
  }
  return state;
}
/** Copies state references so a generation can replace outputs without overwriting cached voice conditioning. */
function cloneState(state) {
  return {
    ...state
  };
}
/** Feeds model state outputs into the next autoregressive step using manifest mappings. */
function updateStateFromManifestOutputs(state, result, manifest) {
  for (const entry of manifest) {
    state[entry.input_name] = result[entry.output_name];
  }
}
/** Prepends the model-required beginning-of-sequence embedding when conditioning a custom voice. */
function prepareVoiceEmbeddingData(voiceEmb) {
  let data = voiceEmb.data;
  let dims = voiceEmb.shape.slice();
  if (bundleMetadata.insert_bos_before_voice && bosBeforeVoice) {
    const bosData = bosBeforeVoice.data;
    const combined = new Float32Array(bosData.length + data.length);
    combined.set(bosData, 0);
    combined.set(data, bosData.length);
    data = combined;
    dims = [1, dims[1] + bosBeforeVoice.shape[1], dims[2]];
  }
  return createTensor("float32", data, dims);
}
/** Runs the reference embedding through Flow LM once to obtain reusable speaker-conditioned state. */
async function buildVoiceConditionedState(voiceEmb) {
  const flowLmState = initStateFromManifest(bundleMetadata.flow_lm_state_manifest);
  const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
  const voiceTensor = prepareVoiceEmbeddingData(voiceEmb);
  const result = await flowLmMainSession.run({
    sequence: emptySeq,
    text_embeddings: voiceTensor,
    ...flowLmState
  });
  updateStateFromManifestOutputs(flowLmState, result, bundleMetadata.flow_lm_state_manifest);
  return flowLmState;
}
/** Reuses prepared speaker state unless the reference embedding has changed. */
async function ensureCustomVoiceCached(options = {}) {
  const {
    force = false,
    statusText = "Preparing custom voice..."
  } = options;
  if (!customVoiceEmbedding) {
    throw new Error("No custom voice loaded.");
  }
  if (!force && voiceConditioningCache.has("custom")) {
    return voiceConditioningCache.get("custom");
  }
  postMessage({
    type: "status",
    status: statusText,
    state: "loading"
  });
  const conditioned = await buildVoiceConditionedState(customVoiceEmbedding);
  voiceConditioningCache.set("custom", conditioned);
  return conditioned;
}
/** Reads the upstream NPY beginning-of-sequence asset while retaining its declared dimensions. */
function parseNpyFloat32(buffer) {
  const view = new DataView(buffer);
  const magic = new Uint8Array(buffer, 0, 6);
  const expected = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  for (let i = 0; i < expected.length; i++) {
    if (magic[i] !== expected[i]) {
      throw new Error("Invalid NPY file");
    }
  }
  const major = view.getUint8(6);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerOffset = major === 1 ? 10 : 12;
  const headerText = new TextDecoder().decode(new Uint8Array(buffer, headerOffset, headerLen));
  const shapeMatch = headerText.match(/\(\s*([0-9,\s]+)\)/);
  if (!shapeMatch) {
    throw new Error("Could not parse NPY shape");
  }
  const shape = shapeMatch[1].split(",").map(part => part.trim()).filter(Boolean).map(part => Number.parseInt(part, 10));
  const dataOffset = headerOffset + headerLen;
  const data = new Float32Array(buffer, dataOffset);
  return {
    data: new Float32Array(data),
    shape
  };
}
/** Loads Mimi encoding only when cloning is requested, avoiding an unnecessary synthesis download. */
async function ensureEncoderSessionLoaded() {
  if (mimiEncoderSession) {
    return;
  }
  postMessage({
    type: "status",
    status: "Loading voice encoder...",
    state: "loading"
  });
  const sessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  };
  if (checkIsIOS() || checkIsSafari()) {
    console.log("iOS or Safari detected: disabling CPU Memory Arena, Memory Pattern, and Graph Optimizations for voice encoder.");
    sessionOptions.enableCpuMemArena = false;
    sessionOptions.enableMemPattern = false;
    sessionOptions.graphOptimizationLevel = "disabled";
  }
  mimiEncoderSession = await createCachedSession(bundlePath(currentLanguage, MODEL_STEMS.mimi_encoder), sessionOptions);
  postMessage({
    type: "status",
    status: "Voice encoder ready",
    state: "idle"
  });
}
/** Runs reference PCM through Mimi and normalizes the output shape expected by voice conditioning. */
async function encodeVoiceAudio(audioData) {
  await ensureEncoderSessionLoaded();
  const input = createTensor("float32", audioData, [1, 1, audioData.length]);
  const outputs = await mimiEncoderSession.run({
    audio: input
  });
  const embeddings = outputs[mimiEncoderSession.outputNames[0]];
  let dims = embeddings.dims.slice();
  let data = new Float32Array(embeddings.data);
  while (dims.length > 3) {
    if (dims[0] !== 1) break;
    dims = dims.slice(1);
  }
  if (dims.length < 3) {
    dims = [1, dims[0], dims[1]];
  }
  return {
    data,
    shape: dims
  };
}
/** Applies bundle-specific text preparation and selects the amount of audio generated after end-of-speech. */
function prepareTextPrompt(text) {
  let prompt = text.trim();
  if (!prompt) {
    return {
      text: "",
      framesAfterEos: 1
    };
  }
  prompt = prompt.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\s+/g, " ");
  if (bundleMetadata.remove_semicolons) {
    prompt = prompt.replace(/;/g, ",");
  }
  const wordCount = prompt.split(/\s+/).filter(Boolean).length;
  let framesAfterEos = wordCount <= 4 ? 3 : 1;
  if (bundleMetadata.model_recommended_frames_after_eos != null) {
    framesAfterEos = Number(bundleMetadata.model_recommended_frames_after_eos);
  }
  if (prompt && !/[A-ZÀ-Þ]/.test(prompt[0])) {
    prompt = prompt[0].toUpperCase() + prompt.slice(1);
  }
  if (prompt && /[0-9A-Za-zÀ-ÿ]/.test(prompt[prompt.length - 1])) {
    prompt += ".";
  }
  if (bundleMetadata.pad_with_spaces_for_short_inputs && wordCount < 5) {
    prompt = "        " + prompt;
  }
  return {
    text: prompt,
    framesAfterEos
  };
}
const SENTENCE_SPLIT_RE = /[^.!?]+[.!?]+|[^.!?]+$/g;
/** Keeps sentence boundaries intact when dividing long text for streaming generation. */
function splitTextIntoSentences(text) {
  const matches = text.match(SENTENCE_SPLIT_RE);
  if (!matches) return [];
  return matches.map(sentence => sentence.trim()).filter(Boolean);
}
/** Splits an overlong sentence at the model token limit and decodes each piece back into text. */
function splitTokenIdsIntoChunks(tokenIds, maxTokens) {
  const chunks = [];
  for (let i = 0; i < tokenIds.length; i += maxTokens) {
    const chunkText = tokenizerProcessor.decodeIds(tokenIds.slice(i, i + maxTokens)).trim();
    if (chunkText) {
      chunks.push(chunkText);
    }
  }
  return chunks;
}
/** Combines short sentences while respecting the bundle token budget for each generation chunk. */
function splitIntoBestSentences(text) {
  const prepared = prepareTextPrompt(text);
  if (!prepared.text) {
    return {
      chunks: [],
      framesAfterEos: prepared.framesAfterEos
    };
  }
  const sentences = splitTextIntoSentences(prepared.text);
  if (!sentences.length) {
    return {
      chunks: [prepared.text],
      framesAfterEos: prepared.framesAfterEos
    };
  }
  const chunks = [];
  let currentChunk = "";
  for (const sentenceText of sentences) {
    const sentenceTokenIds = tokenizerProcessor.encodeIds(sentenceText);
    const sentenceTokens = sentenceTokenIds.length;
    if (sentenceTokens > currentMaxTokenPerChunk) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      const splitChunks = splitTokenIdsIntoChunks(sentenceTokenIds, currentMaxTokenPerChunk);
      for (const splitChunk of splitChunks) {
        if (splitChunk) {
          chunks.push(splitChunk.trim());
        }
      }
      continue;
    }
    if (!currentChunk) {
      currentChunk = sentenceText;
      continue;
    }
    const combined = `${currentChunk} ${sentenceText}`;
    const combinedTokens = tokenizerProcessor.encodeIds(combined).length;
    if (combinedTokens > currentMaxTokenPerChunk) {
      chunks.push(currentChunk.trim());
      currentChunk = sentenceText;
    } else {
      currentChunk = combined;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return {
    chunks,
    framesAfterEos: prepared.framesAfterEos
  };
}
/** Prepares reusable integration-time tensors to avoid recreating them at every sampling step. */
function precomputeFlowBuffers() {
  for (const tensors of stTensors) { tensors.s.dispose?.(); tensors.t.dispose?.(); }
  stTensors = [];
  const dt = 1.0 / LSD_STEPS;
  for (let step = 0; step < LSD_STEPS; step++) {
    const s = step / LSD_STEPS;
    const t = s + dt;
    stTensors.push({
      s: createTensor("float32", new Float32Array([s]), [1, 1]),
      t: createTensor("float32", new Float32Array([t]), [1, 1])
    });
  }
}
/** Loads the pinned ONNX runtime and applies desktop or Safari memory/thread settings inside the worker. */
async function loadOrt() {
  if (typeof ort !== "undefined" && ort) {
    return;
  }
  const isIOSOrSafari = checkIsIOS() || checkIsSafari();
  postMessage({
    type: "status",
    status: "Loading ONNX Runtime...",
    state: "loading"
  });
  // Use ort.min.js (540KB, WASM-only backend) instead of ort.all.min.js (1.1MB, all backends)
  // to halve the JS parse memory overhead before WASM compilation.
  const ortScript = isIOSOrSafari ? "ort.min.js" : "ort.all.min.js";
  const ortUrl = `${ORT_CDN_BASE}${ortScript}`;
  // Direct importScripts avoids the fetch→text→Blob→blobURL pipeline
  // which held 3 copies of the script in memory simultaneously.
  try {
    importScripts(ortUrl);
  } catch (e) {
    // Fallback: try fetch+blob approach if direct importScripts fails (e.g. CORS)
    console.warn("Direct importScripts failed, trying fetch fallback:", e.message);
    const response = await fetch(ortUrl);
    if (!response.ok) throw new Error(`Failed to load ONNX Runtime from CDN (${response.status})`);
    const scriptText = await response.text();
    const blob = new Blob([scriptText], {
      type: "application/javascript"
    });
    const blobUrl = URL.createObjectURL(blob);
    try {
      importScripts(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
  ort.env.wasm.wasmPaths = ORT_CDN_BASE;
  // Disable ORT internal logging to reduce memory allocations
  ort.env.logLevel = "error";
  if (isIOSOrSafari) {
    console.log("iOS/Safari: SIMD off, 1 thread, minimal memory footprint.");
    ort.env.wasm.simd = false;
    ort.env.wasm.numThreads = 1;
    // Disable proxy worker — we're already in a worker, spawning another doubles overhead
    ort.env.wasm.proxy = false;
  } else {
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;
  }
  precomputeFlowBuffers();
}
/** Releases an existing ONNX session before replacing or retiring its model. */
async function releaseSession(session) {
  if (!session) {
    return;
  }
  if (typeof session.release === "function") {
    await session.release();
  }
}
/** Loads metadata and sessions sequentially, then prepares the matching tokenizer and optional BOS asset. */
async function loadBundle(language, {
  initialLoad = false
} = {}) {
  if (!LANGUAGE_BUNDLES.includes(language)) {
    throw new Error(`Unsupported language bundle: ${language}`);
  }
  await loadOrt();
  postMessage({
    type: "status",
    status: `Loading ${language} bundle...`,
    state: "loading"
  });
  currentLanguage = language;
  currentBundleDir = bundleDir(language);
  const metadataResponse = await cachedFetch(bundlePath(language, "bundle.json"));
  if (!metadataResponse.ok) {
    throw new Error(`Failed to load bundle metadata for ${language}`);
  }
  bundleMetadata = await metadataResponse.json();
  currentSampleRate = Number(bundleMetadata.sample_rate);
  currentSamplesPerFrame = Number(bundleMetadata.samples_per_frame);
  currentLatentDim = Number(bundleMetadata.latent_dim);
  currentConditioningDim = Number(bundleMetadata.conditioning_dim);
  currentMaxTokenPerChunk = Number(bundleMetadata.max_token_per_chunk || 50);
  isReady = false;
  await Promise.all([releaseSession(mimiEncoderSession), releaseSession(textConditionerSession), releaseSession(flowLmMainSession), releaseSession(flowLmFlowSession), releaseSession(mimiDecoderSession)]);
  mimiEncoderSession = null;
  textConditionerSession = null;
  flowLmMainSession = null;
  flowLmFlowSession = null;
  mimiDecoderSession = null;
  const sessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  };
  if (checkIsIOS() || checkIsSafari()) {
    console.log("iOS or Safari detected: disabling CPU Memory Arena, Memory Pattern, and Graph Optimizations to save memory.");
    sessionOptions.enableCpuMemArena = false;
    sessionOptions.enableMemPattern = false;
    sessionOptions.graphOptimizationLevel = "disabled";
  }
  const models = [["text_conditioner", s => textConditionerSession = s], ["flow_lm_main", s => flowLmMainSession = s], ["flow_lm_flow", s => flowLmFlowSession = s], ["mimi_decoder", s => mimiDecoderSession = s]];
  for (const [key, assign] of models) {
    postMessage({
      type: "status",
      status: `Loading ${key}...`,
      state: "loading"
    });
    assign(await createCachedSession(bundlePath(language, MODEL_STEMS[key]), sessionOptions));
  }
  const tokenizerResponse = await cachedFetch(bundlePath(language, bundleMetadata.tokenizer_file));
  if (!tokenizerResponse.ok) {
    throw new Error(`Failed to load tokenizer for ${language}`);
  }
  const tokenizerBuffer = await tokenizerResponse.arrayBuffer();
  ensureSentencepieceLoaded();
  tokenizerProcessor = new self.SentencePieceProcessor();
  await tokenizerProcessor.loadFromArrayBuffer(tokenizerBuffer);
  bosBeforeVoice = null;
  if (bundleMetadata.bos_before_voice_file) {
    const bosResponse = await cachedFetch(bundlePath(language, bundleMetadata.bos_before_voice_file));
    if (bosResponse.ok) {
      bosBeforeVoice = parseNpyFloat32(await bosResponse.arrayBuffer());
    }
  }
  predefinedVoiceRecords = {};
  voiceConditioningCache = new Map();
  const defaultVoice = null;
  currentVoiceName = null;
  if (customVoiceEmbedding) {
    voiceConditioningCache.delete("custom");
  }
  isReady = true;
  postMessage({
    type: "voices_loaded",
    voices: [],
    defaultVoice,
    language
  });
  postMessage({
    type: "bundle_loaded",
    language,
    sampleRate: currentSampleRate,
    initialLoad
  });
  postMessage({
    type: "status",
    status: "Ready",
    state: "idle"
  });
  postMessage({
    type: "model_status",
    status: "ready",
    text: `Ready (${language})`
  });
  if (initialLoad) {
    postMessage({
      type: "loaded"
    });
  }
}
// Adapter command router: model loading, reference encoding and generation all stay inside this worker.
self.onmessage = async e => {
  const {
    type,
    data
  } = e.data;
  try {
    if (type === "load") {
      await loadBundle(data?.language || DEFAULT_LANGUAGE, {
        initialLoad: true
      });
      return;
    }
    if (type === "set_language") {
      if (isGenerating) {
        postMessage({
          type: "error",
          error: "Cannot switch language while generation is running."
        });
        return;
      }
      await loadBundle(data.language, {
        initialLoad: false
      });
      return;
    }
    if (type === "stop") {
      isGenerating = false;
      postMessage({
        type: "status",
        status: "Stopped",
        state: "idle"
      });
      return;
    }
    if (!isReady) {
      postMessage({
        type: "error",
        error: "Models are not loaded yet."
      });
      return;
    }
    if (type === "encode_voice") {
      if (isGenerating) {
        postMessage({
          type: "error",
          error: "Cannot encode a voice while generation is running."
        });
        return;
      }
      try {
        customVoiceEmbedding = await encodeVoiceAudio(data.audio);
      } finally {
        await releaseSession(mimiEncoderSession);
        mimiEncoderSession = null;
      }
      currentVoiceName = "custom";
      await ensureCustomVoiceCached({
        force: true,
        statusText: "Preparing custom voice..."
      });
      postMessage({
        type: "voice_encoded",
        embedding: customVoiceEmbedding
      });
      postMessage({
        type: "status",
        status: "Ready",
        state: "idle"
      });
      return;
    }
    if (type === "restore_voice") {
      customVoiceEmbedding = data.embedding;
      voiceConditioningCache.delete("custom");
      await ensureCustomVoiceCached({
        force: true
      });
      currentVoiceName = "custom";
      postMessage({
        type: "voice_set"
      });
      return;
    }
    if (type === "generate") {
      if (isGenerating) {
        return;
      }
      await startGeneration(data.text, data.voice || currentVoiceName, data.options);
    }
  } catch (err) {
    console.error("Worker error:", err);
    postMessage({
      type: "error",
      error: err.toString()
    });
  }
};
/** Owns generation status and error messages so every successful stream receives a completion marker. */
async function startGeneration(text, voiceName, options = {}) {
  const temperature = Number.isFinite(options.temperature) ? Math.max(0.1, Math.min(1.2, options.temperature)) : 0.7;
  LSD_STEPS = Number.isFinite(options.samplingSteps) ? Math.max(1, Math.min(4, Math.round(options.samplingSteps))) : 1;
  precomputeFlowBuffers();
  isGenerating = true;
  postMessage({
    type: "status",
    status: "Generating...",
    state: "running"
  });
  postMessage({
    type: "generation_started",
    data: {
      time: performance.now()
    }
  });
  try {
    const {
      chunks,
      framesAfterEos
    } = splitIntoBestSentences(text);
    if (!chunks.length) {
      throw new Error("No text to generate");
    }
    if (voiceName === "custom") {
      await ensureCustomVoiceCached({
        statusText: "Preparing custom voice..."
      });
    } else {
      throw new Error("Select a saved cloned voice.");
    }
    currentVoiceName = voiceName;
    await runGenerationPipeline(voiceName, chunks, framesAfterEos, temperature);
  } catch (err) {
    console.error("Generation error:", err);
    postMessage({
      type: "error",
      error: err.toString()
    });
  } finally {
    if (isGenerating) {
      postMessage({
        type: "stream_ended"
      });
      postMessage({
        type: "status",
        status: "Finished",
        state: "idle"
      });
    }
    isGenerating = false;
  }
}
/** Runs token conditioning, autoregressive flow sampling and incremental Mimi decoding into PCM chunks. */
async function runGenerationPipeline(voiceName, chunks, framesAfterEos, temperature = 0.7) {
  let mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
  const emptySeq = createTensor("float32", new Float32Array(0), [1, 0, currentLatentDim]);
  const emptyTextEmb = createTensor("float32", new Float32Array(0), [1, 0, currentConditioningDim]);
  const baseFlowState = voiceConditioningCache.get(voiceName);
  if (!baseFlowState) {
    throw new Error(`Voice conditioning cache missing for '${voiceName}'.`);
  }
  let flowLmState = cloneState(baseFlowState);
  const firstChunkFrames = 3;
  const normalChunkFrames = 12;
  let generatedFrames = 0;
  let isFirstAudioChunk = true;
  let totalFlowLmTime = 0;
  let totalDecodeTime = 0;
  const generationStart = performance.now();
  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    if (!isGenerating) break;
    if (RESET_FLOW_STATE_EACH_CHUNK && chunkIdx > 0) {
      flowLmState = cloneState(baseFlowState);
    }
    if (RESET_MIMI_STATE_EACH_CHUNK && chunkIdx > 0) {
      mimiState = initStateFromManifest(bundleMetadata.mimi_state_manifest);
    }
    const chunkText = chunks[chunkIdx];
    let isFirstAudioChunkOfTextChunk = true;
    const tokenIds = tokenizerProcessor.encodeIds(chunkText);
    const textInput = createTensor("int64", BigInt64Array.from(tokenIds.map(token => BigInt(token))), [1, tokenIds.length]);
    let textEmb = (await textConditionerSession.run({
      token_ids: textInput
    }))[textConditionerSession.outputNames[0]];
    if (textEmb.dims.length === 2) {
      textEmb = createTensor("float32", new Float32Array(textEmb.data), [1, textEmb.dims[0], textEmb.dims[1]]);
    }
    const condResult = await flowLmMainSession.run({
      sequence: emptySeq,
      text_embeddings: textEmb,
      ...flowLmState
    });
    updateStateFromManifestOutputs(flowLmState, condResult, bundleMetadata.flow_lm_state_manifest);
    const chunkLatents = [];
    let chunkDecodedFrames = 0;
    let currentLatent = createTensor("float32", new Float32Array(currentLatentDim).fill(NaN), [1, 1, currentLatentDim]);
    let eosStep = null;
    let chunkEnded = false;
    let chunkGenTimeMs = 0;
    for (let step = 0; step < MAX_FRAMES; step++) {
      if (!isGenerating) break;
      if (step > 0 && step % 4 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      const stepStart = performance.now();
      const arResult = await flowLmMainSession.run({
        sequence: currentLatent,
        text_embeddings: emptyTextEmb,
        ...flowLmState
      });
      const stepElapsed = performance.now() - stepStart;
      chunkGenTimeMs += stepElapsed;
      totalFlowLmTime += stepElapsed;
      const conditioning = arResult.conditioning;
      const eosLogit = arResult.eos_logit.data[0];
      const isEos = eosLogit > -4.0;
      if (isEos && eosStep == null) {
        eosStep = step;
      }
      const shouldStop = eosStep != null && step >= eosStep + framesAfterEos || step === MAX_FRAMES - 1;

      const std = Math.sqrt(temperature);
      const latentData = new Float32Array(currentLatentDim);
      for (let i = 0; i < currentLatentDim; i++) {
        let u = 0;
        let v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        latentData[i] = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * std;
      }
      const dt = 1.0 / LSD_STEPS;
      for (let lsdIndex = 0; lsdIndex < LSD_STEPS; lsdIndex++) {
        const flowResult = await flowLmFlowSession.run({
          c: conditioning,
          s: stTensors[lsdIndex].s,
          t: stTensors[lsdIndex].t,
          x: createTensor("float32", latentData, [1, currentLatentDim])
        });
        const flowDir = flowResult.flow_dir.data;
        for (let i = 0; i < currentLatentDim; i++) {
          latentData[i] += flowDir[i] * dt;
        }
      }
      chunkLatents.push(new Float32Array(latentData));
      generatedFrames++;
      currentLatent = createTensor("float32", latentData, [1, 1, currentLatentDim]);
      updateStateFromManifestOutputs(flowLmState, arResult, bundleMetadata.flow_lm_state_manifest);
      const pending = chunkLatents.length - chunkDecodedFrames;
      let decodeSize = 0;
      if (shouldStop) {
        decodeSize = pending;
      } else if (isFirstAudioChunk && pending >= firstChunkFrames) {
        decodeSize = firstChunkFrames;
      } else if (pending >= normalChunkFrames) {
        decodeSize = normalChunkFrames;
      }
      if (decodeSize > 0) {
        const decodeLatents = new Float32Array(decodeSize * currentLatentDim);
        for (let frame = 0; frame < decodeSize; frame++) {
          decodeLatents.set(chunkLatents[chunkDecodedFrames + frame], frame * currentLatentDim);
        }
        const decoderStart = performance.now();
        const decodeResult = await mimiDecoderSession.run({
          latent: createTensor("float32", decodeLatents, [1, decodeSize, currentLatentDim]),
          ...mimiState
        });
        const decoderElapsed = performance.now() - decoderStart;
        chunkGenTimeMs += decoderElapsed;
        totalDecodeTime += decoderElapsed;
        for (const entry of bundleMetadata.mimi_state_manifest) {
          mimiState[entry.input_name] = decodeResult[entry.output_name];
        }
        chunkDecodedFrames += decodeSize;
        const audioFloat32 = new Float32Array(decodeResult[mimiDecoderSession.outputNames[0]].data);
        const isLastChunk = shouldStop && chunkIdx === chunks.length - 1;
        postMessage({
          type: "audio_chunk",
          data: audioFloat32,
          metrics: {
            bbTime: 0,
            decTime: 0,
            chunkDuration: audioFloat32.length / currentSampleRate,
            genTimeSec: chunkGenTimeMs / 1000,
            isFirst: isFirstAudioChunk,
            isLast: isLastChunk,
            chunkStart: isFirstAudioChunkOfTextChunk
          }
        }, [audioFloat32.buffer]);
        isFirstAudioChunk = false;
        isFirstAudioChunkOfTextChunk = false;
        chunkGenTimeMs = 0;
      }
      if (shouldStop) {
        chunkEnded = true;
        break;
      }
    }
    if (chunkEnded && isGenerating && chunkIdx < chunks.length - 1) {
      const gapSamples = Math.max(1, Math.floor(CHUNK_GAP_SEC * currentSampleRate));
      const silence = new Float32Array(gapSamples);
      postMessage({
        type: "audio_chunk",
        data: silence,
        metrics: {
          bbTime: 0,
          decTime: 0,
          chunkDuration: gapSamples / currentSampleRate,
          isFirst: false,
          isLast: false,
          isSilence: true
        }
      }, [silence.buffer]);
    }
  }
  const totalTime = (performance.now() - generationStart) / 1000;
  const audioSeconds = generatedFrames * currentSamplesPerFrame / currentSampleRate;
  const genTime = (totalFlowLmTime + totalDecodeTime) / 1000;
  const rtfx = genTime > 0 ? audioSeconds / genTime : 0;
  debugLog(`Generation complete for ${voiceName} in ${totalTime.toFixed(2)}s (RTFx ${rtfx.toFixed(2)}x)`);
  postMessage({
    type: "status",
    status: `Finished (RTFx: ${rtfx.toFixed(2)}x)`,
    state: "idle",
    metrics: {
      rtfx,
      genTime,
      totalTime,
      audioDuration: audioSeconds
    }
  });
}
