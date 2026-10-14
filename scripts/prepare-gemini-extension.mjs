import {generateKeyPairSync,createHash,randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
process.umask(0o077);
const target=resolve('.runtime/gemini-extension');await mkdir(target,{recursive:true});
let connection;
try{connection=JSON.parse(await readFile(target+'/setup.json','utf8'));}catch{
  const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const der=publicKey.export({type:'spki',format:'der'});
  const id=[...createHash('sha256').update(der).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
  connection={id,key:der.toString('base64'),token:randomBytes(32).toString('hex'),port:3152};
  await writeFile(target+'/setup.json',JSON.stringify(connection),{mode:0o600});
}
const manifest=JSON.parse(await readFile('apps/gemini-extension/manifest.json','utf8'));manifest.key=connection.key;
await writeFile(target+'/manifest.json',JSON.stringify(manifest,null,2));
for(const name of ['worker.js','page.js'])await copyFile('apps/gemini-extension/'+name,target+'/'+name);
await writeFile(target+'/connection.js','export const endpoint='+JSON.stringify('http://127.0.0.1:'+connection.port)+',token='+JSON.stringify(connection.token)+';\n',{mode:0o600});
console.log(JSON.stringify({extension_id:connection.id,directory:target}));
