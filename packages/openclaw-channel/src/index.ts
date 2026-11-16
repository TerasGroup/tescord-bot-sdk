import {
  defineChannelPluginEntry,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-core";
import type { NekordPlugin } from "./config.js";
import { nekordPlugin, holder, initializeCommands } from "./channel.js";
export { nekordPlugin } from "./channel.js";
const entry: {
  id: string;
  name: string;
  description: string;
  configSchema: NonNullable<NekordPlugin["configSchema"]>;
  register(api: OpenClawPluginApi): void;
  channelPlugin: NekordPlugin;
} = defineChannelPluginEntry({
  id: "nekord",
  name: "Nekord",
  description: "Nekord",
  plugin: nekordPlugin,
  setRuntime: (runtime) => {
    holder.runtime = runtime;
  },
  registerFull: () => initializeCommands(),
});
export default entry;
