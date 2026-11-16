import { test, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  encryptSecureMessage,
  messageDeviceFingerprint,
  type MessageDeviceIdentity,
} from "@tescord/types";
import { NekordBotClient } from "../packages/bot-sdk/src/index.js";
import { PluginIdentity } from "../packages/openclaw-channel/src/identity.js";
import { accountDirectory } from "../packages/openclaw-channel/src/state.js";
import { NativeCommandCatalog } from "../packages/openclaw-channel/src/commands.js";
import { resolveAccount } from "../packages/openclaw-channel/src/config.js";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { application, channel, message, token } from "./helpers.js";

test("local device decrypts and verifies messages, rejects forged edits and private recipient expansion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nekord-crypto-"));
  const client = new NekordBotClient({
    serverUrl: "http://127.0.0.1:3101",
    token,
  });
  let bot: PluginIdentity | undefined;
  try {
    const directory = await accountDirectory(root, "default");
    bot = await PluginIdentity.load(directory, application, client);
    const signing = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const agreement = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const signingPublicKey = JSON.stringify(
      await crypto.subtle.exportKey("jwk", signing.publicKey),
    );
    const agreementPublicKey = JSON.stringify(
      await crypto.subtle.exportKey("jwk", agreement.publicKey),
    );
    const user: MessageDeviceIdentity = {
      userId: "user1",
      deviceId: "user-device",
      signingPublicKey,
      agreementPublicKey,
      fingerprint: await messageDeviceFingerprint(
        signingPublicKey,
        agreementPublicKey,
      ),
    };
    const devices = [bot.identity, user];
    vi.spyOn(client, "getDevices").mockResolvedValue(devices);
    const initial = await encryptSecureMessage(
      channel.id,
      "hello",
      user,
      signing.privateKey,
      devices,
    );
    const input = {
      ...message(),
      isEncrypted: true,
      content: JSON.stringify(initial),
    };
    expect((await bot.decryptMessage(input)).text).toBe("hello");
    await expect(
      bot.decryptMessage({ ...input, revision: 1 }),
    ).rejects.toMatchObject({ code: "MESSAGE_CONTEXT_INVALID" });
    const edit = await encryptSecureMessage(
      channel.id,
      "edited",
      user,
      signing.privateKey,
      devices,
      { purpose: "edit", messageId: input.id, revision: 1 },
    );
    expect(
      (
        await bot.decryptMessage({
          ...input,
          revision: 1,
          content: JSON.stringify(edit),
        })
      ).text,
    ).toBe("edited");
    await expect(
      bot.decryptMessage({
        ...input,
        revision: 1,
        content: JSON.stringify({
          ...edit,
          signature: Buffer.alloc(64).toString("base64"),
        }),
      }),
    ).rejects.toThrow();
    const privateEnvelope = JSON.parse(
      await bot.encrypt(
        channel.id,
        "private",
        {
          purpose: "ephemeral",
          interactionId: "i1",
          commandId: "c1",
          botId: "bot1",
          callerId: "user1",
          revision: 1,
          ephemeral: true,
        },
        ["bot1", "user1"],
      ),
    );
    expect(
      privateEnvelope.recipients
        .map((entry: { userId: string }) => entry.userId)
        .sort(),
    ).toEqual(["bot1", "user1"]);
    const interactionContext = {
      purpose: "interaction" as const,
      interactionId: "i1",
      commandId: "c1",
      botId: "bot1",
      callerId: "user1",
      revision: 0 as const,
      ephemeral: true,
    };
    const interactionEnvelope = await encryptSecureMessage(
      channel.id,
      JSON.stringify({ text: "private-argument" }),
      user,
      signing.privateKey,
      devices,
      interactionContext,
    );
    const interaction = {
      id: "i1",
      command: { id: "c1" },
      channelId: channel.id,
      callerId: "user1",
      ephemeral: true,
      isEncrypted: true,
      content: JSON.stringify(interactionEnvelope),
    };
    expect(await bot.decryptInteraction(interaction as never)).toEqual({
      text: "private-argument",
    });
    const expanded = await encryptSecureMessage(
      channel.id,
      "{}",
      user,
      signing.privateKey,
      [
        ...devices,
        { ...user, userId: "outsider", deviceId: "outsider-device" },
      ],
      interactionContext,
    );
    await expect(
      bot.decryptInteraction({
        ...interaction,
        content: JSON.stringify(expanded),
      } as never),
    ).rejects.toMatchObject({ code: "INTERACTION_CONTEXT_INVALID" });
    vi.mocked(client.getDevices).mockResolvedValue([user]);
    await expect(bot.encrypt(channel.id, "revoked")).rejects.toMatchObject({
      code: "BOT_DEVICE_REVOKED",
    });
  } finally {
    client.close();
    await bot?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("native command registry provides five locales and preserves stable registered ownership", async () => {
  const account = resolveAccount({
    channels: {
      nekord: { serverUrl: "http://127.0.0.1:3101", botToken: token },
    },
  });
  const catalog = new NativeCommandCatalog({}, account, {
    listNativeCandidates: () => [],
    retainNativeCatalog() {},
  });
  expect(catalog.definitions.some((item) => item.name === "whoami")).toBe(true);
  expect(
    catalog.definitions.every(
      (item) =>
        item.ephemeral &&
        Object.keys(item.nameLocalizations).length === 5 &&
        Object.keys(item.descriptionLocalizations).length === 5,
    ),
  ).toBe(true);
  const client = new NekordBotClient({ serverUrl: account.serverUrl, token });
  const commands = catalog.definitions.map((definition, index) => ({
    ...definition,
    id: `c${index}`,
    applicationId: application.id,
    botUserId: application.userId,
    botName: "Bot",
  }));
  vi.spyOn(client, "registerCommands").mockResolvedValue(commands);
  try {
    await catalog.register(client);
    const who = commands.find((item) => item.name === "whoami")!;
    expect(catalog.prepare(who, {}).body).toMatch(/^\/(?:whoami|id)/);
    expect(() =>
      catalog.prepare({ ...who, id: "other-bot-command" }, {}),
    ).toThrow();
  } finally {
    client.close();
  }
});
test("an open channel allowlist does not grant OpenClaw owner authority", () => {
  const cfg = {
    channels: { nekord: { allowFrom: ["*"] } },
    commands: { ownerAllowFrom: ["nekord:owner1"] },
  };
  const regular = resolveCommandAuthorization({
    cfg,
    ctx: {
      Provider: "nekord",
      Surface: "nekord",
      SenderId: "user1",
      From: "nekord:user1",
      To: "channel:channel1",
      CommandAuthorized: true,
    },
    commandAuthorized: true,
  });
  expect(regular.senderIsOwner).toBe(false);
});
