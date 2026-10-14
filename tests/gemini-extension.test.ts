import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function submissionPage(){
  let now=0,nextTimer=0,clicks=0;
  const timers=new Map<number,{at:number;repeat:number;run:()=>void}>();
  const schedule=(run:()=>void,ms:number,repeat=0)=>{const id=++nextTimer;timers.set(id,{at:now+ms,repeat,run});return id;};
  class Clock extends Date {static now(){return now;}}
  class Element {
    innerText='';disabled=false;ariaDisabled='false';
    children:{tagName:string;textContent:string}[]=[];
    constructor(public aria=''){}
    getAttribute(name:string){return name==='aria-label'?this.aria:name==='aria-disabled'?this.ariaDisabled:null;}
    getClientRects(){return [1];}focus(){}dispatchEvent(){}
    click(){clicks++;onClick();}
  }
  let input=new Element(),replaceButtons=false;const button=new Element('发送');button.innerText='发送';
  const queries:{innerText:string}[]=[],replies:object[]=[];
  let inserted='',onClick=()=>{},insert=(text:string)=>{input.innerText=text;};
  const location={pathname:'/app',hash:'#nila-image-worker-test'};
  const context=vm.createContext({HTMLElement:Element,Date:Clock,Event:class {},
    location,
    setTimeout:(fn:()=>void,ms:number)=>schedule(fn,ms),clearTimeout:(id:number)=>timers.delete(id),
    setInterval:(fn:()=>void,ms:number)=>schedule(fn,ms,ms),clearInterval:(id:number)=>timers.delete(id),
    MutationObserver:class {observe(){}disconnect(){}},
    getSelection:()=>({removeAllRanges(){},addRange(){}}),
    document:{documentElement:{},addEventListener(){},removeEventListener(){},
      createRange:()=>({selectNodeContents(){}}),querySelector:()=>input,
      querySelectorAll:(selector:string)=>selector==='button'?[replaceButtons?Object.assign(new Element('发送'),{innerText:button.innerText,disabled:button.disabled,ariaDisabled:button.ariaDisabled}):button]:selector==='user-query'?queries:selector==='model-response'?replies:[],
      execCommand:(_command:string,_ui:boolean,text:string)=>{inserted=text;insert(text);return true;}},
    chrome:{runtime:{onMessage:{addListener(){}}}},
  });
  const source=readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
    .replace('setInterval(ready,3000);void ready();','globalThis.submitForTest=submitPrompt;');
  vm.runInContext(source,context);
  return {get input(){return input;},button,queries,replies,location,
    replaceComposer(){input=new Element();},replaceSendButtons(){replaceButtons=true;},
    get clicks(){return clicks;},get inserted(){return inserted;},get timerCount(){return timers.size;},
    setInsert(fn:(text:string)=>void){insert=fn;},setClick(fn:()=>void){onClick=fn;},
    submit(prompt:string,page_url?:string){return (context as any).submitForTest({id:'test',prompt,page_url,expires:60_000}) as Promise<{index:number;text:string}>;},
    async advance(ms:number){
      const end=now+ms;
      for(;;){
        const entry=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
        if(!entry)break;
        const [id,timer]=entry;now=timer.at;
        if(timer.repeat)timer.at+=timer.repeat;else timers.delete(id);
        timer.run();await Promise.resolve();await Promise.resolve();
      }
      now=end;await Promise.resolve();
    },
  };
}

test('long prompt waits for the complete draft and enabled send button to settle, then confirms the new user turn',async()=>{
  const page=submissionPage(),prompt=('多行要求🌙\n'.repeat(900))+'最后一条要求';
  page.setInsert(text=>{page.input.innerText=text.slice(0,2000);});
  page.button.ariaDisabled='true';
  page.setClick(()=>{assert(page.inserted.endsWith(prompt));page.queries.push({innerText:'你说 '+page.inserted});page.input.innerText='\n';});
  const pending=page.submit(prompt);
  await page.advance(700);assert.equal(page.clicks,0);
  page.input.innerText=page.inserted;
  await page.advance(700);assert.equal(page.clicks,0);
  page.button.ariaDisabled='false';
  await page.advance(500);assert.equal(page.clicks,0);
  await page.advance(100);await pending;
  assert.equal(page.clicks,1);assert.equal(page.timerCount,0);
});

test('button replacement, composer replacement and router hash cleanup do not strand a draft',async()=>{
  const page=submissionPage();page.replaceSendButtons();
  page.setClick(()=>{page.queries.push({innerText:page.inserted});page.input.innerText='';});
  const pending=page.submit('保存好完整提示词');
  await page.advance(700);assert.equal(page.clicks,0);
  page.replaceComposer();page.location.hash='';
  await page.advance(1000);await pending;
  assert.equal(page.clicks,1);assert(page.inserted.endsWith('保存好完整提示词'));assert.equal(page.timerCount,0);
});

test('a click with the draft still present fails promptly without double submitting',async()=>{
  const page=submissionPage(),pending=page.submit('画一个苹果');
  const rejected=assert.rejects(pending,/submission_failed/);
  await page.advance(14_000);await rejected;
  assert.equal(page.clicks,1);assert.equal(page.input.innerText,page.inserted);assert.equal(page.timerCount,0);
});

test('a continuing image prompt is submitted only in its assigned existing conversation',async()=>{
  const page=submissionPage();page.location.pathname='/app/owned';
  page.setClick(()=>{page.queries.push({innerText:page.inserted});page.input.innerText='';});
  const pending=page.submit('把上一张的背景改成蓝色','https://gemini.google.com/app/owned#nila-image-worker-test');
  await page.advance(1000);assert.equal(page.clicks,0);assert.equal(page.inserted,'');
  page.queries.push({innerText:'上次的提示词'});page.replies.push({});
  await page.advance(1600);const submitted=await pending;assert.equal(submitted.index,1);assert(submitted.text.endsWith('把上一张的背景改成蓝色'));assert.equal(page.clicks,1);
  const wrong=submissionPage();wrong.location.pathname='/app/other';
  await assert.rejects(wrong.submit('不要串对话','https://gemini.google.com/app/owned#nila-image-worker-test'),/page_changed/);assert.equal(wrong.clicks,0);
});

test('Quill paragraph layout does not block a complete long multiline prompt',async()=>{
  const page=submissionPage(),prompt=('第一行：构图要求\n\n第二行：保留空行与缩进\n  文字要求\n'.repeat(150))+'最终要求🌙';
  page.setInsert(text=>{
    const lines=text.split('\n');
    page.input.children=lines.map(line=>({tagName:'P',textContent:line}));
    // Real Gemini adds display-only paragraph spacing to innerText.
    page.input.innerText=lines.join('\n\n');
  });
  page.setClick(()=>{page.queries.push({innerText:'你说 '+page.input.innerText});page.input.innerText='\n';page.input.children=[];});
  const pending=page.submit(prompt);await page.advance(1200);await pending;
  assert.equal(page.clicks,1);assert(page.inserted.endsWith(prompt));assert.equal(page.timerCount,0);
});

test('paragraph serialization still rejects a missing line or character',async()=>{
  const page=submissionPage();
  page.setInsert(text=>{
    page.input.children=text.split('\n').slice(0,-1).map(line=>({tagName:'P',textContent:line}));
    page.input.innerText=text;
  });
  const rejected=assert.rejects(page.submit('完整第一行\n不能丢掉的第二行'),/submission_failed/);
  await page.advance(21_000);await rejected;assert.equal(page.clicks,0);
});

test('a truncated draft is never submitted',async()=>{
  const page=submissionPage();page.setInsert(text=>{page.input.innerText=text.slice(0,2000);});
  const rejected=assert.rejects(page.submit('图'.repeat(6000)),/submission_failed/);
  await page.advance(21_000);await rejected;
  assert.equal(page.clicks,0);assert.equal(page.timerCount,0);
});

test('old identical user turns and an emptied editor are not a submission acknowledgement',async()=>{
  const page=submissionPage();
  page.queries.push({innerText:'请生成一张图片，不要仅用文字回答，也不要拼图。图片内容：\n画一个苹果'});
  page.setClick(()=>{page.queries[0]={innerText:page.queries[0]!.innerText};page.input.innerText='';});
  const rejected=assert.rejects(page.submit('画一个苹果'),/submission_failed/);
  await page.advance(14_000);await rejected;assert.equal(page.clicks,1);
});

function resultPage(){
  class Button {
    innerText='';constructor(private label:string){}
    getAttribute(name:string){return name==='aria-label'?this.label:null;}
    getClientRects(){return [1];}
  }
  const makeReply=(text:string)=>({tagName:'MODEL-RESPONSE',text,pictures:[] as any[],buttons:[] as Button[],
    querySelector(selector:string){return selector==='message-content .markdown'?{innerText:this.text}:null;},
    querySelectorAll(selector:string){return selector==='img'?this.pictures:selector==='button'?this.buttons:[];}});
  const page={turns:[] as any[],controls:[] as Button[]};
  const context=vm.createContext({HTMLElement:Button,
    document:{querySelectorAll:(selector:string)=>selector==='user-query,model-response'?page.turns:selector==='user-query'?page.turns.filter(t=>t.tagName==='USER-QUERY'):selector==='button'?page.controls:[]},
    chrome:{runtime:{onMessage:{addListener:()=>{}}}}});
  const source=readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
    .replace('setInterval(ready,3000);void ready();','globalThis.readReplyForTest=readResponse;');
  vm.runInContext(source,context);
  return {page,makeReply,button:(label:string)=>new Button(label),query:(text:string)=>({tagName:'USER-QUERY',innerText:text}),read:(context as any).readReplyForTest};
}

test('page reads only the submitted turn, prioritizes its image and waits for streaming or image loading',()=>{
  const {page,makeReply,button,query,read}=resultPage();
  const old=makeReply('旧回复和旧图片'),reply=makeReply('我暂时无法生成这张图片。\n请换一个主题。');
  old.buttons=[button('复制')];page.turns=[query('旧提示'),old,query('当前提示'),reply];
  const anchor={index:1,text:'当前提示'};
  assert.equal(read(anchor),null);
  reply.buttons=[button('复制')];page.controls=[button('停止回答')];assert.equal(read(anchor),null);
  page.controls=[];assert.equal(read(anchor).text,reply.text);
  const picture={alt:'，AI 生成',complete:false,naturalWidth:0};reply.pictures=[picture];
  assert.equal(read(anchor),null);
  picture.complete=true;picture.naturalWidth=1024;assert.equal(read(anchor).image,picture);
  reply.pictures=[];reply.text='字'.repeat(2200);assert(read(anchor).text.length<=2000);
  page.turns.pop();assert.equal(read(anchor),null);
  // A later user's response must never be returned for this request.
  page.turns.push(query('别人的提示'),reply);assert.equal(read(anchor),null);
  page.turns=[query('不同的提示'),reply];assert.equal(read({index:0,text:'当前提示'}),null);
});

test('completed image is recovered after Gemini replaces every optimistic message node',()=>{
  const {page,makeReply,query,read}=resultPage();
  const anchor={index:1,text:'画一艘货轮'};
  const old=makeReply('旧图');old.pictures=[{alt:'AI 生成',complete:true,naturalWidth:1024}];
  const optimistic=query('你说 画一艘货轮'),pending=makeReply('');
  page.turns=[query('画一艘货轮'),old,optimistic,pending];assert.equal(read(anchor),null);
  const completed=makeReply('');const image={alt:'，AI 生成',complete:true,naturalWidth:1024};completed.pictures=[image];
  page.turns=[query('画一艘货轮'),makeReply('重新渲染的历史回复'),query('你说 画一艘货轮'),completed];
  assert.notEqual(page.turns[2],optimistic);assert.notEqual(page.turns[3],pending);
  assert.equal(read(anchor).image,image);
  // Missing or shifted history fails closed instead of returning another image.
  page.turns=[query('画一艘货轮'),old];assert.equal(read(anchor),null);
});

test('extension dispatches a task after same-document navigation, only when the intended page is ready',async()=>{
  const task={id:'75a6bca0-466d-4a4d-a53e-105bc70b676c',prompt:'一只鲸鱼',expires:Date.now()+60_000,tabId:17,phase:'loading',previous_document_id:'old-doc',page_url:'https://gemini.google.com/app#nila-image-worker-75a6bca0-466d-4a4d-a53e-105bc70b676c'};
  const state:Record<string,unknown>={tabId:17,active:task};
  let listener:(message:unknown,sender:unknown,respond:(value:unknown)=>void)=>void;
  const event=()=>({addListener:()=>{}});
  const chrome={
    storage:{local:{
      get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(state[key])])),
      set:async(values:Record<string,unknown>)=>{Object.assign(state,values);},
      remove:async(key:string)=>{delete state[key];},
    }},
    runtime:{onInstalled:event(),onStartup:event(),onMessage:{addListener:(fn:typeof listener)=>{listener=fn;}}},
    alarms:{onAlarm:event()},action:{onClicked:event()},
  };
  const source=readFileSync(new URL('../apps/gemini-extension/worker.js',import.meta.url),'utf8')
    .replace("import {endpoint,token} from './connection.js';",'');
  vm.runInNewContext(source,{chrome,endpoint:'http://127.0.0.1:3152',token:'test',AbortSignal,
    fetch:async()=>({ok:true,json:async()=>({ok:true})})});
  // Chrome's sender URL can refer to the original document after only its hash changes.
  const sender={tab:{id:17},url:'https://gemini.google.com/app#nila-image-worker'};
  const current='https://gemini.google.com/app#nila-image-worker-'+task.id;
  const send=(message:unknown,from=sender)=>new Promise<any>(resolve=>listener(message,from,resolve));
  assert.equal((await send({kind:'ready',document_id:'old-doc',protocol:3,ready:true,pageUrl:current})).task,undefined);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:3,ready:false,pageUrl:current})).task,undefined);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:3,ready:true,pageUrl:sender.url})).task,undefined);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:3,ready:true,pageUrl:current},{...sender,tab:{id:99}})).ignored,true);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:3,ready:true,pageUrl:current})).task.id,task.id);
  // A lost task response can be handed out again until the page acknowledges start.
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:3,ready:true,pageUrl:current})).task.id,task.id);
  assert.equal((await send({kind:'started',document_id:'new-doc',id:task.id})).ok,true);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:3,ready:true,pageUrl:current})).task,undefined);
  assert.equal((state.active as typeof task).phase,'generating');
});

test('extension repairs a lost page script, throttles reloads, and never replays an interrupted generation',async()=>{
  for(const mode of ['lost','login','loading','generating']){
    const state:Record<string,any>={tabId:17};let reloads=0;
    if(mode==='generating')state.active={id:'75a6bca0-466d-4a4d-a53e-105bc70b676c',phase:'generating',expires:Date.now()+60_000};
    const calls:{path:string;body:any}[]=[];
    const event=()=>({addListener:()=>{}});
    const chrome={
      storage:{local:{
        get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(state[key])])),
        set:async(values:Record<string,unknown>)=>{Object.assign(state,values);},
        remove:async(key:string)=>{delete state[key];},
      }},
      tabs:{get:async()=>({id:17,url:'https://gemini.google.com/app',status:mode==='loading'?'loading':'complete'}),
        sendMessage:async()=>{if(mode==='login')return {ready:false,protocol:3};throw Error('no_receiving_end');},
        reload:async(id:number)=>{assert.equal(id,17);reloads++;}},
      runtime:{onInstalled:event(),onStartup:event(),onMessage:event()},alarms:{onAlarm:event()},action:{onClicked:event()},
    };
    const source=readFileSync(new URL('../apps/gemini-extension/worker.js',import.meta.url),'utf8').replace("import {endpoint,token} from './connection.js';",'');
    const context=vm.createContext({chrome,endpoint:'http://127.0.0.1:3152',token:'test',AbortSignal,
      fetch:async(url:string,options:any)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(options.body)});return {ok:true,json:async()=>({task:null})};}});
    vm.runInContext(source,context);
    await vm.runInContext('tick()',context);await vm.runInContext('tick()',context);
    assert.equal(reloads,['lost','generating'].includes(mode)?1:0);
    if(mode==='generating'){
      assert.equal(state.active,undefined);
      assert.equal(calls.filter(c=>c.path==='/result'&&c.body.error==='browser_restarted').length,1);
      assert.equal(calls.some(c=>c.path==='/claim'),false);
    }
  }
});

function conversationWorker(state:Record<string,any>={tabId:17}){
  let url='https://gemini.google.com/app',listener:any,taskActive=true,doc=0,failResult=false;
  const tasks:any[]=[],calls:{path:string;body:any}[]=[],navigations:string[]=[],cancellations:string[]=[];
  const event=()=>({addListener(){}});
  const chrome={
    storage:{local:{get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(state[k])])),set:async(values:object)=>Object.assign(state,values),remove:async(key:string)=>{delete state[key];}}},
    tabs:{get:async()=>({id:17,url,status:'complete'}),update:async(_id:number,patch:any)=>{if(patch.url){url=patch.url;navigations.push(url);doc++;}},reload:async()=>{doc++;},
      sendMessage:async(_id:number,message:any)=>{if(message.kind==='cancel'){cancellations.push(message.id);return {ok:true};}return {ready:true,busy:false,protocol:3,document_id:'doc-'+doc};}},
    runtime:{onInstalled:event(),onStartup:event(),onMessage:{addListener:(fn:any)=>{listener=fn;}}},alarms:{onAlarm:event()},action:{onClicked:event()},
  };
  const context=vm.createContext({chrome,endpoint:'http://127.0.0.1:3152',token:'test',AbortSignal,
    fetch:async(raw:string,options:any)=>{
      const path=new URL(raw).pathname,body=JSON.parse(options.body);calls.push({path,body});
      if(path==='/result'&&failResult)return {ok:false,status:503};
      return {ok:true,json:async()=>path==='/claim'?{task:tasks.shift()??null}:path==='/heartbeat'?{ok:true,task_active:taskActive}:{ok:true}};
    }});
  const source=readFileSync(new URL('../apps/gemini-extension/worker.js',import.meta.url),'utf8').replace("import {endpoint,token} from './connection.js';",'');vm.runInContext(source,context);
  const send=(message:any)=>new Promise<any>(resolve=>listener(message,{tab:{id:17},url:'https://gemini.google.com/app'},resolve));
  return {state,tasks,calls,navigations,cancellations,
    setActive(value:boolean){taskActive=value;},failResult(value:boolean){failResult=value;},setUrl(value:string){url=value;},
    tick:()=>vm.runInContext('tick()',context),
    async ready(){return send({kind:'ready',document_id:'doc-'+doc,ready:true,protocol:3,pageUrl:url});},
    async started(id:string){return send({kind:'started',id,document_id:'doc-'+doc});},
    async finish(id:string,conversation:string){url=conversation;return send({kind:'result',document_id:'doc-'+doc,result:{id,ok:false,error:'text_response',text:'模型回复'},pageUrl:conversation});},
    async settle(){await vm.runInContext('operations',context);await vm.runInContext('operations',context);},
  };
}

test('browser routes A then B then A into separate persistent conversations; a new session starts fresh',async()=>{
  const {randomUUID}=await import('node:crypto');const sessionA=randomUUID(),sessionB=randomUUID();
  const worker=conversationWorker();
  const run=async(session:string,conversation:string,expected:string)=>{
    const task={id:randomUUID(),session_id:session,prompt:'画图',expires:Date.now()+60_000};worker.tasks.push(task);
    await worker.tick();assert.equal(worker.navigations.at(-1),expected+'#nila-image-worker-'+task.id);
    // Concurrent page heartbeats can claim this page only once.
    const ready=await Promise.all([worker.ready(),worker.ready()]);assert.equal(ready.filter(r=>r.task).length,2);await worker.started(task.id);assert.equal((await worker.ready()).task,undefined);
    await worker.finish(task.id,conversation);await worker.settle();return task;
  };
  const a='https://gemini.google.com/app/conversationA',b='https://gemini.google.com/app/conversationB';
  await run(sessionA,a,'https://gemini.google.com/app');await run(sessionB,b,'https://gemini.google.com/app');await run(sessionA,a,a);
  assert.equal(worker.state.conversations[sessionA],a);assert.equal(worker.state.conversations[sessionB],b);
  const restarted=conversationWorker(worker.state),task={id:randomUUID(),session_id:sessionB,prompt:'继续',expires:Date.now()+60_000};restarted.tasks.push(task);await restarted.tick();
  assert.equal(restarted.navigations.at(-1),b+'#nila-image-worker-'+task.id);
  await restarted.ready();await restarted.finish(task.id,b);await restarted.settle();
  await run(randomUUID(),'https://gemini.google.com/app/fresh','https://gemini.google.com/app');
});

test('cancelled browser tasks stop the current generation and a late result cannot replace another session',async()=>{
  const {randomUUID}=await import('node:crypto'),worker=conversationWorker();
  const task={id:randomUUID(),session_id:randomUUID(),prompt:'old',expires:Date.now()+60_000};worker.tasks.push(task);await worker.tick();await worker.ready();
  worker.setActive(false);await worker.tick();assert.deepEqual(worker.cancellations,[task.id]);assert.equal(worker.state.active,undefined);
  const late=await worker.finish(task.id,'https://gemini.google.com/app/old');assert.equal(late.ignored,true);
  assert.equal(worker.state.conversations,undefined);assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);
});

test('navigation to an unrelated conversation cannot overwrite the stored user conversation',async()=>{
  const {randomUUID}=await import('node:crypto'),session=randomUUID(),saved='https://gemini.google.com/app/owned';
  const worker=conversationWorker({tabId:17,conversations:{[session]:saved}}),task={id:randomUUID(),session_id:session,prompt:'continue',expires:Date.now()+60_000};
  worker.tasks.push(task);await worker.tick();await worker.ready();
  await worker.finish(task.id,'https://gemini.google.com/app/someoneElse');await worker.settle();
  assert.equal(worker.state.conversations[session],saved);
  assert.equal(worker.calls.find(c=>c.path==='/result')!.body.error,'page_changed');
});

test('a failed result upload retains the active user until acknowledgement, then advances the queue',async()=>{
  const {randomUUID}=await import('node:crypto'),worker=conversationWorker();
  const first={id:randomUUID(),session_id:randomUUID(),prompt:'A',expires:Date.now()+60_000};
  const second={id:randomUUID(),session_id:randomUUID(),prompt:'B',expires:Date.now()+60_000};
  worker.tasks.push(first,second);await worker.tick();await worker.ready();await worker.started(first.id);
  worker.failResult(true);assert.equal((await worker.finish(first.id,'https://gemini.google.com/app/first')).error,'bridge_unavailable');
  await worker.tick();assert.equal(worker.state.active.id,first.id);assert.equal(worker.tasks.length,1);
  worker.failResult(false);await worker.finish(first.id,'https://gemini.google.com/app/first');await worker.settle();
  assert.equal(worker.state.conversations[first.session_id],'https://gemini.google.com/app/first');
  assert.equal(worker.state.active.id,second.id);
});
