/** Verifies the published artifact resolves under a repository subpath, without requiring a local web server. */
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const origin='https://dibyanshusinha.github.io';
const site=new URL('/voice-studio-web/',origin);
const html=readFileSync('dist/index.html','utf8');
// Root-relative assets would incorrectly resolve outside the repository site.
for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const url=new URL(match[1],site);
  if(url.origin!==origin)continue;
  assert.ok(url.pathname.startsWith(site.pathname),`Asset escapes the Pages subpath: ${url}`);
  assert.ok(existsSync(resolve('dist',url.pathname.slice(site.pathname.length))),`Missing built asset: ${url}`);
}
const manifest=JSON.parse(readFileSync('dist/manifest.webmanifest','utf8'));
assert.equal(new URL(manifest.start_url,site).pathname,site.pathname);
assert.equal(new URL(manifest.scope,site).pathname,site.pathname);
for(const entry of ['audio-runtime/speech-inference.worker.js','audio-runtime/model-cache.js','audio-runtime/model-manifest.js','audio-runtime/sentencepiece-tokenizer.js','licenses.html','licenses/GPL-3.0.txt'])assert.ok(existsSync(resolve('dist',entry)),`Missing runtime asset: ${entry}`);
for(const match of readFileSync('dist/licenses.html','utf8').matchAll(/href="(licenses\/[^"#]+)"/g))assert.ok(existsSync(resolve('dist',match[1])),`Broken license link: ${match[1]}`);
assert.ok(readdirSync('dist/assets').some(name=>name.startsWith('audio-edit.worker-')),'Missing bundled audio-edit worker');
console.log('GitHub Pages subpath, runtime, worker and license assets verified.');
