"""Run with .runtime/voice-venv/bin/python after requirements-voice.txt installation."""
import os
from pathlib import Path
import subprocess
import sys

os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('HF_HUB_DOWNLOAD_TIMEOUT', '60')
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parents[1]
for name, target in [('Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit', 'voice-design'),
                     ('Qwen3-TTS-12Hz-0.6B-Base-4bit', 'base')]:
    snapshot_download('mlx-community/' + name, local_dir=ROOT / '.runtime/voice/models' / target, max_workers=2)
reference = ROOT / 'data/voice/gemini.wav'
if not reference.exists():
    subprocess.run([sys.executable, str(ROOT / 'scripts/design-local-voice.py')], cwd=ROOT, check=True)
print('Local voice assets ready. Enable VOICE_ENABLED only after the phone reports voice_supported=true.')
