import {endpoint,token} from './connection.js';
const protocol=3,version='1.2.1';
let operations=Promise.resolve();
const serial=run=>{const result=operations.then(run);operations=result.catch(()=>{});return result;};
const api=async(path,body)=>{
  const response=await fetch(endpoint+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw Object.assign(new Error('bridge_unavailable'),{status:response.status});return response.json();
};
const conversation=url=>typeof url==='string'&&/^https:\/\/gemini\.google\.com\/app\/[A-Za-z0-9_-]+$/.test(url)?url:null;
async function ensureTab(){
  const {tabId}=await chrome.storage.local.get('tabId');
  if(tabId){try{const t=await chrome.tabs.get(tabId);if(t.url?.startsWith('https://gemini.google.com/'))return tabId;}catch{}}
  const t=await chrome.tabs.create({url:'https://gemini.google.com/app#nila-image-worker',pinned:true,active:false});
  await chrome.tabs.update(t.id,{autoDiscardable:false});
  await chrome.storage.local.set({tabId:t.id});return t.id;
}
async function heartbeat(ready,active){return api('/heartbeat',{ready,protocol,version,...(active?{task_id:active.id,phase:active.phase}:{})});}
async function cancelActive(tabId,active){
  await chrome.tabs.sendMessage(tabId,{kind:'cancel',id:active.id}).catch(()=>{});
  await chrome.storage.local.remove('active');
}
async function runTick(){
  const tabId=await ensureTab();
  const status=await chrome.tabs.sendMessage(tabId,{kind:'status'}).catch(()=>null);
  const {active}=await chrome.storage.local.get('active');
  if(!status||status.protocol!==protocol){
    // Reload only the dedicated tab when an extension update invalidates its script.
    await heartbeat(false).catch(()=>{});
    const tab=await chrome.tabs.get(tabId);if(tab.status!=='complete')return;
    if(active?.phase==='generating'||active?.phase==='dispatching'){
      await api('/result',{id:active.id,ok:false,error:'browser_restarted'}).catch(()=>{});
      await chrome.storage.local.remove('active');
    }
    const {repairs=[]}=await chrome.storage.local.get('repairs');
    const recent=repairs.filter(at=>Date.now()-at<10*60_000);
    if(recent.length>=3||Date.now()-(recent.at(-1)||0)<60_000)return;
    await chrome.storage.local.set({repairs:[...recent,Date.now()]});
    await chrome.tabs.reload(tabId);return;
  }
  if(active){
    const state=await heartbeat(status.ready===true,active);
    if(state.task_active===false||Date.now()>active.expires)await cancelActive(tabId,active);
    return;
  }
  if(status.busy)return;
  const {task}=await api('/claim',{ready:status.ready===true,protocol,version});
  if(!task)return;
  if(!/^[a-f0-9-]{36}$/i.test(task.session_id||'')){
    await api('/result',{id:task.id,ok:false,error:'page_changed'});return;
  }
  const {conversations={}}=await chrome.storage.local.get('conversations');
  const saved=conversation(conversations[task.session_id]);
  const page_url=(saved||'https://gemini.google.com/app')+'#nila-image-worker-'+task.id;
  const previous=await chrome.tabs.get(tabId);
  await chrome.storage.local.set({active:{...task,tabId,phase:'loading',page_url,previous_document_id:status.document_id}});
  await chrome.tabs.update(tabId,{url:page_url});
  // Hash-only navigation leaves the old editor/draft and content script alive.
  // Require a new document even when two consecutive requests share a conversation.
  if(previous.url?.split('#')[0]===page_url.split('#')[0])await chrome.tabs.reload(tabId);
}
function tick(){return serial(runTick).catch(()=>{});}
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('worker',{periodInMinutes:0.5});void tick();});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('worker',{periodInMinutes:0.5});void tick();});
chrome.alarms.onAlarm.addListener(()=>void tick());
chrome.action.onClicked.addListener(()=>{void serial(async()=>{const id=await ensureTab();await chrome.tabs.update(id,{active:true});}).then(tick);});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  serial(async()=>{
    const {tabId,active}=await chrome.storage.local.get(['tabId','active']);
    if(sender.tab?.id!==tabId||!sender.url?.startsWith('https://gemini.google.com/'))return {ignored:true};
    if(message.kind==='ready'){
      const state=await heartbeat(message.ready===true&&message.protocol===protocol,active);
      if(active){
        if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
        if((active.phase==='loading'||active.phase==='dispatching'&&message.document_id===active.document_id)&&message.ready===true&&!message.busy&&message.protocol===protocol&&message.document_id&&message.document_id!==active.previous_document_id&&(message.pageUrl===active.page_url||message.pageUrl===active.page_url.split('#')[0])){
          await chrome.storage.local.set({active:{...active,phase:'dispatching',document_id:message.document_id}});return {task:active};
        }
        return {busy:true};
      }
      void tick();return {ok:true};
    }
    if(message.kind==='started'&&active?.id===message.id&&active.document_id===message.document_id){
      const state=await heartbeat(true,active);
      if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
      await chrome.storage.local.set({active:{...active,phase:'generating'}});return {ok:true};
    }
    if(message.kind==='result'&&active?.id===message.result?.id&&active.document_id===message.document_id){
      const url=conversation(message.pageUrl?.split('#')[0]);
      const previous=conversation(active.page_url?.split('#')[0]);
      const actual=await chrome.tabs.get(tabId);
      const wrong=url&&(previous&&url!==previous||actual.url?.split('#')[0]!==url);
      const result=wrong?{id:active.id,ok:false,error:'page_changed'}:message.result;
      // Save the user's conversation before releasing the task. A transient bridge
      // failure must not dispatch another user's prompt over a result awaiting ACK.
      if(!wrong&&url&&(result.ok||result.error==='text_response')){
        const {conversations={}}=await chrome.storage.local.get('conversations');
        conversations[active.session_id]=url;await chrome.storage.local.set({conversations});
      }
      try{await api('/result',result);}catch(error){if(error.status!==409)throw error;}
      await chrome.storage.local.remove('active');
      void tick();return {ok:true};
    }
    return {ignored:true};
  }).then(respond).catch(()=>respond({error:'bridge_unavailable'}));return true;
});
