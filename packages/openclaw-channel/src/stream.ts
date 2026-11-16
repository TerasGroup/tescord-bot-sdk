import type {
  Channel,
  InteractionCreatePayload,
  CreateMessageAttachmentDTO,
} from "@tescord/types";
import { BotClientError, type NekordBotClient } from "@nekord/bot-sdk";
import { ChannelError, type AccountScheduler } from "./config.js";
import type { PluginIdentity } from "./identity.js";
export function splitMessage(text: string, limit = 4000): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2)
    throw new ChannelError("INVALID_MESSAGE_LIMIT");
  const result: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + limit);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    result.push(text.slice(offset, end));
    offset = end;
  }
  return result;
}
export async function scheduledWait(
  scheduler: AccountScheduler,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      handle.cancel();
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const handle = scheduler.schedule({
      id: `delay-${crypto.randomUUID()}`,
      delayMs: Math.max(0, milliseconds),
      run: () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
export interface StreamOptions {
  client: NekordBotClient;
  identity: PluginIdentity;
  channel: Channel;
  scheduler: AccountScheduler;
  signal: AbortSignal;
  intervalMs: number;
  assertCurrent(): void;
  interaction?: InteractionCreatePayload;
  replyToId?: string;
  nonce?: string;
  onError?(error: unknown): void;
}
interface SentPart {
  id: string;
  revision: number;
  text: string;
}
export class ReplyStream {
  readonly #options: StreamOptions;
  #latest = "";
  #parts: SentPart[] = [];
  #privateRevision = 0;
  #privateText = "";
  #nextAt = 0;
  #busy?: Promise<void>;
  #timer?: { cancel(): void };
  #failure?: unknown;
  #closed = false;
  #finalized = false;
  #nonce: string;
  constructor(options: StreamOptions) {
    this.#options = options;
    this.#nonce = options.nonce ?? crypto.randomUUID();
    if (options.intervalMs < 500)
      throw new ChannelError("INVALID_STREAM_INTERVAL");
  }
  get messageIds(): string[] {
    return this.#parts.map((part) => part.id);
  }
  get visible(): boolean {
    return this.#parts.length > 0 || this.#privateRevision > 0;
  }
  update(text: string): boolean {
    if (this.#closed || this.#finalized) return this.visible;
    if (text.length > 128 * 1024) throw new ChannelError("REPLY_TOO_LARGE");
    this.#latest = text;
    this.schedule();
    return this.visible;
  }
  private check(): void {
    this.#options.signal.throwIfAborted();
    this.#options.assertCurrent();
    if (this.#closed) throw new ChannelError("STREAM_CLOSED");
  }
  private schedule(): void {
    if (
      this.#timer ||
      this.#busy ||
      !this.#latest ||
      this.#closed ||
      this.#finalized
    )
      return;
    this.#timer = this.#options.scheduler.schedule({
      id: "preview",
      delayMs: Math.max(0, this.#nextAt - Date.now()),
      run: async () => {
        this.#timer = undefined;
        try {
          await this.flush(false);
        } catch (error) {
          this.#failure = error;
          this.#options.onError?.(error);
        }
      },
    });
  }
  private async publish(index: number, text: string): Promise<void> {
    const options = this.#options;
    const existing = this.#parts[index];
    if (
      existing?.text === text ||
      (this.#options.interaction?.ephemeral && this.#privateText === text)
    )
      return;
    if (Date.now() < this.#nextAt)
      await scheduledWait(
        options.scheduler,
        this.#nextAt - Date.now(),
        options.signal,
      );
    for (let attempt = 0; ; attempt++) {
      this.check();
      try {
        if (options.interaction?.ephemeral) {
          const interaction = options.interaction;
          const content = options.channel.isE2EE
            ? await options.identity.encrypt(
                options.channel.id,
                text,
                {
                  purpose: "ephemeral",
                  interactionId: interaction.id,
                  commandId: interaction.command.id,
                  botId: options.identity.identity.userId,
                  callerId: interaction.callerId,
                  revision: this.#privateRevision + 1,
                  ephemeral: true,
                },
                [options.identity.identity.userId, interaction.callerId],
                options.signal,
              )
            : text;
          this.check();
          const result = await options.client.respondInteraction(
            interaction.id,
            {
              type: "message",
              content,
              isEncrypted: Boolean(options.channel.isE2EE),
            },
            true,
            options.signal,
          );
          if (
            result.kind !== "ephemeral" ||
            result.revision !== this.#privateRevision + 1
          )
            throw new ChannelError("INTERACTION_REVISION_INVALID");
          this.#privateRevision = result.revision;
          this.#privateText = text;
        } else {
          const context = existing
            ? {
                purpose: "edit" as const,
                messageId: existing.id,
                revision: existing.revision + 1,
              }
            : undefined;
          const content = options.channel.isE2EE
            ? await options.identity.encrypt(
                options.channel.id,
                text,
                context,
                undefined,
                options.signal,
              )
            : text;
          this.check();
          let id: string;
          let revision: number;
          if (options.interaction) {
            const result = await options.client.respondInteraction(
              options.interaction.id,
              {
                type: "message",
                content,
                isEncrypted: Boolean(options.channel.isE2EE),
              },
              true,
              options.signal,
            );
            if (
              result.kind !== "public" ||
              result.message.authorId !== options.identity.identity.userId ||
              result.message.channelId !== options.channel.id
            )
              throw new ChannelError("INTERACTION_VISIBILITY_INVALID");
            id = result.message.id;
            revision = result.message.revision ?? 0;
          } else if (existing) {
            const result = await options.client.editMessage(
              options.channel.id,
              existing.id,
              {
                content,
                isEncrypted: Boolean(options.channel.isE2EE),
                expectedRevision: existing.revision,
              },
              options.signal,
            );
            if (result.revision !== existing.revision + 1)
              throw new ChannelError("MESSAGE_REVISION_INVALID");
            id = existing.id;
            revision = result.revision;
          } else {
            const result = await options.client.sendMessage(
              options.channel.id,
              {
                content,
                isEncrypted: Boolean(options.channel.isE2EE),
                nonce: `${this.#nonce}:${index}`,
                replyToId: index === 0 ? options.replyToId : undefined,
              },
              options.signal,
            );
            if (result.authorId !== options.identity.identity.userId)
              throw new ChannelError("MESSAGE_IDENTITY_INVALID");
            id = result.id;
            revision = result.revision ?? 0;
          }
          this.#parts[index] = { id, revision, text };
        }
        this.#nextAt = Date.now() + options.intervalMs;
        return;
      } catch (error) {
        if (
          !(error instanceof BotClientError) ||
          error.status !== 429 ||
          attempt >= 10
        )
          throw error;
        await scheduledWait(
          options.scheduler,
          Math.max(500, error.retryAfterMs ?? 1000),
          options.signal,
        );
      }
    }
  }
  private async flush(final: boolean): Promise<void> {
    if (this.#busy) {
      await this.#busy;
      if (final) return this.flush(true);
      return;
    }
    const operation = (async () => {
      this.check();
      if (!this.#latest.trim()) return;
      const parts = splitMessage(this.#latest);
      if (this.#options.interaction && parts.length > 1 && final)
        throw new ChannelError("MESSAGE_TOO_LARGE");
      for (let index = 0; index < (final ? parts.length : 1); index++)
        await this.publish(index, parts[index]!);
    })();
    this.#busy = operation;
    try {
      await operation;
    } finally {
      this.#busy = undefined;
      if (
        !final &&
        (this.#options.interaction?.ephemeral
          ? this.#privateText
          : this.#parts[0]?.text) !== splitMessage(this.#latest)[0]
      )
        this.schedule();
    }
  }
  async publishText(text?: string): Promise<void> {
    if (text !== undefined) {
      if (text.length > 128 * 1024) throw new ChannelError("REPLY_TOO_LARGE");
      this.#latest = text;
    }
    this.#timer?.cancel();
    this.#timer = undefined;
    if (this.#failure) throw this.#failure;
    await this.flush(true);
  }
  async finish(text?: string): Promise<void> {
    await this.publishText(text);
    this.#finalized = true;
  }
  async sendAttachments(
    attachments: CreateMessageAttachmentDTO[],
  ): Promise<string[]> {
    if (!attachments.length) return [];
    if (this.#options.interaction)
      throw new ChannelError("INTERACTION_ATTACHMENTS_UNSUPPORTED");
    this.check();
    const content = this.#options.channel.isE2EE
      ? await this.#options.identity.encrypt(
          this.#options.channel.id,
          "",
          undefined,
          undefined,
          this.#options.signal,
        )
      : "";
    this.check();
    const sent = await this.#options.client.sendMessage(
      this.#options.channel.id,
      {
        content,
        isEncrypted: Boolean(this.#options.channel.isE2EE),
        attachments,
        replyToId: this.#options.replyToId,
        nonce: `${this.#nonce}:files`,
      },
      this.#options.signal,
    );
    return [sent.id];
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#timer?.cancel();
    this.#timer = undefined;
    await this.#busy?.catch(() => {});
    this.#latest = "";
    for (const part of this.#parts) part.text = "";
  }
}
