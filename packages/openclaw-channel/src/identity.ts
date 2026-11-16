import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  InteractionType,
  messageDeviceFingerprint,
  validateMessageDevice,
  isRecord,
  validateSecureMessageEnvelope,
  encryptSecureMessage,
  decryptSecureMessage,
  type MessageDeviceIdentity,
  type SignedMessageContext,
  type SecureMessageEnvelope,
  type Message,
  type InteractionCreatePayload,
} from "@tescord/types";
import type { NekordBotClient, BotApplication } from "@nekord/bot-sdk";
import { ChannelError } from "./config.js";
import { readState, writeState } from "./state.js";
interface StoredDevice {
  version: 1;
  applicationId: string;
  identity: MessageDeviceIdentity;
  signingPrivateJwk: JsonWebKey;
  agreementPrivateJwk: JsonWebKey;
}
export class PluginIdentity {
  readonly #pins = new Map<string, MessageDeviceIdentity>();
  readonly #directory: string;
  readonly #signing: CryptoKey;
  readonly #agreement: CryptoKey;
  #pinWrites: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly identity: MessageDeviceIdentity,
    signing: CryptoKey,
    agreement: CryptoKey,
    private readonly client: NekordBotClient,
    private readonly applicationId: string,
    directory: string,
  ) {
    this.#signing = signing;
    this.#agreement = agreement;
    this.#directory = directory;
    this.#pins.set(`${identity.userId}:${identity.deviceId}`, identity);
  }
  static async load(
    directory: string,
    application: BotApplication,
    client: NekordBotClient,
  ): Promise<PluginIdentity> {
    const file = path.join(directory, "device.json");
    let value = await readState(file, 32768);
    if (value === undefined) {
      const signing = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const agreement = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" },
        true,
        ["deriveBits"],
      );
      const signingPublicKey = JSON.stringify(
        await crypto.subtle.exportKey("jwk", signing.publicKey),
      );
      const agreementPublicKey = JSON.stringify(
        await crypto.subtle.exportKey("jwk", agreement.publicKey),
      );
      const identity: MessageDeviceIdentity = {
        userId: application.userId,
        deviceId: crypto.randomUUID(),
        signingPublicKey,
        agreementPublicKey,
        fingerprint: await messageDeviceFingerprint(
          signingPublicKey,
          agreementPublicKey,
        ),
      };
      const stored: StoredDevice = {
        version: 1,
        applicationId: application.id,
        identity,
        signingPrivateJwk: await crypto.subtle.exportKey(
          "jwk",
          signing.privateKey,
        ),
        agreementPrivateJwk: await crypto.subtle.exportKey(
          "jwk",
          agreement.privateKey,
        ),
      };
      if (await writeState(file, stored, true)) value = stored;
      else value = await readState(file, 32768);
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.applicationId !== application.id ||
      !isRecord(value.identity) ||
      !isRecord(value.signingPrivateJwk) ||
      !isRecord(value.agreementPrivateJwk)
    )
      throw new ChannelError("DEVICE_STATE_INVALID");
    const stored = value as unknown as StoredDevice;
    if (stored.identity.userId !== application.userId)
      throw new ChannelError("DEVICE_STATE_SCOPE_MISMATCH");
    await validateMessageDevice(stored.identity);
    for (const [privateJwk, publicKey] of [
      [stored.signingPrivateJwk, stored.identity.signingPublicKey],
      [stored.agreementPrivateJwk, stored.identity.agreementPublicKey],
    ] as const) {
      const expected: unknown = JSON.parse(publicKey);
      if (
        !isRecord(expected) ||
        privateJwk.kty !== "EC" ||
        privateJwk.crv !== "P-256" ||
        typeof privateJwk.d !== "string" ||
        privateJwk.x !== expected.x ||
        privateJwk.y !== expected.y
      )
        throw new ChannelError("DEVICE_STATE_INVALID");
    }
    const signing = await crypto.subtle.importKey(
      "jwk",
      stored.signingPrivateJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const agreement = await crypto.subtle.importKey(
      "jwk",
      stored.agreementPrivateJwk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const publicSigning = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(stored.identity.signingPublicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signing,
      challenge,
    );
    if (
      !(await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicSigning,
        signature,
        challenge,
      ))
    )
      throw new ChannelError("DEVICE_STATE_INVALID");
    const probe = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const publicAgreement = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(stored.identity.agreementPublicKey),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const left = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: probe.publicKey },
        agreement,
        256,
      ),
    );
    const right = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: publicAgreement },
        probe.privateKey,
        256,
      ),
    );
    const matches = timingSafeEqual(left, right);
    left.fill(0);
    right.fill(0);
    if (!matches) throw new ChannelError("DEVICE_STATE_INVALID");
    const identity = new PluginIdentity(
      stored.identity,
      signing,
      agreement,
      client,
      application.id,
      directory,
    );
    const pins = await readState(path.join(directory, "trusted-devices.json"));
    if (pins !== undefined) {
      if (
        !isRecord(pins) ||
        pins.applicationId !== application.id ||
        !Array.isArray(pins.devices) ||
        pins.devices.length > 10000
      )
        throw new ChannelError("DEVICE_TRUST_STATE_INVALID");
      for (const item of pins.devices) {
        if (!isRecord(item))
          throw new ChannelError("DEVICE_TRUST_STATE_INVALID");
        const device = item as unknown as MessageDeviceIdentity;
        await validateMessageDevice(device);
        identity.pin(device);
      }
    }
    return identity;
  }
  private pin(device: MessageDeviceIdentity): void {
    const key = `${device.userId}:${device.deviceId}`;
    const previous = this.#pins.get(key);
    if (
      previous &&
      (previous.fingerprint !== device.fingerprint ||
        previous.signingPublicKey !== device.signingPublicKey ||
        previous.agreementPublicKey !== device.agreementPublicKey)
    )
      throw new ChannelError("DEVICE_IDENTITY_CHANGED");
    this.#pins.delete(key);
    this.#pins.set(key, device);
    while (this.#pins.size > 10000)
      this.#pins.delete(this.#pins.keys().next().value!);
  }
  private async directory(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<MessageDeviceIdentity[]> {
    const devices = await this.client.getDevices(channelId, signal);
    for (const device of devices) this.pin(device);
    const snapshot = {
      applicationId: this.applicationId,
      devices: [...this.#pins.values()],
    };
    this.#pinWrites = this.#pinWrites.then(() =>
      writeState(path.join(this.#directory, "trusted-devices.json"), snapshot),
    );
    await this.#pinWrites;
    return devices;
  }
  async register(signal?: AbortSignal): Promise<void> {
    const text = new TextEncoder().encode(
      JSON.stringify([
        "nekord-bot-device-v1",
        this.applicationId,
        this.identity.deviceId,
        this.identity.fingerprint,
      ]),
    );
    const proof = Buffer.from(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.#signing,
        text,
      ),
    ).toString("base64");
    const registered = await this.client.registerDevice(
      {
        deviceId: this.identity.deviceId,
        signingPublicKey: this.identity.signingPublicKey,
        agreementPublicKey: this.identity.agreementPublicKey,
        fingerprint: this.identity.fingerprint,
        proof,
      },
      signal,
    );
    if (
      registered.userId !== this.identity.userId ||
      registered.fingerprint !== this.identity.fingerprint
    )
      throw new ChannelError("DEVICE_STATE_SCOPE_MISMATCH");
  }
  async encrypt(
    channelId: string,
    text: string,
    context?: SignedMessageContext,
    users?: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const directory = await this.directory(channelId, signal);
    const own = directory.find(
      (device) =>
        device.userId === this.identity.userId &&
        device.deviceId === this.identity.deviceId,
    );
    if (!own || own.fingerprint !== this.identity.fingerprint)
      throw new ChannelError("BOT_DEVICE_REVOKED");
    const recipients = directory.filter(
      (device) => !users || users.includes(device.userId),
    );
    if (users?.some((id) => !recipients.some((device) => device.userId === id)))
      throw new ChannelError("RECIPIENT_DEVICE_UNAVAILABLE");
    return JSON.stringify(
      await encryptSecureMessage(
        channelId,
        text,
        this.identity,
        this.#signing,
        recipients,
        context,
      ),
    );
  }
  private async decrypt(
    channelId: string,
    senderId: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; envelope: SecureMessageEnvelope }> {
    const value: unknown = JSON.parse(content);
    validateSecureMessageEnvelope(value);
    if (value.senderId !== senderId || value.channelId !== channelId)
      throw new ChannelError("MESSAGE_IDENTITY_INVALID");
    const key = `${value.senderId}:${value.senderDeviceId}`;
    let sender = this.#pins.get(key);
    if (!sender) {
      await this.directory(channelId, signal);
      sender = this.#pins.get(key);
    }
    if (!sender) throw new ChannelError("MESSAGE_SENDER_UNAVAILABLE");
    const text = await decryptSecureMessage(
      value,
      channelId,
      this.identity,
      this.#agreement,
      sender,
    );
    return { text, envelope: value };
  }
  async decryptMessage(
    message: Message,
    signal?: AbortSignal,
  ): Promise<{ text: string; envelopeId?: string }> {
    if (!message.isEncrypted) return { text: message.content };
    const result = await this.decrypt(
      message.channelId,
      message.authorId,
      message.content,
      signal,
    );
    const context = result.envelope.context;
    if (
      ((message.revision ?? 0) > 0 && !context) ||
      (context &&
        (context.purpose !== "edit" ||
          context.messageId !== message.id ||
          context.revision !== (message.revision ?? 0)))
    )
      throw new ChannelError("MESSAGE_CONTEXT_INVALID");
    return { text: result.text, envelopeId: result.envelope.messageId };
  }
  async decryptInteraction(
    interaction: InteractionCreatePayload,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!interaction.isEncrypted) {
      if (interaction.type === InteractionType.MODAL_SUBMIT) {
        return interaction.fields ?? {};
      }
      if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
        return {
          customId: interaction.customId,
          values: interaction.values,
        };
      }
      return interaction.options;
    }
    if (
      interaction.type === InteractionType.MESSAGE_COMPONENT &&
      interaction.content === undefined
    ) {
      return {
        customId: interaction.customId,
        values: interaction.values,
      };
    }
    if (typeof interaction.content !== "string") {
      throw new ChannelError("INTERACTION_CONTEXT_INVALID");
    }
    const result = await this.decrypt(
      interaction.channelId,
      interaction.callerId,
      interaction.content,
      signal,
    );
    const context = result.envelope.context;
    if (
      !context ||
      context.purpose !== "interaction" ||
      context.interactionId !== interaction.id ||
      context.commandId !== interaction.command.id ||
      context.botId !== this.identity.userId ||
      context.callerId !== interaction.callerId ||
      context.revision !== 0 ||
      context.ephemeral !== interaction.ephemeral ||
      result.envelope.recipients.some(
        (recipient) =>
          recipient.userId !== this.identity.userId &&
          recipient.userId !== interaction.callerId,
      )
    )
      throw new ChannelError("INTERACTION_CONTEXT_INVALID");
    const options: unknown = JSON.parse(result.text);
    return options;
  }
  async close(): Promise<void> {
    await this.#pinWrites;
    this.#pins.clear();
  }
}
