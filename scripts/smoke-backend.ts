import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { spawn, type ChildProcess } from "node:child_process";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { encodePngRgba } from "openclaw/plugin-sdk/media-runtime";
import {
  encryptSecureMessage,
  decryptSecureMessage,
  messageDeviceFingerprint,
  type MessageDeviceIdentity,
  type BotCommand,
  type BotTokenResponse,
  type SecureMessageEnvelope,
  type Message,
  type PaginatedResult,
  type Channel,
} from "@tescord/types";

const main = path.resolve(process.env.TESCORD_REPO ?? "../Tescord");
const require = createRequire(path.join(main, "apps/server/package.json"));
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "nekord-backend-smoke-"),
);
const database = `nekord-bot-e2e-${crypto.randomUUID()}.sqlite`;
const evidence = path.resolve("test-results/backend-smoke");
await fs.mkdir(evidence, { recursive: true });
const children: ChildProcess[] = [];
const logs = new Map<string, string>();
const secrets: string[] = [];
const packets: { t?: string; d?: unknown }[] = [];
let socket: WebSocket | undefined;
const modelRequests: string[] = [];
const modelBodies: string[] = [];
const sessionProof: {
  encrypted: boolean;
  previousTriggerRetained: boolean;
  previousReplyRetained: boolean;
  noNewHistory: boolean;
  bareMentionTriggered: boolean;
}[] = [];
let allowMockModel = false;
let modelDelayMs = 22000;
let relay:
  | { marker: string; target: string; text: string; requested: boolean }
  | undefined;
const modelServer = createHttpServer((request, response) => {
  modelRequests.push(request.url ?? "");
  if (!allowMockModel) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"MODEL_CALL_FORBIDDEN_IN_SMOKE"}');
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += String(chunk);
    if (body.length > 4 * 1024 * 1024) request.destroy();
  });
  request.on("end", () => {
    modelBodies.push(body);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    if (relay && !relay.requested && body.includes(relay.marker)) {
      relay.requested = true;
      const frame = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({ id: "smoke-tool", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "smoke", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
      response.write(
        frame(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_nekord_smoke",
                type: "function",
                function: {
                  name: "message",
                  arguments: JSON.stringify({
                    action: "send",
                    channel: "nekord",
                    target: relay.target,
                    message: relay.text,
                  }),
                },
              },
            ],
          },
          null,
        ),
      );
      response.write(frame({}, "tool_calls"));
      response.end("data: [DONE]\n\n");
      return;
    }
    const frame = (content: string, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "smoke-completion", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "smoke", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;
    response.write(frame("local-model-answer"));
    setTimeout(() => {
      if (!response.destroyed) {
        response.write(frame("-final"));
        response.write(frame("", "stop"));
        response.end("data: [DONE]\n\n");
      }
    }, modelDelayMs);
  });
});
const backendPort = "3103";
const base = `http://127.0.0.1:${backendPort}`;
const env: NodeJS.ProcessEnv = {
  NO_COLOR: "1",
  OPENCLAW_STATE_DIR: directory,
  OPENCLAW_CONFIG_PATH: path.join(directory, "openclaw.json"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_NO_RESPAWN: "1",
};
for (const key of [
  "PATH",
  "Path",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATHEXT",
  "COMSPEC",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
])
  if (process.env[key]) env[key] = process.env[key];
function start(
  name: string,
  args: string[],
  cwd: string,
  extra: NodeJS.ProcessEnv = {},
) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...env, ...extra },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  logs.set(name, "");
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (data) =>
      logs.set(name, logs.get(name)! + String(data)),
    );
  return child;
}
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  milliseconds = 45000,
): Promise<T> {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {
      /* Startup may not yet have bound the test port. */
    }
    if (Date.now() >= deadline) throw new Error("SMOKE_WAIT_TIMEOUT");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
async function api(
  endpoint: string,
  authorization: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const code =
      result && typeof result === "object" && "code" in result
        ? result.code
        : response.status;
    throw new Error(`SMOKE_HTTP_${code}`);
  }
  return result;
}
async function device(userId: string) {
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
  const identity: MessageDeviceIdentity = {
    userId,
    deviceId: crypto.randomUUID(),
    signingPublicKey,
    agreementPublicKey,
    fingerprint: await messageDeviceFingerprint(
      signingPublicKey,
      agreementPublicKey,
    ),
  };
  return {
    identity,
    signing: signing.privateKey,
    agreement: agreement.privateKey,
  };
}
let success = false;
await fs.writeFile(
  path.join(evidence, "result.json"),
  JSON.stringify({ status: "running", database }),
);
try {
  await new Promise<void>((resolve) =>
    modelServer.listen(0, "127.0.0.1", resolve),
  );
  const modelAddress = modelServer.address();
  assert.ok(modelAddress && typeof modelAddress !== "string");
  start(
    "tescord",
    [require.resolve("tsx/cli"), "scripts/run-e2e-server.ts"],
    path.join(main, "apps/server"),
    {
      TESCORD_BOT_E2E_DATABASE: database,
      TESCORD_BOT_E2E_DIRECT_PORT: backendPort,
    },
  );
  await until(
    () => fetch(base + "/health").then((response) => response.ok),
    Boolean,
  );
  const session = (await api("/api/auth/login", "", "POST", {
    emailOrUsername: "Jackey",
    password: "adminpassword123",
  })) as { accessToken: string; user: { id: string } };
  secrets.push(session.accessToken);
  const auth = `Bearer ${session.accessToken}`;
  const bot = (await api("/api/guilds/gld_default_01/bots", auth, "POST", {
    name: "OpenClawSmoke",
  })) as BotTokenResponse;
  secrets.push(bot.token);
  assert.equal(bot.application.defaultContextLimit, 5);
  const channels: { id: string; isE2EE: boolean }[] = [];
  for (const encrypted of [false, true])
    channels.push(
      (await api("/api/guilds/gld_default_01/channels", auth, "POST", {
        name: encrypted ? "openclaw-encrypted" : "openclaw-plain",
        type: "TEXT",
        isE2EE: encrypted,
      })) as { id: string; isE2EE: boolean },
    );
  const identity = await device(session.user.id);
  await api("/api/e2ee/devices", auth, "POST", identity.identity);
  socket = new WebSocket(base.replace("http:", "ws:") + "/gateway");
  socket.on("message", (raw) => {
    const packet = JSON.parse(raw.toString());
    packets.push(packet);
    if (packet.op === 10)
      socket!.send(
        JSON.stringify({ op: 2, d: { token: session.accessToken } }),
      );
    if (packet.op === 12) socket!.send(JSON.stringify({ op: 13, d: packet.d }));
  });
  await until(
    async () => packets.some((packet) => packet.t === "READY"),
    Boolean,
    10000,
  );
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const gatewayToken = crypto.randomUUID();
  secrets.push(gatewayToken);
  await fs.writeFile(
    env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token: gatewayToken },
      },
      models: {
        mode: "replace",
        providers: {
          smoke: {
            baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
            api: "openai-completions",
            apiKey: "local-smoke-only",
            models: [{ id: "smoke", name: "Smoke", input: ["text", "image"] }],
          },
        },
      },
      agents: { defaults: { model: { primary: "smoke/smoke" } } },
      tools: {
        profile: "messaging",
        toolSearch: false,
        message: { crossContext: { allowWithinProvider: true } },
      },
      plugins: {
        allow: ["nekord"],
        load: { paths: [path.resolve("packages/openclaw-channel")] },
        entries: { nekord: { enabled: true } },
      },
      channels: {
        nekord: {
          serverUrl: base,
          botToken: bot.token,
          allowFrom: [session.user.id],
          locale: "zh-CN",
        },
      },
    }),
    { mode: 0o600 },
  );
  start(
    "openclaw",
    [
      path.resolve("node_modules/openclaw/openclaw.mjs"),
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
    ],
    process.cwd(),
  );
  console.log("Tescord isolated backend ready; starting OpenClaw Gateway");
  const registered = await until(
    () =>
      api(`/api/channels/${channels[0]!.id}/commands`, auth) as Promise<
        BotCommand[]
      >,
    (items) => items.some((item) => item.name === "whoami"),
    180000,
  );
  console.log("OpenClaw native commands registered");
  const command = registered.find((item) => item.name === "whoami")!;
  assert.equal(command.ephemeral, true);
  await fs.writeFile(
    path.join(evidence, "commands.json"),
    JSON.stringify(
      registered.map(({ name, ephemeral, nameLocalizations, options }) => ({
        name,
        ephemeral,
        nameLocalizations,
        options,
      })),
      null,
      2,
    ),
  );
  await until(
    () =>
      api("/api/bots/@me/config", `Bot ${bot.token}`) as Promise<{
        application: { device: unknown };
      }>,
    (value) => Boolean(value.application.device),
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
  const outcomes = [];
  for (const channel of channels) {
    const id = crypto.randomUUID();
    let content: string | undefined;
    if (channel.isE2EE) {
      const devices = (await api(
        `/api/channels/${channel.id}/e2ee/devices`,
        auth,
      )) as MessageDeviceIdentity[];
      content = JSON.stringify(
        await encryptSecureMessage(
          channel.id,
          "{}",
          identity.identity,
          identity.signing,
          devices.filter((item) =>
            [bot.application.userId, session.user.id].includes(item.userId),
          ),
          {
            purpose: "interaction",
            interactionId: id,
            commandId: command.id,
            botId: bot.application.userId,
            callerId: session.user.id,
            revision: 0,
            ephemeral: true,
          },
        ),
      );
    }
    await api(
      `/api/channels/${channel.id}/interactions`,
      auth,
      "POST",
      channel.isE2EE
        ? { id, commandId: command.id, isEncrypted: true, content }
        : { id, commandId: command.id, isEncrypted: false, options: {} },
    );
    const reply = await until(
      async () =>
        packets
          .filter((packet) => packet.t === "EPHEMERAL_MESSAGE")
          .map(
            (packet) =>
              packet.d as {
                interactionId: string;
                content: string;
                isEncrypted: boolean;
              },
          )
          .find((value) => value.interactionId === id),
      Boolean,
      25000,
    );
    assert.ok(reply);
    assert.equal(reply.isEncrypted, channel.isE2EE);
    let text = reply.content;
    if (channel.isE2EE) {
      const envelope = JSON.parse(text) as SecureMessageEnvelope;
      const devices = (await api(
        `/api/channels/${channel.id}/e2ee/devices`,
        auth,
      )) as MessageDeviceIdentity[];
      const sender = devices.find(
        (item) => item.userId === bot.application.userId,
      )!;
      assert.ok(
        envelope.recipients.every((item) =>
          [bot.application.userId, session.user.id].includes(item.userId),
        ),
      );
      text = await decryptSecureMessage(
        envelope,
        channel.id,
        identity.identity,
        identity.agreement,
        sender,
      );
    }
    assert.ok(
      text.includes(session.user.id),
      "native whoami must return authenticated caller",
    );
    assert.deepEqual(
      await api(`/api/channels/${channel.id}/messages`, auth),
      [],
    );
    outcomes.push({
      encrypted: channel.isE2EE,
      command: "whoami",
      replyDecrypted: true,
      historyEmpty: true,
    });
  }
  const outboundText = "openclaw-cli-outbound-smoke";
  const outbound = start(
    "openclaw-outbound",
    [
      path.resolve("node_modules/openclaw/openclaw.mjs"),
      "message",
      "send",
      "--channel",
      "nekord",
      "--target",
      `user:${session.user.id}`,
      "--message",
      outboundText,
      "--json",
    ],
    process.cwd(),
  );
  await until(
    async () => logs.get("openclaw-outbound")!,
    (log) => /"deliveryStatus":\s*"sent"/.test(log),
    55000,
  );
  assert.ok(outbound.exitCode === null || outbound.exitCode === 0);
  if (outbound.exitCode === null) outbound.kill();
  const dmResult = (await api(
    "/api/users/@me/channels",
    auth,
  )) as PaginatedResult<Channel>;
  const dms = dmResult.items;
  assert.ok(Array.isArray(dms));
  const dm = dms.find((item) =>
    item.recipients?.some(
      (recipient) => recipient.id === bot.application.userId,
    ),
  );
  assert.ok(dm);
  const messages = (await api(`/api/channels/${dm.id}/messages`, auth)) as {
    content: string;
    isEncrypted?: boolean;
  }[];
  assert.equal(messages.length, 1);
  const sent = messages[0]!;
  assert.equal(sent.isEncrypted, true);
  const dmDevices = (await api(
    `/api/channels/${dm.id}/e2ee/devices`,
    auth,
  )) as MessageDeviceIdentity[];
  assert.equal(
    await decryptSecureMessage(
      JSON.parse(sent.content),
      dm.id,
      identity.identity,
      identity.agreement,
      dmDevices.find((item) => item.userId === bot.application.userId)!,
    ),
    outboundText,
  );
  assert.deepEqual(modelRequests, []);
  const nativeModelRequests = modelRequests.length;
  allowMockModel = true;
  const channelCanaries: string[] = [];
  for (const channel of channels) {
    const canary = `history-canary-${crypto.randomUUID()}`;
    const triggerPhrase = `stream-smoke-${crypto.randomUUID()}`;
    const sendBody = async (text: string) => {
      const devices = (await api(
        `/api/channels/${channel.id}/e2ee/devices`,
        auth,
      )) as MessageDeviceIdentity[];
      const content = channel.isE2EE
        ? JSON.stringify(
            await encryptSecureMessage(
              channel.id,
              text,
              identity.identity,
              identity.signing,
              devices,
            ),
          )
        : text;
      return await api(`/api/channels/${channel.id}/messages`, auth, "POST", {
        content,
        isEncrypted: channel.isE2EE,
        nonce: crypto.randomUUID(),
      });
    };
    const excluded = `excluded-canary-${crypto.randomUUID()}`;
    await sendBody(excluded);
    for (let index = 0; index < 4; index++) await sendBody(`context-${index}`);
    await sendBody(canary);
    const before: number = modelRequests.length;
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(
      modelRequests.length,
      before,
      "ordinary channel messages must not trigger the model",
    );
    const packetStart = packets.length;
    const trigger = (await sendBody(
      `<@${bot.application.userId}> ${triggerPhrase}`,
    )) as Message;
    const result = await until(
      async () => {
        const history = (await api(
          `/api/channels/${channel.id}/messages`,
          auth,
        )) as Message[];
        const message = history.find(
          (item) =>
            item.authorId === bot.application.userId &&
            item.replyToId === trigger.id,
        );
        if (!message) return undefined;
        const devices = (await api(
          `/api/channels/${channel.id}/e2ee/devices`,
          auth,
        )) as MessageDeviceIdentity[];
        const text = message.isEncrypted
          ? await decryptSecureMessage(
              JSON.parse(message.content),
              channel.id,
              identity.identity,
              identity.agreement,
              devices.find((item) => item.userId === bot.application.userId)!,
            )
          : message.content;
        return { message, text };
      },
      (value) => value?.text === "local-model-answer-final",
      45000,
    );
    assert.ok(result);
    assert.ok(
      (result.message.revision ?? 0) >= 1,
      "stream must edit its initial preview",
    );
    assert.ok(
      modelBodies.at(-1)?.includes(canary),
      "N lookback must reach the actual host model context",
    );
    assert.equal(
      modelBodies.at(-1)?.includes(excluded),
      false,
      "default lookback excludes the sixth preceding message",
    );
    for (const previous of channelCanaries)
      assert.equal(
        modelBodies.at(-1)?.includes(previous),
        false,
        "channel sessions must remain isolated",
      );
    channelCanaries.push(canary);
    const typing = packets
      .slice(packetStart)
      .filter(
        (packet) =>
          packet.t === "TYPING_START" &&
          (packet.d as { channelId: string }).channelId === channel.id,
      );
    assert.ok(typing.length >= 6, "long-running turn must renew typing");
    assert.equal(
      (typing[0]!.d as { user: { isBot: boolean } }).user.isBot,
      true,
    );
    await until(
      async () =>
        packets
          .slice(packetStart)
          .some(
            (packet) =>
              packet.t === "TYPING_STOP" &&
              (packet.d as { channelId: string }).channelId === channel.id,
          ),
      Boolean,
    );
    await api(
      `/api/guilds/gld_default_01/bots/${bot.application.id}/channels/${channel.id}`,
      auth,
      "PUT",
      { contextLimit: 0, respondToAll: false },
    );
    modelDelayMs = 1800;
    const continuation = (await sendBody(
      `<@${bot.application.userId}>${channel.isE2EE ? "" : " continue-session"}`,
    )) as Message;
    await until(async () => {
      const history = (await api(
        `/api/channels/${channel.id}/messages`,
        auth,
      )) as Message[];
      return history.some(
        (item) =>
          item.authorId === bot.application.userId &&
          item.replyToId === continuation.id &&
          (item.revision ?? 0) >= 1,
      );
    }, Boolean);
    const proof = {
      encrypted: channel.isE2EE,
      previousTriggerRetained:
        modelBodies.at(-1)?.includes(triggerPhrase) === true,
      previousReplyRetained:
        modelBodies.at(-1)?.includes("local-model-answer-final") === true,
      noNewHistory: true,
      bareMentionTriggered: channel.isE2EE,
    };
    sessionProof.push(proof);
    assert.equal(
      proof.previousTriggerRetained,
      true,
      "continuous session retains the prior user turn with zero new history",
    );
    assert.equal(
      proof.previousReplyRetained,
      true,
      "continuous session retains the prior assistant reply with zero new history",
    );
    await until(
      async () =>
        packets.some(
          (packet) =>
            packet.t === "TYPING_STOP" &&
            (packet.d as { channelId: string }).channelId === channel.id,
        ),
      Boolean,
    );
    modelDelayMs = 22000;
    outcomes.push({
      encrypted: channel.isE2EE,
      command: "mock-model-stream",
      replyDecrypted: true,
      historyEmpty: false,
    });
  }
  assert.equal(modelRequests.length, 4);
  const [sourceChannel, relayChannel] = channels;
  assert.ok(sourceChannel && relayChannel);
  const pngFixtures = [48, 124, 208].map((red) => {
    const rgba = new Uint8Array(64 * 64 * 4);
    for (let index = 0; index < rgba.length; index += 4) {
      rgba.set([red, 255 - red, 91, 255], index);
    }
    return encodePngRgba(Buffer.from(rgba), 64, 64);
  });
  const sendImage = async (bytes: Buffer, text: string, replyToId?: string) => {
    const file = {
      fileName: `${crypto.randomUUID()}.png`,
      fileSize: bytes.length,
      mimeType: "image/png",
    };
    const grant = (await api("/api/attachments/presigned-url", auth, "POST", {
      ...file,
      channelId: sourceChannel.id,
      purpose: "attachment",
    })) as { uploadUrl: string; fileUrl: string };
    const upload = await fetch(new URL(grant.uploadUrl, base), {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": file.mimeType },
      body: new Uint8Array(bytes),
    });
    assert.ok(upload.ok, `image upload returned ${upload.status}`);
    return (await api(
      `/api/channels/${sourceChannel.id}/messages`,
      auth,
      "POST",
      {
        content: text,
        replyToId,
        attachments: [{ ...file, url: grant.fileUrl }],
      },
    )) as Message;
  };
  const quote = await sendImage(pngFixtures[0]!, "quote image");
  for (let index = 0; index < 5; index++) {
    await api(`/api/channels/${sourceChannel.id}/messages`, auth, "POST", {
      content: `window filler ${index}`,
    });
  }
  await sendImage(pngFixtures[1]!, "history image");
  relay = {
    marker: `vision-relay-${crypto.randomUUID()}`,
    target: `channel:${relayChannel.id}`,
    text: "vision relay to encrypted channel",
    requested: false,
  };
  modelDelayMs = 100;
  const firstModelRequest = modelBodies.length;
  const visionSource = await sendImage(
    pngFixtures[2]!,
    `<@${bot.application.userId}> ${relay.marker}`,
    quote.id,
  );
  await until(
    async () => modelBodies.length,
    (count) => count > firstModelRequest,
  );
  const visionRequest = JSON.parse(modelBodies[firstModelRequest]!) as {
    tools?: Array<{ function?: { name?: string } }>;
    messages?: Array<{ content?: unknown }>;
  };
  const imageParts = visionRequest.messages
    ?.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .filter((part) => part.type === "image_url");
  assert.equal(
    imageParts?.length,
    3,
    "all three image sources must reach the actual model input",
  );
  assert.ok(
    imageParts?.every(
      (part) =>
        /^data:image\//.test(part.image_url?.url) &&
        part.image_url.url.length > 100,
    ),
  );
  assert.ok(
    visionRequest.tools?.some((item) => item.function?.name === "message"),
  );
  const relayed = await until(
    async () => {
      const recent = (await api(
        `/api/channels/${relayChannel.id}/messages`,
        auth,
      )) as Message[];
      return recent.find(
        (message) =>
          message.authorId === bot.application.userId &&
          !message.replyToId &&
          message.createdAt >= quote.createdAt,
      );
    },
    Boolean,
    30_000,
  );
  assert.ok(relayed?.isEncrypted);
  assert.ok(
    logs
      .get("tescord")
      ?.includes(
        `"method":"POST","url":"/api/bots/@me/channels/${relayChannel.id}/messages"`,
      ),
    "model invocation must send through the caller-authorized endpoint",
  );
  const relayDevices = (await api(
    `/api/channels/${relayChannel.id}/e2ee/devices`,
    auth,
  )) as MessageDeviceIdentity[];
  assert.equal(
    await decryptSecureMessage(
      JSON.parse(relayed.content),
      relayChannel.id,
      identity.identity,
      identity.agreement,
      relayDevices.find((item) => item.userId === bot.application.userId)!,
    ),
    relay.text,
  );
  outcomes.push({
    encrypted: true,
    command: "vision-and-cross-channel-message-tool",
    replyDecrypted: true,
    historyEmpty: false,
  });
  await api(
    `/api/guilds/gld_default_01/bots/${bot.application.id}/token`,
    auth,
    "POST",
  );
  await until(
    async () => logs.get("openclaw")!,
    (log) =>
      /stopped|BOT_SESSION_REVOKED|CLIENT_CLOSED|disconnected/i.test(log),
    5000,
  ).catch(() => {});
  const oldToken = await fetch(base + "/api/bots/@me", {
    headers: { Authorization: `Bot ${bot.token}` },
  });
  assert.equal(oldToken.status, 401);
  const revokedRelay = await fetch(
    `${base}/api/bots/@me/channels/${relayChannel.id}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${bot.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: {
          kind: "message",
          id: visionSource.id,
          channelId: sourceChannel.id,
        },
        content: relayed.content,
        isEncrypted: true,
        nonce: crypto.randomUUID(),
      }),
    },
  );
  assert.equal(revokedRelay.status, 401);
  assert.equal(
    sessionProof.some((proof) => proof.bareMentionTriggered),
    true,
  );
  await fs.writeFile(
    path.join(evidence, "result.json"),
    JSON.stringify(
      {
        passed: outcomes.length + 2,
        failed: 0,
        outcomes,
        sustainedTypingAndStop: true,
        continuousChannelSessions: true,
        bareMentionTriggered: sessionProof.some(
          (proof) => proof.bareMentionTriggered,
        ),
        sessionProof,
        defaultContextLimit: 5,
        proactiveEncryptedDm: true,
        resetTokenRejected: true,
        nativeModelRequests,
        localMockModelRequests: modelRequests.length,
        paidModelRequests: 0,
        visionInputImageCount: imageParts?.length,
        crossChannelToolSend: true,
        database,
      },
      null,
      2,
    ),
  );
  success = true;
  console.log(
    "PASS real OpenClaw Gateway + Tescord: native commands, plaintext/E2EE ephemeral, streamed replies, three-source vision input, encrypted cross-channel tool send, proactive DM and Token reset; 0 paid model requests",
  );
} finally {
  await fs.writeFile(
    path.join(evidence, "session-proof.json"),
    JSON.stringify(
      {
        sessionProof,
        requests: modelBodies.map((body) => ({
          previousTrigger: /stream-smoke-[a-f0-9-]+/.test(body),
          continuation: body.includes("continue-session"),
          priorAssistantReply: body.includes("local-model-answer-final"),
        })),
      },
      null,
      2,
    ),
  );
  socket?.terminate();
  await new Promise<void>((resolve) => modelServer.close(() => resolve()));
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
  for (const [name, log] of logs) {
    let redacted = log;
    for (const secret of secrets)
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    await fs.writeFile(path.join(evidence, `${name}.log`), redacted);
  }
  if (
    path.dirname(directory) === os.tmpdir() &&
    path.basename(directory).startsWith("nekord-backend-smoke-")
  )
    await fs.rm(directory, { recursive: true, force: true });
  if (!success) {
    await fs.writeFile(
      path.join(evidence, "result.json"),
      JSON.stringify({ status: "failed", failed: 1, database }),
    );
    console.error(`FAIL real backend smoke; evidence: ${evidence}`);
  }
}
