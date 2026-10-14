import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../apps/server/src/store.js';
import {AdminAuth} from '../apps/server/src/admin-auth.js';
import {Bridge} from '../apps/server/src/bridge.js';
import {MockDriver} from '../apps/server/src/adapters.js';
import {createApi} from '../apps/server/src/api.js';
import {readConfig} from '../apps/server/src/config.js';

const password='test-only-admin-password';
const config=()=>readConfig({BRIDGE_API_TOKEN:'test-bearer-'.repeat(4),WECHAT_DEVICE_MODE:'mock'});
async function server(path:string){
  const store=new Store(path),bridge=new Bridge(config(),new MockDriver(),store,{async reply(){return 'ok';}});
  const app=await createApi(config(),bridge);
  return {store,app,async close(){await app.close();store.close();}};
}

test('password login survives server restart, then logout and password reset revoke sessions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'nila-admin-')),path=join(dir,'db');
  let s=await server(path);
  try{
    await new AdminAuth(s.store.db).setPassword(password);
    assert.equal((await s.app.inject({url:'/api/admin/state'})).statusCode,401);
    const wrong=await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password:'wrong'}});
    assert.equal(wrong.statusCode,401);assert.equal(wrong.json().error,'invalid_password');
    assert.equal(wrong.headers['set-cookie'],undefined);
    const login=await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password}});
    assert.equal(login.statusCode,200);
    const cookie=String(login.headers['set-cookie']).split(';')[0]!;
    assert.match(String(login.headers['set-cookie']),/HttpOnly; SameSite=Strict; Max-Age=43200/);
    assert.equal(JSON.stringify(s.store.db.prepare('SELECT * FROM settings').all()).includes(password),false);
    assert.equal(JSON.stringify(s.store.db.prepare('SELECT * FROM admin_sessions').all()).includes(cookie.split('=')[1]!),false);
    await s.close();s=await server(path);
    assert.equal((await s.app.inject({url:'/api/admin/state',headers:{cookie}})).statusCode,200);
    const logout=await s.app.inject({method:'POST',url:'/api/auth/logout',headers:{cookie}});
    assert.equal(logout.statusCode,200);assert.match(String(logout.headers['set-cookie']),/Max-Age=0/);
    assert.equal((await s.app.inject({url:'/api/admin/state',headers:{cookie}})).statusCode,401);
    const again=await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password}});
    const cookie2=String(again.headers['set-cookie']).split(';')[0]!;
    const auth=new AdminAuth(s.store.db);await auth.setPassword('changed-test-password');
    assert.equal((await s.app.inject({url:'/api/admin/state',headers:{cookie:cookie2}})).statusCode,401);
    assert.equal(await auth.verifyPassword(password),false);
    assert.equal(await auth.verifyPassword('changed-test-password'),true);
  }finally{await s.close();rmSync(dir,{recursive:true});}
});

test('password endpoint retains host/origin protection, input validation and limits guessing',async()=>{
  const s=await server(':memory:');
  try{
    await new AdminAuth(s.store.db).setPassword(password);
    for(const headers of [{origin:'https://other.example'},{host:'other.example'},{'sec-fetch-site':'cross-site'}]){
      assert.equal((await s.app.inject({method:'POST',url:'/api/auth/login',headers,payload:{password}})).statusCode,403);
    }
    assert.equal((await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password,extra:true},remoteAddress:'127.0.0.2'})).statusCode,400);
    for(let i=0;i<5;i++)assert.equal((await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password:'wrong'}})).statusCode,401);
    const limited=await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password}});
    assert.equal(limited.statusCode,429);assert.equal(limited.json().error,'rate_limited');
    assert.equal(limited.headers['set-cookie'],undefined);
    assert.equal((await s.app.inject({url:'/api/admin/state',headers:{cookie:'bridge_session='+'a'.repeat(64)}})).statusCode,401);
  }finally{await s.close();}
});

test('unconfigured passwords fail closed and expired sessions cannot authorize',async()=>{
  const s=await server(':memory:');
  try{
    const auth=new AdminAuth(s.store.db);
    assert.equal((await s.app.inject({method:'POST',url:'/api/auth/login',payload:{password}})).statusCode,401);
    const token=auth.issueSession();assert.equal(auth.validSession(token),true);
    s.store.db.prepare('UPDATE admin_sessions SET expires_at=?').run(Date.now()-1);
    assert.equal((await s.app.inject({url:'/api/admin/state',headers:{cookie:'bridge_session='+token}})).statusCode,401);
    new AdminAuth(s.store.db);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get()!.n,0);
  }finally{await s.close();}
});
