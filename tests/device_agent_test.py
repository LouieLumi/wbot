import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('device_agent', Path(__file__).resolve().parents[1] / 'scripts/device-agent.py')
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

class Node:
    def __init__(self, text='', resource='input', click=None):
        self.attrib = {'text':text, 'resource-id':resource}
        self._click = click
    def click(self):
        if self._click: self._click()

class Device:
    def __init__(self):
        self.taps = 0
        self.title = Node('测试群')
        self.identity = Node('unique-test-identity')
        self.input = Node('')
        self.button = Node('发送',click=self.tap)
        self.info = {'screenOn':True}
        self.count = 1
    def tap(self): self.taps += 1
    def app_current(self): return {'package':'com.tencent.mm'}
    def app_info(self, _): return {'versionName':'8.0.79'}
    def xpath(self, path):
        result = {'title':[self.title], 'identity':[self.identity], 'input':[self.input], 'send':[self.button], 'failure':[]}.get(path,[])
        class Query:
            def all(self): return result
        return Query()
    def __call__(self, **kwargs): return self
    def set_text(self, value): self.input.attrib['text']=value

class DeviceSafetyTests(unittest.TestCase):
    def setUp(self):
        self.chat={'id':'g','name':'测试群','type':'group','verified':True,'title':'测试群','identity_xpath':'identity','identity_value':'unique-test-identity'}
        self.profile={'calibrated':True,'version_name':'8.0.79','title_xpath':'title','input_xpath':'input','send_xpath':'send','failure_xpath':'failure','chats':[self.chat]}
        self.d=Device()
        self.data={'chat_id':'g','content':'中文 test 😀'}
    def test_same_name_different_identity_never_taps(self):
        self.d.identity.attrib['text']='another-chat'
        result=agent.send(self.d,self.profile,self.data)
        self.assertEqual(result['state'],'failed')
        self.assertEqual(self.d.taps,0)
    def test_existing_draft_is_preserved(self):
        self.d.input.attrib['text']='user draft'
        result=agent.send(self.d,self.profile,self.data)
        self.assertEqual(result['state'],'failed')
        self.assertEqual(self.d.input.attrib['text'],'user draft')
        self.assertEqual(self.d.taps,0)
    def test_post_tap_transport_failure_is_uncertain(self):
        with patch.object(agent,'rows',side_effect=[[],RuntimeError('transport lost')]), patch.object(agent.time,'sleep'):
            result=agent.send(self.d,self.profile,self.data)
        self.assertEqual(result['state'],'uncertain')
        self.assertEqual(self.d.taps,1)
        self.assertEqual(self.d.input.attrib['text'],self.data['content'])
    def test_version_mismatch_never_taps(self):
        self.profile['version_name']='different'
        self.assertEqual(agent.send(self.d,self.profile,self.data)['state'],'failed')
        self.assertEqual(self.d.taps,0)

if __name__ == '__main__': unittest.main()
