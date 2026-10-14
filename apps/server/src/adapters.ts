import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Chat, DeviceAdapter, Row, SendResult, Snapshot } from '../../../packages/shared/types.js';
import type { Config } from './config.js';
export class MockDriver implements DeviceAdapter {
  readonly known: Chat[] = [{id:'mock-group',name:'测试群',type:'group',verified:true},{id:'mock-group-2',name:'第二测试群',type:'group',verified:true}];
  private windows=new Map<string,Row[]>(); active = this.known[0]!; sent: {chat:Chat;content:string}[] = [];
  get rows(){let rows=this.windows.get(this.active.id);if(!rows){rows=[];this.windows.set(this.active.id,rows);}return rows;}
  async status() { return {connected:true, installed:true, foreground:true, mode:'mock', simulated:true}; }
  async chats() { return this.known; }
  async snapshot(chat?:Chat): Promise<Snapshot> { if(chat)this.active=chat;return {chat:this.active,rows:[...this.rows],reliability:'mock'}; }
  inject(content:string, own:boolean|null=false, mention:Row['mention']='verified') {
    this.rows.push({content,own,mention,sender:own?'机器人':'测试用户',key:createHash('sha256').update(JSON.stringify([content,own])).digest('hex')});
  }
  async send(chat:Chat,content:string):Promise<SendResult> { this.active=chat;this.sent.push({chat,content}); this.inject(content,true,'none'); return {state:'sent',reason:'mock_confirmed'}; }
}
export class AdbDriver implements DeviceAdapter {
  constructor(private config:Config) {}
  private call<T>(operation:string, payload:unknown={}):Promise<T> {
    return new Promise((done,fail) => {
      const proc = spawn(resolve('.runtime/venv/bin/python'), ['scripts/device-agent.py',operation], {
        env:{...process.env, WECHAT_DEVICE_SERIAL:this.config.WECHAT_DEVICE_SERIAL, WECHAT_PROFILE:this.config.WECHAT_PROFILE, ADB_SERVER_PORT:String(this.config.ADB_SERVER_PORT)},
        stdio:['pipe','pipe','pipe'],
      });
      let output = '', settled = false;
      const finish = (err:Error|null, value?:T) => { if(settled) return; settled=true; clearTimeout(timer); err?fail(err):done(value!); };
      // First IME initialization after a cold VM boot can exceed one minute.
      // A timed-out send stays uncertain and is never automatically retried.
      const timeout=operation==='send'?120_000:operation==='register'?90_000:60_000;
      const timer = setTimeout(() => {proc.kill('SIGKILL');finish(new Error('device_timeout'));},timeout);
      proc.on('error',()=>finish(new Error('device_helper_unavailable')));
      proc.stdout.on('data',chunk=> {output += String(chunk); if(output.length>2_000_000){proc.kill();finish(new Error('device_output_limit'));}});
      // Never forward raw device output, UI text, or child stderr to logs.
      proc.stderr.resume();
      proc.on('close',code=> {try {if(code!==0) throw new Error('device_operation_failed'); finish(null,JSON.parse(output) as T);} catch {finish(new Error('device_operation_failed'));}});
      proc.stdin.on('error',()=>{});
      proc.stdin.end(JSON.stringify(payload));
    });
  }
  status() { return this.call<Record<string,unknown>>('status'); }
  chats() { return this.call<Chat[]>('chats'); }
  snapshot(chat?:Chat) { return this.call<Snapshot>('snapshot',{chat_id:chat?.id}); }
  register(name:string){return this.call<Chat>('register',{name});}
  send(chat:Chat,content:string) { return this.call<SendResult>('send',{chat_id:chat.id,content}); }
}
