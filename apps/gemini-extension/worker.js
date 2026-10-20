import {endpoint,token} from './connection.js';
const protocol=4,version='1.3.2';
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
  // Chrome can restore a worker under a new tab ID after a restart.
  const restored=(await chrome.tabs.query({url:'https://gemini.google.com/*'})).find(t=>/^https:\/\/gemini\.google\.com\/app(?:\/[A-Za-z0-9_-]+)?#nila-image-worker(?:-[a-f0-9-]+)?$/i.test(t.url||''));
  const t=restored||await chrome.tabs.create({url:'https://gemini.google.com/app#nila-image-worker',pinned:true,active:false});
  await chrome.tabs.update(t.id,{autoDiscardable:false});
  await chrome.storage.local.set({tabId:t.id});return t.id;
}
async function heartbeat(ready,active){
  const state=await api('/heartbeat',{ready,protocol,version,...(active?{task_id:active.id,phase:active.phase}:{})});
  if(state.reload_extension&&!active)chrome.runtime.reload();
  return state;
}
async function cancelActive(tabId,active){
  if(active.operation!=='delete'&&active.phase==='generating'){
    const captured=await chrome.tabs.sendMessage(tabId,{kind:'capture-conversation',id:active.id}).catch(()=>null);
    const url=conversation(captured?.url),previous=conversation(active.page_url?.split('#')[0]);
    const actual=await chrome.tabs.get(tabId).catch(()=>null);
    if(url&&captured.document_id===active.document_id&&(!previous||previous===url)&&actual?.url?.split('#')[0]===url){
      const {conversations={}}=await chrome.storage.local.get('conversations');
      if(!conversations[active.session_id]||conversations[active.session_id]===url){conversations[active.session_id]=url;await chrome.storage.local.set({conversations});}
    }
  }
  await chrome.tabs.sendMessage(tabId,{kind:'cancel',id:active.id}).catch(()=>{});
  await chrome.storage.local.remove('active');
}
async function failActive(active,error){
  try{await api('/result',{id:active.id,ok:false,error});}catch(e){if(e.status!==409)throw e;}
  await chrome.storage.local.remove('active');
}
async function navigationSettled(tabId,url){
  // tabs.update resolves when navigation starts, before Tab.url necessarily changes.
  // Reloading then can cancel the pending hash change and reload the old worker URL.
  const expires=Date.now()+10_000;
  while(Date.now()<expires){
    const tab=await chrome.tabs.get(tabId);
    if(tab.url===url&&tab.status==='complete'&&!tab.pendingUrl)return;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('navigation_not_committed');
}
async function loadTask(tabId,active,status){
  const previous=await chrome.tabs.get(tabId);
  const loading={...active,tabId,phase:'loading',previous_document_id:status?.document_id,
    load_attempts:(active.load_attempts||0)+1,last_navigation:Date.now()};
  await chrome.storage.local.set({active:loading});
  let stage='update';
  try{
    await chrome.tabs.update(tabId,{url:active.page_url});
    // A hash change does not reset a draft or create a new page script.
    if(previous.url?.split('#')[0]===active.page_url.split('#')[0]){
      await navigationSettled(tabId,active.page_url);
      stage='reload';await chrome.tabs.reload(tabId);
    }
  }catch(error){
    const message=String(error?.message||'navigation_failed').replace(/https?:\/\/\S+/g,'[url]').slice(0,240);
    await api('/navigation-failure',{stage,message}).catch(()=>{});throw error;
  }
}
async function nextOperation(tabId,task,status){
  const {conversations={}}=await chrome.storage.local.get('conversations');
  const retired=[...new Set(task.retired_sessions||[])].filter(id=>id!==task.session_id&&/^[a-f0-9-]{36}$/i.test(id));
  const old=retired.find(id=>conversation(conversations[id]));
  if(old){
    const url=conversation(conversations[old]);
    // Never delete a conversation also bound to another owner's active session.
    if(Object.entries(conversations).some(([id,value])=>conversation(value)===url&&!retired.includes(id))){
      await failActive(task,'conversation_conflict');return;
    }
    await loadTask(tabId,{...task,operation:'delete',requested_operation:task.requested_operation||task.operation||'generate',
      deleting_session:old,page_url:url+'#nila-image-worker-'+task.id},status);return;
  }
  if((task.requested_operation||task.operation)==='cleanup'){
    await api('/result',{id:task.id,ok:true,reset_complete:true});await chrome.storage.local.remove('active');return;
  }
  const saved=conversation(conversations[task.session_id]);
  await loadTask(tabId,{...task,operation:task.requested_operation||task.operation||'generate',
    deleting_session:undefined,page_url:(saved||'https://gemini.google.com/app')+'#nila-image-worker-'+task.id},status);
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
      await failActive(active,'browser_restarted');
    }
    const {repairs=[]}=await chrome.storage.local.get('repairs');
    const recent=repairs.filter(at=>Date.now()-at<10*60_000);
    if(recent.length>=3||Date.now()-(recent.at(-1)||0)<60_000)return;
    await chrome.storage.local.set({repairs:[...recent,Date.now()]});
    await chrome.tabs.reload(tabId);return;
  }
  if(active){
    const state=await heartbeat(status.ready===true,active);
    if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return;}
    if(active.phase==='loading'){
      const tab=await chrome.tabs.get(tabId);
      const intended=tab.url===active.page_url||tab.url===active.page_url.split('#')[0];
      if(tab.status==='complete'&&(active.tabId!==tabId||!intended||status.document_id===active.previous_document_id)&&Date.now()-(active.last_navigation||0)>=5000){
        if((active.load_attempts||0)>=3)await failActive(active,'page_changed');
        else await loadTask(tabId,active,status);
      }
    }else if(active.tabId!==tabId||active.document_id&&status.document_id!==active.document_id){
      // Once dispatch starts, replay might duplicate a submitted prompt.
      await failActive(active,'browser_restarted');
    }
    return;
  }
  if(status.busy)return;
  const {task}=await api('/claim',{ready:status.ready===true,protocol,version});
  if(!task)return;
  if(!/^[a-f0-9-]{36}$/i.test(task.session_id||'')){
    await api('/result',{id:task.id,ok:false,error:'page_changed'});return;
  }
  if(task.conversation_title&&(!/^[^\u0000-\u001f]{1,160}$/.test(task.conversation_title)||!Array.isArray(task.retired_sessions)||task.retired_sessions.length>256)){
    await api('/result',{id:task.id,ok:false,error:'page_changed'});return;
  }
  await nextOperation(tabId,task,status);
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
      if(state.reload_extension)return {updating:true};
      if(active){
        if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
        if(active.tabId===tabId&&(active.phase==='loading'||active.phase==='dispatching'&&message.document_id===active.document_id)&&message.ready===true&&!message.busy&&message.protocol===protocol&&message.document_id&&message.document_id!==active.previous_document_id&&(message.pageUrl===active.page_url||message.pageUrl===active.page_url.split('#')[0])){
          await chrome.storage.local.set({active:{...active,phase:'dispatching',document_id:message.document_id}});return {task:active};
        }
        if(active.phase==='loading')void tick();
        return {busy:true};
      }
      void tick();return {ok:true};
    }
    if(message.kind==='started'&&active?.id===message.id&&active.document_id===message.document_id){
      const state=await heartbeat(true,active);
      if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
      await chrome.storage.local.set({active:{...active,phase:'generating'}});return {ok:true};
    }
    if(message.kind==='conversation'&&active?.id===message.id&&active.document_id===message.document_id&&active.operation!=='delete'){
      const url=conversation(message.pageUrl?.split('#')[0]),actual=await chrome.tabs.get(tabId);
      const previous=conversation(active.page_url?.split('#')[0]);
      if(!url||previous&&previous!==url)return {ignored:true};
      // pushState updates location before Chrome's tab metadata catches up.
      if(actual.url?.split('#')[0]!==url)return !previous&&actual.url?.split('#')[0]==='https://gemini.google.com/app'?{pending:true}:{ignored:true};
      const {conversations={}}=await chrome.storage.local.get('conversations');
      if(conversations[active.session_id]&&conversations[active.session_id]!==url)return {ignored:true};
      conversations[active.session_id]=url;await chrome.storage.local.set({conversations});return {ok:true};
    }
    if(message.kind==='result'&&active?.id===message.result?.id&&active.document_id===message.document_id){
      if(active.operation==='delete'&&message.result.ok&&message.result.deleted===true){
        const {conversations={}}=await chrome.storage.local.get('conversations');
        const deleted=conversation(active.page_url.split('#')[0]),actual=await chrome.tabs.get(tabId);
        if(!deleted||actual.url?.split('#')[0]===deleted)return {error:'deletion_not_confirmed'};
        for(const id of active.retired_sessions||[])if(conversations[id]===deleted)delete conversations[id];
        await chrome.storage.local.set({conversations});
        await nextOperation(tabId,active,{document_id:message.document_id});return {ok:true};
      }
      const url=conversation(message.pageUrl?.split('#')[0]);
      const previous=conversation(active.page_url?.split('#')[0]);
      const actual=await chrome.tabs.get(tabId);
      const {conversations:bindings={}}=await chrome.storage.local.get('conversations');
      const bound=conversation(bindings[active.session_id]);
      const wrong=url&&(previous&&url!==previous||bound&&url!==bound||actual.url?.split('#')[0]!==url);
      const result=wrong?{id:active.id,ok:false,error:'page_changed'}:message.result;
      const steps=['start','delete','submit','bind','response','download','rename'];
      if(!result.ok&&steps.includes(message.step))await api('/failure-step',{step:message.step}).catch(()=>{});
      // Save the user's conversation before releasing the task. A transient bridge
      // failure must not dispatch another user's prompt over a result awaiting ACK.
      if(!wrong&&url&&active.operation!=='delete'&&(result.ok||result.error==='text_response'||message.submitted===true)){
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
