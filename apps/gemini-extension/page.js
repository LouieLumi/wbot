(() => {
  const pageVersion='1.4.1';
  let running=false,activeTask,generationAbort,activeAnchor,renameDeadline;
  const documentId=Date.now().toString(36)+Math.random().toString(36).slice(2);
  const editor=()=>document.querySelector('[contenteditable="true"][role="textbox"]');
  const visible=e=>e instanceof HTMLElement&&e.getClientRects().length>0;
  const buttons=()=>[...document.querySelectorAll('button')].filter(visible);
  const label=e=>(e.getAttribute('aria-label')||'')+' '+(e.innerText||'');
  const promptText=text=>text.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
  const queryText=text=>promptText(text).replace(/\s+/g,' ');
  const editorText=input=>{
    // Quill represents each input line as a <p>. innerText inserts additional
    // layout-dependent newlines between paragraphs, which are NOT in the draft.
    const lines=[...input.children];
    return lines.length&&lines.every(line=>line.tagName==='P')
      ?lines.map(line=>line.textContent||'').join('\n'):input.innerText;
  };
  const sendButton=()=>buttons().find(b=>!b.disabled&&b.getAttribute('aria-disabled')!=='true'&&
    [b.getAttribute('aria-label')||'',b.innerText||''].some(text=>/^(发送|发送提示|提交|发送消息|Send message|Send prompt|Submit)$/i.test(text.trim())));
  const stop=()=>buttons().find(b=>/停止回答|Stop response|Stop generating/i.test(label(b)));
  const readResponse=anchor=>{
    // Gemini can replace the optimistic user-query and model-response nodes when
    // the server assigns a conversation/turn ID. Never retain those DOM objects
    // across generation. Re-resolve this submitted turn by ordinal AND full text.
    const query=[...document.querySelectorAll('user-query')][anchor.index];
    if(!query||!queryText(query.innerText).includes(anchor.text))return null;
    const turns=[...document.querySelectorAll('user-query,model-response')];
    const position=turns.indexOf(query);
    if(position<0)return null;
    const following=turns.slice(position+1),nextQuery=following.findIndex(e=>e.tagName==='USER-QUERY');
    const reply=(nextQuery<0?following:following.slice(0,nextQuery)).find(e=>e.tagName==='MODEL-RESPONSE');
    if(!reply||stop())return null;
    const pictures=[...reply.querySelectorAll('img')].filter(i=>/AI\s*生成|Generated image|AI.generated/i.test(i.alt));
    const image=pictures.find(i=>i.complete&&i.naturalWidth>=256);
    if(image)return {image};
    if(pictures.length)return null;
    const text=reply.querySelector('message-content .markdown')?.innerText.trim()||'';
    // Feedback/copy controls appear when the response has finished. Never forward
    // prompt text, a streaming preamble, navigation labels or previous replies.
    const completed=[...reply.querySelectorAll('button')].some(b=>visible(b)&&
      [b.getAttribute('aria-label')||'',b.innerText||''].some(value=>/^(答得好|Good response|复制|Copy)$/i.test(value.trim())));
    if(text&&completed)return {text:text.length>2000?text.slice(0,1990)+'…':text};
    // Some Gemini refusals remain aria-busy and never gain feedback controls.
    // Pass only explicit refusal text to the stability check, never a preamble.
    if(text&&/(?:无法|不能|不支持|不能帮助|不能协助).{0,24}(?:生成|创建|绘制).{0,24}(?:图像|图片|图画)|(?:can't|cannot|unable to).{0,24}(?:generate|create|draw).{0,24}(?:image|picture)/i.test(text))return {refusal:text.slice(0,2000)};
    return null;
  };
  const settledResponse=anchor=>{
    let previous='',since=0;
    return ()=>{
      const result=readResponse(anchor);
      if(!result?.refusal){previous='';return result;}
      if(previous!==result.refusal){previous=result.refusal;since=Date.now();}
      return Date.now()-since>=5000?{text:result.refusal}:null;
    };
  };
  const waitFor=(check,timeout,error='timeout',stableMs=0,signal=generationAbort?.signal)=>new Promise((resolve,reject)=>{
    let candidate,since=0;
    const probe=()=>{try{
      const result=check();
      if(!result){candidate=undefined;return;}
      if(result!==candidate){candidate=result;since=Date.now();}
      if(Date.now()-since>=stableMs){cleanup();resolve(result);}
    }catch(e){cleanup();reject(e);}};
    const observer=new MutationObserver(probe);
    const timer=setTimeout(()=>{cleanup();reject(Error(error));},Math.max(1,Math.min(timeout,renameDeadline?renameDeadline-Date.now():Infinity)));
    // A quiet DOM or a property-only change must not leave a readiness check stuck.
    const poll=setInterval(probe,100);
    const cancel=()=>{cleanup();reject(Error('cancelled'));};
    const cleanup=()=>{clearTimeout(timer);clearInterval(poll);observer.disconnect();document.removeEventListener('load',probe,true);signal?.removeEventListener('abort',cancel);};
    if(signal?.aborted){cancel();return;}signal?.addEventListener('abort',cancel,{once:true});
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    document.addEventListener('load',probe,true);probe();
  });
  const currentConversation=()=>/^\/app\/[A-Za-z0-9_-]+$/.test(location.pathname)?'https://gemini.google.com'+location.pathname:null;
  const emptyTranscript=()=>!!editor()&&!stop()&&!promptText(editorText(editor())||'')&&document.querySelectorAll('user-query,model-response').length===0;
  const emptyLanding=()=>location.pathname==='/app'&&emptyTranscript();
  const emptyConversation=()=>!!currentConversation()&&emptyTranscript();
  async function existingConversation(task){
    const expected=task.page_url.split('#')[0];
    let state;try{state=await waitFor(()=>{
      if(currentConversation()===expected&&document.querySelectorAll('user-query').length>0&&document.querySelectorAll('model-response').length>0&&!stop())return 'loaded';
      if(emptyLanding())return 'unavailable';
      return false;
    },Math.max(1000,Math.min(45_000,task.expires-Date.now()-5000)),'page_changed',500);
    }catch(error){
      // The editor can be usable while the conversation fetch has stalled.
      // Refresh this exact saved conversation before inserting any prompt.
      if(error.message==='page_changed'&&currentConversation()===expected&&emptyConversation())throw Error('conversation_load_failed');
      throw error;
    }
    if(state==='unavailable')throw Error('conversation_unavailable');
  }
  const currentLink=()=>[...document.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===location.pathname);
  const dialog=()=>[...document.querySelectorAll('[role="dialog"]')].find(visible);
  async function conversationMenu(item,error){
    const menu=await waitFor(()=>buttons().find(b=>/^(打开对话操作菜单。?|Open conversation actions menu\.?)$/i.test((b.getAttribute('aria-label')||'').trim())),15_000,error);
    menu.click();
    const entry=await waitFor(()=>[...document.querySelectorAll('[role="menuitem"]')].find(e=>visible(e)&&item.test(e.innerText.trim())),5000,error);
    entry.click();await waitFor(dialog,5000,error);
  }
  async function renameConversation(title){
    if(!title)return;
    const url=currentConversation();if(!url)throw Error('conversation_rename_failed');
    const named=()=>currentLink()?.textContent.trim()===title||document.title===title+' - Google Gemini';
    if(named())return;
    await conversationMenu(/^(重命名|Rename)$/i,'conversation_rename_failed');
    const input=await waitFor(()=>dialog()?.querySelector('input[type="text"]'),15_000,'conversation_rename_failed');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    setter.call(input,title);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
    const save=await waitFor(()=>[...dialog()?.querySelectorAll('button')||[]].find(b=>!b.disabled&&/^(重命名|Rename)$/i.test(b.innerText.trim())),5000,'conversation_rename_failed');
    if(currentConversation()!==url||input.value!==title)throw Error('conversation_rename_failed');
    save.click();
    await waitFor(()=>!dialog()&&currentConversation()===url&&named(),15_000,'conversation_rename_failed',300);
  }
  async function deleteConversation(task){
    const expected=task.page_url.split('#')[0];
    await waitFor(()=>currentConversation()===expected&&document.querySelectorAll('user-query').length>0&&!stop(),20_000,'conversation_delete_failed',300);
    await conversationMenu(/^(删除|Delete)$/i,'conversation_delete_failed');
    const confirm=await waitFor(()=>[...dialog()?.querySelectorAll('button')||[]].find(b=>!b.disabled&&/^(删除|Delete)$/i.test(b.innerText.trim())),5000,'conversation_delete_failed');
    if(currentConversation()!==expected||!dialog()||!/(删除对话|Delete chat|Delete conversation)/i.test(dialog().innerText))throw Error('conversation_delete_failed');
    confirm.click();
    const path=new URL(expected).pathname;
    const removed=()=>!dialog()&&![...document.querySelectorAll('a[href]')].some(a=>a.getAttribute('href')===path);
    const cleared=()=>!!editor()&&!stop()&&document.querySelectorAll('user-query,model-response').length===0;
    await waitFor(()=>removed()&&(currentConversation()!==expected||cleared()),15_000,'conversation_delete_failed',500);
    // Gemini can clear a deleted conversation while keeping the old address.
    // Report this only after clicking its confirmation and observing both the
    // transcript and sidebar entry disappear. The worker owns the next navigation.
    return {cleared:currentConversation()===expected};
  }
  async function bindConversation(task){
    if(!task.conversation_title)return;
    // Gemini can keep /app while generating the first response, assigning its
    // persistent URL only at the end. The submitted turn already owns this task;
    // wait within its generation budget instead of abandoning it after 15s.
    const url=await waitFor(currentConversation,Math.max(1000,task.expires-Date.now()-5000),'timeout');
    const deadline=Date.now()+5000;
    while(Date.now()<deadline&&!generationAbort.signal.aborted){
      const result=await chrome.runtime.sendMessage({kind:'conversation',id:task.id,document_id:documentId,pageUrl:url});
      if(result?.ok)return;
      if(!result?.pending||currentConversation()!==url)throw Error('page_changed');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw Error('page_changed');
  }
  async function submitPrompt(task){
    const expected=task.page_url?.replace('https://gemini.google.com','')||'/app#nila-image-worker-'+task.id;
    const [expectedPath,expectedHash]=expected.split('#');
    // Gemini may remove our fragment during its own routing. The worker pins a
    // new document to this task; the assigned conversation path must still match.
    const fresh=()=>location.pathname===expectedPath&&(!location.hash||location.hash==='#'+expectedHash);
    if(!fresh())throw Error('page_changed');
    if(expected.startsWith('/app/')){
      // Gemini renders the editor before fetching a saved conversation. Do not
      // submit until its history is present; otherwise continuity is uncertain.
      await waitFor(()=>{
        if(!fresh())throw Error('page_changed');
        return !!editor()&&!stop()&&document.querySelectorAll('user-query').length>0&&document.querySelectorAll('model-response').length>0;
      },20_000,'page_changed',300);
    }
    await waitFor(()=>{
      if(!fresh())throw Error('page_changed');
      return !!editor()&&!stop();
    },20_000,'login_required',500);
    let input=editor();if(!input)throw Error('login_required');
    const text=task.operation==='reset'?task.prompt:'请生成一张图片，不要仅用文字回答，也不要拼图。图片内容：\n'+task.prompt;
    const previous=new Set(document.querySelectorAll('model-response'));
    const queries=new Set(document.querySelectorAll('user-query'));
    const queryCount=queries.size;
    const insert=()=>{
      input.focus();
      const selection=getSelection(),range=document.createRange();range.selectNodeContents(input);selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand('insertText',false,text))throw Error('submission_failed');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    };
    insert();let repairs=0;
    // Wait on semantic readiness, not the identity of an Angular button node.
    // The composer can also be replaced after a saved conversation finishes loading.
    await waitFor(()=>{
      if(!fresh()||Date.now()>=task.expires)throw Error('page_changed');
      const current=editor();
      if(current&&current!==input){
        if(++repairs>2||document.querySelectorAll('user-query').length!==queryCount)throw Error('submission_failed');
        input=current;insert();return false;
      }
      return current===input&&promptText(editorText(input))===promptText(text)&&!stop()&&!!sendButton();
    },20_000,'submission_failed',500);
    const submit=sendButton();if(!submit||editor()!==input)throw Error('submission_failed');
    submit.click();
    // A click is not an acknowledgement. Require this exact prompt in a NEW user
    // turn plus a cleared composer or a new generation. Never blindly click twice.
    const anchor=await waitFor(()=>{
      const current=[...document.querySelectorAll('user-query')];
      // Existing turns can be re-created too; an old identical prompt is not an
      // acknowledgement. Require a turn added after the pre-submission history.
      const accepted=current.slice(queryCount).find(q=>queryText(q.innerText).includes(queryText(text)));
      return accepted&&(!promptText(editor()?.innerText||'')||stop()||[...document.querySelectorAll('model-response')].some(r=>!previous.has(r)))&&{index:current.indexOf(accepted),text:queryText(text)};
    // Gemini may accept a click only after a slow route/network transition. Keep
    // ownership until the task deadline; a short timeout loses a late accepted
    // request and its image. Do not click again while acknowledgement is pending.
    },Math.max(1000,task.expires-Date.now()-5000),'submission_failed');
    return anchor;
  }
  async function downloadImage(currentImage,signal,expires){
    let failure=Object.assign(Error('download_failed'),{download_status:0});
    for(let attempt=0;attempt<3;attempt++){
      if(signal.aborted)throw Error('cancelled');
      const remaining=expires-Date.now()-1000;if(remaining<=0)throw failure;
      const picture=currentImage(),src=picture?.currentSrc||picture?.src;
      if(!src){
        if(attempt<2){await new Promise(resolve=>setTimeout(resolve,1000));continue;}
        throw failure;
      }
      const url=new URL(src);
      const allowed=url.protocol==='blob:'&&url.origin==='https://gemini.google.com'||
        url.protocol==='https:'&&!url.username&&!url.password&&url.hostname.endsWith('.googleusercontent.com');
      if(!allowed)throw Error('page_changed');
      try{
        // Image elements carry browser credentials. fetch defaults to same-origin,
        // which dropped those credentials on Google's cross-origin download redirect.
        const response=await fetch(src,{credentials:'include',cache:'no-cache',
          signal:AbortSignal.any([signal,AbortSignal.timeout(Math.min(15_000,remaining))])});
        if(!response.ok)throw Object.assign(Error('download_failed'),{download_status:response.status});
        const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
        if(!['image/png','image/jpeg','image/webp'].includes(mime))throw Object.assign(Error('download_failed'),{download_status:response.status});
        if(Number(response.headers.get('content-length'))>8*1024*1024)throw Error('image_too_large');
        const chunks=[];let size=0;const reader=response.body?.getReader();if(!reader)throw Error('download_failed');
        try{
          for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
            if(size>8*1024*1024){await reader.cancel();throw Error('image_too_large');}chunks.push(value);}
        }finally{reader.releaseLock();}
        if(size<16)throw Error('download_failed');
        return new Blob(chunks,{type:mime});
      }catch(error){
        if(signal.aborted)throw Error('cancelled');
        failure=Object.assign(Error('download_failed'),{download_status:error.download_status||0});
        if(error.message==='image_too_large')throw failure;
      }
      // Retry the already generated asset only; never resubmit the prompt.
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
    }
    throw failure;
  }
  const status=()=>{
    const input=editor(),generating=!!stop();
    const hasDraft=!!promptText(input?editorText(input):[...document.querySelectorAll('textarea,input')].filter(visible).map(e=>e.value||'').join(''));
    // The static loading shell has no real editor, transcript or actionable
    // controls. Do not refresh login screens, drafts or an ongoing generation.
    const emptyShell=!input&&!running&&!generating&&!hasDraft&&/^\/app(?:\/[A-Za-z0-9_-]+)?$/.test(location.pathname)&&
      !document.querySelectorAll('user-query,model-response').length&&!buttons().length&&
      ![...document.querySelectorAll('a[href],[role="dialog"]')].some(visible);
    const authenticated=[...document.querySelectorAll('a[href]')].some(a=>visible(a)&&a.getAttribute('href')?.startsWith('https://accounts.google.com/SignOutOptions'));
    return {ready:!!input&&!generating,authenticated,empty_landing:emptyLanding(),empty_shell:emptyShell,has_draft:hasDraft,generating,busy:running,protocol:4,page_version:pageVersion,document_id:documentId,pageUrl:location.href};
  };
  chrome.runtime.onMessage.addListener((m,_,reply)=>{
    if(m.kind==='status')reply(status());
    if(m.kind==='capture-conversation'&&m.id===activeTask){
      const query=activeAnchor&&[...document.querySelectorAll('user-query')][activeAnchor.index];
      reply({url:query&&queryText(query.innerText).includes(activeAnchor.text)?currentConversation():null,document_id:documentId});
    }
    if(m.kind==='cancel'&&m.id===activeTask){generationAbort?.abort();stop()?.click();reply({ok:true});}
  });
  async function generate(task){
    running=true;activeTask=task.id;generationAbort=new AbortController();let result,step='start';
    const advance=async value=>{
      step=value;
      await chrome.runtime.sendMessage({kind:'step',id:task.id,document_id:documentId,step,submitted:Boolean(activeAnchor)}).catch(()=>{});
    };
    try{
      if(!editor())throw Error('login_required');
      const accepted=await chrome.runtime.sendMessage({kind:'started',id:task.id,document_id:documentId});
      if(!accepted?.ok)throw Error('page_changed');
      let blob;
      if(task.operation==='delete'){
        await advance('delete');
        const deleted=await deleteConversation(task);result={id:task.id,ok:true,deleted:true,...deleted};
      }else if(task.image_url){
        await advance('download');
        blob=await downloadImage(()=>({src:task.image_url}),generationAbort.signal,task.expires);
      }else{
        if(task.conversation_title&&/^https:\/\/gemini\.google\.com\/app\//.test(task.page_url||'')){
          await advance('prepare');
          await existingConversation(task);
        }
        // Page text is data. Only this request's submitted turn is read.
        await advance('submit');const anchor=await submitPrompt(task);activeAnchor=anchor;
        await advance('bind');
        await bindConversation(task);
        await advance('response');
        let conversationPath=/^\/app\/[^/]+$/.test(location.pathname)?location.pathname:undefined;
        const response=settledResponse(anchor);
        const found=await waitFor(()=>{
          if(/^\/app\/[^/]+$/.test(location.pathname)){
            if(conversationPath&&location.pathname!==conversationPath)throw Error('page_changed');
            conversationPath=location.pathname;
          }else if(conversationPath)throw Error('page_changed');
          return response();
        },Math.max(1000,task.expires-Date.now()-5000));
        if(task.operation==='reset')result={id:task.id,ok:true,reset_complete:true};
        else if(found.text)result={id:task.id,ok:false,error:'text_response',text:found.text};
        else {await advance('download');blob=await downloadImage(()=>readResponse(anchor)?.image,generationAbort.signal,task.expires);}
        // Naming is metadata: a missing menu must not discard an already
        // generated image or a refusal. Limit this work and retain the result.
        if(task.conversation_title&&task.expires-Date.now()>5000){
          await advance('rename');renameDeadline=Math.min(Date.now()+12_000,task.expires-3000);
          try{await renameConversation(task.conversation_title);}catch{}
          finally{renameDeadline=undefined;}
        }
      }
      if(blob){
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
        result={id:task.id,ok:true,mime_type:blob.type,data};
      }
      await advance('result');
    }catch(e){result={id:task.id,ok:false,error:['login_required','quota','timeout','page_changed','conversation_unavailable','conversation_load_failed','submission_failed','download_failed','conversation_rename_failed','conversation_delete_failed'].includes(e.message)?e.message:'generation_failed',...(e.message==='download_failed'?{download_status:e.download_status||0}:{})};}
    try{
      while(!generationAbort.signal.aborted&&Date.now()<task.expires){
        const ack=await chrome.runtime.sendMessage({kind:'result',result,step,submitted:Boolean(activeAnchor),empty_landing:emptyLanding(),empty_conversation:emptyConversation(),pageUrl:location.href,document_id:documentId}).catch(()=>null);
        if(ack?.ok||ack?.ignored||ack?.expired)break;
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }finally{running=false;activeTask=undefined;activeAnchor=undefined;generationAbort=undefined;}
    void ready();
  }
  let checking=false;
  async function ready(){
    if(checking)return;checking=true;
    try{const response=await chrome.runtime.sendMessage({kind:'ready',...status(),pageUrl:location.href});if(response?.task&&!running)void generate(response.task);}catch{}
    finally{checking=false;}
  }
  setInterval(ready,3000);void ready();
})();
