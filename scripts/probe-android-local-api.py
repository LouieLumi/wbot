"""Probe the phone's authenticated loopback API, without reading secrets into logs.

ADB forwarding must already be configured: host 3151 -> phone 8767.
Only explicit --send-text sends a message, to one exact embedded allowlist name.
"""
import argparse
import json
import os
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / '.runtime/android-research/local-api-config.json'

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', action='store_true')
    parser.add_argument('--send-group')
    parser.add_argument('--send-text')
    parser.add_argument('--check-text', help='Read-only delivery check for an exact previously sent test text')
    parser.add_argument('--save', type=Path)
    args = parser.parse_args()
    config = json.loads(CONFIG.read_text())

    def request(path, body=None):
        req = urllib.request.Request('http://127.0.0.1:3151' + path,
            data=json.dumps(body, ensure_ascii=False).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)

    result = {'status': request('/status'), 'groups': request('/groups')['groups']}
    if args.events:
        result['events'] = request('/events?after=0')
    if args.send_text:
        assert args.send_group in [group['name'] for group in config['groups']], 'Group not allowlisted'
        matches = [group for group in result['groups'] if group['name'] == args.send_group]
        assert len(matches) == 1, 'Group must resolve uniquely'
        result['send'] = request('/send', {'chat_id': matches[0]['id'], 'content': args.send_text, 'id': str(uuid.uuid4())})
    if args.check_text:
        matches = [group for group in result['groups'] if group['name'] == args.send_group]
        assert len(matches) == 1, 'Group must resolve uniquely'
        result['delivery'] = request('/delivery', {'chat_id': matches[0]['id'], 'content': args.check_text})
    if args.save:
        args.save.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        args.save.chmod(0o600)
    safe = {'status': result['status'], 'groups': [group['name'] for group in result['groups']]}
    if 'events' in result:
        safe['events'] = {'count': len(result['events']['events']), 'cursor': result['events']['cursor'],
                          'with_sender_id': sum(bool(event.get('sender_wxid')) for event in result['events']['events'])}
    if 'send' in result:
        safe['send'] = result['send']
    if 'delivery' in result:
        safe['delivery'] = result['delivery']
    print(json.dumps(safe, ensure_ascii=False))

if __name__ == '__main__':
    main()
