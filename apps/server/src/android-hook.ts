import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Config} from './config.js';
import type {Chat,DeviceAdapter,Message,SendResult,Snapshot,SignupRequest,GeneratedImage,GeneratedVoice,GroupHistory} from '../../../packages/shared/types.js';
import {validateVoice} from './voice.js';
import {validateImage} from './images.js';
import {isBotReply} from './reply-context.js';

const exec=promisify(execFile);
const chat=z.object({id:z.string().regex(/^[\w-]+@chatroom$/),name:z.string().max(128),type:z.literal('group'),verified:z.literal(true)});
const event=z.object({event:z.literal('message.received'),message_id:z.string().min(1).max(200),chat_id:chat.shape.id,
  chat_name:z.string().max(128),chat_type:z.literal('group'),sender:z.string().min(1).max(128),sender_wxid:z.string().regex(/^[\w@.\-]{1,128}$/),
  content:z.string().max(8000),own:z.literal(false),mention:z.enum(['text','none','reply']),timestamp:z.number().finite(),seq:z.number().int().nonnegative(),
  reply_to:z.object({message_id:z.string().max(200),content:z.string().max(8000),type:z.enum(['text','image','other']),own:z.literal(true)}).optional()
}).refine(m=>m.mention==='reply'?isBotReply(m):m.reply_to===undefined,'invalid_bot_quote');
const batch=z.object({generation:z.string().uuid(),cursor:z.number().int().nonnegative(),oldest:z.number().int().nonnegative(),events:z.array(event).max(100)});
const signup=z.object({request_id:z.string().regex(/^[\w@:.\-]{1,200}$/),chat_id:chat.shape.id,chat_name:z.string().min(1).max(128),requested_at:z.number().int().positive()});

/** USB forwards the phone's authenticated loopback server. No UI/OCR fallback. */
export class AndroidHookDriver implements DeviceAdapter {
  private generation='';private cursor=0;private baseline=true;private lastPoll=0;private epoch=0;
  private forwardedAt=0;private forwarding:Promise<void>|undefined;
  private authorization='';private signupSupported=false;private phoneGeneration='';private authorizationChain:Promise<void>=Promise.resolve();
  constructor(private config:Config,private forward=async()=>{
    const port=Number(new URL(config.WECHAT_HOOK_BASE_URL).port);
    if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('invalid_hook_port');
    await exec(resolve('.runtime/android-sdk/platform-tools/adb'),['-P',String(config.ADB_SERVER_PORT),'-s',config.WECHAT_DEVICE_SERIAL,'forward','tcp:'+port,'tcp:8767'],{timeout:5000,maxBuffer:4096});
  }){}
  private async ensureForward(){
    if(Date.now()-this.forwardedAt<60_000)return;
    this.forwarding??=this.forward().then(()=>{this.forwardedAt=Date.now();}).finally(()=>{this.forwarding=undefined;});
    await this.forwarding;
  }
  private async call(path:string,body?:unknown,timeout=22_000):Promise<unknown>{
    await this.ensureForward();
    try{
      const response=await fetch(new URL(path,this.config.WECHAT_HOOK_BASE_URL),{method:body===undefined?'GET':'POST',redirect:'error',
        headers:{authorization:'Bearer '+this.config.WECHAT_HOOK_TOKEN,'content-type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
      if(!response.ok)throw new Error('hook_http_error');
      const text=await response.text();if(text.length>1_000_000)throw new Error('hook_output_limit');return JSON.parse(text);
    }catch{this.forwardedAt=0;throw new Error('android_hook_unavailable');}
  }
  async status(){return z.record(z.string(),z.unknown()).parse(await this.call('/status'));}
  async quotedReply(id:string,messageId:string):Promise<Message|null>{
    const data=z.object({messages:z.array(z.unknown()).max(20)}).parse(await this.call('/replies/lookup',{chat_id:id,message_id:messageId,since:Date.now()-23*3600_000}));
    if(!data.messages.length)return null;
    if(data.messages.length!==1)throw new Error('ambiguous_quoted_reply');
    const message=event.parse({...data.messages[0] as object,seq:0});
    if(message.chat_id!==id||message.message_id!==messageId||!isBotReply(message))throw new Error('invalid_quoted_reply');
    return message;
  }
  async resolveAccount(wechatId:string):Promise<string|null>{
    const data=z.object({wechat_id:z.literal(wechatId),verified:z.boolean(),username:z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/).nullable(),reason:z.string()})
      .parse(await this.call('/identity/resolve',{wechat_id:wechatId}));
    return data.verified&&data.reason==='account_exact_match'?data.username:null;
  }
  async chats(){
    const data=z.object({groups:z.array(chat).max(200),generation:z.string().optional(),signup_supported:z.boolean().optional()}).parse(await this.call('/groups'));
    if(data.generation!==this.phoneGeneration){this.authorization='';this.phoneGeneration=data.generation??'';}
    this.signupSupported=data.signup_supported===true;return data.groups;
  }
  async setAuthorized(ids:string[]){
    if(!this.signupSupported)return;
    const value=JSON.stringify([...new Set(ids)].sort());
    const task=this.authorizationChain.catch(()=>{}).then(async()=>{if(this.authorization===value)return;await this.call('/authorization',{chat_ids:JSON.parse(value)});this.authorization=value;});
    this.authorizationChain=task;await task;
  }
  async signupRequests(){return this.signupSupported?z.object({requests:z.array(signup).max(200)}).parse(await this.call('/signup/requests')).requests:[];}
  async acknowledgeSignup(request:SignupRequest):Promise<SendResult>{
    const result=z.object({state:z.enum(['sent','failed','uncertain']),reason:z.string().max(128)}).parse(await this.call('/signup/ack',{request_id:request.request_id,chat_id:request.chat_id}));
    return result.state==='sent'&&result.reason!=='wechat_server_ack'?{state:'uncertain',reason:'unverified_server_ack'}:result;
  }
  async snapshot():Promise<Snapshot>{throw new Error('android_hook_has_no_visual_snapshot');}
  resetEvents(){this.baseline=true;this.epoch++;}
  async groupHistory(id:string,since:number,after:number,source:string):Promise<GroupHistory>{
    const query=new URLSearchParams({chat_id:id,since:String(since),after:String(after),source});
    return z.object({chat_id:z.literal(id),source:z.string().regex(/^[a-f0-9]{64}$/),cursor:z.number().int().nonnegative().safe(),has_more:z.boolean(),messages:z.array(z.object({
      local_id:z.number().int().positive().safe(),sender_id:z.string().regex(/^[\w@.\-]{1,128}$/),sender:z.string().min(1).max(128),content:z.string().max(8000),timestamp:z.number().int().positive().safe(),truncated:z.boolean()
    })).max(100)}).parse(await this.call('/history?'+query,undefined,8000));
  }
  async pollEvents():Promise<{messages:Message[];reliability:string}>{
    const epoch=this.epoch,now=Date.now();
    const data=batch.parse(await this.call('/events?after='+this.cursor));
    const gap=this.generation!==data.generation||data.oldest>this.cursor+1||now-this.lastPoll>180_000;
    const skip=this.baseline||gap||epoch!==this.epoch;
    if(data.events.some((e,i)=>e.seq>data.cursor||(i>0&&e.seq<=data.events[i-1]!.seq)))throw new Error('invalid_hook_sequence');
    const messages=skip?[]:data.events.filter(e=>e.seq>this.cursor&&now-e.timestamp<180_000&&e.timestamp<=now+60_000);
    this.cursor=data.cursor;this.generation=data.generation;this.lastPoll=now;
    if(epoch===this.epoch)this.baseline=false;
    return {messages,reliability:skip?'code_events_baseline':'code_events'};
  }
  async send(target:Chat,content:string,id=randomUUID()):Promise<SendResult>{
    if(content.length>2000)return {state:'failed',reason:'text_exceeds_code_transport_limit'};
    const result=z.object({state:z.enum(['sent','failed','uncertain']),reason:z.string().max(128)}).parse(await this.call('/send',{chat_id:target.id,content,id}));
    if(result.state==='sent'&&result.reason!=='wechat_server_ack')return {state:'uncertain',reason:'unverified_server_ack'};
    return result;
  }
  async sendVoice(target:Chat,voice:GeneratedVoice,id:string):Promise<SendResult>{
    validateVoice(voice);
    const result=z.object({state:z.enum(['sent','failed','uncertain']),reason:z.string().max(128)}).parse(await this.call('/send/voice',
      {chat_id:target.id,id,mime_type:voice.mime_type,duration_ms:voice.duration_ms,data:Buffer.from(voice.data).toString('base64')},75_000));
    return result.state==='sent'&&result.reason!=='wechat_server_ack'?{state:'uncertain',reason:'unverified_server_ack'}:result;
  }
  async sendImage(target:Chat,image:GeneratedImage,id:string):Promise<SendResult>{
    validateImage(image.data,image.mime_type);
    const result=z.object({state:z.enum(['sent','failed','uncertain']),reason:z.string().max(128)}).parse(await this.call('/send/image',
      {chat_id:target.id,id,mime_type:image.mime_type,data:Buffer.from(image.data).toString('base64')},75_000));
    return result.state==='sent'&&result.reason!=='wechat_server_ack'?{state:'uncertain',reason:'unverified_server_ack'}:result;
  }
}
