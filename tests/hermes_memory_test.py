"""Optional integration tests against the locally installed Hermes (no model/network)."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless((Path.home() / '.hermes/hermes-agent').is_dir(), 'Local Hermes installation required')
class HermesMemberMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='hermes-members-')
        self.root = Path(self.temporary.name)
        self.alice = hashlib.sha256(b'test-alice').hexdigest()
        self.bob = hashlib.sha256(b'test-bob').hexdigest()

    def tearDown(self):
        self.temporary.cleanup()

    def call(self, key, action, **fields):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/hermes_member_memory.py')],
                                input=json.dumps({'key': key, 'root': str(self.root), 'action': action, **fields}),
                                cwd=ROOT, text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stderr.strip())
        return json.loads(result.stdout)

    def test_native_memory_history_dedup_reset_and_member_isolation(self):
        first = self.call(self.alice, 'ensure', notes=['喜欢蓝色'], history=[
            {'seq': 1, 'role': 'user', 'content': '旧问题', 'created_at': 1700000000000},
            {'seq': 2, 'role': 'assistant', 'content': '旧回答', 'created_at': 1700000001000}])
        self.call(self.bob, 'ensure', notes=['喜欢绿色'], history=[])
        draft = {key: first[key] for key in ('key', 'epoch', 'user', 'memory')}
        draft['memory'] = ['正在学习日语']
        committed = self.call(self.alice, 'commit', job_id='test-delivery-1', user_text='记住我在学日语', answer='记住了', draft=draft)
        self.assertEqual(committed['summary'], '正在学习日语')
        self.assertEqual(committed['turn_count'], 4)
        repeated = self.call(self.alice, 'commit', job_id='test-delivery-1', user_text='记住我在学日语', answer='记住了', draft=draft)
        self.assertEqual(repeated['turn_count'], 4)
        # Simulate a crash after the native transcript write but before journal removal.
        pending = {'meta': json.loads((self.root / self.alice / 'wbot-profile.json').read_text()),
                   'user': committed['user'], 'memory': committed['memory'], 'delete_session': None,
                   'messages': [{'role': 'user', 'content': '记住我在学日语', 'message_uid': 'wbot_test-delivery-1_user'},
                                {'role': 'assistant', 'content': '记住了', 'message_uid': 'wbot_test-delivery-1_assistant'}]}
        (self.root / self.alice / 'wbot-pending.json').write_text(json.dumps(pending))
        self.assertEqual(self.call(self.alice, 'snapshot')['turn_count'], 4)
        self.assertFalse((self.root / self.alice / 'wbot-pending.json').exists())
        seeded_again = self.call(self.alice, 'ensure', notes=['旧资料不可覆盖'], history=[])
        self.assertEqual(seeded_again['notes'], '喜欢蓝色')
        with self.assertRaisesRegex(RuntimeError, 'stale_memory_draft'):
            self.call(self.alice, 'commit', job_id='different-delivery', user_text='stale', answer='stale', draft=draft)
        self.assertEqual(self.call(self.bob, 'snapshot')['notes'], '喜欢绿色')
        self.assertEqual(self.call(self.bob, 'snapshot')['history'], [])
        fresh = self.call(self.alice, 'reset', notes=False)
        self.assertEqual(fresh['turn_count'], 0)
        self.assertEqual(fresh['summary'], '正在学习日语')
        cleared = self.call(self.alice, 'reset', notes=True)
        self.assertEqual((cleared['notes'], cleared['summary'], cleared['history']), ('', '', []))
        self.assertEqual(self.call(self.bob, 'snapshot')['notes'], '喜欢绿色')
        self.assertTrue((self.root / self.alice / 'state.db').exists())
        self.assertTrue((self.root / self.bob / 'memories/USER.md').exists())

    def test_invalid_edits_leave_native_memory_and_journal_untouched(self):
        self.call(self.alice, 'ensure', notes=['原始资料'], history=[])
        with self.assertRaisesRegex(RuntimeError, 'memory_limit'):
            self.call(self.alice, 'patch', notes='a' * 8001)
        self.assertEqual(self.call(self.alice, 'snapshot')['notes'], '原始资料')
        self.assertFalse((self.root / self.alice / 'wbot-pending.json').exists())
        with self.assertRaises(RuntimeError):
            self.call('../bob', 'snapshot')


if __name__ == '__main__':
    unittest.main()
