/** Model sampling controls affect newly generated PCM, never an already recorded preview. */
export type GenerationSettings = {temperature:number; samplingSteps:number};
export const DEFAULT_GENERATION_SETTINGS:GenerationSettings={temperature:0.7,samplingSteps:1};
/** Keeps persisted model controls within the supported CPU sampling budget. */
export function normalizeGenerationSettings(value?:Partial<GenerationSettings>):GenerationSettings {
  return {temperature:typeof value?.temperature==='number'&&Number.isFinite(value.temperature)?Math.min(1.2,Math.max(0.1,value.temperature)):0.7,
    samplingSteps:typeof value?.samplingSteps==='number'&&Number.isFinite(value.samplingSteps)?Math.min(4,Math.max(1,Math.round(value.samplingSteps))):1};
}
