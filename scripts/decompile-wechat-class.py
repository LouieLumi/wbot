"""Decompile selected classes from the locally extracted, unmodified WeChat APK."""
from pathlib import Path
import json
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BASE = ROOT / '.runtime/android-research'
JDK = next((ROOT / '.runtime/java').glob('*/Contents/Home'))

def main():
    index = json.loads((BASE / 'class-definitions.json').read_text())
    env = {**os.environ, 'JAVA_HOME': str(JDK), 'PATH': str(JDK / 'bin') + os.pathsep + os.environ['PATH'],
           'JAVA_OPTS': '-Xmx3g', 'JADX_CACHE_DIR': str(BASE / 'cache'), 'JADX_CONFIG_DIR': str(BASE / 'config')}
    for name in sys.argv[1:]:
        if name not in index:
            print(f'Not present: {name}')
            continue
        result = subprocess.run([str(BASE / 'jadx/bin/jadx'), '--config', 'none', '-r',
                                 '--single-class', name, '--single-class-output', str(BASE / 'decompiled' / name),
                                 '--rename-flags', 'none', '--log-level', 'error', str(BASE / 'dex' / index[name])], env=env)
        print(f'{name}: exit={result.returncode}', flush=True)

if __name__ == '__main__':
    main()
