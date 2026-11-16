import {
  BotClientError,
  type NekordBotClient,
} from "../../packages/bot-sdk/src/index.js";

export async function acknowledge(
  client: Pick<NekordBotClient, "deferInteraction">,
  id: string,
  signal: AbortSignal,
  onRetry: () => void,
): Promise<void> {
  try {
    await client.deferInteraction(id, signal);
  } catch (error) {
    if (
      !(error instanceof BotClientError) ||
      error.code !== "TRANSPORT_ERROR" ||
      signal.aborted
    )
      throw error;
    // Defer is idempotent; the SDK accepts an already acknowledged response.
    onRetry();
    await client.deferInteraction(id, signal);
  }
}
