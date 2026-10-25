import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

test('quote recovery finds native extended card types, excludes own messages, other groups and old records',()=>{
  const source=readFileSync(new URL('../apps/android-wechat-module/src/local/nilabot/wechathook/LocalBridge.java',import.meta.url),'utf8');
  const sql=/"(SELECT msgId,talker,type,isSend,createTime,content,msgSvrId FROM message WHERE talker=\? AND isSend=0 AND \(type & 65535\)=49 AND createTime>=\? ORDER BY msgId DESC LIMIT 100)"/.exec(source)?.[1];
  assert(sql);
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE message(msgId INTEGER,talker TEXT,type INTEGER,isSend INTEGER,createTime INTEGER,content TEXT,msgSvrId INTEGER)');
    const add=db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?,?)');
    for(const row of [[1,'a',49,0,200,'quote',101],[2,'a',822083633,0,201,'native quote',102],[3,'a',1,0,202,'text',103],
      [4,'b',822083633,0,202,'other group',104],[5,'a',822083633,1,202,'own',105],[6,'a',822083633,0,99,'old',106]] as const)add.run(...row);
    assert.deepEqual(db.prepare(sql).all('a',100).map(r=>r.msgId),[2,1]);
    const proof=db.prepare('SELECT type,content FROM message WHERE talker=? AND msgSvrId=? AND isSend=1 LIMIT 1');
    assert.equal(proof.get('a',102),undefined);assert.equal(proof.get('b',105),undefined);assert.equal(proof.get('a',105)?.content,'own');
  }finally{db.close();}
});
