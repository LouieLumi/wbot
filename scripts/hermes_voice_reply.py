"""Select delivery format only; synthesis and delivery remain in the durable host queue."""
import json

SCHEMA = {'name': 'voice_reply', 'description': '优先将本轮最终回答选择为本地猫娘音色的微信语音。普通闲聊、短问候、安慰、轻松打趣和简短口头解释默认调用，不必等用户要求语音。用给熟朋友发语音的口语回答，短句自然衔接，别写成播报稿。最终回答最多120个汉字，不超过40秒；含网址、代码、详细步骤、需要复制的内容或用户要求文字时不要调用。此工具只选择格式，不代表已经发送。',
          'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': False}}


class VoiceReply:
    def __init__(self):
        self.selected = False

    def select(self, args, **_):
        if not isinstance(args, dict) or args:
            return json.dumps({'error': 'no_arguments_expected'})
        self.selected = True
        return json.dumps({'selected': 'voice', 'message': '请像放松地给熟朋友发微信语音一样回答，用简短、平静、随意的日常口语，直接接上对方的话。日常闲聊不刻意兴奋、惊叹、撒娇或连着反问，句子自然收尾，少用感叹号。别写播报稿、开场白或总结口号；语气词只在自然需要时用，不要每句都加“呀”“呢”“喵”，也别堆省略号、拖长音或动作括号。不要说语音已经发出。系统随后本地合成，失败会发送文字。'}, ensure_ascii=False)

    def register(self):
        from tools.registry import registry
        registry.register(name='voice_reply', toolset='wbot_group', schema=SCHEMA, handler=self.select, check_fn=lambda: True)
