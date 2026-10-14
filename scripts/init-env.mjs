import {existsSync,readFileSync,writeFileSync,copyFileSync,mkdirSync,constants} from 'node:fs';
import {randomBytes} from 'node:crypto';

if(existsSync('.env')) {
  console.log('.env already exists; left unchanged.');
} else {
  const template=readFileSync('.env.example','utf8');
  writeFileSync('.env',template.replace(/^BRIDGE_API_TOKEN=$/m,'BRIDGE_API_TOKEN='+randomBytes(32).toString('hex')),{mode:0o600,flag:'wx'});
  console.log('Created private .env with a random token.');
}
mkdirSync('config',{recursive:true});
if(!existsSync('config/wechat-profile.json')) {
  copyFileSync('config/wechat-profile.example.json','config/wechat-profile.json',constants.COPYFILE_EXCL);
  console.log('Created an unconfigured device profile.');
}
