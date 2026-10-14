import type {Config} from './config.js';
import type {Store} from './store.js';
export class Models {
  private cache:{name:string;size:number;source?:string}[]=[];private checked=0;
  constructor(readonly config:Config,readonly store:Store){}
  default(){return this.store.get('default_model')||(this.config.HERMES_API_BASE_URL?this.config.HERMES_MODEL:this.config.OLLAMA_MODEL);}
  reasoning(){return this.store.get('reasoning_effort')||'auto';}
  source(){return this.config.AI_PROVIDER==='hermes'&&this.config.HERMES_API_BASE_URL?'CLIProxyAPI':'Ollama';}
  async list(){
    if(Date.now()-this.checked<10_000)return this.cache;
    if(this.source()==='CLIProxyAPI'){
      const r=await fetch(this.config.HERMES_API_BASE_URL.replace(/\/$/,'')+'/models',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer '+this.config.HERMES_API_KEY}});
      if(!r.ok)throw new Error('proxy_unavailable');
      const data=await r.json() as {data?:{id?:unknown}[]};
      this.cache=[...new Set((data.data??[]).map(m=>m.id).filter((id):id is string=>typeof id==='string'&&/^(gemini-|claude-|gpt-)/.test(id)&&!/(image|embedding|tts|robotics)/i.test(id)))].sort().map(name=>({name,size:0,source:'CLIProxyAPI'}));
      this.checked=Date.now();return this.cache;
    }
    const r=await fetch(new URL('/api/tags',this.config.OLLAMA_BASE_URL),{redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!r.ok)throw new Error('ollama_unavailable');
    const data=await r.json() as {models?:{name:string;size:number}[]};
    this.cache=(data.models??[]).filter(m=>typeof m.name==='string').map(m=>({name:m.name,size:m.size}));this.checked=Date.now();return this.cache;
  }
  async validate(model:string){if(model&&!(await this.list()).some(m=>m.name===model))throw new Error('model_not_installed');}
}
