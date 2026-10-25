"""Offline Qwen3 TTS -> Tencent SILK. Only the host selects model/reference paths."""
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import wave

os.umask(0o077)


def silk_duration(data):
    if not data.startswith(b'\x02#!SILK_V3'):
        raise ValueError('silk_header')
    offset, frames = 10, 0
    while offset < len(data):
        if offset + 2 > len(data):
            raise ValueError('silk_packet')
        size = struct.unpack_from('<h', data, offset)[0]
        offset += 2
        if size <= 0 or size > 1250 or offset + size > len(data):
            raise ValueError('silk_packet')
        offset += size
        frames += 1
    return frames * 20


def synthesize(request):
    text = request['text'].strip()
    if not text or len(text) > 180:
        raise ValueError('voice_text_limit')
    # Never send chat text to a hosted synthesis API or download missing weights.
    os.environ['HF_HUB_OFFLINE'] = '1'
    from mlx_audio.tts.utils import load_model
    import mlx.core as mx
    import numpy as np
    import pilk
    reference = Path(request['reference'])
    with wave.open(str(reference), 'rb') as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 24000:
            raise ValueError('reference_format')
        audio = mx.array(np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2').astype(np.float32) / 32768)
    transcript = Path(str(reference) + '.txt').read_text().strip()
    model = load_model(request['model'])
    mx.random.seed(217)
    results = list(model.generate(text=text, language='Chinese', ref_audio=audio, ref_text=transcript,
                                  max_tokens=700, temperature=0.65, verbose=False))
    samples = np.concatenate([np.asarray(r.audio).reshape(-1) for r in results])
    rate = results[0].sample_rate
    if rate != 24000 or not np.isfinite(samples).all() or len(samples) < 2400 or len(samples) > rate * 55:
        raise ValueError('voice_audio_bounds')
    if float(np.max(np.abs(samples))) < 0.005:
        raise ValueError('voice_silent')
    # Bound amplitude; pad to exact 20ms SILK frames and at least one second.
    samples = np.clip(samples, -0.98, 0.98)
    length = max(rate, ((len(samples) + 479) // 480) * 480)
    samples = np.pad(samples, (0, length - len(samples)))
    with tempfile.TemporaryDirectory(prefix='wbot-voice-') as folder:
        pcm, silk = Path(folder) / 'voice.pcm', Path(folder) / 'voice.silk'
        pcm.write_bytes((samples * 32767).astype('<i2').tobytes())
        pilk.encode(str(pcm), str(silk), pcm_rate=24000, tencent=True)
        data = silk.read_bytes()
        duration = silk_duration(data)
        if not 1000 <= duration <= 60000 or len(data) > 1024 * 1024:
            raise ValueError('voice_duration')
        return {'mime_type': 'audio/silk', 'duration_ms': duration, 'data': base64.b64encode(data).decode()}


if __name__ == '__main__':
    try:
        raw = sys.stdin.read(16385)
        if len(raw) > 16384:
            raise ValueError('input_limit')
        with contextlib.redirect_stdout(io.StringIO()):
            result = synthesize(json.loads(raw))
        print(json.dumps(result))
    except Exception as error:
        print(json.dumps({'error': type(error).__name__}), file=sys.stderr)
        raise SystemExit(1)
