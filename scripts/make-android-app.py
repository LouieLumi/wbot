from pathlib import Path
import plistlib, shutil
root=Path(__file__).resolve().parent.parent
app=root/'runtime/WeChatBot Android.app'
bin_dir=app/'Contents/MacOS'
bin_dir.mkdir(parents=True,exist_ok=True)
for src in (root/'runtime/scrcpy-macos-aarch64-v5.0.1').iterdir():
 if src.is_file(): shutil.copy2(src,bin_dir/src.name)
launcher=bin_dir/'launcher'
launcher.write_text('''#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
exec /bin/bash scripts/open-android.sh --max-size=1600 --max-fps=30
''')
launcher.chmod(0o755)
with (app/'Contents/Info.plist').open('wb') as f:
 plistlib.dump({'CFBundleName':'WeChatBot Android','CFBundleDisplayName':'Nila 微信手机','CFBundleIdentifier':'local.wechatbot.android','CFBundleExecutable':'launcher','CFBundlePackageType':'APPL','CFBundleVersion':'2','NSHighResolutionCapable':True},f)
print(app)
