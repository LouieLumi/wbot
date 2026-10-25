'use strict';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const views={overview:['总览','OVERVIEW'],groups:['群聊管理','GROUPS'],memory:['成员记忆','MEMORY'],models:['模型管理','MODELS'],jobs:['发送记录','DELIVERY'],commands:['命令管理','COMMANDS']};
const statusLabels={queued:'排队中',running:'发送中',sent:'已发送',failed:'失败',uncertain:'待确认'};
const errors={memory_limit:'记忆容量已满，请整理后保存',hermes_memory_write_rejected:'Hermes 未接受这次记忆修改，请调整内容',unauthorized:'登录已失效，请重新登录',ticket_expired:'登录链接已过期，请输入密码登录',invalid_password:'密码错误，请重新输入',group_archived:'该群已归档',pause_before_registration:'请先暂停机器人',device_busy:'手机正在处理任务，请稍后重试',operation_unavailable:'服务暂不可用，请检查手机或模型连接',model_not_installed:'模型当前不可用',invalid_request:'输入内容不符合要求',rate_limited:'操作频繁，请稍后重试',group_not_found:'群聊不存在',member_not_found:'成员不存在',job_not_found:'记录不存在'};
let state,models=[],modelsLoaded=false,currentView='overview',groupScope='current',selectedGroup='',selectedMember='',members=[],editingGroup='',editorDirty=false,globalDirty=false;
let refreshTask,noticeTimer,memberRequest=0,detailRequest=0,jobsRequest=0,jobPage=1,jobPages=1,groupSignature='',optionsSignature='',recentSignature='',modelSignature='';
let loggedIn=false,loginQueue=Promise.resolve(),pendingConfirm=null;
const allGroups=()=>[...(state?.groups??[]),...(state?.archived_groups??[])];
const groupName=id=>allGroups().find(g=>g.id===id)?.name||id||'—';
const archived=id=>state?.archived_groups?.some(g=>g.id===id);
const dt=ms=>ms?new Date(ms).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).replaceAll('/','-'):'—';
const shortTime=ms=>ms?new Date(ms).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const badge=(label,kind='')=>`<span class="badge ${kind}">${esc(label)}</span>`;
const jobBadge=job=>badge(statusLabels[job.state]||job.state,({queued:'neutral',running:'blue',failed:'error',uncertain:'warning'})[job.state]||'');
const emptyRow=(cols,label='暂无记录')=>`<tr><td colspan="${cols}"><div class="empty">${esc(label)}</div></td></tr>`;
const modelOptions=(value='',inherit=true)=>{
 const list=models.map(m=>m.name);if(value&&!list.includes(value))list.unshift(value);
 return (inherit?`<option value="">跟随默认</option>`:'')+list.map(name=>`<option value="${esc(name)}" ${name===value?'selected':''}>${esc(name)}</option>`).join('');
};
function notify(message,bad=false){clearTimeout(noticeTimer);$('#notice').textContent=message;$('#notice').className='toast'+(bad?' error':'');noticeTimer=setTimeout(()=>$('#notice').classList.add('hidden'),bad?7000:3500);}
function showLogin(message='请登录'){
 loggedIn=false;memberRequest++;detailRequest++;jobsRequest++;
 $$('dialog[open]').forEach(d=>d.close());$('#app').classList.add('hidden');$('#login').classList.remove('hidden');$('#login-error').textContent=message;
 $('#login-error').classList.toggle('error',message!=='请登录'&&message!=='已退出登录');
}
async function api(path,method='GET',body,headers={}){
 let response;try{response=await fetch(path,{method,headers:{'Content-Type':'application/json',...headers},credentials:'same-origin',body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});}catch{throw new Error('连接超时，请稍后重试');}
 const data=await response.json();
 if(!response.ok){const message=errors[data.error]||'操作失败，请稍后重试';if(data.error==='unauthorized')showLogin(message);throw new Error(message);}
 return data;
}
async function action(button,fn){if(button?.disabled)return;if(button)button.disabled=true;try{await fn();}catch(e){notify(e.message,true);}finally{if(button?.isConnected)button.disabled=false;}}
function confirmAction(title,text){
 return new Promise(resolve=>{pendingConfirm=resolve;$('#confirm-title').textContent=title;$('#confirm-text').textContent=text;$('#confirm-dialog').returnValue='cancel';$('#confirm-dialog').showModal();});
}
$('#confirm-dialog').addEventListener('close',()=>{pendingConfirm?.($('#confirm-dialog').returnValue==='confirm');pendingConfirm=null;});
$$('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
function canLeaveEditor(){return !editorDirty||confirm('放弃尚未保存的记忆设置？');}
function routeFromHash(){const value=location.hash.slice(1);return views[value]?value:'overview';}
async function view(name,{setHash=true,force=false}={}){
 if(!views[name])name='overview';
 if(!force&&currentView==='memory'&&name!=='memory'&&!canLeaveEditor())return;
 if(name!=='memory')editorDirty=false;
 currentView=name;if(setHash)history.replaceState(null,'','#'+name);
 $$('.view').forEach(el=>el.classList.toggle('hidden',el.id!==name));$$('.nav').forEach(el=>{const active=el.dataset.view===name;el.classList.toggle('active',active);if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
 $('#page-title').textContent=$('#breadcrumb-page').textContent=views[name][0];$('#page-kicker').textContent=views[name][1];
 if(!loggedIn)return;
 try{if(name==='memory'){await loadMembers();if(selectedMember&&!editorDirty)await loadMember();}if(name==='jobs')await loadJobs();if(name==='models')await loadModels();if(name==='groups')renderGroups();}catch(e){notify(e.message,true);}
}
$$('.nav').forEach(button=>button.onclick=()=>view(button.dataset.view));
$$('[data-open]').forEach(button=>button.onclick=()=>view(button.dataset.open));
window.addEventListener('beforeunload',event=>{if(editorDirty||globalDirty){event.preventDefault();event.returnValue='';}});

async function refresh(){
 if(refreshTask)return refreshTask;
 refreshTask=(async()=>{state=await api('/api/admin/state');loggedIn=true;$('#login').classList.add('hidden');$('#app').classList.remove('hidden');renderState();})();
 try{await refreshTask;}finally{refreshTask=null;}
}
function renderState(){
 const status=state.paused?'已暂停':state.last_error?'连接异常':'运行中';
 $('#status-pill').textContent=status;$('#status-pill').className='badge'+(state.paused?' neutral':state.last_error?' warning':'');$('#sidebar-status').textContent=status;$('#bot-name').textContent=state.bot_name;
 $('#pause').textContent=state.paused?'启动机器人':'暂停机器人';$('#pause').disabled=state.paused&&state.device_busy;$('#auto-reply').checked=state.auto_reply;
 $('#updated-at').textContent='更新于 '+shortTime(Date.now());$('#nav-group-count').textContent=state.groups.length;
 $('#connection-error').classList.toggle('hidden',!state.last_error);$('#connection-error').textContent=state.last_error?'手机连接异常':'';
 $('#stat-groups').textContent=state.stats.authorized;$('#stat-groups-total').textContent='共 '+state.stats.groups+' 个群聊';$('#stat-members').textContent=state.stats.members;$('#stat-sent').textContent=state.stats.sent_today;$('#stat-pending').textContent=state.stats.pending+' 条待发送';$('#stat-failed').textContent=state.stats.failed_today;
 $('#runtime-provider').textContent=({hermes:'Hermes · '+(state.model_source||'Ollama'),ollama:'Ollama',openclaw:'OpenClaw'})[state.ai_provider]||state.ai_provider;
 $('#runtime-model').textContent=state.default_model;$('#runtime-device').innerHTML=badge(state.last_error?'未连接':state.groups.some(g=>g.verified)?'已连接':'待连接',state.last_error?'warning':state.groups.some(g=>g.verified)?'':'neutral');
 $('#runtime-message').textContent=dt(Math.max(0,...state.groups.map(g=>g.last_message)));
 $('#group-summary').innerHTML=state.groups.length?state.groups.slice(0,5).map(g=>`<div class="summary-row"><span class="group-avatar">${esc(g.name[0])}</span><div><strong>${esc(g.name)}</strong><small>${g.member_count} 位成员</small></div>${badge(g.enabled?'已授权':g.signup_pending?'待授权':'未授权',g.enabled?'':g.signup_pending?'warning':'neutral')}</div>`).join(''):'<div class="empty">暂无群聊</div>';
 $('#current-count').textContent=state.groups.length;$('#archive-count').textContent=state.archived_groups.length;
 $('#add-group-open').classList.toggle('hidden',!state.can_register);$('#add-group-open').disabled=!state.paused||state.device_busy;
 const nextGroupSignature=JSON.stringify(allGroups().map(({id,name,enabled,paused,verified,model,member_count,last_message,signup_pending,requested_at})=>({id,name,enabled,paused,verified,model,member_count,last_message,signup_pending,requested_at})));
 if(groupSignature!==nextGroupSignature){groupSignature=nextGroupSignature;renderGroups();}
 const optionKey=JSON.stringify(allGroups().map(g=>[g.id,g.name]));
 if(optionKey!==optionsSignature){
  optionsSignature=optionKey;
  const opts=groups=>groups.map(g=>`<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  $('#memory-group').innerHTML='<option value="">全部成员</option><optgroup label="当前群聊">'+opts(state.groups)+'</optgroup>'+(state.archived_groups.length?'<optgroup label="历史归档">'+opts(state.archived_groups)+'</optgroup>':'');
  if(selectedGroup&&!allGroups().some(g=>g.id===selectedGroup)){selectedGroup='';selectedMember='';}
  $('#memory-group').value=selectedGroup;
  const jobGroup=$('#job-group').value;$('#job-group').innerHTML='<option value="">全部群聊</option>'+allGroups().map(g=>`<option value="${esc(g.id)}">${esc(g.name)}${archived(g.id)?' · 归档':''}</option>`).join('');$('#job-group').value=jobGroup;
 }
 const recentKey=JSON.stringify(state.jobs);if(recentSignature!==recentKey){recentSignature=recentKey;$('#recent-jobs').innerHTML=state.jobs.map(j=>`<tr><td>${esc(j.chat_name||groupName(j.chat_id))}</td><td>${jobBadge(j)}</td><td>${dt(j.created_at)}</td><td class="align-right"><button class="text-button" data-job="${esc(j.id)}">详情</button></td></tr>`).join('')||emptyRow(4);}
 if(!globalDirty){const modelKey=JSON.stringify([state.default_model,state.reasoning_effort,models]);if(modelSignature!==modelKey){modelSignature=modelKey;$('#global-model').innerHTML=modelOptions(state.default_model,false);$('#reasoning-effort').value=state.reasoning_effort||'auto';renderModels();}}
}
function renderGroups(){
 if(!state)return;
 const search=$('#group-search').value.trim().toLocaleLowerCase(),filter=$('#group-status').value;
 const source=groupScope==='current'?state.groups:state.archived_groups;
 const groups=source.filter(g=>g.name.toLocaleLowerCase().includes(search)&&(groupScope==='archived'||filter==='all'||(filter==='pending'?g.signup_pending:filter==='disabled'?!g.enabled&&!g.signup_pending:g.enabled)));
 $('#group-status').disabled=groupScope==='archived';$('#group-results').textContent=groups.length+' 个群聊';
 $('#group-rows').innerHTML=groups.map(g=>`<tr><td><div class="cell-name"><span class="group-avatar">${esc(g.name[0])}</span><div><strong>${esc(g.name)}</strong><small>${groupScope==='archived'?'历史归档':esc(g.id)}</small></div></div></td><td>${groupScope==='archived'?badge('已归档','neutral'):badge(g.enabled?'已授权':g.signup_pending?'待授权':'未授权',g.enabled?'':g.signup_pending?'warning':'neutral')}</td><td>${groupScope==='archived'?'—':badge(!g.verified?'离线':g.paused?'已停用':'运行中',!g.verified?'warning':g.paused?'neutral':'')}</td><td>${g.member_count}</td><td><span class="cell-model" title="${esc(g.model||state.default_model)}">${esc(g.model||'跟随默认')}</span></td><td>${dt(g.last_message||g.requested_at)}</td><td><div class="row-actions">${groupScope==='current'?`<button data-edit-group="${esc(g.id)}">设置</button>${g.enabled?`<button data-pause-group="${esc(g.id)}">${g.paused?'启用':'停用'}</button>`:''}<button class="${g.enabled?'destructive':''}" data-toggle-group="${esc(g.id)}">${g.enabled?'取消授权':'授权'}</button>`:''}<button data-group-memory="${esc(g.id)}">成员记忆</button>${groupScope==='current'?`<button data-group-history="${esc(g.id)}">群聊记录</button>`:''}</div></td></tr>`).join('')||emptyRow(7,search?'未找到匹配的群聊':groupScope==='current'?'暂无群聊':'暂无归档');
}
$$('[data-group-scope]').forEach(button=>button.onclick=()=>{groupScope=button.dataset.groupScope;$$('[data-group-scope]').forEach(b=>b.classList.toggle('active',b===button));renderGroups();});
$('#group-search').oninput=renderGroups;$('#group-status').onchange=renderGroups;
$('#group-rows').onclick=event=>{
 const button=event.target.closest('button');if(!button)return;
 action(button,async()=>{
  const id=button.dataset.editGroup||button.dataset.toggleGroup||button.dataset.pauseGroup||button.dataset.groupMemory||button.dataset.groupHistory,g=allGroups().find(g=>g.id===id);if(!g)return;
  if(button.dataset.groupHistory){
   const data=await api('/api/admin/groups/'+encodeURIComponent(id)+'/history');
   $('#group-history-title').textContent=g.name+' · 群聊记录';
   $('#group-history-status').textContent=(data.stats.message_count||0)+' 条 · '+(data.stats.error?'同步异常':data.stats.has_more?'同步中':'已同步')+' · '+dt(data.stats.last_sync);
   $('#group-history-rows').innerHTML=data.messages.map(m=>`<article class="group-record"><strong>${esc(m.sender)}</strong><time>${dt(m.created_at)}</time><p>${esc(m.content)}${m.truncated?'…（部分内容）':''}</p></article>`).join('')||'<div class="empty">暂无文字记录</div>';
   $('#group-history-dialog').showModal();return;
  }
  if(button.dataset.groupMemory){selectedGroup=id;selectedMember='';editorDirty=false;$('#memory-group').value=id;$('#member-search').value='';$('#memory-editor').innerHTML='<div class="empty tall">选择成员</div>';await view('memory');return;}
  if(button.dataset.editGroup){editingGroup=id;$('#edit-group-name').value=g.name;$('#edit-group-model').innerHTML=modelOptions(g.model);$('#group-dialog').showModal();return;}
  if(button.dataset.pauseGroup){await api('/api/admin/groups/'+encodeURIComponent(id),'PATCH',{paused:!g.paused});await refresh();notify(g.paused?'已启用':'已停用');return;}
  if(g.enabled&&!await confirmAction('取消群聊授权','停止「'+g.name+'」的自动回复？'))return;
  await api('/api/admin/groups/'+encodeURIComponent(id),'PATCH',{enabled:!g.enabled});await refresh();notify(g.enabled?'已取消授权':'已授权');
 });
};
$('#group-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('/api/admin/groups/'+encodeURIComponent(editingGroup),'PATCH',{model:$('#edit-group-model').value});$('#group-dialog').close();await refresh();notify('群聊设置已保存');});};
$('#add-group-open').onclick=()=>$('#add-dialog').showModal();
$('#add-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('/api/admin/groups','POST',{name:$('#group-name').value});$('#add-dialog').close();$('#group-name').value='';await refresh();notify('群聊已授权');});};
$('#pause').onclick=event=>action(event.currentTarget,async()=>{await api('/api/control','POST',{paused:!state.paused});await refresh();notify(state.paused?'机器人已暂停':'机器人已启动');});
$('#auto-reply').onchange=event=>action(event.currentTarget,async()=>{try{await api('/api/control','POST',{paused:state.paused,auto_reply:event.target.checked});await refresh();notify('自动回复设置已保存');}catch(e){event.target.checked=state.auto_reply;throw e;}});
$('#refresh').onclick=event=>action(event.currentTarget,async()=>{await refresh();if(currentView==='jobs')await loadJobs();if(currentView==='memory'){await loadMembers();if(selectedMember&&!editorDirty)await loadMember();}notify('已刷新');});

async function loadMembers(){
 const group=selectedGroup,request=++memberRequest;
 const data=await api(group?`/api/admin/groups/${encodeURIComponent(group)}/members`:'/api/admin/members');
 if(request!==memberRequest||group!==selectedGroup||!loggedIn)return;members=data.members;renderMembers();
}
function renderMembers(){
 const search=$('#member-search').value.trim().toLocaleLowerCase(),filtered=members.filter(m=>m.name.toLocaleLowerCase().includes(search)||m.id.toLocaleLowerCase().includes(search));
 $('#member-count').textContent=members.length;
 $('#members').innerHTML=filtered.map(m=>`<button class="member-list-item ${m.id===selectedMember?'active':''}" data-member="${esc(m.id)}" ${m.id===selectedMember?'aria-current="true"':''}><span class="member-avatar">${esc(m.name[0]||'?')}</span><div><div class="member-name">${esc(m.name)}</div><div class="member-meta">${Math.floor(m.turn_count/2)} 轮对话 · ${m.memory_scope==='member'?(m.groups?.length||1)+' 个群':m.enabled?'已启用':'已停用'}</div></div></button>`).join('')||'<div class="empty">'+(search?'未找到成员':'暂无成员')+'</div>';
}
const memberPath=(group=selectedGroup,member=selectedMember)=>`/api/admin/groups/${encodeURIComponent(group||members.find(m=>m.id===member)?.chat_id||'')}/members/${encodeURIComponent(member)}`;
async function loadMember(){
 if(!selectedMember)return;const group=selectedGroup,member=selectedMember,request=++detailRequest;
 const {member:m,history}=await api(memberPath(group,member));if(request!==detailRequest||group!==selectedGroup||member!==selectedMember||!loggedIn)return;
 editorDirty=false;
 const scope=m.memory_scope==='member'?'所有群共享':groupName(group),native=m.memory_backend==='hermes';
 $('#memory-editor').innerHTML=`<div class="panel-heading"><div class="editor-title"><h2>${esc(m.name)}</h2><small>${esc(scope)} · ${native?'Hermes':'本地'}</small></div>${badge(m.groups?.length?m.groups.length+' 个群':'成员','neutral')}</div><form id="member-form"><div class="editor-fields">${group?`<div class="field-row"><div><label for="member-model">本群专属模型</label><select id="member-model">${modelOptions(m.model)}</select></div><div><label for="member-enabled">本群使用权限</label><select id="member-enabled"><option value="true" ${m.enabled?'selected':''}>已启用</option><option value="false" ${!m.enabled?'selected':''}>已停用</option></select></div></div>`:''}<label for="member-notes">成员资料</label><textarea id="member-notes" rows="5" maxlength="8000" placeholder="添加成员资料">${esc(m.notes)}</textarea>${native?`<label for="member-summary">长期笔记</label><textarea id="member-summary" rows="5" maxlength="8000" placeholder="Hermes 长期记忆">${esc(m.summary)}</textarea>`:''}<div class="editor-tools"><span id="memory-counter" class="muted">资料 ${m.notes.length} / 8000${native?' · 笔记 '+m.summary.length+' / 8000':''}</span><button id="save-member" type="submit" class="primary">保存</button></div></div></form><div class="history-heading"><h2>最近对话 <span class="muted">共 ${Math.floor(m.turn_count/2)} 轮</span></h2><div><button id="clear-context" class="text-button">清空上下文</button><span class="muted"> · </span><button id="reset-member" class="text-button danger-link">重置全部</button></div></div><div class="history">${history.map(t=>`<div class="turn ${esc(t.role)}"><div class="turn-header"><strong>${t.role==='user'?esc(m.name):'Gemini'}</strong><span>${dt(t.created_at)}</span></div><div class="turn-content">${esc(t.content)}</div></div>`).join('')||'<div class="empty">暂无对话</div>'}</div>`;
 $('#member-form').oninput=()=>{editorDirty=true;$('#memory-counter').textContent='资料 '+$('#member-notes').value.length+' / 8000'+(native?' · 笔记 '+$('#member-summary').value.length+' / 8000':'');};
 $('#member-form').onchange=()=>{editorDirty=true;};
 $('#member-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{
  const path=memberPath(group,member),patch={notes:$('#member-notes').value,...(native?{summary:$('#member-summary').value}:{}),...(group?{model:$('#member-model').value,enabled:$('#member-enabled').value==='true'}:{})};
  await api(path,'PATCH',patch);if(selectedGroup===group&&selectedMember===member){editorDirty=false;await loadMember();await loadMembers();}notify('记忆设置已保存');
 });};
 const reset=notes=>async event=>action(event.currentTarget,async()=>{if(!await confirmAction(notes?'重置全部记忆':'清空上下文',notes?`删除该成员的对话和长期记忆？${scope}，此操作无法撤销。`:`删除该成员的对话上下文？${scope}，长期记忆保留。`))return;await api(memberPath(group,member)+'/reset','POST',{notes});if(selectedGroup===group&&selectedMember===member){editorDirty=false;await loadMember();await loadMembers();}notify(notes?'已重置全部记忆':'已清空上下文');});
 $('#clear-context').onclick=reset(false);$('#reset-member').onclick=reset(true);renderMembers();
}
$('#memory-group').onchange=async()=>{if(!canLeaveEditor()){$('#memory-group').value=selectedGroup;return;}selectedGroup=$('#memory-group').value;selectedMember='';editorDirty=false;detailRequest++;$('#memory-editor').innerHTML='<div class="empty tall">选择成员</div>';$('#member-search').value='';try{await loadMembers();}catch(e){notify(e.message,true);}};
$('#member-search').oninput=renderMembers;
$('#members').onclick=async event=>{const button=event.target.closest('[data-member]');if(!button||!canLeaveEditor())return;selectedMember=button.dataset.member;editorDirty=false;try{await loadMember();}catch(e){notify(e.message,true);}};

async function loadModels(){
 try{const data=await api('/api/admin/models');models=data.models;modelsLoaded=true;modelSignature='';if(!globalDirty){$('#global-model').innerHTML=modelOptions(data.default_model,false);$('#reasoning-effort').value=data.reasoning_effort||'auto';}renderModels();}catch(e){modelsLoaded=false;$('#model-rows').innerHTML=emptyRow(3,'模型服务未连接');throw e;}
}
function renderModels(){
 $('#model-provider').textContent=state?.ai_provider==='hermes'?'Hermes · '+(state.model_source||'Ollama'):state?.ai_provider||'—';
 $('#model-rows').innerHTML=models.map(m=>`<tr><td class="mono">${esc(m.name)}</td><td>${m.source?esc(m.source):m.size?(m.size/1024**3).toFixed(2)+' GB':'—'}</td><td>${badge(m.name===state?.default_model?'默认模型':'可用',m.name===state?.default_model?'':'neutral')}</td></tr>`).join('')||emptyRow(3,modelsLoaded?'暂无可用模型':'模型服务未连接');
}
$('#global-model').onchange=()=>{globalDirty=true;};
$('#reasoning-effort').onchange=()=>{globalDirty=true;};
$('#model-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{await api('/api/admin/settings','PATCH',{default_model:$('#global-model').value,reasoning_effort:$('#reasoning-effort').value});globalDirty=false;modelSignature='';await refresh();notify('模型与推理强度已保存');});};
$('#refresh-models').onclick=event=>action(event.currentTarget,async()=>{await loadModels();notify('模型列表已刷新');});

async function loadJobs(){
 const request=++jobsRequest,query=new URLSearchParams({page:String(jobPage),page_size:'15',scope:$('#job-scope').value});
 for(const [key,id] of [['state','job-state'],['chat_id','job-group'],['search','job-search']]){const value=$('#'+id).value.trim();if(value)query.set(key,value);}
 const data=await api('/api/admin/jobs?'+query);if(request!==jobsRequest||!loggedIn)return;jobPage=data.page;jobPages=data.pages;
 $('#job-rows').innerHTML=data.items.map(j=>`<tr><td class="mono">${esc(j.id.slice(0,8))}</td><td>${esc(j.chat_name||groupName(j.chat_id))}${archived(j.chat_id)?' <span class="muted">归档</span>':''}</td><td>${jobBadge(j)}</td><td>${dt(j.created_at)}</td><td>${dt(j.updated_at)}</td><td class="align-right"><button class="text-button" data-job="${esc(j.id)}">详情</button></td></tr>`).join('')||emptyRow(6);
 $('#job-total').textContent='共 '+data.total+' 条记录';$('#job-page').textContent=jobPage+' / '+jobPages;$('#job-prev').disabled=jobPage<=1;$('#job-next').disabled=jobPage>=jobPages;
}
let searchTimer;
function filterJobs(){jobPage=1;loadJobs().catch(e=>notify(e.message,true));}
$('#job-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(filterJobs,250);};
['job-group','job-state','job-scope'].forEach(id=>$('#'+id).onchange=filterJobs);
$('#job-prev').onclick=()=>{if(jobPage>1){jobPage--;loadJobs().catch(e=>notify(e.message,true));}};$('#job-next').onclick=()=>{if(jobPage<jobPages){jobPage++;loadJobs().catch(e=>notify(e.message,true));}};
async function openJob(id){
 const job=await api('/api/jobs/'+encodeURIComponent(id));
 const reasons={wechat_server_ack:'微信已确认',chat_or_memory_no_longer_authorized:'授权或记忆已变更',device_error_no_automatic_retry:'设备连接异常',transport_migration_cancelled_stale_job:'迁移时取消',transport_migration_unconfirmed:'迁移时未确认',interrupted_before_confirmation:'发送中断'};
 $('#job-detail').innerHTML=`<dl class="settings-list"><div><dt>任务 ID</dt><dd class="mono">${esc(job.id)}</dd></div><div><dt>群聊</dt><dd>${esc(groupName(job.chat_id))}</dd></div><div><dt>状态</dt><dd>${jobBadge(job)}</dd></div><div><dt>创建时间</dt><dd>${dt(job.created_at)}</dd></div><div><dt>更新时间</dt><dd>${dt(job.updated_at)}</dd></div>${job.reason?`<div><dt>结果</dt><dd class="job-reason">${esc(reasons[job.reason]||job.reason)}</dd></div>`:''}</dl><div class="job-content">${esc(job.content)}</div>`;$('#job-dialog').showModal();
}
['recent-jobs','job-rows'].forEach(id=>$('#'+id).onclick=event=>{const button=event.target.closest('[data-job]');if(button)action(button,()=>openJob(button.dataset.job));});
const commands=[['/img 提示词','在自己的生图对话中生成图片','所有成员'],['/newimg','新建自己的生图对话','所有成员'],['/signup','提交群使用申请','所有成员'],['/help · /menu','查看对应权限菜单','所有成员'],['/models','查看模型列表','管理员'],['/model 模型名','切换本群模型','管理员'],['/model default','本群跟随默认模型','管理员'],['/status','查看本群状态','管理员'],['/new','新建自己的会话','管理员'],['/stop','停用本群回复','管理员'],['/start','启用本群回复','管理员'],['/reset','重置自己的全部记忆','所有成员'],['/remember 内容','添加自己的长期记忆','所有成员'],['/memory','查看自己的记忆状态','所有成员'],['/forget','清空自己的长期记忆','所有成员']];
$('#command-count').textContent=commands.length+' 项';$('#command-rows').innerHTML=commands.map(([cmd,label,role])=>`<tr><td><code>${esc(cmd)}</code></td><td>${esc(label)}</td><td><span class="muted">${esc(role)}</span></td></tr>`).join('');
$('#logout').onclick=event=>action(event.currentTarget,async()=>{if(!canLeaveEditor())return;await api('/api/auth/logout','POST',{});editorDirty=false;globalDirty=false;showLogin('已退出登录');});
async function start(){await refresh();try{await loadModels();}catch(e){notify(e.message,true);}await view(routeFromHash(),{force:true});}
$('#login-form').onsubmit=event=>{event.preventDefault();action(event.submitter,async()=>{try{await api('/api/auth/login','POST',{password:$('#password').value});$('#password').value='';await start();}catch(e){showLogin(e.message);$('#password').select();}});};
function loginFromLink(){
 const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');
 if(ticket)history.replaceState(null,'','#'+currentView);
 loginQueue=loginQueue.then(async()=>{try{if(ticket)await api('/api/auth/exchange','POST',{ticket});await start();}catch(e){showLogin(e.message);}});return loginQueue;
}
window.addEventListener('hashchange',()=>{if(new URLSearchParams(location.hash.slice(1)).has('ticket'))loginFromLink();else view(routeFromHash(),{setHash:false});});
loginFromLink();
setInterval(async()=>{if(!loggedIn||document.hidden)return;try{await refresh();if(currentView==='jobs'&&!$('#job-dialog').open)await loadJobs();}catch(e){if(loggedIn){$('#connection-error').textContent=e.message;$('#connection-error').classList.remove('hidden');}}},10000);
