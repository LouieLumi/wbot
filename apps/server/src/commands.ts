import type {Memories,Member} from './memory.js';
import type {Models} from './models.js';

const features=['/img 提示词 — 在我的生图对话中生成图片','/newimg — 删除旧生图对话并新建','/signup — 申请群使用权限'];
const personal=['/memory — 查看我的记忆状态','/remember 内容 — 添加我的长期记忆','/forget — 清空我的长期记忆','/reset — 重置我的全部记忆'];
const management=['/models — 查看模型列表','/model 模型名 — 切换本群模型','/model default — 本群跟随默认模型','/status — 查看本群状态','/new — 新建我的会话','/stop — 停用本群回复','/start — 启用本群回复'];
export const memberHelp=['Gemini · 功能菜单',...features,'','我的记忆',...personal,'','/help 或 /menu — 查看菜单'].join('\n');
export const commandHelp=['Gemini · 管理员菜单',...features,'','群聊管理',...management,'','我的记忆',...personal,'','/help 或 /menu — 查看全部菜单'].join('\n');
const restricted=new Set(['models','model','status','new','stop','start']);
export async function command(input:string,member:Member,memory:Memories,models:Models,admin=false):Promise<string|null>{
  const match=/^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if(!match)return input.startsWith('/')?'未知命令，请发 /help。':null;
  const name=match[1]!.toLowerCase(),arg=(match[2]??'').trim(),chat=member.chat_id,id=member.id;
  if(restricted.has(name)&&!admin)return '此命令仅管理员可用。发 /help 查看你的菜单。';
  switch(name){
    case 'verify':return admin?'管理员身份已确认。发 /help 查看全部菜单。':'核验码无效或已过期。';
    case 'help':case 'menu':return admin?commandHelp:memberHelp;
    case 'img':return '用法：/img 提示词\n例如：/img 一只坐在月亮上的白猫，水彩风格';
    case 'newimg':if(arg)return '用法：/newimg';memory.newImageSession(chat,id);return '已切换到你的新生图对话，下次 /img 将从这里开始。';
    case 'signup':return '本群已获授权。';
    case 'models':return ['可用模型',...(await models.list()).slice(0,30).map(m=>m.name),'','/model 模型名 — 切换本群模型'].join('\n');
    case 'model':
      if(!arg)return '本群模型：'+(memory.group(chat)?.model||models.default());
      await models.validate(arg==='default'?'':arg);memory.groupModel(chat,arg==='default'?'':arg);
      return '本群模型已切换为 '+(arg==='default'?models.default():arg)+'，记忆保留。';
    case 'new':memory.reset(chat,id,false);return '已新建你的会话，长期记忆保留，所有群同步生效。';
    case 'reset':memory.reset(chat,id,true);return '已重置你的上下文和长期记忆，所有群同步生效。';
    case 'remember':
      if(!arg)return '用法：/remember 希望我记住的内容';
      if((member.notes+'\n'+arg).length>8000)return '成员资料已达上限，请在后台整理后再添加。';
      memory.patch(chat,id,{notes:[member.notes,arg].filter(Boolean).join('\n§\n')});return '已记入你的长期记忆，所有群共享。';
    case 'forget':memory.patch(chat,id,{notes:'',summary:''});return '已清空你的长期记忆，所有群同步生效，对话上下文保留。';
    case 'memory':return `你的记忆${member.memory_scope==='member'?' · 跨群共享':''}\n管理：${member.memory_backend==='hermes'?'Hermes':'本地'}\n已保存对话：${Math.floor((member.turn_count??memory.history(chat,id).length)/2)} 轮\n成员资料：${member.notes.length} 字\n长期笔记：${member.summary?.length??0} 字`;
    case 'status':return `本群状态：${memory.group(chat)?.paused?'已停用':'运行中'}\n模型：${memory.group(chat)?.model||models.default()}`;
    case 'stop':memory.groupControl(chat,true);return '已停用本群回复。发 /start 恢复。';
    case 'start':memory.groupControl(chat,false);return '已启用本群回复。';
    default:return '未知命令，请发 /help 查看菜单。';
  }
}
