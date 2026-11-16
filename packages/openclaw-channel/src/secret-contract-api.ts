import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
const contract = createSimpleChannelSecretContract({
  channelKey: "nekord",
  label: "Nekord",
  accountFields: ["botToken"],
  channelFields: ["botToken"],
  mode: "account-inheritance",
});
export const secretTargetRegistryEntries = contract.secretTargetRegistryEntries;
export const collectRuntimeConfigAssignments =
  contract.collectRuntimeConfigAssignments;
