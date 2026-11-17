import { ErrorCode, type BotReadyPayload } from "@tescord/types";
import { BotRestClient, type BotClientOptions } from "./rest.js";
import {
  BotGateway,
  type BotGatewayEvents,
  type BotGatewayOptions,
} from "./gateway.js";
import { BotClientError } from "./errors.js";
export interface NekordBotClientOptions extends BotClientOptions {
  gateway?: Omit<BotGatewayOptions, "serverUrl" | "token">;
}
export class NekordBotClient extends BotRestClient {
  readonly gateway: BotGateway;
  constructor(options: NekordBotClientOptions) {
    super(options);
    this.gateway = new BotGateway({
      ...options.gateway,
      serverUrl: options.serverUrl,
      token: options.token,
    });
    this.gateway.on("CLIENT_DISCONNECT", ({ fatal }) => {
      if (fatal) this.dispose();
    });
  }
  on<T extends keyof BotGatewayEvents>(
    event: T,
    handler: (value: BotGatewayEvents[T]) => void | Promise<void>,
  ): () => void {
    return this.gateway.on(event, handler);
  }
  async connect(
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<BotReadyPayload> {
    const config = await this.getConfig(signal);
    if (config.application.device?.deviceId !== deviceId)
      throw new BotClientError(ErrorCode.BOT_DEVICE_CONFLICT);
    return this.gateway.connect(deviceId, config, signal);
  }
  close(): void {
    this.gateway.stop();
    this.dispose();
  }
}
export { BotRestClient } from "./rest.js";
export type {
  BotClientOptions,
  SendMessageDTO,
  InteractionMessageResult,
} from "./rest.js";
export { BotGateway } from "./gateway.js";
export type { BotGatewayEvents, BotGatewayOptions } from "./gateway.js";
export { BotClientError, normalizeServerUrl } from "./errors.js";
export type { BotClientErrorCode } from "./errors.js";
export type { MessageUpdate } from "./validation.js";
export {
  CHANNEL_MENTION_TOKEN_REGEX_SOURCE,
  USER_MENTION_TOKEN_REGEX_SOURCE,
  extractChannelMentionIds,
  formatChannelMention,
  formatChannelMentionsForReader,
  replaceChannelNamesWithTokens,
  resolveGuildChannelMention,
  ErrorCode,
  InteractionType,
  InteractionResponseType,
  MessageFlags,
  ComponentType,
  ButtonStyle,
  TextInputStyle,
} from "@tescord/types";
export type {
  Attachment,
  BotApplication,
  BotChannelSetting,
  BotCommand,
  BotCommandDefinition,
  BotCommandOption,
  BotCommandOptionChoice,
  BotConfigUpdatePayload,
  BotReadyPayload,
  ButtonComponent,
  Channel,
  ChannelMentionReference,
  CreateMessageAttachmentDTO,
  CreateMessageDTO,
  EditMessageDTO,
  InteractionCreatePayload,
  InteractionModalData,
  InteractionOptions,
  InteractionResponseDTO,
  Message,
  MessageActionRow,
  MessageDeviceIdentity,
  MessageInteractionMetadata,
  ModalActionRow,
  RegisterBotDeviceDTO,
  StringSelectComponent,
  StringSelectOption,
  SupportedLocale,
  TextInputComponent,
} from "@tescord/types";
