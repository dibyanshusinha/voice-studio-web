/** Per-voice preview controls distinguish live DSP, completed-clip edits and model regeneration. */
import React,{useId} from 'react';
import {DEFAULT_PREVIEW_SETTINGS,type PreviewAudioSettings} from './preview-audio';
import {DEFAULT_GENERATION_SETTINGS,type GenerationSettings} from './generation-settings';

/** Hover, keyboard focus or a tap reveals the processing cost without misleading users about regeneration. */
function SettingInfo({description,kind}:{description:string;kind:'live'|'edit'|'generate'}) {
  const id=useId();
  const requirement=kind==='generate'?'Will require regeneration':kind==='edit'?'Requires audio reprocessing; no model regeneration. Completed preview restarts.':'Applies live; no regeneration required.';
  return <span className="setting-info"><button type="button" aria-label={`Info: ${description}`} aria-describedby={id}>i</button><span className="setting-tooltip" role="tooltip" id={id}>{description}<br/><strong>{requirement}</strong></span></span>;
}

/** Exposes bounded audio controls and model sampling settings while retaining explicit per-voice save/reset. */
export default function PreviewSettings({value,generation,disabled,canSave,generating,onChange,onGenerationChange,onSave}:{
  value:PreviewAudioSettings;generation:GenerationSettings;disabled:boolean;canSave:boolean;generating:boolean;
  onChange:(settings:PreviewAudioSettings)=>void;onGenerationChange:(settings:GenerationSettings)=>void;onSave:()=>void;
}) {
  /** Renders consistent labels and info controls; range inputs remain explicitly associated with their labels. */
  function range(key:Exclude<keyof PreviewAudioSettings,'limiter'>,label:string,min:number,max:number,step:number,description:string,kind:'live'|'edit'='live',unit='') {
    return <div className="preview-setting"><div className="setting-label"><label htmlFor={`preview-${key}`}>{label}</label><SettingInfo description={description} kind={kind}/><output htmlFor={`preview-${key}`}>{value[key]}{unit}</output></div>
      <input id={`preview-${key}`} aria-label={label} type="range" min={min} max={max} step={step} value={value[key]} disabled={disabled||(kind==='edit'&&generating)} onChange={e=>onChange({...value,[key]:Number(e.target.value)})}/></div>;
  }
  return <details className="preview-settings" open><summary>Preview settings</summary>
    <p className="muted">Sound controls apply live. Speed/pitch reprocess the completed preview. Hover or tap an info icon for details.</p>
    <div className="preview-settings-grid">
      {range('volume','Volume',0,1.5,0.05,'Output level, where 1 is normal volume.')}
      {range('bassDb','Bass / warmth',-6,6,1,'Low-frequency tonal balance.','live',' dB')}
      {range('trebleDb','Treble / brightness',-6,6,1,'High-frequency tonal balance.','live',' dB')}
      <div className="preview-setting"><div className="setting-label"><label htmlFor="preview-lowcut">Low-frequency cleanup</label><SettingInfo kind="live" description="Reduces low rumble; stronger settings may thin the voice."/></div><select id="preview-lowcut" value={value.lowCutHz} disabled={disabled} onChange={e=>onChange({...value,lowCutHz:Number(e.target.value)})}><option value="0">Off</option><option value="80">Light · 80 Hz</option><option value="120">Stronger · 120 Hz</option></select></div>
    </div>
    <details className="preview-advanced"><summary>Advanced sound controls</summary><div className="preview-settings-grid">
      {range('midDb','Midrange',-6,6,1,'Adjusts the body of speech around 1 kHz.','live',' dB')}
      {range('presenceDb','Presence / clarity',-6,6,1,'Adjusts articulation around 2.8 kHz.','live',' dB')}
      {range('compression','Compression',0,1,0.1,'Reduces differences between quiet and loud speech; may change loudness.')}
      {range('deEss','De-esser',0,1,0.1,'Compresses the high-frequency band to soften strong sibilants; results depend on the voice.')}
      {range('reverb','Room / reverb',0,0.5,0.05,'Adds a short synthetic room; zero is dry speech.')}
      <div className="preview-setting"><div className="setting-label"><label htmlFor="preview-limiter">Peak limiter</label><SettingInfo kind="live" description="Clamps output peaks near full scale. Strong limiting can distort; lower volume if needed."/></div><label className="consent"><input id="preview-limiter" type="checkbox" checked={value.limiter} disabled={disabled} onChange={e=>onChange({...value,limiter:e.target.checked})}/> Limit peaks</label></div>
      {range('speed','Speech speed',0.75,1.5,0.05,'Time stretching changes duration while aiming to preserve pitch; extreme edits may sound less natural.','edit','×')}
      {range('pitchSemitones','Pitch',-6,6,1,'Shifts pitch independently of duration using resampling and time stretching; this does not change the voice identity model.','edit',' st')}
    </div></details>
    <details className="preview-advanced"><summary>Generation controls</summary><div className="preview-settings-grid">
      <div className="preview-setting"><div className="setting-label"><label htmlFor="generation-temperature">Variation</label><SettingInfo kind="generate" description="Sampling temperature changes variation in newly synthesized speech; it is not an emotion control."/><output>{generation.temperature}</output></div><input id="generation-temperature" type="range" min="0.1" max="1.2" step="0.1" value={generation.temperature} disabled={disabled||generating} onChange={e=>onGenerationChange({...generation,temperature:Number(e.target.value)})}/></div>
      <div className="preview-setting"><div className="setting-label"><label htmlFor="generation-steps">Sampling steps</label><SettingInfo kind="generate" description="More flow steps cost more CPU time and may change quality; improvement is not guaranteed."/></div><select id="generation-steps" value={generation.samplingSteps} disabled={disabled||generating} onChange={e=>onGenerationChange({...generation,samplingSteps:Number(e.target.value)})}>{[1,2,3,4].map(n=><option key={n} value={n}>{n} {n===1?'· fastest':''}</option>)}</select></div>
    </div><p className="muted">Changes here apply the next time you generate speech.</p></details>
    <div className="actions"><button disabled={disabled||!canSave} onClick={onSave}>Save defaults for this voice</button><button disabled={disabled} onClick={()=>{onChange({...DEFAULT_PREVIEW_SETTINGS});if(!generating)onGenerationChange({...DEFAULT_GENERATION_SETTINGS});}}>Reset settings</button></div>
    <p className="muted">EQ boosts reserve headroom. Speed/pitch apply to completed audio; they do not rerun the model. These effects are not full noise removal.</p>
  </details>;
}
