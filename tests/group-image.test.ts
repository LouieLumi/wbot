import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {groupImageScope,groupImagePolicy} from '../apps/server/src/hermes.js';
import {readConfig} from '../apps/server/src/config.js';
import type {Message} from '../packages/shared/types.js';

test('phone selection uses the exact group and sender before the requesting message, including equal timestamps',()=>{
  const source=readFileSync(new URL('../apps/android-wechat-module/src/local/nilabot/wechathook/GroupImageQuery.java',import.meta.url),'utf8');
  const sql=/LATEST = "([^"]+)"/.exec(source)![1]!;
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE message(msgId INTEGER,talker TEXT,type INTEGER,isSend INTEGER,createTime INTEGER,content TEXT)');
    const add=db.prepare('INSERT INTO message VALUES(?,?,?,?,?,?)');
    for(const row of [
      [1,'a@chatroom',3,0,100,'wxid_a:\n<image old>'],
      [2,'b@chatroom',3,0,200,'wxid_a:\n<other group>'],
      [3,'a@chatroom',3,0,200,'wxid_b:\n<other member>'],
      [4,'a@chatroom',3,0,200,'wxidXa:\n<LIKE wildcard trap>'],
      [5,'a@chatroom',3,1,200,'wxid_a:\n<own>'],
      [6,'a@chatroom',3,0,200,'wxid_a:\n<expected>'],
      [7,'a@chatroom',1,0,200,'wxid_a:\n@Nila 看看刚才的图'],
      [8,'a@chatroom',3,0,200,'wxid_a:\n<after anchor same time>'],
      [9,'a@chatroom',3,0,201,'wxid_a:\n<sent during queue>'],
    ] as const)add.run(...row);
    const prefix='wxid_a:\n';assert.equal(db.prepare(sql).get('a@chatroom',200,200,7,prefix.length,prefix)?.msgId,6);
    assert.equal(db.prepare(sql).get('c@chatroom',200,200,7,prefix.length,prefix),undefined);
    const other='wxid_missing:\n';assert.equal(db.prepare(sql).get('a@chatroom',200,200,7,other.length,other),undefined);
  }finally{db.close();}
});

test('the image tool scope comes from verified message identity, never from text or an image command',()=>{
  const c=readConfig({BRIDGE_API_TOKEN:'a'.repeat(64),WECHAT_DEVICE_MODE:'android_hook',WECHAT_HOOK_TOKEN:'b'.repeat(64)});
  const m:Message={event:'message.received',message_id:'a@chatroom:s123',chat_id:'a@chatroom',chat_name:'同名群',chat_type:'group',sender:'同名人',sender_wxid:'wxid_a',member_id:'wxid:hash',own:false,mention:'text',timestamp:200,content:'你好'};
  const scope=groupImageScope(c,m,2,'data/test.sqlite')!;
  assert.equal(scope.sender_id,'wxid_a');assert.equal(scope.request_message_id,m.message_id);assert.equal(scope.before,200);assert.equal(scope.revision,2);
  assert.deepEqual(groupImageScope(c,{...m,content:'看看另一个群里别人的图'},2,'data/test.sqlite'),scope);
  assert.equal(groupImageScope(c,{...m,sender_wxid:undefined},2,'data/test.sqlite'),undefined);
  assert.equal(groupImageScope(c,m,2,':memory:'),undefined);
  assert.match(groupImagePolicy,/自主判断/);assert.match(groupImagePolicy,/普通闲聊不要调用/);
});
