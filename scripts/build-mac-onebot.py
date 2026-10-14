"""Build the audited local checkout of wechat_chatter with private token handling.

Prerequisites live under .runtime/research: upstream checkout, official Go,
Frida 17.8.0 devkit. Does not modify or launch WeChat.
"""
from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parent.parent
RESEARCH = ROOT / '.runtime/research'
SOURCE = RESEARCH / 'weixin-macos/onebot'

def replace_once(path, old, new):
    text = path.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f'Upstream changed; review required: {path.name}')
    path.write_text(text.replace(old, new, 1))

def main():
    replace_once(SOURCE / 'main.go', '"token", "MuseBot", "OneBot Token: MuseBot"',
                 '"token", os.Getenv("NILA_ONEBOT_TOKEN"), "OneBot Token (defaults to NILA_ONEBOT_TOKEN)"')
    replace_once(SOURCE / 'main.go', 'fmt.Println("OnebotToken", config.OnebotToken)',
                 'fmt.Println("OnebotTokenConfigured", config.OnebotToken != "")')
    replace_once(SOURCE / 'http.go', 'Info("发送数据", "msg", string(jsonReq))',
                 'Info("消息事件已接收", "bytes", len(jsonReq))')
    replace_once(SOURCE / 'main.go',
                 'device, err = mgr.AddRemoteDevice(config.FridaGadgetAddr, frida.NewRemoteDeviceOptions())',
                 'options := frida.NewRemoteDeviceOptions()\n\toptions.SetToken(os.Getenv("NILA_GADGET_TOKEN"))\n\tdevice, err = mgr.AddRemoteDevice(config.FridaGadgetAddr, options)')
    sdk = RESEARCH / 'frida-devkit'
    env = {**os.environ, 'GOARCH': 'arm64', 'CGO_ENABLED': '1', 'GOTELEMETRY': 'off',
           'GOPATH': str(RESEARCH / 'go-cache'), 'GOCACHE': str(RESEARCH / 'go-build'),
           'CGO_CFLAGS': f'-I{sdk}', 'CGO_LDFLAGS': f'-L{sdk} -lfrida-core'}
    subprocess.run([str(RESEARCH / 'toolchain/go/bin/go'), 'build', '-o', 'onebot', '.'], cwd=SOURCE, env=env, check=True)
    print(SOURCE / 'onebot')

if __name__ == '__main__':
    main()
