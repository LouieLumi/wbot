import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../apps/server/src/store.js';
import {Memories,type Turn} from '../apps/server/src/memory.js';
import {memberMemoryKey,type MemberMemoryBackend,type MemorySnapshot,type MemoryDraft} from '../apps/server/src/hermes-memory.js';
import {Bridge} from '../apps/server/src/bridge.js';
import {readConfig} from '../apps/server/src/config.js';
import {createApi} from '../apps/server/src/api.js';
import type {Chat,DeviceAdapter,Message} from '../packages/shared/types.js';

class NativeMemoryFixture implements MemberMemoryBackend {
  root='/unused/test-profiles';profiles=new Map<string,MemorySnapshot>();commits=new Set<string>();failNext=false;
  ensure(key:string,notes:string[],history:(Turn&{seq:number})[]){
    if(!this.profiles.has(key))this.profiles.set(key,{key,epoch:1,user:notes,memory:[],notes:notes.join('\n§\n'),summary:'',history,
      turn_count:history.length,backend:'hermes',session_id:randomUUID()});
    return this.snapshot(key);
  }
  snapshot(key:string){return structuredClone(this.profiles.get(key)!);}
  patch(key:string,patch:{notes?:string;summary?:string}){const s=this.profiles.get(key)!;Object.assign(s,patch);s.user=s.notes?s.notes.split('\n§\n'):[];s.memory=s.summary?s.summary.split('\n§\n'):[];s.epoch++;}
  reset(key:string,notes:boolean){const s=this.profiles.get(key)!;s.history=[];s.turn_count=0;s.epoch++;if(notes)this.patch(key,{notes:'',summary:''});}
  commit(key:string,job:string,user:string,answer:string,draft?:MemoryDraft){
    if(this.failNext){this.failNext=false;throw new Error('hermes_memory_unavailable');}
    if(this.commits.has(job))return;
    const s=this.profiles.get(key)!;if(draft){assert.equal(draft.key,key);assert.equal(draft.epoch,s.epoch);this.patch(key,{notes:draft.user.join('\n§\n'),summary:draft.memory.join('\n§\n')});}
    s.history.push({role:'user',content:user,created_at:Date.now()},{role:'assistant',content:answer,created_at:Date.now()});s.turn_count+=2;this.commits.add(job);
  }
}
const groups:Chat[]=[{id:'a@chatroom',name:'A',type:'group',verified:true},{id:'b@chatroom',name:'B',type:'group',verified:true}];
const config=()=>readConfig({BRIDGE_API_TOKEN:'x'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'a'.repeat(64),WECHAT_BOT_NAME:'Nila',WECHAT_REPLY_MODE:'text_mention',WECHAT_ALLOWED_CHAT_IDS:JSON.stringify(groups.map(g=>g.id))});
const driver=():DeviceAdapter=>({status:async()=>({}),chats:async()=>groups,send:async()=>({state:'sent',reason:'wechat_server_ack'}),pollEvents:async()=>({messages:[],reliability:'code_events'}),snapshot:async()=>{throw Error('No screenshots');}});
const message=(group=groups[0]!):Message=>({event:'message.received',message_id:randomUUID(),chat_id:group.id,chat_name:group.name,chat_type:'group',sender:'同名',sender_wxid:'wxid_alice',own:false,mention:'text',content:'@Nila 你好',timestamp:Date.now()});
async function until(check:()=>boolean){for(let i=0;i<1000;i++){if(check())return;await new Promise(r=>setTimeout(r,1));}throw Error('Condition not reached');}

test('migration merges one verified person across groups, retains history and never merges names',()=>{
  const store=new Store(':memory:');try{
    const old=new Memories(store);old.sync(groups,groups.map(g=>g.id));
    const a=old.identifyWechat(groups[0]!.id,'wxid_alice','同名');old.identifyWechat(groups[1]!.id,'wxid_alice','新昵称');
    const b=old.identifyWechat(groups[1]!.id,'wxid_bob','同名');
    store.db.prepare('UPDATE members SET notes=? WHERE chat_id=? AND id=?').run('喜欢猫',groups[0]!.id,a.id);
    store.db.prepare('UPDATE members SET notes=? WHERE chat_id=? AND id=?').run('正在学日语',groups[1]!.id,a.id);
    store.db.prepare('DELETE FROM member_profiles').run();
    const put=store.db.prepare('INSERT INTO turns(chat_id,member_id,role,content,created_at) VALUES(?,?,?,?,?)');
    for(const group of groups){put.run(group.id,a.id,'user',group.name+' question',1);put.run(group.id,a.id,'assistant',group.name+' answer',2);}
    const backend=new NativeMemoryFixture(),memory=new Memories(store,backend);
    assert.equal(memory.member(groups[0]!.id,a.id)!.notes,'喜欢猫\n§\n正在学日语');
    assert.deepEqual(memory.history(groups[0]!.id,a.id),memory.history(groups[1]!.id,a.id));assert.equal(memory.history(groups[0]!.id,a.id).length,4);
    assert.equal(memory.member(groups[1]!.id,b.id)!.notes,'');assert.equal(memory.allMembers().length,2);assert.equal(backend.profiles.size,2);
    assert.notEqual(memberMemoryKey('a','legacy-name'),memberMemoryKey('b','legacy-name'));
    assert.equal(memberMemoryKey(groups[0]!.id,a.id),memberMemoryKey(groups[1]!.id,a.id));
  }finally{store.close();}
});

test('reset in any group invalidates all of that member’s pending replies and does not resurrect migrated data',()=>{
  const store=new Store(':memory:'),backend=new NativeMemoryFixture();try{
    const memory=new Memories(store,backend);memory.sync(groups,groups.map(g=>g.id));
    const a=memory.identifyWechat(groups[0]!.id,'wxid_alice','A'),a2=memory.identifyWechat(groups[1]!.id,'wxid_alice','A'),b=memory.identifyWechat(groups[0]!.id,'wxid_bob','B');
    memory.patch(a.chat_id,a.id,{notes:'跨群资料'});memory.patch(b.chat_id,b.id,{notes:'Bob only'});
    const jobs=[a,a2].map(m=>{const job=store.enqueue(m.chat_id,'old');memory.stage(job.id,memory.member(m.chat_id,m.id)!,'q','old');return job;});
    memory.reset(a2.chat_id,a2.id);for(const job of jobs){assert(!memory.valid(job.id));memory.complete(job.id,true);}
    assert.equal(memory.member(a.chat_id,a.id)!.notes,'');assert.equal(memory.history(a.chat_id,a.id).length,0);
    assert.equal(memory.member(b.chat_id,b.id)!.notes,'Bob only');
    assert.equal(new Memories(store,backend).member(a.chat_id,a.id)!.notes,'');
  }finally{store.close();}
});

test('a native commit failure is recoverable without sending the message a second time',()=>{
  const store=new Store(':memory:'),backend=new NativeMemoryFixture();try{
    const memory=new Memories(store,backend),a=memory.identifyWechat('a','wxid_alice','A');
    const job=store.enqueue('a','delivered');memory.stage(job.id,a,'question','delivered');store.update(job.id,'sent','wechat_server_ack');backend.failNext=true;
    assert.throws(()=>memory.complete(job.id,true),/unavailable/);assert(memory.pendingMember('a',a.id));
    memory.reconcile();memory.reconcile();assert.equal(backend.commits.size,1);assert.equal(memory.history('a',a.id).length,2);assert(!memory.pendingMember('a',a.id));
  }finally{store.close();}
});

test('same member in two groups waits for delivered memory before generating the second answer',async()=>{
  const store=new Store(':memory:'),backend=new NativeMemoryFixture(),memory=new Memories(store,backend);let calls=0;
  const bridge=new Bridge(config(),driver(),store,{reply:async m=>{
    calls++;const snapshot=backend.snapshot(memberMemoryKey(m.chat_id,m.member_id!));
    if(calls===2){assert.equal(snapshot.notes,'喜欢蓝色');assert.equal(snapshot.history.length,2);}
    return {content:'answer '+calls,memory:{key:snapshot.key,epoch:snapshot.epoch,user:['喜欢蓝色'],memory:[]}};
  }},memory);
  try{
    await bridge.groups();bridge.control(false,true);bridge.receive(message());bridge.receive(message(groups[1]!));
    await until(()=>Boolean(store.db.prepare("SELECT 1 FROM jobs WHERE idem LIKE 'reply:%'").get()));assert.equal(calls,1);
    // A queued receipt can precede the first generated answer. Only delivery of
    // the answer unlocks the same member's next prompt in another group.
    while(store.next()&&calls===1)await bridge.tick();
    await bridge.repliesIdle();assert.equal(calls,2);await bridge.tick();assert.equal(memory.history(groups[1]!.id,memory.members(groups[1]!.id)[0]!.id).length,4);
  }finally{await bridge.close();store.close();}
});

test('reset from another group discards a running Hermes memory draft',async()=>{
  const store=new Store(':memory:'),backend=new NativeMemoryFixture(),memory=new Memories(store,backend);let release!:(r:any)=>void;
  const bridge=new Bridge(config(),driver(),store,{reply:async m=>new Promise(resolve=>{release=()=>resolve({content:'stale',memory:{...backend.snapshot(memberMemoryKey(m.chat_id,m.member_id!)),user:['must not return']}});})},memory);
  try{
    await bridge.groups();bridge.control(false,true);bridge.receive(message());await until(()=>Boolean(release));
    const member=memory.identifyWechat(groups[1]!.id,'wxid_alice','A');memory.reset(member.chat_id,member.id);release(null);await bridge.repliesIdle();
    assert.equal(store.next(),undefined);assert.equal(memory.member(member.chat_id,member.id)!.notes,'');assert.equal(backend.commits.size,0);
  }finally{await bridge.close();store.close();}
});

test('admin lists one person and edits the shared Hermes memory while group authorization stays local',async()=>{
  const store=new Store(':memory:'),memory=new Memories(store,new NativeMemoryFixture()),bridge=new Bridge(config(),driver(),store,{reply:async()=>''},memory);
  const app=await createApi(config(),bridge),headers={authorization:'Bearer '+'x'.repeat(64)};
  try{
    await bridge.groups();const a=memory.identifyWechat(groups[0]!.id,'wxid_alice','A');memory.identifyWechat(groups[1]!.id,'wxid_alice','A');
    assert.equal((await app.inject({url:'/api/admin/members',headers})).json().members.length,1);
    const path=`/api/admin/groups/${groups[1]!.id}/members/${a.id}`;
    assert.equal((await app.inject({method:'PATCH',url:path,headers,payload:{notes:'共享',summary:'长期计划'}})).statusCode,200);
    const first=(await app.inject({url:`/api/admin/groups/${groups[0]!.id}/members/${a.id}`,headers})).json().member;
    assert.equal(first.notes,'共享');assert.equal(first.summary,'长期计划');
    await bridge.groupPatch(groups[1]!.id,{enabled:false});assert(bridge.isAllowed(groups[0]!.id));assert(!bridge.isAllowed(groups[1]!.id));
  }finally{await app.close();store.close();}
});
