import {DatabaseSync} from 'node:sqlite';

/** Read the existing bot's settings without crashing on a concurrent writer. */
export class BridgeSettings {
  private db: DatabaseSync;
  private values = new Map<string, string>();
  private available = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path, {readOnly: true});
    this.db.exec('PRAGMA busy_timeout=1500');
  }
  refresh() {
    try {
      const rows = this.db.prepare("SELECT key,value FROM settings WHERE key IN ('paused','default_model','reasoning_effort','wechat_admin_binding')")
        .all() as {key: string; value: string}[];
      this.values = new Map(rows.map(row => [row.key, row.value]));
      this.available = true;
      return true;
    } catch {
      // Hold all work until a fresh snapshot is available, including a possible
      // pause that the other process is currently committing.
      this.available = false;
      return false;
    }
  }
  get(key: string) { return this.values.get(key); }
  enabled() { return this.available && this.get('paused') === 'false'; }
  close() { this.db.close(); }
}
