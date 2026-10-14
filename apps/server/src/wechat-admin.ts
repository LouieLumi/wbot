import {createHash,timingSafeEqual} from 'node:crypto';
import type {Config} from './config.js';
import type {Store} from './store.js';
import type {DeviceAdapter,Message} from '../../../packages/shared/types.js';

/** One bot-wide administrator: pin the sender ID once, independent of chat ID. */
export class WechatAdmin {
  private username='';private checkedAt=0;private pending:Promise<void>|undefined;
  constructor(private config:Config,private store:Store){
    try{const saved=JSON.parse(store.get('wechat_admin_binding')??'null');
      if(saved?.wechat_id===config.WECHAT_ADMIN_ID&&typeof saved?.username==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(saved.username))this.username=saved.username;
    }catch{}
  }
  get state(){return {wechat_id:this.config.WECHAT_ADMIN_ID,bound:Boolean(this.username)};}
  async resolve(driver:DeviceAdapter){
    if(this.config.WECHAT_DEVICE_MODE!=='android_hook'||!this.config.WECHAT_ADMIN_ID||this.username||!driver.resolveAccount)return;
    if(this.pending)return this.pending;
    if(Date.now()-this.checkedAt<60_000)return;
    this.checkedAt=Date.now();
    this.pending=(async()=>{
      try{
        const username=await driver.resolveAccount!(this.config.WECHAT_ADMIN_ID);
        if(this.username||!username||!/^[A-Za-z0-9_.-]{1,128}$/.test(username))return;
        this.store.set('wechat_admin_binding',JSON.stringify({wechat_id:this.config.WECHAT_ADMIN_ID,username,verified_at:Date.now()}));this.username=username;
      }catch{/* No identity evidence means no administrator permissions. */}
    })().finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  allows(message:Message){
    return this.config.WECHAT_DEVICE_MODE==='android_hook'&&!!this.username&&message.own===false&&message.sender_wxid===this.username&&
      message.member_id==='wxid:'+createHash('sha256').update(this.username).digest('hex');
  }
  verify(message:Message,code:string){
    if(this.username||!this.config.WECHAT_ADMIN_ID||this.config.WECHAT_DEVICE_MODE!=='android_hook'||message.own!==false||message.chat_type!=='group'||!message.sender_wxid||!/^[A-Za-z0-9_.-]{1,128}$/.test(message.sender_wxid))return false;
    if(message.member_id!=='wxid:'+createHash('sha256').update(message.sender_wxid).digest('hex'))return false;
    let challenge;try{challenge=JSON.parse(this.store.get('wechat_admin_challenge')??'null');}catch{return false;}
    if(!challenge||challenge.wechat_id!==this.config.WECHAT_ADMIN_ID||challenge.chat_id!==message.chat_id||!Number.isFinite(challenge.created_at)||!Number.isFinite(challenge.expires_at)||Date.now()>challenge.expires_at||message.timestamp<challenge.created_at||message.timestamp>Date.now()+60_000||!/^[a-f0-9]{64}$/.test(challenge.code_hash))return false;
    if(!timingSafeEqual(Buffer.from(challenge.code_hash,'hex'),createHash('sha256').update(code).digest()))return false;
    this.store.db.exec('BEGIN IMMEDIATE');try{
      this.store.set('wechat_admin_binding',JSON.stringify({wechat_id:this.config.WECHAT_ADMIN_ID,username:message.sender_wxid,verified_at:Date.now(),method:'private_one_time_challenge',message_id:message.message_id}));
      this.store.db.prepare("DELETE FROM settings WHERE key='wechat_admin_challenge'").run();this.store.db.exec('COMMIT');
      this.username=message.sender_wxid;return true;
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
}
