import { test, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NekordBotClient,
  BotClientError,
} from "../packages/bot-sdk/src/index.js";
import {
  readHistory,
  shouldTrigger,
} from "../packages/openclaw-channel/src/inbound.js";
import { resolveAccount } from "../packages/openclaw-channel/src/config.js";
import {
  ReplyStream,
  splitMessage,
} from "../packages/openclaw-channel/src/stream.js";
import { DeliveryLedger } from "../packages/openclaw-channel/src/ledger.js";
import { PluginIdentity } from "../packages/openclaw-channel/src/identity.js";
import { accountDirectory } from "../packages/openclaw-channel/src/state.js";
import { sessionRoute } from "../packages/openclaw-channel/src/host.js";
import { commandLocales } from "../packages/openclaw-channel/src/localization.js";
import type { ChannelRuntime } from "../packages/openclaw-channel/src/config.js";
import { application, channel, message, scheduler, token } from "./helpers.js";
const account = resolveAccount({
  channels: { nekord: { serverUrl: "http://127.0.0.1:3101", botToken: token } },
});
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
  vi.restoreAllMocks();
});
test("triggers mentions/replies/respondToAll and excludes self, other bots and denied senders", () => {
  expect(shouldTrigger(message(), "ordinary", application, account)).toBe(
    false,
  );
  for (const body of ["<@bot1> hi", "<@!bot1> hi"])
    expect(shouldTrigger(message(), body, application, account)).toBe(true);
  expect(
    shouldTrigger(
      {
        ...message(),
        replyTo: {
          id: "m0",
          authorId: "bot1",
          authorName: "Bot",
          content: "prior",
        },
      },
      "hi",
      application,
      account,
    ),
  ).toBe(true);
  expect(
    shouldTrigger(
      message(),
      "hi",
      {
        ...application,
        channelSettings: [
          { channelId: channel.id, respondToAll: true, contextLimit: null },
        ],
      },
      account,
    ),
  ).toBe(true);
  for (const candidate of [
    { ...message(), authorId: "bot1" },
    { ...message(), author: { ...message().author, isBot: true } },
  ])
    expect(shouldTrigger(candidate, "<@bot1>", application, account)).toBe(
      false,
    );
  expect(
    shouldTrigger(message(), "<@bot1>", application, {
      ...account,
      allowFrom: [],
    }),
  ).toBe(false);
});
test("context takes exactly N before sequence and skips failures without backfill; zero makes no request", async () => {
  const client = new NekordBotClient({ serverUrl: account.serverUrl, token });
  cleanup.push(() => client.close());
  const get = vi.spyOn(client, "getMessages").mockResolvedValue([
    { ...message("2"), sequence: 2 },
    { ...message("1"), sequence: 1 },
  ]);
  const identity = {
    decryptMessage: vi
      .fn()
      .mockRejectedValueOnce(new Error("CANNOT_DECRYPT"))
      .mockResolvedValueOnce({ text: "decoded" }),
  } as unknown as PluginIdentity;
  const app = { ...application, defaultContextLimit: 2 };
  const result = await readHistory(client, identity, app, channel, 3);
  expect(get).toHaveBeenCalledExactlyOnceWith(
    channel.id,
    { before: 3, limit: 2 },
    undefined,
  );
  expect(result.map((entry) => entry.id)).toEqual(["2"]);
  get.mockClear();
  expect(
    await readHistory(
      client,
      identity,
      {
        ...app,
        channelSettings: [
          { channelId: channel.id, respondToAll: false, contextLimit: 0 },
        ],
      },
      channel,
      3,
    ),
  ).toEqual([]);
  expect(get).not.toHaveBeenCalled();
});
test("identity survives reload, detects private key corruption and ledger persists only event IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nekord-identity-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const directory = await accountDirectory(root, "default");
  const client = new NekordBotClient({ serverUrl: account.serverUrl, token });
  cleanup.push(() => client.close());
  const first = await PluginIdentity.load(directory, application, client);
  const second = await PluginIdentity.load(directory, application, client);
  expect(first.identity).toEqual(second.identity);
  const ledger = await DeliveryLedger.load(directory, application.id);
  expect(await ledger.admit("message:one")).toBe(true);
  expect(await ledger.admit("message:one")).toBe(false);
  await ledger.close();
  const reloaded = await DeliveryLedger.load(directory, application.id);
  expect(await reloaded.admit("message:one")).toBe(false);
  await reloaded.close();
  const file = path.join(directory, "device.json");
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  value.signingPrivateJwk.x = "corrupted";
  await fs.writeFile(file, JSON.stringify(value));
  await expect(
    PluginIdentity.load(directory, application, client),
  ).rejects.toMatchObject({ code: "DEVICE_STATE_INVALID" });
  await first.close();
  await second.close();
});
test("stream coalesces partials, waits >=500 ms between edits, retries only 429 and flushes final", async () => {
  const scope = scheduler();
  cleanup.push(() => scope.stop());
  const client = new NekordBotClient({ serverUrl: account.serverUrl, token });
  cleanup.push(() => client.close());
  const sent = {
    ...message(),
    authorId: "bot1",
    author: { id: "bot1", username: "Bot" },
    revision: 0,
  };
  const send = vi.spyOn(client, "sendMessage").mockResolvedValue(sent);
  const edit = vi
    .spyOn(client, "editMessage")
    .mockRejectedValueOnce(new BotClientError("RATE_LIMITED" as never, 429, 1))
    .mockResolvedValue({ id: sent.id, channelId: channel.id, revision: 1 });
  const stream = new ReplyStream({
    client,
    identity: { identity: { userId: "bot1" } } as PluginIdentity,
    channel,
    scheduler: scope,
    signal: scope.signal,
    intervalMs: 500,
    assertCurrent() {},
  });
  cleanup.push(() => stream.close());
  stream.update("one");
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  stream.update("intermediate");
  stream.update("latest");
  const started = Date.now();
  await stream.finish("final");
  expect(Date.now() - started).toBeGreaterThanOrEqual(450);
  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.calls.at(-1)![2]).toMatchObject({
    content: "final",
    expectedRevision: 0,
  });
});
test("private streams keep only Bot/caller recipients and increasing authenticated revision", async () => {
  const scope = scheduler();
  cleanup.push(() => scope.stop());
  const client = new NekordBotClient({ serverUrl: account.serverUrl, token });
  cleanup.push(() => client.close());
  const respond = vi
    .spyOn(client, "respondInteraction")
    .mockResolvedValueOnce({
      kind: "ephemeral",
      interactionId: "i1",
      revision: 1,
    })
    .mockResolvedValueOnce({
      kind: "ephemeral",
      interactionId: "i1",
      revision: 2,
    });
  const encrypt = vi.fn().mockResolvedValue("ciphertext");
  const identity = {
    identity: { userId: "bot1" },
    encrypt,
  } as unknown as PluginIdentity;
  const interaction = {
    id: "i1",
    callerId: "user1",
    command: { id: "cmd1" },
    ephemeral: true,
  } as never;
  const stream = new ReplyStream({
    client,
    identity,
    channel: { ...channel, isE2EE: true },
    interaction,
    scheduler: scope,
    signal: scope.signal,
    intervalMs: 500,
    assertCurrent() {},
  });
  cleanup.push(() => stream.close());
  await stream.finish("one");
  await stream.finish("two");
  expect(encrypt.mock.calls[0]![2]).toMatchObject({
    purpose: "ephemeral",
    revision: 1,
  });
  expect(encrypt.mock.calls[1]![2]).toMatchObject({ revision: 2 });
  expect(encrypt.mock.calls[1]![3]).toEqual(["bot1", "user1"]);
  expect(respond.mock.calls.every((call) => call[2] === true)).toBe(true);
});
test("cancellation fences final writes and large UTF-16 replies preserve surrogate pairs", async () => {
  const scope = scheduler();
  cleanup.push(() => scope.stop());
  const client = new NekordBotClient({ serverUrl: account.serverUrl, token });
  cleanup.push(() => client.close());
  const send = vi.spyOn(client, "sendMessage");
  const abort = new AbortController();
  abort.abort();
  const stream = new ReplyStream({
    client,
    identity: {} as PluginIdentity,
    channel,
    scheduler: scope,
    signal: abort.signal,
    intervalMs: 500,
    assertCurrent() {},
  });
  await expect(stream.finish("x")).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
  const text = "a".repeat(3999) + "😀" + "b".repeat(4000);
  const split = splitMessage(text);
  expect(split.join("")).toBe(text);
  expect(() => splitMessage("😀", 1)).toThrow();
  expect(() => splitMessage("text", 0)).toThrow();
  expect(
    split.every(
      (part) => part.length <= 4000 && !/[\uD800-\uDBFF]$/.test(part),
    ),
  ).toBe(true);
});
test("private interactions, DMs and accounts use distinct session keys; locale keys align", () => {
  const routing = {
    resolveAgentRoute: () => ({ agentId: "main" }),
    buildAgentSessionKey: (value: {
      accountId: string;
      peer: { id: string };
    }) => `${value.accountId}:${value.peer.id}`,
  };
  const runtime = { routing } as unknown as ChannelRuntime;
  const a = sessionRoute(runtime, {}, "a", {
    channel,
    senderId: "one",
    interaction: {} as never,
  });
  const b = sessionRoute(runtime, {}, "a", {
    channel,
    senderId: "two",
    interaction: {} as never,
  });
  const c = sessionRoute(runtime, {}, "b", {
    channel,
    senderId: "one",
    interaction: {} as never,
  });
  expect(
    new Set([a.sessionKey, b.sessionKey, c.sessionKey, a.targetSessionKey])
      .size,
  ).toBe(4);
  for (const dictionary of Object.values(commandLocales)) {
    expect(Object.keys(dictionary)).toEqual(
      Object.keys(commandLocales["zh-CN"]),
    );
    expect(Object.keys(dictionary.commands)).toEqual(
      Object.keys(commandLocales["zh-CN"].commands),
    );
  }
});
