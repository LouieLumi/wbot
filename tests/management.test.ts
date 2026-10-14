import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../apps/server/src/store.js';
import {Memories} from '../apps/server/src/memory.js';
import {Models} from '../apps/server/src/models.js';
import {command} from '../apps/server/src/commands.js';
import {Bridge} from '../apps/server/src/bridge.js';
import {MockDriver} from '../apps/server/src/adapters.js';
import {createApi} from '../apps/server/src/api.js';
import {readConfig} from '../apps/server/src/config.js';
import type {Message} from '../packages/shared/types.js';
const token='management-test-'.repeat(4);
const config=()=>readConfig({BRIDGE_API_TOKEN:token,AI_PROVIDER:'ollama',WECHAT_DEVICE_MODE:'mock',WECHAT_AUTO_REPLY:'true',WECHAT_REPLY_MODE:'text_mention',WECHAT_BOT_NAME:'Nila',WECHAT_ALLOWED_CHAT_IDS:'["mock-group","mock-group-2"]'});
const message=(chat:string,sender:string,content:string,id=content):Message=>({event:'message.received',message_id:id,chat_id:chat,chat_name:chat,chat_type:'group',sender,content,own:false,mention:'unknown',timestamp:Date.now(),avatar_hash:sender});

test('persistent memory separates groups and members; reset invalidates unsent replies',()=>{
 const dir=mkdtempSync(join(tmpdir(),'bridge-memory-')),path=join(dir,'db');
 try{
  let store=new Store(path),memory=new Memories(store);
  const alice=memory.identify('a','Alice','avatar-a'),bob=memory.identify('a','Bob','avatar-b'),aliceElsewhere=memory.identify('b','Alice','avatar-a');
  memory.patch('a',alice.id,{notes:'喜欢猫'});const current=memory.member('a',alice.id)!;
  const job=store.enqueue('a','你好');memory.stage(job.id,current,'记住我','你好');assert.equal(memory.history('a',alice.id).length,0);
  memory.complete(job.id,true);assert.equal(memory.history('a',alice.id).length,2);assert.equal(memory.history('a',bob.id).length,0);assert.equal(memory.history('b',aliceElsewhere.id).length,0);
  store.close();store=new Store(path);memory=new Memories(store);assert.equal(memory.member('a',alice.id)?.notes,'喜欢猫');assert.equal(memory.history('a',alice.id).length,2);
  const pending=store.enqueue('a','旧答案');memory.stage(pending.id,memory.member('a',alice.id)!,'问题','旧答案');memory.reset('a',alice.id);assert.equal(memory.valid(pending.id),false);memory.complete(pending.id,true);assert.equal(memory.history('a',alice.id).length,0);assert.equal(memory.member('a',alice.id)?.notes,'');store.close();
 }finally{rmSync(dir,{recursive:true});}
});

test('two-group polling retains each window baseline across switches',async()=>{
 const c=config(),store=new Store(':memory:'),driver=new MockDriver(),calls:Message[]=[];
 const bridge=new Bridge(c,driver,store,{async reply(m){calls.push(m);return '收到';}});bridge.control(false,true);
 driver.inject('历史A');driver.active=driver.known[1]!;driver.inject('历史B');
 await bridge.tick();await bridge.tick();assert.equal(calls.length,0);
 driver.active=driver.known[0]!;driver.inject('@Nila 来自A',false,'unknown');
 driver.active=driver.known[1]!;driver.inject('@Nila 来自B',false,'unknown');
 await bridge.tick();await bridge.repliesIdle();await bridge.tick();await bridge.repliesIdle();await bridge.tick();
 assert.deepEqual(calls.map(m=>m.chat_id),['mock-group','mock-group-2']);assert.equal(driver.sent.length,2);
 const member=bridge.memory.members('mock-group')[0]!;assert.equal(bridge.memory.history('mock-group',member.id).length,2);
 await bridge.tick();await bridge.repliesIdle();assert.equal(calls.length,2);await bridge.close();store.close();
});

test('memory commands affect only their caller and management commands require an administrator',async()=>{
 const c=config(),store=new Store(':memory:'),memory=new Memories(store),models=new Models(c,store);let reads=0;
 models.list=async()=>{reads++;return [{name:'qwen3.5:4b',size:1},{name:'other:4b',size:1}];};
 memory.sync([{id:'g',name:'群',type:'group',verified:true},{id:'elsewhere',name:'其他群',type:'group',verified:true}],['g','elsewhere']);
 const a=memory.identifyWechat('g','wxid_admin','A'),b=memory.identifyWechat('g','wxid_member','B');
 await command('/remember 爱喝茶',a,memory,models);assert.equal(memory.member('g',a.id)?.notes,'爱喝茶');assert.equal(memory.member('g',b.id)?.notes,'');
 for(const input of ['/model other:4b','/models','/model','/new','/stop','/start','/status'])assert.match((await command(input,b,memory,models))!,/仅管理员/);
 assert.equal(reads,0);assert.equal(memory.group('g')?.paused,false);assert.equal(memory.group('g')?.model,'');
 const regular=(await command('/help',b,memory,models))!,admin=(await command('/menu',a,memory,models,true))!;
 assert(!regular.includes('/model'));assert(!regular.includes('/stop'));assert.match(regular,/\n\/memory/);assert.match(admin,/\n\/model/);assert.match(admin,/\n\/start/);
 memory.patch('g',b.id,{model:'qwen3.5:4b'});
 await command('/model other:4b',a,memory,models,true);assert.equal(memory.group('g')?.model,'other:4b');assert.equal(memory.member('g',b.id)?.model,'');assert.equal(memory.group('elsewhere')?.model,'');
 await assert.rejects(command('/model unavailable',a,memory,models,true),/not_installed/);assert.equal(memory.group('g')?.model,'other:4b');
 await command('/remember Bob only',memory.member('g',b.id)!,memory,models);
 await command('/reset @A',memory.member('g',b.id)!,memory,models);assert.equal(memory.member('g',b.id)?.notes,'');assert.equal(memory.member('g',a.id)?.notes,'爱喝茶');
 await command('/new',memory.member('g',a.id)!,memory,models,true);assert.equal(memory.member('g',a.id)?.notes,'爱喝茶');store.close();
});

test('admin reset during generation prevents stale answer from entering queue',async()=>{
 const c=config(),store=new Store(':memory:'),driver=new MockDriver();let release!:(s:string)=>void;
 const bridge=new Bridge(c,driver,store,{reply:()=>new Promise(r=>release=r)});await bridge.groups();bridge.control(false,true);
 bridge.receive(message('mock-group','Alice','@Nila 你好'));await new Promise(r=>setImmediate(r));const m=bridge.memory.members('mock-group')[0]!;
 bridge.memory.reset('mock-group',m.id);release('旧答案');await bridge.repliesIdle();assert.equal(store.next(),undefined);await bridge.close();store.close();
});

test('pause API waits until the in-flight device operation has ended',async()=>{
 const c=config(),store=new Store(':memory:'),driver=new MockDriver(),bridge=new Bridge(c,driver,store,{async reply(){return 'ok';}});
 let release!:()=>void,started!:()=>void;const active=new Promise<void>(r=>started=r);
 driver.snapshot=async(chat)=>{started();await new Promise<void>(r=>release=r);return {chat:chat!,rows:[],reliability:'mock'};};
 const app=await createApi(c,bridge);bridge.control(false,true);const tick=bridge.tick();await active;
 let finished=false;const pause=app.inject({method:'POST',url:'/api/control',headers:{authorization:'Bearer '+token},payload:{paused:true}}).then(r=>{finished=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(finished,false);release();await tick;
 assert.equal((await pause).json().device_busy,false);assert.equal(bridge.paused,true);await app.close();store.close();
});

test('admin auth uses one-time tickets, strict cookies and refuses cross-origin requests',async()=>{
 const c=config(),store=new Store(':memory:'),driver=new MockDriver(),bridge=new Bridge(c,driver,store,{async reply(){return 'answer';}});const app=await createApi(c,bridge),auth={authorization:'Bearer '+token};
 try{
  assert.equal((await app.inject({url:'/'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/admin/state'})).statusCode,401);
  const ticket=(await app.inject({method:'POST',url:'/api/admin/ticket',headers:auth})).json().ticket;
  const login=await app.inject({method:'POST',url:'/api/auth/exchange',payload:{ticket}});assert.equal(login.statusCode,200);
  const cookie=String(login.headers['set-cookie']).split(';')[0]!;assert.match(String(login.headers['set-cookie']),/HttpOnly; SameSite=Strict/);
  assert.equal((await app.inject({method:'POST',url:'/api/auth/exchange',payload:{ticket}})).statusCode,401);
  assert.equal((await app.inject({url:'/api/admin/state',headers:{cookie}})).statusCode,200);
  assert.equal((await app.inject({method:'POST',url:'/api/control',headers:{cookie,origin:'http://evil.example'},payload:{paused:false}})).statusCode,403);
  assert.equal((await app.inject({url:'/api/admin/state',headers:{...auth,host:'evil.example'}})).statusCode,403);
  await app.inject({method:'PATCH',url:'/api/admin/groups/mock-group',headers:{cookie},payload:{enabled:false}});
  assert.equal((await app.inject({method:'POST',url:'/api/messages/send',headers:auth,payload:{chat_id:'mock-group',content:'不得发送'}})).statusCode,403);
  await app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie}});assert.equal((await app.inject({url:'/api/admin/state',headers:{cookie}})).statusCode,401);
 }finally{await app.close();store.close();}
});

test('long nickname emoji OCR variants share a visual identity; different members do not',()=>{
 const store=new Store(':memory:'),memory=new Memories(store);
 const a=memory.identify('g','鲨鱼正在攻击海底光缆領','009a1f2f1f1b8300');
 const same=memory.identify('g','鲨鱼正在攻击海底光缆一','009a1f2f1f1b8300');
 assert.equal(a.id,same.id);
 assert.equal(memory.identify('g','鲨鱼正在攻击海底光缆領','009a1f2f1f1b8200').id,a.id);
 assert.notEqual(memory.identify('g','另一个成员','009a1f2f1f1b8300').id,a.id);
 assert.notEqual(memory.identify('g','鲨鱼正在攻击海底光缆領','0000000000000000').id,a.id);
 assert.notEqual(memory.identify('g','小明','same').id,memory.identify('g','小王','same').id);
 store.close();
});

test('admin separates archived identities, preserves memories and retains same-name real groups while offline',async()=>{
 const c=readConfig({BRIDGE_API_TOKEN:token,WECHAT_DEVICE_MODE:'android_hook',AI_PROVIDER:'ollama',WECHAT_HOOK_TOKEN:'a'.repeat(64),WECHAT_ALLOWED_CHAT_IDS:'["1@chatroom","2@chatroom"]'});
 const store=new Store(':memory:'),driver=new MockDriver();
 driver.known.splice(0,driver.known.length,{id:'1@chatroom',name:'同名群',type:'group',verified:true},{id:'2@chatroom',name:'同名群',type:'group',verified:true});
 const bridge=new Bridge(c,driver,store,{async reply(){return 'ok';}}),app=await createApi(c,bridge),headers={authorization:'Bearer '+token};
 try{
  bridge.memory.sync([{id:'legacy',name:'同名群',type:'group',verified:true}],['legacy']);
  const old=bridge.memory.identify('legacy','旧成员');bridge.memory.patch('legacy',old.id,{notes:'保留历史记忆'});
  bridge.memory.identifyWechat('1@chatroom','wxid_1','新成员');
  const legacyJob=store.enqueue('legacy','旧发送');store.update(legacyJob.id,'sent');
  const currentJob=store.enqueue('1@chatroom','新发送');store.update(currentJob.id,'sent');
  let state=(await app.inject({url:'/api/admin/state',headers})).json();
  assert.deepEqual(state.groups.map((g:{id:string})=>g.id),['1@chatroom','2@chatroom']);assert.equal(state.archived_groups.length,1);
  assert.equal(state.stats.members,1);assert.equal(state.stats.sent_today,1);assert.equal(state.jobs.length,1);
  assert.equal((await app.inject({method:'PATCH',url:'/api/admin/groups/legacy',headers,payload:{enabled:true}})).statusCode,409);
  assert.equal((await app.inject({url:`/api/admin/groups/legacy/members/${old.id}`,headers})).json().member.notes,'保留历史记忆');
  driver.chats=async()=>{throw Error('phone disconnected');};
  const offline=await app.inject({url:'/api/admin/state',headers});assert.equal(offline.statusCode,200);state=offline.json();
  assert.equal(state.groups.length,2);assert(state.groups.every((g:{verified:boolean})=>!g.verified));assert.equal(state.last_error,'device_unavailable_or_unverified');
 }finally{await app.close();store.close();}
});

test('admin delivery records validate filters, paginate deterministically, and omit message content',async()=>{
 const c=config(),store=new Store(':memory:'),driver=new MockDriver(),bridge=new Bridge(c,driver,store,{async reply(){return 'ok';}}),app=await createApi(c,bridge),headers={authorization:'Bearer '+token};
 try{
  await bridge.groups();
  for(let i=0;i<24;i++){const job=store.enqueue(i<20?'mock-group':'mock-group-2','private body '+i);store.update(job.id,i%2?'sent':'failed');}
  const first=(await app.inject({url:'/api/admin/jobs?page_size=5&state=sent&chat_id=mock-group',headers})).json();
  const second=(await app.inject({url:'/api/admin/jobs?page_size=5&page=2&state=sent&chat_id=mock-group',headers})).json();
  assert.equal(first.total,10);assert.equal(first.pages,2);assert.equal(first.items.length,5);
  assert.equal(new Set([...first.items,...second.items].map(j=>j.id)).size,10);
  assert(first.items.every((j:{state:string;content?:string})=>j.state==='sent'&&j.content===undefined));
  assert.equal((await app.inject({url:'/api/admin/jobs?scope=archived',headers})).json().total,0);
  assert.equal((await app.inject({url:'/api/admin/jobs?search='+encodeURIComponent("' OR 1=1 --"),headers})).json().total,0);
  assert.equal((await app.inject({url:'/api/admin/jobs?page_size=1000',headers})).statusCode,400);
  assert.equal((await app.inject({url:'/api/admin/jobs?state=invalid',headers})).statusCode,400);
  assert.equal((await app.inject({url:'/api/admin/jobs'})).statusCode,401);
 }finally{await app.close();store.close();}
});
