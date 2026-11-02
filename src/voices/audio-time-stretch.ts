/** Browser-worker WSOLA time stretching: changes duration without deliberately shifting voice pitch. */
export function stretchPcmWithoutPitchChange(input: Float32Array, speed: number): Float32Array {
  if (speed === 1 || !input.length) return input;
  const length = Math.max(1, Math.round(input.length / speed));
  const output = new Float32Array(length);
  const weights = new Float32Array(length);
  const windowSize = Math.min(960, input.length);
  const hop = Math.max(1, Math.floor(windowSize / 4));
  const search = Math.min(120, Math.floor(windowSize / 8));
  let previousStart = 0;
  for (let position = 0; position < length; position += hop) {
    const nominal = Math.min(Math.max(0, input.length - windowSize), Math.round(position * speed));
    let bestStart = nominal;
    if (position > 0) {
      let bestScore = -Infinity;
      // Align overlapping waveforms near the desired analysis time to reduce phasing/echo.
      for (let candidate = Math.max(0, nominal - search); candidate <= Math.min(input.length - windowSize, nominal + search); candidate += 2) {
        let product = 0, referenceEnergy = 0, candidateEnergy = 0;
        for (let offset = 0; offset < windowSize - hop; offset += 4) {
          const a = input[previousStart + hop + offset] || 0;
          const b = input[candidate + offset];
          product += a * b; referenceEnergy += a * a; candidateEnergy += b * b;
        }
        const score = product / Math.sqrt(referenceEnergy * candidateEnergy + 1e-12);
        if (score > bestScore) {bestScore = score; bestStart = candidate;}
      }
    }
    for (let offset = 0; offset < windowSize && position + offset < length; offset++) {
      const weight = Math.max(1e-5, 0.5 - 0.5 * Math.cos(2 * Math.PI * offset / Math.max(1, windowSize - 1)));
      output[position + offset] += input[bestStart + offset] * weight;
      weights[position + offset] += weight;
    }
    previousStart = bestStart;
  }
  for (let i = 0; i < length; i++) if (weights[i]) output[i] /= weights[i];
  return output;
}

/** Resampling changes pitch; compensating WSOLA sets speed independently. Intended for modest speech edits. */
export function adjustPcmSpeedAndPitch(input: Float32Array, speed: number, pitchSemitones: number): Float32Array {
  if (!Number.isFinite(speed) || speed < 0.75 || speed > 1.5 || !Number.isFinite(pitchSemitones) || Math.abs(pitchSemitones) > 6) throw Error('Unsupported speed or pitch setting.');
  if (!input.length || (speed === 1 && pitchSemitones === 0)) return input;
  const pitchRatio = Math.pow(2, pitchSemitones / 12);
  if (pitchRatio === 1) return stretchPcmWithoutPitchChange(input, speed);
  const shifted = new Float32Array(Math.max(1, Math.round(input.length / pitchRatio)));
  for (let i = 0; i < shifted.length; i++) {
    const position = i * pitchRatio, index = Math.floor(position), fraction = position - index;
    shifted[i] = (input[index] || 0) * (1 - fraction) + (input[Math.min(index + 1, input.length - 1)] || 0) * fraction;
  }
  return stretchPcmWithoutPitchChange(shifted, speed / pitchRatio);
}
