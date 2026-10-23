import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const extensionVersion=JSON.parse(readFileSync(new URL('../apps/gemini-extension/manifest.json',import.meta.url),'utf8')).version;

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
  const bindings:object[]=[];
  const context=vm.createContext({HTMLElement:Element,Date:Clock,Event:class {},AbortController,
    location,
    setTimeout:(fn:()=>void,ms:number)=>schedule(fn,ms),clearTimeout:(id:number)=>timers.delete(id),
    setInterval:(fn:()=>void,ms:number)=>schedule(fn,ms,ms),clearInterval:(id:number)=>timers.delete(id),
    MutationObserver:class {observe(){}disconnect(){}},
    getSelection:()=>({removeAllRanges(){},addRange(){}}),
    document:{documentElement:{},addEventListener(){},removeEventListener(){},
      createRange:()=>({selectNodeContents(){}}),querySelector:()=>input,
      querySelectorAll:(selector:string)=>selector==='button'?[replaceButtons?Object.assign(new Element('发送'),{innerText:button.innerText,disabled:button.disabled,ariaDisabled:button.ariaDisabled}):button]:selector==='user-query'?queries:selector==='model-response'?replies:selector==='user-query,model-response'?[...queries,...replies]:[],
      execCommand:(_command:string,_ui:boolean,text:string)=>{inserted=text;insert(text);return true;}},
    chrome:{runtime:{onMessage:{addListener(){}},sendMessage:async(value:object)=>{bindings.push(value);return {ok:true};}}},
  });
  const source=readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
    .replace('setInterval(ready,3000);void ready();','globalThis.submitForTest=submitPrompt; globalThis.existingForTest=existingConversation; globalThis.bindForTest=task=>{generationAbort=new AbortController();return bindConversation(task);};');
  vm.runInContext(source,context);
  return {get input(){return input;},button,queries,replies,location,bindings,
    replaceComposer(){input=new Element();},replaceSendButtons(){replaceButtons=true;},
    get clicks(){return clicks;},get inserted(){return inserted;},get timerCount(){return timers.size;},
    setInsert(fn:(text:string)=>void){insert=fn;},setClick(fn:()=>void){onClick=fn;},
    submit(prompt:string,page_url?:string){return (context as any).submitForTest({id:'test',prompt,page_url,expires:60_000}) as Promise<{index:number;text:string}>;},
    bind(){return (context as any).bindForTest({id:'test',conversation_title:'wxid_test的对话',expires:60_000}) as Promise<void>;},
    existing(){return (context as any).existingForTest({page_url:'https://gemini.google.com/app/owned#nila-image-worker-test',expires:60_000}) as Promise<void>;},
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

test('a first conversation may receive its URL after 15 seconds without abandoning the submitted task',async()=>{
  const page=submissionPage();let finished=false;
  const pending=page.bind().then(()=>{finished=true;});
  await page.advance(30_000);assert.equal(finished,false);assert.equal(page.bindings.length,0);
  page.location.pathname='/app/lateConversation';
  await page.advance(200);await pending;
  assert.equal(finished,true);assert.equal(page.bindings.length,1);assert.equal(page.timerCount,0);
});

test('an unavailable saved conversation is distinguished from slow history, a draft, or another conversation',async()=>{
  const missing=submissionPage(),unavailable=assert.rejects(missing.existing(),/conversation_unavailable/);
  await missing.advance(600);await unavailable;assert.equal(missing.clicks,0);
  const slow=submissionPage();slow.location.pathname='/app/owned';let loaded=false;
  const waiting=slow.existing().then(()=>{loaded=true;});await slow.advance(30_000);assert.equal(loaded,false);
  slow.queries.push({innerText:'历史提示词'});slow.replies.push({});await slow.advance(700);await waiting;
  for(const kind of ['draft','other'] as const){
    const page=submissionPage();if(kind==='draft')page.input.innerText='尚未提交的内容';else page.location.pathname='/app/other';
    const rejected=assert.rejects(page.existing(),/page_changed/);await page.advance(60_000);await rejected;
    assert.equal(page.clicks,0);
  }
});

test('a stalled empty saved conversation requests a refresh before inserting a prompt, but drafts and partial history do not',async()=>{
  for(const kind of ['empty','draft','partial'] as const){
    const page=submissionPage();page.location.pathname='/app/owned';
    if(kind==='draft')page.input.innerText='不要丢弃的草稿';
    if(kind==='partial')page.queries.push({innerText:'尚未加载完的历史'});
    const rejected=assert.rejects(page.existing(),kind==='empty'?/conversation_load_failed/:/page_changed/);
    await page.advance(46_000);await rejected;
    assert.equal(page.clicks,0);assert.equal(page.inserted,'');assert.equal(page.timerCount,0);
  }
});

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

test('a click with the draft still present expires within the task budget without double submitting',async()=>{
  const page=submissionPage(),pending=page.submit('画一个苹果');
  const rejected=assert.rejects(pending,/submission_failed/);
  await page.advance(60_000);await rejected;
  assert.equal(page.clicks,1);assert.equal(page.input.innerText,page.inserted);assert.equal(page.timerCount,0);
});

test('a slow accepted submission retains ownership and never clicks twice',async()=>{
  const page=submissionPage();let completed=false;
  const pending=page.submit('画一个苹果').then(anchor=>{completed=true;return anchor;});
  await page.advance(30_000);assert.equal(completed,false);assert.equal(page.clicks,1);
  page.queries.push({innerText:page.inserted});page.input.innerText='';
  await page.advance(100);const anchor=await pending;
  assert.equal(anchor.index,0);assert.equal(page.clicks,1);assert.equal(page.timerCount,0);
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
  await page.advance(60_000);await rejected;assert.equal(page.clicks,1);
});

function resultPage(){
  let now=0;class Clock extends Date {static now(){return now;}}
  class Button {
    innerText='';constructor(private label:string){}
    getAttribute(name:string){return name==='aria-label'?this.label:null;}
    getClientRects(){return [1];}
  }
  const makeReply=(text:string)=>({tagName:'MODEL-RESPONSE',text,pictures:[] as any[],buttons:[] as Button[],
    querySelector(selector:string){return selector==='message-content .markdown'?{innerText:this.text}:null;},
    querySelectorAll(selector:string){return selector==='img'?this.pictures:selector==='button'?this.buttons:[];}});
  const page={turns:[] as any[],controls:[] as Button[]};
  const context=vm.createContext({HTMLElement:Button,Date:Clock,
    document:{querySelectorAll:(selector:string)=>selector==='user-query,model-response'?page.turns:selector==='user-query'?page.turns.filter(t=>t.tagName==='USER-QUERY'):selector==='button'?page.controls:[]},
    chrome:{runtime:{onMessage:{addListener:()=>{}}}}});
  const source=readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
    .replace('setInterval(ready,3000);void ready();','globalThis.readReplyForTest=readResponse;globalThis.settledForTest=settledResponse;');
  vm.runInContext(source,context);
  return {page,makeReply,button:(label:string)=>new Button(label),query:(text:string)=>({tagName:'USER-QUERY',innerText:text}),read:(context as any).readReplyForTest,
    settled:(context as any).settledForTest,advance:(ms:number)=>{now+=ms;}};
}

test('page reads only the submitted turn, prioritizes its image and waits for streaming or image loading',()=>{
  const {page,makeReply,button,query,read}=resultPage();
  const old=makeReply('旧回复和旧图片'),reply=makeReply('我暂时无法生成这张图片。\n请换一个主题。');
  old.buttons=[button('复制')];page.turns=[query('旧提示'),old,query('当前提示'),reply];
  const anchor={index:1,text:'当前提示'};
  assert.equal(read(anchor).refusal,reply.text);
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

test('a stable explicit refusal without feedback controls is returned, while preambles and ongoing generation are not',()=>{
  const p=resultPage(),reply=p.makeReply('正在绘制，请稍候。');
  p.page.turns=[p.query('当前提示'),reply];const read=p.settled({index:0,text:'当前提示'});
  assert.equal(read(),null);p.advance(20_000);assert.equal(read(),null);
  reply.text='抱歉，我无法生成不安全的图像。';assert.equal(read(),null);
  p.advance(4000);assert.equal(read(),null);
  reply.text+='请换一个主题。';assert.equal(read(),null);
  p.advance(5000);assert.equal(read().text,reply.text);
  p.page.controls=[p.button('停止回答')];assert.equal(read(),null);
  p.page.controls=[];assert.equal(read(),null);p.advance(5000);assert.equal(read().text,reply.text);
  // A loaded picture always wins over a provisional refusal.
  reply.pictures=[{alt:'AI 生成',complete:true,naturalWidth:1024}];assert.equal(read().image,reply.pictures[0]);
});

test('feedback buttons with icon text still confirm a completed textual response',()=>{
  const p=resultPage(),reply=p.makeReply('本次只返回了文字。'),button=p.button('复制');button.innerText='copy';
  reply.buttons=[button];p.page.turns=[p.query('本次请求'),reply];
  assert.equal(p.read({index:0,text:'本次请求'}).text,reply.text);
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

function deletionPage(outcome:'cleared'|'redirected'|'history_remains'|'link_remains'){
  let now=0,nextTimer=0,history=true,oldLink=true,menu=false,opened=false,confirmClicks=0,newChatClicks=0;
  const timers=new Map<number,{at:number;repeat:number;run:()=>void}>();
  const schedule=(run:()=>void,ms:number,repeat=0)=>{const id=++nextTimer;timers.set(id,{at:now+ms,repeat,run});return id;};
  class Clock extends Date {static now(){return now;}}
  class Element {
    disabled=false;
    constructor(public innerText:string,private aria='',private href:string|null=null,public click=()=>{}){}
    getAttribute(name:string){return name==='aria-label'?this.aria:name==='href'?this.href:null;}
    getClientRects(){return [1];}
    querySelectorAll(selector:string){return selector==='button'?[confirm]:[];}
  }
  const location={pathname:'/app/owned'},input=new Element('');
  const action=new Element('','打开对话操作菜单。',null,()=>{menu=true;});
  const entry=new Element('删除','',null,()=>{menu=false;opened=true;});
  const modal=new Element('删除对话');
  const confirm=new Element('删除','',null,()=>{
    confirmClicks++;opened=false;history=outcome==='history_remains';oldLink=outcome==='link_remains';
    if(outcome==='redirected')location.pathname='/app';
  });
  const old=new Element('测试对话','','/app/owned');
  const fresh=new Element('发起新对话','','/app',()=>{newChatClicks++;location.pathname='/app';});
  const context=vm.createContext({HTMLElement:Element,Date:Clock,URL,location,
    setTimeout:(fn:()=>void,ms:number)=>schedule(fn,ms),clearTimeout:(id:number)=>timers.delete(id),
    setInterval:(fn:()=>void,ms:number)=>schedule(fn,ms,ms),clearInterval:(id:number)=>timers.delete(id),
    MutationObserver:class {observe(){}disconnect(){}},
    document:{documentElement:{},addEventListener(){},removeEventListener(){},querySelector:()=>input,
      querySelectorAll:(selector:string)=>selector==='button'?[action]:selector==='[role="menuitem"]'?(menu?[entry]:[]):selector==='[role="dialog"]'?(opened?[modal]:[]):selector==='a[href]'?(oldLink?[old,fresh]:[fresh]):selector==='user-query'||selector==='user-query,model-response'?(history?[{}]:[]):[]},
    chrome:{runtime:{onMessage:{addListener(){}}}},
  });
  vm.runInContext(readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
    .replace('setInterval(ready,3000);void ready();','globalThis.deleteForTest=deleteConversation;'),context);
  return {location,get confirmClicks(){return confirmClicks;},get newChatClicks(){return newChatClicks;},
    remove:()=>((context as any).deleteForTest({page_url:'https://gemini.google.com/app/owned#nila-image-worker-test'}) as Promise<{cleared:boolean}>),
    async advance(ms:number){
      const end=now+ms;
      for(;;){
        for(let i=0;i<8;i++)await Promise.resolve();
        const entry=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;
        const [id,timer]=entry;now=timer.at;if(timer.repeat)timer.at+=timer.repeat;else timers.delete(id);
        timer.run();await Promise.resolve();await Promise.resolve();
      }
      now=end;await Promise.resolve();
    },
  };
}

test('deletion confirms a cleared transcript and removed sidebar entry when Gemini keeps its old URL',async()=>{
  for(const outcome of ['cleared','redirected'] as const){
    const page=deletionPage(outcome),pending=page.remove();await page.advance(5000);const result=await pending;
    assert.equal(page.confirmClicks,1);assert.equal(result.cleared,outcome==='cleared');
    assert.equal(page.newChatClicks,0);
  }
});

test('deletion never leaves or confirms a conversation whose history or sidebar entry remains',async()=>{
  for(const outcome of ['history_remains','link_remains'] as const){
    const page=deletionPage(outcome),rejected=assert.rejects(page.remove(),/conversation_delete_failed/);
    await page.advance(20_000);await rejected;
    assert.equal(page.confirmClicks,1);assert.equal(page.newChatClicks,0);assert.equal(page.location.pathname,'/app/owned');
  }
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
  const send=(message:object,from=sender)=>new Promise<any>(resolve=>listener({page_version:extensionVersion,...message},from,resolve));
  assert.equal((await send({kind:'ready',document_id:'old-doc',protocol:4,ready:true,pageUrl:current})).task,undefined);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:4,ready:false,pageUrl:current})).task,undefined);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:4,ready:true,pageUrl:sender.url})).task,undefined);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:4,ready:true,pageUrl:current},{...sender,tab:{id:99}})).ignored,true);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:4,ready:true,pageUrl:current})).task.id,task.id);
  // A lost task response can be handed out again until the page acknowledges start.
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:4,ready:true,pageUrl:current})).task.id,task.id);
  assert.equal((await send({kind:'started',document_id:'new-doc',id:task.id})).ok,true);
  assert.equal((await send({kind:'ready',document_id:'new-doc',protocol:4,ready:true,pageUrl:current})).task,undefined);
  assert.equal((state.active as typeof task).phase,'generating');
});

test('extension repairs a lost page script, throttles reloads, and never replays an interrupted generation',async()=>{
  for(const mode of ['lost','login','loading','generating','stale']){
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
        sendMessage:async()=>{if(mode==='login')return {ready:false,protocol:4,page_version:extensionVersion};if(mode==='stale')return {ready:true,protocol:4,page_version:'1.3.6'};throw Error('no_receiving_end');},
        reload:async(id:number)=>{assert.equal(id,17);reloads++;}},
      runtime:{onInstalled:event(),onStartup:event(),onMessage:event()},alarms:{onAlarm:event()},action:{onClicked:event()},
    };
    const source=readFileSync(new URL('../apps/gemini-extension/worker.js',import.meta.url),'utf8').replace("import {endpoint,token} from './connection.js';",'');
    const context=vm.createContext({chrome,endpoint:'http://127.0.0.1:3152',token:'test',AbortSignal,
      fetch:async(url:string,options:any)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(options.body)});return {ok:true,json:async()=>({task:null})};}});
    vm.runInContext(source,context);
    await vm.runInContext('tick()',context);await vm.runInContext('tick()',context);
    assert.equal(reloads,['lost','generating','stale'].includes(mode)?1:0);
    if(mode==='stale')assert.equal(calls.some(c=>c.path==='/claim'),false);
    if(mode==='generating'){
      assert.equal(state.active,undefined);
      assert.equal(calls.filter(c=>c.path==='/result'&&c.body.error==='browser_restarted').length,1);
      assert.equal(calls.some(c=>c.path==='/claim'),false);
    }
  }
});

function conversationWorker(state:Record<string,any>={tabId:17}){
  let url='https://gemini.google.com/app',listener:any,taskActive=true,doc=0,failResult=false,tabId=17,failNavigation=false,delayedNavigation=false,pendingUrl='',pendingReads=0,emptyLanding=false;
  const tasks:any[]=[],calls:{path:string;body:any}[]=[],navigations:string[]=[],cancellations:string[]=[],reloadUrls:string[]=[];
  let pageStatus:Record<string,unknown>={},tabStatus='complete';const reloadOptions:any[]=[];
  const event=()=>({addListener(){}});
  const chrome={
    storage:{local:{get:async(keys:string|string[])=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,structuredClone(state[k])])),set:async(values:object)=>Object.assign(state,values),remove:async(key:string)=>{delete state[key];}}},
    tabs:{get:async(id:number)=>{if(id!==tabId)throw Error('tab_closed');if(pendingUrl&&++pendingReads>=3){url=pendingUrl;pendingUrl='';doc++;}return {id:tabId,url,status:tabStatus,pendingUrl};},
      query:async()=>[{id:tabId,url,status:'complete'}],
      update:async(_id:number,patch:any)=>{if(patch.url){if(failNavigation)throw Error('tab_temporarily_unavailable');navigations.push(patch.url);if(delayedNavigation){pendingUrl=patch.url;pendingReads=0;}else{url=patch.url;doc++;}}},reload:async(_id:number,options:any)=>{if(failNavigation)throw Error('tab_temporarily_unavailable');reloadUrls.push(url);reloadOptions.push(options);pendingUrl='';doc++;},
      sendMessage:async(_id:number,message:any)=>{if(message.kind==='cancel'){cancellations.push(message.id);return {ok:true};}return {ready:true,empty_landing:emptyLanding,busy:false,protocol:4,page_version:extensionVersion,document_id:'doc-'+doc,...pageStatus};}},
    runtime:{onInstalled:event(),onStartup:event(),onMessage:{addListener:(fn:any)=>{listener=fn;}}},alarms:{onAlarm:event()},action:{onClicked:event()},
  };
  const context=vm.createContext({chrome,endpoint:'http://127.0.0.1:3152',token:'test',AbortSignal,setTimeout:(fn:()=>void)=>queueMicrotask(fn),
    fetch:async(raw:string,options:any)=>{
      const path=new URL(raw).pathname,body=JSON.parse(options.body);calls.push({path,body});
      if(path==='/result'&&failResult)return {ok:false,status:503};
      return {ok:true,json:async()=>path==='/claim'?{task:tasks.shift()??null}:path==='/heartbeat'?{ok:true,task_active:taskActive}:{ok:true}};
    }});
  const source=readFileSync(new URL('../apps/gemini-extension/worker.js',import.meta.url),'utf8').replace("import {endpoint,token} from './connection.js';",'');vm.runInContext(source,context);
  const send=(message:any)=>new Promise<any>(resolve=>listener(message,{tab:{id:tabId},url:'https://gemini.google.com/app'},resolve));
  return {state,tasks,calls,navigations,cancellations,reloadUrls,reloadOptions,
    setPageStatus(value:Record<string,unknown>){pageStatus=value;},
    setTabStatus(value:string){tabStatus=value;},
    setActive(value:boolean){taskActive=value;},failResult(value:boolean){failResult=value;},setUrl(value:string){url=value;},
    setEmptyLanding(value:boolean){emptyLanding=value;},
    failNavigation(value:boolean){failNavigation=value;},
    delayNavigation(){delayedNavigation=true;},
    restoreTab(){tabId++;doc++;url='https://gemini.google.com/app#nila-image-worker';},
    allowNavigationRetry(age=6000){state.active.last_navigation=Date.now()-age;},
    tick:()=>vm.runInContext('tick()',context),
    async ready(){return send({kind:'ready',document_id:'doc-'+doc,ready:true,protocol:4,page_version:extensionVersion,pageUrl:url,...pageStatus});},
    async started(id:string){return send({kind:'started',id,document_id:'doc-'+doc});},
    async bound(id:string,conversation:string){url=conversation;return send({kind:'conversation',id,document_id:'doc-'+doc,pageUrl:conversation});},
    async boundBeforeTabUpdate(id:string,conversation:string){return send({kind:'conversation',id,document_id:'doc-'+doc,pageUrl:conversation});},
    async failedAfterSubmission(id:string,conversation:string){url=conversation;return send({kind:'result',document_id:'doc-'+doc,submitted:true,result:{id,ok:false,error:'page_changed'},pageUrl:conversation});},
    async unavailable(id:string,options:{submitted?:boolean;empty?:boolean;step?:string;page?:string}={}){
      url=options.page??'https://gemini.google.com/app';
      return send({kind:'result',document_id:'doc-'+doc,submitted:options.submitted??false,empty_landing:options.empty??true,step:options.step??'rename',result:{id,ok:false,error:'conversation_unavailable'},pageUrl:url});
    },
    async unloaded(id:string,options:{submitted?:boolean;empty?:boolean;step?:string;page?:string}={}){
      if(options.page)url=options.page;
      return send({kind:'result',document_id:'doc-'+doc,submitted:options.submitted??false,empty_conversation:options.empty??true,step:options.step??'rename',result:{id,ok:false,error:'conversation_load_failed'},pageUrl:url});
    },
    async deleted(id:string,cleared?:boolean){if(cleared===undefined)url='https://gemini.google.com/app';return send({kind:'result',document_id:'doc-'+doc,result:{id,ok:true,deleted:true,...(cleared!==undefined?{cleared}:{})},pageUrl:url});},
    async resetDone(id:string,conversation:string){url=conversation;return send({kind:'result',document_id:'doc-'+doc,result:{id,ok:true,reset_complete:true},pageUrl:conversation});},
    async finish(id:string,conversation:string){url=conversation;return send({kind:'result',document_id:'doc-'+doc,result:{id,ok:false,error:'text_response',text:'模型回复'},pageUrl:conversation});},
    async settle(){await vm.runInContext('operations',context);await vm.runInContext('operations',context);},
  };
}

test('same-path tasks reload without a fragment navigation and use the fresh document for ownership',async()=>{
  const {randomUUID}=await import('node:crypto'),worker=conversationWorker();worker.delayNavigation();
  const existing='https://gemini.google.com/app#nila-image-worker-old';worker.setUrl(existing);
  const task={id:randomUUID(),session_id:randomUUID(),prompt:'test',expires:Date.now()+60_000};worker.tasks.push(task);
  await worker.tick();assert.deepEqual(worker.reloadUrls,[existing]);assert.equal(worker.navigations.length,0);
  const dispatched=(await worker.ready()).task;assert.equal(dispatched.id,task.id);assert.equal(dispatched.page_url,existing);await worker.started(task.id);
  assert.equal(worker.state.active.phase,'generating');
});

test('browser routes A then B then A into separate persistent conversations; a new session starts fresh',async()=>{
  const {randomUUID}=await import('node:crypto');const sessionA=randomUUID(),sessionB=randomUUID();
  const worker=conversationWorker();
  const run=async(session:string,conversation:string,expected:string)=>{
    const task={id:randomUUID(),session_id:session,prompt:'画图',expires:Date.now()+60_000};worker.tasks.push(task);
    await worker.tick();assert.equal(worker.state.active.page_url.split('#')[0],expected);
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

test('a restored worker tab resumes only an undispatched task in its assigned conversation',async()=>{
  const {randomUUID}=await import('node:crypto'),session=randomUUID(),saved='https://gemini.google.com/app/owned';
  const worker=conversationWorker({tabId:17,conversations:{[session]:saved}});
  const task={id:randomUUID(),session_id:session,prompt:'继续画图',expires:Date.now()+60_000};
  worker.tasks.push(task);await worker.tick();worker.restoreTab();worker.allowNavigationRetry();
  await worker.tick();assert.equal(worker.state.tabId,18);assert.equal(worker.state.active.tabId,18);
  assert.equal(worker.navigations.at(-1),saved+'#nila-image-worker-'+task.id);
  assert.equal((await worker.ready()).task.id,task.id);await worker.started(task.id);
  assert.equal(worker.state.active.phase,'generating');assert.equal(worker.calls.filter(c=>c.path==='/claim').length,1);
});

test('a saved conversation redirect before dispatch is recovered once without changing another user binding',async()=>{
  const {randomUUID}=await import('node:crypto'),owner=randomUUID(),other=randomUUID(),old='https://gemini.google.com/app/missing',otherUrl='https://gemini.google.com/app/other';
  const worker=conversationWorker({tabId:17,conversations:{[owner]:old,[other]:otherUrl}});
  const task={id:randomUUID(),session_id:owner,conversation_title:'A的对话',retired_sessions:[],prompt:'原样保留的提示词',expires:Date.now()+60_000};
  worker.tasks.push(task);await worker.tick();worker.setUrl('https://gemini.google.com/app');worker.setEmptyLanding(true);worker.allowNavigationRetry();
  await worker.tick();assert.equal(worker.state.active.recovery_from,old);assert.equal(worker.state.active.prompt,task.prompt);
  assert.equal(worker.state.conversations[owner],old);assert.equal(worker.state.conversations[other],otherUrl);
  assert.equal(worker.reloadUrls.at(-1),'https://gemini.google.com/app');
  await worker.ready();await worker.started(task.id);
  assert.equal((await worker.bound(task.id,'https://gemini.google.com/app/recovered')).ok,true);
  assert.equal(worker.state.conversations[owner],'https://gemini.google.com/app/recovered');assert.equal(worker.state.conversations[other],otherUrl);
  await worker.finish(task.id,'https://gemini.google.com/app/recovered');await worker.settle();
  assert.equal(worker.calls.filter(c=>c.path==='/claim').length,2); // final idle tick only
  assert.equal(worker.calls.filter(c=>c.path==='/result').length,1);
});

test('a redirect discovered while waiting for history recovers without replaying a submitted or unrelated page',async()=>{
  const {randomUUID}=await import('node:crypto');
  for(const options of [{},{submitted:true},{empty:false},{step:'response'},{page:'https://gemini.google.com/app/unrelated'}]){
    const owner=randomUUID(),old='https://gemini.google.com/app/missing';
    const worker=conversationWorker({tabId:17,conversations:{[owner]:old}});
    const task={id:randomUUID(),session_id:owner,conversation_title:'A的对话',retired_sessions:[],prompt:'继续画图',expires:Date.now()+60_000};
    worker.tasks.push(task);await worker.tick();await worker.ready();await worker.started(task.id);
    const response=await worker.unavailable(task.id,options);await worker.settle();
    if(Object.keys(options).length===0){
      assert.equal(response.recovered,true);assert.equal(worker.state.active.recovery_from,old);
      assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);
      await worker.ready();await worker.started(task.id);
      await worker.unavailable(task.id);await worker.settle();
      assert.equal(worker.calls.filter(c=>c.path==='/result').length,1); // no recovery loop
    }else{
      assert.equal(response.recovered,undefined);assert.equal(worker.navigations.length,1);
      assert.equal(worker.calls.find(c=>c.path==='/result')!.body.error,'page_changed');
    }
    assert.equal(worker.state.conversations[owner],old);
  }
});

test('an unloaded saved history reloads once in the same member conversation without resubmitting or changing bindings',async()=>{
  const {randomUUID}=await import('node:crypto');
  for(const mode of ['recover','submitted','draft','response','other','binding_changed','deadline','expired'] as const){
    const owner=randomUUID(),other=randomUUID(),saved='https://gemini.google.com/app/owned';
    const worker=conversationWorker({tabId:17,conversations:{[owner]:saved,[other]:'https://gemini.google.com/app/other'}});
    const task={id:randomUUID(),session_id:owner,conversation_title:'A的对话',retired_sessions:[],prompt:'继续修改上一张图',expires:Date.now()+120_000};
    worker.tasks.push(task);await worker.tick();await worker.ready();await worker.started(task.id);
    if(mode==='binding_changed')worker.state.conversations[owner]='https://gemini.google.com/app/changed';
    if(mode==='deadline')worker.state.active.expires=Date.now()+10_000;
    if(mode==='expired')worker.setActive(false);
    const result=await worker.unloaded(task.id,mode==='submitted'?{submitted:true}:mode==='draft'?{empty:false}:mode==='response'?{step:'response'}:mode==='other'?{page:'https://gemini.google.com/app/other'}:{});
    await worker.settle();
    if(mode==='recover'){
      assert.equal(result.recovered,true);assert.equal(worker.state.active.history_reloads,1);
      assert.equal(worker.state.active.prompt,task.prompt);assert.equal(worker.state.active.session_id,owner);
      assert.equal(worker.state.active.phase,'loading');assert.equal(worker.state.active.recovery_from,undefined);
      assert.deepEqual(worker.reloadUrls,[saved+'#nila-image-worker-'+task.id]);
      assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);
      assert.equal((await worker.ready()).task.id,task.id);await worker.started(task.id);
      await worker.unloaded(task.id);await worker.settle();
      assert.equal(worker.reloadUrls.length,1);assert.equal(worker.calls.filter(c=>c.path==='/result').length,1);
      assert.equal(worker.state.active,undefined);
    }else{
      assert.equal(result.recovered,undefined);assert.equal(worker.reloadUrls.length,0);
      if(mode!=='expired')assert.equal(worker.calls.find(c=>c.path==='/result')!.body.error,'page_changed');
      else assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);
    }
    assert.equal(worker.state.conversations[owner],mode==='binding_changed'?'https://gemini.google.com/app/changed':saved);
    assert.equal(worker.state.conversations[other],'https://gemini.google.com/app/other');
  }
});

test('a committed URL with an unready page reloads with cache bypass before dispatch, then preserves the task and other members',async()=>{
  const {randomUUID}=await import('node:crypto'),owner=randomUUID(),other=randomUUID(),saved='https://gemini.google.com/app/owned';
  const worker=conversationWorker({tabId:17,conversations:{[owner]:saved,[other]:'https://gemini.google.com/app/other'}});
  const task={id:randomUUID(),session_id:owner,prompt:'完整提示词\n保留最后一行',expires:Date.now()+240_000};
  worker.tasks.push(task);await worker.tick();worker.setPageStatus({ready:false,empty_shell:true});
  assert.equal((await worker.ready()).task,undefined);await worker.settle();
  worker.allowNavigationRetry(44_000);await worker.tick();assert.equal(worker.reloadUrls.length,0);
  worker.allowNavigationRetry(46_000);await worker.tick();
  assert.equal(worker.reloadUrls.length,1);assert.equal(worker.reloadOptions[0].bypassCache,true);
  assert.equal(worker.state.active.prompt,task.prompt);assert.equal(worker.state.active.phase,'loading');
  assert.equal(worker.state.conversations[owner],saved);assert.equal(worker.state.conversations[other],'https://gemini.google.com/app/other');
  assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);
  worker.setPageStatus({});assert.equal((await worker.ready()).task.id,task.id);await worker.started(task.id);
  worker.setPageStatus({ready:false,empty_shell:true});worker.allowNavigationRetry(46_000);await worker.tick();
  assert.equal(worker.reloadUrls.length,1);assert.equal(worker.state.active.phase,'generating');
});

test('Chrome loading metadata cannot strand a stale document or prevent missing-script recovery',async()=>{
  const {randomUUID}=await import('node:crypto');
  for(const mode of ['stale','missing-script'] as const){
    const worker=conversationWorker(),task={id:randomUUID(),session_id:randomUUID(),prompt:'待发送',expires:Date.now()+240_000};
    if(mode==='stale')worker.failNavigation(true);
    worker.tasks.push(task);await worker.tick();worker.setTabStatus('loading');
    if(mode==='missing-script')worker.setPageStatus({protocol:0});
    worker.failNavigation(false);worker.allowNavigationRetry();await worker.tick();assert.equal(worker.state.active.load_attempts,1);
    worker.allowNavigationRetry(46_000);await worker.tick();assert.equal(worker.state.active.load_attempts,2);
    assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);assert.equal(worker.reloadOptions.at(-1).bypassCache,true);
    worker.setPageStatus({});assert.equal((await worker.ready()).task.id,task.id);
  }
  const idle=conversationWorker();idle.setPageStatus({protocol:0});idle.setTabStatus('loading');
  await idle.tick();assert.equal(idle.reloadUrls.length,0);
  idle.state.script_wait_since=Date.now()-31_000;await idle.tick();assert.equal(idle.reloadUrls.length,1);
  await idle.tick();assert.equal(idle.reloadUrls.length,1);
});

test('unready-page recovery has a retry limit, retains failed result delivery and does not discard drafts or manual generation',async()=>{
  const {randomUUID}=await import('node:crypto');
  for(const mode of ['shell','draft','generating','busy','budget'] as const){
    const worker=conversationWorker(),task={id:randomUUID(),session_id:randomUUID(),prompt:'未发送',expires:Date.now()+240_000};
    worker.tasks.push(task);await worker.tick();const initial=worker.reloadUrls.length;
    worker.setPageStatus({ready:false,empty_shell:mode==='shell',has_draft:mode==='draft',generating:mode==='generating',busy:mode==='busy'});
    if(mode==='budget')worker.state.active.expires=Date.now()+50_000;
    const attempts=mode==='shell'?3:1;
    for(let i=0;i<attempts-1;i++){worker.allowNavigationRetry(46_000);await worker.tick();}
    worker.failResult(true);worker.allowNavigationRetry(46_000);await worker.tick();assert(worker.state.active);
    worker.failResult(false);await worker.tick();assert.equal(worker.state.active,undefined);
    assert.equal(worker.reloadUrls.length-initial,attempts-1);
    assert.equal(worker.calls.at(-1)?.body.error,'page_load_failed');
    assert.equal(worker.calls.some(c=>c.path==='/failure-step'&&c.body.step==='load'),true);
  }
});

test('page status distinguishes a static shell from a login screen, existing history, drafts and ongoing generation',()=>{
  for(const mode of ['shell','login','history','draft','generating','ready'] as const){
    class Element {
      innerText='';value='';children:any[]=[];
      constructor(private aria=''){}
      getClientRects(){return [1];}getAttribute(name:string){return name==='aria-label'?this.aria:null;}
    }
    const input=Object.assign(new Element(),{innerText:mode==='draft'?'保留我的输入':''});
    const control=mode==='generating'?new Element('停止回答'):new Element('登录');
    const context=vm.createContext({HTMLElement:Element,location:{pathname:'/app'},
      document:{querySelector:()=>['ready','generating'].includes(mode)?input:null,
        querySelectorAll:(selector:string)=>selector==='button'?(['login','generating'].includes(mode)?[control]:[]):selector==='textarea,input'?(mode==='draft'?[Object.assign(new Element(),{value:'保留我的输入'})]:[]):selector==='user-query,model-response'?(mode==='history'?[{}]:[]):[]},
      chrome:{runtime:{onMessage:{addListener(){}}}}});
    vm.runInContext(readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
      .replace('setInterval(ready,3000);void ready();','globalThis.statusForTest=status;'),context);
    const status=vm.runInContext('statusForTest()',context);
    assert.equal(status.empty_shell,mode==='shell',mode);assert.equal(status.ready,mode==='ready',mode);
    assert.equal(status.has_draft,mode==='draft',mode);assert.equal(status.generating,mode==='generating',mode);
  }
});

test('only an idle empty shell is refreshed, with a cooldown and a bounded retry count',async()=>{
  const worker=conversationWorker();worker.setPageStatus({ready:false,empty_shell:true});
  await worker.tick();assert.equal(worker.reloadUrls.length,0);
  for(let i=0;i<2;i++){
    worker.state.shell_since=Date.now()-31_000;await worker.tick();assert.equal(worker.reloadUrls.length,i+1);
    await worker.tick();assert.equal(worker.reloadUrls.length,i+1);
  }
  worker.state.shell_since=Date.now()-31_000;await worker.tick();assert.equal(worker.reloadUrls.length,2);
  assert.equal(worker.calls.some(c=>c.path==='/claim'),false);
  assert(worker.reloadOptions.every(o=>o.bypassCache===true));
  worker.setPageStatus({ready:false,empty_shell:false});await worker.tick();assert.equal(worker.state.shell_since,undefined);
  assert.equal(worker.reloadUrls.length,2);
});

test('navigation failures retry before dispatch, with a limit and no lost result acknowledgement',async()=>{
  const {randomUUID}=await import('node:crypto'),worker=conversationWorker();
  const task={id:randomUUID(),session_id:randomUUID(),prompt:'画图',expires:Date.now()+60_000};
  worker.tasks.push(task);worker.failNavigation(true);await worker.tick();
  assert.equal(worker.state.active.phase,'loading');assert.equal(worker.state.active.load_attempts,1);
  await worker.tick();assert.equal(worker.state.active.load_attempts,1);
  worker.failNavigation(false);worker.allowNavigationRetry();await worker.tick();
  assert.equal((await worker.ready()).task.id,task.id);
  const failed=conversationWorker();failed.tasks.push({...task,id:randomUUID()});failed.failNavigation(true);await failed.tick();
  for(let i=0;i<2;i++){failed.allowNavigationRetry();await failed.tick();}
  failed.failResult(true);failed.allowNavigationRetry();await failed.tick();assert.equal(failed.state.active.load_attempts,3);
  failed.failResult(false);await failed.tick();assert.equal(failed.state.active,undefined);
  assert.equal(failed.calls.at(-1)?.body.error,'page_changed');
  const diagnostic=failed.calls.filter(call=>call.path==='/navigation-failure'&&call.body.message.startsWith('navigation_not_ready ')).at(-1)!;
  assert.equal(diagnostic.body.stage,'update');
  const detail=JSON.parse(diagnostic.body.message.slice('navigation_not_ready '.length));
  assert.equal(detail.destination,'landing');assert.equal(detail.attempts,3);
  assert.equal(detail.same_document,true);assert.equal(detail.ready,true);
  assert.doesNotMatch(diagnostic.body.message,/https?:|画图|[a-f0-9]{8}-[a-f0-9-]{27}/);
  assert(diagnostic.body.message.length<=240);
});

test('a missing tab after dispatch fails once instead of generating the same image again',async()=>{
  const {randomUUID}=await import('node:crypto');
  for(const started of [false,true]){
    const worker=conversationWorker(),task={id:randomUUID(),session_id:randomUUID(),prompt:'画图',expires:Date.now()+60_000};
    worker.tasks.push(task);await worker.tick();await worker.ready();if(started)await worker.started(task.id);
    worker.restoreTab();await worker.tick();assert.equal(worker.state.active,undefined);
    assert.equal(worker.navigations.length+worker.reloadUrls.length,1);assert.equal(worker.calls.at(-1)?.body.error,'browser_restarted');
  }
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

test('reset visits only retired session URLs, preserves another user, then creates and binds the new conversation',async()=>{
 const {randomUUID}=await import('node:crypto');
 const old=randomUUID(),other=randomUUID(),fresh=randomUUID();
 const oldUrl='https://gemini.google.com/app/old',otherUrl='https://gemini.google.com/app/other';
 const worker=conversationWorker({tabId:17,conversations:{[old]:oldUrl,[other]:otherUrl}});
 const task={id:randomUUID(),session_id:fresh,operation:'reset',conversation_title:'wxid_alice的对话',retired_sessions:[old],prompt:'prepare',expires:Date.now()+60_000};
 worker.tasks.push(task);await worker.tick();
 assert.equal(worker.state.active.operation,'delete');assert.equal(worker.navigations.at(-1),oldUrl+'#nila-image-worker-'+task.id);
 await worker.ready();await worker.started(task.id);await worker.deleted(task.id);
 assert.equal(worker.state.conversations[old],undefined);assert.equal(worker.state.conversations[other],otherUrl);
 assert.equal(worker.state.active.operation,'reset');assert.equal(worker.calls.filter(c=>c.path==='/result').length,0);
 const ready=await worker.ready();assert.equal(ready.task.conversation_title,'wxid_alice的对话');
 await worker.started(task.id);await worker.bound(task.id,'https://gemini.google.com/app/fresh');
 assert.equal(worker.state.conversations[fresh],'https://gemini.google.com/app/fresh');
 await worker.resetDone(task.id,'https://gemini.google.com/app/fresh');await worker.settle();
 assert.equal(worker.calls.find(c=>c.path==='/result')!.body.reset_complete,true);
 assert.equal(worker.state.active,undefined);
});

test('reset accepts an explicitly cleared deleted page, but an unchanged URL alone cannot retire a session',async()=>{
 const {randomUUID}=await import('node:crypto'),old=randomUUID(),other=randomUUID(),fresh=randomUUID();
 const url='https://gemini.google.com/app/old',otherUrl='https://gemini.google.com/app/other';
 const worker=conversationWorker({tabId:17,conversations:{[old]:url,[other]:otherUrl}});
 const task={id:randomUUID(),session_id:fresh,operation:'reset',conversation_title:'A的对话',retired_sessions:[old],prompt:'prepare',expires:Date.now()+60_000};
 worker.tasks.push(task);await worker.tick();await worker.ready();await worker.started(task.id);
 assert.equal((await worker.deleted(task.id,false)).error,'deletion_not_confirmed');
 assert.equal(worker.state.conversations[old],url);assert.equal(worker.state.active.operation,'delete');
 await worker.deleted(task.id,true);
 assert.equal(worker.state.conversations[old],undefined);assert.equal(worker.state.conversations[other],otherUrl);
 assert.equal(worker.state.active.operation,'reset');
 assert.equal(worker.navigations.at(-1),'https://gemini.google.com/app#nila-image-worker-'+task.id);
});

test('a conversation also owned by a different session cannot be deleted',async()=>{
 const {randomUUID}=await import('node:crypto'),old=randomUUID(),other=randomUUID();
 const worker=conversationWorker({tabId:17,conversations:{[old]:'https://gemini.google.com/app/shared',[other]:'https://gemini.google.com/app/shared'}});
 worker.tasks.push({id:randomUUID(),session_id:randomUUID(),operation:'reset',conversation_title:'A的对话',retired_sessions:[old],prompt:'prepare',expires:Date.now()+60_000});
 await worker.tick();assert.equal(worker.navigations.length,0);
 assert.equal(worker.calls.find(c=>c.path==='/result')!.body.error,'conversation_conflict');
 assert.equal(worker.state.conversations[other],'https://gemini.google.com/app/shared');
});

test('conversation binding is saved before generation completes and rejects a different conversation',async()=>{
 const {randomUUID}=await import('node:crypto'),worker=conversationWorker();
 const task={id:randomUUID(),session_id:randomUUID(),prompt:'draw',expires:Date.now()+60_000};
 worker.tasks.push(task);await worker.tick();await worker.ready();await worker.started(task.id);
 assert.equal((await worker.bound(task.id,'https://gemini.google.com/app/first')).ok,true);
 assert.equal((await worker.bound(task.id,'https://gemini.google.com/app/unrelated')).ignored,true);
 assert.equal(worker.state.conversations[task.session_id],'https://gemini.google.com/app/first');
});

test('new conversation binding waits for Chrome tab metadata and preserves a submitted conversation after failure',async()=>{
 const {randomUUID}=await import('node:crypto'),worker=conversationWorker();
 const task={id:randomUUID(),session_id:randomUUID(),prompt:'draw',expires:Date.now()+60_000};
 worker.tasks.push(task);await worker.tick();await worker.ready();await worker.started(task.id);
 assert.equal((await worker.boundBeforeTabUpdate(task.id,'https://gemini.google.com/app/new')).pending,true);
 assert.equal(worker.state.conversations,undefined);
 await worker.failedAfterSubmission(task.id,'https://gemini.google.com/app/new');await worker.settle();
 assert.equal((worker.state as Record<string,any>).conversations[task.session_id],'https://gemini.google.com/app/new');
 assert.equal(worker.calls.find(c=>c.path==='/result')!.body.error,'page_changed');
});

function imageDownloader(fetcher:typeof fetch){
 const context=vm.createContext({Date,Math,URL,Blob,AbortSignal,fetch:fetcher,
  setTimeout:(fn:()=>void)=>{queueMicrotask(fn);return 0;},
  chrome:{runtime:{onMessage:{addListener(){}}}}});
 const source=readFileSync(new URL('../apps/gemini-extension/page.js',import.meta.url),'utf8')
  .replace('setInterval(ready,3000);void ready();','globalThis.downloadForTest=downloadImage;');
 vm.runInContext(source,context);return (context as any).downloadForTest;
}

test('image downloads carry browser credentials and retry the asset without resubmitting a prompt',async()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
 const calls:{url:string;credentials:unknown}[]=[];
 const download=imageDownloader(async(url,options)=>{
  calls.push({url:String(url),credentials:options?.credentials});
  if(calls.length===1)return new Response('Forbidden',{status:403});
  return new Response(bytes,{headers:{'content-type':'image/png; charset=binary'}});
 });
 const asset={src:'https://lh3.googleusercontent.com/gg-dl/current'};
 const blob=await download(()=>asset,new AbortController().signal,Date.now()+60_000);
 assert.deepEqual(Buffer.from(await blob.arrayBuffer()),bytes);
 assert.equal(blob.type,'image/png');assert.equal(calls.length,2);
 assert(calls.every(c=>c.credentials==='include'&&c.url===asset.src));
});

test('failed asset downloads are bounded, retain HTTP status and never accept an HTML error page',async()=>{
 let calls=0;
 const forbidden=imageDownloader(async()=>{calls++;return new Response('Forbidden',{status:403});});
 const asset=()=>({src:'https://lh3.googleusercontent.com/gg-dl/current'});
 await assert.rejects(forbidden(asset,new AbortController().signal,Date.now()+60_000),(e:any)=>e.message==='download_failed'&&e.download_status===403);
 assert.equal(calls,3);
 const html=imageDownloader(async()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}}));
 await assert.rejects(html(asset,new AbortController().signal,Date.now()+60_000),/download_failed/);
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(forbidden(asset,cancelled.signal,Date.now()+60_000),/cancelled/);assert.equal(calls,3);
 await assert.rejects(forbidden(()=>({src:'https://unrelated.example/image'}),new AbortController().signal,Date.now()+60_000),/page_changed/);assert.equal(calls,3);
});

test('image downloads reject oversized responses before consuming their payload',async()=>{
 const download=imageDownloader(async()=>new Response('not read',{headers:{'content-type':'image/jpeg','content-length':String(8*1024*1024+1)}}));
 await assert.rejects(download(()=>({src:'https://lh3.googleusercontent.com/gg-dl/current'}),new AbortController().signal,Date.now()+60_000),/download_failed/);
});
