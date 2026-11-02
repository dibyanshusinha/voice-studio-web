import type {GenerationSettings} from './generation-settings';
import type {PreviewAudioSettings} from './preview-audio';
/** Shared contracts for model bundles, persisted speaker embeddings and the inference adapter. */
/** Bundles whose tokenizer and tensor metadata match the shipped worker. */
export type PocketBundle = 'english_2026-04' | 'german' | 'italian' | 'portuguese' | 'spanish';
/** Persisted speaker identity: stores model embeddings instead of retaining the original recording. */
export type VoiceProfile = {
  id: string;
  name: string;
  createdAt: number;
  /** Prevents restoring an embedding into a different language model. */
  bundle: PocketBundle;
  /** Optional output defaults; older profiles use neutral settings without migration. */
  previewSettings?: PreviewAudioSettings;
  /** Model sampling defaults apply only to newly generated speech. */
  generationSettings?: GenerationSettings;
  embedding: {
    data: Float32Array;
    shape: number[];
  };
};
/** Stable adapter API; consumers never need to handle worker messages or ONNX tensors. */
export interface PocketTTSEngine {
  /** Loads model resources on demand; repeated calls share the same initialization. */
  initialize(): Promise<void>;
  /** Creates a reusable embedding from browser-decodable reference audio. */
  cloneVoice(audio: Blob, options?: {
    name?: string;
  }): Promise<VoiceProfile>;
  /** Yields mono 24 kHz PCM chunks for incremental playback or export. */
  synthesize(text: string, voice: VoiceProfile): AsyncIterable<Float32Array>;
  /** Cancels outstanding work and releases the worker and its model heap. */
  dispose(): Promise<void>;
}
