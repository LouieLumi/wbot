"""Create an original reference voice from a description, not a person's recording."""
import argparse
import json
from pathlib import Path
import wave

TEXT = '嗯，我在呢。刚才去倒了杯水。今天没什么特别的事，就想安静待一会儿。你先忙你的，不着急，等有空了我们再聊。'
DESCRIPTION = '自然的女性中音，音高适中偏低，声线圆润、温和、略暖，带少量胸腔共鸣，很淡的外国口音。平静松弛地和熟朋友说话，像靠在椅背上随口聊两句，正常轻声，不使劲，不做表演。情绪平淡，音高起伏小，轻重变化克制，句尾平稳自然落下。正常不赶的聊天速度，词语顺着意思连读，停顿短而自然。保留一点原创猫系角色的亲近感，但不刻意可爱。避免高尖的少女嗓、鼻腔挤压、夹嗓、亢奋、撒娇、戏剧化重音、拖长尾音、耳语气声和播音腔。不模仿任何真人或主播。'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='.runtime/voice/models/voice-design')
    parser.add_argument('--output', default='data/voice/gemini.wav')
    args = parser.parse_args()
    import mlx.core as mx
    import numpy as np
    from mlx_audio.tts.utils import load_model
    model = load_model(args.model)
    mx.random.seed(217)
    results = list(model.generate_voice_design(text=TEXT, instruct=DESCRIPTION, language='Chinese',
                                              temperature=0.65, max_tokens=600, verbose=False))
    audio = np.concatenate([np.asarray(r.audio).reshape(-1) for r in results])
    if not 24000 < len(audio) < 24000 * 40 or not np.isfinite(audio).all():
        raise ValueError('reference_invalid')
    path = Path(args.output)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as output:
        output.setparams((1, 2, 24000, 0, 'NONE', 'NONE'))
        output.writeframes((np.clip(audio, -0.98, 0.98) * 32767).astype('<i2').tobytes())
    Path(str(path) + '.txt').write_text(TEXT)
    Path(str(path) + '.json').write_text(json.dumps({'source': 'synthetic_original_voice_design', 'model': 'mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit', 'description': DESCRIPTION, 'seed': 217, 'transcript': TEXT}, ensure_ascii=False, indent=2))
    print(json.dumps({'path': str(path), 'seconds': len(audio) / 24000, 'peak_memory_gb': mx.get_peak_memory() / 1e9}))


if __name__ == '__main__':
    main()
