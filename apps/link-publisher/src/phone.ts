import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {Config} from '../../server/src/config.js';

const exec = promisify(execFile);
const page = z.object({source: z.string().regex(/^[a-f0-9]{64}$/),
  cursor: z.number().int().nonnegative().safe(), has_more: z.boolean(),
  messages: z.array(z.object({message_id: z.string().min(1).max(200), user_id: z.string(),
    content: z.string().max(8000), timestamp: z.number().int().positive().safe()})).max(50)});

export class PrivatePhone {
  private generation = '';
  private forwarded = 0;
  users: string[] = [];
  constructor(private config: Config, private adb: string, private accounts: string[],
    private pinnedUsers: Record<string, string> = {}) {}
  async pair(content: string, since: number) {
    if (this.accounts.length !== 1 || Object.keys(this.pinnedUsers).length) throw new Error('private_pairing_not_needed');
    const result = await this.call('/private/pairing', {content, since});
    if (result.verified !== true || typeof result.username !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(result.username))
      return null;
    this.pinnedUsers[this.accounts[0]!] = result.username;
    return {account: this.accounts[0]!, username: result.username, verified_at: Date.now(), method: 'private_pairing'};
  }
  async call(path: string, body?: object) {
    if (Date.now() - this.forwarded > 60_000) {
      await exec(this.adb, ['-P', String(this.config.ADB_SERVER_PORT), '-s', this.config.WECHAT_DEVICE_SERIAL,
        'forward', 'tcp:' + new URL(this.config.WECHAT_HOOK_BASE_URL).port, 'tcp:8767'], {timeout: 5000, maxBuffer: 4096});
      this.forwarded = Date.now();
    }
    try {
      const response = await fetch(new URL(path, this.config.WECHAT_HOOK_BASE_URL), {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(25_000),
        headers: {Authorization: 'Bearer ' + this.config.WECHAT_HOOK_TOKEN, 'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined});
      if (!response.ok) throw Error();
      const text = await response.text(); if (text.length > 600_000) throw Error();
      return JSON.parse(text);
    } catch { this.forwarded = 0; throw new Error('private_phone_unavailable'); }
  }
  async prepare() {
    const status = await this.call('/status');
    if (status.private_links_supported !== true) throw new Error('private_phone_update_required');
    if (status.generation === this.generation && this.users.length) return;
    const users: string[] = [];
    for (const account of this.accounts) {
      const data = await this.call('/identity/resolve', {wechat_id: account});
      const pin = this.pinnedUsers[account];
      const exact = data.verified === true && data.reason === 'account_exact_match' ? data.username : undefined;
      if (pin && exact && pin !== exact) throw new Error('private_identity_changed');
      const username = exact || pin;
      if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(username))
        throw new Error('private_account_not_verified');
      users.push(username);
    }
    await this.call('/private/authorization', {user_ids: users});
    if (this.users.length && JSON.stringify(this.users) !== JSON.stringify(users)) throw new Error('private_identity_changed');
    this.users = users; this.generation = status.generation;
  }
  async history(user: string, since: number, after: number, source: string) {
    const data = page.parse(await this.call('/private/history', {user_id: user, since, after, source}));
    if (data.messages.some(m => m.user_id !== user)) throw new Error('private_sender_mismatch');
    return data;
  }
  async send(user: string, content: string, id: string) {
    if (!this.users.includes(user) || content.length > 2000) throw new Error('private_send_invalid');
    const result = z.object({state: z.enum(['sent', 'failed', 'uncertain']), reason: z.string()})
      .parse(await this.call('/private/send', {user_id: user, content, id}));
    return result.state === 'sent' && result.reason !== 'wechat_server_ack' ? 'uncertain' : result.state;
  }
}
