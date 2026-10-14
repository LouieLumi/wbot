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
  private replyChain:Promise<void>=Promise.resolve();private pendingReplies=0;private pendingChats=new Set<string>();
  private imageChain:Promise<void>=Promise.resolve();
  private imageRequests=new Map<string,{member:Member;session:string;controller:AbortController}>();
  private commandChain:Promise<void>=Promise.resolve();private pendingCommands=0;private lastCommand=new Map<string,number>();
  readonly wechatAdmin:WechatAdmin;
  private lastReply=new Map<string,number>();private abort=new AbortController();private closed=false;
  paused:boolean;autoReply:boolean;lastReliability='not_started';lastError:string|null=null;activeChat:string|null=null;
  constructor(readonly config:Config,readonly driver:DeviceAdapter,readonly store:Store,private responder:Responder,
    readonly memory=new Memories(store),readonly models=new Models(config,store),private images:ImageGenerator=new GeminiImages(config)){
    super();this.wechatAdmin=new WechatAdmin(config,store);this.paused=store.get('paused')!=='false';this.autoReply=store.get('auto_reply')?store.get('auto_reply')==='true':config.WECHAT_AUTO_REPLY;
  }
  emitEvent(event:Record<string,unknown>){this.emit('event',event);}
  get deviceBusy(){return this.busy;}
  imageStatus(){return this.images.status?.()??{provider:'proxy',model:this.config.IMAGE_MODEL};}
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
    await this.driver.setAuthorized?.(groups.filter(g=>g.enabled&&g.verified).map(g=>g.id));
    await this.wechatAdmin.resolve(this.driver);
    return groups;
  }
  async groupPatch(id:string,patch:{enabled?:boolean;model?:string;paused?:boolean}){
    this.memory.groupPatch(id,patch);this.cancelStaleImages();
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
    const pattern=new RegExp('(^|\\s)@'+this.config.WECHAT_BOT_NAME.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=\\s|$)');
    const mentioned=this.config.WECHAT_REPLY_MODE==='text_mention'&&pattern.test(content);
    const text=mentioned?content.replace(pattern,' ').trim():content.trim();const isCommand=text.startsWith('/');
    return mention==='verified'||mentioned||isCommand?{text,isCommand}:null;
  }
  start(){this.timer=setInterval(()=>void this.tick(),this.config.WECHAT_POLL_MS);this.timer.unref();}
  async tick(){
    if(this.busy||this.paused||this.closed)return;this.busy=true;let target:Chat|undefined;
    try{
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
          const image=this.store.image(job.id);
          const result=image===undefined?await this.driver.send(chat,job.content,job.id):
            image&&this.driver.sendImage?await this.driver.sendImage(chat,image,job.id):{state:'failed' as const,reason:'image_transport_unavailable'};
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
    finally{this.busy=false;}
  }
  receive(message:Message){
    if(this.paused||!this.autoReply||message.own!==false||!this.isAllowed(message.chat_id)||message.chat_type!=='group')return;
    const trigger=this.trigger(message.content,message.mention);if(!trigger)return;
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
      const key=message.chat_id+':'+member.id;
      if(this.pendingCommands>=10||(!admin&&Date.now()-(this.lastCommand.get(key)??0)<2000)||!this.store.once(message.message_id))return;
      this.lastCommand.set(key,Date.now());this.pendingCommands++;const signal=this.abort.signal;
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
    if(!this.store.once(message.message_id)||this.pendingReplies>=10||this.pendingChats.has(message.chat_id)||(Date.now()-(this.lastReply.get(message.chat_id)??0)<(isCommand?2000:10_000)))return;
    this.pendingReplies++;this.pendingChats.add(message.chat_id);const signal=this.abort.signal;
    const run=async()=>{
      if(signal.aborted||this.paused||!this.autoReply||!this.isAllowed(message.chat_id)||this.memory.group(message.chat_id)?.paused)return;
      try{
        const current=this.memory.member(message.chat_id,member.id);if(!current||current.revision!==member.revision)return;
        let answer=await this.responder.reply({...message,content:text,member_id:member.id},signal);
        if(signal.aborted||this.paused||!this.autoReply||!this.isAllowed(message.chat_id))return;
        if(!isCommand&&this.memory.member(message.chat_id,member.id)?.revision!==member.revision)return;
        const limit=this.config.WECHAT_DEVICE_MODE==='android_hook'?2000:100;
        if(answer.length>limit)answer=answer.slice(0,limit-9)+'…（已截短）';
        const job=await this.enqueue(message.chat_id,answer,'reply:'+message.message_id);
        if(!isCommand)this.memory.stage(job.id,member,text,answer);
        this.lastReply.set(message.chat_id,Date.now());
      }catch(e){
        const reason=e instanceof ImageGenerationError?e.reason:e instanceof Error&&e.message==='model_not_installed'?'model_not_installed':'agent_unavailable_or_not_configured';
        if(imageCommand)this.store.set('last_image_error',JSON.stringify({at:Date.now(),chat_id:message.chat_id,message_id:message.message_id,reason,http_status:e instanceof ImageGenerationError?e.httpStatus:undefined,retry_at:e instanceof ImageGenerationError?e.retryAt:undefined}));
        this.emitEvent({event:'reply.failed',message_id:message.message_id,reason});
        if(isCommand&&!signal.aborted&&!this.paused&&this.isAllowed(message.chat_id)&&!this.memory.group(message.chat_id)?.paused&&this.memory.member(message.chat_id,member.id)?.revision===member.revision)await this.enqueue(message.chat_id,imageCommand?imageErrorReply(e):'命令暂未完成，请稍后重试。','error:'+message.message_id).catch(()=>{});
      }
    };
    this.replyChain=this.replyChain.then(run).finally(()=>{this.pendingReplies--;this.pendingChats.delete(message.chat_id);});
  }
  private imageCurrent(member:Member,session:string){
    const current=this.memory.member(member.chat_id,member.id);
    return !this.paused&&this.autoReply&&this.isAllowed(member.chat_id)&&!this.memory.group(member.chat_id)?.paused&&
      current?.enabled&&current.revision===member.revision&&this.memory.imageSession(member.chat_id,member.id)===session;
  }
  private cancelStaleImages(){for(const task of this.imageRequests.values())if(!this.imageCurrent(task.member,task.session))task.controller.abort();}
  private queueImage(message:Message,member:Member,prompt:string){
    if(!this.store.once(message.message_id))return;
    if(this.imageRequests.size>=10){this.store.enqueue(message.chat_id,member.name+'，生图队列已满，请稍后重试。','error:'+message.message_id);return;}
    const session=this.memory.imageSession(member.chat_id,member.id),controller=new AbortController();
    const signal=AbortSignal.any([this.abort.signal,controller.signal]);
    const progress=this.store.enqueue(message.chat_id,member.name+(this.imageRequests.size?'，已加入生图队列。':'，正在生成图片，请稍候。'),'progress:'+message.message_id);
    this.memory.trackImageJob(progress.id,member,session);
    this.imageRequests.set(message.message_id,{member,session,controller});
    this.imageChain=this.imageChain.then(async()=>{
      if(signal.aborted||!this.imageCurrent(member,session))return;
      try{
        if(!this.driver.sendImage)throw new Error('image_transport_unavailable');
        const image=await this.images.generate(prompt,signal,session);
        if(signal.aborted||!this.imageCurrent(member,session))return;
        await this.allowedChat(message.chat_id);
        if(signal.aborted||!this.imageCurrent(member,session))return;
        this.store.enqueueImage(message.chat_id,prompt,image,'reply:'+message.message_id,job=>{
          this.memory.stage(job.id,member,'/img '+prompt,'[已生成图片]');this.memory.trackImageJob(job.id,member,session);
        });
      }catch(e){
        if(signal.aborted||!this.imageCurrent(member,session))return;
        const reason=e instanceof ImageGenerationError?e.reason:'image_generation_failed';
        this.store.set('last_image_error',JSON.stringify({at:Date.now(),chat_id:message.chat_id,message_id:message.message_id,reason,http_status:e instanceof ImageGenerationError?e.httpStatus:undefined,retry_at:e instanceof ImageGenerationError?e.retryAt:undefined}));
        this.emitEvent({event:'reply.failed',message_id:message.message_id,reason});
        const job=this.store.enqueue(message.chat_id,imageErrorReply(e),'error:'+message.message_id);
        this.memory.trackImageJob(job.id,member,session);
      }
    }).finally(()=>{this.imageRequests.delete(message.message_id);});
  }
  async repliesIdle(){await Promise.all([this.replyChain,this.imageChain,this.commandChain]);}
  async close(){this.closed=true;clearInterval(this.timer);this.abort.abort();await this.repliesIdle();while(this.busy)await new Promise(r=>setTimeout(r,20));await this.driver.close?.();}
}
