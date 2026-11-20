import {
  createPluginCommandRuntime,
  type PluginCommandRuntime,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { createAcceptedChannelDeliveryResult } from "openclaw/plugin-sdk/channel-inbound";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import {
  InteractionType,
  MAX_MESSAGE_CONTENT_LENGTH,
  replaceChannelNamesWithTokens,
} from "@tescord/types";
import {
  listAccounts,
  resolveAccount,
  ChannelError,
  type GatewayContext,
  type NekordPlugin,
  type RuntimeHolder,
} from "./config.js";
import { AccountBridge, safeErrorCode } from "./bridge.js";
import { dispatchHostTurn, prepareOutboundMedia } from "./host.js";
import { splitMessage, ReplyStream } from "./stream.js";
import {
  secretTargetRegistryEntries,
  collectRuntimeConfigAssignments,
} from "./secret-contract-api.js";
import { channelConfigSchema } from "./schema.js";
import {
  parseOutboundTarget,
  resolveWritableChannel,
  sendRest,
} from "./outbound.js";

export const holder: RuntimeHolder & { commands?: PluginCommandRuntime } = {};
const active = new Map<string, AccountBridge>();
export async function startAccount(ctx: GatewayContext): Promise<void> {
  if (!ctx.channelRuntime || !holder.runtime || !holder.commands)
    throw new ChannelError("HOST_RUNTIME_UNAVAILABLE");
  if (!ctx.account.configured || !ctx.account.botToken)
    throw new ChannelError("BOT_ACCOUNT_UNCONFIGURED");
  if (active.has(ctx.accountId))
    throw new ChannelError("ACCOUNT_ALREADY_RUNNING");
  const runtime = holder.runtime.channel;
  const bridge = new AccountBridge({
    account: ctx.account,
    cfg: ctx.cfg,
    stateRoot: holder.runtime.state.resolveStateDir(),
    scheduler: ctx.scheduler,
    signal: ctx.abortSignal,
    commands: holder.commands,
    dispatch: (turn, connection) =>
      dispatchHostTurn(runtime, ctx.cfg, turn, connection),
    status: (connected) =>
      ctx.setStatus({
        ...ctx.getStatus(),
        accountId: ctx.accountId,
        running: true,
        connected,
        lifecycle: connected ? "ready" : "recovering",
        lastEventAt: Date.now(),
      }),
    error: (code) => ctx.log?.error(code),
  });
  active.set(ctx.accountId, bridge);
  try {
    await bridge.start();
    await new Promise<void>((resolve) => {
      if (bridge.signal.aborted) resolve();
      else
        bridge.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
  } finally {
    await bridge.close();
    if (active.get(ctx.accountId) === bridge) active.delete(ctx.accountId);
    ctx.setStatus({
      ...ctx.getStatus(),
      running: false,
      connected: false,
      lifecycle: "stopped",
    });
  }
}
function connection(accountId?: string | null): AccountBridge {
  const value = active.get(accountId || "default");
  if (!value) throw new ChannelError("ACCOUNT_NOT_RUNNING");
  return value;
}
export function resolveTarget(to: string): {
  kind: "channel" | "user";
  id: string;
} {
  const parsed = parseOutboundTarget(to);
  if (parsed.kind === "channel-query")
    throw new ChannelError("INVALID_MESSAGE_TARGET");
  return parsed;
}
export const nekordPlugin: NekordPlugin = {
  id: "nekord",
  meta: {
    id: "nekord",
    label: "Nekord",
    selectionLabel: "Nekord",
    docsPath: "/channels/nekord",
    blurb: "Nekord",
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    edit: true,
    reply: true,
    media: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  configSchema: channelConfigSchema,
  config: {
    listAccountIds: listAccounts,
    resolveAccount,
    defaultAccountId: () => "default",
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveAccount(cfg, accountId).allowFrom,
  },
  reload: { configPrefixes: ["channels.nekord"] },
  commands: {
    nativeCommandsAutoEnabled: true,
    nativeSkillsAutoEnabled: true,
    enforceOwnerForCommands: false,
  },
  secrets: { secretTargetRegistryEntries, collectRuntimeConfigAssignments },
  gateway: {
    apiVersion: 2,
    startAccount,
    stopAccount: async (ctx) => {
      await active.get(ctx.accountId)?.close();
    },
  },
  messaging: {
    normalizeTarget: (target) => {
      try {
        const parsed = parseOutboundTarget(target);
        return parsed.kind === "channel-query"
          ? parsed.query
          : `${parsed.kind}:${parsed.id}`;
      } catch {
        return undefined;
      }
    },
    targetResolver: {
      looksLikeId: (target) => {
        try {
          parseOutboundTarget(target);
          return true;
        } catch {
          return false;
        }
      },
      hint: "channel:<id> / #channel / user:<id>",
    },
  },
  actions: {
    describeMessageTool: () => ({ actions: ["send"] }),
    supportsAction: ({ action }) => action === "send",
    prepareSendPayload: ({ ctx, to, payload }) => {
      const invocation = resolveInvocationTarget(ctx, to);
      return !invocation || invocation.channel.id === invocation.turn.channel.id
        ? payload
        : null;
    },
    handleAction: sendMessageAction,
  },
  agentPrompt: {
    messageToolHints: () => [
      "To post a user-requested message to a different Nekord text channel, use message(action=send) with its channel:<id> or <#id> target and the text to publish. A channel mention in a normal reply does not send a message there.",
    ],
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    chunker: splitMessage,
    chunkerMode: "text",
    sendText: async (ctx) => send(ctx),
    sendMedia: async (ctx) => send(ctx),
  },
};

type MessageAction = Parameters<
  NonNullable<NonNullable<NekordPlugin["actions"]>["handleAction"]>
>[0];

function resolveInvocationTarget(ctx: MessageAction, target: string) {
  if (ctx.toolContext?.currentChannelProvider !== "nekord") return undefined;
  const accountId = ctx.requesterAccountId;
  const sourceTarget = ctx.toolContext.currentChannelId;
  const sourceMessageId = ctx.toolContext.currentMessageId;
  if (
    !accountId ||
    (ctx.accountId && ctx.accountId !== accountId) ||
    !sourceTarget ||
    typeof sourceMessageId !== "string" ||
    !ctx.requesterSenderId
  )
    throw new ChannelError("INVALID_SEND_INVOCATION");
  const sourceChannelId = sourceTarget.replace(/^(?:nekord:)?channel:/, "");
  const bridge = connection(accountId);
  const turn = bridge.getInboundTurn(sourceChannelId, sourceMessageId);
  if (
    !turn ||
    turn.senderId !== ctx.requesterSenderId ||
    turn.interaction?.ephemeral
  )
    throw new ChannelError("INVALID_SEND_INVOCATION");
  turn.assertCurrent();
  const parsed = parseOutboundTarget(target);
  if (parsed.kind === "user") throw new ChannelError("INVALID_MESSAGE_TARGET");
  const channels = bridge.config.channels;
  return {
    bridge,
    turn,
    channel: resolveWritableChannel(channels, parsed),
    channels,
    accountId,
  };
}

async function sendMessageAction(ctx: MessageAction) {
  if (ctx.action !== "send") throw new ChannelError("INVALID_MESSAGE_TARGET");
  const target = ctx.params.target ?? ctx.params.to;
  if (typeof target !== "string")
    throw new ChannelError("INVALID_MESSAGE_TARGET");
  const text = typeof ctx.params.message === "string" ? ctx.params.message : "";
  const mediaUrl =
    typeof ctx.params.mediaUrl === "string" ? ctx.params.mediaUrl : "";
  const options = {
    cfg: ctx.cfg,
    accountId: ctx.accountId,
    to: target,
    text,
    mediaUrl,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    replyToId: ctx.reply?.replyToId,
    assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
    onPlatformSendDispatch: ctx.onPlatformSendDispatch,
  };
  const invocation = resolveInvocationTarget(ctx, target);
  if (!invocation) return jsonResult(await send(options));
  const { bridge, turn, channel, channels, accountId } = invocation;
  if (channel.id === turn.channel.id)
    return jsonResult(
      await send({ ...options, accountId, signal: turn.signal }),
    );
  if (
    turn.channel.type !== "TEXT" ||
    channel.type !== "TEXT" ||
    !turn.channel.guildId ||
    channel.guildId !== turn.channel.guildId ||
    turn.senderIsBot ||
    (turn.interaction &&
      turn.interaction.type !== InteractionType.APPLICATION_COMMAND)
  )
    throw new ChannelError("INVALID_SEND_INVOCATION");
  if (
    mediaUrl ||
    (Array.isArray(ctx.params.mediaUrls) && ctx.params.mediaUrls.length) ||
    (Array.isArray(ctx.params.attachments) && ctx.params.attachments.length) ||
    ctx.reply?.source === "explicit" ||
    ctx.params.location
  )
    throw new ChannelError("CROSS_CHANNEL_TEXT_REQUIRED");
  const plain = replaceChannelNamesWithTokens(text, channels);
  if (!plain.trim() || plain.length > MAX_MESSAGE_CONTENT_LENGTH)
    throw new ChannelError("INVALID_MESSAGE_LENGTH");
  const current = bridge.assertCurrent(channel.id);
  const isEncrypted = Boolean(current.isE2EE);
  const content = isEncrypted
    ? await bridge.identity.encrypt(
        channel.id,
        plain,
        undefined,
        undefined,
        turn.signal,
      )
    : plain;
  await ctx.onPlatformSendDispatch?.();
  turn.assertCurrent();
  ctx.assertDirectAdapterHandoff?.();
  bridge.assertCurrent(channel.id);
  const result = await bridge.client.sendMessageFromInvocation(
    channel.id,
    {
      source: {
        kind: turn.interaction ? "interaction" : "message",
        id: turn.messageId,
        channelId: turn.channel.id,
      },
      content,
      isEncrypted,
    },
    turn.signal,
  );
  return jsonResult({
    ok: true,
    channel: "nekord",
    channelId: channel.id,
    messageId: result.id,
  });
}
async function send(
  ctx: Parameters<
    NonNullable<NonNullable<NekordPlugin["outbound"]>["sendMedia"]>
  >[0],
) {
  if (!active.has(ctx.accountId || "default")) {
    if (!holder.runtime) throw new ChannelError("HOST_RUNTIME_UNAVAILABLE");
    return sendRest(ctx, holder.runtime.state.resolveStateDir());
  }
  const bridge = connection(ctx.accountId);
  const target = parseOutboundTarget(ctx.to);
  const scheduler = bridge.options.scheduler.scope();
  const signal = AbortSignal.any([
    bridge.signal,
    scheduler.signal,
    ...(ctx.signal ? [ctx.signal] : []),
  ]);
  let stream: ReplyStream | undefined;
  try {
    signal.throwIfAborted();
    const channel =
      target.kind === "user"
        ? await bridge.client.createDm(target.id, signal)
        : resolveWritableChannel(bridge.config.channels, target);
    if (channel.type === "VOICE") throw new ChannelError("CHANNEL_UNAVAILABLE");
    if (target.kind === "user") {
      const config = await bridge.refreshConfig(signal);
      if (!config.channels.some((item) => item.id === channel.id))
        throw new ChannelError("CHANNEL_UNAVAILABLE");
    }
    const assertCurrent = () => {
      signal.throwIfAborted();
      bridge.assertCurrent(channel.id);
      ctx.assertDirectAdapterHandoff?.();
    };
    assertCurrent();
    stream = new ReplyStream({
      client: bridge.client,
      identity: bridge.identity,
      channel,
      channels: bridge.config.channels,
      scheduler,
      signal,
      intervalMs: bridge.options.account.streamIntervalMs,
      assertCurrent,
      replyToId: ctx.replyToId ?? undefined,
    });
    const files = ctx.mediaUrl
      ? [
          await prepareOutboundMedia(
            bridge,
            { ...ctx, mediaUrl: ctx.mediaUrl },
            ctx.cfg,
            channel.id,
            signal,
          ),
        ]
      : [];
    await ctx.onPlatformSendDispatch?.();
    assertCurrent();
    await stream.finish(ctx.text);
    const ids = [
      ...stream.messageIds,
      ...(await stream.sendAttachments(files)),
    ];
    if (!ids.length) throw new ChannelError("EMPTY_MESSAGE");
    const accepted = createAcceptedChannelDeliveryResult({
      kind: "text",
      results: ids.map((messageId) => ({ channel: "nekord", messageId })),
      content: ctx.text,
    });
    return {
      channel: "nekord" as const,
      messageId: ids[0]!,
      receipt: accepted.receipt,
    };
  } catch (error) {
    throw new ChannelError(safeErrorCode(error));
  } finally {
    await stream?.close();
    scheduler.beginClose();
    await scheduler.stop();
  }
}
export function initializeCommands(): void {
  holder.commands = createPluginCommandRuntime();
}
