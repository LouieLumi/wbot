import {readFile,writeFile} from 'node:fs/promises';
import {readConfig} from '../dist/apps/server/src/config.js';
import {GeminiWebImages,createGeminiWorker} from '../dist/apps/server/src/gemini-web.js';
const setup=JSON.parse(await readFile('.runtime/gemini-extension/setup.json','utf8'));
const config=readConfig({BRIDGE_API_TOKEN:'t'.repeat(64),IMAGE_PROVIDER:'gemini_web',GEMINI_WEB_TOKEN:setup.token,GEMINI_WEB_EXTENSION_ID:setup.id});
const images=new GeminiWebImages(),app=createGeminiWorker(config,images);
let traceCount=0;
app.addHook('preHandler',async req=>{if(req.method==='POST'&&traceCount++<12)console.log(JSON.stringify({path:req.url,ready:req.body?.ready,id:req.body?.id}));});
await app.listen({host:'127.0.0.1',port:setup.port});console.log('Waiting for the Gemini extension on port '+setup.port);
let started=false;
const timer=setInterval(async()=>{
 if(started||!images.status().connected)return;started=true;
 try{
  const image=await images.generate('白色背景，一只紫色的小鲸鱼戴着黄色小帽子，简洁水彩插画。',new AbortController().signal);
  const file='.runtime/gemini-membership/extension-test.'+(image.mime_type==='image/png'?'png':image.mime_type==='image/jpeg'?'jpg':'webp');
  await writeFile(file,image.data);
  const result={ok:true,file,bytes:image.data.length,mime_type:image.mime_type};
  await writeFile('.runtime/gemini-membership/extension-test.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){console.log(JSON.stringify({ok:false,error:e.message,status:images.status()}));}
},2000);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{clearInterval(timer);await app.close();process.exit(0);});
