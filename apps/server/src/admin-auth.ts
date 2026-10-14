import {createHash, randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

const passwordKey='admin_password_hash';
export const sessionSeconds=12*60*60;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>{
  scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key));
});

export class AdminAuth {
  constructor(private db:DatabaseSync){
    db.exec(`CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);`);
    this.prune();
  }
  async setPassword(password:string){
    if(password.length<8||password.length>256)throw new Error('password_length');
    const salt=randomBytes(16).toString('hex'),key=await derive(password,salt);
    const encoded=`scrypt-v1$${salt}$${key.toString('hex')}`;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(passwordKey,encoded);
      this.db.exec('DELETE FROM admin_sessions; COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async verifyPassword(password:string){
    const stored=this.db.prepare('SELECT value FROM settings WHERE key=?').get(passwordKey) as {value:string}|undefined;
    const parts=/^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(stored?.value??'');
    if(!parts)return false;
    const key=await derive(password,parts[1]!);
    return timingSafeEqual(key,Buffer.from(parts[2]!,'hex'));
  }
  issueSession(){
    this.prune();
    const token=randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO admin_sessions VALUES(?,?)').run(digest(token),Date.now()+sessionSeconds*1000);
    return token;
  }
  validSession(token:string){
    if(!/^[a-f0-9]{64}$/.test(token))return false;
    return Boolean(this.db.prepare('SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),Date.now()));
  }
  revokeSession(token:string){this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(digest(token));}
  private prune(){this.db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(Date.now());}
}
