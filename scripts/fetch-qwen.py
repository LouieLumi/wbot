"""Fetch the official Ollama GGUF manifest/blobs with checksum verification.

Used when Ollama's automatic platform selection stalls on this Mac. No model
conversion or third-party mirrors; the result is a project-local Ollama store.
"""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[1]
store = root / '.runtime/ollama-models'
blobs = store / 'blobs'
blobs.mkdir(parents=True, exist_ok=True)
manifest = root / '.runtime/qwen-manifest.json'
url = 'https://registry.ollama.ai/v2/library/qwen3.5/'
if not manifest.exists():
    subprocess.run(['curl','-fsSL','--max-time','60',url+'manifests/4b','-o',str(manifest)],check=True)
data = json.loads(manifest.read_text())
assert data.get('format') == 'gguf' and data.get('runner') == 'llamacpp'

def fetch(layer):
    digest=layer['digest']; assert digest.startswith('sha256:')
    target=blobs/digest.replace(':','-')
    if not target.exists():
        temp=target.with_suffix('.part')
        print('Downloading',layer['mediaType'],layer['size'],flush=True)
        subprocess.run(['curl','-fLsS','--retry','3','--connect-timeout','30','--max-time','3600','-C','-',url+'blobs/'+digest,'-o',str(temp)],check=True)
        with temp.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual!=digest.split(':')[1]: raise RuntimeError('model_checksum_mismatch')
        temp.rename(target)
    with target.open('rb') as f: actual=hashlib.file_digest(f,'sha256').hexdigest()
    assert actual==digest.split(':')[1]
    print('Verified',layer['mediaType'],flush=True)

with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(fetch,[data['config'],*data['layers']]))
target=store/'manifests/registry.ollama.ai/library/qwen3.5/4b'
target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(data))
print('Official Qwen3.5 4B ready in',store,flush=True)
