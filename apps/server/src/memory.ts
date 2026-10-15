import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store.js';
import type {Chat,SignupRequest} from '../../../packages/shared/types.js';
import {memberMemoryKey,verifiedMember,type MemberMemoryBackend,type MemoryDraft} from './hermes-memory.js';

export interface Group extends Chat {enabled:boolean;paused:boolean;model:string;last_poll:number;last_message:number;error:string;signup_pending:boolean;requested_at:number}
export interface Member {chat_id:string;id:string;name:string;avatar_hash:string;notes:string;summary?:string;memory_backend?:string;memory_scope?:'member'|'group';model:string;enabled:boolean;revision:number;last_seen:number;identity:'wechat_id'|'visual'|'name_only';turn_count?:number;groups?:{id:string;name:string}[]}
export interface Turn {role:'user'|'assistant';content:string;created_at:number}
const normalized=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'');
const sameAvatar=(a:string,b:string)=>{
  if(a===b)return true;
  if(!/^[a-f0-9]{16}$/.test(a)||!/^[a-f0-9]{16}$/.test(b))return false;
  let bits=BigInt('0x'+a)^BigInt('0x'+b),count=0;
  while(bits){bits&=bits-1n;if(++count>3)return false;}return true;
};
export class Memories {
  constructor(readonly store:Store,readonly backend?:MemberMemoryBackend){
    store.db.exec(`CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,verified INTEGER NOT NULL,enabled INTEGER NOT NULL,model TEXT NOT NULL DEFAULT '',last_poll INTEGER NOT NULL DEFAULT 0,last_message INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS members(chat_id TEXT NOT NULL,id TEXT NOT NULL,name TEXT NOT NULL,avatar_hash TEXT NOT NULL,notes TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 0,last_seen INTEGER NOT NULL,PRIMARY KEY(chat_id,id));
    CREATE TABLE IF NOT EXISTS turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,member_id TEXT NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS turns_member ON turns(chat_id,member_id,seq);
    CREATE TABLE IF NOT EXISTS reply_context(job_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,member_id TEXT NOT NULL,revision INTEGER NOT NULL,user_text TEXT NOT NULL,answer TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS image_sessions(chat_id TEXT NOT NULL,member_id TEXT NOT NULL,session_id TEXT NOT NULL UNIQUE,PRIMARY KEY(chat_id,member_id));
    CREATE TABLE IF NOT EXISTS image_reply_context(job_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,member_id TEXT NOT NULL,revision INTEGER NOT NULL,session_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signup_requests(request_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,chat_name TEXT NOT NULL,requested_at INTEGER NOT NULL,job_id TEXT NOT NULL UNIQUE);`);
    const columns=new Set((store.db.prepare('PRAGMA table_info(groups)').all() as {name:string}[]).map(r=>r.name));
    if(!columns.has('signup_pending'))store.db.exec('ALTER TABLE groups ADD COLUMN signup_pending INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('requested_at'))store.db.exec('ALTER TABLE groups ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('paused'))store.db.exec('ALTER TABLE groups ADD COLUMN paused INTEGER NOT NULL DEFAULT 0');
    store.db.exec("CREATE TABLE IF NOT EXISTS member_profiles(id TEXT PRIMARY KEY,notes TEXT NOT NULL DEFAULT '')");
    const replyColumns=new Set((store.db.prepare('PRAGMA table_info(reply_context)').all() as {name:string}[]).map(r=>r.name));
    if(!replyColumns.has('memory_draft'))store.db.exec('ALTER TABLE reply_context ADD COLUMN memory_draft TEXT');
    for(const {id} of store.db.prepare("SELECT DISTINCT id FROM members WHERE id LIKE 'wxid:%'").all() as {id:string}[])this.ensureProfile('',id);
  }
  private scope(chat:string,id:string){return verifiedMember(id)?{where:'member_id=?',args:[id]}:{where:'chat_id=? AND member_id=?',args:[chat,id]};}
  private ensureProfile(chat:string,id:string){
    if(verifiedMember(id)&&!this.store.db.prepare('SELECT 1 FROM member_profiles WHERE id=?').get(id)){
      const notes=[...new Set((this.store.db.prepare("SELECT notes FROM members WHERE id=? AND notes<>'' ORDER BY last_seen").all(id) as {notes:string}[]).map(r=>r.notes))];
      this.store.db.prepare('INSERT INTO member_profiles VALUES(?,?)').run(id,notes.join('\n§\n'));
    }
    if(this.backend){
      const scope=this.scope(chat,id);
      const history=this.store.db.prepare(`SELECT seq,role,content,created_at FROM turns WHERE ${scope.where} ORDER BY seq`).all(...scope.args) as unknown as (Turn&{seq:number})[];
      const notes=verifiedMember(id)?(this.store.db.prepare('SELECT notes FROM member_profiles WHERE id=?').get(id) as {notes:string}).notes:
        (this.store.db.prepare('SELECT notes FROM members WHERE chat_id=? AND id=?').get(chat,id) as {notes:string}|undefined)?.notes??'';
      this.backend.ensure(memberMemoryKey(chat,id),notes?notes.split('\n§\n'):[],history);
    }
  }
  private decorate(row:any):Member {
    this.ensureProfile(row.chat_id,row.id);const scope=this.scope(row.chat_id,row.id);
    const native=this.backend?.snapshot(memberMemoryKey(row.chat_id,row.id));
    const notes=native?.notes??(verifiedMember(row.id)?(this.store.db.prepare('SELECT notes FROM member_profiles WHERE id=?').get(row.id) as {notes:string}).notes:row.notes);
    const turnCount=native?.turn_count??(this.store.db.prepare(`SELECT count(*) n FROM turns WHERE ${scope.where}`).get(...scope.args) as {n:number}).n;
    return {...row,notes,summary:native?.summary??'',memory_backend:native?'hermes':'local',memory_scope:verifiedMember(row.id)?'member':'group',turn_count:turnCount,
      enabled:!!row.enabled,identity:verifiedMember(row.id)?'wechat_id':row.avatar_hash?'visual':'name_only',
      groups:this.store.db.prepare('SELECT g.id,g.name FROM groups g JOIN members m ON m.chat_id=g.id WHERE m.id=? ORDER BY g.name').all(row.id) as {id:string;name:string}[]};
  }
  allMembers():Member[]{
    const rows=this.store.db.prepare('SELECT * FROM members ORDER BY last_seen DESC').all() as any[],seen=new Set<string>();
    return rows.filter(row=>{if(!verifiedMember(row.id))return false;const key=memberMemoryKey(row.chat_id,row.id);if(seen.has(key))return false;seen.add(key);return true;}).map(row=>this.decorate(row));
  }
  pendingMember(chat:string,id:string){
    const scope=this.scope(chat,id);
    return !!this.store.db.prepare(`SELECT 1 FROM reply_context WHERE ${scope.where} LIMIT 1`).get(...scope.args);
  }
  reconcile(){
    const failures:string[]=[];
    for(const r of this.store.db.prepare("SELECT r.job_id,j.state FROM reply_context r JOIN jobs j ON j.id=r.job_id WHERE j.state NOT IN ('queued','running')").all() as {job_id:string;state:string}[]){
      try{this.complete(r.job_id,r.state==='sent');}catch{failures.push(r.job_id);}
    }
    return failures;
  }
  sync(chats:Chat[],allowed:string[]){
    this.store.db.prepare('UPDATE groups SET verified=0').run();
    const stmt=this.store.db.prepare('INSERT INTO groups(id,name,type,verified,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,verified=excluded.verified');
    for(const c of chats)stmt.run(c.id,c.name,c.type,Number(c.verified),Number(allowed.includes(c.id)));
  }
  groups():Group[]{return (this.store.db.prepare('SELECT * FROM groups ORDER BY signup_pending DESC,name,id').all() as any[]).map(r=>({...r,verified:!!r.verified,enabled:!!r.enabled,paused:!!r.paused,signup_pending:!!r.signup_pending}));}
  group(id:string){return this.groups().find(g=>g.id===id);}
  groupPatch(id:string,patch:{enabled?:boolean;model?:string;paused?:boolean}){
    if(!this.group(id))throw new Error('group_not_found');
    if(patch.enabled!==undefined)this.store.db.prepare('UPDATE groups SET enabled=?,signup_pending=0 WHERE id=?').run(Number(patch.enabled),id);
    if(patch.model!==undefined)this.store.db.prepare('UPDATE groups SET model=? WHERE id=?').run(patch.model,id);
    if(patch.paused!==undefined)this.groupControl(id,patch.paused);
  }
  private cancelQueued(chat:string,reason:string){
    this.store.db.prepare("DELETE FROM reply_context WHERE job_id IN (SELECT id FROM jobs WHERE chat_id=? AND state='queued')").run(chat);
    this.store.db.prepare("UPDATE jobs SET state='failed',reason=?,updated_at=? WHERE chat_id=? AND state='queued'").run(reason,Date.now(),chat);
  }
  groupControl(chat:string,paused:boolean){
    if(!this.group(chat))throw new Error('group_not_found');
    this.store.db.exec('BEGIN');try{
      this.store.db.prepare('UPDATE groups SET paused=? WHERE id=?').run(Number(paused),chat);
      if(paused){
        this.store.db.prepare('UPDATE members SET revision=revision+1 WHERE chat_id=?').run(chat);
        this.cancelQueued(chat,'group_stopped');
      }
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  groupModel(chat:string,model:string){
    if(!this.group(chat))throw new Error('group_not_found');
    this.store.db.exec('BEGIN');try{
      this.store.db.prepare('UPDATE groups SET model=? WHERE id=?').run(model,chat);
      this.store.db.prepare("UPDATE members SET model='',revision=revision+1 WHERE chat_id=?").run(chat);
      this.cancelQueued(chat,'group_model_changed');this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  requestSignup(request:SignupRequest){
    if(this.store.db.prepare('SELECT 1 FROM signup_requests WHERE request_id=?').get(request.request_id))return;
    this.store.db.exec('BEGIN');try{
      this.store.db.prepare("INSERT INTO groups(id,name,type,verified,enabled,signup_pending,requested_at) VALUES(?,?,'group',1,0,1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,signup_pending=CASE WHEN groups.enabled=1 THEN 0 ELSE 1 END,requested_at=excluded.requested_at").run(request.chat_id,request.chat_name,request.requested_at);
      // This dedicated acknowledgement is the only queued message that may bypass group authorization.
      const job=this.store.enqueue(request.chat_id,'已发起使用请求','signup:'+request.request_id);
      this.store.db.prepare('INSERT INTO signup_requests VALUES(?,?,?,?,?)').run(request.request_id,request.chat_id,request.chat_name,request.requested_at,job.id);
      this.store.db.exec('COMMIT');
      return job;
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  signupForJob(job:string):SignupRequest|undefined{return this.store.db.prepare('SELECT request_id,chat_id,chat_name,requested_at FROM signup_requests WHERE job_id=?').get(job) as SignupRequest|undefined;}
  observed(chat:string,error='',message=false){this.store.db.prepare('UPDATE groups SET last_poll=?,error=?,last_message=CASE WHEN ? THEN ? ELSE last_message END WHERE id=?').run(Date.now(),error,Number(message),Date.now(),chat);}
  members(chat:string):Member[]{return (this.store.db.prepare('SELECT * FROM members WHERE chat_id=? ORDER BY last_seen DESC').all(chat) as any[]).map(row=>this.decorate(row));}
  member(chat:string,id:string){const row=this.store.db.prepare('SELECT * FROM members WHERE chat_id=? AND id=?').get(chat,id);return row?this.decorate(row):undefined;}
  identifyWechat(chat:string,wxid:string,name:string):Member {
    if(!/^[\w@.\-]{1,128}$/.test(wxid))throw new Error('invalid_member_id');
    const id='wxid:'+createHash('sha256').update(wxid).digest('hex');
    this.store.db.prepare("INSERT INTO members(chat_id,id,name,avatar_hash,last_seen) VALUES(?,?,?,'',?) ON CONFLICT(chat_id,id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen").run(chat,id,name,Date.now());
    return this.member(chat,id)!;
  }
  identify(chat:string,name:string,avatar=''):Member {
    // These are visible identities, never asserted to be immutable WeChat IDs.
    let id=createHash('sha256').update(normalized(name)+'\0'+avatar).digest('hex').slice(0,24);
    // Vision sometimes reads an emoji at the end of a long nickname as a varying glyph.
    // Reuse only one close-avatar match with an otherwise identical long name.
    if(avatar&&!this.member(chat,id)){
      const key=normalized(name),candidates=this.members(chat).filter(m=>sameAvatar(m.avatar_hash,avatar)&&(normalized(m.name)===key||(key.length>=8&&normalized(m.name).length===key.length&&normalized(m.name).slice(0,-1)===key.slice(0,-1))));
      if(candidates.length===1)id=candidates[0]!.id;
    }
    this.store.db.prepare('INSERT INTO members(chat_id,id,name,avatar_hash,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(chat_id,id) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen').run(chat,id,name,avatar,Date.now());
    return this.member(chat,id)!;
  }
  patch(chat:string,id:string,patch:{notes?:string;summary?:string;model?:string;enabled?:boolean}){
    if(!this.member(chat,id))throw new Error('member_not_found');
    if(patch.notes!==undefined||patch.summary!==undefined){
      this.backend?.patch(memberMemoryKey(chat,id),{...(patch.notes!==undefined?{notes:patch.notes}:{}),...(patch.summary!==undefined?{summary:patch.summary}:{})});
      if(verifiedMember(id)){
        if(patch.notes!==undefined)this.store.db.prepare('UPDATE member_profiles SET notes=? WHERE id=?').run(patch.notes,id);
        this.store.db.prepare('UPDATE members SET revision=revision+1 WHERE id=?').run(id);
      }else this.store.db.prepare('UPDATE members SET notes=?,revision=revision+1 WHERE chat_id=? AND id=?').run(patch.notes??this.member(chat,id)!.notes,chat,id);
    }
    for(const key of ['model','enabled'] as const)if(patch[key]!==undefined)this.store.db.prepare(`UPDATE members SET ${key}=?,revision=revision+1 WHERE chat_id=? AND id=?`).run(key==='enabled'?Number(patch[key]):String(patch[key]),chat,id);
  }
  reset(chat:string,id:string,notes=true){
    if(!this.member(chat,id))throw new Error('member_not_found');
    this.backend?.reset(memberMemoryKey(chat,id),notes);
    this.store.db.exec('BEGIN');try{
      const scope=this.scope(chat,id);this.store.db.prepare(`DELETE FROM turns WHERE ${scope.where}`).run(...scope.args);
      if(verifiedMember(id)){
        this.store.db.prepare("UPDATE members SET revision=revision+1,notes=CASE WHEN ? THEN '' ELSE notes END WHERE id=?").run(Number(notes),id);
        if(notes)this.store.db.prepare("UPDATE member_profiles SET notes='' WHERE id=?").run(id);
      }else this.store.db.prepare("UPDATE members SET revision=revision+1,notes=CASE WHEN ? THEN '' ELSE notes END WHERE chat_id=? AND id=?").run(Number(notes),chat,id);
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  history(chat:string,id:string):Turn[]{
    if(this.backend){this.ensureProfile(chat,id);return this.backend.snapshot(memberMemoryKey(chat,id)).history;}
    const scope=this.scope(chat,id);return (this.store.db.prepare(`SELECT role,content,created_at FROM turns WHERE ${scope.where} ORDER BY seq DESC LIMIT 20`).all(...scope.args) as unknown as Turn[]).reverse();
  }
  imageSession(chat:string,id:string):string{
    if(!this.member(chat,id))throw new Error('member_not_found');
    this.store.db.prepare('INSERT OR IGNORE INTO image_sessions VALUES(?,?,?)').run(chat,id,randomUUID());
    return (this.store.db.prepare('SELECT session_id FROM image_sessions WHERE chat_id=? AND member_id=?').get(chat,id) as {session_id:string}).session_id;
  }
  newImageSession(chat:string,id:string){
    if(!this.member(chat,id))throw new Error('member_not_found');
    this.store.db.exec('BEGIN');try{
      this.store.db.prepare('INSERT INTO image_sessions VALUES(?,?,?) ON CONFLICT(chat_id,member_id) DO UPDATE SET session_id=excluded.session_id').run(chat,id,randomUUID());
      this.store.db.prepare("UPDATE jobs SET state='failed',reason='image_session_reset',updated_at=? WHERE state='queued' AND id IN (SELECT job_id FROM image_reply_context WHERE chat_id=? AND member_id=?)").run(Date.now(),chat,id);
      this.store.db.prepare("DELETE FROM reply_context WHERE job_id IN (SELECT i.job_id FROM image_reply_context i JOIN jobs j ON j.id=i.job_id WHERE i.chat_id=? AND i.member_id=? AND j.state='failed' AND j.reason='image_session_reset')").run(chat,id);
      this.store.db.prepare("DELETE FROM image_reply_context WHERE chat_id=? AND member_id=? AND job_id IN (SELECT id FROM jobs WHERE state='failed' AND reason='image_session_reset')").run(chat,id);
      this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
  trackImageJob(job:string,member:Member,session:string){this.store.db.prepare('INSERT OR IGNORE INTO image_reply_context VALUES(?,?,?,?,?)').run(job,member.chat_id,member.id,member.revision,session);}
  stage(job:string,member:Member,user:string,answer:string,draft?:MemoryDraft){this.store.db.prepare('INSERT OR IGNORE INTO reply_context(job_id,chat_id,member_id,revision,user_text,answer,memory_draft) VALUES(?,?,?,?,?,?,?)').run(job,member.chat_id,member.id,member.revision,user,answer,draft?JSON.stringify(draft):null);}
  valid(job:string){
    const image=this.store.db.prepare('SELECT * FROM image_reply_context WHERE job_id=?').get(job) as any;
    if(image){const m=this.member(image.chat_id,image.member_id);if(!m?.enabled||m.revision!==image.revision||this.imageSession(image.chat_id,image.member_id)!==image.session_id)return false;}
    const r=this.store.db.prepare('SELECT * FROM reply_context WHERE job_id=?').get(job) as any;if(!r)return true;const m=this.member(r.chat_id,r.member_id);return !!m&&m.enabled&&m.revision===r.revision;
  }
  complete(job:string,sent:boolean){
    const r=this.store.db.prepare('SELECT * FROM reply_context WHERE job_id=?').get(job) as any;if(!r){this.store.db.prepare('DELETE FROM image_reply_context WHERE job_id=?').run(job);return;}
    this.store.db.exec('BEGIN');try{
      if(sent&&this.valid(job)){
        this.backend?.commit(memberMemoryKey(r.chat_id,r.member_id),job,r.user_text,r.answer,r.memory_draft?JSON.parse(r.memory_draft):undefined);
        const put=this.store.db.prepare('INSERT INTO turns(chat_id,member_id,role,content,created_at) VALUES(?,?,?,?,?)');
        put.run(r.chat_id,r.member_id,'user',r.user_text,Date.now());put.run(r.chat_id,r.member_id,'assistant',r.answer,Date.now());
        const scope=this.scope(r.chat_id,r.member_id);
        this.store.db.prepare(`DELETE FROM turns WHERE ${scope.where} AND seq NOT IN (SELECT seq FROM turns WHERE ${scope.where} ORDER BY seq DESC LIMIT 20)`).run(...scope.args,...scope.args);
      }
      this.store.db.prepare('DELETE FROM reply_context WHERE job_id=?').run(job);this.store.db.prepare('DELETE FROM image_reply_context WHERE job_id=?').run(job);this.store.db.exec('COMMIT');
    }catch(e){this.store.db.exec('ROLLBACK');throw e;}
  }
}
