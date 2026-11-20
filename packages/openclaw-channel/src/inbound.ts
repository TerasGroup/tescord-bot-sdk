import {
  effectiveContextLimit,
  formatChannelMention,
  formatChannelMentionsForReader,
  type BotApplication,
  type Channel,
  type Message,
} from "@tescord/types";
import {
  BotClientError,
  ErrorCode,
  type NekordBotClient,
  type MessageImages,
} from "@nekord/bot-sdk";
import type { NekordAccount } from "./config.js";
import { senderAllowed } from "./config.js";
import type { PluginIdentity } from "./identity.js";
export interface HistoryMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  imageMessage?: MessageImages;
}

function imageMessage(message: Message): MessageImages | undefined {
  if (
    !message.attachments?.some((file) =>
      /^image\/(?:png|jpeg|webp)$/i.test(file.mimeType),
    )
  )
    return undefined;
  const { id, channelId, sequence, attachments } = message;
  return { id, channelId, sequence, attachments };
}

export async function readReplyImages(
  client: NekordBotClient,
  identity: PluginIdentity,
  channel: Channel,
  message: Message,
  history: readonly HistoryMessage[],
  signal: AbortSignal,
): Promise<MessageImages | undefined> {
  const replyId = message.replyToId;
  if (!replyId || replyId === message.id) return undefined;
  const present = history.find((entry) => entry.id === replyId);
  if (present) return present.imageMessage;
  try {
    const reply = await client.getMessage(channel.id, replyId, signal);
    if (
      !reply ||
      (channel.isE2EE && !reply.isEncrypted && reply.content) ||
      (reply.sequence !== undefined &&
        message.sequence !== undefined &&
        reply.sequence >= message.sequence)
    )
      return undefined;
    const images = imageMessage(reply);
    if (images) await identity.decryptMessage(reply, signal);
    return images;
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof BotClientError &&
      (error.status === 401 || error.code === ErrorCode.BOT_REVOKED)
    )
      throw error;
    return undefined;
  }
}
export function shouldTrigger(
  message: Message,
  plaintext: string,
  application: BotApplication,
  account: NekordAccount,
): boolean {
  if (
    message.authorId === application.userId ||
    (!account.allowBotMessages && message.author.isBot) ||
    !senderAllowed(account, message.authorId)
  )
    return false;
  return (
    application.channelSettings.find(
      (setting) => setting.channelId === message.channelId,
    )?.respondToAll === true ||
    plaintext.includes(`<@${application.userId}>`) ||
    plaintext.includes(`<@!${application.userId}>`) ||
    message.replyTo?.authorId === application.userId
  );
}
export function stripBotMention(text: string, userId: string): string {
  return text
    .split(`<@${userId}>`)
    .join("")
    .split(`<@!${userId}>`)
    .join("")
    .trim();
}
export function formatInboundTextForAgent(
  text: string,
  channels: readonly Channel[],
): string {
  return formatChannelMentionsForReader(text, channels);
}
export interface ChannelDirectoryEntry {
  id: string;
  name: string;
  type: Channel["type"];
  mention: string;
  topic?: string;
}
export function guildChannelsSummary(
  channels: readonly Channel[],
): ChannelDirectoryEntry[] {
  return [...channels]
    .filter((item) => item.type === "TEXT" || item.type === "VOICE")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      mention: formatChannelMention(item.id),
      ...(item.topic ? { topic: item.topic } : {}),
    }));
}
export async function readHistory(
  client: NekordBotClient,
  identity: PluginIdentity,
  application: BotApplication,
  channel: Channel,
  before: number,
  signal?: AbortSignal,
  channels: readonly Channel[] = [channel],
): Promise<HistoryMessage[]> {
  const limit = effectiveContextLimit(application, channel.id);
  if (limit === 0 || !Number.isSafeInteger(before) || before <= 0) return [];
  let messages: Message[];
  try {
    messages = await client.getMessages(channel.id, { before, limit }, signal);
  } catch (error) {
    if (error instanceof BotClientError && error.code === ErrorCode.FORBIDDEN)
      return [];
    throw error;
  }
  const result: HistoryMessage[] = [];
  for (const message of messages.sort(
    (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
  )) {
    signal?.throwIfAborted();
    if (channel.isE2EE && !message.isEncrypted && message.content) continue;
    try {
      const decoded = await identity.decryptMessage(message, signal);
      const images = imageMessage(message);
      result.push({
        id: message.id,
        senderId: message.authorId,
        senderName: message.author.displayName || message.author.username,
        text: formatChannelMentionsForReader(decoded.text, channels),
        timestamp: Date.parse(message.createdAt),
        ...(images ? { imageMessage: images } : {}),
      });
    } catch {
      signal?.throwIfAborted();
    }
  }
  return result;
}
