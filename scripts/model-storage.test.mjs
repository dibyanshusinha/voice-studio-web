/** Storage regression tests ensure cleanup cannot delete profiles or unrelated application caches. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

/** Supplies the real browser-storage module with isolated, in-memory Cache Storage containers. */
function createStorageHarness() {
  const containers = new Map();
  const cacheApi = {
    keys: async () => [...containers.keys()],
    open: async name => {
      if (!containers.has(name)) containers.set(name, new Map());
      const entries = containers.get(name);
      return {
        keys: async () => [...entries.keys()].map(url => ({url})),
        match: async request => entries.get(typeof request === 'string' ? request : request.url)?.clone(),
        delete: async url => entries.delete(url),
      };
    },
    delete: async name => containers.delete(name),
  };
  const source=readFileSync(new URL('../src/voices/model-storage.ts',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const context={exports:{},caches:cacheApi,navigator:{storage:{estimate:async()=>({usage:500,quota:1000})}},URL,Set,Map,Error,Number};
  vm.runInNewContext(code,context);
  return {api:context.exports, containers};
}

/** Builds realistic model URLs so grouping is based on installed assets rather than a hardcoded language list. */
const url=(bundle,file)=>`https://huggingface.co/spaces/KevinAHM/pocket-tts-web/resolve/version/onnx/${bundle}/${file}`;

test('inventory includes older app caches, ignores unrelated caches and counts legacy bytes',async()=>{
  const {api,containers}=createStorageHarness();
  containers.set('voice-studio-pocket-old',new Map([[url('german','mimi_encoder_int8.onnx'),new Response(new Uint8Array(7))]]));
  containers.set('voice-studio-pocket-current',new Map([[url('english_2026-04','bundle.json'),new Response('abc',{headers:{'x-voice-studio-bytes':'3'}})]]));
  containers.set('another-app',new Map([['https://example.com/private',new Response('untouched')]]));
  const inventory=await api.inspectModelStorage();
  assert.equal(inventory.assets.length,2);
  assert.equal(inventory.modelBytes,10);
  assert.equal(inventory.assets[0].bundle,'german');
  assert.equal(inventory.originUsage,500);
  assert.equal(inventory.originQuota,1000);
});

test('file removal keeps sibling assets and all unrelated caches',async()=>{
  const {api,containers}=createStorageHarness();
  const name='voice-studio-pocket-current';
  const encoder=url('german','mimi_encoder_int8.onnx');
  const decoder=url('german','mimi_decoder_int8.onnx');
  containers.set(name,new Map([[encoder,new Response('encoder')],[decoder,new Response('decoder')]]));
  containers.set('unrelated',new Map());
  const inventory=await api.inspectModelStorage();
  await api.removeCachedModelAssets(inventory.assets.filter(asset=>asset.url===encoder));
  assert.equal(containers.get(name).has(encoder),false);
  assert.equal(containers.get(name).has(decoder),true);
  assert.equal(containers.has('unrelated'),true);
  await api.removeCachedModelAssets(inventory.assets.filter(asset=>asset.url===decoder));
  assert.equal(containers.has(name),false);
});

test('clear all removes only app-owned cache versions and never needs IndexedDB',async()=>{
  const {api,containers}=createStorageHarness();
  containers.set('voice-studio-pocket-old',new Map());
  containers.set('voice-studio-pocket-current',new Map());
  containers.set('other-app-cache',new Map());
  await api.clearAllModelCaches();
  assert.deepEqual([...containers.keys()],['other-app-cache']);
});

test('a mixed removal request is rejected before deleting any files',async()=>{
  const {api,containers}=createStorageHarness();
  const name='voice-studio-pocket-current';const asset=url('german','bundle.json');
  containers.set(name,new Map([[asset,new Response('data')]]));
  await assert.rejects(api.removeCachedModelAssets([{cacheName:name,url:asset},{cacheName:'other-app',url:'x'}]),/Only Voice Studio/);
  assert.equal(containers.get(name).has(asset),true);
});

test('inventory handles unavailable cache storage with a useful error',async()=>{
  const source=readFileSync(new URL('../src/voices/model-storage.ts',import.meta.url),'utf8');
  const context={exports:{},Error};
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
  await assert.rejects(context.exports.inspectModelStorage(),/does not expose/);
});
