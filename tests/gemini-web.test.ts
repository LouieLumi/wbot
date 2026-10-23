import test from 'node:test';
import assert from 'node:assert/strict';
import {GeminiWebImages,createGeminiWorker} from '../apps/server/src/gemini-web.js';
import {readConfig} from '../apps/server/src/config.js';
import {imageErrorReply} from '../apps/server/src/images.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const config=readConfig({BRIDGE_API_TOKEN:'b'.repeat(64),GEMINI_WEB_TOKEN:'a'.repeat(64),GEMINI_WEB_EXTENSION_ID:'a'.repeat(32),IMAGE_PROVIDER:'gemini_web'});
const headers={host:'127.0.0.1:3152',authorization:'Bearer '+config.GEMINI_WEB_TOKEN,origin:'chrome-extension://'+config.GEMINI_WEB_EXTENSION_ID};
test('local extension reload is authenticated, idle-only, version-gated and consumed once',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);
 try{
  assert.equal((await app.inject({method:'POST',url:'/reload-extension',headers:{host:headers.host}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/reload-extension',headers})).statusCode,409);
  images.extension('1.2.3');images.heartbeat(true);
  const abort=new AbortController(),pending=images.generate('test',abort.signal),cancelled=assert.rejects(pending,/image_cancelled/);
  assert.equal((await app.inject({method:'POST',url:'/reload-extension',headers})).statusCode,409);
  abort.abort();await cancelled;
  assert.equal((await app.inject({method:'POST',url:'/reload-extension',headers})).statusCode,200);
  // A new queued request must not deadlock a reload already requested at idle.
  const queuedAbort=new AbortController(),queued=images.generate('queued',queuedAbort.signal),queuedCancelled=assert.rejects(queued,/image_cancelled/);
  assert.equal(images.claim(true),null);
  const beat={method:'POST' as const,url:'/heartbeat',headers,payload:{ready:true,protocol:4,version:'1.2.3'}};
  assert.equal((await app.inject(beat)).json().reload_extension,true);assert.equal((await app.inject(beat)).json().reload_extension,undefined);
  assert(images.claim(true));queuedAbort.abort();await queuedCancelled;
 }finally{await app.close();}
});
test('generation diagnosis requires authentication and creates an isolated task without a WeChat destination',async()=>{
 const images=new GeminiWebImages(2000,1000),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  assert.equal((await app.inject({method:'POST',url:'/probe-generation',headers:{host:headers.host},payload:{prompt:'red apple'}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/probe-generation',headers,payload:{prompt:'red apple',chat_id:'chat'}})).statusCode,400);
  const response=app.inject({method:'POST',url:'/probe-generation',headers,payload:{prompt:'red apple'}}).then(r=>r);
  for(let i=0;i<50&&!images.status().pending;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const task=images.claim(true)!;assert.equal(task.prompt,'red apple');assert.equal(task.image_url,undefined);assert(task.session_id);
  images.complete(task.id,{mime_type:'image/png',data:png});
  const result=(await response).json();assert.equal(result.ok,true);assert.equal(result.bytes,png.length);assert.equal(result.data,undefined);
 }finally{await app.close();}
});
test('an unconfirmed browser submission is reported distinctly and late results are rejected',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  const pending=images.generate('test',new AbortController().signal),task=images.claim(true)!;
  const outcome=assert.rejects(pending,e=>imageErrorReply(e).includes('未能确认 Gemini 已接收'));
  const result={id:task.id,ok:false,error:'submission_failed'};
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,200);
  await outcome;assert.equal(images.status().last_error,'image_submission_failed');
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:{id:task.id,ok:true,mime_type:'image/png',data:png.toString('base64')}})).statusCode,409);
 }finally{await app.close();}
});
test('page load failure reports an unsent prompt distinctly from a generation timeout',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  const pending=images.generate('test',new AbortController().signal),task=images.claim(true)!;
  const outcome=assert.rejects(pending,e=>imageErrorReply(e).includes('页面加载失败，本次提示词尚未发送'));
  assert.equal((await app.inject({method:'POST',url:'/failure-step',headers,payload:{step:'load'}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:{id:task.id,ok:false,error:'page_load_failed'}})).statusCode,200);
  await outcome;assert.equal(images.status().last_error,'image_page_load_failed');assert.equal(images.status().failure_step,'load');
 }finally{await app.close();}
});
test('web image worker preserves long prompts including newlines, emoji and the final instructions',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);
 const prompt='第一段：\n'+('细节要求🌙\n'.repeat(1000))+'结尾要求不得丢失';
 try{
  images.heartbeat(true);const pending=images.generate(prompt,new AbortController().signal);
  const task=(await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true,protocol:4}})).json().task;
  assert.equal(task.prompt,prompt);assert(task.prompt.length>5000);
  await app.inject({method:'POST',url:'/result',headers,payload:{id:task.id,ok:true,mime_type:'image/png',data:png.toString('base64')}});
  assert.deepEqual(Buffer.from((await pending).data),png);
 }finally{await app.close();}
});
test('web worker authenticates a narrow extension channel, claims once, validates image and rejects duplicate delivery',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);
 try{
  assert.equal((await app.inject({method:'POST',url:'/claim',headers:{host:headers.host},payload:{ready:true,protocol:4}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/claim',headers:{...headers,origin:'https://gemini.google.com'},payload:{ready:true,protocol:4}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/claim',headers:{...headers,host:'evil.example'},payload:{ready:true,protocol:4}})).statusCode,403);
  await app.inject({method:'POST',url:'/heartbeat',headers,payload:{ready:true,protocol:4}});
  const pending=images.generate('白猫',new AbortController().signal);
  const task=(await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true,protocol:4}})).json().task;
  assert.equal(task.prompt,'白猫');
  assert.equal((await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true,protocol:4}})).json().task,null);
  const invalid=await app.inject({method:'POST',url:'/result',headers,payload:{id:task.id,ok:true,mime_type:'image/png',data:Buffer.from('invalid image body text').toString('base64')}});
  assert.equal(invalid.statusCode,503);assert.equal(images.status().pending,1);
  const result={id:task.id,ok:true,mime_type:'image/png',data:png.toString('base64')};
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,200);
  assert.deepEqual(Buffer.from((await pending).data),png);
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,409);
 }finally{await app.close();}
});
test('completed text is returned verbatim, bounded and only for the claimed task',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  const pending=images.generate('test',new AbortController().signal),task=images.claim(true)!;
  const text='我暂时无法生成这张图片。\n可以换一个主题。';
  const result={id:task.id,ok:false,error:'text_response',text};
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:{...result,text:' '.repeat(5)}})).statusCode,400);
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:{...result,text:'字'.repeat(2001)}})).statusCode,400);
  const outcome=assert.rejects(pending,e=>imageErrorReply(e)===text);
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,200);
  await outcome;
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,409);
  assert.equal(images.status().pending,0);
 }finally{await app.close();}
});
test('cancelled or expired web generation cannot deliver late images; disconnected browser has a bounded grace period',async()=>{
 const images=new GeminiWebImages(60,10),signal=new AbortController();
 await assert.rejects(images.generate('cat',signal.signal),e=>imageErrorReply(e).includes('未连接'));
 images.heartbeat(true);const cancelled=images.generate('cat',signal.signal);const task=images.claim(true)!;
 signal.abort();await assert.rejects(cancelled,/image_cancelled/);
 assert.equal(images.complete(task.id,{mime_type:'image/png',data:png}),false);
 await assert.rejects(images.generate('cat',new AbortController().signal),e=>imageErrorReply(e).includes('超时'));
 assert.equal(images.status().pending,0);
});
test('a request received while the browser is reconnecting waits and is delivered only once after readiness',async()=>{
 const images=new GeminiWebImages(1000,50),signal=new AbortController();
 images.heartbeat(false);
 const pending=images.generate('画一个苹果',signal.signal);
 assert.equal(images.status().pending,1);assert.equal(images.claim(false),null);
 images.heartbeat(true);
 const task=images.claim(true)!;assert.equal(task.prompt,'画一个苹果');
 images.complete(task.id,{mime_type:'image/png',data:png});
 assert.deepEqual(Buffer.from((await pending).data),png);
 assert.equal(images.complete(task.id,{mime_type:'image/png',data:png}),false);
 const waiting=new GeminiWebImages(1000,50),cancelled=waiting.generate('cat',signal.signal);
 signal.abort();await assert.rejects(cancelled,/image_cancelled/);
 waiting.heartbeat(true);assert.equal(waiting.claim(true),null);
});
test('multiple groups are serialized and quota failures do not retry or expose page text',async()=>{
 const images=new GeminiWebImages();images.heartbeat(true);
 const one=images.generate('first',new AbortController().signal),two=images.generate('second',new AbortController().signal);
 const first=images.claim(true)!;assert.equal(first.prompt,'first');assert.equal(images.claim(true),null);
 images.complete(first.id,{mime_type:'image/png',data:png});await one;
 const second=images.claim(true)!;assert.equal(second.prompt,'second');
 const app=createGeminiWorker(config,images);
 try{
  await app.inject({method:'POST',url:'/result',headers,payload:{id:second.id,ok:false,error:'quota'}});
  await assert.rejects(two,e=>imageErrorReply(e).includes('额度已用完'));
  assert.equal(images.claim(true),null);
 }finally{await app.close();}
});

test('the session protocol gates older extensions and propagates opaque sessions and cancellation',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images),signal=new AbortController();
 try{
  const session='ea216de1-e0dc-4b2c-8dfc-bbe5b7361ea0';images.heartbeat(true);
  const pending=images.generate('same user',signal.signal,session);
  const outcome=assert.rejects(pending,/image_cancelled/);
  const old=(await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true}})).json();
  assert.equal(old.task,null);assert.equal(old.upgrade_required,true);
  const task=(await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true,protocol:4,version:'1.2.0'}})).json().task;
  assert.equal(task.session_id,session);assert.equal(task.chat_id,undefined);assert.equal(task.member_id,undefined);
  const beat={ready:true,protocol:4,version:'1.2.0',task_id:task.id};
  assert.equal((await app.inject({method:'POST',url:'/heartbeat',headers,payload:beat})).json().task_active,true);
  signal.abort();await outcome;
  assert.equal((await app.inject({method:'POST',url:'/heartbeat',headers,payload:beat})).json().task_active,false);
  assert.equal(images.status().extension_version,'1.2.0');
 }finally{await app.close();}
});

test('a reset carries only its exact title and retired sessions and needs a reset-specific completion',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  const session='ea216de1-e0dc-4b2c-8dfc-bbe5b7361ea0',old='ea216de1-e0dc-4b2c-8dfc-bbe5b7361ea1';
  const pending=images.resetSession(session,{title:'wxid_alice的对话',retired_sessions:[old]},new AbortController().signal);
  assert.equal((await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true,protocol:3,version:'1.2.4'}})).json().task,null);
  const task=(await app.inject({method:'POST',url:'/claim',headers,payload:{ready:true,protocol:4,version:'1.3.0'}})).json().task;
  assert.equal(task.operation,'reset');assert.equal(task.conversation_title,'wxid_alice的对话');assert.deepEqual(task.retired_sessions,[old]);
  assert.equal(images.complete(task.id,{mime_type:'image/png',data:png}),false);
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:{id:task.id,ok:true,reset_complete:true}})).statusCode,200);
  await pending;assert.equal(images.status().pending,0);
 }finally{await app.close();}
});

test('session diagnostics cannot target a real or unknown member session',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  for(const action of ['reset','cleanup']){
   assert.equal((await app.inject({method:'POST',url:'/probe-session',headers,payload:{action,session_id:'ea216de1-e0dc-4b2c-8dfc-bbe5b7361ea0'}})).statusCode,404);
   assert.equal(images.status().pending,0);
  }
  assert.equal((await app.inject({method:'POST',url:'/probe-session',headers:{host:headers.host},payload:{action:'create'}})).statusCode,401);
 }finally{await app.close();}
});

test('a generated image download failure preserves its stage and HTTP status without another generation',async()=>{
 const images=new GeminiWebImages(),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  const pending=images.generate('test',new AbortController().signal),task=images.claim(true)!;
  const rejected=assert.rejects(pending,(e:any)=>e.reason==='image_download_failed'&&e.httpStatus===403&&imageErrorReply(e).includes('图片已经生成'));
  const result={id:task.id,ok:false,error:'download_failed',download_status:403};
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,200);
  await rejected;assert.equal(images.status().worker_failure?.error,'download_failed');assert.equal(images.status().worker_failure?.http_status,403);
  assert.equal(images.claim(true),null);
  assert.equal((await app.inject({method:'POST',url:'/result',headers,payload:result})).statusCode,409);
 }finally{await app.close();}
});

test('download diagnosis is authenticated, restricted to generated assets and returns metadata only',async()=>{
 const images=new GeminiWebImages(2000,1000),app=createGeminiWorker(config,images);images.heartbeat(true);
 try{
  assert.equal((await app.inject({method:'POST',url:'/probe-download',headers:{host:headers.host},payload:{url:'https://lh3.googleusercontent.com/gg-dl/asset'}})).statusCode,401);
  for(const url of ['http://127.0.0.1/private','https://unrelated.example/image','https://lh3.googleusercontent.com/profile/photo','blob:https://unrelated.example/123','blob:https://gemini.google.com/not-a-generated-blob']){
   assert.equal((await app.inject({method:'POST',url:'/probe-download',headers,payload:{url}})).statusCode,400);
  }
  for(const version of ['1.2.0','1.1.9','invalid']){
   images.extension(version);
   assert.equal((await app.inject({method:'POST',url:'/probe-download',headers,payload:{url:'https://lh3.googleusercontent.com/gg-dl/asset'}})).statusCode,503);
   assert.equal(images.status().pending,0);
  }
  images.extension('1.2.1');
  for(const url of ['https://lh3.googleusercontent.com/gg-dl/asset','blob:https://gemini.google.com/a852c388-2a55-4ecf-8db7-86e4f9c4337b']){
  const response=app.inject({method:'POST',url:'/probe-download',headers,payload:{url}}).then(r=>r);
  for(let i=0;i<50&&!images.status().pending;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const task=images.claim(true)!;assert.equal(task.image_url,url);
  images.complete(task.id,{mime_type:'image/png',data:png});
  const result=(await response).json();assert.equal(result.ok,true);assert.equal(result.bytes,png.length);assert.equal(result.data,undefined);
  }
 }finally{await app.close();}
});
