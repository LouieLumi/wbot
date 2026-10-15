import type {Config} from './config.js';
import type {Store} from './store.js';
import type {Group} from './memory.js';

export const archivedGroup=(mode:Config['WECHAT_DEVICE_MODE'],id:string)=>mode==='android_hook'&&!id.endsWith('@chatroom');

export function dashboard(store:Store,mode:Config['WECHAT_DEVICE_MODE'],groups:Group[]){
  const day=new Date();day.setHours(0,0,0,0);
  const counts=new Map((store.db.prepare('SELECT chat_id,count(*) AS members FROM members GROUP BY chat_id').all() as {chat_id:string;members:number}[]).map(r=>[r.chat_id,r.members]));
  const decorated=groups.map(g=>({...g,member_count:counts.get(g.id)??0}));
  const current=decorated.filter(g=>!archivedGroup(mode,g.id));
  const archived=decorated.filter(g=>archivedGroup(mode,g.id));
  const ids=current.map(g=>g.id),params=ids.map(()=>'?').join(',');
  const totals=ids.length?store.db.prepare(`SELECT
    coalesce(sum(state='sent' AND updated_at>=?),0) AS sent_today,
    coalesce(sum(state IN ('failed','uncertain') AND updated_at>=?),0) AS failed_today,
    coalesce(sum(state IN ('queued','running')),0) AS pending
    FROM jobs WHERE chat_id IN (${params})`).get(day.getTime(),day.getTime(),...ids):{sent_today:0,failed_today:0,pending:0};
  const memberCount=ids.length?(store.db.prepare(`SELECT count(DISTINCT CASE WHEN id LIKE 'wxid:%' THEN id ELSE chat_id||':'||id END) n FROM members WHERE chat_id IN (${params})`).get(...ids) as {n:number}).n:0;
  return {groups:current,archived_groups:archived,stats:{...totals,groups:current.length,authorized:current.filter(g=>g.enabled).length,members:memberCount}};
}

export function jobPage(store:Store,mode:Config['WECHAT_DEVICE_MODE'],query:{page:number;page_size:number;scope:'current'|'archived'|'all';state?:string;chat_id?:string;search?:string}){
  const where:string[]=[],args:(string|number)[]=[];
  if(query.scope!=='all'){
    if(mode==='android_hook')where.push(`j.chat_id ${query.scope==='current'?'LIKE':'NOT LIKE'} '%@chatroom'`);
    else if(query.scope==='archived')where.push('0');
  }
  if(query.state){where.push('j.state=?');args.push(query.state);}
  if(query.chat_id){where.push('j.chat_id=?');args.push(query.chat_id);}
  if(query.search){where.push('(instr(lower(coalesce(g.name,\'\')),lower(?))>0 OR instr(lower(j.id),lower(?))>0)');args.push(query.search,query.search);}
  const filter=where.length?' WHERE '+where.join(' AND '):'';
  const total=Number((store.db.prepare('SELECT count(*) AS total FROM jobs j LEFT JOIN groups g ON g.id=j.chat_id'+filter).get(...args) as {total:number}).total);
  const pages=Math.max(1,Math.ceil(total/query.page_size)),page=Math.min(query.page,pages);
  const items=store.db.prepare(`SELECT j.id,j.chat_id,g.name AS chat_name,j.state,j.reason,j.created_at,j.updated_at FROM jobs j LEFT JOIN groups g ON g.id=j.chat_id${filter} ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?`).all(...args,query.page_size,(page-1)*query.page_size);
  return {items,total,page,pages,page_size:query.page_size};
}
