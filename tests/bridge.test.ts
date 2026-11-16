import { test, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { NekordBotClient } from "../packages/bot-sdk/src/index.js";
import {
  AccountBridge,
  type InboundTurn,
} from "../packages/openclaw-channel/src/bridge.js";
import { resolveAccount } from "../packages/openclaw-channel/src/config.js";
import type { BotConfigUpdatePayload } from "@tescord/types";
import { application, channel, message, scheduler, token } from "./helpers.js";

test("bounded account queues abort current and queued turns on permission revocation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nekord-bridge-"));
  const scope = scheduler();
  const stop = new AbortController();
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_PORT");
  const client = new NekordBotClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    token,
  });
  const config: BotConfigUpdatePayload = {
    application: {
      ...application,
      channelSettings: [
        { channelId: channel.id, contextLimit: 0, respondToAll: true },
      ],
    },
    channels: [channel],
    commands: [],
  };
  vi.spyOn(client, "getConfig").mockImplementation(async () =>
    structuredClone(config),
  );
  vi.spyOn(client, "registerDevice").mockImplementation(async (input) => {
    const device = { ...input, userId: application.userId };
    config.application.device = device;
    return device;
  });
  vi.spyOn(client, "registerCommands").mockImplementation(
    async (definitions) => {
      config.commands = definitions.map((definition, index) => ({
        ...definition,
        id: `cmd${index}`,
        applicationId: application.id,
        botUserId: application.userId,
        botName: "Bot",
      }));
      return config.commands;
    },
  );
  vi.spyOn(client, "typing").mockResolvedValue();
  const stopTyping = vi.spyOn(client, "stopTyping").mockResolvedValue();
  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeatInterval: 1000 } }));
    socket.on("message", (data) => {
      const packet = JSON.parse(data.toString());
      if (packet.op === 2)
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            d: { ...config, sessionId: "test-session" },
          }),
        );
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  let aborted = false;
  const dispatch = vi.fn(async (turn: InboundTurn) => {
    await new Promise<void>((resolve) => {
      turn.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      );
    });
  });
  const error = vi.fn();
  const account = resolveAccount({
    channels: {
      nekord: {
        serverUrl: `http://127.0.0.1:${address.port}`,
        botToken: token,
        maxQueue: 2,
      },
    },
  });
  const bridge = new AccountBridge({
    client,
    account,
    cfg: {},
    commands: { listNativeCandidates: () => [], retainNativeCatalog() {} },
    stateRoot: root,
    scheduler: scope,
    signal: stop.signal,
    dispatch,
    error,
  });
  try {
    await bridge.start();
    const socket = [...sockets.clients][0]!;
    const send = (value: unknown) => socket.send(JSON.stringify(value));
    send({ op: 0, t: "MESSAGE_CREATE", d: message("one", "first") });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    await bridge.refreshConfig();
    expect(aborted).toBe(false);
    expect(bridge.pending).toBe(1);
    send({ op: 0, t: "MESSAGE_CREATE", d: message("two", "queued") });
    send({ op: 0, t: "MESSAGE_CREATE", d: message("three", "overflow") });
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith("INBOUND_QUEUE_FULL"),
    );
    expect(bridge.pending).toBe(2);
    send({
      op: 0,
      t: "BOT_CONFIG_UPDATE",
      d: {
        ...config,
        application: { ...config.application, configVersion: 2 },
        channels: [],
      },
    });
    await vi.waitFor(() => expect(bridge.pending).toBe(0));
    expect(aborted).toBe(true);
    expect(stopTyping).toHaveBeenCalledWith(
      channel.id,
      expect.any(AbortSignal),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(() => bridge.assertCurrent(channel.id)).toThrow();
    const ledger = await fs.readFile(
      path.join(root, "nekord/default/processed-events.json"),
      "utf8",
    );
    expect(ledger).toContain("message:one");
    expect(ledger).not.toContain("first");
    expect(ledger).not.toContain("queued");
  } finally {
    await bridge.close();
    await scope.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
    await fs.rm(root, { recursive: true, force: true });
  }
});
