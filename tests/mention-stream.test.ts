import { test, expect, vi } from "vitest";
import {
  BotRestClient,
  NekordBotClient,
} from "../packages/bot-sdk/src/index.js";
import { ReplyStream } from "../packages/openclaw-channel/src/stream.js";
import type { PluginIdentity } from "../packages/openclaw-channel/src/identity.js";
import { sessionRoute } from "../packages/openclaw-channel/src/host.js";
import type { ChannelRuntime } from "../packages/openclaw-channel/src/config.js";
import { channel, message, scheduler, token } from "./helpers.js";

test("text blocks and final flush edit the original reply without a duplicate send", async () => {
  const scope = scheduler();
  const client = new NekordBotClient({
    serverUrl: "http://127.0.0.1:3101",
    token,
  });
  const sent = {
    ...message(),
    authorId: "bot1",
    author: { id: "bot1", username: "Bot" },
    revision: 0,
  };
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(sent);
  let revision = 0;
  const edit = vi
    .spyOn(client, "editMessage")
    .mockImplementation(async (_channelId, _id, body) => {
      expect(body.expectedRevision).toBe(revision);
      return { id: sent.id, channelId: channel.id, revision: ++revision };
    });
  const stream = new ReplyStream({
    client,
    identity: { identity: { userId: "bot1" } } as PluginIdentity,
    channel,
    scheduler: scope,
    signal: scope.signal,
    intervalMs: 500,
    assertCurrent() {},
  });
  try {
    await stream.publishText("first block");
    stream.update("first block\n\nsecond block preview");
    await stream.publishText("first block\n\nsecond block");
    await stream.finish();
    expect(send).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]?.[2].content).toBe("first block\n\nsecond block");
    expect(stream.messageIds).toEqual([sent.id]);
  } finally {
    await stream.close();
    client.close();
    await scope.stop();
  }
});

test("stopTyping uses authenticated DELETE with no caller-selected identity", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  const client = new BotRestClient({
    serverUrl: "https://nekord.example",
    token,
    fetch: transport,
  });
  try {
    await client.stopTyping("channel1");
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0]?.[0]).toEqual(
      new URL("https://nekord.example/api/channels/channel1/typing"),
    );
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: `Bot ${token}` },
    });
    expect(transport.mock.calls[0]?.[1]?.body).toBeUndefined();
  } finally {
    client.dispose();
  }
});

test("public channel sessions continue across senders and isolate channels and accounts", () => {
  const runtime = {
    routing: {
      resolveAgentRoute: () => ({ agentId: "main" }),
      buildAgentSessionKey: (value: {
        accountId: string;
        peer: { id: string };
      }) => `${value.accountId}:${value.peer.id}`,
    },
  } as unknown as ChannelRuntime;
  const a = sessionRoute(runtime, {}, "account1", {
    channel,
    senderId: "user1",
  });
  const b = sessionRoute(runtime, {}, "account1", {
    channel,
    senderId: "user2",
  });
  const c = sessionRoute(runtime, {}, "account1", {
    channel: { ...channel, id: "other" },
    senderId: "user1",
  });
  const d = sessionRoute(runtime, {}, "account2", {
    channel,
    senderId: "user1",
  });
  expect(a.sessionKey).toBe(b.sessionKey);
  expect(new Set([a.sessionKey, c.sessionKey, d.sessionKey]).size).toBe(3);
});
