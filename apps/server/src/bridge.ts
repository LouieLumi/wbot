import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {Chat,DeviceAdapter,Message,Row,Snapshot} from '../../../packages/shared/types.js';
import type {Config} from './config.js';
import {Store} from './store.js';
import type {Responder} from './openclaw.js';
import {Memories,type Member} from './memory.js';
import {Models} from './models.js';
import {command} from './commands.js';
import {hostLocked} from './power.js';
import {GeminiImages,ImageGenerationError,imageErrorReply,type ImageGenerator} from './images.js';
import {WechatAdmin} from './wechat-admin.js';
import {ImageQueue,type ImageRequest} from './image-queue.js';
import {GroupMemory} from './group-memory.js';
import {ReplyQueue,type ReplyRequest} from './reply-queue.js';
import {memberMemoryKey} from './hermes-memory.js';
import {LocalVoice,speakable,type VoiceGenerator} from './voice.js';
import {isBotReply} from './reply-context.js';

export class WindowTracker {
  private previous:Snapshot|null=null;
  private observedAt=0;
  advance(snapshot:Snapshot,now=Date.now()):{rows:Row[];gap:boolean}{
    // Preserve progress through a short transport failure, but never replay
    // an arbitrarily old window after a long outage.
    const old=now-this.observedAt<=180_000?this.previous:null;this.previous=snapshot;this.observedAt=now;
    if(!snapshot.chat||!old?.chat||old.chat.id!==snapshot.chat.id)return {rows:[],gap:false};
    const a=old.rows,b=snapshot.rows;
    if(a.length&&!b.length){this.previous=null;return {rows:[],gap:true};}
    if(!a.length)return {rows:b,gap:false};
    for(let n=Math.min(a.length,b.length);n>0;n--)if(a.slice(-n).every((r,i)=>r.key===b[i]?.key))return {rows:b.slice(n),gap:false};
    return {rows:[],gap:true};
  }
  reset(){this.previous=null;this.observedAt=0;}
}
export class Bridge extends EventEmitter {
  private busy=false;private timer:NodeJS.Timeout|undefined;private trackers=new Map<string,WindowTracker>();private eventTrackers=new Map<string,WindowTracker>();private cursor=0;
  private replyRequests=new Map<string,Promise<void>>();private replyOwners=new Set<string>();private historyCursor=0;
  private voiceBusy=false;
  private imageChain:Promise<void>=Promise.resolve();
  private imageRequests=new Map<string,{member:Member;session:string;controller:AbortController;maintenance:boolean}>();
  private commandChain:Promise<void>=Promise.resolve();private pendingCommands=0;
  readonly wechatAdmin:WechatAdmin;
  readonly groupMemory:GroupMemory;
  readonly imageQueue:ImageQueue;private imageQueueRecovered=false;
  readonly replyQueue:ReplyQueue;
  private abort=new AbortController();private closed=false;
  paused:boolean;autoReply:boolean;lastReliability='not_started';lastError:string|null=null;activeChat:string|null=null;
  constructor(readonly config:Config,readonly driver:DeviceAdapter,readonly store:Store,private responder:Responder,
    readonly memory=new Memories(store),readonly models=new Models(config,store),private images:ImageGenerator=new GeminiImages(config),private voices:VoiceGenerator=new LocalVoice(config)){
    super();this.groupMemory=new GroupMemory(store);this.imageQueue=new ImageQueue(store);this.replyQueue=new ReplyQueue(store);this.wechatAdmin=new WechatAdmin(config,store);this.paused=store.get('paused')!=='false';this.autoReply=store.get('auto_reply')?store.get('auto_reply')==='true':config.WECHAT_AUTO_REPLY;
  }
  emitEvent(event:Record<string,unknown>){this.emit('event',event);}
  get deviceBusy(){return this.busy;}
  imageStatus(){return {...(this.images.status?.()??{provider:'proxy',model:this.config.IMAGE_MODEL}) as object,queue:this.imageQueue.status()};}
  voiceStatus(){return this.voices.status?.()??{enabled:this.config.VOICE_ENABLED};}
  replyStatus(){return {active:this.replyRequests.size,pending:this.replyQueue.count(),queue:this.replyQueue.status()};}
  async deviceIdle(){while(this.busy)await new Promise(r=>setTimeout(r,25));}
  control(paused:boolean,autoReply?:boolean){
    if(paused||autoReply===false){this.abort.abort();this.abort=new AbortController();}
    if(paused){this.trackers.clear();this.eventTrackers.clear();this.driver.resetEvents?.();}
    this.paused=paused;this.store.set('paused',String(paused));
    if(autoReply!==undefined){this.autoReply=autoReply;this.store.set('auto_reply',String(autoReply));}
    this.emitEvent({event:'control.changed',paused:this.paused,auto_reply:this.autoReply});
  }
  async groups(){
    this.memory.sync(await this.driver.chats(),this.config.WECHAT_ALLOWED_CHAT_IDS);
    const groups=this.memory.groups();
    // Authorization persists through transport loss; an offline group must not
    // reset its capture start and discard the unsynchronized interval.
    this.groupMemory.authorize(groups.filter(g=>g.enabled).map(g=>g.id));
    await this.driver.setAuthorized?.(groups.filter(g=>g.enabled&&g.verified).map(g=>g.id));
    await this.wechatAdmin.resolve(this.driver);
    if(!this.imageQueueRecovered&&!this.paused&&this.autoReply){
      this.imageQueueRecovered=true;
      for(const request of this.imageQueue.waiting())this.scheduleImage(request);
    }
    if(!this.paused&&this.autoReply){
      for(const request of this.replyQueue.interrupted()){
        const member=this.memory.member(request.chat_id,request.member_id);
        this.store.db.exec('BEGIN IMMEDIATE');try{
          if(member&&this.replyCurrent(request))this.store.enqueue(request.chat_id,member.name+'，上一条回复因服务重启中断，请重新发送。','error:'+request.id);
          this.replyQueue.update(request.id,'failed','interrupted_during_generation_notified');this.store.db.exec('COMMIT');
        }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      }
      this.scheduleReplies();
    }
    return groups;
  }
  async groupPatch(id:string,patch:{enabled?:boolean;model?:string;paused?:boolean}){
    this.memory.groupPatch(id,patch);this.cancelStaleImages();
    this.groupMemory.authorize(this.memory.groups().filter(g=>g.enabled).map(g=>g.id));
    // Persist first; a phone reconnect will reapply the current permissions.
    await this.groups();
  }
  isAllowed(id:string){const group=this.memory.group(id);return group?group.enabled&&group.verified:this.config.WECHAT_ALLOWED_CHAT_IDS.includes(id);}
  async allowedChat(id:string):Promise<Chat>{const chat=(await this.groups()).find(c=>c.id===id);if(!chat?.enabled)throw new Error('chat_not_allowed');if(!chat.verified)throw new Error('chat_not_verified');return chat;}
  async register(name:string){
    if(!this.paused)throw new Error('pause_before_registration');if(this.busy)throw new Error('device_busy');if(!this.driver.register)throw new Error('registration_unavailable');
    this.busy=true;try{const chat=await this.driver.register(name);await this.groups();this.memory.groupPatch(chat.id,{enabled:true});return chat;}finally{this.busy=false;}
  }
  async enqueue(id:string,content:string,idem?:string){await this.allowedChat(id);return this.store.enqueue(id,content,idem);}
  private trigger(content:string,mention:Row['mention']):{text:string;isCommand:boolean}|null{
    // Keep the previous account nickname usable during the Gemini rename.
    const names=this.config.WECHAT_BOT_NAME==='Gemini'?['Gemini','Nila']:[this.config.WECHAT_BOT_NAME];
    const pattern=new RegExp('(^|\\s)@(?:'+names.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')(?=\\s|$)','i');
    const mentioned=this.config.WECHAT_REPLY_MODE==='text_mention'&&pattern.test(content);
    const text=mentioned?content.replace(pattern,' ').trim():content.trim();const isCommand=text.startsWith('/');
    return mention==='verified'||mentioned||isCommand?{text,isCommand}:null;
  }
  start(){this.timer=setInterval(()=>void this.tick(),this.config.WECHAT_POLL_MS);this.timer.unref();}
  async tick(){
    if(this.busy||this.paused||this.closed)return;this.busy=true;let target:Chat|undefined;
    try{
      for(const id of this.memory.reconcile())this.emitEvent({event:'memory.sync_failed',id});
      const lockedBefore=this.config.WECHAT_DEVICE_MODE==='adb'?await hostLocked():null;
      const job=this.store.next();
      if(job){
        const signup=this.memory.signupForJob(job.id);
        if(signup){
          if(!this.driver.acknowledgeSignup||job.chat_id!==signup.chat_id||job.content!=='已发起使用请求'){
            this.store.update(job.id,'failed','invalid_signup_acknowledgement');return;
          }
          this.store.update(job.id,'running');
          try{const result=await this.driver.acknowledgeSignup(signup);this.store.update(job.id,result.state,result.reason);}
          catch{this.store.update(job.id,'uncertain','device_error_no_automatic_retry');}
          const finished=this.store.job(job.id)!;this.emitEvent({event:'job.updated',id:job.id,state:finished.state,reason:finished.reason});
        }else{
        let chat:Chat;
        try{chat=await this.allowedChat(job.chat_id);if(!this.memory.valid(job.id))throw new Error('memory_changed');}
        catch{this.store.update(job.id,'failed','chat_or_memory_no_longer_authorized');this.memory.complete(job.id,false);return;}
        if(this.paused||this.store.job(job.id)?.state!=='queued')return;
        this.store.update(job.id,'running');this.emitEvent({event:'job.updated',id:job.id,state:'running'});
        try{
          const image=this.store.image(job.id),voice=this.store.voice(job.id);
          let result=voice!==undefined?(voice&&this.driver.sendVoice?await this.driver.sendVoice(chat,voice,job.id):{state:'failed' as const,reason:'voice_transport_unavailable'}):image===undefined?await this.driver.send(chat,job.content,job.id):
            image&&this.driver.sendImage?await this.driver.sendImage(chat,image,job.id):{state:'failed' as const,reason:'image_transport_unavailable'};
          if(voice&&result.state==='failed'&&['voice_preflight_failed','wechat_voice_failed'].includes(result.reason)&&
            !this.paused&&this.autoReply&&this.isAllowed(job.chat_id)&&!this.memory.group(job.chat_id)?.paused&&this.memory.valid(job.id)){
            this.emitEvent({event:'voice.fallback',job_id:job.id,reason:result.reason});
            result=await this.driver.send(chat,job.content,'voice-fallback:'+job.id);
            if(result.state==='sent')result={...result,reason:'wechat_server_ack_text_fallback'};
          }
          this.store.update(job.id,result.state,result.reason);
        }
        catch{this.store.update(job.id,'uncertain','device_error_no_automatic_retry');}
        const finished=this.store.job(job.id)!;this.memory.complete(job.id,finished.state==='sent');
        if(this.store.image(job.id)!==undefined&&finished.state!=='sent'&&this.isAllowed(job.chat_id)){
          this.store.enqueue(job.chat_id,finished.state==='uncertain'?'图片发送结果未确认，请先查看群里是否收到。':'图片发送失败，请稍后重试。','image-error:'+job.id);
        }
        if(finished.state==='sent'&&lockedBefore===true&&await hostLocked()===true)this.store.set('lock_send_verified_at',String(Date.now()));
        this.emitEvent({event:'job.updated',id:job.id,state:finished.state,reason:finished.reason});
        }
      }
      if(this.paused)return;
      const groups=(await this.groups()).filter(c=>c.enabled&&c.verified);
      if(this.driver.signupRequests){
        const requests=await this.driver.signupRequests();if(this.paused)return;
        for(const request of requests){const job=this.memory.requestSignup(request);if(job)this.emitEvent({event:'group.signup',chat_id:request.chat_id,job_id:job.id});}
      }
      if(this.driver.pollEvents){
        const result=await this.driver.pollEvents();if(this.paused)return;
        this.lastReliability=result.reliability;this.lastError=null;
        for(const group of groups)this.memory.observed(group.id);
        for(const event of result.messages){
          const group=groups.find(g=>g.id===event.chat_id);if(!group||!event.sender_wxid||!event.sender)continue;
          const member=this.memory.identifyWechat(group.id,event.sender_wxid,event.sender);
          const message={...event,chat_name:group.name,member_id:member.id};
          this.activeChat=group.id;this.memory.observed(group.id,'',true);
          this.emitEvent({...message,mentioned_me:false});this.receive(message);
        }
        // Receive live requests first. Archive one group page per tick so slow
        // history reads in many groups cannot starve the phone's event buffer.
        if(this.driver.groupHistory&&groups.length){
          const group=groups[this.historyCursor++%groups.length]!,state=this.groupMemory.state(group.id);
          if(state?.enabled)try{
            const history=await this.driver.groupHistory(group.id,state.since,state.cursor,state.source);
            if(!this.paused&&this.isAllowed(group.id))this.groupMemory.accept(group.id,history);
          }catch{this.groupMemory.failed(group.id);}
        }
        return;
      }
      if(!groups.length){this.lastReliability='no_authorized_groups';return;}
      target=groups[this.cursor++%groups.length]!;this.activeChat=target.id;
      const snapshot=await this.driver.snapshot(target);if(this.paused)return;
      if(snapshot.chat?.id!==target.id){this.trackers.delete(target.id);this.eventTrackers.delete(target.id);throw new Error('target_not_visible');}
      if(lockedBefore===true&&await hostLocked()===true)this.store.set('lock_poll_verified_at',String(Date.now()));
      let tracker=this.trackers.get(target.id);if(!tracker){tracker=new WindowTracker();this.trackers.set(target.id,tracker);}
      // Non-trigger text, voice bubbles, emoji and our own OCR'd replies must
      // not break overlap matching and silently consume a new @ or command.
      const triggers=snapshot.rows.filter(row=>row.own===false&&row.sender&&this.trigger(row.content,row.mention));
      const delta=tracker.advance({...snapshot,rows:triggers});this.lastError=null;
      let events=this.eventTrackers.get(target.id);if(!events){events=new WindowTracker();this.eventTrackers.set(target.id,events);}
      const eventDelta=events.advance(snapshot);
      // An earlier trigger can scroll out or disappear from OCR while an
      // outgoing bubble still anchors the full window. Either confirmed
      // overlap is sufficient; neither tracker may swallow the other's delta.
      const newTriggers=new Set([...delta.rows,...eventDelta.rows.filter(row=>triggers.includes(row))]);
      const gap=delta.gap&&eventDelta.gap;
      this.lastReliability=gap?'gap_detected_baseline_reset':snapshot.reliability;
      this.store.set('poll_diagnostic:'+target.id,JSON.stringify({at:Date.now(),visible_rows:snapshot.rows.length,trigger_rows:triggers.length,new_triggers:newTriggers.size,gap,trigger_gap:delta.gap,event_gap:eventDelta.gap}));
      if(gap)this.store.set('last_gap:'+target.id,String(Date.now()));
      this.memory.observed(target.id,gap?'visible_window_gap':'',[...eventDelta.rows,...newTriggers].some(r=>r.own===false));
      // Discover visible members without replaying their historical messages to the model.
      for(const row of snapshot.rows)if(row.own===false&&row.sender)this.memory.identify(target.id,row.sender,row.avatar_hash);
      if(this.isAllowed(target.id))for(const row of new Set([...eventDelta.rows,...newTriggers])){
        const member=row.own===false&&row.sender?this.memory.identify(target.id,row.sender,row.avatar_hash):undefined;
        const message:Message={event:'message.received',message_id:randomUUID(),chat_id:target.id,chat_name:target.name,chat_type:target.type,
          sender:row.sender,content:row.content,own:row.own,mention:row.mention,timestamp:Date.now(),...(member?{member_id:member.id,avatar_hash:row.avatar_hash}:{})};
        this.emitEvent({...message,mentioned_me:message.mention==='verified'});if(newTriggers.has(row))this.receive(message);
      }
    }catch{this.lastError='device_unavailable_or_unverified';this.lastReliability='unavailable';if(target){this.memory.observed(target.id,this.lastError);}}
    finally{this.busy=false;this.scheduleReplies();}
  }
  receive(message:Message){
    if(this.paused||!this.autoReply||message.own!==false||!this.isAllowed(message.chat_id)||message.chat_type!=='group')return;
    const quoted=this.config.WECHAT_DEVICE_MODE==='android_hook'&&isBotReply(message);
    const trigger=this.trigger(message.content,quoted?'verified':message.mention);if(!trigger)return;
    const {text,isCommand}=trigger;
    const imageCommand=/^\/img(?:\s+([\s\S]*))?$/i.exec(text);
    // Unreadable senders never share a single anonymous memory bucket.
    if(!message.sender)return;
    const member=this.config.WECHAT_DEVICE_MODE==='android_hook'&&message.sender_wxid?
      this.memory.identifyWechat(message.chat_id,message.sender_wxid,message.sender):
      message.member_id?this.memory.member(message.chat_id,message.member_id):this.memory.identify(message.chat_id,message.sender,message.avatar_hash);
    if(!member)return;
    const admin=this.wechatAdmin.allows({...message,member_id:member.id});
    // Commands stay available while this group is stopped and do not wait for generation.
    if(isCommand&&!imageCommand?.[1]?.trim()){
      if(!this.store.once(message.message_id))return;
      if(this.pendingCommands>=100){this.store.enqueue(message.chat_id,member.name+'，命令队列已满，请稍后重试。','error:'+message.message_id);return;}
      this.pendingCommands++;const signal=this.abort.signal;
      if(/^\/newimg\s*$/i.test(text)&&this.images.resetSession){
        this.pendingCommands--;
        if(this.imageQueue.count()>=10){
          this.store.enqueue(member.chat_id,'生图队列已满，请稍后重试 /newimg。','error:'+message.message_id);return;
        }
        this.memory.newImageSession(member.chat_id,member.id);this.cancelStaleImages();
        const session=this.memory.imageSession(member.chat_id,member.id);
        this.imageQueue.add({id:message.message_id,chat_id:member.chat_id,member_id:member.id,revision:member.revision,session_id:session,prompt:'',kind:'reset'});
        const progress=this.store.enqueue(member.chat_id,'正在删除你的旧生图对话并创建新对话。','progress:'+message.message_id);
        this.memory.trackImageJob(progress.id,member,session);
        this.scheduleImage(this.imageQueue.get(message.message_id)!);return;
      }
      // Reset at receipt time so a following /img in the same phone batch gets the
      // new session, while already queued requests keep their original session.
      const imageReset=/^\/newimg\s*$/i.test(text)?command(text,member,this.memory,this.models,admin):undefined;
      if(imageReset)this.cancelStaleImages();
      this.commandChain=this.commandChain.then(async()=>{
        if(signal.aborted||this.paused||!this.autoReply||!this.isAllowed(message.chat_id))return;
        try{
          const current=this.memory.member(message.chat_id,member.id);if(!current)return;
          const verification=/^\/verify\s+([0-9]{8})$/i.exec(text);
          if(verification)this.wechatAdmin.verify({...message,member_id:member.id},verification[1]!);
          const answer=await (imageReset??command(text,current,this.memory,this.models,this.wechatAdmin.allows({...message,member_id:member.id})));
          this.cancelStaleImages();
          if(!answer||signal.aborted||this.paused||!this.autoReply||!this.isAllowed(message.chat_id))return;
          await this.enqueue(message.chat_id,answer.length>2000?answer.slice(0,1990)+'…（已截短）':answer,'reply:'+message.message_id);
        }catch(e){
          if(signal.aborted||this.paused||!this.autoReply||!this.isAllowed(message.chat_id))return;
          const answer=e instanceof Error&&e.message==='model_not_installed'?'该模型不可用，请用 /models 查看可选模型。':'命令暂未完成，请稍后重试。';
          await this.enqueue(message.chat_id,answer,'error:'+message.message_id).catch(()=>{});
        }
      }).finally(()=>{this.pendingCommands--;});
      return;
    }
    if(!member.enabled||this.memory.group(message.chat_id)?.paused)return;
    if(imageCommand?.[1]?.trim()){this.queueImage(message,member,imageCommand[1].trim());return;}
    this.store.db.exec('BEGIN IMMEDIATE');try{
      if(!this.store.once(message.message_id)){this.store.db.exec('COMMIT');return;}
      const ahead=this.replyQueue.count();
      if(ahead>=100){
        this.store.enqueue(message.chat_id,member.name+'，回复队列已满，请稍后重试。','error:'+message.message_id);
      }else{
        // Persist the receipt-time choice, including turns waiting for the same
        // member's memory commit. Finishing synthesis must not switch them back.
        this.replyQueue.add({...message,content:text,member_id:member.id},member.id,member.revision,this.voiceBusy);
        if(ahead)this.store.enqueue(message.chat_id,member.name+'，消息已排队，前面还有 '+ahead+' 条。','progress:'+message.message_id);
      }
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.scheduleReplies();
  }
  async recoverQuotedReply(chat:string,id:string){
    if(this.paused||!this.autoReply||!this.driver.quotedReply)throw new Error('reply_recovery_unavailable');
    await this.allowedChat(chat);
    const message=await this.driver.quotedReply(chat,id);if(!message)throw new Error('quoted_reply_not_found');
    this.receive(message);
    return {message_id:id,accepted:Boolean(this.store.db.prepare('SELECT 1 FROM seen WHERE id=?').get(id))};
  }
  private replyCurrent(request:ReplyRequest){
    const member=this.memory.member(request.chat_id,request.member_id);
    return !this.paused&&this.autoReply&&this.isAllowed(request.chat_id)&&!this.memory.group(request.chat_id)?.paused&&
      !!member?.enabled&&member.revision===request.revision;
  }
  private scheduleReplies(){
    if(this.closed||this.paused||!this.autoReply)return;
    for(const request of this.replyQueue.waiting()){
      if(!this.replyCurrent(request)){this.replyQueue.update(request.id,'cancelled','authorization_or_memory_changed');continue;}
      const owner=memberMemoryKey(request.chat_id,request.member_id);
      // One member's next turn waits for the previous WeChat ACK and memory
      // commit, including across groups. Other members can use the free slot.
      if(this.replyRequests.size>=2)break;
      if(this.replyOwners.has(owner)||this.memory.pendingMember(request.chat_id,request.member_id))continue;
      this.replyOwners.add(owner);this.replyQueue.update(request.id,'running');
      const signal=this.abort.signal;
      const pending=Promise.resolve().then(()=>this.runReply(request,signal)).finally(()=>{
        this.replyRequests.delete(request.id);this.replyOwners.delete(owner);this.scheduleReplies();
      });
      this.replyRequests.set(request.id,pending);
    }
  }
  private async runReply(request:ReplyRequest,signal:AbortSignal){
    try{
      if(this.closed||signal.aborted||!this.replyCurrent(request))return;
      const textOnly=request.voice_blocked||this.voiceBusy||!this.config.VOICE_ENABLED||!this.driver.sendVoice;
      const generated=await this.responder.reply(request.message,signal,{voice:textOnly?'text':'prefer'});
      let answer=(typeof generated==='string'?generated:generated.content).trim();
      if(!answer)throw Error('empty_reply');
      if(this.closed||signal.aborted||!this.replyCurrent(request))return;
      const member=this.memory.member(request.chat_id,request.member_id)!;
      const limit=this.config.WECHAT_DEVICE_MODE==='android_hook'?2000:100;
      if(answer.length>limit)answer=answer.slice(0,limit-9)+'…（已截短）';
      let voice;
      if(!textOnly&&typeof generated!=='string'&&generated.voice===true&&speakable(answer)){
        // A second model may finish after the first has claimed the synthesizer.
        // Claim synchronously and never queue another voice behind it.
        if(this.voiceBusy)this.emitEvent({event:'voice.fallback',message_id:request.id,reason:'synthesis_busy_text_preserved'});
        else{
          this.voiceBusy=true;
          try{voice=await this.voices.generate(answer,signal);}
          catch{this.emitEvent({event:'voice.fallback',message_id:request.id,reason:'synthesis_unavailable_text_preserved'});}
          finally{this.voiceBusy=false;}
        }
      }
      await this.allowedChat(request.chat_id);
      if(this.closed||signal.aborted||!this.replyCurrent(request))return;
      this.store.db.exec('BEGIN IMMEDIATE');try{
        const job=this.store.enqueue(request.chat_id,answer,'reply:'+request.id);
        if(voice)this.store.attachVoice(job,voice);
        this.memory.stage(job.id,member,request.message.content,answer,typeof generated==='string'?undefined:generated.memory,isBotReply(request.message)||typeof generated!=='string'&&generated.memory_scope==='group'?'group':'member');
        this.replyQueue.update(request.id,'generated');this.store.db.exec('COMMIT');
      }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    }catch(error){
      if(this.closed||signal.aborted||!this.replyCurrent(request))return;
      const message=error instanceof Error?error.message:'';
      const reason=/timeout/i.test(message)?'reply_timeout':message==='model_not_installed'?'model_not_installed':'agent_unavailable_or_not_configured';
      const member=this.memory.member(request.chat_id,request.member_id)!;
      this.store.db.exec('BEGIN IMMEDIATE');try{
        this.store.enqueue(request.chat_id,member.name+(reason==='reply_timeout'?'，这次回复超时了，请稍后重试。':'，这次没能生成回复，请稍后重试。'),'error:'+request.id);
        this.replyQueue.update(request.id,'failed',reason);this.store.db.exec('COMMIT');
      }catch(failure){this.store.db.exec('ROLLBACK');throw failure;}
      this.emitEvent({event:'reply.failed',message_id:request.id,reason});
    }finally{
      this.store.db.prepare("UPDATE reply_requests SET state=?,reason=?,updated_at=? WHERE id=? AND state='running'")
        .run(this.closed?'uncertain':'cancelled',this.closed?'interrupted_during_generation':'authorization_or_memory_changed',Date.now(),request.id);
    }
  }
  private imageCurrent(member:Member,session:string,maintenance=false,ignoreSession=false){
    const current=this.memory.member(member.chat_id,member.id);
    return !this.paused&&this.autoReply&&this.isAllowed(member.chat_id)&&(maintenance||!this.memory.group(member.chat_id)?.paused)&&
      current?.enabled&&current.revision===member.revision&&(ignoreSession||this.memory.imageSession(member.chat_id,member.id)===session);
  }
  private cancelStaleImages(){
    // A second /newimg supersedes the first result, but must let an in-flight
    // deletion finish and save its receipt. The next reset retires that session.
    for(const task of this.imageRequests.values())
      if(!this.imageCurrent(task.member,task.session,task.maintenance,task.maintenance))task.controller.abort();
  }
  private queueImage(message:Message,member:Member,prompt:string){
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      if(!this.store.once(message.message_id)){this.store.db.exec('COMMIT');return;}
      const ahead=this.imageQueue.count();
      if(ahead>=10){this.store.enqueue(message.chat_id,member.name+'，生图队列已满，请稍后重试。','error:'+message.message_id);this.store.db.exec('COMMIT');return;}
      const session=this.memory.imageSession(member.chat_id,member.id);
      this.imageQueue.add({id:message.message_id,chat_id:member.chat_id,member_id:member.id,revision:member.revision,session_id:session,prompt});
      const progress=this.store.enqueue(message.chat_id,member.name+(ahead?'，提示词已保存，前面还有 '+ahead+' 个任务。':'，正在生成图片，请稍候。'),'progress:'+message.message_id);
      this.memory.trackImageJob(progress.id,member,session);
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
    this.scheduleImage(this.imageQueue.get(message.message_id)!);
  }
  private scheduleImage(request:ImageRequest){
    if(this.imageRequests.has(request.id))return;
    const member=this.memory.member(request.chat_id,request.member_id),session=request.session_id,maintenance=request.kind==='reset';
    if(!member||member.revision!==request.revision||!this.imageCurrent(member,session,maintenance)){
      this.imageQueue.update(request.id,'cancelled','authorization_or_session_changed');return;
    }
    const controller=new AbortController(),signal=AbortSignal.any([this.abort.signal,controller.signal]);
    this.imageRequests.set(request.id,{member,session,controller,maintenance});
    this.imageChain=this.imageChain.then(async()=>{
      // On shutdown, prompts which never reached the browser remain recoverable.
      if(this.closed)return;
      if(signal.aborted||!this.imageCurrent(member,session,maintenance)){this.imageQueue.update(request.id,'cancelled','authorization_or_session_changed');return;}
      const saved=this.imageQueue.get(request.id);if(saved?.state!=='queued')return;
      const prompt=saved.prompt;this.imageQueue.update(request.id,'running');
      try{
        const context=this.memory.imageContext(member.chat_id,member.id);
        if(saved.kind==='reset'){
          if(!this.images.resetSession)throw Error('image_reset_unavailable');
          await this.images.resetSession(session,context,signal);
          if(signal.aborted||!this.imageCurrent(member,session,true))return;
          this.memory.imageSessionReady(member.chat_id,member.id,session);
          const job=await this.enqueue(request.chat_id,'已重建生图对话「'+context.title+'」。所有群同步生效。','reply:'+request.id);
          this.memory.trackImageJob(job.id,member,session);this.imageQueue.update(request.id,'completed');return;
        }
        if(!this.driver.sendImage)throw new Error('image_transport_unavailable');
        const image=await this.images.generate(prompt,signal,session,context);
        this.memory.imageSessionReady(member.chat_id,member.id,session);
        if(signal.aborted||!this.imageCurrent(member,session,maintenance))return;
        await this.allowedChat(request.chat_id);
        if(signal.aborted||!this.imageCurrent(member,session,maintenance))return;
        this.store.enqueueImage(request.chat_id,prompt,image,'reply:'+request.id,job=>{
          this.memory.stage(job.id,member,'/img '+prompt,'[已生成图片]');this.memory.trackImageJob(job.id,member,session);
          this.imageQueue.update(request.id,'completed');
        });
      }catch(e){
        if(signal.aborted||!this.imageCurrent(member,session,maintenance))return;
        const reason=e instanceof ImageGenerationError?e.reason:'image_generation_failed';
        this.store.set('last_image_error',JSON.stringify({at:Date.now(),chat_id:request.chat_id,message_id:request.id,reason,http_status:e instanceof ImageGenerationError?e.httpStatus:undefined,retry_at:e instanceof ImageGenerationError?e.retryAt:undefined}));
        this.emitEvent({event:'reply.failed',message_id:request.id,reason});
        this.store.db.exec('BEGIN IMMEDIATE');
        try{
          const job=this.store.enqueue(request.chat_id,saved.kind==='reset'?'生图对话重建未完成，旧任务已取消。请稍后重试 /newimg。':imageErrorReply(e),'error:'+request.id);
          this.memory.trackImageJob(job.id,member,session);this.imageQueue.update(request.id,'failed',reason);
          this.store.db.exec('COMMIT');
        }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      }finally{
        if(this.imageQueue.get(request.id)?.state==='running')this.imageQueue.update(request.id,this.closed?'uncertain':'cancelled',this.closed?'interrupted_during_generation':'authorization_or_session_changed');
      }
    }).catch(()=>{this.imageQueue.update(request.id,'uncertain','queue_processing_failed');}).finally(()=>{this.imageRequests.delete(request.id);});
  }
  async repliesIdle(){
    await Promise.all([this.imageChain,this.commandChain]);
    while(this.replyRequests.size)await Promise.all([...this.replyRequests.values()]);
  }
  async close(){this.closed=true;clearInterval(this.timer);this.abort.abort();await this.repliesIdle();while(this.busy)await new Promise(r=>setTimeout(r,20));await this.driver.close?.();}
}
