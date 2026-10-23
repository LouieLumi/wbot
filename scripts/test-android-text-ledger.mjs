import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, delimiter} from 'node:path';
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
  const xmlPull = process.env.XMLPULL_JAR || join(root, '.runtime/android-sdk/cmdline-tools/latest/lib/external/net/sf/kxml/kxml2/2.3.0/kxml2-2.3.0.jar');
  if (existsSync(xmlPull)) {
    run('javac', ['--release', '8', '-encoding', 'UTF-8', '-cp', xmlPull, '-d', temporary,
      'apps/android-wechat-module/src/local/nilabot/wechathook/PrivateLinkCard.java',
      'tests/android/PrivateLinkCardTest.java']);
    run('java', ['-cp', temporary + delimiter + xmlPull, 'local.nilabot.wechathook.PrivateLinkCardTest']);
  } else {
    console.log('Private share-card parser test skipped: set XMLPULL_JAR or install Android command-line tools.');
  }
} finally {
  rmSync(temporary, {recursive: true, force: true});
}
