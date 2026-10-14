"""Set the local admin password without putting credentials in files or argv."""
import getpass
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]

def main():
    os.umask(0o077)
    env_file = ROOT / '.env'
    env = dict(line.split('=', 1) for line in env_file.read_text().splitlines()
               if '=' in line and not line.startswith('#')) if env_file.exists() else {}
    database = Path(env.get('BRIDGE_DB', 'data/bridge.sqlite'))
    if not database.is_absolute():
        database = ROOT / database
    if not database.is_file():
        raise SystemExit('Database not found; start the bridge first.')
    if sys.stdin.isatty():
        password = getpass.getpass('管理密码: ')
        if password != getpass.getpass('再次输入: '):
            raise SystemExit('Passwords do not match.')
    else:
        password = sys.stdin.read().removesuffix('\n')
    if not 8 <= len(password) <= 256:
        raise SystemExit('Password must contain 8–256 characters.')
    program = """
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AdminAuth} from './dist/apps/server/src/admin-auth.js';
const db=new DatabaseSync(process.argv[1]);
db.exec('PRAGMA busy_timeout=5000');
try { await new AdminAuth(db).setPassword(readFileSync(0,'utf8')); }
finally { db.close(); }
"""
    subprocess.run(['node', '--input-type=module', '-e', program, str(database)],
                   cwd=ROOT, input=password.encode(), check=True)
    print('Admin password updated; previous sessions revoked.')

if __name__ == '__main__':
    main()
