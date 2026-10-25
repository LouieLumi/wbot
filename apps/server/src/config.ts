import { z } from 'zod';
const flag = z.enum(['true', 'false']).transform(v => v === 'true');
const schema = z.object({
  BRIDGE_HOST: z.enum(['127.0.0.1', '::1']).default('127.0.0.1'),
  BRIDGE_PORT: z.coerce.number().int().min(1024).max(65535).default(3100),
  BRIDGE_API_TOKEN: z.string().min(32), BRIDGE_DB: z.string().default('data/bridge.sqlite'),
  WECHAT_DEVICE_MODE: z.enum(['mock', 'adb', 'android_hook']).default('adb'),
  WECHAT_HOOK_BASE_URL: z.string().url().default('http://127.0.0.1:3151'),
  WECHAT_HOOK_TOKEN: z.string().default(''),
  WECHAT_ADMIN_ID: z.string().regex(/^[A-Za-z0-9_.-]{0,128}$/).default(''),
  WECHAT_DEVICE_SERIAL: z.string().regex(/^[\w.:-]+$/).default('emulator-5556'),
  ADB_SERVER_PORT: z.coerce.number().int().min(1024).max(65535).default(5038),
  WECHAT_PROFILE: z.string().default('config/wechat-profile.json'),
  WECHAT_ALLOWED_CHAT_IDS: z.string().default('[]').transform((v, ctx) => {
    try { return z.array(z.string().min(1)).parse(JSON.parse(v)); }
    catch { ctx.addIssue({code:'custom', message:'Expected JSON string array'}); return z.NEVER; }
  }),
  WECHAT_AUTO_REPLY: flag.default(false),
  WECHAT_REPLY_MODE: z.enum(['verified_mention', 'text_mention']).default('verified_mention'),
  WECHAT_BOT_NAME: z.string().min(1).default('Gemini'),
  WECHAT_POLL_MS: z.coerce.number().int().min(500).default(3000),
  AI_PROVIDER: z.enum(['openclaw','ollama','hermes']).default('openclaw'),
  HERMES_API_BASE_URL: z.union([z.literal(''),z.string().url()]).default(''),
  HERMES_API_KEY: z.string().default(''),
  HERMES_MODEL: z.string().min(1).default('gemini-3.8-flash-high'),
  IMAGE_MODEL: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).default('gemini-3.1-flash-image'),
  IMAGE_PROVIDER: z.enum(['proxy','gemini_web']).default('proxy'),
  GEMINI_WEB_PORT: z.coerce.number().int().min(1024).max(65535).default(3152),
  GEMINI_WEB_TOKEN: z.string().default(''),
  GEMINI_WEB_EXTENSION_ID: z.string().default(''),
  HERMES_WEB_SEARCH: flag.default(false),
  VOICE_ENABLED: flag.default(false),
  VOICE_PYTHON: z.string().default('.runtime/voice-venv/bin/python'),
  VOICE_MODEL_PATH: z.string().default('.runtime/voice/models/base'),
  VOICE_REFERENCE: z.string().default('data/voice/gemini.wav'),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_MODEL: z.string().min(1).default('qwen3.5:4b'),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(120_000),
  OPENCLAW_BASE_URL: z.string().url().default('http://127.0.0.1:18789'),
  OPENCLAW_TOKEN: z.string().default(''), OPENCLAW_AGENT_ID: z.string().regex(/^[\w-]+$/).default('wechat-bot'),
  OPENCLAW_ENDPOINT_VERIFIED: flag.default(false), OPENCLAW_AGENT_RESTRICTED: flag.default(false),
});
export type Config = z.infer<typeof schema>;
export const readConfig = (env: Record<string, unknown> = process.env): Config => {
  const c = schema.parse(env);
  if(c.IMAGE_PROVIDER==='gemini_web'&&(!/^[a-f0-9]{64}$/.test(c.GEMINI_WEB_TOKEN)||!/^[a-p]{32}$/.test(c.GEMINI_WEB_EXTENSION_ID)))throw new Error('Gemini web worker configuration missing');
  if(c.WECHAT_DEVICE_MODE==='android_hook'&&!/^[a-f0-9]{64}$/.test(c.WECHAT_HOOK_TOKEN))throw new Error('Android hook token missing');
  if(c.HERMES_API_BASE_URL&&!c.HERMES_API_KEY)throw new Error('Hermes proxy key missing');
  for(const base of [c.OPENCLAW_BASE_URL,c.OLLAMA_BASE_URL,c.WECHAT_HOOK_BASE_URL,...(c.HERMES_API_BASE_URL?[c.HERMES_API_BASE_URL]:[])]) {
    const url = new URL(base);
    if (!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('AI endpoint must use a local HTTP URL without credentials');
  }
  return c;
};
