import {
  effectiveContextLimit,
  type BotApplication,
  type Channel,
  type Message,
} from "@tescord/types";
import {
  BotClientError,
  ErrorCode,
  type NekordBotClient,
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
export async function readHistory(
  client: NekordBotClient,
  identity: PluginIdentity,
  application: BotApplication,
  channel: Channel,
  before: number,
  signal?: AbortSignal,
): Promise<HistoryMessage[]> {
  const limit = effectiveContextLimit(application, channel.id);
  if (limit === 0) return [];
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
      result.push({
        id: message.id,
        senderId: message.authorId,
        senderName: message.author.displayName || message.author.username,
        text: decoded.text,
        timestamp: Date.parse(message.createdAt),
      });
    } catch {
      signal?.throwIfAborted();
    }
  }
  return result;
}
