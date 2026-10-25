import type {Message} from '../../../packages/shared/types.js';
import type {Store} from './store.js';

export interface ReplyRequest {id:string;chat_id:string;member_id:string;revision:number;message:Message;voice_blocked:boolean;state:string;reason:string}
/** Accepted prompts are durable; uncertain generations are never blindly replayed. */
export class ReplyQueue {
  constructor(private store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS reply_requests(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,chat_id TEXT NOT NULL,
      member_id TEXT NOT NULL,revision INTEGER NOT NULL,message TEXT NOT NULL,voice_blocked INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS reply_requests_state ON reply_requests(state,seq);
      UPDATE reply_requests SET state='uncertain',reason='interrupted_during_generation' WHERE state='running';`);
    if(!store.db.prepare('PRAGMA table_info(reply_requests)').all().some(row=>row.name==='voice_blocked'))
      store.db.exec('ALTER TABLE reply_requests ADD COLUMN voice_blocked INTEGER NOT NULL DEFAULT 0');
  }
  add(message:Message,memberId:string,revision:number,voiceBlocked=false){
    const now=Date.now();
    this.store.db.prepare("INSERT INTO reply_requests(id,chat_id,member_id,revision,message,voice_blocked,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?)")
      .run(message.message_id,message.chat_id,memberId,revision,JSON.stringify(message),Number(voiceBlocked),now,now);
  }
  private rows(state:string,reason?:string):ReplyRequest[]{
    const rows=reason===undefined?this.store.db.prepare('SELECT * FROM reply_requests WHERE state=? ORDER BY seq').all(state):
      this.store.db.prepare('SELECT * FROM reply_requests WHERE state=? AND reason=? ORDER BY seq').all(state,reason);
    return rows.map(row=>({...row,message:JSON.parse(String(row.message)),voice_blocked:row.voice_blocked===1})) as unknown as ReplyRequest[];
  }
  waiting(){return this.rows('queued');}
  interrupted(){return this.rows('uncertain','interrupted_during_generation');}
  count(){return Number(this.store.db.prepare("SELECT count(*) n FROM reply_requests WHERE state IN ('queued','running')").get()!.n);}
  update(id:string,state:string,reason=''){this.store.db.prepare('UPDATE reply_requests SET state=?,reason=?,updated_at=? WHERE id=?').run(state,reason,Date.now(),id);}
  status(){return this.store.db.prepare('SELECT state,count(*) count FROM reply_requests GROUP BY state').all();}
}
