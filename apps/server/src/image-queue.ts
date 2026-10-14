import type {Store} from './store.js';

export interface ImageRequest {
  id:string;chat_id:string;member_id:string;revision:number;session_id:string;prompt:string;
  state:string;reason:string;
}
/** Prompts wait in SQLite, never in the shared browser composer. */
export class ImageQueue {
  constructor(private store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS image_requests(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL,member_id TEXT NOT NULL,revision INTEGER NOT NULL,
      session_id TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      UPDATE image_requests SET state='uncertain',reason='interrupted_during_generation' WHERE state='running';`);
  }
  add(request:Omit<ImageRequest,'state'|'reason'>){
    const now=Date.now();
    this.store.db.prepare(`INSERT INTO image_requests
      (id,chat_id,member_id,revision,session_id,prompt,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'queued',?,?)`).run(request.id,request.chat_id,request.member_id,request.revision,request.session_id,request.prompt,now,now);
  }
  get(id:string){return this.store.db.prepare('SELECT * FROM image_requests WHERE id=?').get(id) as unknown as ImageRequest|undefined;}
  waiting(){return this.store.db.prepare("SELECT * FROM image_requests WHERE state='queued' ORDER BY seq").all() as unknown as ImageRequest[];}
  count(){return Number(this.store.db.prepare("SELECT count(*) AS n FROM image_requests WHERE state IN ('queued','running')").get()!.n);}
  update(id:string,state:string,reason=''){this.store.db.prepare('UPDATE image_requests SET state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,Date.now(),id);}
  status(){return this.store.db.prepare('SELECT state,count(*) AS count FROM image_requests GROUP BY state').all();}
}
