import fs from "node:fs/promises";
import path from "node:path";
import {
  buildChannelInboundEventContext,
  createAcceptedChannelDeliveryResult,
  type InboundMediaFacts,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import {
  getAgentScopedMediaLocalRoots,
  resolveOutboundAttachmentFromUrl,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import type { ChannelMessageSendMediaContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { ChannelError, type ChannelRuntime } from "./config.js";
import type { AccountBridge, InboundTurn } from "./bridge.js";
import { guildChannelsSummary } from "./inbound.js";

const maximumMediaBytes = 50 * 1024 * 1024;
export async function prepareOutboundMedia(
  bridge: Pick<AccountBridge, "client" | "assertCurrent">,
  input: Pick<
    ChannelMessageSendMediaContext,
    "mediaUrl" | "mediaAccess" | "mediaLocalRoots" | "mediaReadFile"
  >,
  cfg: OpenClawConfig,
  channelId: string,
  signal: AbortSignal,
  agentId?: string,
) {
  signal.throwIfAborted();
  bridge.assertCurrent(channelId);
  const staged = await resolveOutboundAttachmentFromUrl(
    input.mediaUrl,
    maximumMediaBytes,
    {
      mediaAccess: input.mediaAccess,
      localRoots:
        input.mediaLocalRoots ?? getAgentScopedMediaLocalRoots(cfg, agentId),
      readFile: input.mediaReadFile,
    },
  );
  signal.throwIfAborted();
  bridge.assertCurrent(channelId);
  const info = await fs.stat(staged.path);
  if (!info.isFile() || info.size > maximumMediaBytes)
    throw new ChannelError("MEDIA_TOO_LARGE");
  const bytes = await fs.readFile(staged.path);
  signal.throwIfAborted();
  bridge.assertCurrent(channelId);
  return bridge.client.uploadAttachment(
    channelId,
    {
      fileName: path.basename(staged.path),
      mimeType: staged.contentType ?? "application/octet-stream",
      bytes,
    },
    signal,
  );
}
export function sessionRoute(
  runtime: ChannelRuntime,
  cfg: OpenClawConfig,
  accountId: string,
  turn: Pick<InboundTurn, "channel" | "senderId" | "interaction">,
): {
  agentId: string;
  sessionKey: string;
  targetSessionKey: string;
  dmScope: "per-account-channel-peer";
} {
  const direct = turn.channel.type === "DM";
  const route = runtime.routing.resolveAgentRoute({
    cfg,
    channel: "nekord",
    accountId,
    guildId: turn.channel.guildId,
    peer: {
      kind: direct ? "direct" : "channel",
      id: direct ? turn.senderId : turn.channel.id,
    },
    dmScope: "per-account-channel-peer",
  });
  const base = runtime.routing.buildAgentSessionKey({
    agentId: route.agentId,
    channel: "nekord",
    accountId,
    peer: {
      kind: direct ? "direct" : "channel",
      id: direct ? turn.senderId : turn.channel.id,
    },
    dmScope: "per-account-channel-peer",
  });
  const sessionKey = turn.interaction
    ? runtime.routing.buildAgentSessionKey({
        agentId: route.agentId,
        channel: "nekord",
        accountId,
        peer: {
          kind: "direct",
          id: `interaction:${turn.channel.id}:${turn.senderId}`,
        },
        dmScope: "per-account-channel-peer",
      })
    : base;
  return {
    ...route,
    sessionKey,
    targetSessionKey: base,
    dmScope: "per-account-channel-peer" as const,
  };
}
export async function dispatchHostTurn(
  runtime: ChannelRuntime,
  cfg: OpenClawConfig,
  turn: InboundTurn,
  bridge: AccountBridge,
): Promise<void> {
  const accountId = bridge.options.account.accountId;
  const route = sessionRoute(runtime, cfg, accountId, turn);
  const media: InboundMediaFacts[] = [];
  const stagedPaths: string[] = [];
  const stream = turn.stream();
  let replyText = "";
  try {
    const historyImages = turn.history.flatMap(({ imageMessage }) =>
      imageMessage ? [imageMessage] : [],
    );
    const hasCurrentImage = turn.message?.attachments?.some((file) =>
      /^image\/(?:png|jpeg|webp)$/i.test(file.mimeType),
    );
    const images =
      hasCurrentImage || turn.imageReply || historyImages.length
        ? await bridge.client.getImageContext(
            {
              channelId: turn.channel.id,
              current: turn.message,
              reply: turn.imageReply,
              history: historyImages,
            },
            turn.signal,
          )
        : [];
    const imageSources = [];
    const stage = async (
      bytes: Uint8Array,
      mimeType: string,
      maximum: number,
      fileName?: string,
    ) => {
      turn.assertCurrent();
      const staged = await saveMediaBuffer(
        Buffer.from(bytes),
        mimeType,
        "inbound",
        maximum,
        fileName,
        undefined,
        {
          assertCommitAllowed: turn.assertCurrent,
        },
      );
      stagedPaths.push(staged.path);
      return staged;
    };
    for (const image of images) {
      try {
        const staged = await stage(
          image.bytes,
          image.mimeType,
          10 * 1024 * 1024,
        );
        if (staged.contentType !== image.mimeType) continue;
        media.push({
          path: staged.path,
          contentType: image.mimeType,
          kind: "image",
          messageId: image.messageId,
        });
        imageSources.push({
          image: imageSources.length + 1,
          source: image.source,
          messageId: image.messageId,
        });
      } catch {
        turn.assertCurrent();
      }
    }
    for (const file of turn.message?.attachments ?? []) {
      if (file.mimeType.toLowerCase().startsWith("image/")) continue;
      turn.assertCurrent();
      const bytes = await bridge.client.downloadAttachment(
        turn.channel.id,
        file,
        turn.signal,
      );
      const staged = await stage(
        bytes,
        file.mimeType,
        maximumMediaBytes,
        file.fileName,
      );
      media.push({
        path: staged.path,
        contentType: file.mimeType,
        messageId: turn.message?.id,
      });
    }
    turn.assertCurrent();
    const channelDirectory = turn.channels?.length
      ? guildChannelsSummary(turn.channels)
      : [];
    const extra: Record<string, unknown> = {
      ...(turn.interaction
        ? {
            CommandTargetSessionKey: route.targetSessionKey,
            CommandSource: "native",
          }
        : {}),
      ...(channelDirectory.length || imageSources.length
        ? {
            ChannelStructuredContext: [
              ...(channelDirectory.length
                ? [
                    {
                      label: "available_channels",
                      source: "nekord",
                      type: "channel_directory",
                      payload: channelDirectory,
                    },
                  ]
                : []),
              ...(imageSources.length
                ? [
                    {
                      label: "image_sources",
                      source: "nekord",
                      type: "image_sources",
                      payload: imageSources,
                    },
                  ]
                : []),
            ],
          }
        : {}),
    };
    const ctx = buildChannelInboundEventContext({
      channel: "nekord",
      provider: "nekord",
      surface: "nekord",
      accountId,
      messageId: turn.messageId,
      timestamp: turn.timestamp,
      from: `nekord:${turn.senderId}`,
      sender: {
        id: turn.senderId,
        name: turn.senderName,
        isBot: turn.senderIsBot,
      },
      conversation: {
        kind:
          turn.channel.type === "DM" || turn.interaction ? "direct" : "channel",
        id: turn.channel.id,
        nativeChannelId: turn.channel.id,
        label: turn.channel.name,
        spaceId: turn.channel.guildId ?? undefined,
      },
      route: {
        agentId: route.agentId,
        accountId,
        dmScope: route.dmScope,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: `channel:${turn.channel.id}`,
        originatingTo: `channel:${turn.channel.id}`,
        nativeChannelId: turn.channel.id,
        replyToId: turn.message?.id,
        sourceReplyDeliveryMode:
          turn.channel.type === "DM" ? "direct" : "reply",
      },
      message: {
        rawBody: turn.rawText ?? turn.text,
        bodyForAgent: turn.text,
        commandBody: turn.command?.body,
        inboundHistory: turn.history.map((entry) => ({
          sender: entry.senderName,
          body: entry.text,
          timestamp: entry.timestamp,
          messageId: entry.id,
        })),
      },
      command: turn.command
        ? { kind: "native", body: turn.command.body, authorized: true }
        : { kind: "normal", authorized: true },
      access: {
        commands: { authorized: true },
        mentions: {
          canDetectMention: true,
          wasMentioned: true,
          effectiveWasMentioned: true,
        },
      },
      extra: Object.keys(extra).length ? extra : undefined,
      media,
      channelIngress: "unsupported",
    });
    const auth = resolveCommandAuthorization({
      ctx,
      cfg,
      commandAuthorized: true,
    });
    if (turn.command?.decision.kind === "plugin") {
      const payload = await turn.command.decision.execute({
        senderId: auth.senderId ?? turn.senderId,
        channel: "nekord",
        channelId: turn.channel.id,
        isAuthorizedSender: auth.isAuthorizedSender,
        senderIsOwner: auth.senderIsOwner,
        assertOwnerCurrent: auth.assertOwnerCurrent,
        agentId: route.agentId,
        sessionKey: route.sessionKey,
        commandBody: turn.command.body,
        config: cfg,
        from: ctx.From,
        to: ctx.To,
        originatingTo: ctx.To,
        accountId,
      });
      turn.assertCurrent();
      if (payload.mediaUrl || payload.mediaUrls?.length)
        throw new ChannelError("INTERACTION_ATTACHMENTS_UNSUPPORTED");
      await stream.finish(payload.text ?? "");
      return;
    }
    const deliver: NonNullable<
      Parameters<
        ChannelRuntime["inbound"]["dispatch"]
      >[0]["delivery"]["deliver"]
    > = async (payload, info) => {
      if (
        payload.isReasoning ||
        payload.isCommentary ||
        payload.isCompactionNotice ||
        info.kind === "tool"
      )
        return {
          visibleReplySent: false,
          suppression: { reason: "channel_transform" },
        };
      turn.assertCurrent();
      const urls =
        payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      if (urls.length > 10) throw new ChannelError("TOO_MANY_ATTACHMENTS");
      if (urls.length && turn.interaction)
        throw new ChannelError("INTERACTION_ATTACHMENTS_UNSUPPORTED");
      replyText = [replyText, payload.text].filter(Boolean).join("\n\n");
      await stream.publishText(replyText);
      const ids = [...stream.messageIds];
      if (urls.length) {
        const attachments = [];
        for (const mediaUrl of urls)
          attachments.push(
            await prepareOutboundMedia(
              bridge,
              { mediaUrl },
              cfg,
              turn.channel.id,
              turn.signal,
              route.agentId,
            ),
          );
        ids.push(...(await stream.sendAttachments(attachments)));
      }
      if (!stream.visible && !ids.length)
        return {
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" },
        };
      return createAcceptedChannelDeliveryResult({
        kind: "text",
        results: (ids.length ? ids : [turn.interaction!.id]).map(
          (messageId) => ({ channel: "nekord", messageId }),
        ),
        content: payload.text,
        replyToId: turn.message?.id,
      });
    };
    await runtime.inbound.dispatch({
      cfg,
      route: {
        agentId: route.agentId,
        dmScope: route.dmScope,
        sessionKey: route.sessionKey,
      },
      channel: "nekord",
      accountId,
      ctxPayload: ctx,
      delivery: {
        deliver,
        deliverPrepared: (plan, info) => deliver(plan.payload, info),
      },
      replyOptions: {
        abortSignal: turn.signal,
        suppressTyping: true,
        suppressDefaultToolProgressMessages: true,
        suppressToolProgressMessages: true,
        [PLUGIN_COMMAND_DISPATCH]: turn.command?.decision,
        onPartialReply: async (payload) => {
          turn.assertCurrent();
          if (payload.text)
            stream.update(
              [replyText, payload.text].filter(Boolean).join("\n\n"),
            );
        },
      },
    });
    await stream.finish();
  } finally {
    await Promise.allSettled(stagedPaths.map((file) => fs.unlink(file)));
  }
}
