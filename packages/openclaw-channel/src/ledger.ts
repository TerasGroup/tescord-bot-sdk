import path from "node:path";
import { isRecord } from "@tescord/types";
import { readState, writeState } from "./state.js";
import { ChannelError } from "./config.js";
export class DeliveryLedger {
  #ids = new Map<string, number>();
  #writes = Promise.resolve();
  private constructor(
    private readonly file: string,
    private readonly applicationId: string,
  ) {}
  static async load(
    directory: string,
    applicationId: string,
  ): Promise<DeliveryLedger> {
    const ledger = new DeliveryLedger(
      path.join(directory, "processed-events.json"),
      applicationId,
    );
    const value = await readState(ledger.file, 4 * 1024 * 1024);
    if (value !== undefined) {
      if (
        !isRecord(value) ||
        value.applicationId !== applicationId ||
        !Array.isArray(value.events) ||
        value.events.length > 10000
      )
        throw new ChannelError("EVENT_STATE_INVALID");
      for (const pair of value.events) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          pair[0].length > 512 ||
          typeof pair[1] !== "number" ||
          !Number.isFinite(pair[1])
        )
          throw new ChannelError("EVENT_STATE_INVALID");
        ledger.#ids.set(pair[0], pair[1]);
      }
    }
    return ledger;
  }
  async admit(key: string): Promise<boolean> {
    const existing = this.#ids.get(key);
    const now = Date.now();
    if (existing && existing > now) return false;
    for (const [id, expires] of this.#ids) {
      if (expires > now && this.#ids.size < 10000) break;
      this.#ids.delete(id);
    }
    this.#ids.set(key, now + 7 * 24 * 60 * 60_000);
    const value = { applicationId: this.applicationId, events: [...this.#ids] };
    this.#writes = this.#writes.then(async () => {
      await writeState(this.file, value);
    });
    await this.#writes;
    return true;
  }
  async close(): Promise<void> {
    await this.#writes;
    this.#ids.clear();
  }
}
