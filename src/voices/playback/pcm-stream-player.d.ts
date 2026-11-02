/** TypeScript boundary for the adapted JavaScript playback module; keep signatures aligned with its implementation. */
export class PCMPlayerWorklet {
  /** Initializes playback nodes, buffering state and asynchronous worklet setup. */
  constructor(context: AudioContext, options?: {
    minBufferBeforePlaybackMs?: number;
    /** Optional processing graph used to shape streaming audio before output. */
    destination?: AudioNode;
  });
  readonly initPromise: Promise<void>;
  /** Queues streamed samples until playback is initialized and the audio thread has room. */
  enqueueAudioChunk(data: Float32Array): void;
  /** Marks the last chunk so the worklet can drain and play even a short final stream. */
  finishAudioStream(): void;
  /** Closes the worklet message port and disconnects nodes when playback is replaced or unmounted. */
  releasePlaybackResources(): void;
}
