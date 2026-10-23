import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {parseEnv} from 'node:util';
import {spawn} from 'node:child_process';
import {z} from 'zod';
import {readConfig} from '../../server/src/config.js';
import {readArticle, translateRich, type TranslationModel} from './articles.js';
import {readImage} from './media.js';
import {ChannelApi} from './client.js';
import {PrivatePhone} from './phone.js';
import {LinkPublisher} from './publisher.js';
import {BridgeSettings} from './bridge-settings.js';

process.umask(0o077);
const path = resolve(process.env.LINK_PUBLISHER_CONFIG || 'data/link-publisher/config.json');
const settings = z.object({
  bot_id: z.string().min(1), secret: z.string().min(1),
  topic_id: z.string().min(1), topic_name: z.string().min(1),
  wechat_accounts: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/)).min(1).max(20),
  bridge_root: z.string().min(1),
  translation_model: z.string().min(1).max(200).optional(),
  pairing: z.object({content: z.string().regex(/^绑定发帖 [a-f0-9]{8}$/), issued_at: z.number(), expires_at: z.number()}).optional(),
}).parse(JSON.parse(readFileSync(path, 'utf8')));
const bridgeRoot = resolve(settings.bridge_root);
const config = readConfig(parseEnv(readFileSync(join(bridgeRoot, '.env'), 'utf8')));
if (config.WECHAT_DEVICE_MODE !== 'android_hook') throw new Error('private_links_require_android_hook');
const bridgeSettings = new BridgeSettings(resolve(bridgeRoot, config.BRIDGE_DB));
bridgeSettings.refresh();
const setting = (key: string) => bridgeSettings.get(key);
const enabled = () => bridgeSettings.enabled();
const translationModel = () => settings.translation_model || setting('default_model') ||
  (config.HERMES_API_BASE_URL ? config.HERMES_MODEL : config.OLLAMA_MODEL);
const translationReasoning = (): TranslationModel['reasoningEffort'] => {
  const value = setting('reasoning_effort');
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'auto';
};
const api = new ChannelApi(settings);
const storage = dirname(path); mkdirSync(storage, {recursive: true, mode: 0o700});
const binding = JSON.parse(setting('wechat_admin_binding') || 'null');
const pins = binding?.wechat_id === config.WECHAT_ADMIN_ID && Number.isFinite(binding?.verified_at) &&
  typeof binding?.username === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(binding.username)
  ? {[binding.wechat_id]: binding.username} : {};
const identityFile = join(storage, 'verified-identity.json');
if (existsSync(identityFile)) {
  const identity = JSON.parse(readFileSync(identityFile, 'utf8'));
  if (settings.wechat_accounts.includes(identity.account) && Number.isFinite(identity.verified_at) &&
      identity.method === 'private_pairing' && typeof identity.username === 'string' &&
      /^[A-Za-z0-9_.-]{1,128}$/.test(identity.username)) pins[identity.account] = identity.username;
}
const phone = new PrivatePhone(config, join(bridgeRoot, '.runtime/android-sdk/platform-tools/adb'), settings.wechat_accounts, pins);
let publisher: LinkPublisher | undefined, ticking = false, stopped = false, lastError = '', lastLog = '', justPaired = false;
const started = Date.now();
function status() {
  writeFileSync(join(storage, 'status.json'), JSON.stringify({started_at: started, checked_at: Date.now(),
    ready: Boolean(publisher) && !lastError, paused: !enabled(), error: lastError, target: settings.topic_name,
    translation_model: translationModel(), translation_reasoning: translationReasoning(),
    publishing_format: 'rich_sections',
    requests: publisher?.summary() ?? []}), {mode: 0o600});
  if (lastError !== lastLog) { console.log(JSON.stringify({event: lastError || 'ready', at: Date.now()})); lastLog = lastError; }
}
async function tick() {
  if (ticking || stopped) return; ticking = true;
  try {
    if (!bridgeSettings.refresh()) throw new Error('bridge_settings_busy');
    try { await phone.prepare(); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'private_account_not_verified' ||
          !settings.pairing || settings.pairing.expires_at < Date.now()) throw error;
      const identity = await phone.pair(settings.pairing.content, settings.pairing.issued_at);
      if (!identity) throw new Error('awaiting_private_pairing');
      writeFileSync(identityFile, JSON.stringify(identity), {mode: 0o600});
      await phone.prepare();
      justPaired = true;
      console.log('{"event":"private_identity_verified"}');
    }
    if (!publisher) {
      await api.verifyChannel(settings.topic_id, settings.topic_name);
      publisher = new LinkPublisher(join(storage, 'requests.sqlite'), settings.topic_name, phone.users, {
        read: readArticle, enabled,
        translate: (article, onRetry) => translateRich(article, {
          baseUrl: config.HERMES_API_BASE_URL || new URL('/v1', config.OLLAMA_BASE_URL).href,
          apiKey: config.HERMES_API_KEY || 'local-ollama',
          model: translationModel(),
          reasoningEffort: translationReasoning(),
        }, fetch, {onRetry: event => {
          console.log(JSON.stringify({event: 'translation_retry', ...event}));
          onRetry?.();
        }}),
        verifyChannel: () => api.verifyChannel(settings.topic_id, settings.topic_name),
        uploadImage: async image => api.uploadImage(await readImage(image.url)),
        publish: (text, root, images) => api.publish(settings.topic_id, text, root, images),
        verifyPost: (id, text, imageCount) => api.verifyPost(settings.topic_id, id, text, imageCount),
        notify: (user, text, id) => phone.send(user, text, id),
      }, settings.pairing?.issued_at ?? started);
      if (justPaired) publisher.paired(phone.users[0]!);
      console.log(JSON.stringify({event: 'private_links_started', target: settings.topic_name}));
    }
    if (enabled()) {
      for (const user of phone.users) {
        const cursor = JSON.parse(publisher.get('cursor:' + user) || '{"source":"","after":0}');
        const batch = await phone.history(user, publisher.since, cursor.after, cursor.source);
        for (const message of batch.messages) publisher.receive({...message, chat_type: 'private'});
        publisher.set('cursor:' + user, JSON.stringify({source: batch.source, after: batch.cursor}));
      }
      await publisher.notifyNext();
      void publisher.runNext().catch(() => console.log('{"event":"publisher_internal_error"}'));
    }
    lastError = '';
  } catch (error) {
    lastError = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'publisher_transport_unavailable';
  } finally { ticking = false; status(); }
}
const awake = process.platform === 'darwin' ? spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], {stdio: 'ignore'}) : undefined;
awake?.on('error', () => {});
const timer = setInterval(() => void tick(), 3000);
await tick();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopped = true; clearInterval(timer); awake?.kill();
  // SQLite records protect an in-flight post from replay if shutdown interrupts it.
  process.exit(0);
});
