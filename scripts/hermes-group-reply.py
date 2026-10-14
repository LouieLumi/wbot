"""One isolated Hermes turn with caller-owned history and optional web search only."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
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

def main():
    profile = ROOT / '.runtime/hermes-group-profile'
    workspace = profile / 'workspace'
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ['HERMES_HOME'] = str(profile)
    # No personal Hermes credentials, plugins, context files or memories.
    os.chdir(workspace)
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from run_agent import AIAgent
        raw = sys.stdin.read(65537)
        if len(raw) > 65536:
            raise ValueError('input_limit')
        request = json.loads(raw)
        base = urlparse(request['base_url'])
        if base.scheme != 'http' or base.hostname not in ('127.0.0.1', 'localhost', '::1') or base.username or base.password:
            raise ValueError('local_endpoint_required')
        history = request.get('history', [])
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
            model=request['model'], enabled_toolsets=['search'] if web else [], quiet_mode=True,
            save_trajectories=False, verbose_logging=False, max_iterations=5 if web else 1, max_tokens=8192 if proxy else 512,
            tool_start_callback=tool_started,
            tool_complete_callback=tool_completed,
            reasoning_config=reasoning, request_overrides=overrides,
            skip_context_files=True, load_soul_identity=False, skip_memory=True, skip_background_review=True,
            session_id='wechat_' + hashlib.sha256(request['session_key'].encode()).hexdigest(),
            run_budget_seconds=150 if web else 90, cwd=str(workspace))
        agent._persist_disabled = True
        try:
            allowed = {'web_search'} if web else set()
            if set(agent.valid_tool_names) != allowed:
                raise RuntimeError('unexpected_tools_enabled')
            answer = agent.run_conversation(request['content'], system_message=request['system'], conversation_history=history)
            text = answer.get('final_response')
            if not isinstance(text, str) or not text.strip() or len(text) > 4000 or answer.get('interrupted') or answer.get('error'):
                raise RuntimeError('invalid_hermes_reply')
            if 'web_search' in used_tools and not sources:
                text = '这次联网搜索没有取得有效结果，请稍后重试或换一个关键词。'
            elif sources and not any(url in text for url in sources):
                text = text[:3000] + '\n\n来源：\n' + '\n'.join(sources[:2])
        finally:
            agent.close()
    print(json.dumps({'content': text.strip(), 'provider': 'hermes', 'tools': used_tools, 'sources': sources[:5]}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print prompts, notes, raw provider responses, or credentials.
        print(json.dumps({'error': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
