import type { Message } from "@tescord/types";

export type BotImageMime = "image/png" | "image/jpeg" | "image/webp";
export type BotImageSource = "current" | "reply" | "history";
export type MessageImages = Pick<
  Message,
  "id" | "channelId" | "attachments" | "sequence" | "replyToId"
>;

export interface BotImageContextInput {
  channelId: string;
  current?: MessageImages;
  reply?: MessageImages;
  history?: readonly MessageImages[];
}

export interface BotContextImage {
  source: BotImageSource;
  messageId: string;
  attachmentId: string;
  mimeType: BotImageMime;
  bytes: Uint8Array<ArrayBuffer>;
}

export function isContextImageMime(mime: string): mime is BotImageMime {
  return mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
}

export function matchesImageHeader(
  bytes: Uint8Array,
  mime: BotImageMime,
): boolean {
  const startsAt = (offset: number, signature: number[]) =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  switch (mime) {
    case "image/png":
      return startsAt(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsAt(0, [0xff, 0xd8, 0xff]);
    case "image/webp":
      return (
        startsAt(0, [0x52, 0x49, 0x46, 0x46]) &&
        startsAt(8, [0x57, 0x45, 0x42, 0x50])
      );
  }
}
