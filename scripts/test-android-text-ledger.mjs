import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = join(root, '.runtime/java');
const candidates = [process.env.JAVA_HOME, ...(existsSync(bundled)
  ? readdirSync(bundled).map(name => join(bundled, name, 'Contents/Home')) : [])];
const javaHome = candidates.find(path => path && existsSync(join(path, 'bin/javac')));
const executable = name => javaHome ? join(javaHome, 'bin', name) : name;
const temporary = mkdtempSync(join(tmpdir(), 'wbot-text-ledger-'));
function run(name, args) {
  const result = spawnSync(executable(name), args, {cwd: root, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed (${result.status}); JDK 17+ is required`);
}
try {
  run('javac', ['--release', '8', '-encoding', 'UTF-8', '-d', temporary,
    'apps/android-wechat-module/src/local/nilabot/wechathook/TextSendLedger.java',
    'tests/android/TextSendLedgerTest.java']);
  run('java', ['-cp', temporary, 'local.nilabot.wechathook.TextSendLedgerTest', temporary]);
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
