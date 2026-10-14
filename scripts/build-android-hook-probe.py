"""Build a harmless hook test and a version-pinned WeChat structure diagnostic.

Does not install any APK. Does not patch WeChat. Xposed API is compile-only.
"""
from pathlib import Path
import hashlib
import json
import secrets
import os
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SDK = ROOT / '.runtime/android-sdk'
JDK = next((ROOT / '.runtime/java').glob('*/Contents/Home'))
TOOLS = SDK / 'build-tools/35.0.0'
ANDROID = SDK / 'platforms/android-29/android.jar'
BASE = ROOT / '.runtime/android-research'
OUT = BASE / 'hook-probe'
ENV = {**os.environ, 'JAVA_HOME': str(JDK), 'PATH': str(JDK / 'bin') + os.pathsep + os.environ['PATH']}

def run(*args):
    subprocess.run(list(map(str, args)), check=True, env=ENV, cwd=OUT)

def build(name, source_name, xposed=False):
    src = ROOT / 'apps' / source_name
    dest = OUT / name
    (dest / 'classes').mkdir(parents=True, exist_ok=True)
    (dest / 'dex').mkdir(exist_ok=True)
    classpath = str(ANDROID)
    if xposed:
        classpath += os.pathsep + str(BASE / 'xposed-api-82.jar')
    run(JDK / 'bin/javac', '--release', '8', '-encoding', 'UTF-8', '-classpath', classpath,
        '-d', dest / 'classes', *sorted((src / 'src').rglob('*.java')))
    extra = ['--classpath', BASE / 'xposed-api-82.jar'] if xposed else []
    run(TOOLS / 'd8', '--lib', ANDROID, *extra, '--min-api', '28', '--output', dest / 'dex',
        *sorted((dest / 'classes').rglob('*.class')))
    run(TOOLS / 'aapt2', 'link', '-I', ANDROID, '--manifest', src / 'AndroidManifest.xml', '-o', dest / 'unsigned.apk')
    with zipfile.ZipFile(dest / 'unsigned.apk', 'a') as apk:
        apk.write(dest / 'dex/classes.dex', 'classes.dex')
        for item in sorted((src / 'assets').glob('*')):
            apk.write(item, 'assets/' + item.name)
        if xposed:
            apk.write(BASE / 'local-api-config.json', 'assets/nila-config.json')
    run(TOOLS / 'zipalign', '-f', '4', dest / 'unsigned.apk', dest / 'aligned.apk')
    run(TOOLS / 'apksigner', 'sign', '--ks', OUT / 'local-test.jks', '--ks-pass', 'pass:android',
        '--out', OUT / (name + '.apk'), dest / 'aligned.apk')
    run(TOOLS / 'apksigner', 'verify', OUT / (name + '.apk'))

def main():
    os.umask(0o077)
    assert hashlib.sha256((BASE / 'xposed-api-82.jar').read_bytes()).hexdigest() == 'f48c635f1c7469fdec0e00ad2ea0b7a6b2f5b55065784a35b7ca3a84615e8e25'
    assert hashlib.sha256((BASE / 'lspatch.jar').read_bytes()).hexdigest() == 'd238fdc414d121b7fa454d8b4ccf420df3a8c97d563761861ff92bd9c5da2165'
    OUT.mkdir(parents=True, exist_ok=True)
    config = BASE / 'local-api-config.json'
    if not config.exists():
        config.write_text(json.dumps({'enabled': True, 'token': secrets.token_hex(32), 'groups': []}, ensure_ascii=False))
        config.chmod(0o600)
    key = OUT / 'local-test.jks'
    if not key.exists():
        run(JDK / 'bin/keytool', '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android',
            '-alias', 'local-test', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=Nila Local Hook Test')
    build('probe', 'android-hook-probe')
    build('nila-wechat-diagnostic', 'android-wechat-module', xposed=True)
    run(JDK / 'bin/java', '-jar', BASE / 'lspatch.jar', '-f', '-o', OUT / 'patched-probe',
        '-m', OUT / 'nila-wechat-diagnostic.apk', OUT / 'probe.apk')
    print('Built module and patched self-test. WeChat has not been patched or installed.')

if __name__ == '__main__':
    main()
