import { readFileSync } from 'node:fs';
const command = process.argv[2] ?? 'health';
const routes = {health:'/api/health',device:'/api/device/status',chats:'/api/chats',pause:'/api/control',resume:'/api/control',send:'/api/messages/send'};
if (!routes[command] && command!=='job') throw new Error('Use health, device, chats, pause, resume, send, or job <id>');
const payload = command==='pause'?{paused:true}:command==='resume'?{paused:false}:command==='send'?JSON.parse(readFileSync(0,'utf8')):undefined;
const response = await fetch(`http://127.0.0.1:${process.env.BRIDGE_PORT??3100}`+(routes[command]??'/api/jobs/'+encodeURIComponent(process.argv[3]??'')), {
  method:payload?'POST':'GET',headers:{Authorization:'Bearer '+process.env.BRIDGE_API_TOKEN,'Content-Type':'application/json'},body:payload?JSON.stringify(payload):undefined,
});
console.log(JSON.stringify(await response.json(),null,2));
if(!response.ok)process.exitCode=1;
