import { test, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { BotConfigUpdatePayload, Channel } from "@tescord/types";
import {
  NekordBotClient,
  CHANNEL_MENTION_TOKEN_REGEX_SOURCE,
  formatChannelMention,
  replaceChannelNamesWithTokens,
} from "../packages/bot-sdk/src/index.js";
import {
  formatInboundTextForAgent,
  guildChannelsSummary,
  readHistory,
  shouldTrigger,
} from "../packages/openclaw-channel/src/inbound.js";
import { ReplyStream } from "../packages/openclaw-channel/src/stream.js";
import { AccountBridge } from "../packages/openclaw-channel/src/bridge.js";
import { nekordPlugin } from "../packages/openclaw-channel/src/channel.js";
import {
  parseOutboundTarget,
  resolveWritableChannel,
  sendRest,
} from "../packages/openclaw-channel/src/outbound.js";
import { dispatchHostTurn } from "../packages/openclaw-channel/src/host.js";
import {
  resolveAccount,
  type ChannelRuntime,
} from "../packages/openclaw-channel/src/config.js";
import type { PluginIdentity } from "../packages/openclaw-channel/src/identity.js";
import { fixedReply } from "../scripts/fixed-bot/copy.js";
import { application, channel, message, scheduler, token } from "./helpers.js";

const voiceChannel: Channel = {
  id: "voice1",
  guildId: "guild1",
  name: "voice-lobby",
  type: "VOICE",
  position: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
  vi.restoreAllMocks();
});

test("bot-sdk accepts VOICE channels in config while suppressing VOICE message dispatch", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      application,
      channels: [channel, voiceChannel],
      commands: [],
    }),
  );
  const client = new NekordBotClient({
    serverUrl: "https://server.example",
    token,
    fetch: transport,
  });
  cleanup.push(() => client.close());
  const config = await client.getConfig();
  expect(config.channels.map((item) => item.type)).toEqual(["TEXT", "VOICE"]);
  expect(
    new RegExp(`^${CHANNEL_MENTION_TOKEN_REGEX_SOURCE}$`).test("<#voice1>"),
  ).toBe(true);
});

test("inbound channel mention formatting does not trigger bots alone and expands message + history", async () => {
  expect(
    shouldTrigger(
      message(),
      "check <#channel1>",
      application,
      resolveAccount({
        channels: {
          nekord: { serverUrl: "http://127.0.0.1:3101", botToken: token },
        },
      }),
    ),
  ).toBe(false);
  const channels = [channel, voiceChannel];
  expect(
    formatInboundTextForAgent("join <#voice1> or <#channel1>", channels),
  ).toBe("join #voice-lobby (<#voice1>) or #test (<#channel1>)");

  const client = new NekordBotClient({
    serverUrl: "https://server.example",
    token,
  });
  cleanup.push(() => client.close());
  vi.spyOn(client, "getMessages").mockResolvedValue([
    { ...message("m1"), sequence: 1 },
  ]);
  const identity = {
    decryptMessage: vi.fn().mockResolvedValue({ text: "see <#voice1>" }),
  } as unknown as PluginIdentity;
  const history = await readHistory(
    client,
    identity,
    { ...application, defaultContextLimit: 5 },
    channel,
    2,
    undefined,
    channels,
  );
  expect(history[0]?.text).toBe("see #voice-lobby (<#voice1>)");
  expect(guildChannelsSummary(channels)).toEqual([
    { id: "channel1", name: "test", type: "TEXT", mention: "<#channel1>" },
    { id: "voice1", name: "voice-lobby", type: "VOICE", mention: "<#voice1>" },
  ]);
});

test("ReplyStream converts unambiguous #channel names to <#id> tokens and preserves code/ambiguity", async () => {
  const scope = scheduler();
  cleanup.push(() => scope.stop());
  const client = new NekordBotClient({
    serverUrl: "http://127.0.0.1:3101",
    token,
  });
  cleanup.push(() => client.close());
  const sent = {
    ...message(),
    authorId: "bot1",
    author: { id: "bot1", username: "Bot" },
    revision: 0,
  };
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(sent);
  const dupA: Channel = { ...channel, id: "dup1", name: "shared", position: 2 };
  const dupB: Channel = { ...channel, id: "dup2", name: "shared", position: 3 };
  const channels = [channel, voiceChannel, dupA, dupB];
  const stream = new ReplyStream({
    client,
    identity: { identity: { userId: "bot1" } } as PluginIdentity,
    channel,
    channels,
    scheduler: scope,
    signal: scope.signal,
    intervalMs: 500,
    assertCurrent() {},
  });
  cleanup.push(() => stream.close());

  await stream.finish(
    "Visit #test or #voice-lobby, keep `#test` and ambiguous #shared raw.",
  );
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]?.[1].content).toBe(
    "Visit <#channel1> or <#voice1>, keep `#test` and ambiguous #shared raw.",
  );
});

test("outbound target resolution accepts <#id> and #channel names and rejects VOICE targets", () => {
  const channels = [channel, voiceChannel];
  expect(parseOutboundTarget("<#channel1>")).toEqual({
    kind: "channel",
    id: "channel1",
  });
  expect(parseOutboundTarget("nekord:#test")).toEqual({
    kind: "channel-query",
    query: "#test",
  });
  expect(nekordPlugin.messaging?.targetResolver?.looksLikeId?.("#test")).toBe(
    true,
  );
  expect(nekordPlugin.messaging?.normalizeTarget?.("<#channel1>")).toBe(
    "channel:channel1",
  );
  expect(nekordPlugin.messaging?.normalizeTarget?.("#test")).toBe("#test");

  expect(
    resolveWritableChannel(
      channels,
      parseOutboundTarget("#test") as Exclude<
        ReturnType<typeof parseOutboundTarget>,
        { kind: "user" }
      >,
    ).id,
  ).toBe("channel1");
  expect(() =>
    resolveWritableChannel(
      channels,
      parseOutboundTarget("#voice-lobby") as Exclude<
        ReturnType<typeof parseOutboundTarget>,
        { kind: "user" }
      >,
    ),
  ).toThrow();
});

test("dispatchHostTurn includes guild channel directory in ChannelStructuredContext", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nekord-host-ch-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const scope = scheduler();
  cleanup.push(() => scope.stop());
  const dispatch = vi.fn().mockResolvedValue({ queuedFinal: false });
  const runtime = {
    routing: {
      resolveAgentRoute: () => ({ agentId: "main" }),
      buildAgentSessionKey: () => "session1",
    },
    inbound: { dispatch },
  } as unknown as ChannelRuntime;
  const client = new NekordBotClient({
    serverUrl: "https://server.example",
    token,
  });
  cleanup.push(() => client.close());
  const bridge = new AccountBridge({
    client,
    account: resolveAccount({
      channels: {
        nekord: { serverUrl: "https://server.example", botToken: token },
      },
    }),
    cfg: {},
    commands: { listNativeCandidates: () => [], retainNativeCatalog() {} },
    stateRoot: root,
    scheduler: scope,
    signal: scope.signal,
    dispatch: async () => {},
  });
  await dispatchHostTurn(
    runtime,
    {},
    {
      channel,
      channels: [channel, voiceChannel],
      senderId: "user1",
      senderName: "Alice",
      senderIsBot: false,
      messageId: "m1",
      timestamp: Date.now(),
      rawText: "go <#voice1>",
      text: "go #voice-lobby (<#voice1>)",
      history: [],
      signal: scope.signal,
      scheduler: scope,
      assertCurrent() {},
      stream: () =>
        new ReplyStream({
          client,
          identity: { identity: { userId: "bot1" } } as PluginIdentity,
          channel,
          channels: [channel, voiceChannel],
          scheduler: scope,
          signal: scope.signal,
          intervalMs: 500,
          assertCurrent() {},
        }),
    },
    bridge,
  );
  const ctxPayload = dispatch.mock.calls[0]?.[0]?.ctxPayload as Record<
    string,
    unknown
  >;
  expect(ctxPayload.RawBody).toBe("go <#voice1>");
  expect(ctxPayload.BodyForAgent).toBe("go #voice-lobby (<#voice1>)");
  expect(ctxPayload.ChannelStructuredContext).toEqual([
    {
      label: "available_channels",
      source: "nekord",
      type: "channel_directory",
      payload: [
        { id: "channel1", name: "test", type: "TEXT", mention: "<#channel1>" },
        {
          id: "voice1",
          name: "voice-lobby",
          type: "VOICE",
          mention: "<#voice1>",
        },
      ],
    },
  ]);
});

test("fixedReply formats validated channel mention tokens without echoing arbitrary text", () => {
  expect(
    fixedReply("zh-CN", undefined, 0, formatChannelMention("voice1")),
  ).toBe("已识别频道引用：<#voice1>");
  expect(
    fixedReply("en-US", undefined, 0, formatChannelMention("channel1")),
  ).toBe("Referenced channel: <#channel1>");
  expect(replaceChannelNamesWithTokens("see #test", [channel])).toBe(
    "see <#channel1>",
  );
});

test("sendRest transforms #channel names when sending via REST fallback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nekord-rest-ch-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_PORT");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sentBodies: string[] = [];
  let registeredDevice: BotConfigUpdatePayload["application"]["device"] = null;
  server.on("request", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url === "/api/bots/@me/config" && req.method === "GET") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            application: { ...application, device: registeredDevice },
            channels: [channel, voiceChannel],
            commands: [],
          }),
        );
        return;
      }
      if (url === "/api/bots/@me/device" && req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        registeredDevice = { ...body, userId: application.userId };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(registeredDevice));
        return;
      }
      if (
        url === `/api/channels/${channel.id}/messages` &&
        req.method === "POST"
      ) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sentBodies.push(body.content);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ...message("rest1", body.content),
            authorId: application.userId,
            author: { id: application.userId, username: "Bot", isBot: true },
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  try {
    const result = await sendRest(
      {
        cfg: {
          channels: {
            nekord: { serverUrl: baseUrl, botToken: token },
          },
        },
        to: "#test",
        text: "go #voice-lobby",
        accountId: "default",
      } as Parameters<typeof sendRest>[0],
      root,
    );
    expect(result.messageId).toBe("rest1");
    expect(sentBodies).toEqual(["go <#voice1>"]);
  } finally {
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  }
});
