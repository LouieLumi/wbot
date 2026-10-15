export type ChatType = 'group' | 'private';
export interface Chat { id: string; name: string; type: ChatType; verified: boolean }
export interface Message {
  event: 'message.received'; message_id: string; chat_id: string; chat_name: string;
  chat_type: ChatType; sender: string | null; content: string;
  own: boolean | null; mention: 'verified' | 'text' | 'none' | 'unknown'; timestamp: number;
  member_id?: string; avatar_hash?: string; sender_wxid?: string;
}
export interface Row { key: string; sender: string | null; content: string; own: boolean | null; mention: Message['mention']; avatar_hash?:string }
export interface Snapshot { chat: Chat | null; rows: Row[]; reliability: string }
export type JobState = 'queued' | 'running' | 'sent' | 'failed' | 'uncertain';
export interface SendResult { state: 'sent' | 'failed' | 'uncertain'; reason: string }
export interface GeneratedImage {mime_type:'image/png'|'image/jpeg'|'image/webp';data:Uint8Array}
export interface SignupRequest { request_id:string; chat_id:string; chat_name:string; requested_at:number }
export interface GroupText {local_id:number;sender_id:string;sender:string;content:string;timestamp:number;truncated:boolean}
export interface GroupHistory {chat_id:string;source:string;cursor:number;has_more:boolean;messages:GroupText[]}
export interface Job { id: string; chat_id: string; content: string; state: JobState; reason: string; created_at: number; updated_at: number }
export interface DeviceAdapter {
  status(): Promise<Record<string, unknown>>;
  chats(): Promise<Chat[]>;
  snapshot(chat?:Chat): Promise<Snapshot>;
  register?(name:string):Promise<Chat>;
  pollEvents?(): Promise<{messages:Message[];reliability:string}>;
  groupHistory?(chat:string,since:number,after:number,source:string):Promise<GroupHistory>;
  resetEvents?(): void;
  signupRequests?():Promise<SignupRequest[]>;
  acknowledgeSignup?(request:SignupRequest):Promise<SendResult>;
  setAuthorized?(ids:string[]):Promise<void>;
  resolveAccount?(wechatId:string):Promise<string|null>;
  send(chat: Chat, content: string, id?:string): Promise<SendResult>;
  sendImage?(chat:Chat,image:GeneratedImage,id:string):Promise<SendResult>;
  close?(): Promise<void>;
}
