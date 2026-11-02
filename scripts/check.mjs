/** Fast repository-layout check for required application and worker entry points. */
import { existsSync } from 'node:fs';
for (const p of ['src/main.tsx', 'src/App.tsx', 'src/voices/voice-engine.ts', 'public/audio-runtime/speech-inference.worker.js']) if (!existsSync(p)) throw Error('Missing ' + p);
console.log('Native engine files present.');
