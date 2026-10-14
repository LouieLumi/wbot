"""ADB / UiAutomator2 adapter. JSON over stdin/stdout; never log chat content.

WeChat selectors are version-specific. No real send until a profile with an
independent conversation identity selector has been calibrated after login.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
ADB = ROOT / '.runtime/android-sdk/platform-tools/adb'
SERIAL = os.getenv('WECHAT_DEVICE_SERIAL', 'emulator-5556')
PORT = os.getenv('ADB_SERVER_PORT', '5038')
PROFILE = Path(os.getenv('WECHAT_PROFILE', str(ROOT / 'config/wechat-profile.json')))
PACKAGE = 'com.tencent.mm'

def adb(*args):
    return subprocess.check_output([str(ADB), '-P', PORT, '-s', SERIAL, *args], timeout=12, stderr=subprocess.DEVNULL).decode('utf-8', errors='replace')

def profile():
    if not PROFILE.exists():
        return {'calibrated': False, 'chats': []}
    return json.loads(PROFILE.read_text())

def status():
    result = {'mode': 'adb', 'serial': SERIAL, 'connected': False, 'installed': False,
              'foreground': False, 'calibrated': profile().get('calibrated', False),
              'background_reliable': False, 'login': 'unknown'}
    try:
        result['connected'] = adb('get-state').strip() == 'device'
        result['installed'] = 'package:' in adb('shell', 'pm', 'path', PACKAGE)
        activity = adb('shell', 'dumpsys', 'activity', 'activities')
        result['foreground'] = any(PACKAGE in line and ('mResumedActivity' in line or 'topResumedActivity' in line) for line in activity.splitlines())
    except Exception:
        result['error'] = 'device_unavailable'
    return result

def connect():
    import adbutils
    import uiautomator2 as u2
    client = adbutils.AdbClient(host='127.0.0.1', port=int(PORT))
    device=u2.connect(client.device(SERIAL))
    # Keep the dedicated phone rendering while USB-powered. This does not
    # dismiss a secure lock screen or keep it awake after unplugging USB.
    device.shell(['svc','power','stayon','usb'])
    if not device.info.get('screenOn'):device.screen_on()
    return device

def unique(d, xpath):
    matches = d.xpath(xpath).all()
    if len(matches) != 1:
        raise ValueError('selector_not_unique')
    return matches[0]

def text(node):
    return node.attrib.get('text', '') or node.attrib.get('content-desc', '')

def validate(d, p, chat):
    if not p.get('calibrated') or not chat.get('verified'):
        raise ValueError('not_calibrated')
    if d.app_current().get('package') != PACKAGE or not d.info.get('screenOn'):
        raise ValueError('wechat_not_foreground')
    if d.app_info(PACKAGE).get('versionName') != p['version_name']:
        raise ValueError('wechat_version_changed')
    if text(unique(d, p['title_xpath'])) != chat['title']:
        raise ValueError('wrong_chat')
    # A matching title alone cannot disambiguate same-name chats.
    if chat['identity_xpath'] == p['title_xpath'] or not chat['identity_value']:
        raise ValueError('independent_identity_required')
    if text(unique(d, chat['identity_xpath'])) != chat['identity_value']:
        raise ValueError('identity_mismatch')

def active_chat(d, p):
    found = []
    for chat in p.get('chats', []):
        try:
            validate(d, p, chat)
            found.append(chat)
        except (ValueError, KeyError):
            pass
    return found[0] if len(found) == 1 else None

def public_chat(chat):
    return {k: chat[k] for k in ['id', 'name', 'type', 'verified']}

def rows(d, p):
    result = []
    for row in d.xpath(p['rows_xpath']).all():
        node = row.elem
        texts = node.xpath(p['row_text_xpath'])
        if len(texts) != 1:
            continue
        content = text(texts[0])
        senders = node.xpath(p['row_sender_xpath']) if p.get('row_sender_xpath') else []
        sender = text(senders[0]) if len(senders) == 1 else None
        own_nodes = node.xpath(p['row_own_xpath']) if p.get('row_own_xpath') else []
        incoming = node.xpath(p['row_incoming_xpath']) if p.get('row_incoming_xpath') else []
        own = True if own_nodes and not incoming else False if incoming and not own_nodes else None
        # UI text is not proof of a real WeChat mention relationship.
        key = hashlib.sha256(json.dumps([sender, content, own], ensure_ascii=False).encode()).hexdigest()
        result.append({'key': key, 'sender': sender, 'content': content, 'own': own, 'mention': 'unknown'})
    return result

def snapshot(d, p):
    chat = active_chat(d, p)
    if not chat:
        return {'chat': None, 'rows': [], 'reliability': 'uncalibrated_or_unverified_chat'}
    return {'chat': public_chat(chat), 'rows': rows(d, p), 'reliability': 'foreground_only_mentions_unverified'}

def send(d, p, data):
    tapped = False
    try:
        matches = [c for c in p.get('chats', []) if c['id'] == data['chat_id']]
        if len(matches) != 1:
            raise ValueError('unknown_chat')
        chat = matches[0]
        if active_chat(d, p) != chat:
            # Optional calibrated selector from WeChat's visible conversation list.
            if not chat.get('open_xpath') or d.app_current().get('package') != PACKAGE:
                raise ValueError('open_authorized_chat_manually')
            unique(d, chat['open_xpath']).click()
            time.sleep(0.5)
        validate(d, p, chat)
        field = unique(d, p['input_xpath'])
        if text(field):
            raise ValueError('existing_draft_do_not_overwrite')
        before = rows(d, p)
        # UiObject.set_text supports Unicode without shell interpolation or an IME.
        candidates = d.xpath(p['input_xpath']).all()
        rid = candidates[0].attrib.get('resource-id')
        if not rid or d(resourceId=rid).count != 1:
            raise ValueError('input_resource_not_unique')
        d(resourceId=rid).set_text(data['content'])
        validate(d, p, chat)
        if text(unique(d, p['input_xpath'])) != data['content']:
            raise ValueError('input_not_verified')
        button = unique(d, p['send_xpath'])
        tapped = True  # From this point onward every exception means uncertain delivery.
        button.click()
        for _ in range(5):
            time.sleep(0.5)
            validate(d, p, chat)
            after = rows(d, p)
            count = lambda rs: sum(r['own'] is True and r['content'] == data['content'] for r in rs)
            failed = bool(d.xpath(p['failure_xpath']).all()) if p.get('failure_xpath') else True
            if count(after) > count(before) and not text(unique(d, p['input_xpath'])) and not failed:
                return {'state': 'sent', 'reason': 'outgoing_bubble_observed_not_delivery_receipt'}
        return {'state': 'uncertain', 'reason': 'no_reliable_ui_confirmation'}
    except Exception:
        return {'state': 'uncertain' if tapped else 'failed', 'reason': 'ui_state_or_identity_not_verified'}

def main():
    op = sys.argv[1]
    p = profile()
    if op == 'status': return status()
    if op == 'chats': return [public_chat(c) for c in p.get('chats', []) if p.get('calibrated') and c.get('verified')]
    if op == 'probe':
        d = connect()
        xml = d.dump_hierarchy()
        root = ET.fromstring(xml)
        # Only structural information leaves this process; no message/login text.
        return {'device': status(), 'node_count': len(list(root.iter('node'))),
                'edit_fields': sum(n.get('class') == 'android.widget.EditText' for n in root.iter('node')),
                'resource_ids': sorted({n.get('resource-id') for n in root.iter('node') if n.get('package') == PACKAGE and n.get('resource-id')})}
    if not p.get('calibrated'):
        return {'chat': None, 'rows': [], 'reliability': 'needs_login_and_calibration'} if op == 'snapshot' else {'state':'failed','reason':'not_calibrated'}
    d = connect()
    if p.get('ui_mode') == 'vision':
        import vision_device
        if op == 'snapshot': return vision_device.snapshot(d, p, json.load(sys.stdin).get('chat_id'))
        if op == 'register': return vision_device.register(d, p, json.load(sys.stdin)['name'], PROFILE)
        if op == 'send': return vision_device.send(d, p, json.load(sys.stdin))
    if op == 'snapshot': return snapshot(d, p)
    if op == 'send': return send(d, p, json.load(sys.stdin))
    raise ValueError('unknown_operation')

if __name__ == '__main__':
    try:
        print(json.dumps(main(), ensure_ascii=False))
    except Exception as error:
        # Keep a bounded diagnostic with fixed codes only, never raw UI text.
        safe={'ambiguous_chat_list_entry','authorized_chat_not_visible','chat_changed_after_tap','chat_changed_during_verification','chat_list_changed','existing_draft_do_not_overwrite','group_count_not_verified','group_details_mismatch','group_menu_not_unique','input_field_not_found','keyboard_or_unknown_layout','navigation_requires_chat_or_list','private_remark_not_saved','send_button_not_unique','unknown_chat','visual_label_not_unique','visual_transition_timeout','wechat_not_foreground','wechat_version_changed','wrong_chat','group_remark_identity_mismatch'}
        reason=str(error) if str(error) in safe else type(error).__name__
        diagnostic=ROOT/'.runtime/device-error.json'
        diagnostic.write_text(json.dumps({'at':time.time(),'operation':sys.argv[1] if sys.argv[1] in {'snapshot','send','register','probe','status','chats'} else 'unknown','reason':reason}));diagnostic.chmod(0o600)
        print(json.dumps({'error': 'device_operation_failed'}))
        sys.exit(1)
