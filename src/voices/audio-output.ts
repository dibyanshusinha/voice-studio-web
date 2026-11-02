/** Audio output utilities shared by streaming playback and downloadable WAV generation. */
/** Wraps streamed mono PCM in a 16-bit WAV container for local replay and download. */
export function encodePcmChunksAsWav(chunks: Float32Array[], sampleRate = 24000): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  // Mono PCM16 uses two bytes per sample after the standard 44-byte WAV header.
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  /** Writes the fixed ASCII chunk identifiers required by WAV readers. */
  const writeWavHeaderTag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  writeWavHeaderTag(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  writeWavHeaderTag(8, 'WAVE');
  writeWavHeaderTag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeWavHeaderTag(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const value of chunk) {
    const v = Math.max(-1, Math.min(1, value));
    view.setInt16(offset, v * (v < 0 ? 32768 : 32767), true);
    offset += 2;
  }
  return new Blob([buffer], {
    type: 'audio/wav'
  });
}
/** Only the playback lifecycle needed by React; worklet internals remain behind this boundary. */
export type Player = {
  initPromise: Promise<void>;
  enqueueAudioChunk: (data: Float32Array) => void;
  finishAudioStream: () => void;
  releasePlaybackResources: () => void;
};
/** Lazily loads the playback module and waits for its AudioWorklet before accepting streamed audio. */
export async function createStreamingAudioPlayer(context: AudioContext, destination?: AudioNode): Promise<Player> {
  const {
    PCMPlayerWorklet
  } = await import('./playback/pcm-stream-player.js');
  const player: Player = new PCMPlayerWorklet(context, {destination});
  await player.initPromise;
  return player;
}
