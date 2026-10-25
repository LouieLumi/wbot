import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import type {Config} from './config.js';
import type {GeneratedVoice} from '../../../packages/shared/types.js';

export interface VoiceGenerator {generate(text:string,signal:AbortSignal):Promise<GeneratedVoice>;status?():unknown}
export function validateVoice(voice:GeneratedVoice){
  const b=Buffer.from(voice.data);
  if(voice.mime_type!=='audio/silk'||b.length<13||b.length>1024*1024||!b.subarray(0,10).equals(Buffer.from('\x02#!SILK_V3')))
    throw Error('invalid_voice');
  let offset=10,frames=0;
  while(offset<b.length){
    if(offset+2>b.length)throw Error('invalid_voice_packet');
    const size=b.readInt16LE(offset);offset+=2;
    if(size<=0||size>1250||offset+size>b.length)throw Error('invalid_voice_packet');
    offset+=size;frames++;
  }
  if(!Number.isInteger(voice.duration_ms)||voice.duration_ms!==frames*20||voice.duration_ms<1000||voice.duration_ms>60_000)throw Error('invalid_voice_duration');
}
export function speakable(text:string){
  return text.trim().length>0&&text.length<=180&&!/https?:\/\/|www\.|```|[<>]|\n.{0,10}(?:\d+[.、]|[-*] )/i.test(text);
}

/** One synthesis at a time, without a waiting queue. Busy callers use text;
 * aborts kill the process and release Metal resources before the next starts. */
export class LocalVoice implements VoiceGenerator {
  private pending=0;private lastError:string|null=null;
  constructor(private config:Config){}
  status(){return {enabled:this.config.VOICE_ENABLED,provider:'local_qwen3_tts',pending:this.pending,last_error:this.lastError,
    ready:[this.config.VOICE_PYTHON,this.config.VOICE_MODEL_PATH,this.config.VOICE_REFERENCE,this.config.VOICE_REFERENCE+'.txt'].every(p=>existsSync(resolve(p)))};}
  async generate(text:string,signal:AbortSignal):Promise<GeneratedVoice>{
    if(!this.config.VOICE_ENABLED||!speakable(text)||!this.status().ready)throw Error('voice_unavailable');
    if(this.pending)throw Error('voice_busy');
    if(signal.aborted)throw Error('voice_cancelled');
    this.pending++;
    try{const result=await this.synthesize(text,signal,150_000);this.lastError=null;return result;}
    catch(error){this.lastError=signal.aborted?'cancelled':'synthesis_failed';throw error;}
    finally{this.pending--;}
  }
  private synthesize(text:string,signal:AbortSignal,timeout:number):Promise<GeneratedVoice>{
    return new Promise((done,fail)=>{
      const child=spawn(resolve(this.config.VOICE_PYTHON),[resolve('scripts/local-voice.py')],{stdio:['pipe','pipe','pipe'],
        env:{HOME:process.env.HOME,PATH:process.env.PATH,LANG:'en_US.UTF-8',PYTHONIOENCODING:'utf-8',HF_HUB_OFFLINE:'1',TOKENIZERS_PARALLELISM:'false'}});
      let output='',failure='',settled=false;
      const cancel=()=>{failure='voice_cancelled';child.kill('SIGKILL');};
      const timer=setTimeout(()=>{failure='voice_timeout';child.kill('SIGKILL');},timeout);
      const finish=(error?:Error,value?:GeneratedVoice)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);error?fail(error):done(value!);};
      signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
      child.on('error',()=>finish(Error('voice_worker_unavailable')));
      child.stdout.on('data',chunk=>{output+=String(chunk);if(output.length>1_500_000){failure='voice_output_limit';child.kill('SIGKILL');}});
      child.stderr.resume();child.stdin.on('error',()=>{});
      child.on('close',code=>{
        try{
          if(failure||code!==0)throw Error(failure||'voice_worker_failed');
          const value=JSON.parse(output);
          if(typeof value.data!=='string'||value.data.length>1_400_000)throw Error('invalid_voice_output');
          const voice:GeneratedVoice={mime_type:value.mime_type,data:Buffer.from(value.data,'base64'),duration_ms:value.duration_ms};
          validateVoice(voice);finish(undefined,voice);
        }catch(error){finish(error instanceof Error?error:Error('invalid_voice_output'));}
      });
      child.stdin.end(JSON.stringify({text,model:resolve(this.config.VOICE_MODEL_PATH),reference:resolve(this.config.VOICE_REFERENCE)}));
    });
  }
}
