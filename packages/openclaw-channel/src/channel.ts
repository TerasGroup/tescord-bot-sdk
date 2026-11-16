import {
  createPluginCommandRuntime,
  type PluginCommandRuntime,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { createAcceptedChannelDeliveryResult } from "openclaw/plugin-sdk/channel-inbound";
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
import { sendRest } from "./outbound.js";

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
  const match = /^(?:nekord:)?(channel|user):([A-Za-z0-9_-]{1,160})$/.exec(to);
  if (!match) throw new ChannelError("INVALID_MESSAGE_TARGET");
  return { kind: match[1] as "channel" | "user", id: match[2]! };
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
        const parsed = resolveTarget(target);
        return `${parsed.kind}:${parsed.id}`;
      } catch {
        return undefined;
      }
    },
    targetResolver: {
      looksLikeId: (target) =>
        /^(?:nekord:)?(?:user|channel):[A-Za-z0-9_-]+$/.test(target),
      hint: "channel:<id> / user:<id>",
    },
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
  const target = resolveTarget(ctx.to);
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
        : bridge.assertCurrent(target.id);
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
