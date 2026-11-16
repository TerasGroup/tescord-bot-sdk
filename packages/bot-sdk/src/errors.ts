import { ErrorCode } from "@tescord/types";
export type BotClientErrorCode =
  | ErrorCode
  | "TRANSPORT_ERROR"
  | "PROTOCOL_ERROR"
  | "CLIENT_CLOSED"
  | "RESPONSE_TOO_LARGE";
export class BotClientError extends Error {
  constructor(
    public readonly code: BotClientErrorCode,
    public readonly status = 0,
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "BotClientError";
  }
}
export function normalizeServerUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BotClientError(ErrorCode.INVALID_PARAMS);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new BotClientError(ErrorCode.INVALID_PARAMS);
  return url;
}
export function assertId(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new BotClientError(ErrorCode.INVALID_PARAMS);
}
export async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
