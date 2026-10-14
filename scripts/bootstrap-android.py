"""Project-local Android toolchain, using upstream manifests and checksums."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtime'
DOWNLOADS = RUNTIME / 'downloads'
SDK = RUNTIME / 'android-sdk'

def download(url, name, checksum=None, algorithm='sha1'):
    target = DOWNLOADS / name
    if not target.exists():
        print('Downloading ' + name, flush=True)
        partial = target.with_suffix(target.suffix + '.part')
        subprocess.run(['curl', '-fL', '--retry', '3', '--connect-timeout', '30',
                        '--max-time', '1800', '-sS', url, '-o', str(partial)], check=True)
        partial.rename(target)
    if checksum:
        with target.open('rb') as f:
            actual = hashlib.file_digest(f, algorithm).hexdigest()
        if actual != checksum:
            raise RuntimeError('Checksum mismatch: ' + name)
    return target

def main():
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    SDK.mkdir(parents=True, exist_ok=True)
    manifest = download('https://dl.google.com/android/repository/repository2-3.xml', 'repository-v3.xml')
    repo = ET.parse(manifest).getroot()
    pkg = next(p for p in repo.findall('remotePackage') if p.get('path') == 'cmdline-tools;latest')
    archive = next(a for a in pkg.findall('archives/archive') if a.findtext('host-os') == 'macosx' and a.findtext('host-arch') == 'aarch64')
    name = archive.findtext('complete/url')
    java_manifest = download('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jdk&os=mac&vendor=eclipse', 'jdk.json')
    java = json.loads(java_manifest.read_text())[0]['binary']['package']
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        cf = pool.submit(download, 'https://dl.google.com/android/repository/' + name, name, archive.findtext('complete/checksum'))
        jf = pool.submit(download, java['link'], java['name'], java['checksum'], 'sha256')
        czip, jtar = cf.result(), jf.result()
    java_dir = RUNTIME / 'java'
    java_dir.mkdir(exist_ok=True)
    if not list(java_dir.glob('*/Contents/Home/bin/java')):
        with tarfile.open(jtar) as t:
            t.extractall(java_dir, filter='data')
    java_home = next(java_dir.glob('*/Contents/Home'))
    latest = SDK / 'cmdline-tools/latest'
    if not latest.exists():
        unpack = RUNTIME / 'cmdline-unpack'
        subprocess.run(['unzip', '-q', str(czip), '-d', str(unpack)], check=True)
        latest.parent.mkdir(exist_ok=True)
        (unpack / 'cmdline-tools').rename(latest)
    env = os.environ.copy()
    env.update(JAVA_HOME=str(java_home), ANDROID_HOME=str(SDK), ANDROID_SDK_ROOT=str(SDK),
               ANDROID_USER_HOME=str(RUNTIME / 'android-user'), ANDROID_AVD_HOME=str(RUNTIME / 'avd'))
    Path(env['ANDROID_USER_HOME']).mkdir(exist_ok=True)
    Path(env['ANDROID_AVD_HOME']).mkdir(exist_ok=True)
    # Accept only licenses requested for these user-authorized installations.
    manager = str(latest / 'bin/sdkmanager')
    args = [manager, '--sdk_root=' + str(SDK), 'platform-tools', 'emulator',
            'system-images;android-34;google_apis_playstore;arm64-v8a']
    subprocess.run(args, input='y\n' * 20, text=True, env=env, check=True)
    avd = RUNTIME / 'avd/WeChatBot_API34.avd'
    if not avd.exists():
        subprocess.run([str(latest / 'bin/avdmanager'), 'create', 'avd', '-n', 'WeChatBot_API34',
                        '-k', 'system-images;android-34;google_apis_playstore;arm64-v8a', '-d', 'pixel_7',
                        '-p', str(avd)], input='no\n', text=True, env=env, check=True)
        config = avd / 'config.ini'
        values = dict(line.split('=', 1) for line in config.read_text().splitlines() if '=' in line)
        values.update({'hw.ramSize':'4096', 'hw.cpu.ncore':'4', 'disk.dataPartition.size':'16G',
                       'hw.keyboard':'yes', 'hw.gpu.enabled':'yes', 'hw.gpu.mode':'auto'})
        config.write_text('\n'.join(k + '=' + v for k, v in values.items()) + '\n')
    mirror = ROOT / 'runtime/scrcpy-macos-aarch64-v5.0.1'
    if not mirror.exists():
        archive = download('https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-macos-aarch64-v5.0.1.tar.gz',
                           'scrcpy.tar.gz', '33611e51977a8289e2e124b220f727895181ef2eb9060e0987a4dc2db9cf0d6b', 'sha256')
        (ROOT / 'runtime').mkdir(exist_ok=True)
        with tarfile.open(archive) as t:
            t.extractall(ROOT / 'runtime', filter='data')
    subprocess.run([sys.executable, str(ROOT / 'scripts/make-android-app.py')], check=True)
    print('Android emulator ready: bash scripts/start-emulator.sh', flush=True)

if __name__ == '__main__':
    main()
