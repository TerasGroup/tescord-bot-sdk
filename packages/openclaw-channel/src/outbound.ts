import { NekordBotClient } from "@nekord/bot-sdk";
import { createAcceptedChannelDeliveryResult } from "openclaw/plugin-sdk/channel-inbound";
import {
  CHANNEL_MENTION_TOKEN_REGEX_SOURCE,
  replaceChannelNamesWithTokens,
  resolveGuildChannelMention,
  type Channel,
  type BotConfigUpdatePayload,
} from "@tescord/types";
import { ChannelError, resolveAccount, type NekordPlugin } from "./config.js";
import { accountDirectory } from "./state.js";
import { PluginIdentity } from "./identity.js";
import { splitMessage } from "./stream.js";
import { prepareOutboundMedia } from "./host.js";
type SendContext = Parameters<
  NonNullable<NonNullable<NekordPlugin["outbound"]>["sendMedia"]>
>[0];
export type ParsedOutboundTarget =
  | { kind: "user"; id: string }
  | { kind: "channel"; id: string }
  | { kind: "channel-query"; query: string };
const EXACT_CHANNEL_MENTION_REGEX = new RegExp(
  `^${CHANNEL_MENTION_TOKEN_REGEX_SOURCE}$`,
);
export function parseOutboundTarget(to: string): ParsedOutboundTarget {
  const trimmed = to.trim();
  const explicit = /^(?:nekord:)?(channel|user):([A-Za-z0-9_-]{1,160})$/.exec(
    trimmed,
  );
  if (explicit) {
    return {
      kind: explicit[1] as "channel" | "user",
      id: explicit[2]!,
    };
  }
  const stripped = trimmed.replace(/^nekord:/, "").replace(/^channel:/, "");
  const mention = EXACT_CHANNEL_MENTION_REGEX.exec(stripped);
  if (mention?.[1]) return { kind: "channel", id: mention[1] };
  if (/^#[^\r\n]+$/.test(stripped) && stripped.length > 1) {
    return { kind: "channel-query", query: stripped };
  }
  throw new ChannelError("INVALID_MESSAGE_TARGET");
}
export function resolveWritableChannel(
  channels: readonly Channel[],
  target: Exclude<ParsedOutboundTarget, { kind: "user" }>,
): Channel {
  const selected =
    target.kind === "channel"
      ? channels.find((item) => item.id === target.id)
      : resolveGuildChannelMention(channels, target.query);
  if (!selected || selected.type === "VOICE") {
    throw new ChannelError("CHANNEL_UNAVAILABLE");
  }
  return selected;
}
export async function sendRest(ctx: SendContext, stateRoot: string) {
  const account = resolveAccount(ctx.cfg, ctx.accountId);
  if (!account.enabled || !account.botToken || !account.configured)
    throw new ChannelError("BOT_ACCOUNT_UNCONFIGURED");
  const target = parseOutboundTarget(ctx.to);
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
    if (target.kind === "user") {
      channel = await client.createDm(target.id, signal);
      config = await client.getConfig(signal);
    } else {
      channel = resolveWritableChannel(config.channels, target);
    }
    const assertCurrent = () => {
      signal.throwIfAborted();
      ctx.assertDirectAdapterHandoff?.();
      const current = config.channels.find((item) => item.id === channel.id);
      if (!current || current.type === "VOICE")
        throw new ChannelError("CHANNEL_UNAVAILABLE");
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
    const parts = splitMessage(
      replaceChannelNamesWithTokens(ctx.text, config.channels),
    );
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
