# 本地语音回复

Mac 使用 MLX Qwen3-TTS，手机通过原生 VoiceMsgSendTask 发送微信语音气泡。聊天正文只在本机合成，不上传到语音服务。此功能需要 Apple Silicon、Hermes 和 Android hook API 12 或更新版本。

## 音色

首次用 Qwen3-TTS 1.7B VoiceDesign 设计原创猫娘参考音色，之后用 0.6B Base 固定参考音频合成。参考音频由模型生成，没有采集真人录播。音色描述和固定种子位于 `scripts/design-local-voice.py`；生成后的 WAV、逐字稿及来源记录位于 `data/voice/`。这不是任何主播的授权克隆模型。

模型权重约 4GB。VoiceDesign 仅在设计音色时加载；每条日常语音使用轻量 Base 模型，串行合成、完成后退出进程，释放 Metal 内存。

默认风格为平静、松弛的朋友聊天：女性中音略偏低，圆润、轻声，正常语速、自然连读，音高与重音变化克制。Hermes 同时使用平淡的口语短句，避免刻意惊叹、撒娇、播报稿式开场、总结和密集语气词。语气由参考音频和回答措辞共同决定，调整音色后需要用 Base 模型试听实际合成结果。

## 安装

```sh
python3 -m venv .runtime/voice-venv
.runtime/voice-venv/bin/python -m pip install -r requirements-voice.txt
.runtime/voice-venv/bin/python scripts/setup-local-voice.py
```

完成手机模块更新并确认 `/status` 返回 `voice_supported: true` 后，配置：

```dotenv
VOICE_ENABLED=true
VOICE_PYTHON=.runtime/voice-venv/bin/python
VOICE_MODEL_PATH=.runtime/voice/models/base
VOICE_REFERENCE=data/voice/gemini.wav
```

独立运行目录可使用绝对路径。更换音色需同时更新 WAV 与同名 `.wav.txt` 逐字稿；参考格式是单声道、24kHz、16位 PCM WAV。使用他人参考素材前自行确认授权。

运行中的服务更换音色时，先生成独立文件，例如 `python scripts/design-local-voice.py --output data/voice/gemini-casual-v2.wav`，试听后将 `VOICE_REFERENCE` 指向新文件并在任务空闲时重启。保留旧文件，避免正在合成的任务读到不匹配的音频和逐字稿。

## 行为与故障处理

Hermes 的 `voice_reply` 工具只选择本轮回答格式，不直接发送。普通聊天、短问候、安慰和简短口头解释优先使用语音；网址、代码、详细步骤和明确要求文字时使用文字，无需新增聊天命令。

全局同一时刻只合成一条语音，不排语音等待队列。合成期间收到的新提问会持久化标记为文字回复，即使开始回答时语音已经完成，也不再切回语音。如果多个模型回答同时完成，只有先取得合成位置的一条使用语音，其他回答用文字。同一成员的上下文顺序仍等待上一条回复的微信确认；其他成员可以并行生成文字回复。语音合成完成后，之后的新提问恢复优先语音。

合成限 180 字、最多 60 秒，单条合成超时为 150 秒。合成故障保留原文并回退文字；微信明确返回未发送时也会改发文字；暂停、撤销授权或修改记忆后，过期结果不会发送。语音字节、时长与回复文本在同一数据库事务落盘，只有微信确认发送才提交记忆。

手机检查 SILK 包长度与真实时长，发送前持久化请求 ID、目标群和音频摘要。重发相同 ID 不会重复投递；发送状态不确定时不自动补发文字或语音。手机仅接受本机认证请求和已授权群。

`/api/health` 的 `voice` 显示启用状态、模型文件就绪情况、当前合成任务数及最近合成错误。`voice.fallback` 事件表示本轮改用文字。`ready` 仅表示所需文件存在，不能代替真实合成和微信发送测试。

依赖来源：[Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)、[MLX Audio](https://github.com/Blaizzy/mlx-audio)、[pilk](https://github.com/foyoux/pilk)。模型遵循其 Apache-2.0 许可；pilk 遵循 GPL-3.0，分发相关组件时需遵循各自许可。
