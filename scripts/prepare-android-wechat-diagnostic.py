"""Prepare an offline, version-pinned diagnostic APK. Never installs or uninstalls.

The embedded module only checks class/method signatures. Passing APK verification
does not establish that WeChat will launch, log in, or send/receive messages.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / '.runtime/android-research'
OUT = BASE / 'wechat-diagnostic'
JDK = next((ROOT / '.runtime/java').glob('*/Contents/Home'))
TOOLS = ROOT / '.runtime/android-sdk/build-tools/35.0.0'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    global OUT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUT)
    args = parser.parse_args()
    OUT = args.output.resolve()
    os.umask(0o077)
    apk = BASE / 'wechat-8.0.79.apk'
    patcher = BASE / 'lspatch.jar'
    module = BASE / 'hook-probe/nila-wechat-diagnostic.apk'
    key = BASE / 'hook-probe/local-test.jks'
    assert sha(apk) == 'f2a725bc04302ad218a563533ae79356e66b64aa711b275bc919a8d432f7e15d'
    assert sha(patcher) == 'd238fdc414d121b7fa454d8b4ccf420df3a8c97d563761861ff92bd9c5da2165'
    assert module.exists() and key.exists(), 'Build the local diagnostic module first.'
    OUT.mkdir(exist_ok=True)
    env = {**os.environ, 'JAVA_HOME': str(JDK), 'PATH': str(JDK / 'bin') + os.pathsep + os.environ['PATH']}
    with (OUT / 'build.log').open('w') as log:
        subprocess.run([str(JDK / 'bin/java'), '-Xmx2g', '-jar', str(patcher), '-f', '-o', str(OUT),
                        '-k', str(key), 'android', 'local-test', 'android', '-m', str(module), str(apk)],
                       env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    modified = OUT / 'wechat-8.0.79-487-lspatched.apk'
    signature = subprocess.check_output([str(TOOLS / 'apksigner'), 'verify', '--print-certs', str(modified)], env=env, text=True)
    (OUT / 'signature.txt').write_text(signature)
    metadata = subprocess.run([str(TOOLS / 'aapt2'), 'dump', 'badging', str(modified)], text=True,
                              capture_output=True, check=True)
    (OUT / 'aapt-diagnostics.txt').write_text(metadata.stderr)
    manifest = metadata.stdout
    assert "name='com.tencent.mm'" in manifest and "versionCode='3200'" in manifest and "versionName='8.0.79'" in manifest
    (OUT / 'build-result.json').write_text(json.dumps({
        'artifact': str(modified), 'original_sha256': sha(apk), 'modified_sha256': sha(modified),
        'module_sha256': sha(module), 'lspatch_sha256': sha(patcher),
        'purpose': 'authenticated loopback text transport test; embedded group allowlist',
        'installed': False, 'runtime_verified': False, 'version': '8.0.79', 'version_code': 3200,
        'signature_changed': True, 'signing_key': 'locally generated private test key',
        'system_changes': False, 'signature_bypass_level': 0,
    }, indent=2))
    print('Offline diagnostic APK verified; installation and WeChat runtime remain untested.')

if __name__ == '__main__':
    main()
