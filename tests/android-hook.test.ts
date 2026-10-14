import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {AndroidHookDriver} from '../apps/server/src/android-hook.js';
import {readConfig} from '../apps/server/src/config.js';
import {Store} from '../apps/server/src/store.js';
import {Memories} from '../apps/server/src/memory.js';
import {Bridge} from '../apps/server/src/bridge.js';
import type {Message,DeviceAdapter} from '../packages/shared/types.js';

const group={id:'123@chatroom',name:'测试群',type:'group' as const,verified:true};
const message=(seq:number):Message&{seq:number}=>({event:'message.received',message_id:'123:s'+seq,chat_id:group.id,chat_name:group.name,
  chat_type:'group',sender:'同名成员',sender_wxid:'wxid_alice',content:'@Nila 你好',own:false,mention:'text',timestamp:Date.now(),seq});
const config=(extra={})=>readConfig({BRIDGE_API_TOKEN:'b'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'a'.repeat(64),WECHAT_BOT_NAME:'Nila',
  WECHAT_ALLOWED_CHAT_IDS:JSON.stringify([group.id]),WECHAT_REPLY_MODE:'text_mention',...extra});

test('code events baseline, duplicates, overflow, pause and phone restart never replay old requests',async()=>{
  let generation=randomUUID(),events=[message(1)],cursor=1;
  const server=createServer((req,res)=>{
    assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(64));
    const after=Number(new URL(req.url!,'http://localhost').searchParams.get('after')??0);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({generation,cursor,oldest:events[0]?.seq??cursor+1,events:events.filter(e=>e.seq>after)}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=(server.address() as {port:number}).port;
  const driver=new AndroidHookDriver(config({WECHAT_HOOK_BASE_URL:`http://127.0.0.1:${port}`}),async()=>{});
  try{
    assert.equal((await driver.pollEvents()).messages.length,0);
    events.push(message(++cursor));assert.equal((await driver.pollEvents()).messages.length,1);
    assert.equal((await driver.pollEvents()).messages.length,0);
    driver.resetEvents();events.push(message(++cursor));assert.equal((await driver.pollEvents()).messages.length,0);
    events=[message(cursor=100)];assert.equal((await driver.pollEvents()).messages.length,0);
    generation=randomUUID();events=[message(cursor=1)];assert.equal((await driver.pollEvents()).messages.length,0);
    events.push(message(++cursor));assert.equal((await driver.pollEvents()).messages.length,1);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('stable member IDs survive display-name changes and separate equal names, groups and old visual records',()=>{
  const store=new Store(':memory:'),memory=new Memories(store);
  try{
    const a=memory.identifyWechat('g1','wxid_alice','同名');
    memory.patch('g1',a.id,{notes:'Alice only'});
    assert.equal(memory.identifyWechat('g1','wxid_alice','新昵称').notes,'Alice only');
    assert.equal(memory.identifyWechat('g1','wxid_bob','同名').notes,'');
    assert.equal(memory.identifyWechat('g2','wxid_alice','同名').notes,'');
    assert.notEqual(memory.identify('g1','同名').id,a.id);
    assert.equal(memory.member('g1',a.id)?.identity,'wechat_id');
  }finally{store.close();}
});

test('event adapter bypasses UI and commits memory only after a server-confirmed send',async()=>{
  const store=new Store(':memory:');let events=[message(1)],attempts=0,called=0;
  const driver:DeviceAdapter={status:async()=>({}),chats:async()=>[group],snapshot:async()=>{throw Error('UI must not be called');},
    pollEvents:async()=>({messages:events.splice(0),reliability:'code_events'}),
    send:async(_chat,_content,id)=>{assert(id);attempts++;return {state:'sent',reason:'wechat_server_ack'};}};
  const bridge=new Bridge(config(),driver,store,{reply:async m=>{called++;assert(m.member_id?.startsWith('wxid:'));return '代码回复';}});
  bridge.control(false,true);
  try{
    await bridge.tick();await bridge.repliesIdle();
    const member=bridge.memory.members(group.id)[0]!;assert.equal(bridge.memory.history(group.id,member.id).length,0);
    await bridge.tick();assert.equal(attempts,1);assert.equal(bridge.memory.history(group.id,member.id).length,2);
    events=[message(1)];await bridge.tick();await bridge.repliesIdle();assert.equal(called,1);
  }finally{await bridge.close();store.close();}
});
