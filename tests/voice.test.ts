import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../apps/server/src/store.js';
import {Bridge} from '../apps/server/src/bridge.js';
import {readConfig} from '../apps/server/src/config.js';
import {validateVoice,speakable,type VoiceGenerator} from '../apps/server/src/voice.js';
import type {Responder} from '../apps/server/src/openclaw.js';
import type {DeviceAdapter,GeneratedVoice,Message} from '../packages/shared/types.js';

function audio(marker=42):GeneratedVoice{return {mime_type:'audio/silk',duration_ms:1000,
  data:Buffer.concat([Buffer.from('\x02#!SILK_V3'),...Array.from({length:50},()=>Buffer.from([1,0,marker]))])};}
test('voice parser verifies packet boundaries and duration, not client metadata',()=>{
  validateVoice(audio());
  for(const bad of [{...audio(),duration_ms:2000},{...audio(),data:audio().data.slice(0,-1)},
    {...audio(),data:Buffer.from('#!SILK_V3')},{...audio(),data:Buffer.concat([audio().data,Buffer.from([0,0])])}])assert.throws(()=>validateVoice(bad));
  assert(speakable('喵，今天过得怎么样？'));assert(!speakable('看 https://example.com'));assert(!speakable('长'.repeat(181)));
});
test('durable voice payload is idempotent and cannot change under the same job',()=>{
  const store=new Store(':memory:');try{
    const job=store.enqueue('123@chatroom','你好','test');store.attachVoice(job,audio());store.attachVoice(job,audio());
    assert.equal(store.voice(job.id)?.duration_ms,1000);
    assert.throws(()=>store.attachVoice(job,audio(43)),/idempotency_conflict/);
    store.db.prepare('UPDATE job_voices SET data=NULL').run();assert.equal(store.voice(job.id),null);
  }finally{store.close();}
});
const group={id:'123@chatroom',name:'语音测试',type:'group' as const,verified:true};
const message=(id='one',user='wxid_alice'):Message=>({event:'message.received',message_id:id,chat_id:group.id,chat_name:group.name,chat_type:'group',sender:user,
  sender_wxid:user,content:'@Gemini 说声你好',own:false,mention:'text',timestamp:Date.now()});
function setup(voices:VoiceGenerator,voice=true,reply:Responder['reply']=async()=>({content:'你好呀，喵。',voice})){
  const config=readConfig({BRIDGE_API_TOKEN:'x'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'a'.repeat(64),
    WECHAT_ALLOWED_CHAT_IDS:JSON.stringify([group.id]),WECHAT_REPLY_MODE:'text_mention',VOICE_ENABLED:'true'});
  const sent:string[]=[],store=new Store(':memory:');
  const driver:DeviceAdapter={status:async()=>({}),chats:async()=>[group],snapshot:async()=>{throw Error('no_UI');},
    pollEvents:async()=>({messages:[],reliability:'code_events'}),send:async(_c,text)=>{sent.push(text);return {state:'sent',reason:'wechat_server_ack'};},
    sendVoice:async(_c,v)=>{validateVoice(v);sent.push('voice');return {state:'sent',reason:'wechat_server_ack'};}};
  const bridge=new Bridge(config,driver,store,{reply},undefined,undefined,undefined,voices);bridge.control(false,true);
  return {bridge,store,driver,sent};
}
test('model-selected voice commits member memory only after native send confirmation',async()=>{
  const s=setup({generate:async()=>audio()});try{
    await s.bridge.groups();s.bridge.receive(message());await s.bridge.repliesIdle();
    const member=s.bridge.memory.members(group.id)[0]!;
    assert.equal(s.bridge.memory.history(group.id,member.id).length,0);assert(s.store.voice(s.store.next()!.id));
    await s.bridge.tick();assert.deepEqual(s.sent,['voice']);assert.equal(s.bridge.memory.history(group.id,member.id).at(-1)?.content,'你好呀，喵。');
  }finally{await s.bridge.close();s.store.close();}
});
test('synthesis failure delivers the exact text once; ordinary text never invokes TTS',async()=>{
  for(const selected of [true,false]){
    let called=0;const s=setup({generate:async()=>{called++;throw Error('tts_timeout');}},selected);
    try{await s.bridge.groups();s.bridge.receive(message());await s.bridge.repliesIdle();await s.bridge.tick();await s.bridge.tick();
      assert.equal(called,selected?1:0);assert.deepEqual(s.sent,['你好呀，喵。']);
    }finally{await s.bridge.close();s.store.close();}
  }
});
test('pause or authorization removal during synthesis prevents late voice delivery',async()=>{
  for(const revoke of [false,true]){
    let release!:(v:GeneratedVoice)=>void;const s=setup({generate:()=>new Promise(r=>release=r)});
    try{await s.bridge.groups();s.bridge.receive(message());
      while(!release)await new Promise(r=>setImmediate(r));
      if(revoke)s.bridge.memory.groupPatch(group.id,{enabled:false});else s.bridge.control(true);
      release(audio());await s.bridge.repliesIdle();assert.equal(s.store.next(),undefined);assert.deepEqual(s.sent,[]);
    }finally{await s.bridge.close();s.store.close();}
  }
});
test('uncertain native voice send never creates a duplicate text fallback or commits memory',async()=>{
  const s=setup({generate:async()=>audio()});let attempts=0;
  s.driver.sendVoice=async()=>{attempts++;throw Error('lost_ack');};
  try{await s.bridge.groups();s.bridge.receive(message());await s.bridge.repliesIdle();const id=s.store.next()!.id;
    await s.bridge.tick();await s.bridge.tick();assert.equal(attempts,1);assert.equal(s.store.job(id)?.state,'uncertain');assert.equal(s.store.next(),undefined);
    const member=s.bridge.memory.members(group.id)[0]!;assert.equal(s.bridge.memory.history(group.id,member.id).length,0);
  }finally{await s.bridge.close();s.store.close();}
});

test('a purged voice payload cannot accidentally be sent as a successful text reply',async()=>{
  const s=setup({generate:async()=>audio()});
  try{await s.bridge.groups();s.bridge.receive(message());await s.bridge.repliesIdle();const id=s.store.next()!.id;
    s.store.db.prepare('UPDATE job_voices SET data=NULL WHERE job_id=?').run(id);
    await s.bridge.tick();assert.deepEqual(s.sent,[]);assert.equal(s.store.job(id)?.reason,'voice_transport_unavailable');
  }finally{await s.bridge.close();s.store.close();}
});


test('confirmed native voice failure falls back to text under a distinct stable receipt ID',async()=>{
  const s=setup({generate:async()=>audio()});let fallback='';
  s.driver.sendVoice=async()=>({state:'failed',reason:'voice_preflight_failed'});
  s.driver.send=async(_chat,text,id)=>{fallback=id!;s.sent.push(text);return {state:'sent',reason:'wechat_server_ack'};};
  try{await s.bridge.groups();s.bridge.receive(message());await s.bridge.repliesIdle();const id=s.store.next()!.id;
    await s.bridge.tick();assert.equal(fallback,'voice-fallback:'+id);assert.deepEqual(s.sent,['你好呀，喵。']);
    assert.equal(s.store.job(id)?.reason,'wechat_server_ack_text_fallback');
    const member=s.bridge.memory.members(group.id)[0]!;assert.equal(s.bridge.memory.history(group.id,member.id).length,2);
  }finally{await s.bridge.close();s.store.close();}
});


test('pause while native voice is in flight prevents a new fallback text send',async()=>{
  const s=setup({generate:async()=>audio()});let finish!:(v:{state:'failed';reason:string})=>void;
  s.driver.sendVoice=()=>new Promise(r=>finish=r);
  try{await s.bridge.groups();s.bridge.receive(message());await s.bridge.repliesIdle();
    const tick=s.bridge.tick();while(!finish)await new Promise(r=>setImmediate(r));
    s.bridge.control(true);finish({state:'failed',reason:'wechat_voice_failed'});await tick;assert.deepEqual(s.sent,[]);
  }finally{await s.bridge.close();s.store.close();}
});

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){
  for(let i=0;i<200;i++){if(check())return;await turn();}
  assert.fail('expected reply state was not reached');
}

test('competing model completions send the second reply as text while the first voice is still generating',async()=>{
  let finishVoice!:(v:GeneratedVoice)=>void,finishBob!:()=>void,voiceCalls=0;
  const modes:string[]=[],fallbacks:string[]=[];
  const s=setup({generate:()=>{voiceCalls++;return new Promise(r=>finishVoice=r);}},true,async(m,_signal,options)=>{
    modes.push(options!.voice!);
    if(m.message_id==='bob')await new Promise<void>(r=>finishBob=r);
    return {content:m.message_id+'的回复',voice:true};
  });
  s.bridge.on('event',e=>{if(e.event==='voice.fallback')fallbacks.push(e.reason);});
  try{
    await s.bridge.groups();s.bridge.receive(message('alice','wxid_alice'));s.bridge.receive(message('bob','wxid_bob'));
    await until(()=>!!finishVoice&&!!finishBob);assert.deepEqual(modes,['prefer','prefer']);
    finishBob();await until(()=>s.store.db.prepare("SELECT state FROM reply_requests WHERE id='bob'").get()?.state==='generated');
    assert.equal(voiceCalls,1);assert.deepEqual(fallbacks,['synthesis_busy_text_preserved']);
    for(let i=0;i<5&&!s.sent.includes('bob的回复');i++)await s.bridge.tick();
    assert(s.sent.includes('bob的回复'));assert(!s.sent.includes('voice'));
    finishVoice(audio());await s.bridge.repliesIdle();await s.bridge.tick();
    assert.equal(s.sent.filter(t=>t==='voice').length,1);
  }finally{finishBob?.();finishVoice?.(audio());await s.bridge.close();s.store.close();}
});

test('messages received during synthesis remain text across groups and a same-member wait; later messages can use voice again',async()=>{
  let finishVoice!:(v:GeneratedVoice)=>void,voiceCalls=0;
  const modes:Record<string,string>={};
  const s=setup({generate:()=>++voiceCalls===1?new Promise(r=>finishVoice=r):Promise.resolve(audio())},true,async(m,_signal,options)=>{
    modes[m.message_id]=options!.voice!;
    // Even an incorrect model voice choice must not override the host's busy rule.
    return {content:m.message_id+'的回复',voice:true};
  });
  const other={...group,id:'456@chatroom',name:'另一个群'};
  s.driver.chats=async()=>[group,other];
  try{
    await s.bridge.groups();await s.bridge.groupPatch(other.id,{enabled:true});
    s.bridge.receive(message('first'));await until(()=>!!finishVoice);
    s.bridge.receive({...message('second'),chat_id:other.id,chat_name:other.name});
    assert.equal(s.bridge.replyQueue.waiting().find(r=>r.id==='second')?.voice_blocked,true);
    assert.equal(modes.second,undefined);
    finishVoice(audio());await s.bridge.repliesIdle();
    for(let i=0;i<8;i++){await s.bridge.tick();await turn();}
    await s.bridge.repliesIdle();await s.bridge.tick();
    assert.equal(modes.second,'text');assert.equal(voiceCalls,1);assert(s.sent.includes('second的回复'));
    s.bridge.receive(message('third'));await s.bridge.repliesIdle();await s.bridge.tick();
    assert.equal(modes.third,'prefer');assert.equal(voiceCalls,2);assert.equal(s.sent.filter(t=>t==='voice').length,2);
  }finally{finishVoice?.(audio());await s.bridge.close();s.store.close();}
});

test('a failed synthesis releases the voice slot for the next message',async()=>{
  let calls=0;const s=setup({generate:async()=>{if(++calls===1)throw Error('failed');return audio();}});
  try{
    await s.bridge.groups();s.bridge.receive(message('first'));await s.bridge.repliesIdle();await s.bridge.tick();
    s.bridge.receive(message('next'));await s.bridge.repliesIdle();await s.bridge.tick();
    assert.equal(calls,2);assert.deepEqual(s.sent,['你好呀，喵。','voice']);
  }finally{await s.bridge.close();s.store.close();}
});
