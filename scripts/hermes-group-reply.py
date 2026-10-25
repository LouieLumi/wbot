"""One member-isolated Hermes turn; staged native memory commits after delivery."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import shutil
from urllib.parse import urlparse

os.umask(0o077)
ROOT = Path(__file__).resolve().parents[1]
HERMES = Path.home() / '.hermes/hermes-agent'
sys.path.insert(0, str(HERMES))
# Hermes bootstrap activates its selected dependency tree on the managed base
# interpreter. Launching its venv executable would fight that bootstrap.
from hermes_cli._launchers import resolve_store_python
python = resolve_store_python(HERMES)
if python is None:
    raise SystemExit('Hermes managed Python unavailable')
if os.path.abspath(sys.executable) != os.path.abspath(python):
    os.execv(str(python), [str(python), str(Path(__file__).resolve())])
import hermes_bootstrap  # dependencies belong to the install, not to a member profile

def main():
    raw = sys.stdin.read(262145)
    if len(raw) > 262144:
        raise ValueError('input_limit')
    request = json.loads(raw)
    from hermes_member_memory import MemberProfile, configure
    canonical = MemberProfile(request['memory_root'], request['memory_key'])
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        with canonical.locked():
            if not canonical.meta['initialized']:
                raise ValueError('member_profile_missing')
            snapshot = canonical.snapshot()
    staging = tempfile.TemporaryDirectory(prefix='turn-', dir=canonical.path)
    try:
        return run_turn(request, snapshot, Path(staging.name), configure)
    finally:
        os.chdir(ROOT)
        staging.cleanup()


def run_turn(request, snapshot, profile, configure):
    workspace = profile / 'workspace'
    workspace.mkdir(mode=0o700)
    configure(profile, ROOT / '.runtime/hermes-group-profile/config.yaml')
    os.environ['HERMES_HOME'] = str(profile)
    os.chdir(workspace)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from run_agent import AIAgent
        from hermes_group_recall import GroupRecall
        archive = request.get('group_archive', {})
        recall = GroupRecall(archive.get('database', ''), archive.get('chat_id', ''), archive.get('member_id', ''))
        recall.used = request.get('group_quote') is True
        recall.register()
        image_enabled = bool(request.get('group_image'))
        if image_enabled:
            from hermes_group_image import GroupImage
            image_tool = GroupImage(request['group_image'], request, lambda: setattr(recall, 'used', True))
            image_tool.register()
        voice_tool = None
        if request.get('voice_enabled') is True:
            from hermes_voice_reply import VoiceReply
            voice_tool = VoiceReply()
            voice_tool.register()
        from hermes_member_memory import LIMIT
        from tools.memory_tool import MemoryStore
        seed = MemoryStore(LIMIT, LIMIT)
        seed.load_from_disk()
        for target in ('user', 'memory'):
            entries = snapshot[target]
            if entries:
                result = seed.apply_batch(target, [{'action': 'add', 'content': entry} for entry in entries])
                if not result.get('success'):
                    raise ValueError('hermes_memory_seed_failed')
        base = urlparse(request['base_url'])
        if base.scheme != 'http' or base.hostname not in ('127.0.0.1', 'localhost', '::1') or base.username or base.password:
            raise ValueError('local_endpoint_required')
        history = [{'role': row['role'], 'content': row['content']} for row in snapshot['history']][-20:]
        while sum(len(row['content']) for row in history) > 6000 and history:
            del history[:2]
        if len(history) > 20 or any(t.get('role') not in ('user', 'assistant') or not isinstance(t.get('content'), str) for t in history):
            raise ValueError('invalid_history')
        proxy = request.get('backend') == 'proxy'
        effort = request.get('reasoning_effort', 'auto')
        if proxy and effort not in ('auto', 'low', 'medium', 'high'):
            raise ValueError('invalid_reasoning_effort')
        overrides = ({'reasoning_effort': effort} if effort != 'auto' else {}) if proxy else {'extra_body': {'think': False}}
        reasoning = ({'enabled': True, 'effort': effort} if effort != 'auto' else None) if proxy else {'enabled': False}
        web = request.get('web_search') is True
        used_tools = []
        sources = []
        def tool_started(call_id, name, *args, **kwargs):
            if name not in used_tools:
                used_tools.append(name)
        def tool_completed(call_id, name, arguments, result):
            if name != 'web_search':
                return
            try:
                parsed = json.loads(result) if isinstance(result, str) else result
                if parsed.get('success'):
                    for hit in parsed.get('data', {}).get('web', []):
                        url = hit.get('url', '')
                        if isinstance(url, str) and url.startswith(('https://', 'http://')) and len(url) < 1000 and url not in sources:
                            sources.append(url)
            except (ValueError, AttributeError, TypeError):
                pass
        agent = AIAgent(provider='custom', base_url=request['base_url'], api_key=request.get('api_key', 'local-ollama'),
            model=request['model'], enabled_toolsets=['memory', 'wbot_group', 'search'] if web else ['memory', 'wbot_group'], quiet_mode=True,
            save_trajectories=False, verbose_logging=False, max_iterations=8, max_tokens=8192 if proxy else 512,
            tool_start_callback=tool_started,
            tool_complete_callback=tool_completed,
            reasoning_config=reasoning, request_overrides=overrides,
            skip_context_files=True, load_soul_identity=False, skip_memory=False, skip_background_review=True,
            session_id=snapshot['session_id'],
            run_budget_seconds=210 if image_enabled else 150 if web else 90, cwd=str(workspace))
        agent._persist_disabled = True
        try:
            allowed = {'memory', 'group_recall', 'web_search'} if web else {'memory', 'group_recall'}
            if image_enabled:
                allowed.add('group_latest_image')
            if voice_tool:
                allowed.add('voice_reply')
            if set(agent.valid_tool_names) != allowed:
                raise RuntimeError('unexpected_tools_enabled:' + ','.join(sorted(agent.valid_tool_names)))
            answer = agent.run_conversation(request['content'], system_message=request['system'], conversation_history=history)
            text = answer.get('final_response')
            if not isinstance(text, str) or not text.strip() or len(text) > 4000 or answer.get('interrupted') or answer.get('error'):
                raise RuntimeError('invalid_hermes_reply')
            if 'web_search' in used_tools and not sources and not recall.used:
                text = '这次联网搜索没有取得有效结果，请稍后重试或换一个关键词。'
            elif sources and not any(url in text for url in sources):
                text = text[:3000] + '\n\n来源：\n' + '\n'.join(sources[:2])
            native = agent._memory_store
            if native is None:
                raise RuntimeError('hermes_memory_not_loaded')
            draft = {'key': snapshot['key'], 'epoch': snapshot['epoch'],
                     'user': native.user_entries, 'memory': native.memory_entries}
        finally:
            agent.close()
    print(json.dumps({'content': text.strip(), 'provider': 'hermes', 'tools': used_tools, 'sources': sources[:5],
                      'voice': bool(voice_tool and voice_tool.selected), 'memory': None if recall.used else draft, 'memory_scope': 'group' if recall.used else 'member'}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print prompts, notes, raw provider responses, or credentials.
        detail = str(error) if str(error).startswith(('unexpected_tools_enabled:', 'hermes_memory_not_loaded', 'invalid_hermes_reply')) else ''
        print(json.dumps({'error': type(error).__name__, 'detail': detail}), file=sys.stderr)
        raise SystemExit(1)
