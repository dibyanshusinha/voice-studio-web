/** Regression coverage for worker transport, cache integrity, tokenizer WASM and PCM output; no model inference claims. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
/** Loads a repository fixture so tests exercise the shipped runtime rather than a copied implementation. */
const read = p => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
/** Transpiles TypeScript into an isolated test context without launching a browser or downloading models. */
function moduleCode(path) {
  return ts.transpileModule(read(path), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS
    }
  }).outputText.replaceAll('import.meta.env.BASE_URL', "'/'");
}
/** Provides a simulated worker transport for testing the real adapter lifecycle; it does not simulate inference quality. */
function adapter() {
  const workers = [];
  class Worker {
    /** Registers this simulated transport so tests can inspect worker reuse and cleanup. */
    constructor() {
      workers.push(this);
    }
    /** Delivers simulated worker replies to the real adapter message handler. */
    emit(message) {
      this.onmessage({
        data: message
      });
    }
    /** Responds to the small worker protocol used by adapter lifecycle tests. */
    postMessage({
      type
    }) {
      queueMicrotask(() => {
        if (type === 'load') this.emit({
          type: 'loaded'
        });
        if (type === 'restore_voice') this.emit({
          type: 'voice_set'
        });
        if (type === 'generate') {
          this.emit({
            type: 'audio_chunk',
            data: new Float32Array([0.1, 0.2])
          });
          this.emit({
            type: 'stream_ended'
          });
        }
      });
    }
    /** Records worker termination so cancellation and cleanup can be asserted. */
    terminate() {
      this.terminated = true;
    }
  }
  const context = {
    exports: {},
    window: {
      isSecureContext: true,
      Worker,
      WebAssembly
    },
    Worker,
    Float32Array,
    Error,
    console
  };
  vm.runInNewContext(moduleCode('src/voices/voice-engine.ts'), context);
  return {
    Engine: context.exports.BrowserPocketEngine,
    workers
  };
}
test('adapter streams PCM, reuses worker, releases it, and can initialize again', async () => {
  const {
    Engine,
    workers
  } = adapter();
  const engine = new Engine();
  const voice = {
    id: 'test',
    bundle: 'english_2026-04',
    embedding: {
      data: new Float32Array(1024),
      shape: [1, 1, 1024]
    }
  };
  for (let n = 0; n < 3; n++) {
    const chunks = [];
    for await (const chunk of engine.synthesize('Hello', voice)) chunks.push(chunk);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 2);
  }
  assert.equal(workers.length, 1);
  await engine.dispose();
  assert.equal(workers[0].terminated, true);
  await engine.initialize();
  assert.equal(workers.length, 2);
  await engine.dispose();
});
test('Hindi input fails explicitly before downloading models', async () => {
  const {
    Engine,
    workers
  } = adapter();
  const engine = new Engine();
  await assert.rejects(async () => {
    for await (const _ of engine.synthesize('नमस्ते', {})) {}
  }, /Hindi/);
  assert.equal(workers.length, 0);
});
test('worker boots without loading models and returns a useful error before initialization', async () => {
  const messages = [];
  const context = {
    console,
    postMessage: m => messages.push(m),
    importScripts() {},
    navigator: {
      userAgent: 'Chrome',
      platform: 'MacIntel'
    },
    self: {
      postMessage: m => messages.push(m),
      POCKET_MODEL_MANIFEST: {
        baseUrl: 'https://example.test'
      }
    }
  };
  vm.runInNewContext(read('public/audio-runtime/speech-inference.worker.js'), context);
  assert.equal(messages[0].type, 'status');
  assert.equal(vm.runInNewContext('makeFilledArray([1], "bool", "ones")[0]', context), 1);
  await context.self.onmessage({
    data: {
      type: 'encode_voice',
      data: {}
    }
  });
  assert.match(messages.at(-1).error, /not loaded/);
});
test('cache commits complete assets and reuses them', async () => {
  let downloads = 0,
    writes = 0;
  const entries = new Map();
  const context = {
    self: {
      POCKET_MODEL_MANIFEST: {
        version: 'test'
      }
    },
    /** Responds to the small worker protocol used by adapter lifecycle tests. */
    postMessage() {},
    Blob,
    Response,
    Headers,
    Number,
    caches: {
      open: async () => ({
        match: async u => entries.get(u)?.clone(),
        put: async (u, r) => {
          writes++;
          entries.set(u, r);
        }
      })
    },
    fetch: async () => {
      downloads++;
      return new Response(new Uint8Array([1, 2, 3]));
    }
  };
  vm.createContext(context);
  vm.runInContext(read('public/audio-runtime/model-cache.js'), context);
  await vm.runInContext("cachedFetch('model')", context);
  await vm.runInContext("cachedFetch('model')", context);
  assert.equal(downloads, 1);
  assert.equal(writes, 1);
  assert.equal(entries.get('model').headers.get('x-voice-studio-bytes'), '3');
});
test('interrupted downloads never enter cache', async () => {
  let writes = 0;
  const context = {
    self: {
      POCKET_MODEL_MANIFEST: {
        version: 'test'
      }
    },
    /** Responds to the small worker protocol used by adapter lifecycle tests. */
    postMessage() {},
    Blob,
    Response,
    Headers,
    Number,
    caches: {
      open: async () => ({
        match: async () => undefined,
        put: async () => writes++
      })
    },
    fetch: async () => ({
      ok: true,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => {
            throw Error('interrupted');
          }
        })
      }
    })
  };
  vm.createContext(context);
  vm.runInContext(read('public/audio-runtime/model-cache.js'), context);
  await assert.rejects(vm.runInContext("cachedFetch('model')", context), /interrupted/);
  assert.equal(writes, 0);
});
test('WAV export has correct lengths and saturated 16-bit samples', async () => {
  const context = {
    exports: {},
    Blob,
    DataView,
    ArrayBuffer,
    Math
  };
  vm.runInNewContext(moduleCode('src/voices/audio-output.ts'), context);
  const data = await context.exports.encodePcmChunksAsWav([new Float32Array([-2, 0, 2])]).arrayBuffer();
  const view = new DataView(data);
  assert.equal(data.byteLength, 50);
  assert.equal(view.getUint32(40, true), 6);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
});
test('worklet plays a final chunk shorter than startup buffer', () => {
  const source = read('src/voices/playback/pcm-stream-player.js');
  const begin = source.indexOf('        class PCMProcessor');
  const end = source.indexOf('      `;', begin);
  const code = source.slice(begin, end).replace('${bufferSizeSamples}', '24000').replaceAll('${minBufferSamples}', '7200').replace('${minBufferSamples * 2}', '14400');
  let Processor;
  const messages = [];
  class Base {
    constructor() {
      this.port = {
        postMessage: m => messages.push(m)
      };
    }
  }
  vm.runInNewContext(code, {
    AudioWorkletProcessor: Base,
    Float32Array,
    Math,
    currentTime: 0,
    registerProcessor: (_name, C) => Processor = C
  });
  const processor = new Processor();
  processor.port.onmessage({
    data: {
      type: 'audio',
      data: new Float32Array([0.5, 0.25])
    }
  });
  const output = new Float32Array(128);
  processor.port.onmessage({
    data: {
      type: 'stream-ended'
    }
  });
  processor.process([], [[output]]);
  processor.process([], [[new Float32Array(128)]]);
  assert.equal(output[0], 0.5);
  assert.equal(messages.some(m => m.type === 'playback-complete'), true);
});
test('no separate application integration or source fetch hooks remain', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['install:pocket'], undefined);
  assert.equal(pkg.scripts.postinstall, undefined);
  assert.doesNotMatch(read('src/App.tsx'), /<iframe|pocketInstalled/);
});
test('extracted tokenizer embedded WASM initializes without external vocabulary assets', async () => {
  const context = {
    self: {
      location: {
        href: 'https://example.test/audio-runtime/speech-inference.worker.js'
      }
    },
    importScripts() {},
    console,
    atob,
    TextDecoder,
    TextEncoder,
    WebAssembly,
    Uint8Array,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto
  };
  vm.createContext(context);
  vm.runInContext(read('public/audio-runtime/sentencepiece-tokenizer.js'), context);
  const module = await vm.runInContext('createSentencePieceModule()', context);
  assert.equal(typeof module.SentencePieceProcessor, 'function');
  assert.equal(typeof context.self.SentencePieceProcessor, 'function');
});
test('consumer stopping a stream releases worker rather than leaving generation running', async () => {
  const {
    Engine,
    workers
  } = adapter();
  const engine = new Engine();
  const voice = {
    id: 'test',
    bundle: 'english_2026-04',
    embedding: {
      data: new Float32Array(1024),
      shape: [1, 1, 1024]
    }
  };
  for await (const _ of engine.synthesize('Hello', voice)) break;
  assert.equal(workers[0].terminated, true);
});
