import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/server/src/store.js';
import {Memories} from '../apps/server/src/memory.js';
import {Bridge} from '../apps/server/src/bridge.js';
import {AndroidHookDriver} from '../apps/server/src/android-hook.js';
import {readConfig} from '../apps/server/src/config.js';
import {createApi} from '../apps/server/src/api.js';
import type {DeviceAdapter,Message,SignupRequest} from '../packages/shared/types.js';
const group={id:'new123@chatroom',name:'新群',type:'group' as const,verified:true};
const request={request_id:group.id+':s100',chat_id:group.id,chat_name:group.name,requested_at:Date.now()};
const token='signup-test-token'.repeat(4);
const config=()=>readConfig({BRIDGE_API_TOKEN:token,WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'a'.repeat(64),AI_PROVIDER:'ollama',WECHAT_ALLOWED_CHAT_IDS:'[]',WECHAT_AUTO_REPLY:'true',WECHAT_REPLY_MODE:'text_mention',WECHAT_BOT_NAME:'Nila'});
const incoming=(id:string):Message=>({event:'message.received',message_id:id,chat_id:group.id,chat_name:group.name,chat_type:'group',sender:'发起人',sender_wxid:'wxid_alice',content:'@Nila 你好',own:false,mention:'text',timestamp:Date.now()});

test('signup enrolls without authorization, acknowledges once, and only permits chat after admin approval',async()=>{
 const store=new Store(':memory:');let requests=[request],events=[incoming('before')],ack=0,model=0,sent=0,permissions:string[]=[];
 const driver:DeviceAdapter={status:async()=>({}),chats:async()=>[group],snapshot:async()=>{throw Error('no screenshots');},
  signupRequests:async()=>requests,acknowledgeSignup:async r=>{assert.equal(r.request_id,request.request_id);ack++;return {state:'sent',reason:'wechat_server_ack'};},
  setAuthorized:async ids=>{permissions=ids;},pollEvents:async()=>({messages:events.splice(0),reliability:'code_events'}),send:async()=>{sent++;return {state:'sent',reason:'wechat_server_ack'};}};
 const bridge=new Bridge(config(),driver,store,{reply:async()=>{model++;return '你好';}}),app=await createApi(config(),bridge),headers={authorization:'Bearer '+token};bridge.control(false,false);
 try{
  await bridge.tick();assert.equal(bridge.memory.group(group.id)?.enabled,false);assert.equal(bridge.memory.group(group.id)?.signup_pending,true);assert.deepEqual(permissions,[]);
  assert.equal(store.next()?.content,'已发起使用请求');assert.equal(model,0);assert.equal(bridge.memory.members(group.id).length,0);
  await bridge.tick();await bridge.tick();assert.equal(ack,1);assert.equal(sent,0);assert.equal(store.db.prepare('SELECT count(*) n FROM jobs').get()?.n,1);
  const page=(await app.inject({url:'/api/admin/state',headers})).json();assert.equal(page.groups[0].signup_pending,true);
  assert.equal((await app.inject({method:'POST',url:'/api/messages/send',headers,payload:{chat_id:group.id,content:'不得绕过授权'}})).statusCode,403);
  // Even an identical acknowledgement text in the normal queue cannot bypass authorization.
  const forged=store.enqueue(group.id,'已发起使用请求');await bridge.tick();assert.equal(store.job(forged.id)?.state,'failed');assert.equal(sent,0);
  assert.equal((await app.inject({method:'PATCH',url:'/api/admin/groups/'+group.id,headers,payload:{enabled:true}})).statusCode,200);
  assert.deepEqual(permissions,[group.id]);assert.equal(bridge.memory.group(group.id)?.signup_pending,false);
  requests=[];bridge.control(false,true);events=[incoming('after')];await bridge.tick();await bridge.repliesIdle();await bridge.tick();assert.equal(model,1);assert.equal(sent,1);
  await app.inject({method:'PATCH',url:'/api/admin/groups/'+group.id,headers,payload:{enabled:false}});events=[incoming('revoked')];await bridge.tick();await bridge.repliesIdle();assert.equal(model,1);assert.deepEqual(permissions,[]);
 }finally{await app.close();store.close();}
});

test('pending requests survive host restart and repeated signup never revokes existing approval',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'signup-'));let store=new Store(join(dir,'db'));
 try{
  let memory=new Memories(store);const job=memory.requestSignup(request)!;assert.equal(job.content,'已发起使用请求');store.close();
  store=new Store(join(dir,'db'));memory=new Memories(store);assert.equal(memory.requestSignup(request),undefined);assert.equal(memory.signupForJob(job.id)?.request_id,request.request_id);assert.equal(memory.group(group.id)?.signup_pending,true);
  memory.groupPatch(group.id,{enabled:true});const second={...request,request_id:group.id+':s200',requested_at:request.requested_at+60001};memory.requestSignup(second);
  assert.equal(memory.group(group.id)?.enabled,true);assert.equal(memory.group(group.id)?.signup_pending,false);assert.equal(store.db.prepare('SELECT count(*) n FROM groups').get()?.n,1);
  memory.groupPatch(group.id,{enabled:false});memory.requestSignup({...second,request_id:group.id+':s300'});assert.equal(memory.group(group.id)?.enabled,false);assert.equal(memory.group(group.id)?.signup_pending,true);
 }finally{store.close();rmSync(dir,{recursive:true});}
});

test('phone request API is independent of event baselines and re-syncs permissions after phone restart',async()=>{
 let generation=randomUUID(),authCalls=0;const received:Record<string,unknown>[]=[];
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(64));let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):undefined;res.setHeader('content-type','application/json');
  if(req.url==='/groups')res.end(JSON.stringify({groups:[group],generation,signup_supported:true}));
  else if(req.url==='/authorization'){authCalls++;assert.deepEqual(body.chat_ids,[group.id]);res.end('{"ok":true}');}
  else if(req.url==='/signup/requests')res.end(JSON.stringify({requests:[request]}));
  else if(req.url==='/signup/ack'){received.push(body);res.end('{"state":"sent","reason":"wechat_server_ack"}');}
  else {res.statusCode=404;res.end('{}');}
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 const c={...config(),WECHAT_HOOK_BASE_URL:'http://127.0.0.1:'+(server.address() as {port:number}).port},driver=new AndroidHookDriver(c,async()=>{});
 try{
  await driver.chats();await driver.setAuthorized([group.id]);await driver.setAuthorized([group.id]);assert.equal(authCalls,1);
  driver.resetEvents();assert.deepEqual(await driver.signupRequests(),[request]);assert.equal((await driver.acknowledgeSignup(request)).state,'sent');
  assert.deepEqual(received,[{request_id:request.request_id,chat_id:group.id}]);
  generation=randomUUID();await driver.chats();await driver.setAuthorized([group.id]);assert.equal(authCalls,2);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
