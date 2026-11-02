/** Applies completed-clip speed/pitch edits off the React thread; cancellation terminates this worker. */
import {adjustPcmSpeedAndPitch} from './audio-time-stretch';
self.onmessage = ({data}: MessageEvent<{pcm: Float32Array; speed: number; pitchSemitones: number}>) => {
  try {
    const pcm = adjustPcmSpeedAndPitch(data.pcm, data.speed, data.pitchSemitones);
    self.postMessage({pcm}, {transfer:[pcm.buffer]});
  } catch (reason) {self.postMessage({error:String(reason)});}
};
