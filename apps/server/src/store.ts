import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import type { GeneratedImage,Job, JobState } from '../../../packages/shared/types.js';
import {validateImage} from './images.js';
export class Store {
  readonly db: DatabaseSync;
  constructor(readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true, mode:0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, content TEXT NOT NULL,
      state TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, idem TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_images(job_id TEXT PRIMARY KEY,mime_type TEXT NOT NULL,data BLOB,sha256 TEXT NOT NULL);
      UPDATE jobs SET state='uncertain',reason='interrupted_before_confirmation' WHERE state='running';`);
  }
  enqueueImage(chatId:string,prompt:string,image:GeneratedImage,idem:string,stage?:(job:Job)=>void):Job{
    validateImage(image.data,image.mime_type);
    const hash=createHash('sha256').update(image.data).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const job=this.enqueue(chatId,'[图片] '+prompt,idem);
      const existing=this.db.prepare('SELECT sha256 FROM job_images WHERE job_id=?').get(job.id) as {sha256:string}|undefined;
      if(existing&&existing.sha256!==hash)throw new Error('idempotency_conflict');
      this.db.prepare('INSERT OR IGNORE INTO job_images VALUES(?,?,?,?)').run(job.id,image.mime_type,image.data,hash);
      stage?.(job);
      // Keep recent delivery evidence; old completed image payloads can be released.
      this.db.prepare("UPDATE job_images SET data=NULL WHERE data IS NOT NULL AND job_id IN (SELECT id FROM jobs WHERE state IN ('sent','failed','uncertain') AND updated_at<?)").run(Date.now()-7*86400_000);
      this.db.exec('COMMIT');return job;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  image(id:string):GeneratedImage|null|undefined{
    const image=this.db.prepare('SELECT mime_type,data FROM job_images WHERE job_id=?').get(id) as {mime_type:GeneratedImage['mime_type'];data:Uint8Array|null}|undefined;
    return image?(image.data?{mime_type:image.mime_type,data:image.data}:null):undefined;
  }
  enqueue(chatId: string, content: string, idem?: string): Job {
    if (idem) {
      const old = this.db.prepare('SELECT * FROM jobs WHERE idem=?').get(idem) as unknown as Job | undefined;
      if (old) {
        if (old.chat_id !== chatId || old.content !== content) throw new Error('idempotency_conflict');
        return old;
      }
    }
    const id = randomUUID(), now = Date.now();
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?)').run(id,chatId,content,'queued','',now,now,idem ?? null);
    return this.job(id)!;
  }
  job(id: string): Job | undefined { return this.db.prepare('SELECT id,chat_id,content,state,reason,created_at,updated_at FROM jobs WHERE id=?').get(id) as unknown as Job | undefined; }
  next(): Job | undefined { return this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1").get() as unknown as Job | undefined; }
  update(id: string, state: JobState, reason = '') { this.db.prepare('UPDATE jobs SET state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,Date.now(),id); }
  once(id: string) { return this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(id,Date.now()).changes === 1; }
  get(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value; }
  set(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,value); }
  close() { this.db.close(); }
}
