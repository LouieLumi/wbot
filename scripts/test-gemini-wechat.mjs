// Deliver the one browser-generated smoke-test image to the user's designated test group.
// A durable reservation prevents accidental repeat runs, including uncertain outcomes.
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {readConfig} from '../dist/apps/server/src/config.js';
import {AndroidHookDriver} from '../dist/apps/server/src/android-hook.js';
const config=readConfig(process.env);
const api=async path=>{
  const r=await fetch('http://127.0.0.1:'+config.BRIDGE_PORT+path,{headers:{Authorization:'Bearer '+config.BRIDGE_API_TOKEN}});
  if(!r.ok)throw Error('bridge_unavailable');return r.json();
};
const health=await api('/api/health'),state=await api('/api/admin/state');
if(health.paused||!health.auto_reply||health.image?.provider!=='gemini_web'||!health.image.connected)throw Error('bridge_not_ready');
const target=process.env.WBOT_TEST_CHAT_ID;
if(!target)throw Error('Set WBOT_TEST_CHAT_ID to an explicitly authorized test group');
const group=state.groups.find(g=>g.id===target);
if(!group?.verified||!group.enabled||group.paused)throw Error('test_group_not_authorized');
const test=JSON.parse(await readFile('.runtime/gemini-membership/extension-test.json','utf8'));
if(!test.ok)throw Error('browser_test_not_passed');
const data=await readFile(test.file),id=randomUUID();
const path='.runtime/gemini-membership/wechat-image-test.json';
const record={id,chat_id:group.id,sha256:createHash('sha256').update(data).digest('hex'),state:'reserved'};
await writeFile(path,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});
const driver=new AndroidHookDriver(config,async()=>{});
try{
  const result=await driver.sendImage(group,{mime_type:test.mime_type,data},id);
  await writeFile(path,JSON.stringify({...record,...result},null,2));
  console.log(JSON.stringify({chat_name:group.name,...result}));
  if(result.state!=='sent')process.exitCode=1;
}catch{
  await writeFile(path,JSON.stringify({...record,state:'uncertain',reason:'transport_error'},null,2));
  throw Error('send_unconfirmed_do_not_retry');
}
