import { expect, test, vi } from "vitest";
import type { Attachment } from "@tescord/types";
import { NekordBotClient } from "@nekord/bot-sdk";
import { readReplyImages } from "../packages/openclaw-channel/src/inbound.js";
import type { PluginIdentity } from "../packages/openclaw-channel/src/identity.js";
import { channel, message, token } from "./helpers.js";

const base = "https://chat.example.invalid";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const file = (id: string, data: Partial<Attachment> = {}): Attachment => ({
  id,
  url: "https://untrusted.invalid/object",
  fileName: `${id}.png`,
  mimeType: "image/png",
  fileSize: png.length,
  ...data,
});

test("image context preserves priorities, source IDs and limits across denied and malformed downloads", async () => {
  const grants: string[] = [];
  const download = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/attachments/access") {
      const {
        attachmentIds: [id],
      } = JSON.parse(String(init?.body));
      grants.push(id);
      return Response.json({
        attachments: [
          {
            id,
            downloadUrl: `${base}/attachments/${id}?channelId=${channel.id}`,
          },
        ],
      });
    }
    expect(init?.headers).toBeUndefined();
    expect(init?.redirect).toBe("error");
    const id = url.pathname.split("/").at(-1);
    if (id === "expired") return new Response(null, { status: 403 });
    const bytes =
      id === "bad" ? new Uint8Array(png.length) : new Uint8Array(png);
    return new Response(bytes, { headers: { "content-type": "image/png" } });
  });
  const client = new NekordBotClient({
    serverUrl: base,
    token,
    fetch: download,
  });
  const reply = { ...message("quoted"), attachments: [file("quote")] };
  const current = {
    ...message("current"),
    replyToId: reply.id,
    attachments: [
      file("current"),
      file("expired"),
      file("bad"),
      file("large", { fileSize: 10 * 1024 * 1024 + 1 }),
      file("svg", { mimeType: "image/svg+xml" }),
    ],
  };
  const context = await client.getImageContext({
    channelId: channel.id,
    current,
    reply,
    history: [
      {
        ...message("old"),
        sequence: 1,
        attachments: [file("old"), file("overflow")],
      },
      { ...reply, sequence: 2 },
      { ...message("recent"), sequence: 3, attachments: [file("recent")] },
    ],
  });
  expect(
    context.map(({ source, messageId, attachmentId }) => [
      source,
      messageId,
      attachmentId,
    ]),
  ).toEqual([
    ["current", "current", "current"],
    ["reply", "quoted", "quote"],
    ["history", "recent", "recent"],
    ["history", "old", "old"],
  ]);
  expect(grants).toEqual([
    "current",
    "expired",
    "bad",
    "quote",
    "recent",
    "old",
  ]);
  expect(context.every((image) => Buffer.from(image.bytes).equals(png))).toBe(
    true,
  );
  await expect(
    client.getImageContext({
      channelId: channel.id,
      current,
      history: [{ ...reply, channelId: "other-channel" }],
    }),
  ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  client.close();
});

test("a quoted image is read by exact ID even when history is disabled", async () => {
  const client = new NekordBotClient({ serverUrl: base, token });
  const reply = {
    ...message("quoted"),
    sequence: 7,
    attachments: [file("quote")],
  };
  const current = { ...message("current"), replyToId: reply.id, sequence: 40 };
  const getMessage = vi.spyOn(client, "getMessage").mockResolvedValue(reply);
  const decryptMessage = vi.fn().mockResolvedValue({ text: "quoted" });
  const identity = { decryptMessage } as unknown as PluginIdentity;
  const signal = new AbortController().signal;
  expect(
    await readReplyImages(client, identity, channel, current, [], signal),
  ).toMatchObject({ id: reply.id, attachments: reply.attachments });
  expect(getMessage).toHaveBeenCalledExactlyOnceWith(
    channel.id,
    reply.id,
    signal,
  );
  expect(decryptMessage).toHaveBeenCalledExactlyOnceWith(reply, signal);
  client.close();
});

test("invocation send uses a dedicated endpoint and retries with one nonce", async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const client = new NekordBotClient({
    serverUrl: base,
    token,
    fetch: async (url, init) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: JSON.parse(String(init?.body)),
      });
      if (requests.length === 1) return new Response(null, { status: 503 });
      return Response.json({ ...message("relayed"), channelId: "target" });
    },
  });
  const source = {
    kind: "message",
    id: "source",
    channelId: channel.id,
  } as const;
  await expect(
    client.sendMessageFromInvocation("target", {
      source,
      content: "publish",
      isEncrypted: false,
    }),
  ).resolves.toMatchObject({ id: "relayed", channelId: "target" });
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toMatchObject({
    path: "/api/bots/@me/channels/target/messages",
    body: { source, nonce: expect.any(String) },
  });
  client.close();
});
