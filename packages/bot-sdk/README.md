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

Gateway 处理 IDENTIFY、心跳、重连、撤销终止及事件去重。事件包括 READY、BOT_CONFIG_UPDATE、MESSAGE_CREATE/UPDATE/DELETE、INTERACTION_CREATE、DM_CHANNEL_CREATE、TYPING_START。业务处理异常只发出脱敏的 CLIENT_ERROR。
