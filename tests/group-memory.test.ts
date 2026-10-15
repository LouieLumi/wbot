import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../apps/server/src/store.js';
import {Memories} from '../apps/server/src/memory.js';
import {GroupMemory} from '../apps/server/src/group-memory.js';
import {Bridge} from '../apps/server/src/bridge.js';
import {readConfig} from '../apps/server/src/config.js';
import {createApi} from '../apps/server/src/api.js';
import type {DeviceAdapter,GroupHistory} from '../packages/shared/types.js';

const group={id:'123@chatroom',name:'测试群',type:'group' as const,verified:true};
const now=Date.now(),source='a'.repeat(64);
const page=(chat=group.id,id=1):GroupHistory=>({chat_id:chat,source,cursor:id,has_more:false,messages:[{local_id:id,sender_id:'wxid_alice',sender:'小明',content:'周六三点去看展',timestamp:now,truncated:false}]});

test('group archive persists a cursor atomically, deduplicates reconnects and excludes revoked intervals',()=>{
  const root=mkdtempSync(join(tmpdir(),'group-memory-')),path=join(root,'bridge.sqlite');let store=new Store(path);
  try{
    let archive=new GroupMemory(store);archive.authorize([group.id,'other@chatroom'],now);archive.accept(group.id,page(),now);
    assert.equal(archive.stats(group.id).message_count,1);assert.equal(archive.stats('other@chatroom').message_count,0);
    assert(!JSON.stringify(store.db.prepare('SELECT sender_id FROM group_messages').all()).includes('wxid_alice'));
    store.close();store=new Store(path);archive=new GroupMemory(store);archive.accept(group.id,page(),now);
    assert.equal(archive.state(group.id)?.cursor,1);assert.equal(archive.stats(group.id).message_count,1);
    assert.throws(()=>archive.accept(group.id,{...page(),cursor:0}),/invalid_group_history/);
    assert.equal(archive.state(group.id)?.cursor,1);
    archive.authorize([],now+100);archive.accept(group.id,page(group.id,2),now+100);
    assert.equal(archive.stats(group.id).message_count,1);
    archive.authorize([group.id],now+1000);assert.equal(archive.state(group.id)?.since,now+1000);
    assert.throws(()=>archive.accept(group.id,page(group.id,2),now+1000),/invalid_group_history/);
    assert.equal(archive.stats(group.id).message_count,1);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('passive history never invokes a model, creates personal profiles or replays old triggers; admin can inspect it',async()=>{
  const config=readConfig({BRIDGE_API_TOKEN:'t'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_ALLOWED_CHAT_IDS:JSON.stringify([group.id]),WECHAT_HOOK_TOKEN:'a'.repeat(64)});
  const store=new Store(':memory:');let calls=0,reads=0,fail=false,online=true;
  const driver:DeviceAdapter={status:async()=>({}),chats:async()=>online?[group]:[],snapshot:async()=>{throw Error('No UI');},send:async()=>{throw Error('No sends');},pollEvents:async()=>({messages:[],reliability:'code_events'}),
    groupHistory:async(chat,_since,after)=>{reads++;assert.equal(chat,group.id);if(fail)throw Error('offline');assert.equal(after,reads===1?0:1);return {...page(),messages:[{...page().messages[0]!,content:'@Nila 这是一条历史消息 /img 苹果'}]};}};
  const bridge=new Bridge(config,driver,store,{reply:async()=>{calls++;return '不应调用';}}),api=await createApi(config,bridge);
  bridge.control(false,false);
  try{
    await bridge.tick();assert.equal(bridge.groupMemory.stats(group.id).message_count,1);assert.equal(bridge.memory.allMembers().length,0);assert.equal(calls,0);assert.equal(store.next(),undefined);
    fail=true;await bridge.tick();assert.equal(bridge.groupMemory.state(group.id)?.error,'history_sync_failed');fail=false;
    await bridge.tick();assert.equal(bridge.groupMemory.stats(group.id).message_count,1);assert.equal(bridge.groupMemory.state(group.id)?.error,'');
    const since=bridge.groupMemory.state(group.id)?.since;
    online=false;await bridge.tick();assert.equal(bridge.groupMemory.state(group.id)?.enabled,1);
    online=true;await bridge.tick();assert.equal(bridge.groupMemory.state(group.id)?.since,since);
    const url='/api/admin/groups/'+encodeURIComponent(group.id)+'/history';assert.equal((await api.inject({url})).statusCode,401);
    assert.equal((await api.inject({url,headers:{authorization:'Bearer '+'t'.repeat(64)}})).json().messages.length,1);
    await bridge.groupPatch(group.id,{enabled:false});const before=reads;await bridge.tick();assert.equal(reads,before);assert.equal(calls,0);
  }finally{await api.close();store.close();}
});

test('group recall answers commit only to their group, never to cross-group member history or native memory',()=>{
  const store=new Store(':memory:'),memory=new Memories(store),archive=new GroupMemory(store);
  try{
    const member=memory.identifyWechat(group.id,'wxid_alice','小明');archive.authorize([group.id]);
    const job=store.enqueue(group.id,'周六三点看展');memory.stage(job.id,member,'群里安排了什么？',job.content,undefined,'group');memory.complete(job.id,true);
    assert.equal(memory.history(group.id,member.id).length,0);const elsewhere=memory.identifyWechat('other','wxid_alice','小明');assert.equal(memory.history('other',elsewhere.id).length,0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM group_answers WHERE chat_id=?').get(group.id)?.n,1);
    memory.complete(job.id,true);assert.equal(store.db.prepare('SELECT count(*) AS n FROM group_answers').get()?.n,1);
    const failed=store.enqueue(group.id,'失败');memory.stage(failed.id,member,'问题','失败',undefined,'group');memory.complete(failed.id,false);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM group_answers').get()?.n,1);
  }finally{store.close();}
});
