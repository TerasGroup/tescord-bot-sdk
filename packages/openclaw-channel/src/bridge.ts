import { NekordBotClient } from "@nekord/bot-sdk";
import { isDeepStrictEqual } from "node:util";
import { BOT_TYPING_INTERVAL_MS } from "@tescord/types";
import type {
  BotConfigUpdatePayload,
  Channel,
  InteractionCreatePayload,
  Message,
} from "@tescord/types";
import type { PluginCommandRuntime } from "openclaw/plugin-sdk/plugin-command-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  ChannelError,
  senderAllowed,
  type AccountScheduler,
  type NekordAccount,
} from "./config.js";
import { accountDirectory } from "./state.js";
import { PluginIdentity } from "./identity.js";
import { DeliveryLedger } from "./ledger.js";
import { NativeCommandCatalog, type NativeCommandTurn } from "./commands.js";
import {
  readHistory,
  shouldTrigger,
  stripBotMention,
  type HistoryMessage,
} from "./inbound.js";
import { ReplyStream } from "./stream.js";

export interface InboundTurn {
  channel: Channel;
  senderId: string;
  senderName: string;
  senderIsBot: boolean;
  messageId: string;
  timestamp: number;
  text: string;
  history: HistoryMessage[];
  message?: Message;
  interaction?: InteractionCreatePayload;
  command?: NativeCommandTurn;
  signal: AbortSignal;
  scheduler: AccountScheduler;
  assertCurrent(): void;
  stream(): ReplyStream;
}
export interface BridgeOptions {
  account: NekordAccount;
  cfg: OpenClawConfig;
  stateRoot: string;
  scheduler: AccountScheduler;
  signal: AbortSignal;
  commands: PluginCommandRuntime;
  dispatch(turn: InboundTurn, bridge: AccountBridge): Promise<void>;
  status?(connected: boolean): void;
  error?(code: string): void;
  client?: NekordBotClient;
}
interface Job {
  channelId: string;
  messageId: string;
  controller: AbortController;
}
export function safeErrorCode(error: unknown): string {
  return error instanceof ChannelError
    ? error.code
    : error instanceof Error &&
        error.name === "BotClientError" &&
        "code" in error &&
        typeof error.code === "string"
      ? error.code
      : "CHANNEL_OPERATION_FAILED";
}
export class AccountBridge {
  readonly client: NekordBotClient;
  identity!: PluginIdentity;
  directory = "";
  #config?: BotConfigUpdatePayload;
  #ledger?: DeliveryLedger;
  #catalog?: NativeCommandCatalog;
  #queues = new Map<string, Promise<void>>();
  #jobs = new Set<Job>();
  #subscriptions: (() => void)[] = [];
  #stop = new AbortController();
  #ready = false;
  #closing?: Promise<void>;
  readonly signal: AbortSignal;
  constructor(readonly options: BridgeOptions) {
    this.client =
      options.client ??
      new NekordBotClient({
        serverUrl: options.account.serverUrl,
        token: options.account.botToken ?? "",
      });
    this.signal = AbortSignal.any([
      options.signal,
      options.scheduler.signal,
      this.#stop.signal,
    ]);
  }
  get config(): BotConfigUpdatePayload {
    if (!this.#config) throw new ChannelError("ACCOUNT_NOT_READY");
    return structuredClone(this.#config);
  }
  get pending(): number {
    return this.#jobs.size;
  }
  async refreshConfig(signal?: AbortSignal): Promise<BotConfigUpdatePayload> {
    const config = await this.client.getConfig(signal);
    this.applyConfig(config);
    return this.config;
  }
  assertCurrent(channelId: string): Channel {
    this.signal.throwIfAborted();
    const channel = this.#config?.channels.find(
      (item) => item.id === channelId,
    );
    if (!this.#ready || !this.client.gateway.connected || !channel)
      throw new ChannelError("CHANNEL_UNAVAILABLE");
    const device = this.#config?.application.device;
    if (
      device?.deviceId !== this.identity.identity.deviceId ||
      device.fingerprint !== this.identity.identity.fingerprint
    )
      throw new ChannelError("BOT_DEVICE_REVOKED");
    return channel;
  }
  private cancelJobs(messageId?: string): void {
    for (const job of this.#jobs)
      if (!messageId || messageId === job.messageId)
        job.controller.abort(new ChannelError("TURN_CANCELLED"));
  }
  private applyConfig(config: BotConfigUpdatePayload): void {
    const normalized: BotConfigUpdatePayload = {
      application: config.application,
      channels: config.channels,
      commands: config.commands,
    };
    if (!isDeepStrictEqual(this.#config, normalized)) this.cancelJobs();
    this.#config = normalized;
    const device = config.application.device;
    if (
      device?.deviceId !== this.identity.identity.deviceId ||
      device.fingerprint !== this.identity.identity.fingerprint
    ) {
      this.#stop.abort(new ChannelError("BOT_DEVICE_REVOKED"));
      this.client.close();
      this.#ready = false;
    }
  }
  async start(): Promise<void> {
    this.signal.throwIfAborted();
    try {
      const config = await this.client.getConfig(this.signal);
      this.directory = await accountDirectory(
        this.options.stateRoot,
        this.options.account.accountId,
      );
      this.identity = await PluginIdentity.load(
        this.directory,
        config.application,
        this.client,
      );
      this.#ledger = await DeliveryLedger.load(
        this.directory,
        config.application.id,
      );
      await this.identity.register(this.signal);
      this.#catalog = new NativeCommandCatalog(
        this.options.cfg,
        this.options.account,
        this.options.commands,
      );
      await this.#catalog.register(this.client, this.signal);
      this.#subscriptions.push(
        this.client.on("READY", (ready) => {
          this.applyConfig(ready);
          this.#ready = !this.signal.aborted;
          this.options.status?.(this.#ready);
        }),
        this.client.on("BOT_CONFIG_UPDATE", (update) =>
          this.applyConfig(update),
        ),
        this.client.on("DM_CHANNEL_CREATE", (channel) => {
          if (this.#config)
            this.#config.channels = [
              ...this.#config.channels.filter((item) => item.id !== channel.id),
              channel,
            ];
        }),
        this.client.on("MESSAGE_CREATE", (message) => {
          this.enqueue(message.channelId, message.id, (signal, scheduler) =>
            this.message(message, signal, scheduler),
          );
        }),
        this.client.on("INTERACTION_CREATE", (interaction) =>
          this.interaction(interaction),
        ),
        this.client.on("MESSAGE_DELETE", ({ messageId }) =>
          this.cancelJobs(messageId),
        ),
        this.client.on("MESSAGE_UPDATE", ({ id }) => this.cancelJobs(id)),
        this.client.on("CLIENT_DISCONNECT", ({ fatal }) => {
          this.#ready = false;
          this.cancelJobs();
          this.options.status?.(false);
          if (fatal) this.#stop.abort(new ChannelError("BOT_SESSION_REVOKED"));
        }),
        this.client.on("CLIENT_ERROR", ({ code }) =>
          this.options.error?.(code),
        ),
      );
      await this.client.connect(this.identity.identity.deviceId, this.signal);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private enqueue(
    channelId: string,
    messageId: string,
    run: (signal: AbortSignal, scheduler: AccountScheduler) => Promise<void>,
  ): void {
    if (this.signal.aborted || !this.#ready) return;
    if (this.#jobs.size >= this.options.account.maxQueue) {
      this.options.error?.("INBOUND_QUEUE_FULL");
      return;
    }
    const job: Job = {
      channelId,
      messageId,
      controller: new AbortController(),
    };
    this.#jobs.add(job);
    const prior = this.#queues.get(channelId) ?? Promise.resolve();
    const pending = prior.then(async () => {
      const scheduler = this.options.scheduler.scope();
      const signal = AbortSignal.any([
        this.signal,
        job.controller.signal,
        scheduler.signal,
      ]);
      try {
        signal.throwIfAborted();
        this.assertCurrent(channelId);
        await run(signal, scheduler);
      } catch (error) {
        if (!signal.aborted) this.options.error?.(safeErrorCode(error));
      } finally {
        scheduler.beginClose();
        await scheduler.stop();
        this.#jobs.delete(job);
      }
    });
    this.#queues.set(channelId, pending);
    void pending.finally(() => {
      if (this.#queues.get(channelId) === pending)
        this.#queues.delete(channelId);
    });
  }
  private async message(
    message: Message,
    signal: AbortSignal,
    scheduler: AccountScheduler,
  ): Promise<void> {
    const channel = this.assertCurrent(message.channelId);
    const application = this.config.application;
    if (
      message.authorId === application.userId ||
      !senderAllowed(this.options.account, message.authorId) ||
      (!this.options.account.allowBotMessages && message.author.isBot)
    )
      return;
    if (channel.isE2EE && !message.isEncrypted && message.content)
      throw new ChannelError("PLAINTEXT_REJECTED");
    const decoded = await this.identity.decryptMessage(message, signal);
    if (
      channel.type !== "DM" &&
      !shouldTrigger(message, decoded.text, application, this.options.account)
    )
      return;
    if (!(await this.#ledger!.admit(`message:${message.id}`))) return;
    const history = await readHistory(
      this.client,
      this.identity,
      application,
      channel,
      message.sequence ?? 0,
      signal,
    );
    await this.dispatch(
      {
        channel,
        senderId: message.authorId,
        senderName: message.author.displayName || message.author.username,
        senderIsBot: Boolean(message.author.isBot),
        messageId: message.id,
        timestamp: Date.parse(message.createdAt),
        text:
          stripBotMention(decoded.text, application.userId) ||
          decoded.text.trim(),
        history,
        message,
      },
      signal,
      scheduler,
    );
  }
  private async interaction(
    interaction: InteractionCreatePayload,
  ): Promise<void> {
    try {
      const channel = this.assertCurrent(interaction.channelId);
      if (!senderAllowed(this.options.account, interaction.callerId)) return;
      if (Boolean(channel.isE2EE) !== interaction.isEncrypted)
        throw new ChannelError("INTERACTION_ENCRYPTION_REQUIRED");
      await this.client.deferInteraction(interaction.id, this.signal);
      this.enqueue(channel.id, interaction.id, async (signal, scheduler) => {
        const options = await this.identity.decryptInteraction(
          interaction,
          signal,
        );
        const command = this.#catalog!.prepare(interaction.command, options);
        if (!(await this.#ledger!.admit(`interaction:${interaction.id}`)))
          return;
        await this.dispatch(
          {
            channel,
            senderId: interaction.callerId,
            senderName: interaction.callerId,
            senderIsBot: false,
            messageId: interaction.id,
            timestamp: Date.now(),
            text: command.body,
            history: [],
            interaction,
            command,
          },
          signal,
          scheduler,
        );
      });
    } catch (error) {
      if (!this.signal.aborted) this.options.error?.(safeErrorCode(error));
    }
  }
  private async dispatch(
    turn: Omit<
      InboundTurn,
      "signal" | "scheduler" | "assertCurrent" | "stream"
    >,
    signal: AbortSignal,
    scheduler: AccountScheduler,
  ): Promise<void> {
    const streams: ReplyStream[] = [];
    const version = this.config.application.configVersion;
    const assertCurrent = () => {
      signal.throwIfAborted();
      this.assertCurrent(turn.channel.id);
      if (version !== this.#config?.application.configVersion)
        throw new ChannelError("BOT_CONFIG_CHANGED");
    };
    const typing = async () => {
      assertCurrent();
      await this.client.typing(
        turn.channel.id,
        AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      );
    };
    let pendingTyping: Promise<void> | undefined;
    const ticker = scheduler.schedule({
      id: "typing",
      delayMs: 0,
      everyMs: BOT_TYPING_INTERVAL_MS,
      run: async () => {
        try {
          if (!turn.interaction?.ephemeral) {
            pendingTyping = typing();
            await pendingTyping;
          }
        } catch (error) {
          if (!signal.aborted) this.options.error?.(safeErrorCode(error));
        }
      },
    });
    try {
      assertCurrent();
      await this.options.dispatch(
        {
          ...turn,
          signal,
          scheduler,
          assertCurrent,
          stream: () => {
            const stream = new ReplyStream({
              client: this.client,
              identity: this.identity,
              channel: turn.channel,
              scheduler: scheduler.scope(),
              signal,
              intervalMs: this.options.account.streamIntervalMs,
              assertCurrent,
              interaction: turn.interaction,
              replyToId: turn.message?.id,
            });
            streams.push(stream);
            return stream;
          },
        },
        this,
      );
    } finally {
      ticker.cancel();
      await pendingTyping?.catch(() => {});
      await Promise.allSettled(streams.map((stream) => stream.close()));
      if (!turn.interaction?.ephemeral) {
        await this.client
          .stopTyping(turn.channel.id, AbortSignal.timeout(2000))
          .catch(() => {});
      }
    }
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#stop.abort(new ChannelError("ACCOUNT_STOPPED"));
      this.#ready = false;
      this.cancelJobs();
      for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
      this.client.close();
      await Promise.allSettled([...this.#queues.values()]);
      await Promise.allSettled([this.identity?.close(), this.#ledger?.close()]);
      this.options.status?.(false);
    })());
  }
}
