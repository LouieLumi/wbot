import Fastify from 'fastify';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {Config} from './config.js';
import type {GeneratedImage} from '../../../packages/shared/types.js';
import {ImageGenerationError,ImageTextResponse,validateImage,type ImageGenerator,maxImageBytes} from './images.js';

type Task={id:string;prompt:string;session_id:string;expires:number;claimed:boolean;ready:()=>void;finish:(image?:GeneratedImage,error?:Error)=>void};
/** A narrow image-only worker channel. Browser credentials never leave Chrome. */
export class GeminiWebImages implements ImageGenerator {
  private tasks=new Map<string,Task>();
  private seen=0;
  private ready=false;
  private lastError:string|null=null;
  private extensionVersion:string|null=null;
  private phase:string|null=null;
  constructor(private timeoutMs=240_000,private connectTimeoutMs=45_000){}
  status(){return {provider:'gemini_web',connected:this.ready&&Date.now()-this.seen<90_000,last_seen:this.seen||null,pending:this.tasks.size,last_error:this.lastError,extension_version:this.extensionVersion,phase:this.phase};}
  extension(version?:string,phase?:string){this.extensionVersion=version??null;this.phase=phase??null;}
  active(id:string){return this.tasks.has(id);}
  heartbeat(ready:boolean){this.seen=Date.now();this.ready=ready;if(ready)for(const task of this.tasks.values())task.ready();}
  claim(ready:boolean){
    this.heartbeat(ready);
    if(!ready||[...this.tasks.values()].some(t=>t.claimed))return null;
    const task=this.tasks.values().next().value as Task|undefined;
    if(!task)return null;
    task.claimed=true;return {id:task.id,prompt:task.prompt,session_id:task.session_id,expires:task.expires};
  }
  complete(id:string,image?:GeneratedImage,error?:Error){
    const task=this.tasks.get(id);if(!task?.claimed)return false;
    if(image)validateImage(image.data,image.mime_type);
    task.finish(image,error);return true;
  }
  generate(prompt:string,signal:AbortSignal,sessionId=randomUUID()):Promise<GeneratedImage>{
    if(!prompt.trim())return Promise.reject(new Error('invalid_image_prompt'));
    if(signal.aborted)return Promise.reject(new Error('image_cancelled'));
    if(this.tasks.size>=10)return Promise.reject(new ImageGenerationError('image_rate_limited',429));
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),expires=Date.now()+this.timeoutMs;
      const finish=(image?:GeneratedImage,error?:Error)=>{
        if(!this.tasks.delete(id))return;
        clearTimeout(timer);clearTimeout(connectionTimer);signal.removeEventListener('abort',cancel);
        this.lastError=error?.message??null;
        if(error)reject(error);else if(image)resolve(image);else reject(new Error('image_not_returned'));
      };
      const cancel=()=>finish(undefined,new Error('image_cancelled'));
      const timer=setTimeout(()=>finish(undefined,new ImageGenerationError('image_browser_timeout',504)),this.timeoutMs);
      // An extension restart/navigation briefly reports ready:false. Keep the request
      // until its first ready heartbeat instead of rejecting a recoverable transition.
      const connectionTimer=this.status().connected?undefined:setTimeout(()=>finish(undefined,new ImageGenerationError('image_browser_offline',503)),this.connectTimeoutMs);
      this.tasks.set(id,{id,prompt,session_id:sessionId,expires,claimed:false,ready:()=>clearTimeout(connectionTimer),finish});
      signal.addEventListener('abort',cancel,{once:true});
    });
  }
  close(){for(const t of [...this.tasks.values()])t.finish(undefined,new Error('image_cancelled'));}
}

export function createGeminiWorker(config:Config,images:GeminiWebImages){
  const app=Fastify({logger:false,bodyLimit:Math.ceil(maxImageBytes/3)*4+2048});
  const origin='chrome-extension://'+config.GEMINI_WEB_EXTENSION_ID;
  app.addHook('onRequest',async(req,res)=>{
    res.header('Cache-Control','no-store');
    if(!/^127\.0\.0\.1(?::\d+)?$/.test(req.headers.host??''))return res.code(403).send({error:'host_disallowed'});
    if(req.headers.origin&&req.headers.origin!==origin)return res.code(403).send({error:'origin_disallowed'});
    if(req.headers.origin===origin)res.header('Access-Control-Allow-Origin',origin);
    if(req.method==='OPTIONS')return res.header('Access-Control-Allow-Methods','POST, GET').header('Access-Control-Allow-Headers','Authorization, Content-Type').code(204).send();
    const expected=Buffer.from('Bearer '+config.GEMINI_WEB_TOKEN),supplied=Buffer.from(req.headers.authorization??'');
    if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))return res.code(401).send({error:'unauthorized'});
  });
  app.setErrorHandler((e,_,res)=>res.code(e instanceof z.ZodError?400:503).send({error:'invalid_worker_request'}));
  app.get('/status',async()=>images.status());
  const heartbeat=z.object({ready:z.boolean(),protocol:z.number().int().optional(),phase:z.enum(['loading','dispatching','generating']).optional(),version:z.string().max(32).optional(),task_id:z.string().uuid().optional()}).strict();
  app.post('/heartbeat',async req=>{
    const value=heartbeat.parse(req.body);images.extension(value.version,value.phase);images.heartbeat(value.ready&&value.protocol===3);
    return {ok:true,...(value.task_id?{task_active:images.active(value.task_id)}:{}),upgrade_required:value.protocol!==3};
  });
  app.post('/claim',async req=>{
    const value=heartbeat.parse(req.body);images.extension(value.version,value.phase);
    if(value.protocol!==3){images.heartbeat(false);return {task:null,upgrade_required:true};}
    return {task:images.claim(value.ready)};
  });
  app.post('/result',async(req,res)=>{
    const value=z.union([
      z.object({id:z.string().uuid(),ok:z.literal(true),mime_type:z.enum(['image/png','image/jpeg','image/webp']),data:z.string().max(Math.ceil(maxImageBytes/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict(),
      z.object({id:z.string().uuid(),ok:z.literal(false),error:z.literal('text_response'),text:z.string().trim().min(1).max(2000)}).strict(),
      z.object({id:z.string().uuid(),ok:z.literal(false),error:z.enum(['login_required','quota','timeout','page_changed','browser_restarted','generation_failed','submission_failed'])}).strict()
    ]).parse(req.body);
    if(!value.ok&&value.error==='text_response'){
      const accepted=images.complete(value.id,undefined,new ImageTextResponse(value.text));
      return accepted?{ok:true}:res.code(409).send({error:'task_expired'});
    }
    const image=value.ok?{mime_type:value.mime_type,data:Buffer.from(value.data,'base64')}:undefined;
    const reason=!value.ok&&value.error==='quota'?'image_quota_exhausted':!value.ok&&value.error==='login_required'?'image_browser_offline':!value.ok&&value.error==='timeout'?'image_browser_timeout':!value.ok&&value.error==='submission_failed'?'image_submission_failed':'image_service_unavailable';
    const accepted=images.complete(value.id,image,value.ok?undefined:new ImageGenerationError(reason,value.error==='quota'?429:503));
    return accepted?{ok:true}:res.code(409).send({error:'task_expired'});
  });
  app.addHook('onClose',async()=>images.close());return app;
}
