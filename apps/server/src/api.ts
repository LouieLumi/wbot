import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual,randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import type { Bridge } from './bridge.js';
import {archivedGroup,dashboard,jobPage} from './admin-data.js';
import {AdminAuth,sessionSeconds} from './admin-auth.js';
export async function createApi(config:Config,bridge:Bridge) {
  const app=Fastify({logger:{level:'info',redact:['req.headers.authorization','req.body','res.body']},disableRequestLogging:true,bodyLimit:32_768});
  await app.register(websocket,{options:{maxPayload:4096}});
  await app.register(rateLimit,{max:120,timeWindow:'1 minute'});
  const tickets=new Map<string,number>(),auth=new AdminAuth(bridge.store.db);
  const publicPaths=new Set(['/','/admin.js','/admin.css','/api/auth/exchange','/api/auth/login']);
  app.addHook('onRequest',async(req,res)=>{
    res.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    res.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host=req.headers.host??'';
    if(!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))return res.code(403).send({error:'host_disallowed'});
    if((req.headers.origin&&req.headers.origin!=='http://'+host)||req.headers['sec-fetch-site']==='cross-site')return res.code(403).send({error:'browser_origin_disallowed'});
    if(publicPaths.has(req.url.split('?')[0]!))return;
    const expected=Buffer.from('Bearer '+config.BRIDGE_API_TOKEN), supplied=Buffer.from(req.headers.authorization??'');
    const cookie=/(?:^|;\s*)bridge_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie??'')?.[1];
    const tokenValid=expected.length===supplied.length&&timingSafeEqual(expected,supplied);
    if(!tokenValid&&!(cookie&&auth.validSession(cookie)))return res.code(401).send({error:'unauthorized'});
  });
  app.setErrorHandler((error,_,res)=>{
    if(error instanceof z.ZodError)return res.code(400).send({error:'invalid_request'});
    const code=error instanceof Error?error.message:'';
    if(code==='idempotency_conflict')return res.code(409).send({error:code});
    if(code==='chat_not_allowed'||code==='chat_not_verified')return res.code(403).send({error:code});
    if(['pause_before_registration','device_busy'].includes(code))return res.code(409).send({error:code});
    if(['group_not_found','member_not_found'].includes(code))return res.code(404).send({error:code});
    if(code==='model_not_installed')return res.code(400).send({error:code});
    if(['memory_limit','hermes_memory_write_rejected'].includes(code))return res.code(400).send({error:code});
    if(code==='group_archived')return res.code(409).send({error:code});
    const status=(error as {statusCode?:number}).statusCode;
    return res.code(status&&status>=400&&status<500?status:503).send({error:status===429?'rate_limited':'operation_unavailable'});
  });
  app.get('/',async(_,res)=>res.type('text/html; charset=utf-8').send(await readFile('apps/admin/index.html')));
  app.get('/admin.js',async(_,res)=>res.type('text/javascript; charset=utf-8').send(await readFile('apps/admin/admin.js')));
  app.get('/admin.css',async(_,res)=>res.type('text/css; charset=utf-8').send(await readFile('apps/admin/admin.css')));
  app.post('/api/admin/ticket',async()=>{
    for(const [key,expiry] of tickets)if(expiry<Date.now())tickets.delete(key);
    if(tickets.size>20)tickets.delete(tickets.keys().next().value!);
    const ticket=randomBytes(32).toString('hex');tickets.set(ticket,Date.now()+60_000);return {ticket};
  });
  app.post('/api/auth/exchange',async(req,res)=>{
    const {ticket}=z.object({ticket:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    const expires=tickets.get(ticket);tickets.delete(ticket);if(!expires||expires<Date.now())return res.code(401).send({error:'ticket_expired'});
    const session=auth.issueSession();
    res.header('Set-Cookie',`bridge_session=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}`);return {ok:true};
  });
  app.post('/api/auth/login',{config:{rateLimit:{max:5,timeWindow:'1 minute'}}},async(req,res)=>{
    const {password}=z.object({password:z.string().min(1).max(256)}).strict().parse(req.body);
    if(!await auth.verifyPassword(password))return res.code(401).send({error:'invalid_password'});
    const old=/(?:^|;\s*)bridge_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie??'')?.[1];
    if(old)auth.revokeSession(old);
    res.header('Set-Cookie',`bridge_session=${auth.issueSession()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionSeconds}`);
    return {ok:true};
  });
  app.post('/api/auth/logout',async(req,res)=>{
    const cookie=/(?:^|;\s*)bridge_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie??'')?.[1];if(cookie)auth.revokeSession(cookie);
    res.header('Set-Cookie','bridge_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return {ok:true};
  });
  app.get('/api/health',async()=>({ok:true,mode:config.WECHAT_DEVICE_MODE,paused:bridge.paused,auto_reply:bridge.autoReply,
    voice:bridge.voiceStatus(),image:bridge.imageStatus(),replies:bridge.replyStatus(),web_search:config.HERMES_WEB_SEARCH,
    memory:{provider:bridge.memory.backend?'hermes':'local',scope:'member'},
    group_memory:{enabled:Boolean(bridge.driver.groupHistory),scope:'group',groups:bridge.groupMemory.states().map(g=>bridge.groupMemory.stats(g.chat_id))},
    reliability:bridge.lastReliability,last_error:bridge.lastError,ai_provider:config.AI_PROVIDER,
    ai_model:config.AI_PROVIDER!=='openclaw'?bridge.models.default():config.OPENCLAW_AGENT_ID,
    openclaw_configured:config.OPENCLAW_ENDPOINT_VERIFIED&&config.OPENCLAW_AGENT_RESTRICTED&&Boolean(config.OPENCLAW_TOKEN)}));
  app.get('/api/device/status',async()=>bridge.driver.status());
  app.get('/api/wechat/status',async()=>bridge.driver.status());
  app.get('/api/chats',async()=>({chats:await bridge.driver.chats(),scope:'verified_configured_chats'}));
  app.get('/api/groups',async()=>({chats:(await bridge.driver.chats()).filter(c=>c.type==='group'),scope:'verified_configured_chats'}));
  const send=z.object({chat_id:z.string().min(1).max(128).optional(),chat_name:z.string().min(1).max(128).optional(),chat_type:z.enum(['group','private']).optional(),content:z.string().min(1).max(4000)}).strict();
  app.post('/api/messages/send',async(req,res)=>{
    const body=send.parse(req.body);let id=body.chat_id;
    if(!id){const matches=(await bridge.driver.chats()).filter(c=>c.verified&&c.name===body.chat_name&&c.type===body.chat_type);if(matches.length!==1)return res.code(409).send({error:'ambiguous_or_unknown_chat_use_chat_id'});id=matches[0]!.id;}
    const idem=z.string().min(1).max(128).optional().parse(req.headers['idempotency-key']);
    const job=await bridge.enqueue(id,body.content,idem);return res.code(202).send(job);
  });
  for(const path of ['/api/messages/at','/api/messages/image'])app.post(path,async(_,res)=>res.code(501).send({error:'not_supported_in_mvp'}));
  app.post('/api/messages/recover-reply',async req=>{
    const body=z.object({chat_id:z.string().regex(/^[\w-]+@chatroom$/),message_id:z.string().min(1).max(200)}).strict().parse(req.body);
    return bridge.recoverQuotedReply(body.chat_id,body.message_id);
  });
  app.get('/api/jobs/:id',async(req,res)=>{const {id}=z.object({id:z.string().uuid()}).parse(req.params);const job=bridge.store.job(id);return job??res.code(404).send({error:'job_not_found'});});
  app.post('/api/control',async(req)=>{const body=z.object({paused:z.boolean(),auto_reply:z.boolean().optional()}).strict().parse(req.body);bridge.control(body.paused,body.auto_reply);if(body.paused)await bridge.deviceIdle();return {paused:bridge.paused,auto_reply:bridge.autoReply,device_busy:bridge.deviceBusy};});
  app.get('/api/admin/state',async()=>{
    let groups,deviceError=bridge.lastError;
    try{groups=await bridge.groups();}catch{groups=bridge.memory.groups().map(g=>({...g,verified:false}));deviceError='device_unavailable_or_unverified';}
    return {mode:config.WECHAT_DEVICE_MODE,ai_provider:config.AI_PROVIDER,can_register:Boolean(bridge.driver.register),paused:bridge.paused,device_busy:bridge.deviceBusy,auto_reply:bridge.autoReply,reliability:bridge.lastReliability,last_error:deviceError,active_chat:bridge.activeChat,
      default_model:bridge.models.default(),reasoning_effort:bridge.models.reasoning(),model_source:bridge.models.source(),bot_name:config.WECHAT_BOT_NAME,wechat_admin:bridge.wechatAdmin.state,...dashboard(bridge.store,config.WECHAT_DEVICE_MODE,groups),
      jobs:jobPage(bridge.store,config.WECHAT_DEVICE_MODE,{page:1,page_size:6,scope:'current'}).items};
  });
  app.get('/api/admin/jobs',async(req)=>{
    const query=z.object({page:z.coerce.number().int().min(1).max(1_000_000).default(1),page_size:z.coerce.number().int().min(1).max(100).default(20),scope:z.enum(['current','archived','all']).default('current'),state:z.enum(['queued','running','sent','failed','uncertain']).optional(),chat_id:z.string().max(128).optional(),search:z.string().trim().max(128).optional()}).strict().parse(req.query);
    return jobPage(bridge.store,config.WECHAT_DEVICE_MODE,query);
  });
  app.get('/api/admin/models',async()=>({models:await bridge.models.list(),default_model:bridge.models.default(),reasoning_effort:bridge.models.reasoning(),model_source:bridge.models.source()}));
  app.patch('/api/admin/settings',async(req)=>{const body=z.object({default_model:z.string().min(1).max(128),reasoning_effort:z.enum(['auto','low','medium','high']).optional()}).strict().parse(req.body);await bridge.models.validate(body.default_model);bridge.store.set('default_model',body.default_model);if(body.reasoning_effort!==undefined)bridge.store.set('reasoning_effort',body.reasoning_effort);return {ok:true};});
  app.post('/api/admin/groups',async(req)=>{const {name}=z.object({name:z.string().trim().min(1).max(128)}).strict().parse(req.body);return bridge.register(name);});
  const groupParams=z.object({id:z.string().min(1).max(128)});
  app.patch('/api/admin/groups/:id',async(req)=>{
    const {id}=groupParams.parse(req.params);const body=z.object({enabled:z.boolean().optional(),model:z.string().max(128).optional(),paused:z.boolean().optional()}).strict().parse(req.body);
    if(archivedGroup(config.WECHAT_DEVICE_MODE,id))throw new Error('group_archived');
    if(body.model!==undefined)await bridge.models.validate(body.model);await bridge.groupPatch(id,body);return {ok:true};
  });
  app.get('/api/admin/groups/:id/members',async(req)=>{const {id}=groupParams.parse(req.params);return {members:bridge.memory.members(id)};});
  app.get('/api/admin/groups/:id/history',async(req)=>{const {id}=groupParams.parse(req.params);if(!bridge.memory.group(id))throw new Error('group_not_found');return {stats:bridge.groupMemory.stats(id),messages:bridge.groupMemory.recent(id)};});
  app.get('/api/admin/members',async()=>({members:bridge.memory.allMembers()}));
  const memberParams=z.object({id:z.string().min(1).max(128),member:z.string().min(1).max(128)});
  app.get('/api/admin/groups/:id/members/:member',async(req,res)=>{const {id,member}=memberParams.parse(req.params);const value=bridge.memory.member(id,member);return value?{member:value,history:bridge.memory.history(id,member)}:res.code(404).send({error:'member_not_found'});});
  app.patch('/api/admin/groups/:id/members/:member',async(req)=>{const {id,member}=memberParams.parse(req.params);const body=z.object({notes:z.string().max(8000).optional(),summary:z.string().max(8000).optional(),model:z.string().max(128).optional(),enabled:z.boolean().optional()}).strict().parse(req.body);if(body.model!==undefined)await bridge.models.validate(body.model);bridge.memory.patch(id,member,body);return {ok:true};});
  app.post('/api/admin/groups/:id/members/:member/reset',async(req)=>{const {id,member}=memberParams.parse(req.params);const {notes}=z.object({notes:z.boolean().default(true)}).strict().parse(req.body??{});bridge.memory.reset(id,member,notes);return {ok:true};});
  const sockets=new Set<WebSocket>();
  app.get('/api/events',{websocket:true},socket=>{
    sockets.add(socket);socket.on('error',()=>sockets.delete(socket));socket.on('close',()=>sockets.delete(socket));
    socket.send(JSON.stringify({event:'bridge.connected',replay:false}));
  });
  const broadcast=(event:unknown)=>{for(const s of sockets)if(s.readyState===1){if(s.bufferedAmount>1_000_000){s.terminate();continue;}s.send(JSON.stringify(event));}};
  bridge.on('event',broadcast);
  app.addHook('onClose',async()=>{for(const s of sockets)s.terminate();bridge.off('event',broadcast);await bridge.close();});
  return app;
}
