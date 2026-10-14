"""Build a dependency-free diagnostic APK with locally installed Android SDK tools."""
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SDK = ROOT / '.runtime/android-sdk'
JDK = next((ROOT / '.runtime/java').glob('*/Contents/Home'))
TOOLS = SDK / 'build-tools/35.0.0'
ANDROID = SDK / 'platforms/android-29/android.jar'
SRC = ROOT / 'apps/android-companion'
OUT = ROOT / '.runtime/android-companion'
env = {**os.environ, 'JAVA_HOME': str(JDK), 'PATH': str(JDK / 'bin') + os.pathsep + os.environ['PATH']}

def run(*args):
    subprocess.run([str(x) for x in args], check=True, env=env, cwd=OUT)

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'classes').mkdir(exist_ok=True)
    (OUT / 'dex').mkdir(exist_ok=True)
    run(JDK / 'bin/javac', '--release', '8', '-encoding', 'UTF-8', '-classpath', ANDROID,
        '-d', OUT / 'classes', *sorted((SRC / 'src').rglob('*.java')))
    run(TOOLS / 'd8', '--lib', ANDROID, '--min-api', '26', '--output', OUT / 'dex', *sorted((OUT / 'classes').rglob('*.class')))
    run(TOOLS / 'aapt2', 'compile', '--dir', SRC / 'res', '-o', OUT / 'resources.zip')
    run(TOOLS / 'aapt2', 'link', '-I', ANDROID, '--manifest', SRC / 'AndroidManifest.xml', '-o', OUT / 'unsigned.apk', OUT / 'resources.zip')
    with zipfile.ZipFile(OUT / 'unsigned.apk', 'a') as apk:
        apk.write(OUT / 'dex/classes.dex', 'classes.dex')
    run(TOOLS / 'zipalign', '-f', '4', OUT / 'unsigned.apk', OUT / 'aligned.apk')
    key = OUT / 'diagnostic.jks'
    if not key.exists():
        run(JDK / 'bin/keytool', '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android',
            '-alias', 'diagnostic', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=Nila Local Diagnostic')
        key.chmod(0o600)
    run(TOOLS / 'apksigner', 'sign', '--ks', key, '--ks-pass', 'pass:android', '--out', OUT / 'nila-companion.apk', OUT / 'aligned.apk')
    run(TOOLS / 'apksigner', 'verify', OUT / 'nila-companion.apk')
    print(OUT / 'nila-companion.apk')

if __name__ == '__main__':
    main()
