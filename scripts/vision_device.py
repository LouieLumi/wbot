"""Foreground-only WeChat visual driver for builds with unavailable UI nodes.

Uses local macOS Vision OCR, private group remarks and Android input APIs.
Never modifies WeChat or infers a real mention from displayed text.
"""
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import time
import unicodedata
import secrets
import os

ROOT = Path(__file__).resolve().parents[1]
DEVICE_KEY=hashlib.sha256((os.getenv('WECHAT_DEVICE_SERIAL','emulator-5556')+'\0'+os.getenv('WECHAT_PROFILE','config/wechat-profile.json')).encode()).hexdigest()[:16]
LEASE = ROOT / ('.runtime/vision-lease-'+DEVICE_KEY+'.json')

def leases():
    try:
        value=json.loads(LEASE.read_text())
        return {value['chat_id']:value} if 'chat_id' in value else value
    except (OSError,ValueError):return {}

def normal(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))

def capture(d):
    # uiautomator2's default screenshot is JPEG quality 80. Use Android's
    # lossless capture so dark text/avatars do not change with compression.
    image = d.screenshot(display_id=0).convert('RGB')
    buf = io.BytesIO(); image.save(buf, format='PNG')
    data = json.loads(subprocess.check_output([str(ROOT / '.runtime/bin/wechat-ocr')], input=buf.getvalue(), timeout=15))
    # A separate title crop avoids body screenshots confusing the OCR layout.
    x,y=int(image.width*.10),int(image.height*.030)
    crop=image.crop((x,y,int(image.width*.88),int(image.height*.100)))
    title_bytes=io.BytesIO();crop.save(title_bytes,format='PNG')
    title=json.loads(subprocess.check_output([str(ROOT / '.runtime/bin/wechat-ocr')],input=title_bytes.getvalue(),timeout=15))
    data['items']=[n for n in data['items'] if not (x<n['bounds'][0]<image.width*.88 and y<n['bounds'][1]<image.height*.100)]
    for n in title['items']:
        a,b,c,e=n['bounds'];n['bounds']=[a+x,b+y,c+x,e+y];data['items'].append(n)
    if is_chat_info(data):
        # Separate the right-hand values from English field labels. Whole-page
        # OCR dropped a Chinese character in the original group's name.
        x,y=int(image.width*.53),int(image.height*.32);right,bottom=int(image.width*.98),int(image.height*.78)
        buf=io.BytesIO();image.crop((x,y,right,bottom)).save(buf,format='PNG')
        values=json.loads(subprocess.check_output([str(ROOT/'.runtime/bin/wechat-ocr')],input=buf.getvalue(),timeout=15))
        data['items']=[n for n in data['items'] if not (x<(n['bounds'][0]+n['bounds'][2])/2<right and y<(n['bounds'][1]+n['bounds'][3])/2<bottom)]
        for n in values['items']:
            a,b,c,e=n['bounds'];n['bounds']=[a+x,b+y,c+x,e+y];data['items'].append(n)
    data['image'] = image
    refine_bubbles(data)
    return data

def refine_bubbles(frame):
    """Re-read low-confidence short text in its own bubble, not the whole page."""
    image=frame['image'];w,h=image.size
    try:composer=field(frame)
    except ValueError:return
    for region in components(image,'white')+components(image,'green'):
        box=region['bounds'];a,b,c,e=box
        if b<.12*h or e>=composer[1]-8 or e-b>.20*h or region['fill']<.6:continue
        tokens=[n for n in frame['items'] if in_box(n,box)]
        if not any(n['confidence']<.5 for n in tokens):continue
        x,y=max(0,a-8),max(0,b-8);buf=io.BytesIO()
        image.crop((x,y,min(w,c+8),min(h,e+8))).save(buf,format='PNG')
        local=json.loads(subprocess.check_output([str(ROOT/'.runtime/bin/wechat-ocr')],input=buf.getvalue(),timeout=15))
        # Retain small glyphs from the full frame: they may identify a picture.
        frame['items']=[n for n in frame['items'] if not in_box(n,box) or n['bounds'][3]-n['bounds'][1]<=.012*h]
        for n in local['items']:
            l,t,r,bottom=n['bounds'];n['bounds']=[l+x,t+y,r+x,bottom+y];frame['items'].append(n)

def click(d, item):
    x1,y1,x2,y2=item['bounds'];d.click((x1+x2)/2,(y1+y2)/2)

def exact(frame, label):
    found=[n for n in frame['items'] if normal(n['text'])==normal(label)]
    if len(found)!=1:raise ValueError('visual_label_not_unique')
    return found[0]

def action_label(frame, labels, maximum_y=1):
    found=[n for n in frame['items'] if normal(n['text']) in {normal(s) for s in labels} and n['bounds'][1]<maximum_y*frame['height']]
    if len(found)!=1:raise ValueError('visual_label_not_unique')
    return found[0]

def title_matches(frame, chat):
    expected={normal(chat['title']),*(normal(t) for t in chat.get('title_ocr_aliases',[]))}
    return len([n for n in frame['items'] if .025*frame['height']<n['bounds'][1]<.12*frame['height'] and normal(n['text']) in expected and n['confidence']>=.5])==1

def wait_frame(d, predicate, timeout=12):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        frame=capture(d)
        try:
            if predicate(frame):return frame
        except ValueError:
            pass # An animation/keyboard transition is not yet a usable frame.
        time.sleep(.3)
    raise ValueError('visual_transition_timeout')

def check_app(d,p):
    if d.app_current().get('package')!='com.tencent.mm' or not d.info.get('screenOn'):raise ValueError('wechat_not_foreground')
    if d.app_info('com.tencent.mm').get('versionName')!=p['version_name']:raise ValueError('wechat_version_changed')

def group_menu(frame):
    # Detect three contrasting dots, including a shorter real-phone toolbar.
    im=frame['image'];w,h=im.size
    dark=dark_theme(im)
    cells={(x,y) for y in range(int(.035*h),int(.11*h)) for x in range(int(.88*w),int(.97*w)) if (min(im.getpixel((x,y)))>145 if dark else max(im.getpixel((x,y)))<100)}
    dots=[]
    while cells:
        stack=[cells.pop()];points=[]
        while stack:
            point=stack.pop();points.append(point);x,y=point
            for neighbor in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if neighbor in cells:cells.remove(neighbor);stack.append(neighbor)
        x1=min(x for x,y in points);x2=max(x for x,y in points);y1=min(y for x,y in points);y2=max(y for x,y in points)
        if .004*w<x2-x1<.025*w and .004*w<y2-y1<.025*w:dots.append([x1,y1,x2,y2])
    if len(dots)!=3 or max(b[1] for b in dots)-min(b[1] for b in dots)>.008*h:raise ValueError('group_menu_not_unique')
    return {'bounds':[min(b[0] for b in dots),min(b[1] for b in dots),max(b[2] for b in dots),max(b[3] for b in dots)]}

def remark_matches(frame,chat):
    if not chat.get('private_remark'):return False
    expected={normal(chat['private_remark'])}
    expected.update(re.sub(r'\(\d+\)$','',normal(t)) for t in chat.get('title_ocr_aliases',[]))
    return any(normal(n['text']).rstrip('>›') in expected for n in frame['items'])

def verify_identity(d,p,chat):
    """Verify original group name plus a unique, account-private group remark."""
    check_app(d,p)
    frame=capture(d)
    if not title_matches(frame,chat):raise ValueError('wrong_chat')
    click(d,group_menu(frame))
    # Header animation can finish before the right-hand values are rendered.
    # Wait for both independent identity values, retrying OCR on fresh frames.
    info=wait_frame(d,lambda f:is_chat_info(f) and remark_matches(f,chat) and any(normal(n['text']).rstrip('>›')==normal(chat['name']) for n in f['items']))
    # Verify original group name and the account-private remark independently.
    error=None
    if not any(normal(n['text']).rstrip('>›')==normal(chat['name']) for n in info['items']):error='group_details_mismatch'
    if not remark_matches(info,chat):
        LEASE.unlink(missing_ok=True)
        error='group_remark_identity_mismatch'
    # A rejected identity must not strand all later group polls in Chat Info.
    d.press('back')
    result=wait_frame(d,lambda f:title_matches(f,chat))
    if error:raise ValueError(error)
    time.sleep(.4);result=capture(d)
    if not title_matches(result,chat):raise ValueError('chat_changed_during_verification')
    cached=leases();cached[chat['id']]={'chat_id':chat['id'],'pid':d.app_current().get('pid'),'until':time.time()+60,'private_remark':chat['private_remark']}
    LEASE.write_text(json.dumps(cached))
    return result

def dark_theme(image):
    return max(image.getpixel((int(image.width*.018),int(image.height*.5))))<80

def components(image, kind):
    """Connected color regions; all coordinates come from the current frame."""
    step=4;small=image.resize((image.width//step,image.height//step));w,h=small.size
    cells=set();dark=dark_theme(image)
    for y in range(int(h*.12),int(h*.98)):
        for x in range(int(w*.10),int(w*.96)):
            r,g,b=small.getpixel((x,y))
            neutral=(32<=r<=75 and max(r,g,b)-min(r,g,b)<8) if dark else (r>247 and g>247 and b>247)
            ok=neutral if kind=='white' else (g>170 and 0<=r<205 and b<185 and g-r>25 and g-b>30)
            if ok:cells.add((x,y))
    found=[]
    while cells:
        first=cells.pop();stack=[first];x1=x2=first[0];y1=y2=first[1];count=0
        while stack:
            x,y=stack.pop();count+=1;x1=min(x1,x);x2=max(x2,x);y1=min(y1,y);y2=max(y2,y)
            for point in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if point in cells:cells.remove(point);stack.append(point)
        if (x2-x1)*step>35 and (y2-y1)*step>35:
            found.append({'bounds':[x1*step,y1*step,(x2+1)*step,(y2+1)*step],'fill':count/((x2-x1+1)*(y2-y1+1))})
    return found

def in_box(item,box):
    a,b,c,d=item['bounds'];x1,y1,x2,y2=box
    return x1-3<=(a+c)/2<=x2+3 and y1-3<=(b+d)/2<=y2+3

def is_chat_list(frame):
    labels={normal(n['text']) for n in frame['items'] if n['bounds'][1]>.90*frame['height']}
    return any(tabs.issubset(labels) for tabs in ({'WeChat','Contacts','Discover','Me'},{'微信','通讯录','发现','我'},{'WeChat','通讯录','发现','我'}))

def is_chat_info(frame):
    return any(re.fullmatch(r'(?:ChatInfo|聊天信息)(?:\(\d+\))?',normal(n['text'])) and n['bounds'][1]<.12*frame['height'] for n in frame['items'])

def open_chat(d,p,chat):
    check_app(d,p);frame=capture(d)
    if is_chat_info(frame):
        # Recover navigation after a helper timeout/restart, without treating
        # the menu as identity proof or typing into an unknown conversation.
        d.press('back')
        frame=wait_frame(d,lambda f:is_chat_list(f) or any(title_matches(f,c) for c in p['chats']))
    if title_matches(frame,chat):return frame
    current=[c for c in p['chats'] if title_matches(frame,c)]
    if len(current)==1:
        if field_text(frame,field(frame)):raise ValueError('existing_draft_do_not_overwrite')
        d.press('back');frame=wait_frame(d,is_chat_list)
    if not is_chat_list(frame):raise ValueError('navigation_requires_chat_or_list')
    labels={normal(chat['private_remark'])}
    labels.update(normal(re.sub(r'\(\d+\)$','',normal(t))) for t in chat.get('title_ocr_aliases',[]))
    for attempt in range(6):
        found=[n for n in frame['items'] if normal(n['text']) in labels and .12*frame['height']<n['bounds'][1]<.90*frame['height']]
        if len(found)>1:raise ValueError('ambiguous_chat_list_entry')
        if len(found)==1:
            click(d,found[0])
            return wait_frame(d,lambda f:title_matches(f,chat))
        # Scroll only inside the verified conversation-list surface.
        w,h=frame['width'],frame['height']
        if attempt==0:
            for _ in range(2):d.swipe(.65*w,.35*h,.65*w,.80*h,duration=.2)
        else:d.swipe(.65*w,.78*h,.65*w,.35*h,duration=.3)
        time.sleep(.4);frame=capture(d)
        if not is_chat_list(frame):raise ValueError('chat_list_changed')
    raise ValueError('authorized_chat_not_visible')

def register(d,p,name,profile_path):
    """Admin explicitly selects the current group and assigns a private marker."""
    check_app(d,p);frame=capture(d)
    if field_text(frame,field(frame)):raise ValueError('existing_draft_do_not_overwrite')
    existing=[c for c in p['chats'] if c['name']==name and title_matches(frame,c)]
    if len(existing)==1:
        verify_identity(d,p,existing[0]);return {k:existing[0][k] for k in ['id','name','type','verified']}
    click(d,group_menu(frame))
    info=wait_frame(d,is_chat_info)
    if not any(normal(n['text']).rstrip('>›')==normal(name) for n in info['items']):
        d.press('back');raise ValueError('group_details_mismatch')
    headings=[normal(n['text']) for n in info['items'] if re.fullmatch(r'(?:ChatInfo|聊天信息)\(\d+\)',normal(n['text'])) and n['bounds'][1]<.12*info['height']]
    count=re.search(r'\((\d+)\)',headings[0]).group(1) if len(headings)==1 and re.search(r'\((\d+)\)',headings[0]) else None
    if not count:raise ValueError('group_count_not_verified')
    previous=[c for c in p['chats'] if c['name']==name and c.get('private_remark') and any(normal(n['text']).rstrip('>›')==normal(c['private_remark']) for n in info['items'])]
    if len(previous)==1:
        # Membership-count changes must retain the same Bridge ID and memories.
        chat=previous[0];chat['title']=chat['private_remark']+'('+count+')'
        chat['title_ocr_aliases']=[re.sub(r'\(\d+\)$','('+count+')',normal(t)) for t in chat.get('title_ocr_aliases',[])]
        d.press('back');wait_frame(d,lambda f:title_matches(f,chat));verify_identity(d,p,chat)
        target=Path(profile_path);temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(target)
        return {k:chat[k] for k in ['id','name','type','verified']}
    remark='Bridge '+str(100000+secrets.randbelow(900000))
    while any(c.get('private_remark')==remark for c in p['chats']):remark='Bridge '+str(100000+secrets.randbelow(900000))
    click(d,action_label(info,['Remark','备注']))
    edit=wait_frame(d,lambda f:any('visible only to you' in n['text'] or '群聊的备注仅自己可见' in n['text'] for n in f['items']))
    previous=[n['text'] for n in edit['items'] if .25*edit['height']<n['bounds'][1]<.36*edit['height'] and n['bounds'][0]>.15*edit['width'] and n['text']!='Remark']
    old=d.current_ime()
    try:
        d.set_input_ime(True);d.send_keys(remark,clear=True)
        ready=wait_frame(d,lambda f:any(normal(n['text'])==normal(remark) for n in f['items']))
        click(d,action_label(ready,['Done','完成'],maximum_y=.8))
        info=wait_frame(d,is_chat_info)
        if not any(normal(n['text']).rstrip('>›')==normal(remark) for n in info['items']):raise ValueError('private_remark_not_saved')
    finally:d.shell(['ime','set',old])
    d.press('back')
    result=wait_frame(d,lambda f:any(remark.split()[-1] in n['text'] and n['bounds'][1]<.12*f['height'] for n in f['items']))
    observed=[n['text'] for n in result['items'] if remark.split()[-1] in n['text'] and .025*result['height']<n['bounds'][1]<.12*result['height']]
    chat={'id':'group-'+secrets.token_hex(6),'name':name,'type':'group','verified':True,'private_remark':remark,'title':remark+'('+count+')','title_ocr_aliases':observed,'previous_remark':previous}
    verify_identity(d,{**p,'chats':[*p['chats'],chat]},chat)
    p['chats'].append(chat);target=Path(profile_path);temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(target)
    return {k:chat[k] for k in ['id','name','type','verified']}

def avatar_hash(frame,name_item):
    # Perceptual visual fingerprint, not a WeChat account identifier.
    w,h=frame['width'],frame['height'];image=frame['image'];label_y=name_item['bounds'][1]
    background=image.getpixel((int(.018*w),int(label_y)))
    cells={(x,y) for y in range(max(0,int(label_y-.035*h)),min(h,int(label_y+.075*h))) for x in range(int(.025*w),int(.135*w)) if max(abs(a-b) for a,b in zip(image.getpixel((x,y)),background))>10}
    boxes=[]
    while cells:
        stack=[cells.pop()];x1=w;y1=h;x2=y2=0
        while stack:
            x,y=stack.pop();x1=min(x1,x);x2=max(x2,x);y1=min(y1,y);y2=max(y2,y)
            for point in ((x-1,y),(x+1,y),(x,y-1),(x,y+1)):
                if point in cells:cells.remove(point);stack.append(point)
        if .07*w<x2-x1<.12*w and .07*w<y2-y1<.12*w and label_y-.03*h<y1<label_y+.01*h:boxes.append((x1,y1,x2+1,y2+1))
    if len(boxes)!=1:return ''
    x1,y1,x2,y2=boxes[0]
    im=image.crop((x1+3,y1+3,x2-3,y2-3)).convert('L').resize((9,8))
    values=list(im.get_flattened_data())
    if max(values)-min(values)<20:return ''
    bits=0
    # Ignore the outer rows: a 1px OCR baseline jitter changes avatar borders.
    for y in range(1,7):
        for x in range(8):bits=(bits<<1)|int(im.getpixel((x,y))>im.getpixel((x+1,y)))
    return '00'+f'{bits:012x}'+'00'

def field(frame,white=None):
    w,h=frame['width'],frame['height'];regions=white if white is not None else components(frame['image'],'white')
    choices=[r['bounds'] for r in regions if r['bounds'][1]>.55*h and (r['bounds'][2]-r['bounds'][0])>.35*w and .025*h<(r['bounds'][3]-r['bounds'][1])<.16*h and r['fill']>.6]
    if not choices:raise ValueError('input_field_not_found')
    box=max(choices,key=lambda b:b[1])
    # Composer must be in the bottom strip; never use a white message/photo area.
    if box[3]<.90*h:raise ValueError('keyboard_or_unknown_layout')
    return box

def field_text(frame,box):
    text=''.join(n['text'] for n in sorted(frame['items'],key=lambda n:(round(n['bounds'][1]/15),n['bounds'][0])) if in_box(n,box) and n['bounds'][3]-n['bounds'][1]>.012*frame['height'])
    if text.startswith(('Tap to convert to text','轻触说话转文字')):
        # A gray empty-composer hint is not a user's high-contrast typed draft.
        x1,y1,x2,y2=map(int,box);ink=0;dark=dark_theme(frame['image'])
        for y in range(y1+12,y2-12,2):
            for x in range(x1+12,x2-int(.12*frame['width']),2):
                pixel=frame['image'].getpixel((x,y))
                if (min(pixel)>190 if dark else max(pixel)<100):ink+=1
        if ink<20:return ''
    return text

def send_failure_visible(frame):
    """Conservatively reject a red failure mark next to an outgoing bubble."""
    im=frame['image'];w,h=im.size
    for region in components(im,'green'):
        x1,y1,x2,y2=region['bounds']
        if x2<.6*w or y1<.12*h or y2>.9*h:continue
        red=0
        for y in range(y1,y2,2):
            for x in range(max(0,x1-int(.10*w)),x1,2):
                r,g,b=im.getpixel((x,y))
                if r>180 and g<100 and b<100:red+=1
        if red>20:return True
    return False

def parse_rows(frame):
    w,h=frame['width'],frame['height'];white=components(frame['image'],'white');green=components(frame['image'],'green');composer=field(frame,white)
    output=[]
    for own,regions in [(False,white),(True,green)]:
        for region in regions:
            box=region['bounds'];x1,y1,x2,y2=box
            if y1<.12*h or y2>=composer[1]-8 or region['fill']<.60:continue
            if own and x2<.6*w:continue
            if not own and not (.12*w<x1<.28*w):continue
            if y2-y1>.20*h:continue
            tokens=[n for n in frame['items'] if in_box(n,box) and n['bounds'][3]-n['bounds'][1]>.012*h and n['confidence']>=.5]
            if not tokens:continue
            # Small OCR glyphs indicate an embedded screenshot/image, not a text bubble.
            tiny=[n for n in frame['items'] if in_box(n,box) and n['bounds'][3]-n['bounds'][1]<=.012*h]
            if tiny:continue
            tokens.sort(key=lambda n:(round(n['bounds'][1]/15),n['bounds'][0]))
            content='\n'.join(n['text'] for n in tokens)
            sender=None;avatar=''
            if not own:
                names=[n for n in frame['items'] if y1-.04*h<n['bounds'][3]<=y1+4 and abs(n['bounds'][0]-x1)<.06*w]
                if names:
                    label=max(names,key=lambda n:n['bounds'][1]);sender=label['text'];avatar=avatar_hash(frame,label)
            # OCR/thumbnail jitter must not replay a message. Repeated identical text
            # in a fully replaced window is intentionally treated as ambiguous.
            key=hashlib.sha256(json.dumps([normal(content),own],ensure_ascii=False).encode()).hexdigest()
            output.append({'key':key,'sender':sender,'content':content,'own':own,'mention':'unknown','avatar_hash':avatar,'_y':y1})
    output.sort(key=lambda r:r.pop('_y'))
    return output

def snapshot(d,p,chat_id=None):
    check_app(d,p)
    if chat_id:
        targets=[c for c in p['chats'] if c['id']==chat_id and c['verified']]
        if len(targets)!=1:raise ValueError('unknown_chat')
        open_chat(d,p,targets[0])
    frame=capture(d)
    matches=[c for c in p['chats'] if c['verified'] and title_matches(frame,c)]
    if len(matches)!=1:
        LEASE.unlink(missing_ok=True)
        return {'chat':None,'rows':[],'reliability':'visual_wrong_or_unreadable_chat'}
    chat=matches[0]
    lease=leases().get(chat['id'],{})
    if lease.get('private_remark')!=chat.get('private_remark') or lease.get('chat_id')!=chat['id'] or lease.get('pid')!=d.app_current().get('pid') or lease.get('until',0)<time.time():frame=verify_identity(d,p,chat)
    return {'chat':{k:chat[k] for k in ['id','name','type','verified']},'rows':parse_rows(frame),'reliability':'foreground_visual_ocr_partial_mentions_unverified'}

def send(d,p,data):
    tapped=False
    original_ime=None
    try:
        matches=[c for c in p['chats'] if c['id']==data['chat_id'] and c['verified']]
        if len(matches)!=1:raise ValueError('unknown_chat')
        chat=matches[0];open_chat(d,p,chat);before=verify_identity(d,p,chat);box=field(before)
        if field_text(before,box):raise ValueError('existing_draft_do_not_overwrite')
        previous=parse_rows(before)
        original_ime=d.current_ime()
        d.set_input_ime(True)
        d.click((box[0]+box[2])/2,(box[1]+box[3])/2)
        # UiAutomator's documented Unicode input helper uses standard Android IME APIs.
        d.send_keys(data['content'],clear=False)
        ready=wait_frame(d,lambda f:title_matches(f,chat) and normal(field_text(f,field(f)))==normal(data['content']))
        check_app(d,p)
        buttons=[n for n in ready['items'] if normal(n['text']) in ['Send','发送'] and n['bounds'][0]>.75*ready['width'] and n['bounds'][1]>.80*ready['height']]
        if len(buttons)!=1:raise ValueError('send_button_not_unique')
        tapped=True;click(d,buttons[0])
        for _ in range(5):
            time.sleep(.5);after=capture(d)
            if not title_matches(after,chat):raise ValueError('chat_changed_after_tap')
            if field_text(after,field(after)):continue
            if send_failure_visible(after):return {'state':'uncertain','reason':'visual_send_failure_indicator'}
            rows=parse_rows(after)
            count=lambda rs:sum(r['own'] and normal(r['content'])==normal(data['content']) for r in rs)
            if count(rows)>count(previous):
                # No delivery receipt is available. This state explicitly reports UI evidence only.
                return {'state':'sent','reason':'visual_outgoing_bubble_observed_not_delivery_receipt'}
        return {'state':'uncertain','reason':'visual_send_not_confirmed'}
    except Exception as e:
        safe={'wrong_chat','group_remark_identity_mismatch','existing_draft_do_not_overwrite','input_field_not_found','send_button_not_unique','visual_transition_timeout','wechat_not_foreground'}
        reason=str(e) if str(e) in safe else 'visual_state_not_verified'
        return {'state':'uncertain' if tapped else 'failed','reason':reason}
    finally:
        if original_ime:
            try:d.shell(['ime','set',original_ime])
            except Exception:pass
