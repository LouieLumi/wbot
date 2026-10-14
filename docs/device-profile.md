# 旧 ADB / 视觉设备配置

当前推荐通道为 `WECHAT_DEVICE_MODE=android_hook`，不读取此视觉配置，不依赖截图或 OCR。

`config/wechat-profile.example.json` 仅为历史 `adb` 适配器的空模板。`npm run setup` 会在本地生成 `config/wechat-profile.json`，默认 `calibrated=false`、无已验证群。真实配置属于私有数据，不提交 Git。

如果研究旧驱动，需要针对自己的设备验证版本、输入框、发送控件、消息方向和独立群身份；不能只凭同名群或昵称授权。未知发言者、不确定 @、已有草稿、身份不一致或校准未完成时应拒绝自动发送。

旧模式的 `sent` 仅表示界面证据，不等同于当前代码模式的微信服务器回执。旧成员使用昵称/头像等界面线索，不能自动迁移为真实微信账号身份。详见 `scripts/device-agent.py`、`scripts/vision_device.py` 及相关 Python 测试。
