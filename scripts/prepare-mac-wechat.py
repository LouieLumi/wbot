"""Stage the pinned desktop bridge. Never replaces /Applications or user data."""
from pathlib import Path
import hashlib
import json
import os
import plistlib
import secrets
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / '.runtime/mac-wechat'
SOURCE = Path('/private/tmp/nila-wechat-4.1.12/WeChat.app')
STAGED = BASE / 'staging/WeChat.app'
EXPECTED_SHA = '2c61ba7f64c2b98e897553cd226364642a1eb213b5b7f74556c6fc2efc363e32'

def run(*args):
    subprocess.run(list(map(str, args)), check=True)

def main():
    os.umask(0o077)
    BASE.mkdir(parents=True, exist_ok=True)
    info = plistlib.loads((SOURCE / 'Contents/Info.plist').read_bytes())
    assert info['WeChatBundleVersion'] == '4.1.12.53'
    assert str(info['CFBundleVersion']) == '269365'
    assert hashlib.sha256((SOURCE / 'Contents/MacOS/WeChat').read_bytes()).hexdigest() == EXPECTED_SHA
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', SOURCE)
    if STAGED.exists():
        raise SystemExit('Staging already exists; inspect it before repeating preparation.')
    STAGED.parent.mkdir(parents=True, exist_ok=True)
    run('/usr/bin/ditto', '--norsrc', SOURCE, STAGED)
    credentials = BASE / 'credentials.json'
    if not credentials.exists():
        credentials.write_text(json.dumps({
            'gadget_token': secrets.token_hex(32),
            'onebot_token': secrets.token_hex(32),
        }))
    credentials.chmod(0o600)
    tokens = json.loads(credentials.read_text())
    frameworks = STAGED / 'Contents/Frameworks'
    gadget = frameworks / 'FridaGadget.dylib'
    shutil.copy2(ROOT / '.runtime/research/downloads/FridaGadget.dylib', gadget)
    gadget.chmod(0o755)
    config = STAGED / 'Contents/Resources/FridaGadget.config'
    config.write_text(json.dumps({'interaction': {
        'type': 'listen', 'address': '127.0.0.1', 'port': 27042,
        'on_load': 'resume', 'token': tokens['gadget_token'],
    }}))
    config.chmod(0o600)
    (frameworks / 'FridaGadget.config').symlink_to('../Resources/FridaGadget.config')
    run('/usr/bin/python3', ROOT / '.runtime/research/wechat-mac-hook-classic/scripts/inject_load_dylib.py',
        STAGED / 'Contents/MacOS/WeChat', '@executable_path/../Frameworks/FridaGadget.dylib')
    # Only the staged copy is changed. No global Gatekeeper/SIP or entitlement changes.
    for attr in ['com.apple.quarantine', 'com.apple.provenance']:
        subprocess.run(['/usr/bin/xattr', '-dr', attr, str(STAGED)], capture_output=True)
    suffixes = ('.framework', '.dylib', '.bundle', '.xpc', '.appex', '.app')
    nested = [p for p in (STAGED / 'Contents').rglob('*') if not p.is_symlink() and
              ((p.is_file() and p.suffix == '.dylib') or (p.is_dir() and p.name.endswith(suffixes)))]
    for path in sorted(nested, key=lambda p: len(p.parts), reverse=True):
        run('/usr/bin/codesign', '-f', '-s', '-', '--timestamp=none', path)
    run('/usr/bin/codesign', '-f', '-s', '-', '--timestamp=none', STAGED)
    run('/usr/bin/codesign', '--verify', '--deep', '--strict', STAGED)
    (BASE / 'prepared.json').write_text(json.dumps({
        'version': '4.1.12.53', 'build': '269365', 'stage': str(STAGED),
        'source_main_sha256': EXPECTED_SHA, 'signature': 'local ad-hoc',
        'gadget': '17.8.0', 'listen': '127.0.0.1:27042', 'authentication': True,
    }, indent=2))
    print('Staged and verified; /Applications is unchanged.')

if __name__ == '__main__':
    main()
