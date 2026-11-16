import { expect, test, vi, afterEach } from "vitest";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  BotRestClient,
  BotGateway,
  BotClientError,
  normalizeServerUrl,
} from "../packages/bot-sdk/src/index.js";
import { token, application, channel, message } from "./helpers.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()));
});
test("requires TLS except loopback and rejects URL credentials, paths, queries", () => {
  for (const url of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com/api",
    "https://example.com/?token=x",
    "file:///tmp/test",
  ])
    expect(() => normalizeServerUrl(url)).toThrow();
  expect(normalizeServerUrl("http://127.0.0.1:3101").protocol).toBe("http:");
  expect(normalizeServerUrl("https://lan.example").protocol).toBe("https:");
});
test("REST sends Bot auth, validates scope and never exposes token in errors", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ application, channels: [channel], commands: [] }),
    )
    .mockResolvedValueOnce(
      Response.json({ code: "UNAUTHORIZED", error: token }, { status: 401 }),
    );
  const client = new BotRestClient({
    serverUrl: "https://server.example",
    token,
    fetch: transport,
  });
  cleanup.push(() => client.dispose());
  expect((await client.getConfig()).application.id).toBe("app1");
  expect(transport.mock.calls[0]![1]!.headers).toEqual({
    Authorization: `Bot ${token}`,
  });
  try {
    await client.getConfig();
    expect.unreachable();
  } catch (error) {
    expect(String(error)).toContain("UNAUTHORIZED");
    expect(String(error)).not.toContain(token);
  }
  expect(() => JSON.stringify(client)).not.toThrow();
  expect(JSON.stringify(client)).not.toContain(token);
});
test("rejects cross guild config, malformed messages, response size and attachment redirects", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        application,
        channels: [{ ...channel, guildId: "other" }],
        commands: [],
      }),
    )
    .mockResolvedValueOnce(
      Response.json([{ ...message(), authorId: "forged" }]),
    )
    .mockResolvedValueOnce(Response.json({ padding: "x".repeat(500) }));
  const client = new BotRestClient({
    serverUrl: "https://server.example",
    token,
    fetch: transport,
    maxResponseBytes: 1000,
  });
  cleanup.push(() => client.dispose());
  await expect(client.getConfig()).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
  });
  await expect(client.getMessages(channel.id)).rejects.toMatchObject({
    code: "PROTOCOL_ERROR",
  });
  const small = new BotRestClient({
    serverUrl: "https://server.example",
    token,
    fetch: transport,
    maxResponseBytes: 64,
  });
  cleanup.push(() => small.dispose());
  await expect(small.getConfig()).rejects.toMatchObject({
    code: "RESPONSE_TOO_LARGE",
  });
});
test("message retries reuse nonce; edits and interaction writes never retry ambiguous failures", async () => {
  const sent = {
    ...message(),
    authorId: "bot1",
    author: { id: "bot1", username: "Bot", isBot: true },
  };
  const transport = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error(token))
    .mockResolvedValueOnce(Response.json(sent))
    .mockRejectedValueOnce(new Error(token))
    .mockRejectedValueOnce(new Error(token));
  const client = new BotRestClient({
    serverUrl: "https://server.example",
    token,
    fetch: transport,
    maxRetries: 1,
  });
  cleanup.push(() => client.dispose());
  await client.sendMessage(channel.id, { content: "test", isEncrypted: false });
  expect(JSON.parse(String(transport.mock.calls[0]![1]!.body)).nonce).toBe(
    JSON.parse(String(transport.mock.calls[1]![1]!.body)).nonce,
  );
  await expect(
    client.editMessage(channel.id, "m1", {
      content: "edit",
      isEncrypted: false,
      expectedRevision: 0,
    }),
  ).rejects.toBeInstanceOf(BotClientError);
  await expect(
    client.respondInteraction("i1", {
      type: "message",
      content: "private",
      isEncrypted: false,
    }),
  ).rejects.toMatchObject({ code: "TRANSPORT_ERROR" });
  expect(transport).toHaveBeenCalledTimes(4);
});
test("attachment upload grants cannot send the Bot credential to another origin", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      uploadUrl: "https://attacker.example/api/attachments/upload/x",
      fileUrl: "/attachments/x",
      requiresAuth: true,
    }),
  );
  const client = new BotRestClient({
    serverUrl: "https://server.example",
    token,
    fetch: transport,
  });
  cleanup.push(() => client.dispose());
  await expect(
    client.uploadAttachment(channel.id, {
      fileName: "x.txt",
      mimeType: "text/plain",
      bytes: new Uint8Array([1]),
    }),
  ).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  expect(transport).toHaveBeenCalledTimes(1);
});
test("Gateway identifies, deduplicates, ignores hidden channels, reconnects and stops on revoked session", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_PORT");
  const gateway = new BotGateway({
    serverUrl: `http://127.0.0.1:${address.port}`,
    token,
    reconnectBaseMs: 5,
    reconnectMaxMs: 10,
  });
  cleanup.push(async () => {
    gateway.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) =>
      sockets.close(() => server.close(() => resolve())),
    );
  });
  let connections = 0;
  const seen: string[] = [];
  const ready = vi.fn();
  const disconnect = vi.fn();
  gateway.on("MESSAGE_CREATE", (value) => {
    seen.push(value.id);
  });
  gateway.on("READY", ready);
  gateway.on("CLIENT_DISCONNECT", disconnect);
  sockets.on("connection", (socket) => {
    connections++;
    socket.send(JSON.stringify({ op: 10, d: { heartbeatInterval: 1000 } }));
    socket.on("message", (raw) => {
      const packet = JSON.parse(raw.toString());
      if (packet.op === 2) {
        expect(packet.d).toEqual({ token, bot: true, deviceId: "device1" });
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            d: {
              sessionId: `session${connections}`,
              application,
              channels: [channel],
              commands: [],
            },
          }),
        );
      }
      if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }));
    });
  });
  await gateway.connect("device1", {
    application,
    channels: [channel],
    commands: [],
  });
  const socket = [...sockets.clients][0]!;
  for (const value of [
    message(),
    message(),
    { ...message("hidden"), channelId: "hidden" },
  ])
    socket.send(JSON.stringify({ op: 0, t: "MESSAGE_CREATE", d: value }));
  await vi.waitFor(() => expect(seen).toEqual(["message1"]));
  socket.close(4000);
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2));
  [...sockets.clients][0]!.close(4001);
  await vi.waitFor(() =>
    expect(disconnect).toHaveBeenLastCalledWith({ code: 4001, fatal: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(connections).toBe(2);
  expect(gateway.connected).toBe(false);
});
