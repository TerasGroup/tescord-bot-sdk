import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import type { NekordPlugin } from "./config.js";
export const channelConfigSchema: NonNullable<NekordPlugin["configSchema"]> =
  buildJsonChannelConfigSchema(manifest.channelConfigs.nekord.schema, {
    uiHints: {
      botToken: { sensitive: true },
      "accounts.*.botToken": { sensitive: true },
    },
  });
