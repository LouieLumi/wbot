import sys
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from PIL import Image, ImageDraw

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import vision_device as v

def frame():
    image=Image.new('RGB',(1080,2400),(237,237,237));draw=ImageDraw.Draw(image)
    draw.rectangle((128,2204,844,2316),fill='white')
    draw.rectangle((172,900,600,1010),fill='white')
    draw.rectangle((450,1300,900,1410),fill=(149,236,105))
    item=lambda text,box:{'text':text,'bounds':box,'confidence':1}
    return {'width':1080,'height':2400,'image':image,'items':[
        item('Bridge 123456(5)',[350,150,740,205]),
        item('成员',[175,853,270,888]),item('@Nila 你好',[200,930,490,976]),
        item('收到',[485,1330,780,1377])], 'qr_hashes':[]}

class VisionTests(unittest.TestCase):
    def test_title_crop_does_not_replace_first_member_nickname(self):
        f=frame();name={'text':'自己的父亲。','bounds':[175,250,350,290],'confidence':1};f['items'].append(name)
        encoded=[json.dumps({k:val for k,val in f.items() if k!='image'}).encode(),json.dumps({'items':[]}).encode()]
        class Device:
            def screenshot(self,**kwargs):return f['image']
        with patch.object(v.subprocess,'check_output',side_effect=encoded):result=v.capture(Device())
        self.assertIn(name,result['items'])
    def test_chinese_done_ignores_keyboard_action(self):
        f=frame();f['items']=[{'text':'完成','bounds':[490,1100,580,1150],'confidence':1},{'text':'完成','bounds':[920,1980,1030,2030],'confidence':1}]
        self.assertEqual(v.action_label(f,['Done','完成'],maximum_y=.8)['bounds'][1],1100)
        with self.assertRaisesRegex(ValueError,'visual_label_not_unique'):v.action_label(f,['Done','完成'])
    def test_dark_phone_layout_reads_sender_and_preserves_draft(self):
        image=Image.new('RGB',(1080,2220),(17,17,17));draw=ImageDraw.Draw(image)
        draw.rectangle((128,1964,844,2076),fill=(41,41,41))
        draw.rectangle((172,410,600,520),fill=(44,44,44))
        draw.rectangle((450,730,900,840),fill=(26,179,103))
        for x in (976,1000,1024):draw.ellipse((x,126,x+8,134),fill=(220,220,220))
        item=lambda text,box:{'text':text,'bounds':box,'confidence':1}
        f={'width':1080,'height':2220,'image':image,'items':[
            item('Bridge 654321（5）',[350,81,720,133]),
            item('自己的父亲。',[175,368,345,407]),item('@Nila',[200,445,330,494]),
            item('收到',[485,755,780,807]),item('已有草稿',[200,1990,430,2040])]}
        self.assertTrue(v.title_matches(f,{'title':'Bridge 654321(5)'}))
        self.assertEqual(len(v.group_menu(f)['bounds']),4)
        rows=v.parse_rows(f)
        self.assertEqual([(r['sender'],r['content'],r['own']) for r in rows],[('自己的父亲。','@Nila',False),(None,'收到',True)])
        self.assertEqual(v.field_text(f,v.field(f)),'已有草稿')
        draw.ellipse((402,750,429,779),fill=(240,30,30))
        self.assertTrue(v.send_failure_visible(f))

    def test_chinese_chat_list_requires_all_four_tabs(self):
        f=frame();f['items']=[{'text':t,'bounds':[10+i*200,2300,110+i*200,2350]} for i,t in enumerate(['微信','通讯录','发现','我'])]
        self.assertTrue(v.is_chat_list(f))
        f['items'][0]['text']='WeChat';self.assertTrue(v.is_chat_list(f))
        f['items'].pop();self.assertFalse(v.is_chat_list(f))

    def test_low_confidence_mention_is_refined_from_its_bubble(self):
        f=frame();f['items'][2]['confidence']=.3
        local={'items':[{'text':'@Nila 你好','bounds':[36,38,326,84],'confidence':.5}]}
        with patch.object(v.subprocess,'check_output',return_value=json.dumps(local).encode()):v.refine_bubbles(f)
        self.assertEqual(v.parse_rows(f)[0]['content'],'@Nila 你好')

    def test_dark_chinese_hint_does_not_hide_a_typed_draft(self):
        im=Image.new('RGB',(1080,2220),(17,17,17));draw=ImageDraw.Draw(im)
        draw.rectangle((128,1964,844,2076),fill=(41,41,41))
        f={'width':1080,'height':2220,'image':im,'items':[{'text':'轻触说话转文字→','bounds':[400,1990,730,2040],'confidence':1}]}
        draw.rectangle((400,1990,650,2030),fill=(140,140,140))
        self.assertEqual(v.field_text(f,v.field(f)),'')
        draw.rectangle((400,1990,650,2030),fill=(213,213,213))
        self.assertEqual(v.field_text(f,v.field(f)),'轻触说话转文字→')

    def test_chat_info_values_are_read_in_a_separate_column(self):
        f=frame();f['items']=[{'text':'测试用中转站','bounds':[659,920,980,961],'confidence':1}]
        title={'items':[{'text':'Chat Info（5）','bounds':[240,20,620,75],'confidence':1}]}
        values={'items':[{'text':'测试用的中转站＞','bounds':[87,152,408,193],'confidence':1}]}
        encoded=[json.dumps({k:v for k,v in f.items() if k!='image'}).encode(),json.dumps(title).encode(),json.dumps(values).encode()]
        class Device:
            def screenshot(self,display_id=None):
                self.assert_lossless=display_id==0
                return f['image']
        with patch.object(v.subprocess,'check_output',side_effect=encoded):result=v.capture(Device())
        self.assertIn('测试用的中转站＞',[n['text'] for n in result['items']])
        self.assertNotIn('测试用中转站',[n['text'] for n in result['items']])
    def test_private_remark_accepts_only_calibrated_alias_and_exact_digits(self):
        chat={'private_remark':'Bridge 123456','title_ocr_aliases':['Briage 123456(5)']};f=frame()
        f['items']=[{'text':'Briage 123456 >','bounds':[300,1200,700,1250],'confidence':1}]
        self.assertTrue(v.remark_matches(f,chat))
        f['items'][0]['text']='Briage 739262 >';self.assertFalse(v.remark_matches(f,chat))
        f['items'][0]['text']='123456';self.assertFalse(v.remark_matches(f,chat))
    def test_interrupted_identity_check_recovers_from_chat_info(self):
        chat={'id':'g','title':'Bridge 123456(5)'};target=frame();info=frame()
        info['items']=[{'text':'Chat Info（5）','bounds':[350,150,740,205],'confidence':1}]
        class Device:
            keys=[]
            def press(self,key):self.keys.append(key)
        d=Device()
        with patch.object(v,'check_app'),patch.object(v,'capture',return_value=info),patch.object(v,'wait_frame',return_value=target):
            self.assertIs(v.open_chat(d,{'chats':[chat]},chat),target)
        self.assertEqual(d.keys,['back'])
    def test_identity_rejection_returns_from_menu_before_failing(self):
        chat={'id':'g','title':'Bridge 123456(5)','name':'授权群','private_remark':'Bridge 123456'}
        f=frame();info=frame();info['items']=[{'text':'不匹配的原群名','bounds':[300,1000,600,1050],'confidence':1},{'text':'Bridge 123456','bounds':[300,1200,700,1250],'confidence':1}]
        class Device:
            keys=[]
            def press(self,key):self.keys.append(key)
        d=Device()
        with patch.object(v,'check_app'),patch.object(v,'capture',return_value=f),patch.object(v,'group_menu',return_value={}),patch.object(v,'click'),patch.object(v,'wait_frame',side_effect=[info,f]):
            with self.assertRaisesRegex(ValueError,'group_details_mismatch'):v.verify_identity(d,{},chat)
        self.assertEqual(d.keys,['back'])
    def test_avatar_follows_picture_bounds_despite_nickname_height(self):
        f=frame();draw=ImageDraw.Draw(f['image'])
        draw.rectangle((35,845,140,950),fill=(40,70,90))
        draw.rectangle((50,855,85,935),fill=(170,140,110))
        draw.rectangle((95,865,130,940),fill=(80,120,100))
        fingerprints=[v.avatar_hash(f,{'bounds':[175,y,400,y+35]}) for y in (843,853,865)]
        self.assertNotEqual(fingerprints[0],'')
        self.assertEqual(len(set(fingerprints)),1)
        draw.rectangle((35,845,140,950),fill=(237,237,237))
        self.assertEqual(v.avatar_hash(f,{'bounds':[175,853,400,888]}),'')
    def test_direction_sender_and_composer_are_separated(self):
        f=frame();rows=v.parse_rows(f)
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['sender'],'成员');self.assertFalse(rows[0]['own'])
        self.assertEqual(rows[0]['mention'],'unknown');self.assertTrue(rows[1]['own'])
        f['items'].append({'text':'草稿','bounds':[200,2220,400,2270],'confidence':1})
        self.assertEqual(v.field_text(f,v.field(f)),'草稿')
        self.assertEqual(len(v.parse_rows(f)),2)
    def test_screenshot_small_glyphs_are_rejected(self):
        f=frame();f['items'].append({'text':'embedded','bounds':[200,985,330,1000],'confidence':1})
        self.assertEqual([r['own'] for r in v.parse_rows(f)],[True])
    def test_red_failure_mark_blocks_confirmation(self):
        f=frame();self.assertFalse(v.send_failure_visible(f))
        ImageDraw.Draw(f['image']).ellipse((405,1335,430,1360),fill=(240,30,30))
        self.assertTrue(v.send_failure_visible(f))
    def test_gray_composer_hint_is_not_a_draft_but_typed_hint_is(self):
        f=frame();f['items'].append({'text':'Tap to convert to text','bounds':[260,2230,700,2290],'confidence':1})
        ImageDraw.Draw(f['image']).rectangle((270,2240,600,2260),fill=(170,170,170))
        self.assertEqual(v.field_text(f,v.field(f)),'')
        ImageDraw.Draw(f['image']).rectangle((270,2240,600,2260),fill=(20,20,20))
        self.assertEqual(v.field_text(f,v.field(f)),'Tap to convert to text')
    def test_wrong_title_and_existing_draft_never_type(self):
        f=frame();self.assertFalse(v.title_matches(f,{'title':'另一个群'}))
        f['items'].append({'text':'草稿','bounds':[200,2220,400,2270],'confidence':1})
        class Device:
            def send_keys(self,*args,**kwargs):raise AssertionError('must not type')
        with patch.object(v,'verify_identity',return_value=f), patch.object(v,'open_chat',return_value=f):
            result=v.send(Device(),{'chats':[{'id':'g','verified':True}]},{'chat_id':'g','content':'测试'})
        self.assertEqual(result,{'state':'failed','reason':'existing_draft_do_not_overwrite'})

if __name__=='__main__':unittest.main()
