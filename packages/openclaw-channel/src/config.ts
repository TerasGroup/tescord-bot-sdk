import type {
  ChannelPlugin,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import {
  isRecord,
  SUPPORTED_LOCALES,
  type SupportedLocale,
} from "@tescord/types";
import { normalizeServerUrl } from "@nekord/bot-sdk";
export class ChannelError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "NekordChannelError";
  }
}
export interface NekordAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  serverUrl: string;
  botToken?: string;
  locale: SupportedLocale;
  allowFrom: string[];
  publicCommands: string[];
  allowBotMessages: boolean;
  streamIntervalMs: number;
  maxQueue: number;
}
export type NekordPlugin = ChannelPlugin<NekordAccount, unknown, unknown, 2>;
export type GatewayContext = Parameters<
  NonNullable<NonNullable<NekordPlugin["gateway"]>["startAccount"]>
>[0];
export type ChannelRuntime = PluginRuntime["channel"];
export type AccountScheduler = GatewayContext["scheduler"];
export interface RuntimeHolder {
  runtime?: PluginRuntime;
}
export function normalizeSender(value: string): string {
  const id = value.replace(/^nekord:/, "").replace(/^user:/, "");
  if (id !== "*" && !/^[A-Za-z0-9_-]{1,160}$/.test(id))
    throw new ChannelError("INVALID_SENDER_ID");
  return id;
}
function rootConfig(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  return isRecord(cfg.channels) && isRecord(cfg.channels.nekord)
    ? cfg.channels.nekord
    : undefined;
}
export function listAccounts(cfg: OpenClawConfig): string[] {
  const root = rootConfig(cfg);
  if (!root) return process.env.NEKORD_BOT_TOKEN ? ["default"] : [];
  const ids = isRecord(root.accounts)
    ? Object.keys(root.accounts)
    : ["default"];
  for (const id of ids)
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new ChannelError("INVALID_ACCOUNT_ID");
  return ids;
}
function stringList(value: unknown, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some((entry) => typeof entry !== "string")
  )
    throw new ChannelError("INVALID_CHANNEL_CONFIG");
  return value as string[];
}
export function resolveAccount(
  cfg: OpenClawConfig,
  inputId?: string | null,
): NekordAccount {
  const accountId = inputId || "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(accountId))
    throw new ChannelError("INVALID_ACCOUNT_ID");
  const root = rootConfig(cfg) ?? {};
  const nested =
    isRecord(root.accounts) && isRecord(root.accounts[accountId])
      ? (root.accounts[accountId] as Record<string, unknown>)
      : {};
  const settings = { ...root, ...nested };
  const rawToken = settings.botToken;
  const token =
    rawToken === undefined
      ? process.env[
          accountId === "default"
            ? "NEKORD_BOT_TOKEN"
            : `NEKORD_BOT_TOKEN_${accountId.toUpperCase().replaceAll("-", "_")}`
        ]
      : typeof rawToken === "string"
        ? rawToken
        : undefined;
  if (token !== undefined && !/^nkbot_[A-Za-z0-9_-]{43}$/.test(token))
    throw new ChannelError("INVALID_BOT_TOKEN");
  const serverUrl =
    typeof settings.serverUrl === "string"
      ? settings.serverUrl
      : (process.env.NEKORD_SERVER_URL ?? "");
  if (serverUrl) normalizeServerUrl(serverUrl);
  const locale = settings.locale ?? "zh-CN";
  if (!SUPPORTED_LOCALES.some((item) => item.code === locale))
    throw new ChannelError("INVALID_CHANNEL_CONFIG");
  const streamIntervalMs = settings.streamIntervalMs ?? 1000;
  const maxQueue = settings.maxQueue ?? 32;
  if (
    !Number.isSafeInteger(streamIntervalMs) ||
    Number(streamIntervalMs) < 500 ||
    Number(streamIntervalMs) > 10000 ||
    !Number.isSafeInteger(maxQueue) ||
    Number(maxQueue) < 1 ||
    Number(maxQueue) > 256
  )
    throw new ChannelError("INVALID_CHANNEL_CONFIG");
  return {
    accountId,
    enabled: root.enabled !== false && nested.enabled !== false,
    configured: Boolean(serverUrl && (token || rawToken !== undefined)),
    serverUrl,
    ...(token ? { botToken: token } : {}),
    locale: locale as SupportedLocale,
    allowFrom: stringList(settings.allowFrom, ["*"]).map(normalizeSender),
    publicCommands: stringList(settings.publicCommands, []),
    allowBotMessages: settings.allowBotMessages === true,
    streamIntervalMs: Number(streamIntervalMs),
    maxQueue: Number(maxQueue),
  };
}
export function senderAllowed(
  account: NekordAccount,
  senderId: string,
): boolean {
  return (
    account.allowFrom.includes("*") || account.allowFrom.includes(senderId)
  );
}
