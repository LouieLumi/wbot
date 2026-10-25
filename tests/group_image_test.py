import base64
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from hermes_group_image import GroupImage, local_url

class GroupImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / 'db.sqlite')
        self.member = 'wxid:' + hashlib.sha256(b'wxid_a').hexdigest()
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('''CREATE TABLE settings(key,value); INSERT INTO settings VALUES('paused','false'),('auto_reply','true');
            CREATE TABLE groups(id,enabled,verified,paused); INSERT INTO groups VALUES('a@chatroom',1,1,0);
            CREATE TABLE members(chat_id,id,enabled,revision);''')
            db.execute('INSERT INTO members VALUES(?,?,1,0)', ('a@chatroom', self.member))
        self.scope = dict(database=self.db, member_id=self.member, revision=0, chat_id='a@chatroom', sender_id='wxid_a', request_message_id='a@chatroom:s123', before=200, base_url='http://127.0.0.1:3151', token='secret-test')
        data=io.BytesIO();Image.new('RGB',(100,100),'red').save(data,'JPEG')
        self.image = dict(ok=True, chat_id='a@chatroom', sender_id='wxid_a', member='', target_id='wxid_a', target_name='A', request_message_id='a@chatroom:s123', message_id='a@chatroom:s122', timestamp=199, quality='thumbnail', mime_type='image/jpeg', width=100, height=100, data=base64.b64encode(data.getvalue()).decode())
        self.restricted = False
        self.analyzed = []
        self.requests = []
        self.tool = GroupImage(self.scope, {}, self.restrict, self.analyze)
    def tearDown(self):
        self.temp.cleanup()
    def restrict(self):
        self.restricted = True
    def analyze(self,image,question):
        self.analyzed.append((image['message_id'],question));return '红色图片'
    def opener(self,request,timeout):
        self.requests.append(request)
        return io.BytesIO(json.dumps(self.image).encode())
    def call(self,args=None):
        with patch('hermes_group_image.build_opener') as mocked:
            mocked.return_value.open.side_effect=self.opener
            return json.loads(self.tool.inspect(args if args is not None else {'question':'这是什么颜色'}))
    def test_only_selected_image_and_bounded_cached_calls(self):
        self.assertEqual(self.requests,[])  # constructing a tool never reads an image
        answer=self.call();self.assertEqual(answer['analysis'],'红色图片');self.assertTrue(self.restricted)
        self.assertIn('缩略图',answer['note']);self.assertNotIn('data',answer)
        payload=json.loads(self.requests[0].data)
        self.assertEqual(payload,{**{k:self.scope[k] for k in ('chat_id','sender_id','request_message_id')}, 'member':''})
        self.call();self.assertEqual(len(self.requests),1);self.assertEqual(len(self.analyzed),2)
        self.call()
        self.assertEqual(self.call()['error'],'image_tool_limit')
    def test_wrong_group_sender_anchor_future_image_and_invalid_data_fail_closed(self):
        for key,value in [('chat_id','b@chatroom'),('sender_id','wxid_b'),('target_id','wxid_b'),('member','B'),('request_message_id','a@chatroom:s999'),('timestamp',201),('data','<html>'),('width',30000)]:
            with self.subTest(key=key):
                previous=self.image[key];self.image[key]=value
                self.tool.results={};self.tool.calls=0
                self.assertEqual(self.call()['error'],'image_analysis_failed');self.assertEqual(self.analyzed,[])
                self.image[key]=previous
    def test_model_cannot_override_scope_and_missing_image_is_not_invented(self):
        self.assertEqual(self.call({'question':'看看','chat_id':'b@chatroom'})['error'],'invalid_image_arguments')
        self.assertEqual(len(self.requests),0)
        self.image={'ok':False,'error':'image_not_found'}
        self.assertEqual(self.call()['error'],'image_not_found');self.assertEqual(self.analyzed,[])
    def test_revocation_and_identity_mismatch_block_even_cached_image(self):
        self.call()
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:db.execute('UPDATE members SET revision=1')
        self.assertEqual(self.call()['error'],'image_not_authorized');self.assertEqual(len(self.analyzed),1)
        self.tool.scope['sender_id']='wxid_b';self.assertFalse(self.tool.authorized())
    def test_local_endpoints_only(self):
        for url in ('https://example.com','http://127.0.0.1@evil.test','file:///tmp/x','http://127.0.0.1/?token=x'):
            with self.assertRaises(ValueError):local_url(url)

    def test_different_members_have_separate_images_and_ambiguity_never_analyzes(self):
        self.call()
        self.image.update(member='B', target_id='wxid_b', target_name='群员 B', message_id='a@chatroom:s121')
        other=self.call({'question':'B 的图片是什么', 'member':'B'})
        self.assertEqual(other['member_id'],'wxid_b')
        self.assertEqual([x[0] for x in self.analyzed],['a@chatroom:s122','a@chatroom:s121'])
        self.image={'ok':False,'error':'image_member_ambiguous','candidates':[{'id':'wxid_c','name':'C'}]}
        self.assertEqual(self.call({'question':'看看 C 的', 'member':'C'})['error'],'image_member_ambiguous')
        self.assertEqual(len(self.analyzed),2)

    def test_waits_for_clear_download_and_rechecks_revocation(self):
        final={**self.image,'quality':'image','width':3000,'height':1000}
        data=io.BytesIO();Image.new('RGB',(3000,1000),'blue').save(data,'JPEG');final['data']=base64.b64encode(data.getvalue()).decode()
        with patch('hermes_group_image.build_opener') as mock, patch('hermes_group_image.time.sleep'):
            mock.return_value.open.side_effect=[io.BytesIO(json.dumps({'ok':False,'error':'image_downloading'}).encode()),io.BytesIO(json.dumps(final).encode())]
            result=json.loads(self.tool.inspect({'question':'看清楚图里的字'}))
            self.assertEqual(result['quality'],'image');self.assertEqual(result['width'],3000)
            self.assertEqual(mock.return_value.open.call_count,2)
        self.tool.results={}
        def revoke(_):
            with contextlib.closing(sqlite3.connect(self.db)) as db, db:db.execute('UPDATE groups SET enabled=0')
        with patch('hermes_group_image.build_opener') as mock, patch('hermes_group_image.time.sleep',side_effect=revoke):
            mock.return_value.open.return_value=io.BytesIO(b'{"ok":false,"error":"image_downloading"}')
            self.assertEqual(json.loads(self.tool.inspect({'question':'继续看'}))['error'],'image_not_authorized')
            self.assertEqual(mock.return_value.open.call_count,1)

if __name__=='__main__':unittest.main()
