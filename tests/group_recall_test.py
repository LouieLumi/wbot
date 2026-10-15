import contextlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from hermes_group_recall import GroupRecall


class GroupRecallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / 'history.sqlite')
        self.now = int(time.time() * 1000)
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.executescript('''CREATE TABLE groups(id,name,enabled,verified);
            CREATE TABLE group_capture(chat_id,enabled,since,last_sync,has_more,error);
            CREATE TABLE group_messages(chat_id,local_id,sender_id,sender,content,created_at,truncated);
            CREATE TABLE group_answers(chat_id,member_id,user_text,answer,created_at);''')
            for group in ('a', 'b'):
                db.execute('INSERT INTO groups VALUES(?,?,1,1)', (group, '同名群'))
                db.execute('INSERT INTO group_capture VALUES(?,1,?,?,0,?)', (group, self.now-86400000, self.now, ''))
                for i in range(3):
                    db.execute('INSERT INTO group_messages VALUES(?,?,?,?,?,?,0)', (group, i, 'f'*64, '同名人', group+'群约定 '+str(i)+' 100%', self.now-5000+i))
            db.execute('INSERT INTO group_answers VALUES(?,?,?,?,?)', ('b', 'alice', '另一个群的问题', '不得泄露', self.now))

    def tearDown(self):
        self.tmp.cleanup()

    def test_scope_pagination_time_and_readonly(self):
        recall = GroupRecall(self.path, 'a', 'alice')
        result = json.loads(recall.recall({'limit': 2, 'query': '100%'}))
        self.assertTrue(recall.used)
        self.assertEqual(result['total_matches'], 3)
        self.assertEqual(result['next_offset'], 2)
        self.assertEqual(len(result['messages']), 2)
        self.assertNotIn('b群', json.dumps(result, ensure_ascii=False))
        self.assertNotIn('不得泄露', json.dumps(result, ensure_ascii=False))
        self.assertEqual(len(json.loads(recall.recall({'offset': 2}))['messages']), 1)
        self.assertEqual(json.loads(recall.recall({'query': "' OR 1=1"}))['total_matches'], 0)
        self.assertEqual(json.loads(recall.recall({'chat_id': 'b'}))['error'], 'invalid_recall_arguments')
        self.assertEqual(json.loads(recall.recall({'since': '2099-01-01'}))['error'], 'invalid_recall_arguments')

    def test_revocation_and_incomplete_evidence(self):
        recall = GroupRecall(self.path, 'a', 'alice')
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE group_capture SET error='offline' WHERE chat_id='a'")
        self.assertTrue(json.loads(recall.recall({}))['sync_incomplete'])
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE groups SET enabled=0 WHERE id='a'")
        self.assertEqual(json.loads(recall.recall({}))['error'], 'group_history_not_authorized')


if __name__ == '__main__':
    unittest.main()
