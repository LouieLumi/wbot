# API

默认 `http://127.0.0.1:3100`。除页面与登录入口外，接口要求 `Authorization: Bearer <BRIDGE_API_TOKEN>`。管理网页支持同源 HttpOnly 会话，不支持跨源请求或查询参数 Token。消息正文和凭证不写入日志。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | /api/health | 服务、暂停、监听可靠性及配置状态 |
| GET | /api/device/status | ADB 连接、安装、前台状态 |
| GET | /api/wechat/status | 微信状态；不推测登录成功 |
| GET | /api/chats | 已配置并验证的会话，非全部微信会话 |
| GET | /api/groups | 已配置并验证的群聊 |
| POST | /api/messages/send | 文本发送排队，202 返回任务 |
| GET | /api/jobs/:id | 查询 queued/running/sent/failed/uncertain |
| GET (WS) | /api/events | 实时事件，无历史重放 |
| POST | /api/control | `{"paused":true}` 一键暂停 |
| POST | /api/messages/at | 501，尚未支持 |
| POST | /api/messages/image | 501，尚未支持 |

发送请求：`{"chat_id":"test-group","content":"你好"}`。可附 `Idempotency-Key` 请求头；相同 key 和内容返回同一任务，冲突返回 409。兼容 `chat_type` + `chat_name`，但出现多个匹配时返回 409，推荐稳定的 Bridge `chat_id`。

WebSocket 事件包括 `message.received`、`job.updated`、`reply.failed`、`control.changed`。代码模式的 `message_id` 与时间来自手机消息事件；旧视觉模式使用本地观察标识和时间。`own:null` 和 `mention:unknown` 必须当作未知处理。消息事件含正文，只通过已鉴权的本地连接传递。慢客户端超过 1 MB 缓冲会被断开。

发送任务会把待发送正文保存在权限为 0600 的本地 SQLite 中；它不是加密数据库。收到的聊天正文不持久化为审计日志。请保护这台 Mac 的账号和磁盘。

暂停会阻止后续监听、后续队列执行和 AI 回答入队；已经进入设备发送步骤的任务可能已提交给微信，不能撤回。恢复后重新建立消息基线，不补读暂停期间的历史。


## 管理接口

管理页面：GET /。本机命令 `npm run admin` 使用 Bearer Token 请求 POST /api/admin/ticket，产生 60 秒单次票据；POST /api/auth/exchange 交换 12 小时会话。POST /api/auth/logout 注销会话。Cookie 会话持久化，有效期内可跨服务重启；重设密码会使旧会话失效。

| 方法 | 路径 | 功能 |
| --- | --- | --- |
| GET | /api/admin/state | 群授权、轮询状态、锁屏验证时间、发送任务摘要 |
| GET | /api/admin/models | 当前模型来源的可用模型 |
| PATCH | /api/admin/settings | {default_model, reasoning_effort?} |
| POST | /api/admin/groups | {name}，暂停时核验并授权当前群 |
| PATCH | /api/admin/groups/:id | {enabled?, model?, paused?}，空 model 为继承 |
| GET | /api/admin/groups/:id/members | 已发现的成员及记忆概况 |
| GET | /api/admin/groups/:id/members/:member | 成员设置和最近上下文 |
| PATCH | /api/admin/groups/:id/members/:member | {notes?, model?, enabled?} |
| POST | /api/admin/groups/:id/members/:member/reset | {notes:true} 清全部，false 仅清上下文 |

管理接口要求本机 Bearer Token 或已登录 Cookie。记忆和聊天正文属于本地私有数据，管理员可查看，但接口没有额外数据库加密。记忆修改增加 revision，使旧的尚未发送回答失效；已经进入设备发送步骤的内容不能撤回。

## 图片与群申请

群内 `/img` 通过图片生成队列发送真实图片；公开 REST `/api/messages/image` 仍返回 501，不是 `/img` 的入口。图片 worker 使用独立端口及 Token，开放 `/heartbeat`、`/claim`、`/result`、`/status` 给指定扩展。任务回传需匹配已领取的有效 UUID，过期回传返回 409。

代码模式新群由手机 `/signup` 事件进入后台待授权列表，`PATCH /api/admin/groups/:id` 的 `enabled` 字段完成批准或撤销。`POST /api/admin/groups` 是旧界面登记入口，不是代码模式的新群入口。`GET /api/admin/jobs` 支持分页、状态、群和范围筛选。

密码登录：`POST /api/auth/login`，退出：`POST /api/auth/logout`。登录接口有独立失败限流。

## Gemini 下载诊断

独立本机 worker 端口上的 `POST /probe-download` 使用 `GEMINI_WEB_TOKEN` 鉴权，接收 `{ "url": "https://lh3.googleusercontent.com/gg-dl/..." }`。只接受 Google 生成图片路径，在 worker 空闲时通过现有浏览器下载该资源，返回 MIME、字节数和 SHA-256；不会提交提示词或发送微信群消息。`GET /status` 的 `worker_failure` 保留错误类型和 HTTP 状态，不包含图片地址、提示词或登录信息。
