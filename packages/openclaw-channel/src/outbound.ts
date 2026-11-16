import { NekordBotClient } from "@nekord/bot-sdk";
import { createAcceptedChannelDeliveryResult } from "openclaw/plugin-sdk/channel-inbound";
import type { Channel, BotConfigUpdatePayload } from "@tescord/types";
import { ChannelError, resolveAccount, type NekordPlugin } from "./config.js";
import { accountDirectory } from "./state.js";
import { PluginIdentity } from "./identity.js";
import { splitMessage } from "./stream.js";
import { prepareOutboundMedia } from "./host.js";
type SendContext = Parameters<
  NonNullable<NonNullable<NekordPlugin["outbound"]>["sendMedia"]>
>[0];
export async function sendRest(ctx: SendContext, stateRoot: string) {
  const account = resolveAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled || !account.botToken || !account.configured)
    throw new ChannelError("BOT_ACCOUNT_UNCONFIGURED");
  const match = /^(?:nekord:)?(channel|user):([A-Za-z0-9_-]{1,160})$/.exec(
    ctx.to,
  );
  if (!match) throw new ChannelError("INVALID_MESSAGE_TARGET");
  const client = new NekordBotClient({
    serverUrl: account.serverUrl,
    token: account.botToken,
  });
  const signal = ctx.signal ?? new AbortController().signal;
  let identity: PluginIdentity | undefined;
  let config: BotConfigUpdatePayload;
  try {
    config = await client.getConfig(signal);
    identity = await PluginIdentity.load(
      await accountDirectory(stateRoot, account.accountId),
      config.application,
      client,
    );
    if (!config.application.device) {
      await identity.register(signal);
      config = await client.getConfig(signal);
    }
    if (
      config.application.device?.deviceId !== identity.identity.deviceId ||
      config.application.device.fingerprint !== identity.identity.fingerprint
    )
      throw new ChannelError("BOT_DEVICE_REVOKED");
    let channel: Channel;
    if (match[1] === "user") {
      channel = await client.createDm(match[2]!, signal);
      config = await client.getConfig(signal);
    } else {
      const selected = config.channels.find((item) => item.id === match[2]);
      if (!selected) throw new ChannelError("CHANNEL_UNAVAILABLE");
      channel = selected;
    }
    const assertCurrent = () => {
      signal.throwIfAborted();
      ctx.assertDirectAdapterHandoff?.();
      const current = config.channels.find((item) => item.id === channel.id);
      if (!current) throw new ChannelError("CHANNEL_UNAVAILABLE");
      return current;
    };
    assertCurrent();
    const nonce = crypto.randomUUID();
    const files = ctx.mediaUrl
      ? [
          await prepareOutboundMedia(
            { client, assertCurrent },
            { ...ctx, mediaUrl: ctx.mediaUrl },
            ctx.cfg,
            channel.id,
            signal,
          ),
        ]
      : [];
    const parts = splitMessage(ctx.text);
    if (!parts.length && files.length) parts.push("");
    const ids: string[] = [];
    for (let index = 0; index < parts.length; index++) {
      config = await client.getConfig(signal);
      assertCurrent();
      const content = channel.isE2EE
        ? await identity.encrypt(
            channel.id,
            parts[index]!,
            undefined,
            undefined,
            signal,
          )
        : parts[index]!;
      await ctx.onPlatformSendDispatch?.();
      assertCurrent();
      const result = await client.sendMessage(
        channel.id,
        {
          content,
          isEncrypted: Boolean(channel.isE2EE),
          replyToId: index === 0 ? (ctx.replyToId ?? undefined) : undefined,
          attachments: index === 0 ? files : undefined,
          nonce: `${nonce}:${index}`,
        },
        signal,
      );
      ids.push(result.id);
    }
    if (!ids.length) throw new ChannelError("EMPTY_MESSAGE");
    const accepted = createAcceptedChannelDeliveryResult({
      kind: files.length ? "media" : "text",
      results: ids.map((messageId) => ({ channel: "nekord", messageId })),
      content: ctx.text,
    });
    return {
      channel: "nekord" as const,
      messageId: ids[0]!,
      receipt: accepted.receipt,
    };
  } finally {
    client.close();
    await identity?.close();
  }
}
