# 部署

## 1. 本机服务

Node.js 22.13+，Python 3，支持 USB 调试的 Android 测试设备。macOS 是当前主要运行平台；管理服务与单元测试不要求手机。

```bash
npm ci
npm run setup
python3 -m venv .runtime/venv
.runtime/venv/bin/python -m pip install -r requirements.txt
npm run check
npm run build
```

`.env.example` 是配置模板；`.env`、`data/`、`.runtime/`、`config/wechat-profile.json` 均不提交。`npm run setup` 默认采用 mock 设备并关闭自动回复。

在仓库根目录启动：

```bash
npm start
```

`npm run admin` 打开本机一次性登录链接；也可执行 `python3 scripts/set-admin-password.py` 设置密码。该脚本使用隐藏输入，不要把密码写入命令参数或提交到配置模板。后台及 API 只监听本机，不应直接暴露到公网。

## 2. Android 代码接入

当前模块绑定微信 8.0.79 / versionCode 3200。源码和自检 App 在 `apps/android-wechat-module/`、`apps/android-hook-probe/`。安装包与签名文件需在本地准备，仓库不分发微信代码或修改版 APK。

构建工具按下列本地路径组织：

| 路径 | 依赖 |
| --- | --- |
| `.runtime/java/*/Contents/Home` | JDK |
| `.runtime/android-sdk/build-tools/35.0.0` | Android build-tools |
| `.runtime/android-sdk/platforms/android-29/android.jar` | Android SDK platform |
| `.runtime/android-sdk/platform-tools/adb` | ADB |
| `.runtime/android-research/xposed-api-82.jar` | 仅编译用 Xposed API |
| `.runtime/android-research/lspatch.jar` | 已校验的 LSPatch |
| `.runtime/android-research/wechat-8.0.79.apk` | 自行取得的原始 APK |

构建脚本对关键输入校验 SHA-256；版本或文件不匹配时应停止并重新适配，不要删除校验后继续。

```bash
python3 scripts/build-android-hook-probe.py
python3 scripts/prepare-android-wechat-diagnostic.py
```

首个命令在 `.runtime/android-research/local-api-config.json` 生成随机 Token 和空初始群列表；已有配置不覆盖。新群通过 `/signup` 申请。两个命令只生成本地产物，不会安装、卸载或自动登录。测试签名的口令是构建脚本中的开发默认值，不能作为生产密钥保护措施；密钥文件必须留在本机。

Android 不允许不同签名直接覆盖安装。替换原有微信可能需要卸载并清除本地数据；不要把 APK 备份当作聊天备份。后续更新必须保留同一签名。模块适配与设备操作应在自己的测试设备上完成。

手机模块监听 `127.0.0.1:8767`。连接设备并授权 USB 调试后，以自己的序列号转发端口：

```bash
.runtime/android-sdk/platform-tools/adb -P 5038 devices -l
.runtime/android-sdk/platform-tools/adb -P 5038 -s YOUR_ANDROID_SERIAL forward tcp:3151 tcp:8767
```

在私有 `.env` 配置：

```dotenv
WECHAT_DEVICE_MODE=android_hook
WECHAT_DEVICE_SERIAL=YOUR_ANDROID_SERIAL
WECHAT_HOOK_BASE_URL=http://127.0.0.1:3151
WECHAT_HOOK_TOKEN=填入本机模块配置中的Token
WECHAT_ADMIN_ID=你的管理员微信号
WECHAT_BOT_NAME=Nila
WECHAT_AUTO_REPLY=false
```

Token 必须为 64 位十六进制字符串。不要使用示例文本作为实际密钥。`python3 scripts/probe-android-local-api.py --events` 可检查接口与事件计数，默认不发送消息。

重新启动服务，将机器人加入群，由其他成员发送 `/signup`。后台会出现待授权记录，申请本身不自动授权。批准后在后台启用自动回复，再测试 `@Nila 你好`。

## 3. 文本模型

直接调用 Ollama：

```dotenv
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:4b
```

Ollama 与模型需独立安装，默认模板不下载权重。旧的本地启动脚本使用 11435 端口，使用它时同步修改 `OLLAMA_BASE_URL`。

Hermes 适配器要求本机已安装 Hermes 到 `~/.hermes/hermes-agent`，且 managed Python 可用；入口是 `scripts/hermes-group-reply.py`。该脚本依赖 Hermes 内部接口，升级后需验证兼容性。

```dotenv
AI_PROVIDER=hermes
HERMES_WEB_SEARCH=false
```

未配置 `HERMES_API_BASE_URL` 时，Hermes 使用 Ollama 的 `/v1`。接本机兼容 API 时设置 `HERMES_API_BASE_URL`、`HERMES_API_KEY`、`HERMES_MODEL`。模型端点必须为 loopback 地址，不允许直接填外部服务地址。

启用搜索时设置 `HERMES_WEB_SEARCH=true`，在独立的 `.runtime/hermes-group-profile/config.yaml` 配置 Hermes 支持的搜索后端及必要凭据，例如已验证过的 `web.backend: exa` 与 `web.search_backend: exa`。只有 `web_search` 可用，不开放终端和本地文件工具，也不载入个人 Hermes 的记忆或上下文。请按本机 Hermes 版本确认搜索配置。

## 4. Gemini 网页图片

需要已登录 Gemini 的 Chrome。会员网页能力与 API 额度独立；此适配器操作网页，不把浏览器登录凭证导出给 Bridge。

```bash
node scripts/prepare-gemini-extension.mjs
```

生成目录为 `.runtime/gemini-extension/`。可复制到易于选择的本地目录；须完整复制 `manifest.json`、`worker.js`、`page.js` 和 `connection.js`，并保留私有 `setup.json` 用于以后更新同一扩展身份。

在 Chrome 的 `chrome://extensions` 打开开发者模式，选择“加载已解压的扩展程序”，加载生成目录。更新文件后需手动点“重新加载”。点击扩展图标打开专用 Gemini 页面并登录。

从本地 `setup.json` 将 `token` 和 `id` 分别填入 `.env`，不要公开或贴进日志：

```dotenv
IMAGE_PROVIDER=gemini_web
GEMINI_WEB_PORT=3152
GEMINI_WEB_TOKEN=本机生成的token
GEMINI_WEB_EXTENSION_ID=本机生成的id
```

重启 Bridge，检查 `/api/health` 的 `image.connected` 与 `extension_version`。在已授权群发送 `/img 画一个苹果`，验证 `sent / wechat_server_ack`。不要仅以网页出图作为微信发送成功的依据。

浏览器任务最长等待生成 240 秒，初次连接恢复最多等 45 秒；失败不自动重画或切换 API。`scripts/test-gemini-extension.mjs` 是独立测试 worker，会占用相同端口，不可与正式图片 worker 同时运行。`scripts/test-gemini-wechat.mjs` 是会真实发送图片的测试脚本，只有明确设置 `WBOT_TEST_CHAT_ID` 且群已授权才会执行。

## 5. 常驻与升级

macOS 上 `scripts/services.py` 是旧运行目录布局的 launchd 管理工具，需要其引用的 ADB、Python、Ollama、投屏 App 等本地依赖齐全；不是纯源码克隆后的通用一键安装器。先验证前台运行，再按所需进程配置自己的 launchd 服务。

当前已有运行目录的机器，发布仓库不会替换其 `.env`、数据库、手机 APK 或已安装扩展。升级前备份 SQLite、私有配置和签名文件；暂停队列并退出服务后再替换程序文件。保持配置、设备和群授权一致，恢复后检查接口连接及发送回执。
