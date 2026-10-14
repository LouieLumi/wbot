"""Test Tencent Web WeChat login eligibility; never fetch contacts or send messages.

Endpoints and appid are taken from Tencent's public webwx JavaScript.
Successful session material stays in a private local directory for later setup.
"""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.runtime/web-wechat-probe'

def emit(**data):
    print(json.dumps(data, ensure_ascii=False), flush=True)

def main():
    os.umask(0o077)
    OUT.mkdir(parents=True, exist_ok=True)
    jar = http.cookiejar.LWPCookieJar(str(OUT / 'cookies.txt'))
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    opener.addheaders = [('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'), ('Referer', 'https://wx.qq.com/')]
    def get(url):
        with opener.open(url, timeout=40) as response:
            return response.read()
    query = urllib.parse.urlencode({'appid': 'wx782c26e4c19acffb', 'redirect_uri': 'https://wx.qq.com/cgi-bin/mmwebwx-bin/webwxnewloginpage', 'fun': 'new', 'lang': 'zh_CN', '_': int(time.time()*1000)})
    response = get('https://login.wx.qq.com/jslogin?' + query).decode()
    match = re.search(r'window.QRLogin.uuid\s*=\s*"([\w=-]+)"', response)
    if not match:
        emit(event='failed', reason='web_login_qr_unavailable')
        return 1
    uuid = match.group(1)
    qr = OUT / 'login.jpg'
    qr.write_bytes(get('https://login.weixin.qq.com/qrcode/' + uuid))
    emit(event='qr_ready', path=str(qr), purpose='web_wechat_login_eligibility_no_messages_sent')
    deadline = time.monotonic() + 480
    previous = None
    scanned = False
    while time.monotonic() < deadline:
        query = urllib.parse.urlencode({'loginicon': 'true', 'uuid': uuid, 'tip': 0 if scanned else 1, '_': int(time.time()*1000)})
        response = get('https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login?' + query).decode()
        status = re.search(r'window.code\s*=\s*(\d+)', response)
        code = status.group(1) if status else 'unknown'
        if code != previous:
            emit(event='login_status', code=code)
        previous = code
        if code == '201':
            scanned = True
        if code == '200':
            found = re.search(r'window.redirect_uri\s*=\s*"([^"]+)"', response)
            if not found:
                emit(event='failed', reason='missing_redirect'); return 1
            target = urllib.parse.urlsplit(found.group(1))
            if target.scheme != 'https' or target.hostname not in {'wx.qq.com', 'wx2.qq.com', 'wx8.qq.com', 'web.wechat.com', 'web2.wechat.com'}:
                emit(event='failed', reason='unexpected_redirect_host'); return 1
            xml = get(found.group(1) + '&fun=new&version=v2')
            document = ET.fromstring(xml)
            ret = document.findtext('ret')
            ready = ret == '0' and bool(document.findtext('wxsid')) and bool(document.findtext('skey'))
            if ready:
                (OUT / 'session.xml').write_bytes(xml)
                jar.save(ignore_discard=True, ignore_expires=True)
            outcome = {'event': 'result', 'web_login_supported': ready, 'ret': ret, 'message': document.findtext('message') or '', 'checked_at': int(time.time())}
            (OUT / 'result.json').write_text(json.dumps(outcome, ensure_ascii=False, indent=2))
            emit(**outcome)
            qr.unlink(missing_ok=True)
            return 0 if ready else 2
        # Tencent returns 408 for an ordinary long-poll timeout: keep waiting.
        if code in {'0', '400', '500'}:
            emit(event='failed', reason='login_expired_or_rejected', code=code)
            qr.unlink(missing_ok=True)
            return 2
        time.sleep(1)
    emit(event='failed', reason='login_timeout')
    qr.unlink(missing_ok=True)
    return 2

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, ET.ParseError) as error:
        emit(event='failed', reason=type(error).__name__)
        raise SystemExit(1)
