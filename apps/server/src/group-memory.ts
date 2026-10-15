import {createHash} from 'node:crypto';
import type {GroupHistory} from '../../../packages/shared/types.js';
import type {Store} from './store.js';

interface Capture {chat_id:string;enabled:number;since:number;source:string;cursor:number;last_sync:number;error:string;has_more:number}
/** Durable group evidence, separate from Hermes' cross-group personal profiles. */
export class GroupMemory {
  constructor(private store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS group_capture(chat_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL,since INTEGER NOT NULL,source TEXT NOT NULL DEFAULT '',cursor INTEGER NOT NULL DEFAULT 0,last_sync INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',has_more INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS group_messages(chat_id TEXT NOT NULL,source TEXT NOT NULL,local_id INTEGER NOT NULL,sender_id TEXT NOT NULL,sender TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL,truncated INTEGER NOT NULL,PRIMARY KEY(chat_id,source,local_id));
      CREATE INDEX IF NOT EXISTS group_messages_time ON group_messages(chat_id,created_at,local_id);
      CREATE TABLE IF NOT EXISTS group_answers(job_id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,member_id TEXT NOT NULL,user_text TEXT NOT NULL,answer TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  }
  authorize(ids:string[],now=Date.now()){
    const allowed=new Set(ids);
    for(const row of this.states())if(!allowed.has(row.chat_id)&&row.enabled)this.store.db.prepare('UPDATE group_capture SET enabled=0 WHERE chat_id=?').run(row.chat_id);
    for(const id of allowed){
      const previous=this.state(id);
      // Initial rollout can recall the past day. Reauthorization excludes the disabled interval.
      if(!previous)this.store.db.prepare('INSERT INTO group_capture(chat_id,enabled,since) VALUES(?,1,?)').run(id,now-86400_000);
      else if(!previous.enabled)this.store.db.prepare("UPDATE group_capture SET enabled=1,since=?,cursor=0,source='',has_more=1 WHERE chat_id=?").run(now,id);
    }
  }
  state(chat:string){return this.store.db.prepare('SELECT * FROM group_capture WHERE chat_id=?').get(chat) as unknown as Capture|undefined;}
  states(){return this.store.db.prepare('SELECT * FROM group_capture').all() as unknown as Capture[];}
  accept(chat:string,page:GroupHistory,now=Date.now()){
    const state=this.state(chat);if(!state?.enabled)return;
    if(page.chat_id!==chat||!page.source||page.cursor<0||page.messages.some((m,i)=>m.local_id>page.cursor||m.timestamp<state.since||m.timestamp>now+60_000||i>0&&m.local_id<=page.messages[i-1]!.local_id)||page.source===state.source&&page.cursor<state.cursor)throw new Error('invalid_group_history');
    this.store.db.exec('BEGIN IMMEDIATE');
    try{
      const put=this.store.db.prepare('INSERT OR IGNORE INTO group_messages VALUES(?,?,?,?,?,?,?,?)');
      for(const row of page.messages)put.run(chat,page.source,row.local_id,createHash('sha256').update(row.sender_id).digest('hex'),row.sender,row.content,row.timestamp,Number(row.truncated));
      this.store.db.prepare("UPDATE group_capture SET source=?,cursor=?,last_sync=?,error='',has_more=? WHERE chat_id=?").run(page.source,page.cursor,now,Number(page.has_more),chat);
      this.store.db.exec('COMMIT');
    }catch(error){this.store.db.exec('ROLLBACK');throw error;}
  }
  failed(chat:string){this.store.db.prepare("UPDATE group_capture SET error='history_sync_failed' WHERE chat_id=?").run(chat);}
  stats(chat:string){return {...this.state(chat),...this.store.db.prepare('SELECT count(*) AS message_count,min(created_at) AS first_message,max(created_at) AS last_message FROM group_messages WHERE chat_id=?').get(chat) as {message_count:number;first_message:number|null;last_message:number|null}};}
  recent(chat:string,limit=100){return this.store.db.prepare('SELECT sender,content,created_at,truncated FROM group_messages WHERE chat_id=? ORDER BY created_at DESC,local_id DESC LIMIT ?').all(chat,Math.min(100,Math.max(1,limit))).reverse();}
}
