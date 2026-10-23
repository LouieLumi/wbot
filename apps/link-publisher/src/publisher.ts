import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {extractUrls, channelParts, ArticleError, type Article} from './articles.js';
import {WecomError} from './client.js';
import {richChannelParts, escapeMarkdown, type ArticleImage, type RichTranslation} from './layout.js';

export type PrivateMessage = {
  message_id: string; user_id: string; content: string; timestamp: number; chat_type: 'private' | 'group';
};
type Job = {id: string; user_id: string; url: string; state: string; created_at: number; expires_at: number; error: string};
type Part = {job_id: string; ordinal: number; content: string; images: string; delivery_content: string; state: string; remote_id: string};
export type PublisherPorts = {
  enabled?: () => boolean;
  read(url: string): Promise<Article>;
  translate(article: Article, onRetry?: () => void): Promise<string | RichTranslation>;
  uploadImage?(image: ArticleImage): Promise<string>;
  verifyChannel(): Promise<void>;
  publish(content: string, postId?: string, imageIds?: string[]): Promise<string>;
  verifyPost(id: string, content: string, imageCount?: number): Promise<boolean>;
  notify(user: string, text: string, id: string): Promise<'sent' | 'failed' | 'uncertain'>;
  pause?: () => Promise<void>;
};
const labels: Record<string, string> = {pending: '待确认', queued: '排队中', processing: '翻译中',
  ready: '准备发布', publishing: '发布中', sent: '已发布', failed: '失败', partial: '部分已发布',
  uncertain: '发送结果待核实', cancelled: '已取消', expired: '已过期'};

export class LinkPublisher {
  readonly db: DatabaseSync;
  private running = false;
  private notifying = false;
  readonly since: number;
  constructor(path: string, readonly channelName: string, private users: string[], private ports: PublisherPorts, enabledSince = Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,url TEXT NOT NULL,
        state TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,error TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS parts(job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,content TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',remote_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(job_id,ordinal));
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,content TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL);
      UPDATE requests SET state='queued' WHERE state='processing';
      UPDATE requests SET state='uncertain',error='interrupted_send' WHERE state='publishing'
        AND id IN (SELECT job_id FROM parts WHERE state='sending');
      UPDATE requests SET state='ready' WHERE state='publishing';
      UPDATE notices SET state='queued' WHERE state='sending';`);
    const columns = this.db.prepare('PRAGMA table_info(parts)').all() as {name: string}[];
    for (const [name, value] of [['images', '[]'], ['delivery_content', '']]) {
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE parts ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${value}'`);
    }
    this.since = Number(this.get('enabled_since') || enabledSince); this.set('enabled_since', String(this.since));
  }
  get(key: string) { return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value: string} | undefined)?.value; }
  set(key: string, value: string) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, value); }
  private notice(user: string, content: string, id: string = randomUUID()) {
    this.db.prepare('INSERT OR IGNORE INTO notices(id,user_id,content,created_at) VALUES(?,?,?,?)')
      .run(id, user, content, Date.now());
  }
  paired(user: string) {
    if (this.users.includes(user)) this.notice(user,
      `私聊链接发帖已开启。把链接发给我，我会先询问你是否翻译并发布到「${this.channelName}」。\n回复“待处理”可以查看任务。`, 'paired-ready');
  }
  private expire() {
    this.db.prepare("UPDATE requests SET state='expired' WHERE state='pending' AND expires_at<?").run(Date.now());
  }
  job(id: string) { return this.db.prepare('SELECT * FROM requests WHERE id=?').get(id) as Job | undefined; }
  receive(message: PrivateMessage) {
    if (message.chat_type !== 'private' || !this.users.includes(message.user_id) ||
        message.timestamp < this.since || message.timestamp < Date.now() - 86400_000 ||
        message.timestamp > Date.now() + 60_000) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?)').run(message.message_id).changes) {
        this.db.exec('COMMIT'); return;
      }
      this.expire();
      const user = message.user_id, text = message.content.trim();
      let urls: string[] = [];
      try { urls = extractUrls(text); }
      catch { this.notice(user, '这个链接暂时不能读取，请发公开网页的完整 http 或 https 链接。'); }
      if (urls.length) {
        if (urls.length > 3) this.notice(user, '一次最多发 3 个链接，请分开发给我。');
        else for (const url of urls) {
          const existing = this.db.prepare("SELECT * FROM requests WHERE user_id=? AND url=? AND state IN ('pending','queued','processing','ready','publishing')")
            .get(user, url) as Job | undefined;
          if (existing) { this.notice(user, `这条链接已有任务 ${existing.id}：${labels[existing.state]}。`); continue; }
          const count = this.db.prepare("SELECT count(*) n FROM requests WHERE user_id=? AND state IN ('pending','queued','processing','ready','publishing')").get(user) as {n: number};
          if (count.n >= 10) { this.notice(user, '还有 10 条待处理任务，先处理或取消一些再添加吧。'); break; }
          const id = randomBytes(4).toString('hex'), now = Date.now();
          this.db.prepare('INSERT INTO requests(id,user_id,url,state,created_at,expires_at) VALUES(?,?,?,?,?,?)')
            .run(id, user, url, 'pending', now, now + 86400_000);
          this.notice(user, `要把这个链接的内容翻译成中文，并发布到「${this.channelName}」吗？\n\n${url.slice(0, 900)}\n\n回复：确认 ${id}\n放弃：取消 ${id}\n只有一条待确认时，也可以直接回复“确认”或“取消”。`);
        }
      } else {
        const action = text.match(/^\/?(确认|取消|是|好|好的|可以|yes|cancel)(?:\s+([a-f0-9]{8}))?[。！!]?$/i);
        if (action) {
          const confirm = !/^(取消|cancel)$/i.test(action[1]!);
          const candidates = action[2]
            ? [this.job(action[2].toLowerCase())].filter((j): j is Job => !!j && j.user_id === user)
            : this.db.prepare("SELECT * FROM requests WHERE user_id=? AND state='pending' ORDER BY created_at").all(user) as Job[];
          if (candidates.length !== 1) this.notice(user, candidates.length > 1
            ? '有多条待确认链接，请回复“确认 编号”或“取消 编号”。'
            : '没有找到你的待确认任务。发送链接可以新建任务，回复“待处理”可以查看状态。');
          else {
            const job = candidates[0]!;
            if (confirm && job.state === 'pending') {
              this.db.prepare("UPDATE requests SET state='queued' WHERE id=? AND state='pending'").run(job.id);
              this.notice(user, `收到，任务 ${job.id} 已排队。翻译并发布后告诉你。`);
            } else if (!confirm && ['pending', 'queued', 'processing', 'ready'].includes(job.state)) {
              this.db.prepare("UPDATE requests SET state='cancelled' WHERE id=?").run(job.id);
              this.notice(user, `已取消 ${job.id}。`);
            } else this.notice(user, `任务 ${job.id}：${labels[job.state] ?? job.state}。`);
          }
        } else if (/^\/?(待处理|状态|发帖状态|help|帮助)$/i.test(text)) {
          const jobs = this.db.prepare('SELECT * FROM requests WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 10').all(user) as Job[];
          this.notice(user, jobs.length ? jobs.map(j => `${j.id} · ${labels[j.state]}\n${j.url.slice(0, 100)}`).join('\n\n')
            : '私聊发链接给我，我会先问你是否翻译并发到「' + this.channelName + '」。');
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async notifyNext() {
    if (this.notifying) return;
    const row = this.db.prepare("SELECT * FROM notices WHERE state='queued' ORDER BY created_at,rowid LIMIT 1")
      .get() as {id: string; user_id: string; content: string} | undefined;
    if (!row || !this.users.includes(row.user_id)) return;
    this.notifying = true;
    this.db.prepare("UPDATE notices SET state='sending' WHERE id=?").run(row.id);
    try {
      // The phone reserves this ID durably before sending. Retrying the same ID
      // after transport loss reads that receipt instead of sending a duplicate.
      const state = await this.ports.notify(row.user_id, row.content, 'link-' + row.id);
      this.db.prepare('UPDATE notices SET state=? WHERE id=?').run(state, row.id);
    } catch { this.db.prepare("UPDATE notices SET state='queued' WHERE id=?").run(row.id); }
    finally { this.notifying = false; }
  }
  async runNext() {
    if (this.running || this.ports.enabled?.() === false) return;
    const job = this.db.prepare("SELECT * FROM requests WHERE state IN ('queued','ready') ORDER BY created_at,rowid LIMIT 1").get() as Job | undefined;
    if (!job || !this.users.includes(job.user_id)) return;
    this.running = true; let stage = 'read';
    try {
      if (job.state === 'queued') {
        this.db.prepare("UPDATE requests SET state='processing' WHERE id=?").run(job.id);
        const article = await this.ports.read(job.url);
        if (this.job(job.id)?.state === 'cancelled') return;
        stage = 'translate'; const translation = await this.ports.translate(article, () => {
          if (this.job(job.id)?.state === 'processing') this.notice(job.user_id,
            `任务 ${job.id}：翻译服务暂时不可用，正在等待重试，不用重复发送链接。`, 'retry-' + job.id);
        });
        if (this.job(job.id)?.state === 'cancelled') return;
        if (typeof translation === 'string' && !translation.trim()) throw new Error('translation_empty');
        const chunks = typeof translation === 'string'
          ? channelParts(article, translation).map(content => ({content, images: []})) : richChannelParts(article.url, translation);
        this.db.exec('BEGIN IMMEDIATE');
        try {
          chunks.forEach((part, index) => this.db.prepare('INSERT INTO parts(job_id,ordinal,content,images) VALUES(?,?,?,?)')
            .run(job.id, index, part.content, JSON.stringify(part.images)));
          this.db.prepare("UPDATE requests SET state='ready' WHERE id=?").run(job.id); this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      }
      if (this.ports.enabled?.() === false) return;
      stage = 'destination'; await this.ports.verifyChannel();
      if (this.job(job.id)?.state === 'cancelled') return;
      if (this.ports.enabled?.() === false) return;
      const parts = this.db.prepare('SELECT * FROM parts WHERE job_id=? ORDER BY ordinal').all(job.id) as Part[];
      stage = 'images';
      const uploaded = new Map<string, string | null>(), payloads = new Map<number, {content: string; images: string[]}>();
      let missingImages = 0;
      for (const part of parts) {
        if (part.state === 'sent') continue;
        let content = part.content; const images: string[] = [];
        for (const image of JSON.parse(part.images) as ArticleImage[]) {
          if (!uploaded.has(image.url)) {
            try { uploaded.set(image.url, await this.ports.uploadImage?.(image) || null); }
            catch { uploaded.set(image.url, null); }
          }
          const id = uploaded.get(image.url);
          if (id) images.push(id);
          else { missingImages++; content += '\n\n配图' + (image.alt ? '：' + escapeMarkdown(image.alt) : '') + '\n' + image.url; }
          if (this.job(job.id)?.state === 'cancelled' || this.ports.enabled?.() === false) return;
        }
        // Check every payload before any visible write, including fallback links.
        if (!content.trim() || Buffer.byteLength(content) > 20_480) throw new ArticleError('image_layout_size');
        payloads.set(part.ordinal, {content, images});
      }
      let postId = parts[0]?.remote_id || undefined;
      if (this.job(job.id)?.state === 'cancelled' || this.ports.enabled?.() === false) return;
      stage = 'publish';
      this.db.prepare("UPDATE requests SET state='publishing' WHERE id=?").run(job.id);
      for (const part of parts) {
        if (part.state === 'sent') continue;
        if (part.state !== 'queued') throw new WecomError('previous_send_uncertain', true);
        if (part.ordinal > 0 && !postId) throw new Error('missing_root_post');
        const payload = payloads.get(part.ordinal)!;
        this.db.prepare("UPDATE parts SET state='sending',delivery_content=? WHERE job_id=? AND ordinal=?")
          .run(payload.content, job.id, part.ordinal);
        const id = await this.ports.publish(payload.content, part.ordinal === 0 ? undefined : postId, payload.images);
        this.db.prepare("UPDATE parts SET state='sent',remote_id=? WHERE job_id=? AND ordinal=?").run(id, job.id, part.ordinal);
        if (part.ordinal === 0) postId = id;
        if (part.ordinal < parts.length - 1) await (this.ports.pause?.() ?? new Promise(r => setTimeout(r, 2100)));
      }
      const root = payloads.get(0);
      const verified = await this.ports.verifyPost(postId!, root?.content || parts[0]!.delivery_content || parts[0]!.content,
        root?.images.length ?? 0).catch(() => false);
      this.db.prepare("UPDATE requests SET state='sent',error=? WHERE id=?").run(verified ? '' : 'readback_unavailable', job.id);
      this.notice(job.user_id, `任务 ${job.id} 已发布到「${this.channelName}」。` +
        (parts.length > 1 ? '\n后续图文已按原文顺序接在同一帖子下。' : '') +
        (missingImages ? `\n有 ${missingImages} 张配图暂时无法上传，已在对应位置保留原图链接。` : '') +
        '\n\n原文：' + job.url.slice(0, 900), 'done-' + job.id);
    } catch (error) {
      if (this.job(job.id)?.state === 'cancelled') return;
      const count = this.db.prepare("SELECT count(*) n FROM parts WHERE job_id=? AND state='sent'").get(job.id) as {n: number};
      const uncertain = error instanceof WecomError && error.uncertain ||
        stage === 'publish' && !(error instanceof WecomError);
      const state = uncertain ? 'uncertain' : count.n ? 'partial' : 'failed';
      const reason = error instanceof WecomError ? error.code :
        error instanceof ArticleError && /^[a-z0-9_]+$/.test(error.message)
          ? 'link_' + stage + '_failed:' + error.message : 'link_' + stage + '_failed';
      const temporarilyUnavailable = error instanceof ArticleError &&
        /^(translation_capacity_exhausted|translation_rate_limited|translation_network|translation_http_(500|502|503|504))$/.test(error.message);
      this.db.prepare('UPDATE requests SET state=?,error=? WHERE id=?').run(state, reason, job.id);
      this.notice(job.user_id, `任务 ${job.id}：` + (uncertain
        ? '发帖回执未确认，请先到频道查看。我不会自动重复发帖。'
        : count.n ? '正文已发布，但部分续文失败，请到频道查看。'
        : stage === 'read' ? '没能读取网页正文，可能需要登录、页面不支持或暂时无法访问。没有发帖。'
        : stage === 'translate' && temporarilyUnavailable ? '翻译模型繁忙或连接暂不可用，本次未能完成。没有发帖，稍后可重新发送链接。'
        : stage === 'translate' ? '翻译暂时失败，没有发帖。稍后重新发链接给我即可。'
        : '频道发布失败，没有发出新帖。请检查机器人权限后再试。'), 'error-' + job.id);
    } finally { this.running = false; }
  }
  summary() {
    return this.db.prepare('SELECT state,count(*) count FROM requests GROUP BY state').all();
  }
  close() { this.db.close(); }
}
