#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="$PWD/.runtime/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$PWD/.runtime/android-user"
export ANDROID_AVD_HOME="$PWD/.runtime/avd"
export ANDROID_ADB_SERVER_PORT=5038
export ADB_SERVER_SOCKET=tcp:localhost:5038
EMULATOR="$ANDROID_HOME/emulator/emulator"
if [ -x "$PWD/runtime/emulator/emulator" ]; then EMULATOR="$PWD/runtime/emulator/emulator"; fi
# This Mac currently requires headless rendering. scripts/open-android.sh supplies the GUI.
exec "$EMULATOR" -avd WeChatBot_API34 -port 5556 -no-window -no-snapshot -no-boot-anim -no-audio -no-metrics "$@"
