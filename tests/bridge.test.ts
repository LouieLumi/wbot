import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { readConfig } from '../apps/server/src/config.js';
import { Store } from '../apps/server/src/store.js';
import { MockDriver } from '../apps/server/src/adapters.js';
import { Bridge, WindowTracker } from '../apps/server/src/bridge.js';
import { createApi } from '../apps/server/src/api.js';
import { OpenClaw } from '../apps/server/src/openclaw.js';
import type { Message, Row } from '../packages/shared/types.js';

const token='test-token-'.repeat(5);
const config=()=>readConfig({BRIDGE_API_TOKEN:token,WECHAT_DEVICE_MODE:'mock',WECHAT_ALLOWED_CHAT_IDS:'["mock-group","mock-group-2"]',WECHAT_AUTO_REPLY:'true'});
const message=(id='m1',chat='mock-group'):Message=>({event:'message.received',message_id:id,chat_id:chat,chat_name:'测试群',chat_type:'group',sender:'用户',content:'@AI助手 测试',own:false,mention:'verified',timestamp:Date.now()});
function setup() {
  const c=config(),store=new Store(':memory:'),driver=new MockDriver();const calls:Message[]=[];
  const bridge=new Bridge(c,driver,store,{async reply(m){calls.push(m);return '收到 '+m.chat_id;}});
  bridge.control(false,true);return {c,store,driver,bridge,calls};
}

test('API authentication, allowlist, idempotency, queue and observable confirmation',async()=>{
  const s=setup(),app=await createApi(s.c,s.bridge);const headers={authorization:'Bearer '+token};
  try {
    assert.equal((await app.inject({url:'/api/health'})).statusCode,401);
    assert.equal((await app.inject({url:'/api/health',headers})).statusCode,200);
    assert.equal((await app.inject({url:'/api/health',headers:{...headers,origin:'https://example.com'}})).statusCode,403);
    const post=(chat_id:string,content='你好')=>app.inject({method:'POST',url:'/api/messages/send',headers:{...headers,'idempotency-key':'abc'},payload:{chat_id,content}});
    assert.equal((await post('unapproved')).statusCode,403);
    const a=await post('mock-group');assert.equal(a.statusCode,202);assert.equal(a.json().state,'queued');
    assert.equal((await post('mock-group')).json().id,a.json().id);
    assert.equal((await post('mock-group','different')).statusCode,409);
    await s.bridge.tick();assert.equal(s.store.job(a.json().id)?.state,'sent');assert.equal(s.driver.sent.length,1);
    assert.equal((await app.inject({url:'/api/jobs/'+a.json().id,headers})).json().state,'sent');
    assert.equal((await app.inject({method:'POST',url:'/api/messages/image',headers})).statusCode,501);
  }finally{await app.close();s.store.close();}
});
test('ambiguous names rejected; independent chat IDs remain usable',async()=>{
  const s=setup();s.driver.known[1]!.name='测试群';const app=await createApi(s.c,s.bridge);
  try {assert.equal((await app.inject({method:'POST',url:'/api/messages/send',headers:{authorization:'Bearer '+token},payload:{chat_name:'测试群',chat_type:'group',content:'hi'}})).statusCode,409);}
  finally{await app.close();s.store.close();}
});
test('Gemini rename accepts both mentions, strips the current name and rejects partial names',async()=>{
  const s=setup();s.c.WECHAT_BOT_NAME='Gemini';s.c.WECHAT_REPLY_MODE='text_mention';
  try{
    await s.bridge.groups();s.bridge.control(false,true);
    for(const [id,content] of [['rename-new','@Gemini\u2005你好'],['rename-old','@Nila 还在吗'],['rename-partial','@GeminiOther 不应回复'],['rename-email','user@Gemini 不应回复'],['rename-normal','Gemini 是名字']]){
      s.bridge.receive({...message(id),content:content!,mention:'text'});await s.bridge.repliesIdle();await s.bridge.tick();
    }
    assert.deepEqual(s.calls.map(m=>m.content),['你好','还在吗']);
    s.bridge.receive({...message('rename-command'),content:'@Gemini\u2005/help',mention:'text'});await s.bridge.repliesIdle();
    const jobs=s.store.db.prepare('SELECT content FROM jobs').all();
    assert(jobs.some(job=>String(job.content).startsWith('Gemini · 功能菜单\n')));
    assert.equal(s.calls.length,2);
  }finally{await s.bridge.close();s.store.close();}
});
test('new visible messages only, no historical replay, duplicates, own and untrusted mentions ignored',async()=>{
  const s=setup();s.driver.inject('old');await s.bridge.tick();assert.equal(s.calls.length,0);
  s.driver.inject('@AI助手 新消息');await s.bridge.tick();await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);
  s.bridge.receive(s.calls[0]!);await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);
  for(const m of [{...message('own','mock-group-2'),own:true},{...message('unknown','mock-group-2'),own:null},{...message('mention','mock-group-2'),mention:'unknown' as const},{...message('outside','unknown')}])s.bridge.receive(m);
  await s.bridge.repliesIdle();assert.equal(s.calls.length,1);await s.bridge.close();s.store.close();
});
test('pause blocks queued sends and in-flight AI reply enqueue',async()=>{
  const s=setup();s.bridge.control(true);const job=await s.bridge.enqueue('mock-group','hi');await s.bridge.tick();assert.equal(s.store.job(job.id)?.state,'queued');
  let release!:(v:string)=>void;const b=new Bridge(s.c,s.driver,s.store,{reply:()=>new Promise(r=>release=r)});b.control(false,true);b.receive(message());
  await new Promise(r=>setImmediate(r));b.control(true);release('must not send');await b.repliesIdle();
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n,1);await b.close();await s.bridge.close();s.store.close();
});
test('running jobs become uncertain across restart and never auto retry',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wechat-test-'));const path=join(dir,'test.sqlite');
  try {let store=new Store(path);const job=store.enqueue('mock-group','hi');store.update(job.id,'running');store.close();store=new Store(path);assert.equal(store.job(job.id)?.state,'uncertain');assert.equal(store.next(),undefined);store.close();}finally{rmSync(dir,{recursive:true});}
});
test('transport errors do not cause automatic resends',async()=>{
  const s=setup();let attempts=0;s.driver.send=async()=>{attempts++;throw new Error('lost reply after tap');};
  const job=await s.bridge.enqueue('mock-group','hello');await s.bridge.tick();await s.bridge.tick();assert.equal(attempts,1);assert.equal(s.store.job(job.id)?.state,'uncertain');await s.bridge.close();s.store.close();
});
test('sliding window overlap handles repeated messages and resets on unknown gaps',()=>{
  const t=new WindowTracker(),chat=new MockDriver().active;
  const r=(key:string):Row=>({key,content:key,own:false,sender:null,mention:'unknown'});
  const snap=(keys:string[])=>({chat,rows:keys.map(r),reliability:'test'});
  assert.equal(t.advance(snap(['a','b'])).rows.length,0);
  assert.deepEqual(t.advance(snap(['b','b'])).rows.map(x=>x.key),['b']);
  assert.equal(t.advance(snap(['c'])).gap,true);assert.equal(t.advance(snap(['c'])).rows.length,0);
  assert.equal(t.advance(snap([])).gap,true);
  assert.equal(t.advance(snap(['c'])).rows.length,0); // A transient empty tree must not replay history.
});
test('voice/emoji disappearance and outgoing OCR changes do not consume a new mention',async()=>{
  const s=setup();s.c.WECHAT_BOT_NAME='Nila';s.c.WECHAT_REPLY_MODE='text_mention';s.driver.known.splice(1);
  const row=(key:string,content:string,own=false):Row=>({key,content,own,sender:own?null:'成员',mention:'unknown'});
  const old=row('old','@Nila 会计是做什么的');
  s.driver.rows.push(old,row('own-before','会计负责记录、核算',true),row('voice','2秒语音'),row('emoji','机器人表情'));
  await s.bridge.tick();assert.equal(s.calls.length,0);
  s.driver.rows.splice(0,s.driver.rows.length,old,row('own-after','会计负责记录核算',true),row('new','@Nila 还活着吗'));
  await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);assert.equal(s.calls[0]?.content,'还活着吗');
  await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);await s.bridge.close();s.store.close();
});
test('a transient read failure preserves progress; ordinary message events still work',async()=>{
  const s=setup();s.c.WECHAT_BOT_NAME='Nila';s.c.WECHAT_REPLY_MODE='text_mention';s.driver.known.splice(1);
  const events:Record<string,unknown>[]=[];s.bridge.on('event',e=>events.push(e));
  s.driver.inject('@Nila 旧问题',false,'unknown');await s.bridge.tick();
  const snapshot=s.driver.snapshot.bind(s.driver);s.driver.snapshot=async()=>{throw Error('temporary transport failure');};await s.bridge.tick();
  s.driver.snapshot=snapshot;s.driver.inject('普通聊天',false,'unknown');s.driver.inject('@Nila 新问题',false,'unknown');
  await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);assert.equal(s.calls[0]?.content,'新问题');
  assert(events.some(e=>e.event==='message.received'&&e.content==='普通聊天'));
  s.bridge.control(true);s.driver.inject('@Nila 暂停期间的旧消息',false,'unknown');s.bridge.control(false);await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);
  await s.bridge.close();s.store.close();
});
test('outgoing bubble anchors a new mention when the old trigger leaves the OCR window',async()=>{
  const s=setup();s.c.WECHAT_BOT_NAME='Nila';s.c.WECHAT_REPLY_MODE='text_mention';s.driver.known.splice(1);
  s.driver.inject('@Nila 旧问题',false,'unknown');s.driver.inject('上一条回答',true,'unknown');
  await s.bridge.tick();assert.equal(s.calls.length,0);
  s.driver.rows.shift();s.driver.inject('@Nila 请只回复OK',false,'unknown');
  await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);assert.equal(s.calls[0]?.content,'请只回复OK');
  const diagnostic=JSON.parse(s.store.get('poll_diagnostic:mock-group')!);
  assert.equal(diagnostic.trigger_gap,true);assert.equal(diagnostic.event_gap,false);assert.equal(diagnostic.new_triggers,1);
  await s.bridge.tick();await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,1);
  await s.bridge.close();s.store.close();
});
test('both windows losing overlap never replays an unrelated historical mention',async()=>{
  const s=setup();s.c.WECHAT_BOT_NAME='Nila';s.c.WECHAT_REPLY_MODE='text_mention';s.driver.known.splice(1);
  s.driver.inject('@Nila 旧问题',false,'unknown');s.driver.inject('旧回答',true,'unknown');await s.bridge.tick();
  s.driver.rows.splice(0);s.driver.inject('@Nila 另一页旧问题',false,'unknown');
  await s.bridge.tick();await s.bridge.tick();await s.bridge.repliesIdle();assert.equal(s.calls.length,0);
  assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM jobs').get()?.n,0);
  await s.bridge.close();s.store.close();
});
test('long outages establish a new baseline instead of replying to historical prompts',()=>{
  const t=new WindowTracker(),chat=new MockDriver().active;
  const snap=(keys:string[])=>({chat,rows:keys.map(key=>({key,content:key,own:false,sender:'成员',mention:'unknown' as const})),reliability:'test'});
  t.advance(snap(['a']),1000);assert.deepEqual(t.advance(snap(['a','b']),61_000).rows.map(r=>r.key),['b']);
  assert.equal(t.advance(snap(['a','b','c']),242_000).rows.length,0);
});
test('OpenClaw separates sessions per chat, validates response and blocks unverified setup',async()=>{
  const requests:Record<string,unknown>[]=[];const server=createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push(JSON.parse(body));assert.equal(req.url,'/v1/chat/completions');res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'answer'}}]}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {const c=config();c.OPENCLAW_BASE_URL='http://127.0.0.1:'+(server.address() as {port:number}).port;const client=new OpenClaw(c);
    await assert.rejects(client.reply(message()),/openclaw_not_ready/);c.OPENCLAW_ENDPOINT_VERIFIED=true;c.OPENCLAW_AGENT_RESTRICTED=true;c.OPENCLAW_TOKEN='test';
    await client.reply(message());await client.reply(message('m2','mock-group-2'));await client.reply(message('m3'));
    assert.notEqual(requests[0]!.user,requests[1]!.user);assert.equal(requests[0]!.user,requests[2]!.user);
  }finally{server.close();await once(server,'close');}
});
test('authenticated websocket receives job updates',async()=>{
  const s=setup(),app=await createApi(s.c,s.bridge);await app.listen({host:'127.0.0.1',port:0});
  const port=(app.server.address() as {port:number}).port;const ws=new WebSocket('ws://127.0.0.1:'+port+'/api/events',{headers:{authorization:'Bearer '+token}});const events:Record<string,unknown>[]=[];ws.on('message',data=>events.push(JSON.parse(String(data))));
  try {await once(ws,'open');await s.bridge.enqueue('mock-group','hi');await s.bridge.tick();await new Promise(r=>setTimeout(r,25));assert(events.some(e=>e.event==='job.updated'&&e.state==='sent'));}
  finally{ws.terminate();await app.close();s.store.close();}
});
