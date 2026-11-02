/** Sound-processing tests cover backward-compatible defaults and a shared graph for live/export rendering. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

/** Runs the real DSP configuration module with controllable Web Audio nodes, without a browser or inference models. */
function loadAudioSettings(context = {}) {
  const source = readFileSync(new URL('../src/voices/preview-audio.ts', import.meta.url), 'utf8');
  const sandbox = {exports:{}, ...context};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText, sandbox);
  return sandbox.exports;
}

test('existing profiles use neutral sound; invalid persisted parameters are bounded', () => {
  const api = loadAudioSettings();
  const defaults = api.normalizePreviewSettings();
  assert.equal(defaults.volume, 1); assert.equal(defaults.bassDb, 0); assert.equal(defaults.lowCutHz, 0);
  const bounded = api.normalizePreviewSettings({volume:Infinity, bassDb:99, trebleDb:-99, lowCutHz:999});
  assert.equal(bounded.volume, 1); assert.equal(bounded.bassDb, 6); assert.equal(bounded.trebleDb, -6); assert.equal(bounded.lowCutHz, 160);
});

test('neutral sound preserves raw generated PCM without a second allocation or offline context', async () => {
  const api = loadAudioSettings(); const chunks = [new Float32Array([0.1, -0.1])];
  assert.equal(await api.renderPreviewAudio(chunks, api.DEFAULT_PREVIEW_SETTINGS), chunks);
});

/** Implements Web Audio node/parameter surfaces so the actual graph can be checked without native rendering. */
function mockAudioContext() {
  const nodes=[];
  const parameter=()=>({value:0,setValueAtTime(v){this.value=v;},cancelScheduledValues(){},setTargetAtTime(v){this.value=v;}});
  const createNode=()=>{const node={frequency:parameter(),Q:parameter(),gain:parameter(),threshold:parameter(),knee:parameter(),ratio:parameter(),attack:parameter(),release:parameter(),delayTime:parameter(),targets:[],connect(target){this.targets.push(target);},disconnect(){}};nodes.push(node);return node;};
  return {nodes,currentTime:0,sampleRate:24000,destination:{},createBiquadFilter:createNode,createGain:createNode,createDynamicsCompressor:createNode,createDelay:createNode,createConvolver:createNode,createWaveShaper:createNode,
    createBuffer:(_channels,length)=>{const data=new Float32Array(length);return {getChannelData:()=>data};}};
}

test('advanced graph reserves EQ headroom, configures dynamics and bounds peak-limiter output',()=>{
  const api=loadAudioSettings(),context=mockAudioContext();
  const graph=api.createPreviewAudioGraph(context,{...api.DEFAULT_PREVIEW_SETTINGS,bassDb:6,midDb:2,compression:0.5,deEss:0.5,limiter:true,reverb:0.2,lowCutHz:80});
  assert.equal(graph.input.frequency.value,80);
  assert.equal(context.nodes.find(node=>node.type==='lowshelf').gain.value,6);
  assert.equal(context.nodes.find(node=>node.type==='peaking').gain.value,2);
  const compressors=context.nodes.filter(node=>node.ratio.value>1);
  assert.equal(compressors.length,2);
  const limiter=context.nodes.find(node=>node.curve);
  assert.ok(Math.max(...limiter.curve)<1);assert.ok(Math.min(...limiter.curve)>-1);
  const room=context.nodes.find(node=>node.buffer);assert.ok(room.buffer.getChannelData(0).some(value=>value!==0));
  graph.applySettings(api.DEFAULT_PREVIEW_SETTINGS);
  assert.equal(context.nodes.find(node=>node.type==='lowshelf').gain.value,0);
  assert.equal(graph.input.frequency.value,0);
});

test('live preview reuses its media source and playback position across slider updates and replay', async () => {
  let sources=0,resumes=0,closed=0;
  const context=mockAudioContext(),nodes=context.nodes;
  class Context {
    constructor(){Object.assign(this,context);}
    createMediaElementSource(){sources++;return {connect(){},disconnect(){}};}
    async resume(){resumes++;}
    async close(){closed++;}
  }
  const media={currentTime:7,pause(){}};
  const refs=[];const effects=[];let cursor=0;const pending=[];
  const react={
    useRef(initial){const at=cursor++;return refs[at] ||= {current:initial};},
    useEffect(effect,deps){const at=cursor++;const old=effects[at];if(!old || deps.some((value,i)=>!Object.is(value,old.deps[i])))pending.push(()=>{old?.cleanup?.();effects[at]={deps,cleanup:effect()};});},
    createElement(type,props){props.ref.current=media;return {type,props};},
  };
  const audio=loadAudioSettings();
  const source=readFileSync(new URL('../src/voices/LiveAudioPreview.tsx',import.meta.url),'utf8');
  const sandbox={exports:{},AudioContext:Context,require:name=>name==='react'?{default:react,...react}:audio};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText,sandbox);
  const errors=[];
  const render=settings=>{cursor=0;const view=sandbox.exports.default({src:'blob:original',settings,onPlaybackStart(){},onError:e=>errors.push(e)});while(pending.length)pending.shift()();return view;};
  let view=render(audio.DEFAULT_PREVIEW_SETTINGS);
  await view.props.onPlay();
  // onPlay starts async work; resume resolves in a microtask.
  await Promise.resolve();
  view=render({...audio.DEFAULT_PREVIEW_SETTINGS,bassDb:4});
  assert.equal(view.props.src,'blob:original');assert.equal(media.currentTime,7);
  assert.equal(sources,1);assert.equal(nodes.find(node => node.type === 'lowshelf').gain.value,4);
  await view.props.onPlay();await Promise.resolve();
  assert.equal(sources,1);assert.equal(resumes,2);assert.equal(errors.length,0);
  for(const effect of effects)effect?.cleanup?.();
  assert.equal(closed,1);
});

test('speed and pitch editing changes duration independently and retains finite PCM',()=>{
  const source=readFileSync(new URL('../src/voices/audio-time-stretch.ts',import.meta.url),'utf8');
  const context={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const input=Float32Array.from({length:24000},(_,i)=>0.5*Math.sin(2*Math.PI*440*i/24000));
  const edited=context.exports.adjustPcmSpeedAndPitch(input,1.25,0);
  assert.equal(edited.length,19200);assert.ok(edited.every(Number.isFinite));
  const shifted=context.exports.adjustPcmSpeedAndPitch(input,1,3);
  assert.ok(Math.abs(shifted.length-input.length)<3);
  let crossings=0;for(let i=2401;i<shifted.length-2400;i++)if(shifted[i-1]<=0&&shifted[i]>0)crossings++;
  const frequency=crossings/((shifted.length-4800)/24000);
  assert.ok(Math.abs(frequency-440*Math.pow(2,3/12))<25,`Measured frequency ${frequency}`);
  assert.throws(()=>context.exports.adjustPcmSpeedAndPitch(input,5,0),/Unsupported/);
});

test('generation defaults remain compatible and invalid sampling settings are clamped',()=>{
  const source=readFileSync(new URL('../src/voices/generation-settings.ts',import.meta.url),'utf8');
  const context={exports:{}};vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  assert.equal(context.exports.normalizeGenerationSettings().temperature,0.7);
  assert.equal(context.exports.normalizeGenerationSettings().samplingSteps,1);
  const values=context.exports.normalizeGenerationSettings({temperature:99,samplingSteps:99});
  assert.equal(values.temperature,1.2);assert.equal(values.samplingSteps,4);
});
