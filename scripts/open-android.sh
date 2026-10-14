#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ADB="$PWD/.runtime/android-sdk/platform-tools/adb"
export ANDROID_ADB_SERVER_PORT=5038
export ADB_SERVER_SOCKET=tcp:localhost:5038
serial=$(python3 - <<'PY'
from pathlib import Path
import re
values=dict(line.split('=',1) for line in Path('.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
serial=values.get('WECHAT_DEVICE_SERIAL','')
if not re.fullmatch(r'[\w.:-]+',serial):raise SystemExit('Missing device serial in .env')
print(serial)
PY
)
exec "$PWD/runtime/scrcpy-macos-aarch64-v5.0.1/scrcpy" -s "$serial" --no-audio --no-clipboard-autosync --window-title='Nila · 微信手机' --window-height=850 --stay-awake "$@"
