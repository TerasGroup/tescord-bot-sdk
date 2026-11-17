import fs from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import {
  BotClientError,
  NekordBotClient,
} from "../packages/bot-sdk/src/index.js";
import {
  ButtonStyle,
  ComponentType,
  InteractionType,
  MessageFlags,
  effectiveContextLimit,
  extractChannelMentionIds,
  formatChannelMention,
  isRecord,
  validateInteractionOptions,
  SUPPORTED_LOCALES,
  type BotCommandDefinition,
  type BotConfigUpdatePayload,
  type InteractionCreatePayload,
  type Message,
  type Channel,
  type SupportedLocale,
} from "@tescord/types";
import { PluginIdentity } from "../packages/openclaw-channel/src/identity.js";
import { DeliveryLedger } from "../packages/openclaw-channel/src/ledger.js";
import {
  accountDirectory,
  writeState,
} from "../packages/openclaw-channel/src/state.js";
import {
  readHistory,
  stripBotMention,
} from "../packages/openclaw-channel/src/inbound.js";
import { ChannelError } from "../packages/openclaw-channel/src/config.js";
import {
  buildAcceptChallengeComponents,
  buildFeedbackModal,
  buildRpsSelectComponents,
  commandDefinitions,
  commandNames,
  copy,
  evaluateRpsResult,
  fixedReply,
  gettingStartedCommandDefinitions,
  gettingStartedCommandNames,
  parseCommand,
  type RpsObject,
} from "./fixed-bot/copy.js";
import { acknowledge } from "./fixed-bot/defer.js";

const root = path.resolve(".runtime/fixed-bot");
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const lockPath = path.join(root, "process.lock");
try {
  const previous: unknown = JSON.parse(await fs.readFile(lockPath, "utf8"));
  if (
    typeof previous !== "number" ||
    !Number.isSafeInteger(previous) ||
    previous < 1
  )
    throw new Error("LOCK_INVALID");
  let alive = false;
  try {
    process.kill(previous, 0);
    alive = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
  if (alive) throw new Error("BOT_ALREADY_RUNNING");
  await fs.unlink(lockPath);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}
const lock = await fs.open(lockPath, "wx", 0o600);
await lock.writeFile(String(process.pid));
await fs.rm(path.join(root, "stop"), { force: true });
const token = process.env.NEKORD_BOT_TOKEN ?? "";
const serverUrl = process.env.NEKORD_SERVER_URL ?? "https://tescord.terata.top";
const localeInput = process.env.NEKORD_BOT_LOCALE ?? "zh-CN";
if (!SUPPORTED_LOCALES.some((item) => item.code === localeInput))
  throw new Error("INVALID_LOCALE");
const locale = localeInput as SupportedLocale;
const client = new NekordBotClient({ serverUrl, token });
const stop = new AbortController();
const stats = {
  pid: process.pid,
  serverUrl: client.serverUrl.origin,
  connected: false,
  readyCount: 0,
  messages: 0,
  interactions: 0,
  replies: 0,
  errors: 0,
  contextReads: 0,
  markerReads: 0,
};
let logWrites = Promise.resolve();
function log(event: string, fields: Record<string, unknown> = {}): void {
  const record = { time: new Date().toISOString(), event, ...fields };
  const line = JSON.stringify(record);
  process.stdout.write(`${line}\n`);
  logWrites = logWrites.then(() =>
    fs.appendFile(path.join(root, "events.jsonl"), `${line}\n`, {
      mode: 0o600,
    }),
  );
}
function failure(error: unknown): void {
  stats.errors++;
  log("error", {
    code:
      error instanceof BotClientError || error instanceof ChannelError
        ? error.code
        : "BOT_OPERATION_FAILED",
  });
}
let identity: PluginIdentity | undefined;
let ledger: DeliveryLedger | undefined;
let config: BotConfigUpdatePayload;
let generation = new AbortController();
let queue = Promise.resolve();
let pending = 0;
function applyConfig(value: BotConfigUpdatePayload): void {
  generation.abort();
  generation = new AbortController();
  config = value;
  if (
    identity &&
    (value.application.device?.deviceId !== identity.identity.deviceId ||
      value.application.device.fingerprint !== identity.identity.fingerprint)
  )
    stop.abort();
}
function current(channelId: string, signal: AbortSignal): Channel {
  signal.throwIfAborted();
  const channel = config.channels.find((item) => item.id === channelId);
  if (!channel || !client.gateway.connected)
    throw new ChannelError("CHANNEL_UNAVAILABLE");
  return channel;
}
function enqueue(job: (signal: AbortSignal) => Promise<void>): void {
  if (stop.signal.aborted) return;
  if (pending >= 32) {
    failure(new ChannelError("INBOUND_QUEUE_FULL"));
    return;
  }
  const signal = AbortSignal.any([stop.signal, generation.signal]);
  pending++;
  queue = queue.then(async () => {
    try {
      signal.throwIfAborted();
      await job(signal);
    } catch (error) {
      if (!signal.aborted) failure(error);
    } finally {
      pending--;
    }
  });
}
async function context(
  channel: Channel,
  before: number,
  signal: AbortSignal,
): Promise<number> {
  const history = await readHistory(
    client,
    identity!,
    config.application,
    channel,
    before,
    signal,
  );
  const marker = process.env.NEKORD_TEST_MARKER;
  const markerFound = Boolean(
    marker && history.some((item) => item.text.includes(marker)),
  );
  stats.contextReads++;
  if (markerFound) stats.markerReads++;
  log("context_read", {
    channelId: channel.id,
    encrypted: Boolean(channel.isE2EE),
    limit: effectiveContextLimit(config.application, channel.id),
    count: history.length,
    markerFound,
  });
  return history.length;
}
async function messageTurn(
  message: Message,
  signal: AbortSignal,
): Promise<void> {
  const channel = current(message.channelId, signal);
  if (message.authorId === config.application.userId || message.author.isBot)
    return;
  if (channel.isE2EE && !message.isEncrypted)
    throw new ChannelError("PLAINTEXT_REJECTED");
  const decoded = await identity!.decryptMessage(message, signal);
  const mentioned =
    decoded.text.includes(`<@${config.application.userId}>`) ||
    decoded.text.includes(`<@!${config.application.userId}>`);
  const replied = message.replyTo?.authorId === config.application.userId;
  const respondToAll = config.application.channelSettings.some(
    (item) => item.channelId === channel.id && item.respondToAll,
  );
  if (channel.type !== "DM" && !mentioned && !replied && !respondToAll) return;
  if (!(await ledger!.admit(`message:${message.id}`))) return;
  const stripped = stripBotMention(decoded.text, config.application.userId);
  const command = parseCommand(stripped);
  const mentionedChannels = extractChannelMentionIds(stripped)
    .map((id) => config.channels.find((item) => item.id === id))
    .filter((item): item is Channel => Boolean(item && item.type !== "DM"));
  const channelMention =
    !command && mentionedChannels[0]
      ? formatChannelMention(mentionedChannels[0].id)
      : undefined;
  const count = await context(channel, message.sequence ?? 0, signal);
  const text = fixedReply(locale, command, count, channelMention);
  const content = channel.isE2EE
    ? await identity!.encrypt(channel.id, text, undefined, undefined, signal)
    : text;
  current(channel.id, signal);
  const result = await client.sendMessage(
    channel.id,
    {
      content,
      isEncrypted: Boolean(channel.isE2EE),
      replyToId: message.id,
      nonce: `fixed:${message.id}`,
    },
    signal,
  );
  stats.messages++;
  stats.replies++;
  log("message_reply", {
    channelId: channel.id,
    messageId: message.id,
    replyId: result.id,
    command: command ?? "unknown",
    historyCount: count,
    encrypted: Boolean(channel.isE2EE),
  });
}
interface ActiveRpsGame {
  id: string;
  channelId: string;
  challengerId: string;
  challengerName: string;
  challengerChoice: RpsObject;
  publicMessageId?: string;
  publicMessageRevision: number;
}
const activeGames = new Map<string, ActiveRpsGame>();

async function encryptReplyContent(
  channel: Channel,
  text: string,
  interaction: InteractionCreatePayload,
  ephemeral: boolean,
  revision: number,
  signal: AbortSignal,
): Promise<string> {
  if (!channel.isE2EE) return text;
  if (ephemeral) {
    return identity!.encrypt(
      channel.id,
      text,
      {
        purpose: "ephemeral",
        interactionId: interaction.id,
        commandId: interaction.command.id,
        botId: config.application.userId,
        callerId: interaction.callerId,
        revision,
        ephemeral: true,
      },
      [config.application.userId, interaction.callerId],
      signal,
    );
  }
  return identity!.encrypt(channel.id, text, undefined, undefined, signal);
}

async function gettingStartedTurn(
  interaction: InteractionCreatePayload,
  signal: AbortSignal,
): Promise<void> {
  const channel = current(interaction.channelId, signal);
  if (Boolean(channel.isE2EE) !== interaction.isEncrypted)
    throw new ChannelError("INTERACTION_ENCRYPTION_REQUIRED");
  if (!(await ledger!.admit(`interaction:${interaction.id}`))) return;

  const callerName =
    interaction.caller?.displayName ||
    interaction.caller?.username ||
    `<@${interaction.callerId}>`;
  const type = interaction.type ?? InteractionType.APPLICATION_COMMAND;

  if (type === InteractionType.APPLICATION_COMMAND) {
    const cmdName = interaction.command.name;
    if (cmdName === "feedback") {
      await client.openInteractionModal(
        interaction.id,
        buildFeedbackModal(locale),
        signal,
      );
      stats.interactions++;
      return;
    }

    const rawOptions = await identity!.decryptInteraction(interaction, signal);
    validateInteractionOptions(interaction.command, rawOptions);
    const options = isRecord(rawOptions) ? rawOptions : {};

    if (cmdName === "test") {
      const text = copy[locale].gettingStarted.testReply;
      const content = await encryptReplyContent(
        channel,
        text,
        interaction,
        false,
        1,
        signal,
      );
      await client.respondInteraction(
        interaction.id,
        {
          type: "message",
          content,
          isEncrypted: Boolean(channel.isE2EE),
          components: [
            {
              type: ComponentType.ACTION_ROW,
              components: [
                {
                  type: ComponentType.BUTTON,
                  style: ButtonStyle.PRIMARY,
                  customId: "test_button",
                  label: copy[locale].gettingStarted.testButtonLabel,
                },
              ],
            },
          ],
        },
        false,
        signal,
      );
      stats.interactions++;
      stats.replies++;
      return;
    }

    if (cmdName === "challenge") {
      const chosenObj = String(options.object || "rock") as RpsObject;
      const validChoice: RpsObject =
        chosenObj === "paper" || chosenObj === "scissors" ? chosenObj : "rock";
      const text = copy[locale].gettingStarted.challengePrompt(callerName);
      const content = await encryptReplyContent(
        channel,
        text,
        interaction,
        false,
        1,
        signal,
      );
      const result = await client.respondInteraction(
        interaction.id,
        {
          type: "message",
          content,
          isEncrypted: Boolean(channel.isE2EE),
          components: buildAcceptChallengeComponents(locale, interaction.id),
        },
        false,
        signal,
      );
      activeGames.set(interaction.id, {
        id: interaction.id,
        channelId: channel.id,
        challengerId: interaction.callerId,
        challengerName: callerName,
        challengerChoice: validChoice,
        publicMessageId:
          result.kind === "public" ? result.message.id : undefined,
        publicMessageRevision:
          result.kind === "public" ? (result.message.revision ?? 0) : 0,
      });
      stats.interactions++;
      stats.replies++;
      return;
    }
  } else if (type === InteractionType.MESSAGE_COMPONENT) {
    const customId = interaction.customId ?? "";
    if (customId === "test_button") {
      const text = copy[locale].gettingStarted.testClickedReply;
      const content = await encryptReplyContent(
        channel,
        text,
        interaction,
        Boolean(interaction.ephemeralMessage),
        2,
        signal,
      );
      await client.updateInteractionMessage(
        interaction.id,
        {
          content,
          isEncrypted: Boolean(channel.isE2EE),
          components: [],
        },
        signal,
      );
      stats.interactions++;
      stats.replies++;
      return;
    }

    if (customId.startsWith("accept_button_")) {
      const gameId = customId.slice("accept_button_".length);
      const text = copy[locale].gettingStarted.selectPrompt;
      const content = await encryptReplyContent(
        channel,
        text,
        interaction,
        true,
        1,
        signal,
      );
      await client.respondInteraction(
        interaction.id,
        {
          type: "message",
          content,
          isEncrypted: Boolean(channel.isE2EE),
          ephemeral: true,
          flags: MessageFlags.EPHEMERAL,
          components: buildRpsSelectComponents(locale, gameId),
        },
        false,
        signal,
      );
      stats.interactions++;
      stats.replies++;
      return;
    }

    if (customId.startsWith("select_choice_")) {
      const gameId = customId.slice("select_choice_".length);
      const game = activeGames.get(gameId);
      const selectedRaw = interaction.values?.[0] ?? "rock";
      const acceptorChoice: RpsObject =
        selectedRaw === "paper" || selectedRaw === "scissors"
          ? selectedRaw
          : "rock";
      const resultText = game
        ? evaluateRpsResult(
            locale,
            game.challengerName,
            game.challengerChoice,
            callerName,
            acceptorChoice,
          )
        : evaluateRpsResult(
            locale,
            callerName,
            "rock",
            callerName,
            acceptorChoice,
          );
      const ephemContent = await encryptReplyContent(
        channel,
        resultText,
        interaction,
        true,
        2,
        signal,
      );
      await client.updateInteractionMessage(
        interaction.id,
        {
          content: ephemContent,
          isEncrypted: Boolean(channel.isE2EE),
          components: [],
        },
        signal,
      );
      if (game?.publicMessageId) {
        activeGames.delete(gameId);
        const nextRev = game.publicMessageRevision + 1;
        const pubContent = channel.isE2EE
          ? await identity!.encrypt(
              channel.id,
              resultText,
              {
                purpose: "edit",
                messageId: game.publicMessageId,
                revision: nextRev,
              },
              undefined,
              signal,
            )
          : resultText;
        await client.editMessage(
          channel.id,
          game.publicMessageId,
          {
            content: pubContent,
            isEncrypted: Boolean(channel.isE2EE),
            expectedRevision: game.publicMessageRevision,
            components: [],
          },
          signal,
        );
      }
      stats.interactions++;
      stats.replies++;
      return;
    }
  } else if (type === InteractionType.MODAL_SUBMIT) {
    const rawFields = await identity!.decryptInteraction(interaction, signal);
    const fields = isRecord(rawFields) ? rawFields : {};
    const subject = String(fields.subject || "Feedback");
    const text = copy[locale].gettingStarted.feedbackReply(subject);
    const content = await encryptReplyContent(
      channel,
      text,
      interaction,
      true,
      1,
      signal,
    );
    await client.respondInteraction(
      interaction.id,
      {
        type: "message",
        content,
        isEncrypted: Boolean(channel.isE2EE),
        ephemeral: true,
        flags: MessageFlags.EPHEMERAL,
      },
      false,
      signal,
    );
    stats.interactions++;
    stats.replies++;
  }
}

async function interactionTurn(
  interaction: InteractionCreatePayload,
  signal: AbortSignal,
): Promise<void> {
  const channel = current(interaction.channelId, signal);
  const command = commandNames.find(
    (name) => name === interaction.command.name,
  );
  if (!command) return;
  if (Boolean(channel.isE2EE) !== interaction.isEncrypted)
    throw new ChannelError("INTERACTION_ENCRYPTION_REQUIRED");
  const options = await identity!.decryptInteraction(interaction, signal);
  validateInteractionOptions(interaction.command, options);
  if (!(await ledger!.admit(`interaction:${interaction.id}`))) return;
  const count = await context(channel, interaction.sequence, signal);
  const text = fixedReply(locale, command, count);
  const content = channel.isE2EE
    ? await identity!.encrypt(
        channel.id,
        text,
        {
          purpose: "ephemeral",
          interactionId: interaction.id,
          commandId: interaction.command.id,
          botId: config.application.userId,
          callerId: interaction.callerId,
          revision: 1,
          ephemeral: true,
        },
        [config.application.userId, interaction.callerId],
        signal,
      )
    : text;
  current(channel.id, signal);
  const result = await client.respondInteraction(
    interaction.id,
    { type: "message", content, isEncrypted: Boolean(channel.isE2EE) },
    true,
    signal,
  );
  if (result.kind !== "ephemeral")
    throw new ChannelError("INTERACTION_VISIBILITY_INVALID");
  stats.interactions++;
  stats.replies++;
  log("interaction_reply", {
    channelId: channel.id,
    interactionId: interaction.id,
    command,
    historyCount: count,
    encrypted: Boolean(channel.isE2EE),
    ephemeral: true,
  });
}
const saveStatus = () =>
  writeState(path.join(root, "status.json"), {
    ...stats,
    updatedAt: new Date().toISOString(),
    pending,
  });
let timer: ReturnType<typeof setInterval> | undefined;
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
try {
  const initial = await client.getConfig(stop.signal);
  const directory = await accountDirectory(root, initial.application.id);
  identity = await PluginIdentity.load(directory, initial.application, client);
  await identity.register(stop.signal);
  ledger = await DeliveryLedger.load(directory, initial.application.id);
  await writeState(path.join(root, "commands-before.json"), initial.commands);
  const definitions = [
    ...commandDefinitions(locale),
    ...gettingStartedCommandDefinitions(locale),
  ];
  const allManagedNames = new Set<string>([
    ...commandNames,
    ...gettingStartedCommandNames,
  ]);
  const retained: BotCommandDefinition[] = initial.commands
    .filter((item) => !allManagedNames.has(item.name))
    .map(
      ({
        name,
        description,
        nameLocalizations,
        descriptionLocalizations,
        options,
        ephemeral,
      }) => ({
        name,
        description,
        nameLocalizations,
        descriptionLocalizations,
        options,
        ephemeral,
      }),
    );
  await client.registerCommands([...retained, ...definitions], stop.signal);
  client.on("READY", (ready) => {
    applyConfig(ready);
    stats.connected = true;
    stats.readyCount++;
    log("ready", {
      applicationId: ready.application.id,
      name: ready.application.name,
      channels: ready.channels.length,
      defaultContextLimit: ready.application.defaultContextLimit,
      commands: definitions.map((item) => item.name),
    });
  });
  client.on("BOT_CONFIG_UPDATE", applyConfig);
  client.on("DM_CHANNEL_CREATE", (channel) => {
    config.channels = [
      ...config.channels.filter((item) => item.id !== channel.id),
      channel,
    ];
  });
  client.on("MESSAGE_CREATE", (message) =>
    enqueue((signal) => messageTurn(message, signal)),
  );
  client.on("INTERACTION_CREATE", async (interaction) => {
    try {
      const type = interaction.type ?? InteractionType.APPLICATION_COMMAND;
      if (
        type === InteractionType.MESSAGE_COMPONENT ||
        type === InteractionType.MODAL_SUBMIT ||
        gettingStartedCommandNames.some(
          (name) => name === interaction.command.name,
        )
      ) {
        current(interaction.channelId, stop.signal);
        enqueue((signal) => gettingStartedTurn(interaction, signal));
        return;
      }
      if (!commandNames.some((name) => name === interaction.command.name))
        return;
      if (!interaction.ephemeral)
        throw new ChannelError("INTERACTION_VISIBILITY_INVALID");
      current(interaction.channelId, stop.signal);
      await acknowledge(client, interaction.id, stop.signal, () =>
        log("defer_retry", { interactionId: interaction.id }),
      );
      enqueue((signal) => interactionTurn(interaction, signal));
    } catch (error) {
      if (!stop.signal.aborted) failure(error);
    }
  });
  client.on("CLIENT_ERROR", failure);
  client.on("CLIENT_DISCONNECT", (event) => {
    stats.connected = false;
    generation.abort();
    log("disconnect", event);
    if (event.fatal) stop.abort();
  });
  await client.connect(identity.identity.deviceId, stop.signal);
  await saveStatus();
  let ticking = false;
  timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      try {
        await fs.access(path.join(root, "stop"));
        stop.abort();
      } catch {}
      await saveStatus();
    })()
      .catch(failure)
      .finally(() => {
        ticking = false;
      });
  }, 1000);
  if (!stop.signal.aborted) await once(stop.signal, "abort");
} catch (error) {
  failure(error);
  process.exitCode = 1;
} finally {
  stop.abort();
  if (timer) clearInterval(timer);
  client.close();
  await queue;
  await identity?.close();
  await ledger?.close();
  stats.connected = false;
  log("stopped");
  await saveStatus();
  await logWrites;
  await lock.close();
  await fs.unlink(lockPath);
}
