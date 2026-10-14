"""Use Hermes' built-in iLink login and render a local QR for this deployment."""
import asyncio
import json
import os
from pathlib import Path
import sys

os.umask(0o077)
hermes_root = Path.home() / '.hermes'
sys.path.insert(0, str(hermes_root / 'hermes-agent'))
from gateway.platforms import weixin
from hermes_cli.config import save_env_value
from ruamel.yaml import YAML
import qrcode

runtime = Path(__file__).resolve().parents[1] / '.runtime'
qr_path = runtime / 'hermes-weixin-login.png'

def display_qr(value, url, *, report_render_error):
    qrcode.make(url or value).save(qr_path)
    qr_path.chmod(0o600)
    print(json.dumps({'event': 'qr_ready', 'path': str(qr_path)}), flush=True)

async def main():
    weixin._print_qr = display_qr
    credentials = await weixin.qr_login(str(hermes_root), timeout_seconds=480)
    if not credentials:
        raise SystemExit('Weixin login was not completed; gateway remains disabled.')
    owner = credentials.get('user_id', '')
    if not owner:
        raise SystemExit('Login did not identify the owner; gateway remains disabled.')
    for key, value in {
        'WEIXIN_ACCOUNT_ID': credentials['account_id'],
        'WEIXIN_TOKEN': credentials['token'],
        'WEIXIN_BASE_URL': credentials['base_url'],
        'WEIXIN_ALLOWED_USERS': owner,
        'WEIXIN_ALLOW_ALL_USERS': 'false',
        'WEIXIN_HOME_CHANNEL': owner,
    }.items():
        save_env_value(key, value)
    yaml = YAML()
    config_path = hermes_root / 'config.yaml'
    config = yaml.load(config_path)
    config.setdefault('platforms', {})['weixin'] = {
        'enabled': True,
        'extra': {'dm_policy': 'allowlist', 'group_policy': 'disabled', 'allow_from': [owner]},
    }
    temporary = config_path.with_suffix('.yaml.tmp')
    with temporary.open('w') as output:
        yaml.dump(config, output)
    temporary.chmod(0o600)
    temporary.replace(config_path)
    qr_path.unlink(missing_ok=True)
    print(json.dumps({'event': 'bound', 'owner_only': True, 'account_id': credentials['account_id']}), flush=True)

asyncio.run(main())
