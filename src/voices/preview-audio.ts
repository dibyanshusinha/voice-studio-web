/** Local sound shaping shared by streaming preview and WAV rendering; does not alter speaker conditioning. */
export type PreviewAudioSettings = {
  volume: number; bassDb: number; midDb: number; presenceDb: number; trebleDb: number; lowCutHz: number;
  compression: number; limiter: boolean; deEss: number; reverb: number; speed: number; pitchSemitones: number;
};
export const DEFAULT_PREVIEW_SETTINGS: PreviewAudioSettings = {
  volume:1,bassDb:0,midDb:0,presenceDb:0,trebleDb:0,lowCutHz:0,compression:0,limiter:false,deEss:0,reverb:0,speed:1,pitchSemitones:0,
};

/** Bounds persisted parameters and supplies defaults for profiles saved before advanced controls existed. */
export function normalizePreviewSettings(value?: Partial<PreviewAudioSettings>): PreviewAudioSettings {
  const clamp = (v: unknown, fallback: number, low: number, high: number) => typeof v === 'number' && Number.isFinite(v) ? Math.min(high, Math.max(low, v)) : fallback;
  return {volume:clamp(value?.volume,1,0,1.5),bassDb:clamp(value?.bassDb,0,-6,6),midDb:clamp(value?.midDb,0,-6,6),
    presenceDb:clamp(value?.presenceDb,0,-6,6),trebleDb:clamp(value?.trebleDb,0,-6,6),lowCutHz:clamp(value?.lowCutHz,0,0,160),
    compression:clamp(value?.compression,0,0,1),limiter:value?.limiter === true,deEss:clamp(value?.deEss,0,0,1),
    reverb:clamp(value?.reverb,0,0,0.5),speed:clamp(value?.speed,1,0.75,1.5),pitchSemitones:clamp(value?.pitchSemitones,0,-6,6)};
}

/** Deterministic synthetic room impulse keeps preview/export consistent without downloading room assets. */
function createRoomImpulse(context: BaseAudioContext) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0); let seed = 1937;
  for (let i=0;i<data.length;i++) {seed = (Math.imul(seed,1664525)+1013904223)>>>0;data[i]=((seed/4294967296)*2-1)*Math.pow(1-i/data.length,3);}
  return buffer;
}

/** Routes EQ, split-band de-essing, dynamics, room ambience and a final peak clamp through one shared graph. */
export function createPreviewAudioGraph(context: BaseAudioContext, settings: PreviewAudioSettings) {
  const nodes: AudioNode[] = [];
  const gainNode = () => {const node=context.createGain();nodes.push(node);return node;};
  const filter = (type:BiquadFilterType, frequency:number) => {const node=context.createBiquadFilter();node.type=type;node.frequency.value=frequency;nodes.push(node);return node;};
  const lowCut=filter('highpass',0);lowCut.Q.value=0.707;
  const bass=filter('lowshelf',200), mid=filter('peaking',1000), presence=filter('peaking',2800), treble=filter('highshelf',4500);
  mid.Q.value=0.8;presence.Q.value=0.8;
  lowCut.connect(bass);bass.connect(mid);mid.connect(presence);presence.connect(treble);
  const deEssDry=gainNode(), deEssWet=gainNode(), lowBand=filter('lowpass',4500), highBand=filter('highpass',4500);
  lowBand.Q.value=highBand.Q.value=0.707;
  const highCompressor=context.createDynamicsCompressor();nodes.push(highCompressor);
  highCompressor.threshold.value=-30;highCompressor.knee.value=12;highCompressor.attack.value=0.002;highCompressor.release.value=0.06;
  const lowDelay=context.createDelay(0.02);lowDelay.delayTime.value=0.006;nodes.push(lowDelay);
  const sum=gainNode();treble.connect(deEssDry);deEssDry.connect(sum);
  treble.connect(lowBand);lowBand.connect(lowDelay);lowDelay.connect(deEssWet);
  treble.connect(highBand);highBand.connect(highCompressor);highCompressor.connect(deEssWet);deEssWet.connect(sum);
  const compressor=context.createDynamicsCompressor();nodes.push(compressor);
  compressor.attack.value=0.01;compressor.release.value=0.15;compressor.knee.value=18;
  const dynamicsDry=gainNode(),dynamicsWet=gainNode(),roomInput=gainNode();
  sum.connect(dynamicsDry);dynamicsDry.connect(roomInput);sum.connect(compressor);compressor.connect(dynamicsWet);dynamicsWet.connect(roomInput);
  const dry=gainNode(),wet=gainNode(),reverb=context.createConvolver();nodes.push(reverb);
  reverb.buffer=createRoomImpulse(context);
  roomInput.connect(dry);roomInput.connect(reverb);reverb.connect(wet);
  const gain=gainNode();dry.connect(gain);wet.connect(gain);
  const limiter=context.createWaveShaper();nodes.push(limiter);
  const clampCurve=new Float32Array(4097);for(let i=0;i<clampCurve.length;i++)clampCurve[i]=Math.max(-0.98,Math.min(0.98,4*i/(clampCurve.length-1)-2));
  // Scale the curve domain back to [-1,1]; a preceding gain of 0.5 gives a +/-2 input range.
  const limiterInput=gainNode();limiterInput.gain.value=0.5;limiter.curve=clampCurve;limiter.oversample='2x';
  const bypass=gainNode(),limited=gainNode();gain.connect(bypass);bypass.connect(context.destination);
  gain.connect(limiterInput);limiterInput.connect(limiter);limiter.connect(limited);limited.connect(context.destination);

  /** Ramps live parameters; exact fixed values are used for offline export and initial playback. */
  function applySettings(next:PreviewAudioSettings,smooth=false) {
    const value=normalizePreviewSettings(next),time=context.currentTime;
    const set=(parameter:AudioParam,v:number)=>{if(smooth){parameter.cancelScheduledValues(time);parameter.setTargetAtTime(v,time,0.015);}else parameter.setValueAtTime(v,time);};
    set(lowCut.frequency,value.lowCutHz);set(bass.gain,value.bassDb);set(mid.gain,value.midDb);set(presence.gain,value.presenceDb);set(treble.gain,value.trebleDb);
    const headroom=Math.pow(10,-[value.bassDb,value.midDb,value.presenceDb,value.trebleDb].reduce((n,v)=>n+Math.max(0,v),0)/20);
    set(gain.gain,value.volume*headroom);
    set(deEssDry.gain,value.deEss>0?0:1);set(deEssWet.gain,value.deEss>0?1:0);set(highCompressor.ratio,1+value.deEss*7);
    set(compressor.threshold,-12-value.compression*18);set(compressor.ratio,1+value.compression*5);
    set(dynamicsDry.gain,value.compression>0?0:1);set(dynamicsWet.gain,value.compression>0?1:0);
    set(dry.gain,1-value.reverb);set(wet.gain,value.reverb);
    set(bypass.gain,value.limiter?0:1);set(limited.gain,value.limiter?1:0);
  }
  applySettings(settings);
  return {input:lowCut,applySettings,disconnect(){for(const node of nodes)node.disconnect();}};
}

/** Runs fixed tone/dynamics settings on already speed/pitch-processed PCM; includes the room tail in exports. */
export async function renderPreviewAudio(chunks:Float32Array[],settings:PreviewAudioSettings):Promise<Float32Array[]> {
  const value=normalizePreviewSettings(settings);
  if(Object.entries(DEFAULT_PREVIEW_SETTINGS).every(([key,defaultValue])=>key==='speed'||key==='pitchSemitones'||value[key as keyof PreviewAudioSettings]===defaultValue))return chunks;
  const length=chunks.reduce((n,chunk)=>n+chunk.length,0);if(!length)return [];
  const context=new OfflineAudioContext(1,length+(value.reverb>0?24000:0),24000),buffer=context.createBuffer(1,length,24000);
  let offset=0;for(const chunk of chunks){buffer.getChannelData(0).set(chunk,offset);offset+=chunk.length;}
  const source=context.createBufferSource();source.buffer=buffer;source.connect(createPreviewAudioGraph(context,value).input);source.start();
  return [(await context.startRendering()).getChannelData(0)];
}
