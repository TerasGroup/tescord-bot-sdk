import {
  ComponentType,
  InteractionType,
  isRecord,
  isContextLimit,
  validateBotCommandDefinition,
  validateMessageComponents,
  validateMessageDevice,
  type Attachment,
  type BotApplication,
  type BotCommand,
  type BotConfigUpdatePayload,
  type BotReadyPayload,
  type Channel,
  type InteractionCreatePayload,
  type Message,
  type MessageDeviceIdentity,
} from "@tescord/types";
import { BotClientError } from "./errors.js";
export function invalid(): never {
  throw new BotClientError("PROTOCOL_ERROR");
}
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export function attachment(value: unknown): Attachment {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    typeof value.url !== "string" ||
    typeof value.fileName !== "string" ||
    !integer(value.fileSize) ||
    typeof value.mimeType !== "string" ||
    (value.downloadUrl !== undefined && typeof value.downloadUrl !== "string")
  )
    return invalid();
  return value as unknown as Attachment;
}
export function message(value: unknown): Message {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !text(value.channelId) ||
    !text(value.authorId) ||
    typeof value.content !== "string" ||
    value.content.length > 256 * 1024 ||
    !text(value.createdAt) ||
    !isRecord(value.author) ||
    value.author.id !== value.authorId ||
    typeof value.author.username !== "string" ||
    (value.author.isBot !== undefined &&
      typeof value.author.isBot !== "boolean") ||
    (value.isEncrypted !== undefined &&
      typeof value.isEncrypted !== "boolean") ||
    (value.sequence !== undefined && !integer(value.sequence)) ||
    (value.revision !== undefined && !integer(value.revision))
  )
    return invalid();
  if (
    value.replyTo !== null &&
    value.replyTo !== undefined &&
    (!isRecord(value.replyTo) ||
      !text(value.replyTo.id) ||
      typeof value.replyTo.authorName !== "string" ||
      typeof value.replyTo.content !== "string" ||
      (value.replyTo.authorId !== undefined && !text(value.replyTo.authorId)))
  )
    return invalid();
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > 10)
      return invalid();
    value.attachments.forEach(attachment);
  }
  if (value.components !== undefined) {
    try {
      validateMessageComponents(value.components);
    } catch {
      return invalid();
    }
  }
  return value as unknown as Message;
}
export type MessageUpdate = Partial<Message> & {
  id: string;
  channelId: string;
};
export function messageUpdate(value: unknown): MessageUpdate {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    !text(value.channelId) ||
    (value.content !== undefined && typeof value.content !== "string") ||
    (value.isEncrypted !== undefined &&
      typeof value.isEncrypted !== "boolean") ||
    (value.revision !== undefined && !integer(value.revision)) ||
    (value.editedAt !== undefined &&
      value.editedAt !== null &&
      typeof value.editedAt !== "string")
  )
    return invalid();
  return value as unknown as MessageUpdate;
}
export function channel(value: unknown): Channel {
  if (
    !isRecord(value) ||
    !text(value.id) ||
    typeof value.name !== "string" ||
    !["TEXT", "DM"].includes(String(value.type)) ||
    !integer(value.position) ||
    !text(value.createdAt) ||
    (value.guildId !== undefined &&
      value.guildId !== null &&
      !text(value.guildId)) ||
    (value.isE2EE !== undefined && typeof value.isE2EE !== "boolean")
  )
    return invalid();
  if (value.lastMessage !== undefined) message(value.lastMessage);
  if (
    value.recipients !== undefined &&
    (!Array.isArray(value.recipients) ||
      value.recipients.some(
        (recipient) =>
          !isRecord(recipient) ||
          !text(recipient.id) ||
          typeof recipient.username !== "string",
      ))
  )
    return invalid();
  return value as unknown as Channel;
}
export function application(value: unknown): BotApplication {
  if (
    !isRecord(value) ||
    !["id", "userId", "guildId", "managedRoleId", "createdAt"].every(
      (key) => text(value[key]),
    ) ||
    (value.ownerId !== undefined &&
      value.ownerId !== null &&
      !text(value.ownerId)) ||
    (value.createdById !== undefined &&
      value.createdById !== null &&
      !text(value.createdById)) ||
    (value.identityId !== undefined && !text(value.identityId)) ||
    typeof value.name !== "string" ||
    !isContextLimit(value.defaultContextLimit) ||
    !integer(value.configVersion) ||
    !Array.isArray(value.channelSettings)
  )
    return invalid();
  for (const setting of value.channelSettings)
    if (
      !isRecord(setting) ||
      !text(setting.channelId) ||
      (setting.contextLimit !== null &&
        !isContextLimit(setting.contextLimit)) ||
      typeof setting.respondToAll !== "boolean"
    )
      return invalid();
  if (value.device !== null) device(value.device);
  return value as unknown as BotApplication;
}
export function command(value: unknown): BotCommand {
  try {
    validateBotCommandDefinition(value);
  } catch {
    return invalid();
  }
  if (
    !isRecord(value) ||
    !["id", "applicationId", "botUserId"].every((key) => text(value[key])) ||
    typeof value.botName !== "string"
  )
    return invalid();
  return value as unknown as BotCommand;
}
export function config(value: unknown): BotConfigUpdatePayload {
  if (
    !isRecord(value) ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.commands)
  )
    return invalid();
  const app = application(value.application);
  const channels = value.channels.map(channel);
  const commands = value.commands.map(command);
  if (
    channels.some(
      (item) =>
        item.guildId !== null &&
        item.guildId !== undefined &&
        item.guildId !== app.guildId,
    ) ||
    commands.some(
      (item) => item.applicationId !== app.id || item.botUserId !== app.userId,
    )
  )
    return invalid();
  return { application: app, channels, commands };
}
export function ready(value: unknown): BotReadyPayload {
  const result = config(value);
  if (!isRecord(value) || !text(value.sessionId)) return invalid();
  return { ...result, sessionId: value.sessionId };
}
export function device(value: unknown): MessageDeviceIdentity {
  if (
    !isRecord(value) ||
    ![
      "userId",
      "deviceId",
      "fingerprint",
      "signingPublicKey",
      "agreementPublicKey",
    ].every(
      (key) =>
        typeof value[key] === "string" &&
        String(value[key]).length > 0 &&
        String(value[key]).length <= 8192,
    )
  )
    return invalid();
  return value as unknown as MessageDeviceIdentity;
}
export async function devices(
  value: unknown,
): Promise<MessageDeviceIdentity[]> {
  if (!Array.isArray(value) || value.length > 100) return invalid();
  const result = value.map(device);
  const ids = new Set<string>();
  for (const item of result) {
    const key = `${item.userId}:${item.deviceId}`;
    if (ids.has(key)) return invalid();
    ids.add(key);
    try {
      await validateMessageDevice(item);
    } catch {
      return invalid();
    }
  }
  return result;
}
export function interaction(
  value: unknown,
  app: BotApplication,
): InteractionCreatePayload {
  if (
    !isRecord(value) ||
    !["id", "channelId", "callerId", "applicationId", "expiresAt"].every(
      (key) => text(value[key]),
    ) ||
    value.applicationId !== app.id ||
    typeof value.ephemeral !== "boolean" ||
    typeof value.isEncrypted !== "boolean" ||
    !integer(value.sequence)
  )
    return invalid();
  const type =
    value.type === undefined
      ? InteractionType.APPLICATION_COMMAND
      : value.type;
  if (
    type !== InteractionType.APPLICATION_COMMAND &&
    type !== InteractionType.MESSAGE_COMPONENT &&
    type !== InteractionType.MODAL_SUBMIT
  )
    return invalid();
  const definition = command(value.command);
  if (
    definition.applicationId !== app.id ||
    definition.botUserId !== app.userId
  )
    return invalid();
  if (type === InteractionType.APPLICATION_COMMAND) {
    if (definition.ephemeral !== value.ephemeral) return invalid();
    if (
      value.isEncrypted
        ? typeof value.content !== "string" || value.options !== undefined
        : !isRecord(value.options) ||
          Object.values(value.options).some(
            (item) => !["string", "number", "boolean"].includes(typeof item),
          ) ||
          value.content !== undefined
    )
      return invalid();
  } else if (type === InteractionType.MESSAGE_COMPONENT) {
    if (
      !text(value.messageId) ||
      !text(value.customId) ||
      (value.componentType !== ComponentType.BUTTON &&
        value.componentType !== ComponentType.STRING_SELECT) ||
      (value.values !== undefined &&
        (!Array.isArray(value.values) ||
          value.values.some((item) => typeof item !== "string"))) ||
      (value.content !== undefined && typeof value.content !== "string")
    )
      return invalid();
  } else if (type === InteractionType.MODAL_SUBMIT) {
    if (
      !text(value.modalInteractionId) ||
      !text(value.customId) ||
      (value.isEncrypted
        ? typeof value.content !== "string" || value.fields !== undefined
        : !isRecord(value.fields) ||
          Object.values(value.fields).some(
            (item) => typeof item !== "string",
          ) ||
          value.content !== undefined)
    )
      return invalid();
  }
  return value as unknown as InteractionCreatePayload;
}
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  return value;
}
export function id(value: unknown): string {
  if (!text(value)) return invalid();
  return value;
}
