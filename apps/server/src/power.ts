import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export async function hostLocked():Promise<boolean|null>{
 if(process.platform!=='darwin')return null;
 try{
  const {stdout}=await exec('/usr/sbin/ioreg',['-n','Root','-d1'],{timeout:3000,maxBuffer:2_000_000});
  const values=[...stdout.matchAll(/"CGSSessionScreenIsLocked"\s*=\s*(Yes|No)/g)].map(m=>m[1]==='Yes');
  return values.length&&values.every(v=>v===values[0])?values[0]!:null;
 }catch{return null;}
}
