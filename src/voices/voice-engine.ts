/** Typed boundary around the classic inference worker; owns commands, streaming and cancellation. */
import type { PocketTTSEngine, VoiceProfile, PocketBundle } from './types';
/** Messages crossing the adapter/worker boundary; embeddings and PCM use structured cloning. */
type Message = {
  type: string;
  status?: string;
  error?: string;
  data?: Float32Array;
  embedding?: VoiceProfile['embedding'];
};
/** Owns one model bundle and serializes work so worker state cannot be changed mid-generation. */
export class BrowserPocketEngine implements PocketTTSEngine {
  private worker?: Worker;
  private resourceState: 'not-loaded' | 'loading' | 'ready' = 'not-loaded';
  /** Exposes resource ownership without guessing the browser's unobservable WASM heap size. */
  getResourceState() { return this.resourceState; }
  private loading?: Promise<void>;
  private pending?: {
    type: string;
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
  };
  private stream?: (m: Message) => void;
  private busy = false;
  private loadedVoice?: string;
  // Changes on disposal so async decoding cannot restart a cancelled operation.
  private epoch = 0;
  /** Stores the progress callback and bundle selection without starting any model download. */
  constructor(private progress: (status: string) => void = () => {}, private bundle: PocketBundle = 'english_2026-04') {}
  /** Loads the chosen model bundle once; concurrent callers share the same initialization promise. */
  initialize(): Promise<void> {
    if (this.loading) return this.loading;
    if (!window.isSecureContext || !window.Worker || !window.WebAssembly) return Promise.reject(Error('Local inference requires HTTPS, Web Workers and WebAssembly.'));
    this.worker = new Worker(`${import.meta.env.BASE_URL}audio-runtime/speech-inference.worker.js`);
    const worker = this.worker;
    this.resourceState = 'loading';
    // A command reply settles its promise; stream messages continue to the active generator.
    this.worker.onmessage = ({
      data
    }: MessageEvent<Message>) => {
      if (data.status) this.progress(data.status);
      if (data.type === 'error') {
        this.pending?.reject(Error(data.error));
        this.pending = undefined;
      } else if (data.type === this.pending?.type) {
        this.pending.resolve(data);
        this.pending = undefined;
      }
      this.stream?.(data);
    };
    this.worker.onerror = e => {
      const message = {
        type: 'error',
        error: e.message || 'Inference worker crashed; stop and retry.'
      };
      this.pending?.reject(Error(message.error));
      this.pending = undefined;
      this.stream?.(message);
    };
    this.loading = this.sendWorkerRequest('load', 'loaded', {
      language: this.bundle
    }).then(() => { if (this.worker === worker) this.resourceState = 'ready'; }).catch(async e => {
      if (this.worker === worker) await this.dispose();
      throw e;
    });
    return this.loading;
  }
  /** Pairs one worker command with its completion message while rejecting overlapping requests. */
  private sendWorkerRequest(type: string, response: string, data?: unknown): Promise<Message> {
    if (this.pending) return Promise.reject(Error('An inference operation is already running.'));
    return new Promise((resolve, reject) => {
      this.pending = {
        type: response,
        resolve,
        reject
      };
      this.worker!.postMessage({
        type,
        data
      });
    });
  }
  /** Decodes and downmixes a reference to 24 kHz before requesting the reusable encoder embedding. */
  async cloneVoice(blob: Blob, options?: {
    name?: string;
  }): Promise<VoiceProfile> {
    if (this.busy) throw Error('Wait for the current operation or cancel it.');
    this.busy = true;
    const epoch = this.epoch;
    try {
      if (!blob.size || blob.size > 25 * 1024 * 1024) throw Error('Choose an audio recording smaller than 25 MB.');
      const context = new AudioContext();
      let decoded: AudioBuffer;
      try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer());
      } finally {
        await context.close();
      }
      if (decoded.duration < 3 || decoded.duration > 30) throw Error('Use a 3–30 second recording; the first 10 seconds are used.');
      const offline = new OfflineAudioContext(1, Math.ceil(Math.min(decoded.duration, 10) * 24000), 24000);
      const source = offline.createBufferSource();
      source.buffer = decoded;
      source.connect(offline.destination);
      source.start();
      const pcm = (await offline.startRendering()).getChannelData(0);
      if (!pcm.every(Number.isFinite) || !pcm.some(v => Math.abs(v) > 0.005)) throw Error('The reference is silent or invalid.');
      if (epoch !== this.epoch) throw Error('Operation cancelled.');
      await this.initialize();
      if (epoch !== this.epoch) throw Error('Operation cancelled.');
      const result = await this.sendWorkerRequest('encode_voice', 'voice_encoded', {
        audio: pcm
      });
      if (!result.embedding) throw Error('Voice encoder returned no embedding.');
      this.loadedVoice = undefined;
      return {
        id: crypto.randomUUID(),
        name: options?.name?.trim() || 'My voice',
        createdAt: Date.now(),
        bundle: this.bundle,
        embedding: result.embedding
      };
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }
  /** Streams PCM for a saved embedding and terminates incomplete generation if the consumer stops reading. */
  async *synthesize(text: string, voice: VoiceProfile): AsyncIterable<Float32Array> {
    if (this.busy) throw Error('Wait for the current operation or cancel it.');
    if (!text.trim() || text.length > 4000) throw Error('Enter between 1 and 4000 characters.');
    if (/[\u0900-\u097f]/.test(text)) throw Error('Hindi synthesis is not supported by the available model bundles.');
    if (voice.bundle !== this.bundle) throw Error('This voice uses an incompatible model bundle.');
    this.busy = true;
    const epoch = this.epoch;
    let completed = false;
    try {
      await this.initialize();
      if (epoch !== this.epoch) throw Error('Operation cancelled.');
      if (this.loadedVoice !== voice.id) {
        await this.sendWorkerRequest('restore_voice', 'voice_set', {
          embedding: voice.embedding
        });
        this.loadedVoice = voice.id;
      }
      // The message callback produces chunks while the async iterator consumes them.
      const queue: Float32Array[] = [];
      let done = false;
      let failure: Error | undefined;
      let wake = () => {};
      this.stream = m => {
        if (m.type === 'audio_chunk' && m.data) queue.push(m.data);
        if (m.type === 'stream_ended') done = true;
        if (m.type === 'error') {
          failure = Error(m.error);
          done = true;
        }
        wake();
      };
      this.worker!.postMessage({
        type: 'generate',
        data: {
          text,
          voice: 'custom',
          options: voice.generationSettings
        }
      });
      while (!done || queue.length) {
        if (failure) throw failure;
        if (queue.length) yield queue.shift()!;else await new Promise<void>(r => {
          wake = r;
        });
      }
      if (failure) throw failure;
      completed = true;
    } finally {
      this.stream = undefined;
      this.busy = false;
      if (!completed && epoch === this.epoch) await this.dispose();
    }
  }
  /** Cancels pending operations and terminates the worker to reclaim its complete WASM heap. */
  async dispose(): Promise<void> {
    this.epoch++;
    this.stream?.({
      type: 'error',
      error: 'Operation cancelled.'
    });
    this.pending?.reject(Error('Operation cancelled.'));
    this.pending = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.resourceState = 'not-loaded';
    this.loading = undefined;
    this.loadedVoice = undefined;
    this.busy = false;
  }
}
