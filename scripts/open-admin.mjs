import {spawn} from 'node:child_process';
const port=process.env.BRIDGE_PORT??3100;
const response=await fetch(`http://127.0.0.1:${port}/api/admin/ticket`,{method:'POST',headers:{Authorization:'Bearer '+process.env.BRIDGE_API_TOKEN}});
if(!response.ok)throw new Error('请先启动 Bridge');
const {ticket}=await response.json();
// A one-time 60-second ticket goes in the fragment, never the server URL/logs.
const url=`http://127.0.0.1:${port}/#ticket=${ticket}`;
if(process.argv.includes('--save')){
 const {writeFileSync}=await import('node:fs');writeFileSync('.runtime/admin-launch.json',JSON.stringify({url}),{mode:0o600});
 console.log('一次性登录链接已保存，有效期 60 秒。');
}else{
 await new Promise((resolve,reject)=>{const child=spawn('open',[url],{stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('无法打开浏览器，请检查默认浏览器设置。')));});
 console.log('已将登录链接交给浏览器，登录成功后会话有效 12 小时。');
}
