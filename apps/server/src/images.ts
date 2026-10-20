import type {Config} from './config.js';
import type {GeneratedImage} from '../../../packages/shared/types.js';

export const maxImageBytes=8*1024*1024;
export interface ImageSessionContext {title:string;retired_sessions:string[]}
export interface ImageGenerator {
  generate(prompt:string,signal:AbortSignal,sessionId?:string,context?:ImageSessionContext):Promise<GeneratedImage>;
  resetSession?(sessionId:string,context:ImageSessionContext,signal:AbortSignal):Promise<void>;
  status?():unknown;
}

export class ImageGenerationError extends Error {
  constructor(readonly reason:'image_quota_exhausted'|'image_rate_limited'|'image_auth_failed'|'image_service_unavailable'|'image_browser_offline'|'image_browser_timeout'|'image_submission_failed'|'image_text_response'|'image_download_failed',readonly httpStatus:number,readonly retryAt?:number){super(reason);}
}
/** Explicit completed model text, never raw provider errors or surrounding page content. */
export class ImageTextResponse extends ImageGenerationError {
  readonly text:string;
  constructor(text:string){
    super('image_text_response',200);
    this.text=text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,2000);
    if(!this.text)throw new Error('invalid_image_text');
  }
}
export function imageErrorReply(error:unknown):string {
  if(error instanceof ImageTextResponse)return error.text;
  if(!(error instanceof ImageGenerationError))return '图片生成失败，请稍后重试。';
  if(error.reason==='image_browser_offline')return 'Gemini 网页生图未连接，请联系管理员检查浏览器登录。';
  if(error.reason==='image_browser_timeout')return 'Gemini 网页生图超时，请稍后重新发送 /img。';
  if(error.reason==='image_download_failed')return '图片已经生成，但下载失败；本次不会重复生图，请联系管理员补发。';
  if(error.reason==='image_submission_failed')return '未能确认 Gemini 已接收提示词，请检查生图网页。本次没有自动重复提交。';
  const reset=error.retryAt&&error.retryAt>Date.now()?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(error.retryAt):'';
  if(error.reason==='image_quota_exhausted')return '生图模型额度已用完。'+(reset?'预计 '+reset+'（北京时间）恢复，请届时重新发送 /img。':'请等待额度恢复后重新发送 /img。');
  if(error.reason==='image_rate_limited')return '生图请求暂时受限。'+(reset?'预计 '+reset+'（北京时间）可重试。':'请稍后重试。');
  if(error.reason==='image_auth_failed')return '生图服务认证失败，请联系管理员。';
  return '生图服务暂时不可用，请稍后重试。';
}
async function imageHttpError(response:Response):Promise<ImageGenerationError>{
  // Read only bounded error metadata. Never expose provider messages or credentials.
  let data:any;try{
    const chunks:Uint8Array[]=[];let size=0;
    if(response.body)for await(const chunk of response.body){size+=chunk.length;if(size>64*1024)break;chunks.push(chunk);}
    data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{}
  const error=data?.error,details=Array.isArray(error?.details)?error.details:[];
  const quota=response.status===429&&(error?.code==='model_cooldown'||details.some((d:any)=>d?.reason==='QUOTA_EXHAUSTED'));
  const now=Date.now();let retryAt:number|undefined;
  const seconds=error?.reset_seconds;
  if(typeof seconds==='number'&&Number.isFinite(seconds)&&seconds>0)retryAt=now+seconds*1000;
  for(const item of details){
    const stamp=item?.metadata?.quotaResetTimeStamp;
    if(typeof stamp==='string'){const date=Date.parse(stamp);if(Number.isFinite(date)&&date>now)retryAt=date;}
    if(!retryAt&&typeof item?.retryDelay==='string'&&/^\d+(?:\.\d+)?s$/.test(item.retryDelay))retryAt=now+Number(item.retryDelay.slice(0,-1))*1000;
  }
  if(!retryAt){const header=response.headers.get('retry-after');if(header){const delay=/^\d+$/.test(header)?now+Number(header)*1000:Date.parse(header);if(Number.isFinite(delay)&&delay>now)retryAt=delay;}}
  if(retryAt&&retryAt>now+7*86400_000)retryAt=undefined;
  const reason=quota?'image_quota_exhausted':response.status===429?'image_rate_limited':response.status===401||response.status===403?'image_auth_failed':'image_service_unavailable';
  return new ImageGenerationError(reason,response.status,retryAt);
}

export function validateImage(data:Uint8Array,mime:string):asserts mime is GeneratedImage['mime_type']{
  if(data.length<16||data.length>maxImageBytes)throw new Error('invalid_image');
  const b=Buffer.from(data);
  const valid=mime==='image/png'?b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):
    mime==='image/jpeg'?b[0]===255&&b[1]===216&&b[2]===255:
    mime==='image/webp'?b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP':false;
  if(!valid)throw new Error('invalid_image');
}

/** Uses the already configured local proxy; prompts never include chat history or notes. */
export class GeminiImages implements ImageGenerator {
  constructor(private config:Config){}
  async generate(prompt:string,signal:AbortSignal):Promise<GeneratedImage>{
    if(!prompt.trim())throw new Error('invalid_image_prompt');
    if(!this.config.HERMES_API_BASE_URL||!this.config.HERMES_API_KEY)throw new Error('image_not_configured');
    const endpoint=new URL('/v1beta/models/'+encodeURIComponent(this.config.IMAGE_MODEL)+':generateContent',this.config.HERMES_API_BASE_URL);
    const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(180_000)]),
      headers:{Authorization:'Bearer '+this.config.HERMES_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({contents:[{role:'user',parts:[{text:'请根据以下提示词生成一张图片：\n'+prompt}]}],
        generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:'1:1',imageSize:'1K'}}})});
    if(!response.ok)throw await imageHttpError(response);
    if(!response.body)throw new Error('image_generation_failed');
    const chunks:Uint8Array[]=[];let size=0;
    for await(const part of response.body){size+=part.length;if(size>12*1024*1024)throw new Error('image_response_too_large');chunks.push(part);}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      candidates?:{content?:{parts?:{thought?:boolean;inlineData?:{mimeType?:string;data?:string};inline_data?:{mime_type?:string;data?:string}}[]}}[]};
    for(const candidate of result.candidates??[])for(const part of candidate.content?.parts??[]){
      if(part.thought)continue;
      const image=part.inlineData??part.inline_data;if(!image?.data)continue;
      const mime=('mimeType' in image?image.mimeType:undefined)??('mime_type' in image?image.mime_type:undefined)??'';
      if(image.data.length>Math.ceil(maxImageBytes/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))throw new Error('invalid_image');
      const data=Buffer.from(image.data,'base64');validateImage(data,mime);
      return {mime_type:mime,data};
    }
    throw new Error('image_not_returned');
  }
}
