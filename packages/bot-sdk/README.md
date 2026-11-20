# @nekord/bot-sdk

```ts
import { NekordBotClient } from "@nekord/bot-sdk";

const client = new NekordBotClient({
  serverUrl: process.env.NEKORD_SERVER_URL!,
  token: process.env.NEKORD_BOT_TOKEN!,
});
const config = await client.getConfig();
await client.connect(config.application.device!.deviceId);
client.close();
```

首次连接前使用 `registerDevice` 注册本地生成的设备和持有证明；密钥处理见 OpenClaw 插件的 `identity.ts`。SDK 不解密消息，不记录 Token 或服务端错误正文。

REST 支持配置、设备目录、历史、发送/编辑、typing、DM、命令、Interaction 和附件。所有响应经运行时校验；鉴权只发往配置的同源地址，禁止重定向。GET 和幂等 nonce 发送支持有限重试；编辑和 Interaction 写入遇到未知传输结果时直接失败。

## 图片上下文和跨频道发送

```ts
const images = await client.getImageContext({
  channelId: message.channelId,
  current: message,
  reply: quotedMessage,
  history: recentMessages,
});

const sent = await client.sendMessageFromInvocation(targetChannelId, {
  source: { kind: "message", id: message.id, channelId: message.channelId },
  content: "The image was reviewed.",
  isEncrypted: false,
});
```

`getImageContext` 从同频道的消息附件返回图片字节及来源。上下文顺序为当前消息、引用、由近到远的历史，最多返回 4 张 PNG、JPEG 或 WebP，单张 10 MiB、合计 20 MiB。普通 SDK Bot 自行选择识图模型，并在提供加密频道图片上下文前完成消息解密与校验。

跨频道发送可使用 `kind: "interaction"` 和公开斜杠调用 ID。示例目标是明文频道。加密目标应先获取目标设备目录并用目标频道 ID 生成密文。`sendMessageFromInvocation` 默认生成 nonce，跨业务重试时可传入稳定 nonce。目标 Tescord 后端需要提供调用发信接口。

Gateway 处理 IDENTIFY、心跳、重连、撤销终止及事件去重。事件包括 READY、BOT_CONFIG_UPDATE、MESSAGE_CREATE/UPDATE/DELETE、INTERACTION_CREATE、DM_CHANNEL_CREATE、TYPING_START。业务处理异常只发出脱敏的 CLIENT_ERROR。
