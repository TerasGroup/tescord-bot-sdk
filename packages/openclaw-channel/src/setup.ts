import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { listAccounts, resolveAccount, type NekordPlugin } from "./config.js";
import { channelConfigSchema } from "./schema.js";
const plugin: NekordPlugin = {
  id: "nekord",
  meta: {
    id: "nekord",
    label: "Nekord",
    selectionLabel: "Nekord",
    docsPath: "/channels/nekord",
    blurb: "Nekord",
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    media: true,
    nativeCommands: true,
  },
  configSchema: channelConfigSchema,
  config: {
    listAccountIds: listAccounts,
    resolveAccount,
    isConfigured: (account) => account.configured,
    isEnabled: (account) => account.enabled,
  },
};
const entry: { plugin: NekordPlugin } = defineSetupPluginEntry(plugin);
export default entry;
