import {
  ErrorCode,
  InteractionResponseType,
  isRecord,
  validateBotCommandDefinition,
  validateInteractionModalData,
  validateMessageComponents,
  type Attachment,
  type BotCommand,
  type BotCommandDefinition,
  type BotConfigUpdatePayload,
  type CreateMessageAttachmentDTO,
  type CreateMessageDTO,
  type EditMessageDTO,
  type InteractionModalData,
  type InteractionResponseDTO,
  type Message,
  type MessageActionRow,
  type MessageDeviceIdentity,
  type RegisterBotDeviceDTO,
  type Channel,
} from "@tescord/types";
import {
  assertId,
  BotClientError,
  normalizeServerUrl,
  wait,
} from "./errors.js";
import * as parse from "./validation.js";
export interface BotClientOptions {
  serverUrl: string;
  token: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxAttachmentBytes?: number;
  maxRetries?: number;
}
export type SendMessageDTO = Omit<CreateMessageDTO, "authorId">;
export type InteractionMessageResult =
  | { kind: "public"; message: Message }
  | { kind: "ephemeral"; interactionId: string; revision: number };
interface RequestOptions {
  method?: string;
  json?: unknown;
  raw?: BodyInit;
  contentType?: string;
  retry?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export class BotRestClient {
  readonly serverUrl: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #shutdown = new AbortController();
  readonly #timeout: number;
  readonly #maxResponseBytes: number;
  readonly #maxAttachmentBytes: number;
  readonly #maxRetries: number;
  constructor(options: BotClientOptions) {
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    if (!/^nkbot_[A-Za-z0-9_-]{43}$/.test(options.token))
      throw new BotClientError(ErrorCode.INVALID_PARAMS);
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.requestTimeoutMs ?? 15000;
    this.#maxResponseBytes = options.maxResponseBytes ?? 32 * 1024 * 1024;
    this.#maxAttachmentBytes = options.maxAttachmentBytes ?? 50 * 1024 * 1024;
    this.#maxRetries = options.maxRetries ?? 3;
    if (
      ![this.#timeout, this.#maxResponseBytes, this.#maxAttachmentBytes].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      !Number.isSafeInteger(this.#maxRetries) ||
      this.#maxRetries < 0 ||
      this.#maxRetries > 10
    )
      throw new BotClientError(ErrorCode.INVALID_PARAMS);
  }
  dispose(): void {
    this.#shutdown.abort(new BotClientError("CLIENT_CLOSED"));
  }
  private sameOrigin(input: string): URL {
    let url: URL;
    try {
      url = new URL(input, this.serverUrl);
    } catch {
      throw new BotClientError("PROTOCOL_ERROR");
    }
    if (
      url.origin !== this.serverUrl.origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new BotClientError("PROTOCOL_ERROR");
    return url;
  }
  private async readBytes(
    response: Response,
    limit: number,
    signal: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new BotClientError("RESPONSE_TOO_LARGE");
        chunks.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  private async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const url = this.sameOrigin(path);
    const method = options.method ?? "GET";
    const retry = options.retry ?? method === "GET";
    for (let attempt = 0; ; attempt++) {
      this.#shutdown.signal.throwIfAborted();
      options.signal?.throwIfAborted();
      const signal = AbortSignal.any([
        this.#shutdown.signal,
        ...(options.signal ? [options.signal] : []),
        AbortSignal.timeout(options.timeoutMs ?? this.#timeout),
      ]);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          signal,
          redirect: "error",
          headers: {
            Authorization: `Bot ${this.#token}`,
            ...(options.json !== undefined
              ? { "Content-Type": "application/json" }
              : options.contentType
                ? { "Content-Type": options.contentType }
                : {}),
          },
          ...(options.json !== undefined
            ? { body: JSON.stringify(options.json) }
            : options.raw !== undefined
              ? { body: options.raw }
              : {}),
        });
      } catch {
        this.#shutdown.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        if (!retry || attempt >= this.#maxRetries)
          throw new BotClientError("TRANSPORT_ERROR");
        await wait(
          Math.min(500 * 2 ** attempt, 5000),
          AbortSignal.any([
            this.#shutdown.signal,
            ...(options.signal ? [options.signal] : []),
          ]),
        );
        continue;
      }
      const bytes = await this.readBytes(
        response,
        this.#maxResponseBytes,
        signal,
      );
      let value: unknown;
      try {
        value = bytes.length
          ? JSON.parse(new TextDecoder().decode(bytes))
          : null;
      } catch {
        throw new BotClientError("PROTOCOL_ERROR", response.status);
      }
      if (response.ok) return value;
      const code =
        isRecord(value) &&
        Object.values(ErrorCode).includes(value.code as ErrorCode)
          ? (value.code as ErrorCode)
          : response.status === 401
            ? ErrorCode.UNAUTHORIZED
            : response.status === 403
              ? ErrorCode.FORBIDDEN
              : response.status === 429
                ? ErrorCode.RATE_LIMITED
                : ErrorCode.INTERNAL_ERROR;
      const retryHeader = response.headers.get("retry-after");
      const seconds =
        retryHeader !== null && /^\d+(?:\.\d+)?$/.test(retryHeader)
          ? Number(retryHeader) * 1000
          : retryHeader
            ? Date.parse(retryHeader) - Date.now()
            : NaN;
      const delay = Number.isFinite(seconds)
        ? Math.max(0, Math.min(seconds, 60000))
        : Math.min(500 * 2 ** attempt, 5000);
      if (
        retry &&
        attempt < this.#maxRetries &&
        (response.status === 429 || response.status >= 500)
      ) {
        await wait(
          delay,
          AbortSignal.any([
            this.#shutdown.signal,
            ...(options.signal ? [options.signal] : []),
          ]),
        );
        continue;
      }
      throw new BotClientError(
        code,
        response.status,
        response.status === 429 ? delay : undefined,
      );
    }
  }
  async getConfig(signal?: AbortSignal): Promise<BotConfigUpdatePayload> {
    return parse.config(await this.request("/api/bots/@me/config", { signal }));
  }
  async registerDevice(
    input: RegisterBotDeviceDTO,
    signal?: AbortSignal,
  ): Promise<MessageDeviceIdentity> {
    const value = parse.device(
      await this.request("/api/bots/@me/device", {
        method: "POST",
        json: input,
        retry: false,
        signal,
      }),
    );
    if (
      value.deviceId !== input.deviceId ||
      value.fingerprint !== input.fingerprint
    )
      throw new BotClientError("PROTOCOL_ERROR");
    return value;
  }
  async getDevices(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<MessageDeviceIdentity[]> {
    assertId(channelId);
    return parse.devices(
      await this.request(`/api/channels/${channelId}/e2ee/devices`, { signal }),
    );
  }
  async getMessages(
    channelId: string,
    query: { before?: number; limit?: number; aroundMessageId?: string } = {},
    signal?: AbortSignal,
  ): Promise<Message[]> {
    assertId(channelId);
    const params = new URLSearchParams();
    if (query.before !== undefined) {
      if (
        !Number.isSafeInteger(query.before) ||
        query.before < 0 ||
        query.before > 2147483647
      )
        throw new BotClientError(ErrorCode.INVALID_PARAMS);
      params.set("before", String(query.before));
    }
    if (query.limit !== undefined) {
      if (
        !Number.isSafeInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > 100
      )
        throw new BotClientError(ErrorCode.INVALID_PARAMS);
      params.set("limit", String(query.limit));
    }
    if (query.aroundMessageId !== undefined) {
      assertId(query.aroundMessageId);
      if (query.before !== undefined)
        throw new BotClientError(ErrorCode.INVALID_PARAMS);
      params.set("aroundMessageId", query.aroundMessageId);
    }
    const value = await this.request(
      `/api/channels/${channelId}/messages?${params}`,
      { signal },
    );
    if (!Array.isArray(value)) throw new BotClientError("PROTOCOL_ERROR");
    const messages = value.map(parse.message);
    if (messages.some((message) => message.channelId !== channelId))
      throw new BotClientError("PROTOCOL_ERROR");
    return messages;
  }
  async getMessage(
    channelId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<Message | undefined> {
    try {
      return (
        await this.getMessages(
          channelId,
          { aroundMessageId: messageId, limit: 1 },
          signal,
        )
      ).find((message) => message.id === messageId);
    } catch (error) {
      if (error instanceof BotClientError && error.status === 404)
        return undefined;
      throw error;
    }
  }
  async sendMessage(
    channelId: string,
    input: SendMessageDTO,
    signal?: AbortSignal,
  ): Promise<Message> {
    assertId(channelId);
    if (input.replyToId) assertId(input.replyToId);
    const value = parse.message(
      await this.request(`/api/channels/${channelId}/messages`, {
        method: "POST",
        json: {
          content: input.content,
          isEncrypted: input.isEncrypted,
          replyToId: input.replyToId,
          attachments: input.attachments,
          ...(input.components ? { components: input.components } : {}),
          nonce: input.nonce ?? crypto.randomUUID(),
        },
        retry: true,
        signal,
      }),
    );
    if (value.channelId !== channelId)
      throw new BotClientError("PROTOCOL_ERROR");
    return value;
  }
  async editMessage(
    channelId: string,
    messageId: string,
    input: EditMessageDTO,
    signal?: AbortSignal,
  ): Promise<parse.MessageUpdate> {
    assertId(channelId);
    assertId(messageId);
    const value = parse.messageUpdate(
      await this.request(`/api/channels/${channelId}/messages/${messageId}`, {
        method: "PATCH",
        json: input,
        retry: false,
        signal,
      }),
    );
    if (value.id !== messageId || value.channelId !== channelId)
      throw new BotClientError("PROTOCOL_ERROR");
    return value;
  }
  async typing(channelId: string, signal?: AbortSignal): Promise<void> {
    assertId(channelId);
    await this.request(`/api/channels/${channelId}/typing`, {
      method: "POST",
      retry: true,
      signal,
    });
  }
  async stopTyping(channelId: string, signal?: AbortSignal): Promise<void> {
    assertId(channelId);
    await this.request(`/api/channels/${channelId}/typing`, {
      method: "DELETE",
      retry: false,
      signal,
    });
  }
  async createDm(userId: string, signal?: AbortSignal): Promise<Channel> {
    assertId(userId);
    const value = parse.channel(
      await this.request("/api/users/@me/channels", {
        method: "POST",
        json: { recipientId: userId },
        retry: true,
        signal,
      }),
    );
    if (
      value.type !== "DM" ||
      !value.recipients?.some((recipient) => recipient.id === userId)
    )
      throw new BotClientError("PROTOCOL_ERROR");
    return value;
  }
  async registerCommands(
    commands: readonly BotCommandDefinition[],
    signal?: AbortSignal,
  ): Promise<BotCommand[]> {
    if (commands.length > 100)
      throw new BotClientError(ErrorCode.INVALID_PARAMS);
    for (const command of commands) validateBotCommandDefinition(command);
    const values = await this.request("/api/bots/@me/commands", {
      method: "PUT",
      json: commands,
      retry: true,
      signal,
    });
    if (!Array.isArray(values)) throw new BotClientError("PROTOCOL_ERROR");
    return values.map(parse.command);
  }
  async deferInteraction(
    interactionId: string,
    optionsOrSignal?: AbortSignal | { ephemeral?: boolean; flags?: number },
    maybeSignal?: AbortSignal,
  ): Promise<void> {
    assertId(interactionId);
    const isAbortSignal =
      optionsOrSignal !== undefined && "aborted" in optionsOrSignal;
    const signal = isAbortSignal ? optionsOrSignal : maybeSignal;
    const opts = isAbortSignal ? undefined : optionsOrSignal;
    try {
      parse.id(
        parse.record(
          await this.request(`/api/interactions/${interactionId}/callback`, {
            method: "POST",
            json: {
              type: "defer",
              ...(opts?.ephemeral !== undefined
                ? { ephemeral: opts.ephemeral }
                : {}),
              ...(opts?.flags !== undefined ? { flags: opts.flags } : {}),
            },
            timeoutMs: 2000,
            retry: false,
            signal,
          }),
        ).id,
      );
    } catch (error) {
      if (!(
        error instanceof BotClientError &&
        error.code === ErrorCode.INTERACTION_ALREADY_ACKNOWLEDGED
      ))
        throw error;
    }
  }
  async deferUpdateInteraction(
    interactionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertId(interactionId);
    parse.id(
      parse.record(
        await this.request(`/api/interactions/${interactionId}/callback`, {
          method: "POST",
          json: { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE },
          timeoutMs: 2000,
          retry: false,
          signal,
        }),
      ).id,
    );
  }
  async respondInteraction(
    interactionId: string,
    input: Extract<
      InteractionResponseDTO,
      {
        type: "message" | InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE;
      }
    >,
    edit = false,
    signal?: AbortSignal,
  ): Promise<InteractionMessageResult> {
    assertId(interactionId);
    if (input.components !== undefined) {
      validateMessageComponents(input.components);
    }
    const value = parse.record(
      await this.request(
        `/api/interactions/${interactionId}/${edit ? "response" : "callback"}`,
        { method: edit ? "PATCH" : "POST", json: input, retry: false, signal },
      ),
    );
    if (value.author !== undefined)
      return { kind: "public", message: parse.message(value) };
    if (
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1
    )
      throw new BotClientError("PROTOCOL_ERROR");
    return {
      kind: "ephemeral",
      interactionId: value.id,
      revision: Number(value.revision),
    };
  }
  async updateInteractionMessage(
    interactionId: string,
    input: {
      content: string;
      isEncrypted: boolean;
      components?: MessageActionRow[];
    },
    signal?: AbortSignal,
  ): Promise<InteractionMessageResult> {
    assertId(interactionId);
    if (input.components !== undefined) {
      validateMessageComponents(input.components);
    }
    const value = parse.record(
      await this.request(`/api/interactions/${interactionId}/callback`, {
        method: "POST",
        json: {
          type: InteractionResponseType.UPDATE_MESSAGE,
          ...input,
        },
        retry: false,
        signal,
      }),
    );
    if (value.author !== undefined)
      return { kind: "public", message: parse.message(value) };
    if (
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1
    )
      throw new BotClientError("PROTOCOL_ERROR");
    return {
      kind: "ephemeral",
      interactionId: value.id,
      revision: Number(value.revision),
    };
  }
  async openInteractionModal(
    interactionId: string,
    modal: InteractionModalData,
    signal?: AbortSignal,
  ): Promise<void> {
    assertId(interactionId);
    validateInteractionModalData(modal);
    parse.id(
      parse.record(
        await this.request(`/api/interactions/${interactionId}/callback`, {
          method: "POST",
          json: {
            type: InteractionResponseType.MODAL,
            modal,
          },
          retry: false,
          signal,
        }),
      ).id,
    );
  }
  async deleteInteractionResponse(
    interactionId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    assertId(interactionId);
    await this.request(`/api/interactions/${interactionId}/response`, {
      method: "DELETE",
      retry: false,
      signal,
    });
  }
  async createFollowup(
    interactionId: string,
    input: {
      content: string;
      isEncrypted: boolean;
      components?: MessageActionRow[];
      ephemeral?: boolean;
      flags?: number;
    },
    signal?: AbortSignal,
  ): Promise<InteractionMessageResult> {
    assertId(interactionId);
    if (input.components !== undefined) {
      validateMessageComponents(input.components);
    }
    const value = parse.record(
      await this.request(`/api/interactions/${interactionId}/followups`, {
        method: "POST",
        json: input,
        retry: false,
        signal,
      }),
    );
    if (value.author !== undefined)
      return { kind: "public", message: parse.message(value) };
    if (
      typeof value.id !== "string" ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1
    )
      throw new BotClientError("PROTOCOL_ERROR");
    return {
      kind: "ephemeral",
      interactionId: value.id,
      revision: Number(value.revision),
    };
  }
  async uploadAttachment(
    channelId: string,
    input: { fileName: string; mimeType: string; bytes: Uint8Array },
    signal?: AbortSignal,
  ): Promise<CreateMessageAttachmentDTO> {
    assertId(channelId);
    if (
      !input.bytes.length ||
      input.bytes.length > this.#maxAttachmentBytes ||
      !input.fileName ||
      !input.mimeType
    )
      throw new BotClientError(ErrorCode.INVALID_PARAMS);
    const grant = parse.record(
      await this.request("/api/attachments/presigned-url", {
        method: "POST",
        json: {
          channelId,
          purpose: "attachment",
          fileName: input.fileName,
          mimeType: input.mimeType,
          fileSize: input.bytes.byteLength,
        },
        retry: false,
        signal,
      }),
    );
    if (
      typeof grant.uploadUrl !== "string" ||
      typeof grant.fileUrl !== "string" ||
      grant.requiresAuth !== true
    )
      throw new BotClientError("PROTOCOL_ERROR");
    const uploadUrl = this.sameOrigin(grant.uploadUrl);
    if (!uploadUrl.pathname.startsWith("/api/attachments/upload/"))
      throw new BotClientError("PROTOCOL_ERROR");
    const uploaded = parse.record(
      await this.request(uploadUrl.href, {
        method: "PUT",
        raw: new Uint8Array(input.bytes).buffer,
        contentType: input.mimeType,
        retry: false,
        signal,
      }),
    );
    if (uploaded.success !== true) throw new BotClientError("PROTOCOL_ERROR");
    const result: CreateMessageAttachmentDTO = {
      url: this.sameOrigin(grant.fileUrl).href,
      fileName:
        typeof uploaded.fileName === "string"
          ? uploaded.fileName
          : input.fileName,
      mimeType:
        typeof uploaded.mimeType === "string"
          ? uploaded.mimeType
          : input.mimeType,
      fileSize:
        typeof uploaded.fileSize === "number"
          ? uploaded.fileSize
          : input.bytes.byteLength,
    };
    if (typeof uploaded.width === "number") result.width = uploaded.width;
    if (typeof uploaded.height === "number") result.height = uploaded.height;
    return result;
  }
  async downloadAttachment(
    channelId: string,
    file: Attachment,
    signal?: AbortSignal,
  ): Promise<Uint8Array<ArrayBuffer>> {
    assertId(channelId);
    assertId(file.id);
    if (file.fileSize > this.#maxAttachmentBytes)
      throw new BotClientError("RESPONSE_TOO_LARGE");
    const access = parse.record(
      await this.request("/api/attachments/access", {
        method: "POST",
        json: { attachmentIds: [file.id] },
        retry: true,
        signal,
      }),
    );
    if (!Array.isArray(access.attachments))
      throw new BotClientError("PROTOCOL_ERROR");
    const entry = access.attachments.find(
      (item) => isRecord(item) && item.id === file.id,
    );
    if (!isRecord(entry) || typeof entry.downloadUrl !== "string")
      throw new BotClientError("PROTOCOL_ERROR");
    const url = this.sameOrigin(entry.downloadUrl);
    if (
      url.searchParams.get("channelId") !== channelId ||
      !url.pathname.startsWith("/attachments/")
    )
      throw new BotClientError("PROTOCOL_ERROR");
    const requestSignal = AbortSignal.any([
      this.#shutdown.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.#timeout),
    ]);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        signal: requestSignal,
        redirect: "error",
      });
    } catch {
      requestSignal.throwIfAborted();
      throw new BotClientError("TRANSPORT_ERROR");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BotClientError(ErrorCode.FORBIDDEN, response.status);
    }
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase() !==
      file.mimeType.toLowerCase()
    ) {
      await response.body?.cancel();
      throw new BotClientError("PROTOCOL_ERROR");
    }
    const bytes = await this.readBytes(
      response,
      this.#maxAttachmentBytes,
      requestSignal,
    );
    if (bytes.byteLength !== file.fileSize)
      throw new BotClientError("PROTOCOL_ERROR");
    return bytes;
  }
}
