"""Member-scoped adapter for Hermes MemoryStore and SessionDB, without model calls.

Every profile is selected by a trusted SHA-256 identity, never by a model argument.
The small JSON snapshot is an admin/read cache; Hermes files and SessionDB own data.
"""
import contextlib
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid

LIMIT = 8000
DELIMITER = '\n§\n'


def bootstrap():
    hermes = Path.home() / '.hermes/hermes-agent'
    sys.path.insert(0, str(hermes))
    from hermes_cli._launchers import resolve_store_python
    python = resolve_store_python(hermes)
    if python is None:
        raise RuntimeError('hermes_unavailable')
    if os.path.abspath(sys.executable) != os.path.abspath(python):
        os.execv(str(python), [str(python), *sys.argv])
    import hermes_bootstrap  # select installed dependencies before switching member homes


def atomic_json(path, data):
    descriptor, name = tempfile.mkstemp(prefix='.wbot-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(data, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def profile_path(root, key):
    if not isinstance(key, str) or not re.fullmatch(r'[a-f0-9]{64}', key):
        raise ValueError('invalid_memory_identity')
    return Path(root).resolve() / key


def configure(profile, base_config=None):
    """Only share web-search settings; never load the operator's personal profile."""
    import hermes_yaml as yaml
    config = {}
    if base_config and Path(base_config).is_file():
        source = yaml.safe_load(Path(base_config).read_text()) or {}
        if isinstance(source.get('web'), dict):
            config['web'] = source['web']
    config['memory'] = {'memory_enabled': True, 'user_profile_enabled': True,
                        'memory_char_limit': LIMIT, 'user_char_limit': LIMIT, 'provider': ''}
    (profile / 'config.yaml').write_text(yaml.safe_dump(config, allow_unicode=True))


class MemberProfile:
    def __init__(self, root, key):
        self.path = profile_path(root, key)
        self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.environ['HERMES_HOME'] = str(self.path)
        if not (self.path / 'config.yaml').exists():
            configure(self.path)
        self.meta_path = self.path / 'wbot-profile.json'
        self.journal = self.path / 'wbot-pending.json'
        self.snapshot_path = self.path / 'wbot-snapshot.json'
        self.key = key

    @contextlib.contextmanager
    def locked(self):
        import hermes_bootstrap  # activate the installed Hermes dependency generation
        with (self.path / 'wbot.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                self.meta = json.loads(self.meta_path.read_text()) if self.meta_path.exists() else {
                    'epoch': 0, 'session_id': 'wechat_' + uuid.uuid4().hex, 'initialized': False}
                from tools.memory_tool import MemoryStore
                from hermes_state import SessionDB
                self.store = MemoryStore(LIMIT, LIMIT)
                self.store.load_from_disk()
                self.db = SessionDB(self.path / 'state.db')
                try:
                    if self.journal.exists():
                        self.apply(json.loads(self.journal.read_text()))
                    yield self
                finally:
                    self.db.close()
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def replace(self, target, entries):
        if not isinstance(entries, list) or any(not isinstance(entry, str) for entry in entries):
            raise ValueError('invalid_memory_entries')
        if len(DELIMITER.join(entries)) > LIMIT:
            raise ValueError('memory_limit')
        entries = [entry for entry in entries if entry.strip()]
        current = list(self.store.user_entries if target == 'user' else self.store.memory_entries)
        if current == entries:
            return
        if not entries:
            # Hermes deliberately reserves full clearing for single remove calls.
            # This path implements explicit /forget, /reset and admin edits.
            for entry in current:
                if not self.store.remove(target, entry).get('success'):
                    raise ValueError('hermes_memory_write_rejected')
            return
        operations = ([{'action': 'remove', 'old_text': entry} for entry in current]
                      + [{'action': 'add', 'content': entry} for entry in entries if entry.strip()])
        if operations:
            result = self.store.apply_batch(target, operations)
            if not result.get('success'):
                raise ValueError('hermes_memory_write_rejected')

    def apply(self, update):
        # A recoverable journal keeps file memory and transcript changes together.
        if update.get('delete_session'):
            self.db.delete_session(update['delete_session'])
        self.db.ensure_session(update['meta']['session_id'], source='wechat', user_id=self.key)
        self.replace('user', update['user'])
        self.replace('memory', update['memory'])
        if update.get('messages'):
            # Hermes allows repeated message occurrences. Check our stable IDs
            # explicitly so journal recovery cannot append an already saved pair.
            import sqlite3
            remaining = []
            with sqlite3.connect(f'file:{self.path}/state.db?mode=ro', uri=True) as reader:
                for message in update['messages']:
                    previous = reader.execute('SELECT role,content FROM messages WHERE session_id=? AND message_uid=?',
                                              (update['meta']['session_id'], message['message_uid'])).fetchone()
                    if previous is None:
                        remaining.append(message)
                    elif previous != (message['role'], message['content']):
                        raise ValueError('memory_message_id_conflict')
            if remaining:
                self.db.append_messages_batch(update['meta']['session_id'], remaining)
        self.meta = update['meta']
        atomic_json(self.meta_path, self.meta)
        snapshot = self.snapshot()
        atomic_json(self.snapshot_path, snapshot)
        self.journal.unlink(missing_ok=True)
        return snapshot

    def update(self, *, user=None, memory=None, messages=None, reset=False, bump=True):
        meta = {**self.meta, 'initialized': True, 'epoch': self.meta['epoch'] + int(bump)}
        if reset:
            meta['session_id'] = 'wechat_' + uuid.uuid4().hex
        update = {'meta': meta, 'user': self.store.user_entries if user is None else user,
                  'memory': self.store.memory_entries if memory is None else memory, 'messages': messages or [],
                  'delete_session': self.meta['session_id'] if reset else None}
        # Validate before writing a recovery journal.
        self.validate(update)
        atomic_json(self.journal, update)
        return self.apply(update)

    def validate(self, update):
        from tools.memory_tool_store import _scan_memory_content
        for entries in (update['user'], update['memory']):
            if not isinstance(entries, list) or any(not isinstance(entry, str) for entry in entries):
                raise ValueError('invalid_memory_entries')
            if len(DELIMITER.join(entries)) > LIMIT:
                raise ValueError('memory_limit')
            if any(_scan_memory_content(entry) for entry in entries):
                raise ValueError('hermes_memory_write_rejected')

    def snapshot(self):
        rows = self.db.get_messages(self.meta['session_id'], limit=40, latest=True)
        history = [{'role': row['role'], 'content': row['content'], 'created_at': int(row['timestamp'] * 1000)}
                   for row in rows if row['role'] in ('user', 'assistant') and isinstance(row['content'], str)]
        session = self.db.get_session(self.meta['session_id']) or {}
        return {'backend': 'hermes', 'key': self.key, 'epoch': self.meta['epoch'],
                'notes': DELIMITER.join(self.store.user_entries), 'summary': DELIMITER.join(self.store.memory_entries),
                'user': self.store.user_entries, 'memory': self.store.memory_entries,
                'history': history, 'turn_count': session.get('message_count', 0), 'session_id': self.meta['session_id']}

    def execute(self, request):
        action = request['action']
        if action == 'ensure' and not self.meta['initialized']:
            messages = [{**turn, 'message_uid': 'migration_' + str(turn['seq']),
                         'timestamp': turn['created_at'] / 1000} for turn in request.get('history', [])]
            return self.update(user=request.get('notes', []), messages=messages)
        if not self.meta['initialized']:
            raise ValueError('member_profile_missing')
        if action in ('ensure', 'snapshot'):
            snapshot = self.snapshot()
            atomic_json(self.snapshot_path, snapshot)
            return snapshot
        if action == 'patch':
            return self.update(user=request['notes'].split(DELIMITER) if 'notes' in request else None,
                               memory=request['summary'].split(DELIMITER) if 'summary' in request else None)
        if action == 'reset':
            return self.update(user=[] if request['notes'] else None, memory=[] if request['notes'] else None, reset=True)
        if action == 'commit':
            draft = request.get('draft')
            # A replay of a completed commit must not overwrite newer memory.
            uid = 'wbot_' + request['job_id']
            import sqlite3
            with sqlite3.connect(f'file:{self.path}/state.db?mode=ro', uri=True) as db:
                if db.execute('SELECT 1 FROM messages WHERE session_id=? AND message_uid=?',
                              (self.meta['session_id'], uid + '_assistant')).fetchone():
                    return self.snapshot()
            if draft and (draft.get('key') != self.key or draft.get('epoch') != self.meta['epoch']):
                raise ValueError('stale_memory_draft')
            messages = [{'role': role, 'content': request[field], 'message_uid': uid + '_' + role}
                        for role, field in [('user', 'user_text'), ('assistant', 'answer')]]
            return self.update(user=draft['user'] if draft else None, memory=draft['memory'] if draft else None,
                               messages=messages, bump=bool(draft))
        raise ValueError('unknown_memory_operation')


def main():
    os.umask(0o077)
    bootstrap()
    request = json.load(sys.stdin)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        profile = MemberProfile(request['root'], request['key'])
        with profile.locked():
            result = profile.execute(request)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': str(error) if str(error) in (
            'memory_limit', 'hermes_memory_write_rejected', 'stale_memory_draft') else type(error).__name__,
            'module': error.name if isinstance(error, ModuleNotFoundError) else None}), file=sys.stderr)
        raise SystemExit(1)
