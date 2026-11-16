# Tescord Bot

独立 pnpm workspace，包含 `@nekord/bot-sdk` 与 `@nekord/openclaw-channel`。对应主仓库 Bot REST/Gateway 协议。

```powershell
pnpm install --ignore-scripts
pnpm verify:protocol
pnpm typecheck
pnpm build
pnpm test
pnpm smoke:openclaw
pnpm smoke:backend
```

项目使用 pnpm 11.9.0，插件适配 OpenClaw **2026.10.9**。pnpm 为项目选择 Node 24.22.1，不修改全局 Node。SDK 支持 Node >=22.17.1。

## 固定回复测试 Bot

在 `.env.production.local` 设置 `NEKORD_SERVER_URL`、`NEKORD_BOT_TOKEN` 和可选的 `NEKORD_BOT_LOCALE`（默认 `zh-CN`）。该文件与 `.runtime/` 均已忽略。设备私钥保存在 `.runtime/fixed-bot/nekord/<applicationId>/`，重启时必须保留。

```powershell
pnpm start:test-bot
# Windows 后台运行
pnpm start:test-bot:background
# 停止本程序
pnpm stop:test-bot
```

预设 `/ping`、`/hello`、`/help`、`/context` 四个原生指令，均仅调用者可见。私信直接触发；频道中使用原生指令、@Bot 或引用 Bot 消息。普通触发回复使用消息回复，`ping` 与 `/ping` 均可识别。非指令消息返回固定确认文本。

上下文按服务器配置读取触发前的 N 条；`/context` 根据是否存在可读消息返回两种固定文本。可选的 `NEKORD_TEST_MARKER` 仅用于日志记录是否在上下文中找到指定测试标记。日志不写入消息正文、Token 或密钥。运行状态和记录分别在 `.runtime/fixed-bot/status.json`、`.runtime/fixed-bot/events.jsonl`。

入口使用现有 Bot REST/Gateway 契约，以 Bot Token 鉴权，仅处理服务端配置允许的频道与对应 application 的事件。沿用设备签名、加密解密和事件去重；加密频道拒绝明文，私密指令仅向调用者与 Bot 设备加密。配置变化或断线时取消旧任务，撤销时停止。无权限历史返回空上下文。该程序不调用模型或执行聊天内容中的操作。

生产实测记录见 [固定回复 Bot 验收](docs/fixed-bot-production-2026-11-06.md)。

`smoke:backend` 默认读取相邻的 `../Tescord`，可用 `TESCORD_REPO` 指定主仓库。它要求 3101 端口空闲，只创建随机命名的隔离 SQLite 与上传目录。OpenClaw 使用临时状态目录；原生命令阶段拒绝模型请求，正文阶段使用本地模拟流式模型。不会读取现有 OpenClaw 配置、调用付费模型或迁移业务数据库。脱敏日志保存在 `test-results/`。

## 安装插件

完成构建后，在使用相同 OpenClaw 版本的环境执行：

```powershell
openclaw plugins install --link E:/nodejs_project/tescord-bot/packages/openclaw-channel
```

OpenClaw 配置示例：

```json
{
  "plugins": {
    "allow": ["nekord"],
    "entries": { "nekord": { "enabled": true } }
  },
  "channels": {
    "nekord": {
      "enabled": true,
      "serverUrl": "https://nekord.example",
      "locale": "zh-CN",
      "allowFrom": ["USER_ID"],
      "publicCommands": [],
      "streamIntervalMs": 1000,
      "maxQueue": 32
    }
  },
  "commands": { "ownerAllowFrom": ["nekord:OWNER_USER_ID"] }
}
```

在启动 OpenClaw 的进程环境中设置 `NEKORD_BOT_TOKEN`。也支持通过 `botToken` 配置字段使用 OpenClaw SecretRef；不要将真实 Token 提交到 Git。`serverUrl` 必须为 HTTPS；本机测试允许 loopback HTTP。自签名证书使用 Node 的可信 CA 配置。

多账户使用 `channels.nekord.accounts.<accountId>` 覆盖根配置。账户 ID 为 1–64 位字母、数字、下划线或连字符；命名账户的环境变量是 `NEKORD_BOT_TOKEN_<大写账户ID>`，连字符转换为下划线。

`allowFrom` 默认 `['*']`，只控制普通发送者准入；OpenClaw 所有者权限由其 `commands.ownerAllowFrom` 等主机规则决定。默认忽略其他 Bot 的消息，可显式设置 `allowBotMessages`。

`NEKORD_SERVER_URL` 可作为未配置 `serverUrl` 时的环境变量。状态保存在 OpenClaw 状态目录下的 `nekord/<accountId>/`，包含设备私钥、已信任公钥和事件 ID。保留该目录；设备被吊销或本地私钥丢失时，先在集成页重置 Token，再重新绑定设备。

## 验证范围

- 默认触发：提及 Bot、回复 Bot、原生斜杠指令；DM 直接接收。`respondToAll` 与上下文数使用服务端配置。
- 新 Bot 的历史默认 5 条，已有设置与频道覆盖保留。历史只拉取触发消息之前的 N 条，解密失败跳过且不补足；N=0 不发历史请求。同一频道延续 OpenClaw 会话，不同频道、账号、私信及私密指令隔离；会话压缩与重置由主机配置管理。
- 原生命令自动注册五语言名称、描述及参数，默认私密；`publicCommands` 可选择公开回复。私密指令采用调用者隔离的会话。
- 流式正文按默认 1 秒间隔编辑，每次重新加密并递增修订号。生成期间每 3 秒续发 typing，结束时主动停止。无变化的配置刷新不取消任务，断线、实际配置变化及撤销会取消任务，不自动重做命令。
- 频道与 DM 支持现有附件上传/下载。附件内容沿用主仓库当前明文协议。现有 Interaction 协议仅支持文本；私密媒体被拒绝，不转换为公开发送。单条 Interaction 回复上限 4000 字符。
- 主动发送目标使用 `channel:<id>` 或 `user:<id>`；后者仅能创建本公会成员的 DM，并遵守屏蔽与服务端限流。

共享类型来自主仓库构建产物 `vendor/*.tgz`，哈希、源摘要与提交基线见 `vendor/protocol-lock.json`。两个包在构建时打入共享协议代码，发布产物不依赖相邻主仓库路径。

OpenClaw 接口依据固定版本的公开 SDK，并对照[渠道插件文档](https://docs.openclaw.ai/plugins/sdk-channel-plugins)与[插件清单文档](https://docs.openclaw.ai/plugins/manifest)。

执行结果见 [验收记录](docs/verification.md)。

本轮 @Bot、连续会话与状态停止的验证见[2026-11-17 验收](docs/mentions-2026-11-17.md)。
