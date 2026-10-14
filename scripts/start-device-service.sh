#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/start-emulator.sh &
vm_pid=$!
trap 'kill -TERM "$vm_pid" 2>/dev/null || true; wait "$vm_pid" 2>/dev/null || true' TERM INT EXIT
adb="$PWD/.runtime/android-sdk/platform-tools/adb"
# A dedicated VM starts WeChat once after boot. Later foreground changes are
# left to the user; the bridge refuses to type into an unverified application.
for ((attempt=0; attempt<90; attempt++)); do
  kill -0 "$vm_pid" 2>/dev/null || { wait "$vm_pid"; exit 1; }
  booted=$("$adb" -P 5038 -s emulator-5556 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') || booted=''
  if [[ "$booted" == '1' ]]; then
    "$adb" -P 5038 -s emulator-5556 shell svc power stayon true >/dev/null
    # Package-scoped implicit intents did not resolve on this WeChat build.
    # LauncherUI is the launcher component verified in its installed manifest.
    for ((launch_attempt=0; launch_attempt<15; launch_attempt++)); do
      result=$("$adb" -P 5038 -s emulator-5556 shell am start -W -n com.tencent.mm/.ui.LauncherUI 2>&1) || result=''
      if [[ "$result" == *'Status: ok'* ]]; then break; fi
      sleep 2
    done
    if [[ "$result" != *'Status: ok'* ]]; then echo 'WeChat startup needs manual attention.'; fi
    break
  fi
  sleep 2
done
wait "$vm_pid"
