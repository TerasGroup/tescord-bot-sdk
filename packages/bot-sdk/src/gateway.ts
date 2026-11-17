import {
  GatewayCloseCode,
  GatewayOpCode,
  type BotConfigUpdatePayload,
  type BotReadyPayload,
  type Channel,
  type InteractionCreatePayload,
  type Message,
  type TypingIndicatorPayload,
  type TypingStopPayload,
} from "@tescord/types";
import { BotClientError, normalizeServerUrl } from "./errors.js";
import * as parse from "./validation.js";
export interface BotGatewayEvents {
  READY: BotReadyPayload;
  BOT_CONFIG_UPDATE: BotConfigUpdatePayload;
  MESSAGE_CREATE: Message;
  MESSAGE_UPDATE: parse.MessageUpdate;
  MESSAGE_DELETE: { channelId: string; messageId: string };
  INTERACTION_CREATE: InteractionCreatePayload;
  DM_CHANNEL_CREATE: Channel;
  TYPING_START: TypingIndicatorPayload;
  TYPING_STOP: TypingStopPayload;
  CLIENT_DISCONNECT: { code: number; fatal: boolean };
  CLIENT_ERROR: {
    code: "PROTOCOL_ERROR" | "TRANSPORT_ERROR" | "HANDLER_ERROR";
  };
}
export interface BotGatewayOptions {
  serverUrl: string;
  token: string;
  webSocketFactory?: (url: string) => WebSocket;
  readyTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxFrameBytes?: number;
  dedupeLimit?: number;
}
const fatalCodes = new Set<number>([
  GatewayCloseCode.TOKEN_EXPIRED,
  GatewayCloseCode.UNAUTHORIZED,
  GatewayCloseCode.ACCOUNT_BANNED,
  GatewayCloseCode.SESSION_INVALID,
]);
export class BotGateway {
  readonly #token: string;
  readonly #url: string;
  readonly #factory: (url: string) => WebSocket;
  readonly #options: BotGatewayOptions;
  #socket?: WebSocket;
  #generation = 0;
  #running = false;
  #terminal = false;
  #deviceId = "";
  #config?: BotConfigUpdatePayload;
  #heartbeat?: ReturnType<typeof setInterval>;
  #reconnect?: ReturnType<typeof setTimeout>;
  #readyTimeout?: ReturnType<typeof setTimeout>;
  #ack = true;
  #hello = false;
  #ready = false;
  #attempts = 0;
  #pending?: {
    resolve(value: BotReadyPayload): void;
    reject(error: BotClientError): void;
  };
  #abortCleanup?: () => void;
  #listeners = new Map<
    keyof BotGatewayEvents,
    Set<(value: unknown) => unknown>
  >();
  #seen = new Map<string, number>();
  constructor(options: BotGatewayOptions) {
    const base = normalizeServerUrl(options.serverUrl);
    base.pathname = "/gateway";
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    this.#url = base.href;
    this.#token = options.token;
    this.#options = { ...options, token: "" };
    this.#factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }
  get config(): BotConfigUpdatePayload | undefined {
    return this.#config ? structuredClone(this.#config) : undefined;
  }
  get connected(): boolean {
    return this.#ready && this.#socket?.readyState === WebSocket.OPEN;
  }
  on<T extends keyof BotGatewayEvents>(
    event: T,
    handler: (value: BotGatewayEvents[T]) => void | Promise<void>,
  ): () => void {
    const wrapped = (value: unknown) => handler(value as BotGatewayEvents[T]);
    let handlers = this.#listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.#listeners.set(event, handlers);
    }
    handlers.add(wrapped);
    return () => {
      handlers?.delete(wrapped);
      if (!handlers?.size) this.#listeners.delete(event);
    };
  }
  private emit<T extends keyof BotGatewayEvents>(
    event: T,
    value: BotGatewayEvents[T],
  ): void {
    for (const handler of this.#listeners.get(event) ?? []) {
      try {
        void Promise.resolve(handler(value)).catch(() => {
          if (event !== "CLIENT_ERROR")
            this.emit("CLIENT_ERROR", { code: "HANDLER_ERROR" });
        });
      } catch {
        if (event !== "CLIENT_ERROR")
          this.emit("CLIENT_ERROR", { code: "HANDLER_ERROR" });
      }
    }
  }
  private clearConnectionTimers(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }
  private send(value: unknown): void {
    if (this.#socket?.readyState === WebSocket.OPEN)
      this.#socket.send(JSON.stringify(value));
  }
  async connect(
    deviceId: string,
    expected: BotConfigUpdatePayload,
    signal?: AbortSignal,
  ): Promise<BotReadyPayload> {
    if (this.#running || !deviceId) throw new BotClientError("PROTOCOL_ERROR");
    signal?.throwIfAborted();
    this.#config = expected;
    this.#deviceId = deviceId;
    this.#running = true;
    this.#terminal = false;
    const result = new Promise<BotReadyPayload>((resolve, reject) => {
      this.#pending = { resolve, reject };
    });
    const abort = () => this.stop();
    signal?.addEventListener("abort", abort, { once: true });
    this.#abortCleanup = () => signal?.removeEventListener("abort", abort);
    this.#readyTimeout = setTimeout(
      () => this.fail(new BotClientError("TRANSPORT_ERROR")),
      this.#options.readyTimeoutMs ?? 15000,
    );
    this.open();
    return result;
  }
  private open(): void {
    if (!this.#running) return;
    const generation = ++this.#generation;
    this.clearConnectionTimers();
    this.#ready = false;
    this.#hello = false;
    this.#ack = true;
    let socket: WebSocket;
    try {
      socket = this.#factory(this.#url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.#socket = socket;
    let inbound = Promise.resolve();
    socket.addEventListener("message", (event) => {
      inbound = inbound
        .then(async () => {
          if (
            !this.#running ||
            this.#generation !== generation ||
            this.#socket !== socket
          )
            return;
          await this.receive(event.data);
        })
        .catch(() => {
          if (this.#generation === generation && this.#running)
            this.fail(new BotClientError("PROTOCOL_ERROR"));
        });
    });
    socket.addEventListener("error", () => {
      if (this.#generation === generation && this.#running)
        this.emit("CLIENT_ERROR", { code: "TRANSPORT_ERROR" });
    });
    socket.addEventListener("close", (event) => {
      if (this.#generation !== generation) return;
      this.clearConnectionTimers();
      this.#ready = false;
      const fatal = this.#terminal || fatalCodes.has(event.code);
      this.emit("CLIENT_DISCONNECT", { code: event.code, fatal });
      if (fatal) {
        this.fail(new BotClientError("CLIENT_CLOSED"), false);
        return;
      }
      if (this.#running) this.scheduleReconnect();
    });
  }
  private scheduleReconnect(): void {
    if (!this.#running || this.#reconnect) return;
    const base = this.#options.reconnectBaseMs ?? 500;
    const maximum = this.#options.reconnectMaxMs ?? 30000;
    const delay =
      Math.min(maximum, base * 2 ** Math.min(this.#attempts++, 12)) *
      (0.8 + Math.random() * 0.4);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      this.open();
    }, delay);
  }
  private seen(key: string): boolean {
    const now = Date.now();
    const previous = this.#seen.get(key);
    if (previous && previous > now) return true;
    const limit = this.#options.dedupeLimit ?? 10000;
    for (const [id, expires] of this.#seen) {
      if (expires > now && this.#seen.size < limit) break;
      this.#seen.delete(id);
    }
    this.#seen.set(key, now + 60 * 60_000);
    return false;
  }
  private acceptConfig(value: BotConfigUpdatePayload): boolean {
    const current = this.#config;
    if (
      current &&
      (value.application.id !== current.application.id ||
        value.application.userId !== current.application.userId ||
        value.application.guildId !== current.application.guildId)
    )
      throw new BotClientError("PROTOCOL_ERROR");
    if (
      current &&
      value.application.configVersion < current.application.configVersion
    )
      return false;
    this.#config = value;
    return true;
  }
  private async receive(data: unknown): Promise<void> {
    let text: string;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer)
      text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    else if (data instanceof Blob) text = await data.text();
    else throw new BotClientError("PROTOCOL_ERROR");
    if (
      new TextEncoder().encode(text).byteLength >
      (this.#options.maxFrameBytes ?? 4 * 1024 * 1024)
    )
      throw new BotClientError("RESPONSE_TOO_LARGE");
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      throw new BotClientError("PROTOCOL_ERROR");
    }
    const packet = parse.record(decoded);
    if (typeof packet.op !== "number")
      throw new BotClientError("PROTOCOL_ERROR");
    if (packet.op === GatewayOpCode.HELLO) {
      const hello = parse.record(packet.d);
      const interval = hello.heartbeatInterval;
      if (
        this.#hello ||
        !Number.isSafeInteger(interval) ||
        Number(interval) < 1000 ||
        Number(interval) > 120000
      )
        throw new BotClientError("PROTOCOL_ERROR");
      this.#hello = true;
      this.send({
        op: GatewayOpCode.IDENTIFY,
        d: { token: this.#token, bot: true, deviceId: this.#deviceId },
      });
      this.#heartbeat = setInterval(() => {
        if (!this.#ack) {
          this.#socket?.close(4000);
          return;
        }
        this.#ack = false;
        this.send({
          op: GatewayOpCode.HEARTBEAT,
          d: { clientTimestamp: Date.now() },
        });
      }, Number(interval));
      return;
    }
    if (packet.op === GatewayOpCode.HEARTBEAT_ACK) {
      this.#ack = true;
      return;
    }
    if (packet.op === GatewayOpCode.SERVER_PING) {
      const ping = parse.record(packet.d);
      if (typeof ping.timestamp !== "number")
        throw new BotClientError("PROTOCOL_ERROR");
      this.send({
        op: GatewayOpCode.CLIENT_PONG,
        d: { timestamp: ping.timestamp },
      });
      return;
    }
    if (packet.op === GatewayOpCode.INVALID_SESSION) {
      this.fail(new BotClientError("CLIENT_CLOSED"));
      return;
    }
    if (packet.op === GatewayOpCode.RECONNECT) {
      this.#socket?.close(4000);
      return;
    }
    if (packet.op !== GatewayOpCode.DISPATCH) return;
    if (packet.t === "READY") {
      if (!this.#hello || this.#ready)
        throw new BotClientError("PROTOCOL_ERROR");
      const ready = parse.ready(packet.d);
      if (!this.acceptConfig(ready)) throw new BotClientError("PROTOCOL_ERROR");
      this.#ready = true;
      this.#attempts = 0;
      if (this.#readyTimeout) clearTimeout(this.#readyTimeout);
      this.#readyTimeout = undefined;
      this.#pending?.resolve(ready);
      this.#pending = undefined;
      this.emit("READY", ready);
      return;
    }
    if (!this.#ready || !this.#config)
      throw new BotClientError("PROTOCOL_ERROR");
    switch (packet.t) {
      case "BOT_CONFIG_UPDATE": {
        const config = parse.config(packet.d);
        if (this.acceptConfig(config)) this.emit("BOT_CONFIG_UPDATE", config);
        break;
      }
      case "MESSAGE_CREATE": {
        const value = parse.message(packet.d);
        const target = this.#config.channels.find(
          (channel) => channel.id === value.channelId,
        );
        if (!target || target.type === "VOICE") return;
        if (!this.seen(`message:${value.id}`))
          this.emit("MESSAGE_CREATE", value);
        break;
      }
      case "MESSAGE_UPDATE": {
        const value = parse.messageUpdate(packet.d);
        const target = this.#config.channels.find(
          (channel) => channel.id === value.channelId,
        );
        if (target && target.type !== "VOICE")
          this.emit("MESSAGE_UPDATE", value);
        break;
      }
      case "MESSAGE_DELETE": {
        const value = parse.record(packet.d);
        const event = {
          channelId: parse.id(value.channelId),
          messageId: parse.id(value.messageId),
        };
        if (
          this.#config.channels.some(
            (channel) => channel.id === event.channelId,
          )
        )
          this.emit("MESSAGE_DELETE", event);
        break;
      }
      case "INTERACTION_CREATE": {
        const value = parse.interaction(packet.d, this.#config.application);
        if (
          this.#config.channels.some(
            (channel) => channel.id === value.channelId,
          ) &&
          !this.seen(`interaction:${value.id}`)
        )
          this.emit("INTERACTION_CREATE", value);
        break;
      }
      case "DM_CHANNEL_CREATE": {
        const value = parse.channel(packet.d);
        if (
          value.type !== "DM" ||
          !value.recipients?.some(
            (recipient) => recipient.id === this.#config!.application.userId,
          )
        )
          throw new BotClientError("PROTOCOL_ERROR");
        this.#config.channels = [
          ...this.#config.channels.filter((channel) => channel.id !== value.id),
          value,
        ];
        this.emit("DM_CHANNEL_CREATE", value);
        break;
      }
      case "TYPING_STOP": {
        const value = parse.record(packet.d);
        const channelId = parse.id(value.channelId);
        parse.id(value.userId);
        if (
          typeof value.timestamp !== "number" ||
          !Number.isFinite(value.timestamp)
        )
          throw new BotClientError("PROTOCOL_ERROR");
        if (this.#config.channels.some((channel) => channel.id === channelId))
          this.emit("TYPING_STOP", value as unknown as TypingStopPayload);
        break;
      }
      case "TYPING_START": {
        const value = parse.record(packet.d);
        const channelId = parse.id(value.channelId);
        const userId = parse.id(value.userId);
        const user = parse.record(value.user);
        if (
          user.id !== userId ||
          typeof user.username !== "string" ||
          (user.isBot !== undefined && typeof user.isBot !== "boolean") ||
          typeof value.timestamp !== "number" ||
          !Number.isFinite(value.timestamp)
        )
          throw new BotClientError("PROTOCOL_ERROR");
        if (this.#config.channels.some((channel) => channel.id === channelId))
          this.emit("TYPING_START", value as unknown as TypingIndicatorPayload);
        break;
      }
    }
  }
  private fail(error: BotClientError, emit = true): void {
    this.#terminal = true;
    this.#running = false;
    this.#ready = false;
    this.clearConnectionTimers();
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    if (this.#readyTimeout) clearTimeout(this.#readyTimeout);
    this.#readyTimeout = undefined;
    this.#pending?.reject(error);
    this.#pending = undefined;
    this.#abortCleanup?.();
    this.#abortCleanup = undefined;
    if (emit)
      this.emit("CLIENT_ERROR", {
        code:
          error.code === "PROTOCOL_ERROR"
            ? "PROTOCOL_ERROR"
            : "TRANSPORT_ERROR",
      });
    this.#socket?.close(4000);
  }
  stop(): void {
    this.#running = false;
    this.#ready = false;
    ++this.#generation;
    this.clearConnectionTimers();
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#reconnect = undefined;
    if (this.#readyTimeout) clearTimeout(this.#readyTimeout);
    this.#readyTimeout = undefined;
    this.#pending?.reject(new BotClientError("CLIENT_CLOSED"));
    this.#pending = undefined;
    this.#abortCleanup?.();
    this.#abortCleanup = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000);
  }
}
