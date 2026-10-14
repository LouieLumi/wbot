import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Bridge} from '../apps/server/src/bridge.js';
import {Store} from '../apps/server/src/store.js';
import {Memories} from '../apps/server/src/memory.js';
import {Models} from '../apps/server/src/models.js';
import {readConfig} from '../apps/server/src/config.js';
import {GeminiImages,ImageTextResponse,validateImage} from '../apps/server/src/images.js';
import {AndroidHookDriver} from '../apps/server/src/android-hook.js';
import type {Chat,DeviceAdapter,GeneratedImage,Message,SendResult} from '../packages/shared/types.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const image:GeneratedImage={mime_type:'image/png',data:png};
const group:Chat={id:'123@chatroom',name:'图片测试群',type:'group',verified:true};
const second:Chat={...group,id:'456@chatroom'};
const config=(extra={})=>readConfig({BRIDGE_API_TOKEN:'b'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'a'.repeat(64),WECHAT_ALLOWED_CHAT_IDS:JSON.stringify([group.id,second.id]),WECHAT_BOT_NAME:'Nila',WECHAT_REPLY_MODE:'text_mention',...extra});
const message=(content:string,chat=group):Message=>({event:'message.received',message_id:randomUUID(),chat_id:chat.id,chat_name:chat.name,chat_type:'group',sender:'Alice',sender_wxid:'wxid_alice',own:false,mention:'none',timestamp:Date.now(),content});
function setup(generate:(prompt:string,signal:AbortSignal,sessionId?:string)=>Promise<GeneratedImage>,result:SendResult={state:'sent',reason:'wechat_server_ack'},path=':memory:'){
 const c=config(),store=new Store(path),text:string[]=[],sent:GeneratedImage[]=[],ai:string[]=[];
 const driver:DeviceAdapter={status:async()=>({}),chats:async()=>[group,second],snapshot:async()=>{throw Error('No screenshots');},pollEvents:async()=>({messages:[],reliability:'code_events'}),
  send:async(_chat,content)=>{text.push(content);return {state:'sent',reason:'wechat_server_ack'};},sendImage:async(_chat,picture)=>{sent.push(picture);return result;}};
 const bridge=new Bridge(c,driver,store,{reply:async(m)=>{ai.push(m.content);return '文字回复';}},new Memories(store),new Models(c,store),{generate});
 bridge.control(false,true);return {store,bridge,driver,text,sent,ai,async close(){await bridge.close();store.close();}};
}

test('/img persists a typed image job, sends exactly once, and commits member history after acknowledgement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nila-images-')),path=join(dir,'db');let calls=0;
 let s=setup(async()=>{calls++;return image;},undefined,path);
 try{
  await s.bridge.groups();const incoming=message('/img 水彩白猫');s.bridge.receive(incoming);await s.bridge.repliesIdle();
  s.bridge.receive(incoming);await s.bridge.repliesIdle();assert.equal(calls,1);assert.equal(s.ai.length,0);
  const job=s.store.db.prepare('SELECT job_id FROM job_images').get() as {job_id:string};
  assert.deepEqual(Buffer.from(s.store.image(job.job_id)!.data),png);
  assert.equal(s.store.job(job.job_id)?.content,'[图片] 水彩白猫');
  const member=s.bridge.memory.members(group.id)[0]!;assert.equal(s.bridge.memory.history(group.id,member.id).length,0);
  await s.close();s=setup(async()=>{throw Error('Must not regenerate after restart');},undefined,path);
  await s.bridge.tick();await s.bridge.tick();await s.bridge.tick();
  assert.equal(s.sent.length,1);assert.equal(s.store.job(job.job_id)?.state,'sent');assert.equal(s.bridge.memory.history(group.id,member.id).length,2);
  assert.deepEqual(s.text,['Alice，正在生成图片，请稍候。']);
 }finally{await s.close();rmSync(dir,{recursive:true});}
});

test('/img forwards a long multiline prompt unchanged and sends its image',async()=>{
 const prompt='画面描述：\n'+('中文构图与光影细节🌙\n'.repeat(420))+'最后一条要求：保留这一行。';
 assert(prompt.length>5000);let received='';
 const s=setup(async value=>{received=value;return image;});
 try{
  await s.bridge.groups();s.bridge.receive(message('/img '+prompt));await s.bridge.repliesIdle();
  assert.equal(received,prompt);
  const job=s.store.db.prepare('SELECT job_id FROM job_images').get() as {job_id:string};
  assert.equal(s.store.job(job.job_id)!.content,'[图片] '+prompt);
  for(let i=0;i<3;i++)await s.bridge.tick();
  assert.equal(s.sent.length,1);assert.equal(s.store.job(job.job_id)!.state,'sent');
  assert(!s.text.some(t=>t.includes('2000')));
 }finally{await s.close();}
});

test('a completed refusal is sent once as plain text to the requesting group, with no image or AI fallback',async()=>{
 const text='我暂时无法生成这张图片。\n可以换一个主题。';let attempts=0;
 const s=setup(async()=>{attempts++;throw new ImageTextResponse(text);});
 try{
  await s.bridge.groups();const incoming=message('/img test');s.bridge.receive(incoming);await s.bridge.repliesIdle();
  s.bridge.receive(incoming);await s.bridge.repliesIdle();
  for(let i=0;i<4;i++)await s.bridge.tick();
  assert.equal(attempts,1);assert.equal(s.sent.length,0);assert.equal(s.ai.length,0);
  assert.equal(s.text.filter(t=>t===text).length,1);
  const job=s.store.db.prepare('SELECT chat_id,state FROM jobs WHERE content=?').get(text);
  assert.equal(job!.chat_id,group.id);assert.equal(job!.state,'sent');
  assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM job_images').get()!.n,0);
  assert(!s.store.get('last_image_error')!.includes(text));
 }finally{await s.close();}
});

test('generation does not block text in another group, and memory reset or authorization revocation prevents image delivery',async()=>{
 for(const revoke of [false,true]){
  let release!:(image:GeneratedImage)=>void,started!:()=>void;
  const ready=new Promise<void>(r=>started=r),s=setup(()=>{started();return new Promise(r=>release=r);});
  try{
   await s.bridge.groups();s.bridge.receive(message('/img 蓝鲸'));await ready;
   s.bridge.receive(message('@Nila 你好',second));await new Promise(r=>setImmediate(r));
   assert.deepEqual(s.ai,['你好']);
   const member=s.bridge.memory.members(group.id)[0]!;
   if(revoke)s.bridge.memory.groupPatch(group.id,{enabled:false});else s.bridge.memory.reset(group.id,member.id);
   release(image);await s.bridge.repliesIdle();assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM job_images').get()!.n,0);
   await s.bridge.tick();await s.bridge.tick();assert.equal(s.sent.length,0);
  }finally{release?.(image);await s.close();}
 }
});

test('unauthorized /img never invokes a model; empty prompt is usage; failed generation and uncertain delivery are visible without retry',async()=>{
 let calls=0;const s=setup(async()=>{calls++;throw Error('upstream_secret_must_not_leak');});
 try{
  await s.bridge.groups();s.bridge.receive(message('/img cat',{...group,id:'unapproved@chatroom'}));await s.bridge.repliesIdle();assert.equal(calls,0);
  s.bridge.receive(message('/img'));await s.bridge.repliesIdle();await s.bridge.tick();assert.match(s.text[0]!,/用法/);assert.equal(calls,0);
  s.bridge.receive(message('/img cat',second));await s.bridge.repliesIdle();await s.bridge.tick();await s.bridge.tick();
  assert.equal(calls,1);assert(s.text.includes('图片生成失败，请稍后重试。'));assert(!s.text.some(t=>t.includes('secret')));
 }finally{await s.close();}
 const u=setup(async()=>image,{state:'uncertain',reason:'no_server_ack_yet'});
 try{
  await u.bridge.groups();u.bridge.receive(message('/img cat'));await u.bridge.repliesIdle();
  for(let i=0;i<5;i++)await u.bridge.tick();
  assert.equal(u.sent.length,1);assert(u.text.includes('图片发送结果未确认，请先查看群里是否收到。'));
  const member=u.bridge.memory.members(group.id)[0]!;assert.equal(u.bridge.memory.history(group.id,member.id).length,0);
 }finally{await u.close();}
});

test('Gemini images use the native local API and the phone accepts only verified image acknowledgements',async()=>{
 let mode='image',phoneCalls=0,expectedPrompt='白猫';
 const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
  res.setHeader('Content-Type','application/json');
  if(req.url==='/send/image'){
   phoneCalls++;assert.equal(body.chat_id,group.id);assert.equal(body.data,png.toString('base64'));assert.equal(body.mime_type,'image/png');
   res.end(JSON.stringify({state:'sent',reason:mode==='ack'?'wechat_server_ack':'queued'}));return;
  }
  assert.equal(req.url,'/v1beta/models/gemini-3.1-flash-image:generateContent');assert.equal(req.headers.authorization,'Bearer test-image-key');
  assert.deepEqual(body.generationConfig.responseModalities,['TEXT','IMAGE']);assert.equal(body.contents[0].parts[0].text,'请根据以下提示词生成一张图片：\n'+expectedPrompt);
  res.end(JSON.stringify({candidates:[{content:{parts:mode==='text'?[{text:'没有图片'}]:[{inlineData:{mimeType:'image/png',data:(mode==='bad'?Buffer.from('not an image, just text!'):png).toString('base64')}}]}}]}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const c=config({HERMES_API_BASE_URL:`http://127.0.0.1:${port}/v1`,HERMES_API_KEY:'test-image-key',WECHAT_HOOK_BASE_URL:`http://127.0.0.1:${port}`});
 try{
  const images=new GeminiImages(c);assert.deepEqual(Buffer.from((await images.generate('白猫',new AbortController().signal)).data),png);
  expectedPrompt='白猫\n'+('细节与构图要求。'.repeat(700));
  assert(expectedPrompt.length>5000);
  assert.deepEqual(Buffer.from((await images.generate(expectedPrompt,new AbortController().signal)).data),png);
  expectedPrompt='白猫';
  mode='text';await assert.rejects(images.generate('白猫',new AbortController().signal),/image_not_returned/);
  mode='bad';await assert.rejects(images.generate('白猫',new AbortController().signal),/invalid_image/);
  const driver=new AndroidHookDriver(c,async()=>{});assert.equal((await driver.sendImage(group,image,randomUUID())).state,'uncertain');
  mode='ack';assert.equal((await driver.sendImage(group,image,randomUUID())).state,'sent');assert.equal(phoneCalls,2);
  assert.throws(()=>validateImage(Buffer.alloc(8*1024*1024+1),'image/png'),/invalid_image/);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('image quota errors preserve reset time and return a safe Chinese message instead of provider details',async()=>{
 const {ImageGenerationError,imageErrorReply}=await import('../apps/server/src/images.js');
 let payload:unknown={error:{code:'model_cooldown',reset_seconds:9000,message:'private-provider-account secret-key'}};
 let status=429;const server=createServer((_req,res)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(payload));});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 const images=new GeminiImages(config({HERMES_API_BASE_URL:`http://127.0.0.1:${port}/v1`,HERMES_API_KEY:'test'}));
 try{
  let failure:unknown;try{await images.generate('苹果',new AbortController().signal);}catch(e){failure=e;}
  assert(failure instanceof ImageGenerationError);assert.equal(failure.reason,'image_quota_exhausted');assert.equal(failure.httpStatus,429);
  assert(failure.retryAt!>Date.now()+8990_000);assert.match(imageErrorReply(failure),/额度已用完/);assert.match(imageErrorReply(failure),/北京时间/);assert(!imageErrorReply(failure).includes('secret'));
  const reset=new Date(Date.now()+600_000).toISOString();
  payload={error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{reason:'QUOTA_EXHAUSTED',metadata:{quotaResetTimeStamp:reset}}]}};
  await assert.rejects(images.generate('苹果',new AbortController().signal),(e:unknown)=>e instanceof ImageGenerationError&&e.retryAt===Date.parse(reset)&&e.reason==='image_quota_exhausted');
  payload={error:{code:429,message:'slow down'}};
  await assert.rejects(images.generate('苹果',new AbortController().signal),(e:unknown)=>e instanceof ImageGenerationError&&e.reason==='image_rate_limited'&&!imageErrorReply(e).includes('额度'));
  status=401;payload={error:{message:'secret'}};
  await assert.rejects(images.generate('苹果',new AbortController().signal),(e:unknown)=>e instanceof ImageGenerationError&&imageErrorReply(e)==='生图服务认证失败，请联系管理员。');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('quota failure is reported to the group and records only diagnostic metadata without a retry or image send',async()=>{
 const {ImageGenerationError}=await import('../apps/server/src/images.js');let attempts=0;
 const reset=Date.now()+600_000,s=setup(async()=>{attempts++;throw new ImageGenerationError('image_quota_exhausted',429,reset);});
 try{
  await s.bridge.groups();s.bridge.receive(message('/img 苹果'));await s.bridge.repliesIdle();
  for(let i=0;i<4;i++)await s.bridge.tick();assert.equal(attempts,1);assert.equal(s.sent.length,0);
  assert(s.text.some(t=>t.includes('生图模型额度已用完')&&t.includes('北京时间')));
  const diagnostic=JSON.parse(s.store.get('last_image_error')!);assert.equal(diagnostic.reason,'image_quota_exhausted');assert.equal(diagnostic.http_status,429);assert.equal(diagnostic.retry_at,reset);assert.equal(diagnostic.prompt,undefined);
 }finally{await s.close();}
});

test('same-group users queue without drops; sessions isolate users and groups and survive restart',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nila-sessions-')),path=join(dir,'db');
 const calls:{prompt:string;session?:string}[]=[];
 let release!:(picture:GeneratedImage)=>void,started!:()=>void;
 const ready=new Promise<void>(r=>started=r);
 let s=setup(async(prompt,_signal,session)=>{calls.push({prompt,session});if(prompt==='A1'){started();return new Promise(r=>release=r);}return image;},undefined,path);
 try{
  await s.bridge.groups();s.bridge.receive(message('/img A1'));await ready;
  s.bridge.receive({...message('/img B1'),sender:'Alice',sender_wxid:'wxid_bob'});
  s.bridge.receive(message('/img A2'));s.bridge.receive(message('/img other-group',second));
  s.bridge.receive(message('@Nila 同群文字不被生图阻塞'));
  await new Promise(r=>setImmediate(r));assert.deepEqual(s.ai,['同群文字不被生图阻塞']);
  release(image);await s.bridge.repliesIdle();
  assert.deepEqual(calls.map(c=>c.prompt),['A1','B1','A2','other-group']);
  assert.equal(calls[0]!.session,calls[2]!.session);assert.notEqual(calls[0]!.session,calls[1]!.session);assert.notEqual(calls[0]!.session,calls[3]!.session);
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM job_images').get()!.n,4);
  await s.close();s=setup(async(prompt,_signal,session)=>{calls.push({prompt,session});return image;},undefined,path);
  await s.bridge.groups();s.bridge.receive({...message('/img after-restart'),sender:'改过的昵称'});await s.bridge.repliesIdle();
  assert.equal(calls.at(-1)!.session,calls[0]!.session);
 }finally{release?.(image);await s.close();rmSync(dir,{recursive:true});}
});

test('/newimg cancels only its sender old images, preserves text memory and routes a following request into the new session',async()=>{
 const calls:{prompt:string;session?:string}[]=[];let started!:()=>void;
 const ready=new Promise<void>(r=>started=r);
 const s=setup(async(prompt,signal,session)=>{
  calls.push({prompt,session});if(prompt==='old'){started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));}return image;
 });
 try{
  await s.bridge.groups();const alice=s.bridge.memory.identifyWechat(group.id,'wxid_alice','Alice');
  s.bridge.memory.patch(group.id,alice.id,{notes:'我的文字笔记'});
  s.bridge.receive(message('/img old'));await ready;
  s.bridge.receive(message('/img old-queued'));
  s.bridge.receive({...message('/img Bob'),sender:'Bob',sender_wxid:'wxid_bob'});
  const reset=message('/newimg');s.bridge.receive(reset);s.bridge.receive(message('/img fresh'));s.bridge.receive(reset);
  await s.bridge.repliesIdle();
  assert.deepEqual(calls.map(c=>c.prompt),['old','Bob','fresh']);assert.notEqual(calls[0]!.session,calls[2]!.session);
  assert.equal(s.bridge.memory.member(group.id,alice.id)!.notes,'我的文字笔记');
  assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE content LIKE '已切换到你的新生图对话%'").get()!.n,1);
  const imagePrompts=s.store.db.prepare('SELECT content FROM jobs WHERE id IN (SELECT job_id FROM job_images)').all().map(j=>j.content);
  // Membership is checked here; generation order is asserted by calls above.
  assert.deepEqual(imagePrompts.sort(),['[图片] Bob','[图片] fresh']);
  assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE reason='image_session_reset'").get()!.n,2);
 }finally{await s.close();}
});

test('/newimg also invalidates a generated image waiting for delivery without affecting another user',async()=>{
 const s=setup(async()=>image);
 try{
  await s.bridge.groups();s.bridge.receive(message('/img old'));
  s.bridge.receive({...message('/img Bob'),sender:'Bob',sender_wxid:'wxid_bob'});await s.bridge.repliesIdle();
  const alice=s.bridge.memory.members(group.id).find(m=>m.name==='Alice')!;
  const oldSession=s.bridge.memory.imageSession(group.id,alice.id);
  s.bridge.receive(message('/newimg'));await s.bridge.repliesIdle();
  assert.notEqual(s.bridge.memory.imageSession(group.id,alice.id),oldSession);
  for(let i=0;i<8;i++)await s.bridge.tick();
  assert.equal(s.sent.length,1);
  assert.equal(s.store.db.prepare("SELECT state FROM jobs WHERE content='[图片] old'").get()!.state,'failed');
  assert.equal(s.store.db.prepare("SELECT state FROM jobs WHERE content='[图片] Bob'").get()!.state,'sent');
 }finally{await s.close();}
});
