import {createHash} from 'node:crypto';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import type {Turn} from './memory.js';

export interface MemoryDraft {key:string;epoch:number;user:string[];memory:string[]}
export interface MemorySnapshot extends MemoryDraft {
  backend:'hermes';notes:string;summary:string;history:Turn[];turn_count:number;session_id:string;
}
export interface MemberMemoryBackend {
  readonly root:string;
  ensure(key:string,notes:string[],history:(Turn&{seq:number})[]):MemorySnapshot;
  snapshot(key:string):MemorySnapshot;
  patch(key:string,patch:{notes?:string;summary?:string}):void;
  reset(key:string,notes:boolean):void;
  commit(key:string,job:string,user:string,answer:string,draft?:MemoryDraft):void;
}
export const verifiedMember=(id:string)=>/^wxid:[a-f0-9]{64}$/.test(id);
export const memberMemoryKey=(chat:string,id:string)=>verifiedMember(id)?id.slice(5):createHash('sha256').update('legacy\0'+chat+'\0'+id).digest('hex');

export class HermesMemberMemory implements MemberMemoryBackend {
  readonly root:string;private ready=new Set<string>();
  constructor(root=resolve('data/hermes-members')){this.root=resolve(root);}
  private call(key:string,body:Record<string,unknown>):MemorySnapshot {
    if(!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid_memory_identity');
    const result=spawnSync(resolve('.runtime/venv/bin/python'),[resolve('scripts/hermes_member_memory.py')],{
      input:JSON.stringify({...body,key,root:this.root}),encoding:'utf8',timeout:30_000,maxBuffer:2_000_000,
      env:{HOME:process.env.HOME,PATH:process.env.PATH,LANG:'en_US.UTF-8',PYTHONIOENCODING:'utf-8'}});
    if(result.status!==0){
      let code='hermes_memory_unavailable';try{const parsed=JSON.parse(result.stderr);if(['memory_limit','hermes_memory_write_rejected','stale_memory_draft'].includes(parsed.error))code=parsed.error;}catch{}
      throw new Error(code);
    }
    return JSON.parse(result.stdout) as MemorySnapshot;
  }
  ensure(key:string,notes:string[],history:(Turn&{seq:number})[]){
    if(!this.ready.has(key)){this.call(key,{action:'ensure',notes,history});this.ready.add(key);}
    return this.snapshot(key);
  }
  snapshot(key:string):MemorySnapshot {
    if(!/^[a-f0-9]{64}$/.test(key))throw new Error('invalid_memory_identity');
    if(existsSync(join(this.root,key,'wbot-pending.json')))return this.call(key,{action:'snapshot'});
    return JSON.parse(readFileSync(join(this.root,key,'wbot-snapshot.json'),'utf8')) as MemorySnapshot;
  }
  patch(key:string,patch:{notes?:string;summary?:string}){this.call(key,{action:'patch',...patch});}
  reset(key:string,notes:boolean){this.call(key,{action:'reset',notes});}
  commit(key:string,job:string,user:string,answer:string,draft?:MemoryDraft){this.call(key,{action:'commit',job_id:job,user_text:user,answer,draft});}
}
