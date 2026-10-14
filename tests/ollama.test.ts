import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Ollama} from '../apps/server/src/ollama.js';
import {readConfig} from '../apps/server/src/config.js';
import type {Message} from '../packages/shared/types.js';

test('Ollama keeps groups isolated, sends text only and rejects tool output',async()=>{
  const requests:any[]=[];let invalid=false;
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push(JSON.parse(body));assert.equal(req.url,'/api/chat');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({done:true,message:{content:'本地回答',...(invalid?{tool_calls:[{function:{name:'anything'}}]}:{})}}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const config=readConfig({BRIDGE_API_TOKEN:'test'.repeat(10),AI_PROVIDER:'ollama',OLLAMA_BASE_URL:'http://127.0.0.1:'+(server.address() as {port:number}).port});
    const client=new Ollama(config);
    const msg=(chat:string,content:string):Message=>({event:'message.received',message_id:content,chat_id:chat,chat_name:'群',chat_type:'group',content,sender:'同一成员',own:false,mention:'unknown',timestamp:0});
    await client.reply(msg('a','第一组秘密'));await client.reply(msg('b','第二组'));await client.reply(msg('a','继续'));
    assert.equal(requests[1].messages.length,2);
    assert(!JSON.stringify(requests[1]).includes('第一组秘密'));
    assert.equal(requests[2].messages[1].content,'第一组秘密');
    assert.equal(requests[2].messages.length,4);
    assert.equal(requests[0].think,false);assert.equal(requests[0].tools,undefined);
    invalid=true;await assert.rejects(client.reply(msg('a','工具')),/invalid_reply/);
    invalid=false;await client.reply(msg('a','继续2'));
    assert(!requests.at(-1).messages.some((m:any)=>m.content==='工具'));
    await assert.rejects(client.reply(msg('a','已取消'),AbortSignal.abort()));
  }finally{server.close();await once(server,'close');}
});

test('remote or credential-bearing AI URLs are rejected',()=>{
  for(const url of ['https://example.com','http://user:pass@127.0.0.1','file:///tmp/model'])
    assert.throws(()=>readConfig({BRIDGE_API_TOKEN:'t'.repeat(32),OLLAMA_BASE_URL:url}));
});
