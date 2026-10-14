"""Manage per-user launchd services; no root and no credentials in plists."""
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import re

ROOT = Path(__file__).resolve().parents[1]
SERVICE_ROOT = Path.home() / 'Library/Application Support/WeChatBot'
AGENTS = Path.home() / 'Library/LaunchAgents'
DOMAIN = f'gui/{os.getuid()}'
NAMES = ('adb', 'ollama', 'bridge')

def label(name):
    return 'local.nilabot.' + name

def ctl(*args):
    return subprocess.run(['/bin/launchctl', *args], text=True, capture_output=True)

def loaded(name):
    return ctl('print', DOMAIN + '/' + label(name)).returncode == 0

def deploy():
    if any(loaded(name) for name in NAMES):
        raise SystemExit('Stop the services before updating their files.')
    SERVICE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    # APFS clones preserve model state without duplicating every disk block.
    # Mutable state is initialized once and never overwritten during upgrades.
    immutable = ['dist', 'apps', 'scripts', 'node_modules', 'package.json', '.env', 'runtime/WeChatBot Android.app']
    initial = ['data', 'config', 'runtime/scrcpy-macos-aarch64-v5.0.1',
               '.runtime/android-sdk/platform-tools', '.runtime/venv',
               '.runtime/bin', '.runtime/ollama-models']
    for relative in immutable + initial:
        source, destination = ROOT / relative, SERVICE_ROOT / relative
        if relative in initial and destination.exists():
            continue
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source.is_dir() and destination.exists():
            subprocess.run(['/bin/cp', '-cRP', str(source) + '/.', str(destination)], check=True)
        else:
            subprocess.run(['/bin/cp', '-cRP', str(source), str(destination)], check=True)
    (SERVICE_ROOT / '.env').chmod(0o600)
    (ROOT / '.runtime/service-root').write_text(str(SERVICE_ROOT) + '\n')

def install():
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js was not found.')
    deploy()
    env=dict(line.split('=',1) for line in (SERVICE_ROOT/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
    serial=env.get('WECHAT_DEVICE_SERIAL','')
    port=env.get('ADB_SERVER_PORT','5038')
    if not re.fullmatch(r'[\w.:-]+',serial) or serial.startswith('emulator-') or not port.isdigit():
        raise SystemExit('Configure a physical WECHAT_DEVICE_SERIAL and ADB_SERVER_PORT first.')
    commands = {
        'adb': [str(SERVICE_ROOT/'.runtime/android-sdk/platform-tools/adb'), '-P', port, '--one-device', serial, 'server', 'nodaemon'],
        'ollama': ['/bin/bash', str(SERVICE_ROOT / 'scripts/start-ollama.sh')],
        'bridge': [node, '--env-file=.env', 'dist/apps/server/src/main.js'],
    }
    AGENTS.mkdir(parents=True, exist_ok=True)
    logs = SERVICE_ROOT / '.runtime/logs'
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name, args in commands.items():
        path = AGENTS / (label(name) + '.plist')
        data = {'Label': label(name), 'ProgramArguments': args,
                'WorkingDirectory': str(SERVICE_ROOT), 'RunAtLoad': True, 'KeepAlive': True,
                'ThrottleInterval': 10, 'ExitTimeOut': 30,
                # Device rendering, OCR and input confirmation need interactive
                # latency, including when macOS has no foreground app window.
                'ProcessType': 'Interactive',
                'Umask': 0o077,
                'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
                'StandardOutPath': str(logs / (name + '.log')),
                'StandardErrorPath': str(logs / (name + '.log'))}
        temporary = path.with_suffix('.tmp')
        temporary.write_bytes(plistlib.dumps(data));temporary.chmod(0o600);temporary.replace(path)
    start()

def start():
    for name in NAMES:
        if loaded(name):
            continue
        path = AGENTS / (label(name) + '.plist')
        result = ctl('bootstrap', DOMAIN, str(path))
        if result.returncode:
            raise SystemExit(f'{name}: {result.stderr.strip()}')
    status()

def stop():
    for name in reversed(NAMES):
        if loaded(name):
            result = ctl('bootout', DOMAIN + '/' + label(name))
            if result.returncode:
                raise SystemExit(f'{name}: {result.stderr.strip()}')
    status()

def status():
    for name in NAMES:
        result = ctl('print', DOMAIN + '/' + label(name))
        details = [line.strip() for line in result.stdout.splitlines()
                   if line.strip().startswith(('state =', 'pid =', 'last exit code ='))]
        print(name + ': ' + (', '.join(details) if result.returncode == 0 else 'not loaded'))

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) == 2 else 'status'
    if action not in {'install', 'start', 'stop', 'status'}:
        raise SystemExit('Usage: python3 scripts/services.py install|start|stop|status')
    globals()[action]()
