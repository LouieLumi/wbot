import { readConfig } from './config.js';
import { Store } from './store.js';
import { AdbDriver, MockDriver } from './adapters.js';
import { AndroidHookDriver } from './android-hook.js';
import { OpenClaw } from './openclaw.js';
import { Ollama } from './ollama.js';
import { Hermes } from './hermes.js';
import { Bridge } from './bridge.js';
import { createApi } from './api.js';
import { Memories } from './memory.js';
import { Models } from './models.js';
import {HermesMemberMemory} from './hermes-memory.js';
import { spawn } from 'node:child_process';
import {GeminiWebImages,createGeminiWorker} from './gemini-web.js';
process.umask(0o077);
const config=readConfig();
const store=new Store(config.BRIDGE_DB);
const memory=new Memories(store,config.AI_PROVIDER==='hermes'?new HermesMemberMemory():undefined),models=new Models(config,store);
memory.reconcile();
const responder=config.AI_PROVIDER==='hermes'?new Hermes(config,memory,models):config.AI_PROVIDER==='ollama'?new Ollama(config,memory,models):new OpenClaw(config);
const driver=config.WECHAT_DEVICE_MODE==='mock'?new MockDriver():config.WECHAT_DEVICE_MODE==='android_hook'?new AndroidHookDriver(config):new AdbDriver(config);
const webImages=config.IMAGE_PROVIDER==='gemini_web'?new GeminiWebImages(undefined,undefined,store):undefined;
const bridge=new Bridge(config,driver,store,responder,memory,models,webImages);
// Keep the management page available while the USB phone reconnects.
try{await bridge.groups();}catch{bridge.lastError='device_unavailable_or_unverified';}
const app=await createApi(config,bridge);
if(webImages){
  const worker=createGeminiWorker(config,webImages);
  await worker.listen({host:'127.0.0.1',port:config.GEMINI_WEB_PORT});
  app.addHook('onClose',async()=>{await worker.close();});
}
// Keep the host awake while this process runs; display sleep and screen locking remain available.
const awake=process.platform==='darwin'?spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'}):undefined;
store.set('power_prevent_idle_sleep',String(Boolean(awake)));
awake?.on('error',()=>{store.set('power_prevent_idle_sleep','false');bridge.emitEvent({event:'power.warning',reason:'idle_sleep_prevention_unavailable'});});
app.addHook('onClose',async()=>{awake?.kill();});
await app.listen({host:config.BRIDGE_HOST,port:config.BRIDGE_PORT});bridge.start();

let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(stopping)return;stopping=true;void app.close().finally(()=>store.close());});
