/** Audio-thread playback bridge: queues PCM and uses a worklet ring buffer to tolerate inference pauses. */
// Modified for Voice Studio. Third-party MIT notice: /licenses/audio-components-MIT.txt
import { EventEmitter, CustomEvent } from './event-emitter.js';
/**
 * PCMPlayerWorklet - AudioWorklet-based streaming PCM player
 * Uses dynamic buffer management with backpressure for smooth playback
 */
export class PCMPlayerWorklet extends EventEmitter {
  /** Initializes playback nodes, buffering state and asynchronous worklet setup. */
  constructor(audioContext, options = {}) {
    super();
    this.audioContext = audioContext;
    this.options = options;
    this.workletNode = null;
    this.isInitialized = false;
    this.playbackTime = 0;
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.options.destination || this.audioContext.destination);
    this.analyser = this.audioContext.createAnalyser();
    this.gainNode.connect(this.analyser);
    this.pendingChunks = [];
    this.availableCapacity = 0;
    this.isWorkletReady = false;
    this.hasReceivedInitialCapacity = false;
    this.metrics = {
      chunksPlayed: 0,
      underruns: 0,
      bufferLevel: 0,
      samplesPlayed: 0
    };
    this.initPromise = this.initializePlayback();
  }
  /** Creates the ring-buffer worklet and establishes capacity reporting before playback begins. */
  async initializePlayback() {
    if (this.isInitialized) return;
    try {
      const sampleRate = this.audioContext.sampleRate;
      const minBufferMs = this.options.minBufferBeforePlaybackMs || 300;
      const minBufferSamples = Math.floor(minBufferMs * sampleRate / 1000);
      const bufferSizeSamples = sampleRate * 60;
      const processorCode = `
        class PCMProcessor extends AudioWorkletProcessor {
          // Allocates the audio-thread ring buffer and connects its message protocol.
          constructor() {
            super();
            this.bufferSize = ${bufferSizeSamples};
            this.ringBuffer = new Float32Array(this.bufferSize);
            this.readPos = 0;
            this.writePos = 0;
            this.isPlaying = false;
            this.minBufferSamples = ${minBufferSamples};
            this.targetBufferSamples = ${minBufferSamples * 2};
            this.streamEnded = false;
            this.playbackCompleteReported = false;
            this.frameCount = 0;
            this.reportInterval = 256;

            this.port.onmessage = (e) => {
              switch(e.data.type) {
                case 'audio': this.addAudio(e.data.data); break;
                case 'reset': this.resetPlaybackBuffer(); break;
                case 'stream-ended': this.streamEnded = true; this.isPlaying = true; break;
                case 'request-capacity': this.sendCapacityUpdate(); break;
              }
            };
            this.sendCapacityUpdate();
          }

          // Copies received PCM into the ring and starts playback once enough audio is buffered.
          addAudio(float32Data) {
            const samples = float32Data.length;
            const available = this.getAvailableSpace();
            if (samples > available) {
              const overflow = samples - available;
              this.readPos = (this.readPos + overflow) % this.bufferSize;
            }
            if (this.writePos + samples <= this.bufferSize) {
              this.ringBuffer.set(float32Data, this.writePos);
              this.writePos += samples;
              if (this.writePos >= this.bufferSize) this.writePos = 0;
            } else {
              const firstPart = this.bufferSize - this.writePos;
              const secondPart = samples - firstPart;
              this.ringBuffer.set(float32Data.slice(0, firstPart), this.writePos);
              this.ringBuffer.set(float32Data.slice(firstPart), 0);
              this.writePos = secondPart;
            }
            const buffered = this.getBufferedSamples();
            if (!this.isPlaying && buffered >= this.minBufferSamples) {
              this.isPlaying = true;
              this.port.postMessage({ type: 'playback-started', buffered, audioTime: currentTime });
            }
            this.sendCapacityUpdate();
          }

          // Reserves one render quantum so queued samples do not overwrite unread audio.
          getAvailableSpace() {
            return this.bufferSize - this.getBufferedSamples() - 128;
          }

          // Counts unread samples across ring-buffer wraparound.
          getBufferedSamples() {
            return this.writePos >= this.readPos
              ? this.writePos - this.readPos
              : this.bufferSize - this.readPos + this.writePos;
          }

          // Reports free space so the main-thread queue can apply backpressure.
          sendCapacityUpdate() {
            const buffered = this.getBufferedSamples();
            const capacity = this.getAvailableSpace();
            let requestSamples = 0;
            if (buffered < this.targetBufferSamples) {
              requestSamples = Math.min(capacity, this.targetBufferSamples - buffered);
            }
            this.port.postMessage({ type: 'capacity', buffered, capacity, requestSamples, isPlaying: this.isPlaying });
          }

          // Web Audio render callback: drains one output block and reports underruns or stream completion.
          process(inputs, outputs) {
            const output = outputs[0];
            if (!output || !output[0]) return true;
            const outputChannel = output[0];
            const numSamples = outputChannel.length;
            if (++this.frameCount % this.reportInterval === 0) this.sendCapacityUpdate();
            if (!this.isPlaying) { outputChannel.fill(0); return true; }
            const buffered = this.getBufferedSamples();
            if (buffered < numSamples) {
              let samplesRead = 0;
              if (buffered > 0) {
                if (this.readPos + buffered <= this.bufferSize) {
                  for (let i = 0; i < buffered; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                  this.readPos += buffered;
                  if (this.readPos >= this.bufferSize) this.readPos = 0;
                } else {
                  const fp = this.bufferSize - this.readPos;
                  const sp = buffered - fp;
                  for (let i = 0; i < fp; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                  for (let i = 0; i < sp; i++) outputChannel[fp + i] = this.ringBuffer[i];
                  this.readPos = sp;
                }
                samplesRead = buffered;
              }
              for (let i = samplesRead; i < numSamples; i++) outputChannel[i] = 0;
              if (this.streamEnded && buffered === 0) {
                if (!this.playbackCompleteReported) {
                  this.port.postMessage({ type: 'playback-complete' });
                  this.playbackCompleteReported = true;
                }
                this.isPlaying = false;
                this.streamEnded = false;
              } else {
                this.port.postMessage({ type: 'underrun', buffered, needed: numSamples });
                this.sendCapacityUpdate();
              }
            } else {
              if (this.readPos + numSamples <= this.bufferSize) {
                for (let i = 0; i < numSamples; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                this.readPos += numSamples;
                if (this.readPos >= this.bufferSize) this.readPos = 0;
              } else {
                const fp = this.bufferSize - this.readPos;
                const sp = numSamples - fp;
                for (let i = 0; i < fp; i++) outputChannel[i] = this.ringBuffer[this.readPos + i];
                for (let i = 0; i < sp; i++) outputChannel[fp + i] = this.ringBuffer[i];
                this.readPos = sp;
              }
            }
            return true;
          }

          // Clears ring state before a new stream or an explicit stop.
          resetPlaybackBuffer() {
            this.readPos = 0;
            this.writePos = 0;
            this.ringBuffer.fill(0);
            this.isPlaying = false;
            this.streamEnded = false;
            this.playbackCompleteReported = false;
            this.sendCapacityUpdate();
          }
        }
        registerProcessor('pcm-processor', PCMProcessor);
      `;
      const blob = new Blob([processorCode], {
        type: 'application/javascript'
      });
      const workletUrl = URL.createObjectURL(blob);
      await this.audioContext.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');
      this.workletNode.connect(this.gainNode);
      this.workletNode.port.onmessage = e => {
        switch (e.data.type) {
          case 'capacity':
            this.updateAvailablePlaybackCapacity(e.data);
            break;
          case 'underrun':
            this.metrics.underruns++;
            this.flushQueuedAudioChunks();
            break;
          case 'playback-started':
            this.emit('firstPlayback', {
              startTime: this.audioContext.currentTime,
              bufferedSamples: e.data.buffered
            });
            break;
          case 'playback-complete':
            this.emit('audioEnded', {
              endTime: this.audioContext.currentTime
            });
            break;
        }
      };
      // The processor constructor sends an initial capacity message, but it arrives
      // before port.onmessage is set above — so it's lost. Request a fresh one,
      // and bootstrap capacity so enqueueAudioChunk() works immediately without waiting
      // for the round-trip response.
      this.workletNode.port.postMessage({
        type: 'request-capacity'
      });
      this.hasReceivedInitialCapacity = true;
      this.availableCapacity = bufferSizeSamples - 128;
      this.isInitialized = true;
      this.isWorkletReady = true;
    } catch (error) {
      console.error('Failed to initialize PCMPlayerWorklet:', error);
      throw error;
    }
  }
  /** Tracks audio-thread capacity so pending chunks can be sent without overflowing the ring buffer. */
  updateAvailablePlaybackCapacity(data) {
    this.availableCapacity = data.capacity;
    this.metrics.bufferLevel = data.buffered;
    if (!this.hasReceivedInitialCapacity) {
      this.hasReceivedInitialCapacity = true;
      if (this.pendingChunks.length > 0) this.flushQueuedAudioChunks();
    }
    if (data.requestSamples > 0 && this.pendingChunks.length > 0) this.flushQueuedAudioChunks();
  }
  /** Drains queued PCM as capacity allows and sends the end marker only after all queued samples. */
  flushQueuedAudioChunks() {
    if (!this.isWorkletReady || this.pendingChunks.length === 0 || this.availableCapacity <= 0) return;
    // Drain as many pending chunks as capacity allows. This is critical on
    // iOS where inference blocks the main thread — we can't wait for
    // round-trip capacity updates from the audio thread between chunks.
    while (this.pendingChunks.length > 0 && this.availableCapacity > 0) {
      const chunk = this.pendingChunks[0];
      if (chunk.length <= this.availableCapacity) {
        this.pendingChunks.shift();
        this.workletNode.port.postMessage({
          type: 'audio',
          data: chunk
        });
        this.availableCapacity -= chunk.length;
      } else if (this.availableCapacity > 4096) {
        const partial = chunk.slice(0, this.availableCapacity);
        this.pendingChunks[0] = chunk.slice(this.availableCapacity);
        this.workletNode.port.postMessage({
          type: 'audio',
          data: partial
        });
        this.availableCapacity = 0;
      } else {
        break;
      }
    }
    if (this.pendingChunks.length === 0 && this.pendingStreamEnd) {
      this.workletNode.port.postMessage({
        type: 'stream-ended'
      });
      this.pendingStreamEnd = false;
    }
  }
  /** Queues streamed samples until playback is initialized and the audio thread has room. */
  enqueueAudioChunk(data) {
    if (!this.isInitialized) {
      if (!this.initPendingQueue) {
        this.initPendingQueue = [];
        this.initPromise.then(() => {
          const queue = this.initPendingQueue;
          this.initPendingQueue = null;
          for (const queuedData of queue) this.enqueueAudioChunk(queuedData);
        });
      }
      this.initPendingQueue.push(data);
      return;
    }
    if (this.audioContext.state !== 'running') return;
    const float32Array = data instanceof Int16Array ? this.convertPcm16ToFloat32(data) : data;
    this.pendingChunks.push(float32Array);
    if (this.hasReceivedInitialCapacity && this.availableCapacity > 0) this.flushQueuedAudioChunks();
    this.metrics.chunksPlayed++;
    const duration = float32Array.length / this.audioContext.sampleRate;
    this.playbackTime = this.audioContext.currentTime + duration;
    this.emit('audioStarted', {
      startTime: this.audioContext.currentTime,
      duration,
      samples: float32Array.length
    });
  }
  /** Marks the last chunk so the worklet can drain and play even a short final stream. */
  finishAudioStream() {
    if (this.pendingChunks.length > 0) {
      this.pendingStreamEnd = true;
    } else if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'stream-ended'
      });
    }
  }
  /** Normalizes signed 16-bit samples for the floating-point Web Audio pipeline. */
  convertPcm16ToFloat32(pcm16) {
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;
    return float32;
  }
  /** Clears pending audio and resets buffer accounting so a later stream starts without stale samples. */
  resetPlaybackBuffer() {
    this.playbackTime = 0;
    this.pendingChunks = [];
    this.pendingStreamEnd = false;
    if (this.workletNode) {
      this.workletNode.port.postMessage({
        type: 'reset'
      });
      this.workletNode.port.postMessage({
        type: 'request-capacity'
      });
    }
    // After reset the worklet buffer is empty — bootstrap capacity so
    // enqueueAudioChunk() can send chunks immediately without waiting for the
    // round-trip capacity response.
    this.availableCapacity = this.audioContext.sampleRate * 60 - 128;
    if (this.gainNode) {
      const now = this.audioContext.currentTime;
      this.gainNode.gain.setValueAtTime(this.gainNode.gain.value, now);
      this.gainNode.gain.linearRampToValueAtTime(0, now + 0.05);
      setTimeout(() => {
        this.gainNode.gain.value = 1;
      }, 100);
    }
  }
  /** Closes the worklet message port and disconnects nodes when playback is replaced or unmounted. */
  releasePlaybackResources() {
    this.pendingChunks = [];
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.port.close();
      this.workletNode.disconnect();
    }
    this.gainNode.disconnect();
    this.analyser.disconnect();
  }
  /** Stops queued playback through the shared buffer-reset path. */
  stopPlayback() {
    this.resetPlaybackBuffer();
  }
  /** Resumes a suspended audio context after a user gesture when the browser requires it. */
  async resumePlayback() {
    if (this.audioContext.state === 'suspended') await this.audioContext.resumePlayback();
  }
  /** Returns the current playback gain without modifying audio state. */
  get volume() {
    return this.gainNode.gain.value;
  }
  /** Clamps playback gain to the supported range and notifies volume subscribers. */
  set volume(value) {
    const v = Math.max(0, Math.min(1, value));
    this.gainNode.gain.value = v;
    this.emit('volumeChange', {
      volume: v
    });
  }
  /** Exposes frequency samples to consumers that need a playback visualization. */
  readFrequencySpectrum() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);
    return dataArray;
  }
  /** Exposes time-domain samples to consumers that need a waveform visualization. */
  readWaveformSamples() {
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);
    return dataArray;
  }
  /** Reports buffering and timing metrics for diagnosing underruns and playback progress. */
  getPlaybackSnapshot() {
    const bufferMs = this.metrics.bufferLevel ? this.metrics.bufferLevel / this.audioContext.sampleRate * 1000 : 0;
    return {
      currentTime: this.audioContext.currentTime,
      scheduledTime: this.playbackTime,
      bufferedDuration: bufferMs / 1000,
      state: this.audioContext.state,
      worklet: {
        bufferLevelSamples: this.metrics.bufferLevel,
        bufferLevelMs: bufferMs,
        underruns: this.metrics.underruns,
        chunksPlayed: this.metrics.chunksPlayed,
        pendingChunks: this.pendingChunks.length
      }
    };
  }
}
