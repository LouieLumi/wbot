import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/server/src/store.js';
import {readConfig} from '../apps/server/src/config.js';
import {WechatAdmin} from '../apps/server/src/wechat-admin.js';
import {Bridge} from '../apps/server/src/bridge.js';
import type {DeviceAdapter,Message,GeneratedImage} from '../packages/shared/types.js';
import {Memories} from '../apps/server/src/memory.js';
import {Models} from '../apps/server/src/models.js';
const groups=[{id:'1@chatroom',name:'一群',type:'group' as const,verified:true},{id:'2@chatroom',name:'二群',type:'group' as const,verified:true}];
const config=(extra={})=>readConfig({BRIDGE_API_TOKEN:'a'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'b'.repeat(64),WECHAT_ADMIN_ID:'test_bot_admin',WECHAT_BOT_NAME:'Nila',WECHAT_REPLY_MODE:'text_mention',WECHAT_ALLOWED_CHAT_IDS:JSON.stringify(groups.map(g=>g.id)),...extra});
const msg=(content:string,username='wxid_owner',group=groups[0]!):Message=>({event:'message.received',message_id:randomUUID(),chat_id:group.id,chat_name:group.name,chat_type:'group',sender:'test_bot_admin',sender_wxid:username,content,own:false,mention:'none',timestamp:Date.now()});
const driver=():DeviceAdapter=>({status:async()=>({}),chats:async()=>groups,pollEvents:async()=>({messages:[],reliability:'code_events'}),snapshot:async()=>{throw Error('No UI');},resolveAccount:async id=>{assert.equal(id,'test_bot_admin');return 'wxid_owner';},send:async()=>({state:'sent',reason:'wechat_server_ack'})});

test('administrator identity fails closed, ignores nicknames, and pins the verified account across restart',async()=>{
 const store=new Store(':memory:'),c=config(),memory=new Memories(store),member=memory.identifyWechat(groups[0]!.id,'wxid_owner','name'),m={...msg('/help'),member_id:member.id};
 try{
  const admin=new WechatAdmin(c,store);assert.equal(admin.allows(m),false);await admin.resolve(driver());assert.equal(admin.allows(m),true);
  assert.equal(admin.allows({...m,sender_wxid:'wxid_impostor'}),false);assert.equal(admin.allows({...m,sender_wxid:undefined}),false);
  assert.equal(admin.allows({...m,member_id:'visual'}),false);assert.equal(admin.allows({...m,own:true}),false);
  const persisted=new WechatAdmin(c,store);const changed=driver();changed.resolveAccount=async()=>{throw Error('Must use pinned ID');};await persisted.resolve(changed);assert.equal(persisted.allows(m),true);
  assert.equal(new WechatAdmin(config({WECHAT_DEVICE_MODE:'adb'}),store).allows(m),false);
  assert.equal(new WechatAdmin(config({WECHAT_ADMIN_ID:'someone_else'}),store).allows(m),false);
  store.set('wechat_admin_binding','');const unknown=new WechatAdmin(c,store),missing=driver();missing.resolveAccount=async()=>null;await unknown.resolve(missing);assert.equal(unknown.allows(m),false);
 }finally{store.close();}
});

test('nickname impersonation cannot switch models and the menu is selected from the real sender account',async()=>{
 const store=new Store(':memory:'),b=new Bridge(config(),driver(),store,{reply:async()=>{throw Error('Commands must not reach AI');}});
 try{
  b.control(false,true);await b.groups();let validations=0;b.models.validate=async()=>{validations++;};
  b.receive({...msg('/model stolen','wxid_stranger'),member_id:b.memory.identifyWechat(groups[0]!.id,'wxid_owner','name').id});await b.repliesIdle();assert.equal(validations,0);
  b.receive(msg('/help','wxid_second_stranger'));await b.repliesIdle();
  b.receive(msg('/menu'));await b.repliesIdle();
  const texts=store.db.prepare('SELECT content FROM jobs').all().map(j=>String(j.content));
  assert(texts.some(t=>t.includes('仅管理员')));assert(texts.some(t=>t.includes('功能菜单')&&!t.includes('/model')));assert(texts.some(t=>t.includes('管理员菜单')&&t.includes('\n/model')));
  b.receive(msg('/model allowed'));await b.repliesIdle();assert.equal(validations,1);assert.equal(b.memory.group(groups[0]!.id)?.model,'allowed');assert.equal(b.memory.group(groups[1]!.id)?.model,'');
 }finally{await b.close();store.close();}
});

test('group stop interrupts pending work, persists across restart, and start remains accessible without affecting another group',async()=>{
 const store=new Store(':memory:'),sent:string[]=[];let release!:(s:string)=>void,started!:()=>void;
 const ready=new Promise<void>(r=>started=r),d=driver();d.send=async(_chat,text)=>{sent.push(text);return {state:'sent',reason:'wechat_server_ack'};};
 const b=new Bridge(config(),d,store,{reply:async m=>{if(m.chat_id===groups[1]!.id)return '另一群照常回答';started();return new Promise(r=>release=r);}});
 try{
  b.control(false,true);await b.groups();b.receive(msg('@Nila 未完成的问题','wxid_member'));await ready;
  const queued=store.enqueue(groups[0]!.id,'排队旧回复');b.receive(msg('/stop'));
  // A control command must complete while the responder is still blocked.
  for(let i=0;i<20&&!b.memory.group(groups[0]!.id)?.paused;i++)await new Promise(r=>setImmediate(r));
  assert.equal(b.memory.group(groups[0]!.id)?.paused,true);assert.equal(store.job(queued.id)?.state,'failed');
  b.receive(msg('@Nila 忽略这个问题','wxid_member'));b.receive(msg('@Nila 正常问题','wxid_member',groups[1]));
  release('不能发出的旧结果');await b.repliesIdle();assert(!store.db.prepare('SELECT content FROM jobs').all().some(j=>j.content==='不能发出的旧结果'));
  const persisted=new Memories(store);assert.equal(persisted.group(groups[0]!.id)?.paused,true);assert.equal(persisted.group(groups[1]!.id)?.paused,false);
  b.receive(msg('/start','wxid_intruder'));await b.repliesIdle();assert.equal(persisted.group(groups[0]!.id)?.paused,true);
  b.receive(msg('/start'));await b.repliesIdle();assert.equal(persisted.group(groups[0]!.id)?.paused,false);
  for(let i=0;i<8;i++)await b.tick();assert(sent.includes('已停用本群回复。发 /start 恢复。'));assert(sent.includes('已启用本群回复。'));assert(sent.includes('另一群照常回答'));assert(!sent.includes('排队旧回复'));
 }finally{release?.('cancel');await b.close();store.close();}
});

test('stop and restart during image generation discard the old image and progress job',async()=>{
 const store=new Store(':memory:'),c=config(),d=driver();let release!:(p:GeneratedImage)=>void,started!:()=>void;
 const ready=new Promise<void>(r=>started=r);d.sendImage=async()=>{throw Error('Old image must not be sent');};
 const b=new Bridge(c,d,store,{reply:async()=>''},new Memories(store),new Models(c,store),{generate:()=>{started();return new Promise(r=>release=r);}});
 try{
  b.control(false,true);await b.groups();b.receive(msg('/img cat','wxid_member'));await ready;b.receive(msg('/stop'));
  for(let i=0;i<20&&!b.memory.group(groups[0]!.id)?.paused;i++)await new Promise(r=>setImmediate(r));
  assert.equal(b.memory.group(groups[0]!.id)?.paused,true);b.receive(msg('/start'));
  release({mime_type:'image/png',data:new Uint8Array()});await b.repliesIdle();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM job_images').get()!.n,0);
  assert.equal(store.db.prepare("SELECT state FROM jobs WHERE idem LIKE 'progress:%'").get()!.state,'failed');
 }finally{release?.({mime_type:'image/png',data:new Uint8Array()});await b.close();store.close();}
});

test('a private one-time verification binds only a fresh real sender in the requested group, and cannot reassign the administrator',async()=>{
 const {createHash}=await import('node:crypto');const store=new Store(':memory:'),memory=new Memories(store),c=config();
 try{
  const owner=memory.identifyWechat(groups[0]!.id,'wxid_owner','name'),other=memory.identifyWechat(groups[0]!.id,'wxid_other','name');
  const admin=new WechatAdmin(c,store),event={...msg('/verify 12345678'),member_id:owner.id};
  const challenge={wechat_id:c.WECHAT_ADMIN_ID,chat_id:event.chat_id,code_hash:createHash('sha256').update('12345678').digest('hex'),created_at:Date.now()-1000,expires_at:Date.now()+60_000};
  store.set('wechat_admin_challenge',JSON.stringify(challenge));
  assert.equal(admin.verify(event,'00000000'),false);
  assert.equal(admin.verify({...event,chat_id:groups[1]!.id},'12345678'),false);
  assert.equal(admin.verify({...event,timestamp:challenge.created_at-1},'12345678'),false);
  assert.equal(admin.verify({...event,sender_wxid:undefined},'12345678'),false);
  store.set('wechat_admin_challenge',JSON.stringify({...challenge,expires_at:Date.now()-1}));assert.equal(admin.verify(event,'12345678'),false);
  store.set('wechat_admin_challenge',JSON.stringify(challenge));assert.equal(admin.verify(event,'12345678'),true);assert.equal(admin.allows(event),true);assert.equal(store.get('wechat_admin_challenge'),undefined);
  store.set('wechat_admin_challenge',JSON.stringify(challenge));assert.equal(admin.verify({...event,sender_wxid:'wxid_other',member_id:other.id},'12345678'),false);
  assert.equal(new WechatAdmin(c,store).allows(event),true);
 }finally{store.close();}
});

test('verification command is handled without AI and unlocks the administrator menu only for the verified sender',async()=>{
 const {createHash}=await import('node:crypto');const store=new Store(':memory:'),d=driver();d.resolveAccount=async()=>null;
 const b=new Bridge(config(),d,store,{reply:async()=>{throw Error('No AI for verification');}});
 try{
  b.control(false,true);await b.groups();store.set('wechat_admin_challenge',JSON.stringify({wechat_id:'test_bot_admin',chat_id:groups[0]!.id,created_at:Date.now()-1000,expires_at:Date.now()+60_000,code_hash:createHash('sha256').update('12345678').digest('hex')}));
  const event=msg('/verify 12345678');b.receive({...event,chat_id:'unknown@chatroom'});await b.repliesIdle();assert.equal(b.wechatAdmin.state.bound,false);
  b.receive(event);await b.repliesIdle();assert.equal(b.wechatAdmin.state.bound,true);assert.match(store.next()!.content,/身份已确认/);
  b.receive(msg('/help'));b.receive(msg('/menu','wxid_stranger'));await b.repliesIdle();
  const texts=store.db.prepare('SELECT content FROM jobs').all().map(j=>String(j.content));assert(texts.some(t=>t.includes('管理员菜单')));assert(texts.some(t=>t.includes('功能菜单')&&!t.includes('/model')));
 }finally{await b.close();store.close();}
});

test('one account verification grants bot-wide administration in existing and newly joined groups, including after restart',async()=>{
 const {createHash}=await import('node:crypto');const store=new Store(':memory:'),c=config(),d=driver();d.resolveAccount=async()=>null;
 let b=new Bridge(c,d,store,{reply:async()=>{throw Error('Commands must not reach AI');}});
 try{
  b.control(false,true);await b.groups();store.set('wechat_admin_challenge',JSON.stringify({wechat_id:c.WECHAT_ADMIN_ID,chat_id:groups[0]!.id,created_at:Date.now()-1000,expires_at:Date.now()+60_000,code_hash:createHash('sha256').update('12345678').digest('hex')}));
  b.receive(msg('/verify 12345678'));await b.repliesIdle();assert.equal(b.wechatAdmin.state.bound,true);
  await b.close();
  const joined={id:'3@chatroom',name:'新加入的群',type:'group' as const,verified:true};
  d.chats=async()=>[...groups,joined];d.resolveAccount=async()=>{throw Error('No repeated verification');};
  b=new Bridge(c,d,store,{reply:async()=>{throw Error('Commands must not reach AI');}});
  await b.groups();b.memory.groupPatch(joined.id,{enabled:true});b.models.validate=async()=>{};
  for(const group of [...groups,joined]){
   b.receive(msg('/menu','wxid_owner',group));await b.repliesIdle();
   b.receive(msg('/model owner-selected','wxid_owner',group));await b.repliesIdle();
   b.receive(msg('/model impostor-selected','wxid_stranger',group));await b.repliesIdle();
   assert.equal(b.memory.group(group.id)?.model,'owner-selected');
   const replies=store.db.prepare('SELECT content FROM jobs WHERE chat_id=?').all(group.id).map(j=>String(j.content));
   assert(replies.some(t=>t.includes('管理员菜单')));assert(replies.some(t=>t.includes('仅管理员')));
  }
  assert.equal(store.get('wechat_admin_challenge'),undefined);
  const binding=JSON.parse(store.get('wechat_admin_binding')!);assert.equal(binding.username,'wxid_owner');assert.equal(binding.chat_id,undefined);
 }finally{await b.close();store.close();}
});
