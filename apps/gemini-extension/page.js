(() => {
  let running=false,activeTask,generationAbort;
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
    const completed=[...reply.querySelectorAll('button')].some(b=>visible(b)&&/^(答得好|Good response|复制|Copy)$/i.test(label(b).trim()));
    if(text&&completed)return {text:text.length>2000?text.slice(0,1990)+'…':text};
    return null;
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
    const timer=setTimeout(()=>{cleanup();reject(Error(error));},timeout);
    // A quiet DOM or a property-only change must not leave a readiness check stuck.
    const poll=setInterval(probe,100);
    const cancel=()=>{cleanup();reject(Error('cancelled'));};
    const cleanup=()=>{clearTimeout(timer);clearInterval(poll);observer.disconnect();document.removeEventListener('load',probe,true);signal?.removeEventListener('abort',cancel);};
    if(signal?.aborted){cancel();return;}signal?.addEventListener('abort',cancel,{once:true});
    observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true});
    document.addEventListener('load',probe,true);probe();
  });
  async function submitPrompt(task){
    const expected=task.page_url?.replace('https://gemini.google.com','')||'/app#nila-image-worker-'+task.id;
    const fresh=()=>location.pathname+location.hash===expected;
    if(!fresh())throw Error('page_changed');
    if(expected.startsWith('/app/')){
      // Gemini renders the editor before fetching a saved conversation. Do not
      // submit until its history is present; otherwise continuity is uncertain.
      await waitFor(()=>{
        if(!fresh())throw Error('page_changed');
        return !!editor()&&!stop()&&document.querySelectorAll('user-query').length>0&&document.querySelectorAll('model-response').length>0;
      },20_000,'page_changed',300);
    }
    const input=editor();if(!input)throw Error('login_required');
    const text='请生成一张图片，不要仅用文字回答，也不要拼图。图片内容：\n'+task.prompt;
    const previous=new Set(document.querySelectorAll('model-response'));
    const queries=new Set(document.querySelectorAll('user-query'));
    const queryCount=queries.size;
    input.focus();
    const selection=getSelection(),range=document.createRange();range.selectNodeContents(input);selection.removeAllRanges();selection.addRange(range);
    if(!document.execCommand('insertText',false,text))throw Error('submission_failed');
    input.dispatchEvent(new Event('input',{bubbles:true}));
    // Quill and the page framework update asynchronously after a long insertion.
    // Wait for the entire draft and an enabled send control to settle before clicking.
    const submit=await waitFor(()=>{
      if(!fresh()||Date.now()>=task.expires)throw Error('page_changed');
      if(editor()!==input||promptText(editorText(input))!==promptText(text)||stop())return null;
      return sendButton();
    },10_000,'submission_failed',500);
    submit.click();
    // A click is not an acknowledgement. Require this exact prompt in a NEW user
    // turn plus a cleared composer or a new generation. Never blindly click twice.
    const anchor=await waitFor(()=>{
      const current=[...document.querySelectorAll('user-query')];
      // Existing turns can be re-created too; an old identical prompt is not an
      // acknowledgement. Require a turn added after the pre-submission history.
      const accepted=current.slice(queryCount).find(q=>queryText(q.innerText).includes(queryText(text)));
      return accepted&&(!promptText(editor()?.innerText||'')||stop()||[...document.querySelectorAll('model-response')].some(r=>!previous.has(r)))&&{index:current.indexOf(accepted),text:queryText(text)};
    },12_000,'submission_failed');
    return anchor;
  }
  const status=()=>({ready:!!editor(),busy:running,protocol:2});
  chrome.runtime.onMessage.addListener((m,_,reply)=>{
    if(m.kind==='status')reply(status());
    if(m.kind==='cancel'&&m.id===activeTask){generationAbort?.abort();stop()?.click();reply({ok:true});}
  });
  async function generate(task){
    running=true;activeTask=task.id;generationAbort=new AbortController();let result;
    try{
      if(!editor())throw Error('login_required');
      if(!location.hash.endsWith(task.id))throw Error('page_changed');
      // Page text is never executed or treated as instructions. Only this fresh turn is read.
      const anchor=await submitPrompt(task);let conversationPath=/^\/app\/[^/]+$/.test(location.pathname)?location.pathname:undefined;
      const found=await waitFor(()=>{
        if(/^\/app\/[^/]+$/.test(location.pathname)){
          if(conversationPath&&location.pathname!==conversationPath)throw Error('page_changed');
          conversationPath=location.pathname;
        }else if(conversationPath)throw Error('page_changed');
        return readResponse(anchor);
      },Math.max(1000,task.expires-Date.now()-5000));
      if(found.text){
        result={id:task.id,ok:false,error:'text_response',text:found.text};
      }else{
      const src=found.image.currentSrc||found.image.src;
      const url=new URL(src);
      if(!(url.protocol==='blob:'&&url.origin==='https://gemini.google.com')&&!(url.protocol==='https:'&&url.hostname.endsWith('.googleusercontent.com')))throw Error('page_changed');
      const response=await fetch(src,{signal:generationAbort.signal});if(!response.ok)throw Error('generation_failed');
      const blob=await response.blob();if(blob.size>8*1024*1024||!['image/png','image/jpeg','image/webp'].includes(blob.type))throw Error('generation_failed');
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
      result={id:task.id,ok:true,mime_type:blob.type,data};
      }
    }catch(e){result={id:task.id,ok:false,error:['login_required','quota','timeout','page_changed','submission_failed'].includes(e.message)?e.message:'generation_failed'};}
    try{if(!generationAbort.signal.aborted)await chrome.runtime.sendMessage({kind:'result',result,pageUrl:location.href});}finally{running=false;activeTask=undefined;generationAbort=undefined;}
  }
  async function ready(){
    try{const response=await chrome.runtime.sendMessage({kind:'ready',...status(),pageUrl:location.href});if(response?.task&&!running)void generate(response.task);}catch{}
  }
  setInterval(ready,3000);void ready();
})();
