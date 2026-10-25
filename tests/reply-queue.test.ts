import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Bridge} from '../apps/server/src/bridge.js';
import {Store} from '../apps/server/src/store.js';
import {ReplyQueue} from '../apps/server/src/reply-queue.js';
import {readConfig} from '../apps/server/src/config.js';
import type {Responder} from '../apps/server/src/openclaw.js';
import type {Message,DeviceAdapter} from '../packages/shared/types.js';

const groups=[{id:'a@chatroom',name:'A',type:'group' as const,verified:true},{id:'b@chatroom',name:'B',type:'group' as const,verified:true}];
const message=(who:string,content='你好',chat=groups[0]!.id):Message=>({event:'message.received',message_id:randomUUID(),chat_id:chat,chat_name:chat,
  chat_type:'group',sender:who,sender_wxid:'wxid_'+who,content:'@Nila '+content,own:false,mention:'text',timestamp:Date.now()});
const turn=()=>new Promise<void>(r=>setImmediate(r));
function setup(reply:Responder['reply'],path=':memory:'){
  const store=new Store(path),sent:string[]=[];
  const driver:DeviceAdapter={status:async()=>({}),chats:async()=>groups,pollEvents:async()=>({messages:[],reliability:'code_events'}),
    snapshot:async()=>{throw Error('No UI');},send:async(_chat,text)=>{sent.push(text);return {state:'sent',reason:'wechat_server_ack'};}};
  const config=readConfig({BRIDGE_API_TOKEN:'a'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'b'.repeat(64),WECHAT_BOT_NAME:'Nila',WECHAT_REPLY_MODE:'text_mention',WECHAT_ALLOWED_CHAT_IDS:JSON.stringify(groups.map(g=>g.id))});
  const bridge=new Bridge(config,driver,store,{reply});bridge.control(false,true);
  return {bridge,store,sent,driver,async close(){await bridge.close();store.close();}};
}
async function drain(s:ReturnType<typeof setup>){
  for(let i=0;i<1000;i++){
    await s.bridge.tick();await turn();
    if(!s.bridge.replyQueue.count()&&!s.store.next()&&!s.bridge.replyStatus().active)return;
  }
  assert.fail('queue did not drain');
}

test('a same-group burst queues all 12 members exactly once, with two concurrent generations and no cooldown loss',async()=>{
  let active=0,max=0;const seen:string[]=[],release:(()=>void)[]=[];
  const s=setup(async m=>{seen.push(m.message_id);active++;max=Math.max(max,active);await new Promise<void>(r=>release.push(r));active--;return 'answer:'+m.message_id;});
  try{
    await s.bridge.groups();const requests=Array.from({length:12},(_,i)=>message('member'+i));
    for(const request of requests){s.bridge.receive(request);s.bridge.receive(request);}
    await turn();assert.equal(active,2);assert.equal(s.bridge.replyQueue.count(),12);
    for(let i=0;i<20&&s.bridge.replyQueue.count();i++){release.splice(0).forEach(r=>r());await turn();}
    await drain(s);assert.equal(max,2);assert.equal(new Set(seen).size,12);assert.equal(seen.length,12);
    assert.equal(s.sent.filter(t=>t.startsWith('answer:')).length,12);
    s.bridge.receive(message('newMember','紧接上一条回答'));await turn();release.splice(0).forEach(r=>r());await drain(s);
    assert.equal(seen.length,13);
  }finally{release.splice(0).forEach(r=>r());await s.close();}
});

test('a member waits for their cross-group memory commit while another member proceeds',async()=>{
  const calls:string[]=[];let s:ReturnType<typeof setup>;
  s=setup(async m=>{calls.push(m.content);if(m.content==='A2')assert.equal(s.bridge.memory.history(m.chat_id,m.member_id!).length,2);return m.content+' answer';});
  try{
    await s.bridge.groups();s.bridge.receive(message('alice','A1'));s.bridge.receive(message('alice','A2',groups[1]!.id));s.bridge.receive(message('bob','B1'));
    await s.bridge.repliesIdle();assert.deepEqual(calls,['A1','B1']);
    await drain(s);assert.deepEqual(calls,['A1','B1','A2']);assert.equal(s.sent.filter(t=>t.endsWith(' answer')).length,3);
  }finally{await s.close();}
});

test('model errors and empty responses produce a visible error and do not poison the next queued reply',async()=>{
  const s=setup(async m=>{if(m.content==='timeout')throw Error('hermes_timeout');if(m.content==='empty')return ' ';return '正常回复';});
  try{
    await s.bridge.groups();for(const [i,text] of ['timeout','empty','ok'].entries())s.bridge.receive(message('person'+i,text));
    await drain(s);assert(s.sent.some(t=>t.includes('回复超时')));assert(s.sent.some(t=>t.includes('没能生成回复')));assert(s.sent.includes('正常回复'));
    assert.equal(s.store.db.prepare("SELECT count(*) n FROM reply_requests WHERE state='failed'").get()!.n,2);
  }finally{await s.close();}
});

test('a full queue explicitly rejects excess messages once and rapid personal commands are not silently discarded',async()=>{
  const s=setup((_m,signal)=>new Promise(resolve=>signal!.addEventListener('abort',()=>resolve('cancelled'),{once:true})));
  try{
    await s.bridge.groups();for(let i=0;i<100;i++)s.bridge.receive(message('person'+i));
    const extra=message('extra');s.bridge.receive(extra);s.bridge.receive(extra);
    assert.equal(s.bridge.replyQueue.count(),100);
    assert.equal(s.store.db.prepare("SELECT count(*) n FROM jobs WHERE content LIKE '%回复队列已满%'").get()!.n,1);
    for(let i=0;i<12;i++)s.bridge.receive({...message('commands'),content:'/memory'});
    for(let i=0;i<30;i++)await turn();
    assert.equal(s.store.db.prepare("SELECT count(*) n FROM jobs WHERE content LIKE '你的记忆%'").get()!.n,12);
  }finally{await s.close();}
});

test('reset, group stop and revocation invalidate queued and running prompts before delivery',async()=>{
  for(const change of ['reset','stop','revoke'] as const){
    const releases:(()=>void)[]=[],calls:string[]=[];
    const s=setup(async m=>{calls.push(m.content);await new Promise<void>(r=>releases.push(r));return 'must not deliver';});
    try{
      await s.bridge.groups();s.bridge.receive(message('alice','first'));s.bridge.receive(message('alice','second'));await turn();
      const member=s.bridge.memory.members(groups[0]!.id)[0]!;
      if(change==='reset')s.bridge.memory.reset(member.chat_id,member.id);
      if(change==='stop')s.bridge.memory.groupControl(groups[0]!.id,true);
      if(change==='revoke')await s.bridge.groupPatch(groups[0]!.id,{enabled:false});
      releases.splice(0).forEach(r=>r());await drain(s);
      assert.deepEqual(calls,['first']);assert(!s.sent.includes('must not deliver'));
      assert.equal(s.store.db.prepare("SELECT count(*) n FROM reply_requests WHERE state='cancelled'").get()!.n,2);
    }finally{releases.splice(0).forEach(r=>r());await s.close();}
  }
});

test('queued prompts survive restart intact; interrupted generation is notified without replay or duplicate delivery',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wbot-replies-')),path=join(dir,'bridge.sqlite');const calls:string[]=[];
  let s=setup((m,signal)=>new Promise(resolve=>{calls.push(m.content);signal!.addEventListener('abort',()=>resolve('cancelled'),{once:true});}),path);
  try{
    await s.bridge.groups();s.bridge.receive(message('alice','first'));const next=message('alice','second\n完整内容🌙');s.bridge.receive(next);await turn();
    await s.close();s=setup(async m=>{calls.push(m.content);return '恢复成功';},path);await s.bridge.groups();await drain(s);
    assert.deepEqual(calls,['first','second\n完整内容🌙']);assert.equal(s.sent.filter(t=>t==='恢复成功').length,1);
    assert.equal(s.sent.filter(t=>t.includes('服务重启中断')).length,1);
    await s.bridge.groups();s.bridge.receive(next);await drain(s);assert.equal(calls.length,2);
  }finally{await s.close();rmSync(dir,{recursive:true,force:true});}
});

test('live events are processed before history; many groups archive one page per tick in round-robin order',async()=>{
  const order:string[]=[],s=setup(async()=>{order.push('reply');return 'ok';});let first=true;
  s.driver.pollEvents=async()=>{order.push('events');return {messages:first?(first=false,[message('alice')]):[],reliability:'code_events'};};
  s.driver.groupHistory=async chat=>{order.push('history:'+chat);assert(s.bridge.replyQueue.count()>0||!first);return {chat_id:chat,source:'a'.repeat(64),cursor:0,has_more:true,messages:[]};};
  try{
    await s.bridge.tick();assert.equal(order[0],'events');assert.equal(order.filter(t=>t.startsWith('history:')).length,1);
    await s.bridge.tick();assert.deepEqual(order.filter(t=>t.startsWith('history:')),groups.map(g=>'history:'+g.id));
    await drain(s);
  }finally{await s.close();}
});

test('voice busy receipt decisions survive restart and old reply queues migrate without losing prompts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wbot-voice-queue-')),path=join(dir,'bridge.sqlite');let store=new Store(path);
  try{
    store.db.exec(`CREATE TABLE reply_requests(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,member_id TEXT NOT NULL,revision INTEGER NOT NULL,message TEXT NOT NULL,
      state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`);
    const old=message('old'),busy=message('busy');
    store.db.prepare("INSERT INTO reply_requests(id,chat_id,member_id,revision,message,state,created_at,updated_at) VALUES(?,?,?,?,?,'queued',1,1)")
      .run(old.message_id,old.chat_id,'old',0,JSON.stringify(old));
    const queue=new ReplyQueue(store);queue.add(busy,'busy',0,true);
    store.close();store=new Store(path);
    const restored=new ReplyQueue(store).waiting();
    assert.deepEqual(restored.map(r=>({id:r.id,voice_blocked:r.voice_blocked})),[
      {id:old.message_id,voice_blocked:false},{id:busy.message_id,voice_blocked:true}]);
    assert.deepEqual(restored.map(r=>r.message),[old,busy]);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
