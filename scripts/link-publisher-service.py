"""Install the private-link publisher as an independent per-user launchd service."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import sqlite3
import subprocess

ROOT = Path(__file__).resolve().parents[1]
LIVE = Path.home() / "Library/Application Support/NilaLinkPublisher"
LABEL = "local.nilabot.link-publisher"
DOMAIN = f"gui/{os.getuid()}"
PLIST = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")


def ctl(*args):
    return subprocess.run(["/bin/launchctl", *args], capture_output=True, text=True)


def install(config):
    node = shutil.which("node")
    if not node or not (ROOT / "dist/apps/link-publisher/src/main.js").exists():
        raise SystemExit("Run npm run build first.")
    settings = json.loads(config.read_text())
    for name in ("bot_id", "secret", "topic_id", "topic_name", "wechat_accounts", "bridge_root"):
        if not settings.get(name):
            raise SystemExit("Publisher configuration is incomplete.")
    database = LIVE / "data/requests.sqlite"
    if database.exists():
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            if db.execute("SELECT count(*) FROM requests WHERE state IN ('processing','publishing')").fetchone()[0]:
                raise SystemExit("A request is active; deploy after it finishes.")
    if ctl("print", DOMAIN + "/" + LABEL).returncode == 0:
        result = ctl("bootout", DOMAIN + "/" + LABEL)
        if result.returncode:
            raise SystemExit("Could not stop the publisher service.")
    LIVE.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ("dist", "node_modules"):
        destination = LIVE / name
        destination.mkdir(exist_ok=True)
        subprocess.run(["/bin/cp", "-cRP", str(ROOT / name) + "/.", str(destination)], check=True)
    shutil.copy2(ROOT / "package.json", LIVE / "package.json")
    data = LIVE / "data"
    data.mkdir(exist_ok=True, mode=0o700)
    target = data / "config.json"
    target.write_text(json.dumps(settings, ensure_ascii=False))
    target.chmod(0o600)
    PLIST.parent.mkdir(exist_ok=True)
    PLIST.write_bytes(plistlib.dumps({
        "Label": LABEL,
        "ProgramArguments": [node, "dist/apps/link-publisher/src/main.js"],
        "WorkingDirectory": str(LIVE),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ExitTimeOut": 10,
        "Umask": 0o077,
        "EnvironmentVariables": {
            "LINK_PUBLISHER_CONFIG": str(target),
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        },
        "StandardOutPath": str(data / "service.log"),
        "StandardErrorPath": str(data / "service.log"),
    }))
    PLIST.chmod(0o600)
    result = ctl("bootstrap", DOMAIN, str(PLIST))
    if result.returncode:
        raise SystemExit("Could not start the publisher service.")
    print("Private-link publisher installed and started.")


def status():
    state = LIVE / "data/status.json"
    print(state.read_text() if state.exists() else '{"ready":false}')


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "status"])
    parser.add_argument("--config", type=Path, default=ROOT / "data/link-publisher/config.json")
    args = parser.parse_args()
    install(args.config) if args.action == "install" else status()
