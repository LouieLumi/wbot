import {endpoint,token} from './connection.js';
const protocol=4,version='1.4.1';
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
  const state=await api('/heartbeat',{ready,protocol,version,...(active?{task_id:active.id,phase:active.phase,step:active.step||'loading',submitted:active.submitted===true}:{})});
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
async function loadTask(tabId,active,status){
  const previous=await chrome.tabs.get(tabId);
  const currentUrl=status?.pageUrl||previous.url;
  const target=active.page_url.split('#')[0];
  const sameDocumentPath=currentUrl?.split('#')[0]===target;
  const samePath=sameDocumentPath||previous.url?.split('#')[0]===target;
  // The fresh document ID, not the URL fragment, grants ownership. Chrome can
  // leave a fragment-only tabs.update pending indefinitely. For the same path,
  // retain its URL and reload directly; this also cannot cancel a pending hash.
  // A redirected SPA can report /app while Chrome retains the old conversation
  // URL. Updating that old URL only changes its fragment; force a real reload.
  const pageUrl=sameDocumentPath?currentUrl:active.page_url;
  const loading={...active,page_url:pageUrl,tabId,phase:'loading',step:'loading',redirect_since:undefined,previous_document_id:status?.document_id,
    load_attempts:(active.load_attempts||0)+1,last_navigation:Date.now()};
  await chrome.storage.local.set({active:loading});
  let stage='update';
  try{
    if(samePath){
      stage='reload';await chrome.tabs.reload(tabId,{bypassCache:(active.load_attempts||0)>0});
    }else await chrome.tabs.update(tabId,{url:pageUrl});
  }catch(error){
    const message=String(error?.message||'navigation_failed').replace(/https?:\/\/\S+/g,'[url]').slice(0,240);
    await api('/navigation-failure',{stage,message}).catch(()=>{});throw error;
  }
}
async function nextOperation(tabId,task,status){
  task={...task,load_attempts:0,history_reloads:0,missing_rechecked:undefined,redirect_since:undefined,recovery_from:undefined,submitted:false,document_id:undefined};
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
async function recoverUnavailableConversation(tabId,active,status){
  // A saved URL can be deleted/expire remotely. Recover only a proven empty
  // landing-page redirect before submission, once per task, retaining the old
  // binding until the replacement conversation is actually created.
  const saved=conversation(active.page_url?.split('#')[0]);
  const declined=async reason=>{await api('/navigation-failure',{stage:'update',message:'conversation_recovery_declined '+reason}).catch(()=>{});return false;};
  if(!saved||active.operation==='delete'||active.recovery_from||status.empty_landing!==true||Date.now()>=active.expires)return declined('ineligible_or_not_empty');
  // This is a response from the owned content script. Chrome's URL/status can
  // lag indefinitely behind an SPA redirect; use the actual document location.
  const actual=await chrome.tabs.get(tabId);
  if((status.pageUrl||actual.url)?.split('#')[0]!=='https://gemini.google.com/app'||status.has_draft||status.generating||status.busy)return declined('document_not_empty_landing');
  const {conversations={}}=await chrome.storage.local.get('conversations');
  if(conversations[active.session_id]!==saved)return declined('binding_changed');
  await loadTask(tabId,{...active,recovery_from:saved,load_attempts:0,page_url:'https://gemini.google.com/app#nila-image-worker-'+active.id},status);
  return true;
}
async function retireUnavailableConversation(tabId,active,status){
  const saved=conversation(active.page_url?.split('#')[0]);
  if(active.operation!=='delete'||!saved||status.empty_landing!==true||status.has_draft||status.generating||status.busy||
    status.authenticated!==true||status.pageUrl?.split('#')[0]!=='https://gemini.google.com/app'||status.document_id===active.previous_document_id)return false;
  // A transient landing page is not proof of deletion. Observe it for five
  // seconds, then visit the exact retired URL once more before retiring a stale
  // local binding. This never clicks Delete on a different conversation.
  if(!active.redirect_since){await chrome.storage.local.set({active:{...active,redirect_since:Date.now()}});return true;}
  if(Date.now()-active.redirect_since<5000)return true;
  if(!active.missing_rechecked){
    await loadTask(tabId,{...active,missing_rechecked:true,load_attempts:0},status);return true;
  }
  const {conversations={},cleanup_receipts={}}=await chrome.storage.local.get(['conversations','cleanup_receipts']);
  if(conversations[active.deleting_session]!==saved)return false;
  const retired=active.retired_sessions||[];
  if(Object.entries(conversations).some(([id,url])=>url===saved&&!retired.includes(id))){await failActive(active,'conversation_conflict');return true;}
  for(const id of retired)if(conversations[id]===saved){
    cleanup_receipts[id]={outcome:'unavailable',at:Date.now()};delete conversations[id];
  }
  const receipts=Object.fromEntries(Object.entries(cleanup_receipts).sort((a,b)=>b[1].at-a[1].at).slice(0,256));
  await chrome.storage.local.set({conversations,cleanup_receipts:receipts});
  await heartbeat(true,{...active,step:'cleanup_unavailable'});
  await nextOperation(tabId,{...active,missing_rechecked:undefined,redirect_since:undefined,load_attempts:0},status);return true;
}
async function reloadUnloadedConversation(tabId,active,message){
  const saved=conversation(active.page_url?.split('#')[0]);
  if(!saved||active.operation==='delete'||active.history_reloads||message.empty_conversation!==true||
    message.pageUrl?.split('#')[0]!==saved||active.expires-Date.now()<30_000)return false;
  const actual=await chrome.tabs.get(tabId);
  if(message.pageUrl?.split('#')[0]!==saved||actual.id!==tabId)return false;
  const {conversations={}}=await chrome.storage.local.get('conversations');
  if(conversations[active.session_id]!==saved)return false;
  // Keep the same owner, URL, prompt and task. loadTask reloads same-path
  // navigation; this is allowed only before any prompt has been submitted.
  await loadTask(tabId,{...active,history_reloads:1,load_attempts:0},{document_id:message.document_id});
  return true;
}
async function runTick(){
  const tabId=await ensureTab();
  const status=await chrome.tabs.sendMessage(tabId,{kind:'status'}).catch(()=>null);
  const {active}=await chrome.storage.local.get('active');
  if(!status||status.protocol!==protocol||status.page_version!==version){
    // Reload only the dedicated tab when an extension update invalidates its script.
    await heartbeat(false,active).catch(()=>{});
    const tab=await chrome.tabs.get(tabId);
    if(active?.phase==='loading'&&Date.now()-(active.last_navigation||0)>=45_000){
      await api('/navigation-failure',{stage:'reload',message:'page_script_not_ready attempts='+String(active.load_attempts||1)}).catch(()=>{});
      if((active.load_attempts||0)>=3||active.expires-Date.now()<60_000){
        await api('/failure-step',{step:'load'}).catch(()=>{});await failActive(active,'page_load_failed');
      }else await loadTask(tabId,active,status);
      return;
    }
    const {script_wait_since=Date.now()}=await chrome.storage.local.get('script_wait_since');
    if(tab.status!=='complete'&&Date.now()-script_wait_since<30_000){
      await chrome.storage.local.set({script_wait_since});return;
    }
    if(active?.phase==='generating'||active?.phase==='dispatching'){
      await failActive(active,'browser_restarted');
    }
    const {repairs=[],repair_version}=await chrome.storage.local.get(['repairs','repair_version']);
    const recent=repair_version===version?repairs.filter(at=>Date.now()-at<10*60_000):[];
    if(recent.length>=3||Date.now()-(recent.at(-1)||0)<60_000)return;
    if(status&&status.page_version!==version)await api('/navigation-failure',{stage:'reload',message:'content_script_version_mismatch expected='+version+' actual='+String(status.page_version||'missing').slice(0,32)}).catch(()=>{});
    await chrome.storage.local.set({repairs:[...recent,Date.now()],repair_version:version});
    await chrome.tabs.reload(tabId);return;
  }
  await chrome.storage.local.remove('script_wait_since');
  if(active){
    const state=await heartbeat(status.ready===true,active);
    if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return;}
    if(active.phase==='loading'){
      const tab=await chrome.tabs.get(tabId);
      const pageUrl=status.pageUrl||tab.url;
      const intended=pageUrl?.split('#')[0]===active.page_url.split('#')[0];
      if(await retireUnavailableConversation(tabId,active,status))return;
      // Navigation can finish while Gemini is still just its static shell. This
      // task has never been dispatched: retry the same owner/URL with a bounded
      // load budget, rather than waiting for the full image-generation deadline.
      if(intended&&status.document_id!==active.previous_document_id&&status.ready!==true&&Date.now()-(active.last_navigation||0)>=45_000){
        await api('/navigation-failure',{stage:'reload',message:'page_not_ready '+JSON.stringify({ready:false,empty_shell:status.empty_shell===true,attempts:active.load_attempts||1})}).catch(()=>{});
        if((active.load_attempts||0)>=3||active.expires-Date.now()<60_000||status.busy||status.generating||status.has_draft){
          await api('/failure-step',{step:'load'}).catch(()=>{});
          await failActive(active,'page_load_failed');
        }else await loadTask(tabId,active,status);
        return;
      }
      if((tab.status==='complete'||Date.now()-(active.last_navigation||0)>=45_000)&&(active.tabId!==tabId||!intended||status.document_id===active.previous_document_id)&&Date.now()-(active.last_navigation||0)>=5000){
        if(active.tabId===tabId&&status.empty_landing===true&&status.document_id!==active.previous_document_id&&await recoverUnavailableConversation(tabId,active,status))return;
        if((active.load_attempts||0)>=3){
          // Keep enough evidence to distinguish a redirect, a stale page script
          // and a tab replacement. Never log prompts, member IDs or chat URLs.
          const actualBase=pageUrl?.split('#')[0],expectedBase=active.page_url.split('#')[0];
          const destination=actualBase==='https://gemini.google.com/app'?'landing':conversation(actualBase)?'conversation':'other';
          await api('/navigation-failure',{stage:'update',message:'navigation_not_ready '+JSON.stringify({
            destination,path_matches:actualBase===expectedBase,hash_matches:tab.url===active.page_url,
            same_document:status.document_id===active.previous_document_id,tab_changed:active.tabId!==tabId,
            ready:status.ready===true,attempts:active.load_attempts,
          })}).catch(()=>{});
          await failActive(active,active.operation==='delete'?'conversation_delete_failed':'page_load_failed');
        }
        else await loadTask(tabId,active,status);
      }
    }else if(active.tabId!==tabId||active.document_id&&status.document_id!==active.document_id){
      // Once dispatch starts, replay might duplicate a submitted prompt.
      await failActive(active,'browser_restarted');
    }
    return;
  }
  if(status.busy)return;
  if(status.empty_shell===true){
    await heartbeat(false);
    const {shell_since=Date.now(),shell_repairs=[]}=await chrome.storage.local.get(['shell_since','shell_repairs']);
    const recent=shell_repairs.filter(at=>Date.now()-at<10*60_000);
    if(Date.now()-shell_since>=30_000&&recent.length<2){
      await chrome.storage.local.set({shell_since:Date.now(),shell_repairs:[...recent,Date.now()]});
      await api('/navigation-failure',{stage:'reload',message:'idle_page_shell_reload'}).catch(()=>{});
      await chrome.tabs.reload(tabId,{bypassCache:true});
    }else await chrome.storage.local.set({shell_since});
    return;
  }
  await chrome.storage.local.remove('shell_since');
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
let ticking;
function tick(){
  // Coalesce alarm/ready callbacks. A slow browser or local server must not grow
  // an unbounded backlog of obsolete ticks ahead of result acknowledgements.
  if(!ticking)ticking=serial(runTick).catch(()=>{}).finally(()=>{ticking=undefined;});
  return ticking;
}
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create('worker',{periodInMinutes:0.5});void tick();});
chrome.runtime.onStartup.addListener(()=>{chrome.alarms.create('worker',{periodInMinutes:0.5});void tick();});
chrome.alarms.onAlarm.addListener(()=>void tick());
chrome.action.onClicked.addListener(()=>{void serial(async()=>{const id=await ensureTab();await chrome.tabs.update(id,{active:true});}).then(tick);});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  serial(async()=>{
    const {tabId,active}=await chrome.storage.local.get(['tabId','active']);
    if(sender.tab?.id!==tabId||!sender.url?.startsWith('https://gemini.google.com/'))return {ignored:true};
    if(message.kind==='ready'){
      const state=await heartbeat(message.ready===true&&message.protocol===protocol&&message.page_version===version,active);
      if(state.reload_extension)return {updating:true};
      if(message.page_version!==version){void tick();return {updating:true};}
      if(active){
        if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
        if(active.tabId===tabId&&(active.phase==='loading'||active.phase==='dispatching'&&message.document_id===active.document_id)&&message.ready===true&&!message.busy&&message.protocol===protocol&&message.document_id&&message.document_id!==active.previous_document_id&&message.pageUrl?.split('#')[0]===active.page_url.split('#')[0]){
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
    if(message.kind==='step'&&active?.id===message.id&&active.document_id===message.document_id&&
      ['prepare','delete','submit','bind','response','download','rename','result'].includes(message.step)){
      const updated={...active,step:message.step,submitted:active.submitted===true||message.submitted===true};
      await chrome.storage.local.set({active:updated});await heartbeat(true,updated);return {ok:true};
    }
    if(message.kind==='conversation'&&active?.id===message.id&&active.document_id===message.document_id&&active.operation!=='delete'){
      const url=conversation(message.pageUrl?.split('#')[0]);
      const previous=conversation(active.page_url?.split('#')[0]);
      if(!url||previous&&previous!==url)return {ignored:true};
      // The bound document acknowledged this URL after submitting the exact
      // prompt. Do not discard it because Chrome still reports the prior route.
      const {conversations={}}=await chrome.storage.local.get('conversations');
      if(conversations[active.session_id]&&conversations[active.session_id]!==url&&conversations[active.session_id]!==active.recovery_from)return {ignored:true};
      conversations[active.session_id]=url;await chrome.storage.local.set({conversations});return {ok:true};
    }
    if(message.kind==='result'&&active?.id===message.result?.id&&active.document_id===message.document_id){
      if(message.result.error==='conversation_load_failed'&&['prepare','rename'].includes(message.step)&&message.submitted===false){
        const state=await heartbeat(true,active);
        if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
        if(await reloadUnloadedConversation(tabId,active,message))return {ok:true,recovered:true};
      }
      if(message.result.error==='conversation_unavailable'&&['prepare','rename'].includes(message.step)&&message.submitted===false&&message.pageUrl?.split('#')[0]==='https://gemini.google.com/app'){
        const state=await heartbeat(true,active);
        if(state.task_active===false||Date.now()>active.expires){await cancelActive(tabId,active);return {expired:true};}
        if(await recoverUnavailableConversation(tabId,active,message))return {ok:true,recovered:true};
      }
      if(active.operation==='delete'&&message.result.ok&&message.result.deleted===true){
        const {conversations={}}=await chrome.storage.local.get('conversations');
        const deleted=conversation(active.page_url.split('#')[0]);
        const clearedInPlace=message.result.cleared===true&&message.pageUrl?.split('#')[0]===deleted;
        if(!deleted||message.pageUrl?.split('#')[0]===deleted&&!clearedInPlace)return {error:'deletion_not_confirmed'};
        for(const id of active.retired_sessions||[])if(conversations[id]===deleted)delete conversations[id];
        await chrome.storage.local.set({conversations});
        await nextOperation(tabId,active,{document_id:message.document_id});return {ok:true};
      }
      const url=conversation(message.pageUrl?.split('#')[0]);
      const previous=conversation(active.page_url?.split('#')[0]);
      const {conversations:bindings={}}=await chrome.storage.local.get('conversations');
      const bound=conversation(bindings[active.session_id]);
      const wrong=url&&(previous&&url!==previous||bound&&url!==bound&&bound!==active.recovery_from);
      const result=wrong||['conversation_unavailable','conversation_load_failed'].includes(message.result.error)?{id:active.id,ok:false,error:'page_changed'}:message.result;
      const steps=['start','prepare','delete','submit','bind','response','download','rename','result'];
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
